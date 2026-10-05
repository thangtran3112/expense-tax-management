#!/usr/bin/env python3
"""ai-trading Secret Manager bundle tool. See README.md for the grammar and
the single-version policy. Python 3.9+ standard library only.

Usage:
  env-bundle.py [--project P] pull APP OUT_FILE
  env-bundle.py [--project P] push APP IN_FILE
  env-bundle.py [--project P] render APP --out-dir DIR [--bundle-file F] SECTION...
  env-bundle.py [--project P] exec APP [--bundle-file F] SECTION... -- CMD ARGS...
  env-bundle.py [--project P] get-file SECRET KEY OUT_FILE
  env-bundle.py check IN_FILE
"""
from __future__ import annotations

import subprocess
import sys

import bundle_lib


def usage_error(message: str):
    print(message, file=sys.stderr)
    raise SystemExit(2)


def require(tokens: list, n: int, usage: str) -> tuple:
    if len(tokens) != n:
        usage_error(f"usage: {usage}")
    return tuple(tokens)


def take_flag(tokens: list, flag: str):
    """Return (value, remaining_tokens) if `flag value` is present, else (None, tokens)."""
    if flag in tokens:
        idx = tokens.index(flag)
        if idx + 1 >= len(tokens):
            usage_error(f"{flag} requires a value")
        return tokens[idx + 1], tokens[:idx] + tokens[idx + 2 :]
    return None, tokens


def cmd_render_args(rest: list):
    if not rest:
        usage_error("usage: render APP --out-dir DIR [--bundle-file F] SECTION...")
    app, rest = rest[0], rest[1:]
    out_dir, rest = take_flag(rest, "--out-dir")
    bundle_file, rest = take_flag(rest, "--bundle-file")
    if out_dir is None or not rest:
        usage_error("usage: render APP --out-dir DIR [--bundle-file F] SECTION...")
    return app, bundle_file, out_dir, rest


def cmd_exec_args(rest: list):
    if "--" not in rest:
        usage_error("usage: exec APP [--bundle-file F] SECTION... -- CMD ARGS...")
    idx = rest.index("--")
    head, cmd = rest[:idx], rest[idx + 1 :]
    if not head or not cmd:
        usage_error("usage: exec APP [--bundle-file F] SECTION... -- CMD ARGS...")
    app, head = head[0], head[1:]
    bundle_file, head = take_flag(head, "--bundle-file")
    if not head:
        usage_error("usage: exec APP [--bundle-file F] SECTION... -- CMD ARGS...")
    return app, bundle_file, head, cmd


def main(argv: list) -> int:
    argv = argv[1:]
    project = bundle_lib.DEFAULT_PROJECT
    if argv and argv[0] == "--project":
        if len(argv) < 2:
            usage_error("--project requires a value")
        project, argv = argv[1], argv[2:]
    if not argv:
        usage_error("missing command")
    command, rest = argv[0], argv[1:]

    try:
        if command == "pull":
            app, out_file = require(rest, 2, "pull APP OUT_FILE")
            bundle_lib.cmd_pull(project, app, out_file)
        elif command == "push":
            app, in_file = require(rest, 2, "push APP IN_FILE")
            bundle_lib.cmd_push(project, app, in_file)
        elif command == "check":
            (in_file,) = require(rest, 1, "check IN_FILE")
            bundle_lib.cmd_check(in_file)
        elif command == "get-file":
            secret, key, out_file = require(rest, 3, "get-file SECRET KEY OUT_FILE")
            bundle_lib.cmd_get_file(project, secret, key, out_file)
        elif command == "render":
            app, bundle_file, out_dir, sections = cmd_render_args(rest)
            bundle_lib.cmd_render(project, app, bundle_file, out_dir, sections)
        elif command == "exec":
            app, bundle_file, sections, cmd = cmd_exec_args(rest)
            return bundle_lib.cmd_exec(project, app, bundle_file, sections, cmd)
        else:
            usage_error(f"unknown command: {command}")
    except bundle_lib.BundleError as exc:
        print(f"bundle error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", "replace") if exc.stderr else ""
        print(f"gcloud failed ({exc.returncode}): {stderr.strip()}", file=sys.stderr)
        return exc.returncode or 1
    except (RuntimeError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
