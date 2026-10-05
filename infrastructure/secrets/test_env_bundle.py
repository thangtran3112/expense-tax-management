"""Tests for the ai-trading Secret Manager bundle tool.

Run with: python3 -m unittest infrastructure/secrets/test_env_bundle.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, THIS_DIR)  # robust import regardless of invocation style

import bundle_lib  # noqa: E402

ENV_BUNDLE = os.path.join(THIS_DIR, "env-bundle.py")

FAKE_GCLOUD = r"""#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${FAKE_GCLOUD_STATE_DIR:?FAKE_GCLOUD_STATE_DIR not set}"

get_flag() {
  local name="$1"; shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$name" ]]; then echo "$2"; return 0; fi
    shift
  done
  return 1
}

[[ "$1" == "secrets" && "$2" == "versions" ]] || { echo "fake gcloud: unsupported: $*" >&2; exit 1; }
sub="$3"

case "$sub" in
  add)
    secret="$4"
    mkdir -p "$STATE_DIR/$secret"
    shopt -s nullglob
    existing=("$STATE_DIR/$secret"/*.data)
    next=1
    if (( ${#existing[@]} > 0 )); then
      next=$(( $(printf '%s\n' "${existing[@]}" | sed -E 's#.*/([0-9]+)\.data#\1#' | sort -n | tail -1) + 1 ))
    fi
    cat > "$STATE_DIR/$secret/$next.data"
    echo "ENABLED" > "$STATE_DIR/$secret/$next.state"
    echo "projects/0/secrets/$secret/versions/$next"
    ;;
  access)
    version="$4"
    secret="$(get_flag --secret "${@:5}")"
    if [[ "$version" == "latest" ]]; then
      version=""
      shopt -s nullglob
      for f in "$STATE_DIR/$secret"/*.state; do
        v="$(basename "$f" .state)"
        [[ "$(cat "$f")" == "ENABLED" ]] && version="$v"
      done
      [[ -n "$version" ]] || { echo "no enabled version" >&2; exit 1; }
    fi
    [[ -f "$STATE_DIR/$secret/$version.state" ]] || { echo "version not found: $version" >&2; exit 1; }
    [[ "$(cat "$STATE_DIR/$secret/$version.state")" == "ENABLED" ]] || { echo "version destroyed: $version" >&2; exit 1; }
    cat "$STATE_DIR/$secret/$version.data"
    ;;
  list)
    secret="$4"
    out="["
    first=1
    shopt -s nullglob
    for f in "$STATE_DIR/$secret"/*.state; do
      v="$(basename "$f" .state)"
      st="$(cat "$f")"
      [[ $first -eq 0 ]] && out+=","
      first=0
      out+="{\"name\":\"projects/0/secrets/$secret/versions/$v\",\"state\":\"$st\"}"
    done
    out+="]"
    echo "$out"
    ;;
  destroy)
    version="$4"
    secret="$(get_flag --secret "${@:5}")"
    echo "DESTROYED" > "$STATE_DIR/$secret/$version.state"
    ;;
  *)
    echo "fake gcloud: unsupported secrets versions subcommand: $sub" >&2
    exit 1
    ;;
esac
"""


def write_fake_gcloud(bin_dir: str) -> None:
    path = os.path.join(bin_dir, "gcloud")
    with open(path, "w") as fh:
        fh.write(FAKE_GCLOUD)
    os.chmod(path, stat.S_IRWXU)


def run_cli(args, env=None, input_bytes=None):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, ENV_BUNDLE, *args],
        env=full_env,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class ParseBundleGrammarTests(unittest.TestCase):
    def test_valid_bundle_with_comments_and_equals_in_value(self):
        text = (
            "# a leading comment\n"
            "\n"
            "[deploy]\n"
            "VPS_HOST=1.2.3.4\n"
            "VPS_KNOWN_HOSTS=[1.2.3.4]:22 ssh-ed25519 AAAA==\n"
            "\n"
            "[cloudflare]\n"
        )
        sections = bundle_lib.parse_bundle(text)
        self.assertEqual(list(sections.keys()), ["deploy", "cloudflare"])
        self.assertEqual(sections["deploy"]["VPS_KNOWN_HOSTS"], "[1.2.3.4]:22 ssh-ed25519 AAAA==")
        self.assertEqual(sections["cloudflare"], {})  # empty section allowed

    def test_duplicate_section_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError) as ctx:
            bundle_lib.parse_bundle("[a]\nK=1\n[a]\nJ=2\n")
        self.assertEqual(ctx.exception.line, 3)

    def test_duplicate_key_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError) as ctx:
            bundle_lib.parse_bundle("[a]\nK=1\nK=2\n")
        self.assertEqual(ctx.exception.line, 3)

    def test_empty_value_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[a]\nK=\n")

    def test_replace_me_placeholder_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[a]\nK=replace-me\n")

    def test_bad_key_name_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[a]\n1BAD=v\n")

    def test_bad_section_name_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[Bad-Section]\nK=v\n")

    def test_key_before_any_section_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError) as ctx:
            bundle_lib.parse_bundle("K=v\n")
        self.assertEqual(ctx.exception.line, 1)

    def test_malformed_line_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[a]\nnot a key value line\n")

    def test_cr_line_ending_is_an_error(self):
        with self.assertRaises(bundle_lib.BundleError):
            bundle_lib.parse_bundle("[a]\r\nK=v\r\n")


class RenderCommandTests(unittest.TestCase):
    def test_render_writes_exact_files_and_modes_from_bundle_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nVPS_HOST=1.2.3.4\nVPS_PORT=22\n\n[cloudflare]\nTOKEN=abc\n")
            out_dir = os.path.join(tmp, "out")

            result = run_cli(
                ["render", "ai-trading", "--out-dir", out_dir, "--bundle-file", bundle_path, "deploy", "cloudflare"]
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual(stat.S_IMODE(os.stat(out_dir).st_mode), 0o700)
            deploy_path = os.path.join(out_dir, "deploy.env")
            self.assertEqual(stat.S_IMODE(os.stat(deploy_path).st_mode), 0o600)
            with open(deploy_path) as fh:
                self.assertEqual(fh.read(), "VPS_HOST=1.2.3.4\nVPS_PORT=22\n")
            with open(os.path.join(out_dir, "cloudflare.env")) as fh:
                self.assertEqual(fh.read(), "TOKEN=abc\n")

    def test_render_fails_on_missing_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nVPS_HOST=1.2.3.4\n")
            out_dir = os.path.join(tmp, "out")
            result = run_cli(
                ["render", "ai-trading", "--out-dir", out_dir, "--bundle-file", bundle_path, "nonexistent"]
            )
            self.assertNotEqual(result.returncode, 0)

    def test_render_masks_values_under_github_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nVPS_HOST=1.2.3.4\n")
            out_dir = os.path.join(tmp, "out")
            result = run_cli(
                ["render", "ai-trading", "--out-dir", out_dir, "--bundle-file", bundle_path, "deploy"],
                env={"GITHUB_ACTIONS": "true"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b"::add-mask::1.2.3.4", result.stdout)


class ExecCommandTests(unittest.TestCase):
    def test_exec_exposes_keys_and_returns_child_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nFOO=bar\n\n[cloudflare]\nFOO=baz\n")

            child = (
                "import os, sys; "
                "assert os.environ.get('FOO') == 'baz', os.environ.get('FOO'); "
                "sys.exit(17)"
            )
            result = run_cli(
                [
                    "exec",
                    "ai-trading",
                    "--bundle-file",
                    bundle_path,
                    "deploy",
                    "cloudflare",  # later section wins: FOO should end up "baz"
                    "--",
                    sys.executable,
                    "-c",
                    child,
                ]
            )
            self.assertEqual(result.returncode, 17, result.stderr)

    def test_exec_masks_values_under_github_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nFOO=secret-value\n")
            result = run_cli(
                ["exec", "ai-trading", "--bundle-file", bundle_path, "deploy", "--", sys.executable, "-c", "pass"],
                env={"GITHUB_ACTIONS": "true"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b"::add-mask::secret-value", result.stdout)


class GetFileAndPushTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        write_fake_gcloud(self.bin_dir)
        self.state_dir = os.path.join(self.tmp.name, "state")
        os.makedirs(self.state_dir)
        self.fake_env = {
            "PATH": self.bin_dir + os.pathsep + os.environ["PATH"],
            "FAKE_GCLOUD_STATE_DIR": self.state_dir,
            "CLOUDSDK_ACTIVE_CONFIG_NAME": "test",
        }

    def test_get_file_is_byte_exact_through_fake_gcloud(self):
        secret_dir = os.path.join(self.state_dir, "expense-tax-env-files")
        os.makedirs(secret_dir)
        payload = json.dumps({"ovh/github-actions-expense-tax": "-----KEY-----\nline2\n-----END-----"})
        with open(os.path.join(secret_dir, "1.data"), "w") as fh:
            fh.write(payload)
        with open(os.path.join(secret_dir, "1.state"), "w") as fh:
            fh.write("ENABLED")

        out_file = os.path.join(self.tmp.name, "key.pem")
        result = run_cli(
            ["get-file", "expense-tax-env-files", "ovh/github-actions-expense-tax", out_file],
            env=self.fake_env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(out_file) as fh:
            self.assertEqual(fh.read(), "-----KEY-----\nline2\n-----END-----")
        self.assertEqual(stat.S_IMODE(os.stat(out_file).st_mode), 0o600)

    def test_get_file_masks_under_github_actions(self):
        secret_dir = os.path.join(self.state_dir, "expense-tax-env-files")
        os.makedirs(secret_dir)
        with open(os.path.join(secret_dir, "1.data"), "w") as fh:
            fh.write(json.dumps({"k": "top-secret"}))
        with open(os.path.join(secret_dir, "1.state"), "w") as fh:
            fh.write("ENABLED")
        out_file = os.path.join(self.tmp.name, "out")
        env = dict(self.fake_env)
        env["GITHUB_ACTIONS"] = "true"
        result = run_cli(["get-file", "expense-tax-env-files", "k", out_file], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"::add-mask::top-secret", result.stdout)

    def test_push_uploads_verifies_hash_and_destroys_other_versions(self):
        secret_dir = os.path.join(self.state_dir, "ai-trading-env-bundle")
        os.makedirs(secret_dir)
        with open(os.path.join(secret_dir, "1.data"), "w") as fh:
            fh.write("[deploy]\nOLD=1\n")
        with open(os.path.join(secret_dir, "1.state"), "w") as fh:
            fh.write("ENABLED")

        bundle_path = os.path.join(self.tmp.name, "new-bundle.env")
        with open(bundle_path, "w") as fh:
            fh.write("[deploy]\nVPS_HOST=1.2.3.4\n")

        result = run_cli(["push", "ai-trading", bundle_path], env=self.fake_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"pushed ai-trading-env-bundle version 2", result.stdout)

        with open(os.path.join(secret_dir, "1.state")) as fh:
            self.assertEqual(fh.read().strip(), "DESTROYED")
        with open(os.path.join(secret_dir, "2.state")) as fh:
            self.assertEqual(fh.read().strip(), "ENABLED")
        with open(os.path.join(secret_dir, "2.data")) as fh:
            self.assertEqual(fh.read(), "[deploy]\nVPS_HOST=1.2.3.4\n")

    def test_push_refuses_invalid_bundle_without_calling_gcloud(self):
        bundle_path = os.path.join(self.tmp.name, "bad-bundle.env")
        with open(bundle_path, "w") as fh:
            fh.write("[deploy]\nVPS_HOST=replace-me\n")
        result = run_cli(["push", "ai-trading", bundle_path], env=self.fake_env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"bundle error", result.stderr)


class CheckCommandTests(unittest.TestCase):
    def test_check_validates_without_calling_gcloud(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nVPS_HOST=1.2.3.4\n")
            # No PATH/gcloud override, no CLOUDSDK_ACTIVE_CONFIG_NAME: must still succeed.
            result = run_cli(["check", bundle_path])
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_reports_grammar_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle_path = os.path.join(tmp, "bundle.env")
            with open(bundle_path, "w") as fh:
                fh.write("[deploy]\nVPS_HOST=replace-me\n")
            result = run_cli(["check", bundle_path])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"replace-me", result.stderr)


class CloudsdkGuardTests(unittest.TestCase):
    def test_pull_refuses_without_cloudsdk_config_outside_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_file = os.path.join(tmp, "out.env")
            env = {"PATH": "/usr/bin:/bin"}  # no CLOUDSDK_ACTIVE_CONFIG_NAME, no GITHUB_ACTIONS
            # Deliberately do not put a fake gcloud on PATH: if the guard is
            # bypassed, this would fail with "gcloud not found" instead of
            # the guard's own message, which the assertion below catches.
            result = subprocess.run(
                [sys.executable, ENV_BUNDLE, "pull", "ai-trading", out_file],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"CLOUDSDK_ACTIVE_CONFIG_NAME", result.stderr)

    def test_pull_allowed_under_github_actions_without_cloudsdk_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = os.path.join(tmp, "bin")
            os.makedirs(bin_dir)
            write_fake_gcloud(bin_dir)
            state_dir = os.path.join(tmp, "state")
            secret_dir = os.path.join(state_dir, "ai-trading-env-bundle")
            os.makedirs(secret_dir)
            with open(os.path.join(secret_dir, "1.data"), "w") as fh:
                fh.write("[deploy]\nVPS_HOST=1.2.3.4\n")
            with open(os.path.join(secret_dir, "1.state"), "w") as fh:
                fh.write("ENABLED")

            out_file = os.path.join(tmp, "out.env")
            env = {
                "PATH": bin_dir + os.pathsep + os.environ["PATH"],
                "FAKE_GCLOUD_STATE_DIR": state_dir,
                "GITHUB_ACTIONS": "true",
            }
            result = run_cli(["pull", "ai-trading", out_file], env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(out_file) as fh:
                self.assertEqual(fh.read(), "[deploy]\nVPS_HOST=1.2.3.4\n")


if __name__ == "__main__":
    unittest.main()
