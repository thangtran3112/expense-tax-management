#!/usr/bin/env bash
# Fast, Docker-free static checks for .github/workflows/family-backup-freshness.yml
# (fix round 2): asserts the schedule is NOT hourly and the job skips
# without GCP_BACKUP_BUCKET configured. Same node+yaml pattern as
# infrastructure/temporal/test-temporal-infrastructure.sh. Wired into
# pnpm ci:test via check:vps-backup-infrastructure.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

node - "$ROOT" <<'JS'
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const YAML = require(process.argv[2] + "/expense-tax-management/node_modules/yaml");
const root = process.argv[2];
const workflow = YAML.parse(readFileSync(`${root}/.github/workflows/family-backup-freshness.yml`, "utf8"));

const schedules = workflow.on.schedule;
assert.equal(schedules.length, 1, "expected exactly one schedule entry");
const cron = schedules[0].cron;
assert.notEqual(cron, "0 * * * *",
  "must not run hourly: dev is the default branch, so merging an hourly schedule " +
  "activates it immediately and burns Actions minutes before any bucket exists");
assert.ok(/^\d{1,2} \d{1,2} \* \* \*$/.test(cron), `expected a once-daily cron (minute hour * * *), got: ${cron}`);

assert.ok("workflow_dispatch" in workflow.on, "must keep workflow_dispatch for an on-demand check");

const job = workflow.jobs["check-freshness"];
assert.ok(job.if, "job must have an if: guard");
assert.match(job.if, /GCP_BACKUP_BUCKET/, "job if: guard must reference GCP_BACKUP_BUCKET");
assert.match(job.if, /!=\s*(['"]{2}|"")/, "job if: guard must skip the job when GCP_BACKUP_BUCKET is empty");

console.log("PASS: family-backup-freshness.yml runs once daily (not hourly) and skips entirely without GCP_BACKUP_BUCKET set");
JS
