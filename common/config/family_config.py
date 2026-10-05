#!/usr/bin/env python3
"""family-config: the single Firestore store for family-app env, config, and keys.

Schema, commands, and examples: common/config/README.md.
Standard library only; gcloud supplies access tokens.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
REF_RE = re.compile(r"^shared/([a-z0-9][a-z0-9-]*)$")
RESERVED_NAMES = frozenset(
    "PATH HOME IFS SHELL USER LOGNAME PWD OLDPWD SHLVL ENV BASH_ENV CDPATH PS1 PS2 PS3 PS4".split()
)
RESERVED_PREFIXES = ("BASH", "LD_", "DYLD_", "FAMILY_CONFIG_", "CLOUDSDK_")
CONCURRENT_STATUSES = ("FAILED_PRECONDITION", "ALREADY_EXISTS")

USAGE = """\
usage: family_config.py <command> [args]

  run <app>/<profile>... [--env-file-var VAR] -- <cmd> [args...]
  render <app>/<profile>... --out-dir DIR
  get <target> <NAME>
  keys <target>
  ls
  set <target> <NAME> [--raw]                      value read from stdin
  unset <target> <NAME>
  link <app>/<profile> <ENV_NAME> shared/<group> [<KEY>]
  import <target> <dotenv-file>
  describe <target|app> <TEXT>
  with-file <target> <NAME> [--] <cmd> [args...]   {} becomes the file path

