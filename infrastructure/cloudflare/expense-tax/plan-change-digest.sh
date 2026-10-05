#!/usr/bin/env bash
# Reads `terraform show -json <planfile>` on stdin and prints a SHA-256 digest
# of the planned resource addresses and actions only. Attribute values, which
# can be sensitive, never leave jq; only the digest is printed.
set -euo pipefail

plan_json="$(cat)"
jq -e 'type == "object"' >/dev/null <<<"$plan_json" || {
  echo "plan-change-digest: input is not Terraform plan JSON" >&2
  exit 1
}
jq -cS '[.resource_changes[]? | select(.change.actions != ["no-op"]) | {address, actions: .change.actions}] | sort_by(.address)' <<<"$plan_json" |
  shasum -a 256 | cut -d' ' -f1
