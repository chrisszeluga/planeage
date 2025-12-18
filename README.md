# planeage

Resolve `Flight #` → `Tail #` → `Mfr Year` → `Aircraft Age`.

## Setup

1. Install deps:
   - `npm install`
2. Create `.env` from `.env.example`:
   - `cp .env.example .env`
   - set `RAPIDAPI_KEY=...`
3. Download the FAA registry cache (large):
   - `npm run refresh`
   - downloads both `data/master.csv` and `data/acftref.csv` (used for aircraft make/model)

## Run

- `npm start`
- Open `http://localhost:3000`

## Demo Bypass

For demos without calling RapidAPI: submit flight `TT111` on `2025-01-01` to return a fictional aircraft with age `10`.

## Scripts

- `npm run refresh` — download + atomically swap `data/master.csv` and `data/acftref.csv`
- `npm test` — minimalist test suite (no external calls)
- `npm run verify` — memory/stream sanity check (early-match lookup)
- `npm run verify:full` — worst-case full scan (no-match)
- `npm run deploy:gcp` — deploy Cloud Run web service + refresh job (Buildpacks)

## Google Cloud

See `cloud/README.md` for the Cloud Storage + Cloud Run + Cloud Scheduler setup.

## Env Vars

- `RAPIDAPI_KEY` — required for lookups
- `PORT` — server port (default `3000`)
- `RAPIDAPI_TIMEOUT_MS` — RapidAPI fetch timeout (default `10000`)
- `TRUST_PROXY` — set when behind a reverse proxy (e.g. `1`)
- `FAA_DATA_BACKEND` — `local` (default) or `gcs`
- `FAA_DATA_DIR` — override the local data directory (default `./data`)
- `GCS_BUCKET` — Cloud Storage bucket for FAA data (used when `FAA_DATA_BACKEND=gcs`)
- `GCS_MASTER_OBJECT` / `GCS_ACFTREF_OBJECT` — optional explicit object names (bypass manifest)
- `GCS_MANIFEST_OBJECT` — manifest JSON object (default `faa/current.json`)
- `GCS_MANIFEST_CACHE_MS` — manifest cache TTL (default `60000`)