targets: shared/<group> or <app>/<profile>
"""


class ConfigError(Exception):
    """A failure reported as `family-config: <message>`. Never holds a value."""


class UsageError(Exception):
    """Bad command-line arguments."""


class FirestoreError(ConfigError):
    def __init__(self, method: str, code: int, status: str) -> None:
        super().__init__(f"Firestore {method} failed: HTTP {code} {status}".rstrip())
        self.status = status


class Store:
    """Firestore REST access with one gcloud access token per process."""

    def __init__(self) -> None:
        env = os.environ
        self.project = env.get("FAMILY_CONFIG_PROJECT", "tobytran-portfolio")
        database = env.get("FAMILY_CONFIG_DATABASE", "family-config")
        self.base = env.get("FAMILY_CONFIG_FIRESTORE_URL", "https://firestore.googleapis.com/v1").rstrip("/")
        self.root = f"projects/{self.project}/databases/{database}/documents"
        self._token: str | None = None
        self._user_mode = False

    def _fetch_token(self) -> str:
        command = ["gcloud", "auth", "print-access-token"]
        child_env = dict(os.environ)
        credentials = os.environ.get("FAMILY_CONFIG_CREDENTIALS", "")
        scratch = None
        try:
            if credentials:
                try:
                    regular = stat.S_ISREG(os.stat(credentials).st_mode)
                except OSError:
                    regular = False
                if not regular:
                    raise ConfigError("FAMILY_CONFIG_CREDENTIALS must point to a regular file")
                scratch = tempfile.mkdtemp(prefix="family-config-gcloud-")
                child_env["CLOUDSDK_CONFIG"] = scratch
                child_env["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = credentials
            elif os.environ.get("GITHUB_ACTIONS") != "true":
                # Never the active default configuration: on the operator laptop it is a work account.
                command.append(f"--configuration={os.environ.get('FAMILY_CONFIG_GCLOUD_CONFIG', 'personal')}")
                self._user_mode = True
            try:
                result = subprocess.run(command, env=child_env, capture_output=True, text=True, check=False)
            except FileNotFoundError:
                raise ConfigError("gcloud is not installed") from None
        finally:
            if scratch:
                shutil.rmtree(scratch, ignore_errors=True)
        token = result.stdout.strip()
        if result.returncode != 0 or not token:
            sys.stderr.write(result.stderr)
            raise ConfigError("gcloud could not provide an access token")
        return token

    def request(self, method: str, path: str, body=None, query=None):
        if self._token is None:
            self._token = self._fetch_token()
        url = f"{self.base}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self._token}")
        request.add_header("Content-Type", "application/json")
        if self._user_mode:
            request.add_header("x-goog-user-project", self.project)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:
            status = ""
            try:
                status = json.loads(error.read() or b"{}").get("error", {}).get("status", "")
            except (ValueError, AttributeError):
                pass
            raise FirestoreError(method, error.code, status) from None
        except urllib.error.URLError as error:
            raise ConfigError(f"cannot reach Firestore: {error.reason}") from None
        return json.loads(payload or b"{}")

    def read(self, paths: list[str]) -> dict[str, dict | None]:
        unique = list(dict.fromkeys(paths))
        response = self.request("POST", f"{self.root}:batchGet",
                                {"documents": [f"{self.root}/{path}" for path in unique]})
        docs: dict[str, dict | None] = {path: None for path in unique}
        prefix = f"{self.root}/"
        for item in response:
            found = item.get("found")
            if found:
                docs[found["name"][len(prefix):]] = found
        return docs

    def read_one(self, path: str) -> dict | None:
        return self.read([path])[path]

    def list_ids(self, collection: str, show_missing: bool = False) -> list[str]:
        ids: list[str] = []
        token = None
        while True:
            query = [("pageSize", "300")]
            if show_missing:
                query.append(("showMissing", "true"))
            if token:
                query.append(("pageToken", token))
            response = self.request("GET", f"{self.root}/{collection}", query=query)
            ids += [doc["name"].rsplit("/", 1)[1] for doc in response.get("documents", [])]
            token = response.get("nextPageToken")
            if not token:
                return sorted(ids)

    def patch(self, path: str, fields: dict, mask: list[str], update_time: str | None) -> None:
        query = [("updateMask.fieldPaths", field) for field in mask]
        if update_time:
            query.append(("currentDocument.updateTime", update_time))
        else:
            query.append(("currentDocument.exists", "false"))
        self.request("PATCH", f"{self.root}/{path}", {"fields": fields}, query)


# Parsing and validation --------------------------------------------------------


def parse_target(text: str, *kinds: str) -> tuple[str, str]:
    parts = text.split("/")
    if len(parts) == 2 and parts[0] == "shared" and ID_RE.match(parts[1]):
        kind, path = "shared", text
    elif len(parts) == 2 and parts[0] != "shared" and all(ID_RE.match(part) for part in parts):
        kind, path = "profile", f"apps/{parts[0]}/profiles/{parts[1]}"
    elif len(parts) == 1 and parts[0] != "shared" and ID_RE.match(parts[0]):
        kind, path = "app", f"apps/{parts[0]}"
    else:
        raise ConfigError(f"invalid target {text!r}")
    if kind not in kinds:
        raise ConfigError(f"{text}: expected a {' or '.join(kinds)} target")
    return kind, path


def check_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise ConfigError(f"invalid name {name!r}")


def check_env_name(name: str, where: str) -> None:
    check_name(name)
    if name in RESERVED_NAMES or name.startswith(RESERVED_PREFIXES):
        raise ConfigError(f"{where}: {name} is reserved")


def check_value(text: str, where: str, single_line: bool) -> None:
    if "\x00" in text:
        raise ConfigError(f"{where}: value contains NUL")
    if single_line and ("\n" in text or "\r" in text):
        raise ConfigError(f"{where}: value must be a single line")


def validate_entry(kind: str, target: str, name: str, value: str) -> None:
    if kind == "profile":
        check_env_name(name, target)
    else:
        check_name(name)
    check_value(value, f"{target} {name}", single_line=kind == "profile")


def decode_scalar(value: dict, where: str) -> str:
    if "stringValue" in value:
        text = value["stringValue"]
    elif "integerValue" in value:
        text = str(value["integerValue"])
    elif "booleanValue" in value:
        text = "true" if value["booleanValue"] else "false"
    else:
        raise ConfigError(f"{where}: unsupported value type")
    check_value(text, where, single_line=False)
    return text


def parse_ref(fields: dict, name: str, where: str) -> tuple[str, str]:
    if "ref" not in fields or set(fields) - {"ref", "key"}:
        raise ConfigError(f"{where}: a reference holds 'ref' and an optional 'key'")
    match = REF_RE.match(fields["ref"].get("stringValue", ""))
    key = fields.get("key", {"stringValue": name}).get("stringValue", "")
    if not match or not NAME_RE.match(key):
        raise ConfigError(f"{where}: invalid reference (expected ref shared/<group>)")
    return match.group(1), key


def parse_values(doc: dict, label: str, refs_allowed: bool) -> dict[str, str | tuple[str, str]]:
    raw = doc.get("fields", {}).get("values")
    if raw is None:
        return {}
    if "mapValue" not in raw:
        raise ConfigError(f"{label}: 'values' must be a map")
    parsed: dict[str, str | tuple[str, str]] = {}
    for name, value in raw["mapValue"].get("fields", {}).items():
        where = f"{label} {name}"
        if not NAME_RE.match(name):
            raise ConfigError(f"{label}: invalid name {name!r}")
        if "mapValue" in value:
            if not refs_allowed:
                raise ConfigError(f"{where}: shared values cannot be references")
            parsed[name] = parse_ref(value["mapValue"].get("fields", {}), name, where)
        else:
            parsed[name] = decode_scalar(value, where)
    return parsed


def ref_value(name: str, group: str, key: str) -> dict:
    fields = {"ref": {"stringValue": f"shared/{group}"}}
    if key != name:
        fields["key"] = {"stringValue": key}
    return {"mapValue": {"fields": fields}}


def parse_dotenv(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export "):].lstrip()
        name, separator, value = stripped.partition("=")
        name, value = name.strip(), value.strip()
        if not separator or not NAME_RE.match(name):
            raise ConfigError(f"line {number}: expected NAME=VALUE")
        if value[:1] in ("'", '"'):
            end = value.find(value[0], 1)
            rest = value[end + 1:].strip() if end != -1 else ""
            if end == -1 or (rest and not rest.startswith("#")):
                raise ConfigError(f"line {number}: unterminated or trailing quote")
            value = value[1:end]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        values[name] = value
    return values


# Resolution, writes, and process helpers -----------------------------------------


def resolve(store: Store, targets: list[str]) -> list[tuple[str, dict[str, str]]]:
    """Resolves profile targets to [(target, {ENV_NAME: value})] in target order."""
    paths = [parse_target(target, "profile")[1] for target in targets]
    docs = store.read(paths)
    profiles = []
    groups: set[str] = set()
    for target, path in zip(targets, paths):
        doc = docs[path]
        if doc is None:
            raise ConfigError(f"profile not found: {target}")
        values = parse_values(doc, target, refs_allowed=True)
        for name, value in values.items():
            check_env_name(name, target)
            if isinstance(value, tuple):
                groups.add(value[0])
        profiles.append((target, values))
    shared: dict[str, dict] = {}
    if groups:
        group_docs = store.read([f"shared/{group}" for group in sorted(groups)])
        for group in groups:
            doc = group_docs[f"shared/{group}"]
            if doc is not None:
                shared[group] = parse_values(doc, f"shared/{group}", refs_allowed=False)
    resolved = []
    for target, values in profiles:
        out: dict[str, str] = {}
        for name, value in values.items():
            where = f"{target} {name}"
            if isinstance(value, tuple):
                group, key = value
                if key not in shared.get(group, {}):
                    raise ConfigError(f"{where}: shared/{group} has no {key}")
                value = shared[group][key]
            check_value(value, where, single_line=True)
            out[name] = value
        resolved.append((target, out))
    return resolved


def lookup(store: Store, target: str, name: str) -> str:
    kind, path = parse_target(target, "shared", "profile")
    if kind == "profile":
        values = resolve(store, [target])[0][1]
    else:
        doc = store.read_one(path)
        if doc is None:
            raise ConfigError(f"not found: {target}")
        values = parse_values(doc, target, refs_allowed=False)
    if name not in values:
        raise ConfigError(f"{target} has no {name}")
    return values[name]


def write(store: Store, label: str, path: str, changes: dict, description: str | None = None) -> None:
    """Applies {NAME: firestore value | None (delete)} with a precondition, then verifies."""
    doc = store.read_one(path)
    fields = (doc or {}).get("fields", {})
    current = fields.get("values", {}).get("mapValue", {}).get("fields", {})
    mask_paths: list[str] = []
    new_values: dict = {}
    for name, value in changes.items():
        if value is None:
            if name in current:
                mask_paths.append(f"values.{name}")
        elif current.get(name) != value:
            mask_paths.append(f"values.{name}")
            new_values[name] = value
    body: dict = {}
    if new_values:
        body["values"] = {"mapValue": {"fields": new_values}}
    if description is not None and fields.get("description") != {"stringValue": description}:
        mask_paths.append("description")
        body["description"] = {"stringValue": description}
    if not mask_paths:
        print(f"unchanged {label}")
        return
    try:
        store.patch(path, body, mask_paths, doc.get("updateTime") if doc else None)
    except FirestoreError as error:
        if error.status in CONCURRENT_STATUSES:
            raise ConfigError(f"{label} changed concurrently; re-run") from None
        raise
    after = (store.read_one(path) or {}).get("fields", {})
    stored = after.get("values", {}).get("mapValue", {}).get("fields", {})
    for name, value in changes.items():
        if stored.get(name) != value:
            raise ConfigError(f"{label} {name}: verification failed after write")
    if description is not None and after.get("description") != {"stringValue": description}:
        raise ConfigError(f"{label}: description verification failed after write")
    print(f"updated {label}: {len(mask_paths)} field(s)")


def mask(values) -> None:
    """Registers every non-empty value line with GitHub Actions log redaction."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    for value in values:
        for line in value.splitlines():
            if line.strip():
                print(f"::add-mask::{line}")
    sys.stdout.flush()


