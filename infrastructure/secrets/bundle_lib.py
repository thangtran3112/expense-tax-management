"""Shared grammar, gcloud wrapper, and command logic for env-bundle.py.

Python 3.9+ standard library only. Kept separate from env-bundle.py (which
cannot be `import`ed directly because of its hyphen) so both the CLI and
test_env_bundle.py share one implementation.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict

DEFAULT_PROJECT = "tobytran-portfolio"
REQUIRED_CLOUDSDK_CONFIG = "personal"

SECTION_RE = re.compile(r"^\[([a-z0-9][a-z0-9-]*)\]$")
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class BundleError(Exception):
    """A bundle grammar violation, with the 1-indexed line number."""

    def __init__(self, line: int, message: str):
        super().__init__(f"line {line}: {message}")
        self.line = line
        self.message = message


def parse_bundle(text: str) -> "OrderedDict[str, OrderedDict[str, str]]":
    """Parse the INI-style bundle grammar.

    Returns an ordered dict of section name to ordered dict of key to value.
    Raises BundleError (with the offending line number) on any violation:
    duplicate sections/keys, bad names, empty/placeholder values, a key
    before any section, NUL/CR bytes, or a line that is none of comment,
    blank, section header, or KEY=value.
    """
    sections: "OrderedDict[str, OrderedDict[str, str]]" = OrderedDict()
    current: str | None = None

    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]  # drop the empty tail from a trailing newline

    for line_no, line in enumerate(lines, start=1):
        if "\x00" in line:
            raise BundleError(line_no, "NUL byte is not allowed")
        if "\r" in line:
            raise BundleError(line_no, "CR is not allowed (use LF, no embedded CR)")

        if line.strip() == "" or line.startswith("#"):
            continue

        if line.startswith("["):
            match = SECTION_RE.match(line)
            if not match:
                raise BundleError(line_no, f"invalid section header: {line!r}")
            name = match.group(1)
            if name in sections:
                raise BundleError(line_no, f"duplicate section: {name!r}")
            sections[name] = OrderedDict()
            current = name
            continue

        if current is None:
            raise BundleError(line_no, "KEY=value line before any [section]")

        if "=" not in line:
            raise BundleError(line_no, f"expected KEY=value, got: {line!r}")
        key, value = line.split("=", 1)
        if not KEY_RE.match(key):
            raise BundleError(line_no, f"invalid key name: {key!r}")
        if key in sections[current]:
            raise BundleError(line_no, f"duplicate key {key!r} in section [{current}]")
        if value == "":
            raise BundleError(line_no, f"empty value for key {key!r}")
        if value == "replace-me":
            raise BundleError(line_no, f"placeholder value 'replace-me' for key {key!r}")

        sections[current][key] = value

    return sections


def render_env(items: "OrderedDict[str, str]") -> str:
    """Render one section's keys as a KEY=value env file body."""
    if not items:
        return ""
    return "".join(f"{k}={v}\n" for k, v in items.items())


# --- gcloud wrapper and GitHub Actions helpers -----------------------------


def is_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def check_cloudsdk_guard() -> None:
    """Outside GitHub Actions, refuse to call gcloud unless
    CLOUDSDK_ACTIVE_CONFIG_NAME is exactly "personal" (controller ruling,
    ai-trading/AGENTS.md) -- the operator machine's default config
    ("chartflow") is a different (work) account, and any other explicit
    value is just as wrong a target as the default."""
    if is_github_actions():
        return
    if os.environ.get("CLOUDSDK_ACTIVE_CONFIG_NAME") != REQUIRED_CLOUDSDK_CONFIG:
        print(
            f"CLOUDSDK_ACTIVE_CONFIG_NAME must be set to {REQUIRED_CLOUDSDK_CONFIG!r}"
            " outside GitHub Actions before calling gcloud",
            file=sys.stderr,
        )
        raise SystemExit(1)


