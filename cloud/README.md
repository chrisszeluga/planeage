# Google Cloud (Buildpacks) deployment

PlaneAge can run locally with `./data/*.csv`, or in Google Cloud using:

- **Cloud Storage**: stores the FAA registry files
- **Cloud Run (web service)**: runs `server.js`
- **Cloud Run (job)**: runs `scripts/refresh-faa.js` to refresh the FAA data in Cloud Storage
- **Cloud Scheduler**: triggers the Cloud Run job on a schedule

## Data layout in Cloud Storage

The refresh job uploads versioned objects and then updates a small manifest JSON:

- `gs://$GCS_BUCKET/faa/master-<timestamp>.csv`
- `gs://$GCS_BUCKET/faa/acftref-<timestamp>.csv`
- `gs://$GCS_BUCKET/faa/current.json` (manifest)

The web service reads `faa/current.json` and streams the referenced CSV objects (zero-RAM lookup; it stops on first match).

## Environment variables

### Web service (`node server.js`)

- `RAPIDAPI_KEY` (recommended via Secret Manager)
- `FAA_DATA_BACKEND=gcs`
- `GCS_BUCKET=your-bucket`
- `GCS_MANIFEST_OBJECT=faa/current.json` (optional; default is `faa/current.json`)
- `GCS_MANIFEST_CACHE_MS=60000` (optional)
- `TRUST_PROXY=1` (recommended on Cloud Run for correct IP/rate limiting)

### Refresh job (`node scripts/refresh-faa.js`)

- `FAA_DATA_DIR=/tmp/planeage-data` (Cloud Run containers should write under `/tmp`)
- `GCS_BUCKET=your-bucket`
- `GCS_PREFIX=faa` (optional)
- `GCS_MANIFEST_OBJECT=faa/current.json` (optional)

## Cloud Scheduler trigger (outline)

Use Cloud Scheduler to trigger the Cloud Run Job weekly.

One simple pattern is an authenticated Scheduler HTTP target that calls the Cloud Run Jobs API `:run` endpoint for your job; the Scheduler service account needs permission to run the job.

This repo does not create Scheduler resources automatically as part of Phase 7 task #1/#2; see the Phase 7 tasks for the `gcloud` bootstrap step.

## Deploy (Buildpacks)

Run `npm run deploy:gcp` (or `cloud/deploy.sh`) after you have `gcloud` authenticated.

- Provide `RAPIDAPI_KEY` as an environment variable once to create/update the Secret Manager secret (or create it manually).
- Provide `PROJECT_ID` and `GCS_BUCKET` (and optionally `REGION`, service/job names, and service accounts).

The deploy script builds a single image using Buildpacks (`gcloud builds submit --pack ...`) and deploys:

- Cloud Run service: default CNB process `web`
- Cloud Run job: CNB process `refresh` (provided via the repo root `Procfile`)

## Updating the RapidAPI secret from `.env`

Avoid piping `node -e "require('dotenv').config(); ..."` directly into `gcloud secrets versions add`, because some `dotenv` versions print tips to stdout and can contaminate the secret value.

Use quiet mode:

- `DOTENV_CONFIG_QUIET=true node -e 'require(\"dotenv\").config(); process.stdout.write(process.env.RAPIDAPI_KEY||\"\");' | gcloud secrets versions add rapidapi-key --project planeage --data-file=-`