def dotenv(values: dict[str, str]) -> str:
    return "".join(f"{name}={values[name]}\n" for name in sorted(values))


def private_dir() -> str:
    base = "/dev/shm" if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK) else None
    return tempfile.mkdtemp(prefix="family-config-", dir=base)


def write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(text.encode("utf-8"))


def run_child(command: list[str], env: dict[str, str]) -> int:
    try:
        child = subprocess.Popen(command, env=env)
    except OSError as error:
        raise ConfigError(f"cannot run {command[0]}: {error.strerror}") from None

    def forward(signum, _frame):
        child.send_signal(signum)

    # Set after the fork so the child keeps default handlers; the terminal already
    # delivers Ctrl-C to the child's process group, so the parent ignores SIGINT.
    previous = {
        signal.SIGINT: signal.signal(signal.SIGINT, signal.SIG_IGN),
        signal.SIGTERM: signal.signal(signal.SIGTERM, forward),
        signal.SIGHUP: signal.signal(signal.SIGHUP, forward),
    }
    try:
        code = child.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    return 128 - code if code < 0 else code


def split_command(args: list[str], required: bool) -> tuple[list[str], list[str]]:
    if "--" not in args:
        if required:
            raise UsageError("put -- before the command")
        return list(args), []
    index = args.index("--")
    return list(args[:index]), list(args[index + 1:])


