#!/usr/bin/env bash
set -euo pipefail

container=${TEMPORAL_CONTAINER:-family-temporal}
address=${TEMPORAL_ADDRESS:-temporal:7233}

if ! docker exec "$container" temporal operator cluster health --address "$address" >/dev/null 2>&1; then
  printf '%s\n' "Shared Temporal is not healthy; namespace bootstrap stopped" >&2
  exit 1
fi

if docker exec "$container" temporal operator namespace describe \
  --address "$address" --namespace expense-tax >/dev/null 2>&1; then
  printf '%s\n' "Temporal namespace expense-tax already exists"
else
  docker exec "$container" temporal operator namespace create \
    --address "$address" --namespace expense-tax --retention 72h \
    --description "Expense Tax workflows" >/dev/null
  printf '%s\n' "Created Temporal namespace expense-tax"
fi

docker exec "$container" temporal operator namespace describe \
  --address "$address" --namespace expense-tax >/dev/null
