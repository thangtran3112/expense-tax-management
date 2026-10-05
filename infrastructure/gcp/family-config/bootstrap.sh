#!/usr/bin/env bash
# Creates the family-app config store: Firestore database family-config with
# deny-all client rules, plus the read-only VPS service account. Safe to re-run.
# Usage: infrastructure/gcp/family-config/bootstrap.sh
set -Eeuo pipefail
umask 077

PROJECT="${FAMILY_CONFIG_PROJECT:-tobytran-portfolio}"
DATABASE="${FAMILY_CONFIG_DATABASE:-family-config}"
CONFIGURATION="${FAMILY_CONFIG_GCLOUD_CONFIG:-personal}"
LOCATION="northamerica-northeast1"
READER="family-config-reader"
READER_EMAIL="$READER@$PROJECT.iam.gserviceaccount.com"
RULES_API="https://firebaserules.googleapis.com/v1"
RELEASE="projects/$PROJECT/releases/cloud.firestore/$DATABASE"
RULES="$(cat <<'RULES_EOF'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
RULES_EOF
)"

g() { gcloud --configuration="$CONFIGURATION" --project="$PROJECT" "$@"; }

# Firebase Rules API call; the access token travels through curl's stdin config, never argv.
rules_api() {
  local method="$1" path="$2" body="${3:-}" token
  local args=(--silent --show-error --fail --max-time 30 --request "$method" --config -)
  [[ -z "$body" ]] || args+=(--data "$body")
  token="$(gcloud --configuration="$CONFIGURATION" auth print-access-token)"
  printf 'header = "Authorization: Bearer %s"\nheader = "x-goog-user-project: %s"\nheader = "Content-Type: application/json"\n' \
    "$token" "$PROJECT" | curl "${args[@]}" "$RULES_API/$path"
}

g services enable firestore.googleapis.com firebaserules.googleapis.com iam.googleapis.com

if g firestore databases describe --database="$DATABASE" >/dev/null 2>&1; then
  echo "database $DATABASE exists"
else
  g firestore databases create --database="$DATABASE" --location="$LOCATION" \
    --type=firestore-native --delete-protection
fi

current_ruleset="$(rules_api GET "$RELEASE" 2>/dev/null | jq -r '.rulesetName // empty' || true)"
current_source=""
if [[ -n "$current_ruleset" ]]; then
  current_source="$(rules_api GET "$current_ruleset" | jq -r '.source.files[0].content // empty')"
fi
if [[ "$current_source" == "$RULES" ]]; then
  echo "deny-all rules already released for $DATABASE"
else
  ruleset="$(rules_api POST "projects/$PROJECT/rulesets" \
    "$(jq -n --arg content "$RULES" '{source: {files: [{name: "firestore.rules", content: $content}]}}')" | jq -r '.name')"
  if [[ -n "$current_ruleset" ]]; then
    rules_api PATCH "$RELEASE" \
      "$(jq -n --arg name "$RELEASE" --arg ruleset "$ruleset" '{release: {name: $name, rulesetName: $ruleset}}')" >/dev/null
  else
    rules_api POST "projects/$PROJECT/releases" \
      "$(jq -n --arg name "$RELEASE" --arg ruleset "$ruleset" '{name: $name, rulesetName: $ruleset}')" >/dev/null
  fi
  echo "released deny-all rules for $DATABASE"
fi

if g iam service-accounts describe "$READER_EMAIL" >/dev/null 2>&1; then
  echo "service account $READER_EMAIL exists"
else
  g iam service-accounts create "$READER" --display-name="Family config reader (VPS)"
fi

# A new service account can take a few seconds to become visible to IAM.
for attempt in 1 2 3 4 5 6; do
  if gcloud --configuration="$CONFIGURATION" projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$READER_EMAIL" \
    --role=roles/datastore.viewer \
    --condition="expression=resource.name == \"projects/$PROJECT/databases/$DATABASE\",title=family-config-only" \
    --quiet >/dev/null; then
    break
  fi
  ((attempt < 6)) || exit 1
  sleep 5
done
echo "family-config ready: database $DATABASE ($LOCATION), reader $READER_EMAIL"