def take_option(args: list[str], option: str) -> str | None:
    if option not in args:
        return None
    index = args.index(option)
    if index + 1 >= len(args):
        raise UsageError(f"{option} needs a value")
    value = args[index + 1]
    del args[index:index + 2]
    return value


# Commands -------------------------------------------------------------------------


def cmd_run(store: Store, args: list[str]) -> int:
    head, command = split_command(args, required=True)
    env_file_var = take_option(head, "--env-file-var")
    if env_file_var is not None:
        check_env_name(env_file_var, "--env-file-var")
    if not head or not command:
        raise UsageError("run needs at least one profile and a command")
    merged: dict[str, str] = {}
    for _, values in resolve(store, head):
        merged.update(values)
    mask(merged.values())
    env = {**os.environ, **merged}
    scratch = None
    try:
        if env_file_var:
            scratch = private_dir()
            env[env_file_var] = os.path.join(scratch, "env")
            write_private(env[env_file_var], dotenv(merged))
        return run_child(command, env)
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)


def cmd_render(store: Store, args: list[str]) -> int:
    targets = list(args)
    out_dir = take_option(targets, "--out-dir")
    if out_dir is None or not targets:
        raise UsageError("render needs profiles and --out-dir DIR")
    profiles = [target.split("/")[-1] for target in targets]
    if len(set(profiles)) != len(profiles):
        raise ConfigError("render targets need distinct profile names")
    resolved = resolve(store, targets)
    for _, values in resolved:
        mask(values.values())
    try:
        os.makedirs(out_dir, mode=0o700, exist_ok=True)
        os.chmod(out_dir, 0o700)
    except OSError as error:
        raise ConfigError(f"cannot prepare {out_dir}: {error.strerror}") from None
    for profile, (_, values) in zip(profiles, resolved):
        fd, temp = tempfile.mkstemp(dir=out_dir, prefix=f".{profile}.env.")
        with os.fdopen(fd, "wb") as handle:
            handle.write(dotenv(values).encode("utf-8"))
        final = os.path.join(out_dir, f"{profile}.env")
        os.replace(temp, final)
        print(final)
    return 0


def cmd_get(store: Store, args: list[str]) -> int:
    if len(args) != 2:
        raise UsageError("get needs <target> <NAME>")
    value = lookup(store, args[0], args[1])
    mask([value])
    sys.stdout.write(value)
    sys.stdout.flush()
    return 0


def cmd_keys(store: Store, args: list[str]) -> int:
    if len(args) != 1:
        raise UsageError("keys needs <target>")
    kind, path = parse_target(args[0], "shared", "profile")
    doc = store.read_one(path)
    if doc is None:
        raise ConfigError(f"not found: {args[0]}")
    for name, value in sorted(parse_values(doc, args[0], refs_allowed=kind == "profile").items()):
        if isinstance(value, tuple):
            group, key = value
            print(f"{name} -> shared/{group}" + ("" if key == name else f":{key}"))
        else:
            print(name)
    return 0


