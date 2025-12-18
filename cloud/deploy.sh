#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd gcloud

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"

WEB_SERVICE_NAME="${WEB_SERVICE_NAME:-planeage-web}"
REFRESH_JOB_NAME="${REFRESH_JOB_NAME:-planeage-refresh}"

GCS_BUCKET="${GCS_BUCKET:-${BUCKET:-}}"
GCS_MANIFEST_OBJECT="${GCS_MANIFEST_OBJECT:-faa/current.json}"
GCS_PREFIX="${GCS_PREFIX:-faa}"

RAPIDAPI_SECRET_NAME="${RAPIDAPI_SECRET_NAME:-rapidapi-key}"

WEB_SERVICE_ACCOUNT="${WEB_SERVICE_ACCOUNT:-}"
REFRESH_SERVICE_ACCOUNT="${REFRESH_SERVICE_ACCOUNT:-}"

REFRESH_TASK_TIMEOUT="${REFRESH_TASK_TIMEOUT:-3600s}"
REFRESH_MEMORY="${REFRESH_MEMORY:-2Gi}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set PROJECT_ID (or run: gcloud config set project <id>)" >&2
  exit 1
fi

if [[ -z "$GCS_BUCKET" ]]; then
  echo "Set GCS_BUCKET (the Cloud Storage bucket that will hold FAA data)" >&2
  exit 1
fi

maybe_set_service_account_flag() {
  local -r sa="$1"
  if [[ -n "$sa" ]]; then
    echo "--service-account=$sa"
  fi
}

echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo "Bucket:  $GCS_BUCKET"

if [[ -n "${RAPIDAPI_KEY:-}" ]]; then
  echo "Upserting Secret Manager secret: $RAPIDAPI_SECRET_NAME"
  if gcloud secrets describe "$RAPIDAPI_SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf %s "$RAPIDAPI_KEY" | gcloud secrets versions add "$RAPIDAPI_SECRET_NAME" --project "$PROJECT_ID" --data-file=-
  else
    printf %s "$RAPIDAPI_KEY" | gcloud secrets create "$RAPIDAPI_SECRET_NAME" --project "$PROJECT_ID" --replication-policy=automatic --data-file=-
  fi
else
  echo "RAPIDAPI_KEY not set; assuming secret '$RAPIDAPI_SECRET_NAME' already exists."
fi

echo "Deploying Cloud Run web service: $WEB_SERVICE_NAME"
gcloud run deploy "$WEB_SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --allow-unauthenticated \
  --set-env-vars "FAA_DATA_BACKEND=gcs,GCS_BUCKET=$GCS_BUCKET,GCS_MANIFEST_OBJECT=$GCS_MANIFEST_OBJECT,GCS_MANIFEST_CACHE_MS=60000" \
  --set-secrets "RAPIDAPI_KEY=$RAPIDAPI_SECRET_NAME:latest" \
  $(maybe_set_service_account_flag "$WEB_SERVICE_ACCOUNT")

echo "Deploying Cloud Run refresh job: $REFRESH_JOB_NAME"
gcloud run jobs deploy "$REFRESH_JOB_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --command node \
  --args scripts/refresh-faa.js \
  --task-timeout "$REFRESH_TASK_TIMEOUT" \
  --memory "$REFRESH_MEMORY" \
  --set-env-vars "FAA_DATA_DIR=/tmp/planeage-data,GCS_BUCKET=$GCS_BUCKET,GCS_PREFIX=$GCS_PREFIX,GCS_MANIFEST_OBJECT=$GCS_MANIFEST_OBJECT" \
  $(maybe_set_service_account_flag "$REFRESH_SERVICE_ACCOUNT")

echo "Done."