def gcloud(args: list, input_bytes: bytes | None = None) -> bytes:
    """Thin wrapper so tests can replace `gcloud` on PATH with a fake."""
    check_cloudsdk_guard()
    result = subprocess.run(
        ["gcloud", *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


def emit_masks(value: str) -> None:
    """Under GitHub Actions, mask every non-empty line of a value read from
    Secret Manager (multi-line values: one ::add-mask:: per line)."""
    if not is_github_actions():
        return
    for line in value.split("\n"):
        if line:
            print(f"::add-mask::{line}")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_file(path: str, data: bytes, mode: int = 0o600) -> None:
    """Create/overwrite `path` with `mode` from the moment it exists -- never
    process-default-then-chmod, so secret contents are never briefly
    readable under a wider mode."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.fchmod(fd, mode)  # in case the file pre-existed with a wider mode
    except BaseException:
        os.close(fd)
        raise
    with os.fdopen(fd, "wb") as fh:  # fdopen now owns fd's lifecycle
        fh.write(data)


def ensure_dir(path: str, mode: int = 0o700) -> None:
    os.makedirs(path, exist_ok=True)
    os.chmod(path, mode)


# --- bundle loading (file or Secret Manager) -------------------------------


def load_bundle(project: str, app: str, bundle_file: str | None):
    """Load and parse the bundle, from `bundle_file` if given, else pull the
    latest `{app}-env-bundle` version from Secret Manager."""
    if bundle_file:
        with open(bundle_file, "rb") as fh:
            data = fh.read()
    else:
        data = pull_bundle(project, app)
    return parse_bundle(data.decode("utf-8"))


def pull_bundle(project: str, app: str) -> bytes:
    secret_id = f"{app}-env-bundle"
    return gcloud(["secrets", "versions", "access", "latest", "--secret", secret_id, "--project", project])


# --- commands ---------------------------------------------------------------


def cmd_pull(project: str, app: str, out_file: str) -> None:
    data = pull_bundle(project, app)
    write_file(out_file, data, 0o600)


def cmd_check(in_file: str) -> None:
    with open(in_file, "rb") as fh:
        data = fh.read()
    parse_bundle(data.decode("utf-8"))
    print(f"ok: {in_file}")


def _active_version_ids(project: str, secret_id: str) -> list:
    out = gcloud(["secrets", "versions", "list", secret_id, "--project", project, "--format=json"])
    versions = json.loads(out.decode("utf-8") or "[]")
    return [v["name"].rsplit("/", 1)[-1] for v in versions if v.get("state") != "DESTROYED"]


def cmd_push(project: str, app: str, in_file: str) -> None:
    secret_id = f"{app}-env-bundle"
    with open(in_file, "rb") as fh:
        data = fh.read()
    parse_bundle(data.decode("utf-8"))  # validate before upload

    add_out = gcloud(
        ["secrets", "versions", "add", secret_id, "--project", project, "--data-file=-", "--format=value(name)"],
        input_bytes=data,
    )
    resource_name = add_out.decode("utf-8").strip()
    if not resource_name:
        raise RuntimeError("gcloud did not return a new secret version name")
    new_version = resource_name.rsplit("/", 1)[-1]

    verify_data = gcloud(["secrets", "versions", "access", new_version, "--secret", secret_id, "--project", project])
    if sha256_hex(verify_data) != sha256_hex(data):
        raise RuntimeError("uploaded secret version hash mismatch")

    for version in _active_version_ids(project, secret_id):
        if version != new_version:
            gcloud(["secrets", "versions", "destroy", version, "--secret", secret_id, "--project", project, "--quiet"])

    remaining = _active_version_ids(project, secret_id)
    if remaining != [new_version]:
        raise RuntimeError(
            f"postcondition failed: expected exactly one non-destroyed version {new_version!r}, got {remaining!r}"
        )
    print(f"pushed {secret_id} version {new_version}")


def cmd_render(project: str, app: str, bundle_file: str | None, out_dir: str, section_names: list) -> None:
    sections = load_bundle(project, app, bundle_file)
    for name in section_names:
        if name not in sections:
            raise RuntimeError(f"missing section: {name!r}")
    ensure_dir(out_dir, 0o700)
    for name in section_names:
        items = sections[name]
        for value in items.values():
            emit_masks(value)
        write_file(os.path.join(out_dir, f"{name}.env"), render_env(items).encode("utf-8"), 0o600)


def cmd_exec(project: str, app: str, bundle_file: str | None, section_names: list, cmd: list) -> int:
    sections = load_bundle(project, app, bundle_file)
    env = dict(os.environ)
    for name in section_names:
        if name not in sections:
            raise RuntimeError(f"missing section: {name!r}")
        items = sections[name]
        for value in items.values():
            emit_masks(value)
        env.update(items)  # later sections win
    result = subprocess.run(cmd, env=env)
    return result.returncode


def cmd_get_file(project: str, secret: str, key: str, out_file: str) -> None:
    data = gcloud(["secrets", "versions", "access", "latest", "--secret", secret, "--project", project])
    obj = json.loads(data.decode("utf-8"))
    if key not in obj:
        raise RuntimeError(f"key not found in {secret!r}: {key!r}")
    value = obj[key]
    if not isinstance(value, str):
        raise RuntimeError(f"value for key {key!r} in {secret!r} is not a string")
    emit_masks(value)
    write_file(out_file, value.encode("utf-8"), 0o600)
