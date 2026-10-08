"""Tests for family_config.py against an in-process fake Firestore and a fake gcloud."""

from __future__ import annotations

import copy
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
CLI = HERE / "family_config.py"
REPO = HERE.parent.parent
SECRET = "s3cr3t-marker-value"
KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
NAME_PREFIX = "projects/test-project/databases/test-db/documents/"
PATH_PREFIX = "/v1/" + NAME_PREFIX.rstrip("/")
PRINT_ENV = "import json, os, sys; print(json.dumps({k: os.environ.get(k) for k in sys.argv[1:]}))"


def s(text: str) -> dict:
    return {"stringValue": text}


def ref(group: str, key: str | None = None) -> dict:
    fields = {"ref": s(f"shared/{group}")}
    if key:
        fields["key"] = s(key)
    return {"mapValue": {"fields": fields}}


def apply_mask(target: dict, source: dict, parts: list[str]) -> None:
    head, rest = parts[0], parts[1:]
    if not rest:
        if head in source:
            target[head] = copy.deepcopy(source[head])
        else:
            target.pop(head, None)
        return
    child_source = source.get(head, {}).get("mapValue", {}).get("fields", {})
    child = target.setdefault(head, {"mapValue": {"fields": {}}})
    apply_mask(child.setdefault("mapValue", {}).setdefault("fields", {}), child_source, rest)


class FakeFirestore:
    """The Firestore REST subset family_config.py uses: batchGet, list, and PATCH."""

    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}
        self.requests: list[dict] = []
        self.bump_before_patch = False
        self.clock = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence request logging
                pass

            def _body(self) -> dict:
                length = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(length) or b"{}")

            def _send(self, code: int, payload) -> None:
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self, body=None) -> tuple[str, dict]:
                url = urlparse(self.path)
                fake.requests.append({
                    "method": self.command,
                    "path": unquote(url.path),
                    "query": parse_qs(url.query),
                    "headers": {key.lower(): value for key, value in self.headers.items()},
                    "body": body,
                })
                return unquote(url.path), parse_qs(url.query)

            def do_POST(self):
                body = self._body()
                path, _ = self._record(body)
                if path != PATH_PREFIX + ":batchGet":
                    return self._send(404, {"error": {"status": "NOT_FOUND"}})
                out = []
                for name in body["documents"]:
                    doc = fake.docs.get(name[len(NAME_PREFIX):])
                    out.append({"found": {"name": name, **copy.deepcopy(doc)}} if doc else {"missing": name})
                return self._send(200, out)

            def do_GET(self):
                path, query = self._record()
                collection = path[len(PATH_PREFIX) + 1:]
                depth = collection.count("/") + 2
                names = set()
                for doc_path in fake.docs:
                    if doc_path.startswith(collection + "/"):
                        candidate = "/".join(doc_path.split("/")[:depth])
                        if candidate in fake.docs or query.get("showMissing") == ["true"]:
                            names.add(candidate)
                return self._send(200, {"documents": [{"name": NAME_PREFIX + name} for name in sorted(names)]})

            def do_PATCH(self):
                body = self._body()
                path, query = self._record(body)
                rel = path[len(PATH_PREFIX) + 1:]
                if fake.bump_before_patch and rel in fake.docs:
                    fake.docs[rel]["updateTime"] = fake.tick()
                doc = fake.docs.get(rel)
                if query.get("currentDocument.exists") == ["false"] and doc is not None:
                    return self._send(409, {"error": {"status": "ALREADY_EXISTS"}})
                wanted = query.get("currentDocument.updateTime")
                if wanted and (doc is None or doc["updateTime"] != wanted[0]):
                    return self._send(400, {"error": {"status": "FAILED_PRECONDITION"}})
                fields = copy.deepcopy(doc["fields"]) if doc else {}
                for field_path in query.get("updateMask.fieldPaths", []):
                    apply_mask(fields, body.get("fields", {}), field_path.split("."))
                fake.docs[rel] = {"fields": fields, "updateTime": fake.tick()}
                return self._send(200, {"name": NAME_PREFIX + rel, **fake.docs[rel]})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tick(self) -> str:
        self.clock += 1
        return f"2026-01-01T00:00:{self.clock:02d}.000000Z"

    def put(self, path: str, values: dict | None = None, **extra: str) -> None:
        fields = {key: s(value) for key, value in extra.items()}
        if values is not None:
            fields["values"] = {"mapValue": {"fields": {
                name: value if isinstance(value, dict) else s(value) for name, value in values.items()
            }}}
        self.docs[path] = {"fields": fields, "updateTime": self.tick()}

    def values(self, path: str) -> dict:
        return self.docs[path]["fields"].get("values", {}).get("mapValue", {}).get("fields", {})

    def patches(self) -> list[dict]:
        return [request for request in self.requests if request["method"] == "PATCH"]


class FamilyConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeFirestore()
        self.addCleanup(self.fake.server.server_close)
        self.addCleanup(self.fake.server.shutdown)
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        self.gcloud_log = self.tmp / "gcloud.log"
        gcloud = bin_dir / "gcloud"
        gcloud.write_text(
            "#!/usr/bin/env bash\n"
            'if [[ -n "${FAKE_GCLOUD_FAIL:-}" ]]; then echo "auth broken" >&2; exit 1; fi\n'
            "state=absent\n"
            'if [[ -n "${CLOUDSDK_CONFIG:-}" && -d "$CLOUDSDK_CONFIG" ]]; then state=present; fi\n'
            'printf "%s|%s|%s|%s\\n" "$*" "${CLOUDSDK_CONFIG:-}" "$state" '
            '"${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-}" >> "$FAKE_GCLOUD_LOG"\n'
            "echo test-token\n"
        )
        gcloud.chmod(0o755)
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("FAMILY_CONFIG_", "CLOUDSDK_", "GITHUB_ACTIONS"))
        }
        self.env.update({
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAMILY_CONFIG_FIRESTORE_URL": self.fake.url,
            "FAMILY_CONFIG_PROJECT": "test-project",
            "FAMILY_CONFIG_DATABASE": "test-db",
            "FAKE_GCLOUD_LOG": str(self.gcloud_log),
        })
        self.fake.put("shared/cloudflare", {"CLOUDFLARE_API_TOKEN": SECRET, "CLOUDFLARE_ACCOUNT_ID": "acct-1"})
        self.fake.put("shared/vps", {"VPS_HOST": "vps.example", "VPS_PORT": {"integerValue": "2222"}, "VPS_KEY": KEY_TEXT})
        self.fake.put("apps/demo/profiles/prod", {
            "APP_SECRET": "app-secret-1",
            "CLOUDFLARE_API_TOKEN": ref("cloudflare"),
            "TF_VAR_account": ref("cloudflare", "CLOUDFLARE_ACCOUNT_ID"),
            "PORT_TEXT": ref("vps", "VPS_PORT"),
            "FLAG": {"booleanValue": True},
        })
        self.fake.put("apps/demo/profiles/extra", {"APP_SECRET": "override", "EXTRA": "1"})

    def cli(self, *args: str, stdin: str = "", env: dict | None = None) -> tuple[int, str, str]:
        result = subprocess.run(
            [sys.executable, str(CLI), *args], input=stdin.encode(), capture_output=True,
            env={**self.env, **(env or {})}, timeout=60,
        )
        return result.returncode, result.stdout.decode(), result.stderr.decode()

    def env_of(self, *targets: str, names: list[str], extra: dict | None = None) -> dict:
        code, out, err = self.cli("run", *targets, "--", sys.executable, "-c", PRINT_ENV, *names, env=extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def gcloud_calls(self) -> list[list[str]]:
        return [line.split("|") for line in self.gcloud_log.read_text().splitlines()]

    # run / render -----------------------------------------------------------

    def test_run_resolves_references_and_scalars(self):
        env = self.env_of("demo/prod", names=["APP_SECRET", "CLOUDFLARE_API_TOKEN", "TF_VAR_account", "PORT_TEXT", "FLAG"])
        self.assertEqual(env, {"APP_SECRET": "app-secret-1", "CLOUDFLARE_API_TOKEN": SECRET,
                               "TF_VAR_account": "acct-1", "PORT_TEXT": "2222", "FLAG": "true"})

    def test_run_later_profiles_and_store_beat_parent_env(self):
        env = self.env_of("demo/prod", "demo/extra", names=["APP_SECRET", "EXTRA"], extra={"APP_SECRET": "parent"})
        self.assertEqual(env, {"APP_SECRET": "override", "EXTRA": "1"})

    def test_run_env_file_is_private_and_removed(self):
        script = ("import os, stat, sys; p = os.environ['ENV_FILE']; "
                  "print(oct(stat.S_IMODE(os.stat(p).st_mode))); print(p); "
                  "sys.stdout.write(open(p).read()); sys.exit(7)")
        code, out, err = self.cli("run", "demo/extra", "--env-file-var", "ENV_FILE", "--", sys.executable, "-c", script)
        self.assertEqual(code, 7, err)
        mode, path, *lines = out.splitlines()
        self.assertEqual(mode, "0o600")
        self.assertEqual(lines, ["APP_SECRET=override", "EXTRA=1"])
        self.assertFalse(os.path.exists(path))

    def test_sigterm_reaches_child(self):
        child = ("import signal, sys, time; signal.signal(signal.SIGTERM, lambda *a: sys.exit(42)); "
                 "print('ready', flush=True); time.sleep(30)")
        process = subprocess.Popen([sys.executable, str(CLI), "run", "demo/extra", "--", sys.executable, "-c", child],
                                   stdout=subprocess.PIPE, env=self.env)
        self.assertEqual(process.stdout.readline().strip(), b"ready")
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 42)
        process.stdout.close()

    def test_render_writes_private_env_files(self):
        out_dir = self.tmp / "rendered"
        code, out, err = self.cli("render", "demo/prod", "demo/extra", "--out-dir", str(out_dir))
        self.assertEqual(code, 0, err)
        self.assertNotIn(SECRET, out)
        self.assertEqual(stat.S_IMODE(out_dir.stat().st_mode), 0o700)
        prod = out_dir / "prod.env"
        self.assertEqual(stat.S_IMODE(prod.stat().st_mode), 0o600)
        self.assertIn(f"CLOUDFLARE_API_TOKEN={SECRET}\n", prod.read_text())
        self.assertEqual((out_dir / "extra.env").read_text(), "APP_SECRET=override\nEXTRA=1\n")

    def test_render_rejects_duplicate_profile_names(self):
        self.fake.put("apps/other/profiles/prod", {"X": "1"})
        code, _, err = self.cli("render", "demo/prod", "other/prod", "--out-dir", str(self.tmp / "dup"))
        self.assertEqual(code, 1)
        self.assertIn("distinct profile names", err)

    # reads ------------------------------------------------------------------

    def test_get_keys_and_ls(self):
        self.assertEqual(self.cli("get", "shared/vps", "VPS_KEY")[:2], (0, KEY_TEXT))
        self.assertEqual(self.cli("get", "demo/prod", "TF_VAR_account")[:2], (0, "acct-1"))
        code, out, _ = self.cli("keys", "demo/prod")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), [
            "APP_SECRET",
            "CLOUDFLARE_API_TOKEN -> shared/cloudflare",
            "FLAG",
            "PORT_TEXT -> shared/vps:VPS_PORT",
            "TF_VAR_account -> shared/cloudflare:CLOUDFLARE_ACCOUNT_ID",
        ])
        code, out, _ = self.cli("ls")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), ["shared/cloudflare", "shared/vps", "demo/extra", "demo/prod"])
        self.assertNotIn(SECRET, out)
        code, _, err = self.cli("get", "demo/prod", "MISSING")
        self.assertEqual(code, 1)
        self.assertIn("demo/prod has no MISSING", err)

    def test_invalid_documents_fail_without_printing_values(self):
        cases = {
            "multi-line": {"BAD": f"{SECRET}\nsecond"},
            "reserved name": {"PATH": SECRET},
            "ref outside shared": {"BAD": {"mapValue": {"fields": {"ref": s("apps/demo")}}}},
            "missing ref key": {"BAD": ref("cloudflare", "NOPE")},
            "ref to multi-line value": {"BAD": ref("vps", "VPS_KEY")},
            "unsupported type": {"BAD": {"doubleValue": 1.5}},
            "bad name": {"bad-name": SECRET},
            "extra ref field": {"BAD": {"mapValue": {"fields": {"ref": s("shared/cloudflare"), "x": s(SECRET)}}}},
        }
        for label, values in cases.items():
            with self.subTest(label):
                self.fake.put("apps/demo/profiles/broken", values)
                code, out, err = self.cli("run", "demo/broken", "--", sys.executable, "-c", "pass")
                self.assertEqual(code, 1, label)
                self.assertNotIn(SECRET, out + err)
                self.assertNotIn("BEGIN OPENSSH", out + err)

    # writes -----------------------------------------------------------------

    def test_set_creates_updates_and_skips_unchanged(self):
        self.assertEqual(self.cli("set", "demo/new", "NAME", stdin="v1\n")[0], 0)
        first = self.fake.patches()[-1]
        self.assertEqual(first["query"]["currentDocument.exists"], ["false"])
        self.assertEqual(first["query"]["updateMask.fieldPaths"], ["values.NAME"])
        self.assertEqual(self.fake.values("apps/demo/profiles/new")["NAME"], s("v1"))
        self.assertEqual(self.cli("set", "demo/new", "NAME", stdin="v2")[0], 0)
        self.assertIn("currentDocument.updateTime", self.fake.patches()[-1]["query"])
        count = len(self.fake.patches())
        code, out, _ = self.cli("set", "demo/new", "NAME", stdin="v2\n")
        self.assertEqual(code, 0)
        self.assertIn("unchanged", out)
        self.assertEqual(len(self.fake.patches()), count)

    def test_set_raw_and_single_line_rules(self):
        self.assertEqual(self.cli("set", "shared/vps", "NEW_KEY", "--raw", stdin=KEY_TEXT)[0], 0)
        self.assertEqual(self.fake.values("shared/vps")["NEW_KEY"], s(KEY_TEXT))
        code, out, err = self.cli("set", "demo/prod", "BAD", stdin=f"{SECRET}\nline2")
        self.assertEqual(code, 1)
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(self.cli("set", "demo/prod", "LD_PRELOAD", stdin="x")[0], 1)

    def test_unset_link_import_and_describe(self):
        self.assertEqual(self.cli("unset", "demo/prod", "APP_SECRET")[0], 0)
        self.assertEqual(self.fake.patches()[-1]["query"]["updateMask.fieldPaths"], ["values.APP_SECRET"])
        self.assertNotIn("APP_SECRET", self.fake.values("apps/demo/profiles/prod"))
        self.assertIn("unchanged", self.cli("unset", "demo/prod", "APP_SECRET")[1])

        self.assertEqual(self.cli("link", "demo/prod", "ACCOUNT", "shared/cloudflare", "CLOUDFLARE_ACCOUNT_ID")[0], 0)
        self.assertEqual(self.fake.values("apps/demo/profiles/prod")["ACCOUNT"], ref("cloudflare", "CLOUDFLARE_ACCOUNT_ID"))
        self.assertEqual(self.cli("link", "demo/prod", "CLOUDFLARE_ACCOUNT_ID", "shared/cloudflare")[0], 0)
        self.assertEqual(self.fake.values("apps/demo/profiles/prod")["CLOUDFLARE_ACCOUNT_ID"], ref("cloudflare"))
        self.assertEqual(self.cli("link", "demo/prod", "X", "shared/cloudflare", "NOPE")[0], 1)

        source = self.tmp / "in.env"
        source.write_text("# comment\n\nexport A=1\nB=\"two words\" # note\nC='x=y'\nD=plain # trailing\nE=\n")
        code, out, err = self.cli("import", "demo/imported", str(source))
        self.assertEqual(code, 0, err)
        self.assertIn("imported 5", out)
        self.assertEqual(self.fake.values("apps/demo/profiles/imported"),
                         {"A": s("1"), "B": s("two words"), "C": s("x=y"), "D": s("plain"), "E": s("")})
        bad = self.tmp / "bad.env"
        bad.write_text('A="unterminated\n')
        count = len(self.fake.patches())
        self.assertEqual(self.cli("import", "demo/imported", str(bad))[0], 1)
        self.assertEqual(len(self.fake.patches()), count)

        self.assertEqual(self.cli("describe", "demo", "Demo app")[0], 0)
        self.assertEqual(self.fake.docs["apps/demo"]["fields"]["description"], s("Demo app"))

    def test_concurrent_change_is_rejected(self):
        self.fake.bump_before_patch = True
        code, _, err = self.cli("set", "demo/prod", "APP_SECRET", stdin="new")
        self.assertEqual(code, 1)
        self.assertIn("changed concurrently", err)

    def test_with_file_substitutes_path_and_cleans_up(self):
        script = ("import os, stat, sys; p = sys.argv[1]; print(oct(stat.S_IMODE(os.stat(p).st_mode))); "
                  "print(open(p).read() == sys.argv[2]); print(p)")
        code, out, err = self.cli("with-file", "shared/vps", "VPS_KEY", "--", sys.executable, "-c", script, "{}", KEY_TEXT)
        self.assertEqual(code, 0, err)
        mode, same, path = out.splitlines()
        self.assertEqual((mode, same), ("0o600", "True"))
        self.assertFalse(os.path.exists(path))

    # auth -------------------------------------------------------------------

    def test_laptop_auth_uses_named_configuration_and_quota_project(self):
        self.assertEqual(self.cli("keys", "demo/prod")[0], 0)
        args, config_dir, _, override = self.gcloud_calls()[-1]
        self.assertIn("--configuration=personal", args)
        self.assertEqual((config_dir, override), ("", ""))
        headers = self.fake.requests[-1]["headers"]
        self.assertEqual(headers.get("x-goog-user-project"), "test-project")
        self.assertEqual(headers.get("authorization"), "Bearer test-token")
        self.cli("keys", "demo/prod", env={"FAMILY_CONFIG_GCLOUD_CONFIG": "other"})
        self.assertIn("--configuration=other", self.gcloud_calls()[-1][0])

    def test_key_file_auth_uses_override_and_throwaway_config(self):
        key = self.tmp / "reader.json"
        key.write_text("{}")
        code, _, err = self.cli("keys", "demo/prod", env={"FAMILY_CONFIG_CREDENTIALS": str(key)})
        self.assertEqual(code, 0, err)
        args, config_dir, state, override = self.gcloud_calls()[-1]
        self.assertNotIn("--configuration", args)
        self.assertEqual((state, override), ("present", str(key)))
        self.assertFalse(os.path.exists(config_dir))
        self.assertNotIn("x-goog-user-project", self.fake.requests[-1]["headers"])
        missing = {"FAMILY_CONFIG_CREDENTIALS": str(self.tmp / "missing.json")}
        self.assertEqual(self.cli("keys", "demo/prod", env=missing)[0], 1)

    def test_github_actions_masks_values(self):
        code, out, err = self.cli("get", "shared/vps", "VPS_KEY", env={"GITHUB_ACTIONS": "true"})
        self.assertEqual(code, 0, err)
        self.assertNotIn("--configuration", self.gcloud_calls()[-1][0])
        # stdout must be exactly the value so `get ... > file` stays a valid key file.
        self.assertEqual(out, KEY_TEXT)
        masks = [line for line in err.splitlines() if line.startswith("::add-mask::")]
        self.assertEqual(masks, [f"::add-mask::{line}" for line in KEY_TEXT.splitlines()])

    def test_gcloud_failure_is_reported(self):
        code, _, err = self.cli("keys", "demo/prod", env={"FAKE_GCLOUD_FAIL": "1"})
        self.assertEqual(code, 1)
        self.assertIn("could not provide an access token", err)


class ProvisioningScriptTest(unittest.TestCase):
    SCRIPTS = REPO / "infrastructure/gcp/family-config"

    def read(self, name: str) -> str:
        path = self.SCRIPTS / name
        self.assertEqual(subprocess.run(["bash", "-n", str(path)]).returncode, 0, name)
        return path.read_text()

    def test_bootstrap_declares_the_approved_database(self):
        text = self.read("bootstrap.sh")
        for expected in (
            'LOCATION="northamerica-northeast1"',
            "--delete-protection",
            "--type=firestore-native",
            "allow read, write: if false;",
            "roles/datastore.user",
            "roles/secretmanager.secretAccessor",
            "roles/storage.objectAdmin",
            "--condition=None",
        ):
            self.assertIn(expected, text)
        self.assertNotIn("family-config-only", text)

    def test_reader_key_is_streamed_and_verified_before_old_keys_go(self):
        text = self.read("install-reader-key.sh")
        self.assertIn("keys create /dev/stdout", text)
        self.assertIn("/etc/family-app/config-reader.json", text)
        self.assertLess(text.index("keys expense-tax-management/production"), text.index("service-accounts keys delete"))


if __name__ == "__main__":
    unittest.main()