def cmd_ls(store: Store, args: list[str]) -> int:
    if args:
        raise UsageError("ls takes no arguments")
    for group in store.list_ids("shared"):
        print(f"shared/{group}")
    for app in store.list_ids("apps", show_missing=True):
        for profile in store.list_ids(f"apps/{app}/profiles"):
            print(f"{app}/{profile}")
    return 0


def cmd_set(store: Store, args: list[str]) -> int:
    raw = "--raw" in args
    args = [arg for arg in args if arg != "--raw"]
    if len(args) != 2:
        raise UsageError("set needs <target> <NAME>")
    target, name = args
    kind, path = parse_target(target, "shared", "profile")
    data = sys.stdin.buffer.read()
    if not raw and data.endswith(b"\n"):
        data = data[:-1]
    try:
        value = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ConfigError("value must be valid UTF-8") from None
    validate_entry(kind, target, name, value)
    write(store, target, path, {name: {"stringValue": value}})
    return 0


def cmd_unset(store: Store, args: list[str]) -> int:
    if len(args) != 2:
        raise UsageError("unset needs <target> <NAME>")
    target, name = args
    _, path = parse_target(target, "shared", "profile")
    check_name(name)
    write(store, target, path, {name: None})
    return 0


def cmd_link(store: Store, args: list[str]) -> int:
    if len(args) not in (3, 4):
        raise UsageError("link needs <app>/<profile> <ENV_NAME> shared/<group> [<KEY>]")
    target, name, group_target = args[:3]
    key = args[3] if len(args) == 4 else name
    _, path = parse_target(target, "profile")
    check_env_name(name, target)
    check_name(key)
    match = REF_RE.match(group_target)
    if not match:
        raise ConfigError(f"invalid reference target {group_target!r}")
    group_doc = store.read_one(group_target)
    if group_doc is None or key not in parse_values(group_doc, group_target, refs_allowed=False):
        raise ConfigError(f"{group_target} has no {key}")
    write(store, target, path, {name: ref_value(name, match.group(1), key)})
    return 0


def cmd_import(store: Store, args: list[str]) -> int:
    if len(args) != 2:
        raise UsageError("import needs <target> <dotenv-file>")
    target, source = args
    kind, path = parse_target(target, "shared", "profile")
    try:
        with open(source, encoding="utf-8") as handle:
            values = parse_dotenv(handle.read())
    except (OSError, UnicodeDecodeError):
        raise ConfigError(f"cannot read {source} as UTF-8 text") from None
    for name, value in values.items():
        validate_entry(kind, target, name, value)
    write(store, target, path, {name: {"stringValue": value} for name, value in values.items()})
    print(f"imported {len(values)} name(s) into {target}")
    return 0


def cmd_describe(store: Store, args: list[str]) -> int:
    if len(args) != 2:
        raise UsageError("describe needs <target|app> <TEXT>")
    target, text = args
    _, path = parse_target(target, "shared", "profile", "app")
    check_value(text, f"{target} description", single_line=False)
    write(store, target, path, {}, description=text)
    return 0


def cmd_with_file(store: Store, args: list[str]) -> int:
    if "--" in args:
        head, command = split_command(args, required=True)
    else:
        head, command = list(args[:2]), list(args[2:])
    if len(head) != 2 or not command:
        raise UsageError("with-file needs <target> <NAME> and a command")
    value = lookup(store, head[0], head[1])
    mask([value])
    scratch = private_dir()
    try:
        path = os.path.join(scratch, "file")
        write_private(path, value)
        return run_child([path if arg == "{}" else arg for arg in command], dict(os.environ))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


COMMANDS = {
    "run": cmd_run,
    "render": cmd_render,
    "get": cmd_get,
    "keys": cmd_keys,
    "ls": cmd_ls,
    "set": cmd_set,
    "unset": cmd_unset,
    "link": cmd_link,
    "import": cmd_import,
    "describe": cmd_describe,
    "with-file": cmd_with_file,
}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(USAGE)
        return 0 if args else 2
    handler = COMMANDS.get(args[0])
    if handler is None:
        sys.stderr.write(USAGE)
        return 2
    try:
        return handler(Store(), list(args[1:]))
    except UsageError as error:
        sys.stderr.write(f"family-config: {error}\n{USAGE}")
        return 2
    except ConfigError as error:
        sys.stderr.write(f"family-config: {error}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
