#!/usr/bin/env bash
# Local health command (Task 6): fails when the latest successful backup
# marker is missing or its recorded cutoff is at least MAX_AGE_HOURS old.
# Pure bash + jq + epoch arithmetic -- no GNU-only date flags -- so it runs
# identically on the VPS (Linux) and in CI/local dev (any OS).
#
# Usage: check-backup-freshness.sh [MARKER_FILE] [MAX_AGE_HOURS]
#   MARKER_FILE     default: $BACKUP_STATE_DIR/last-success.json, or
#                   /opt/family-app/backup/state/last-success.json
#   MAX_AGE_HOURS   default: 24 (the plan's RPO)
set -euo pipefail

marker_file="${1:-${BACKUP_STATE_DIR:-/opt/family-app/backup/state}/last-success.json}"
max_age_hours="${2:-24}"

if [[ ! -s "$marker_file" ]]; then
  echo "STALE: no successful backup marker found at $marker_file" >&2
  exit 1
fi

cutoff_epoch=$(jq -r '.cutoff_epoch' "$marker_file")
if [[ -z "$cutoff_epoch" || "$cutoff_epoch" == "null" ]]; then
  echo "STALE: marker at $marker_file has no cutoff_epoch" >&2
  exit 1
fi

now_epoch=$(date -u +%s)
age_hours=$(( (now_epoch - cutoff_epoch) / 3600 ))

if (( age_hours >= max_age_hours )); then
  echo "STALE: latest successful backup is ${age_hours}h old (>= ${max_age_hours}h RPO)" >&2
  exit 1
fi

echo "FRESH: latest successful backup is ${age_hours}h old"
