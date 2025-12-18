# PlaneAge Implementation Tasks

## Phase 1: Environment & Foundation
- [x] Initialize `package.json` with dependencies
- [x] Create folder structure: `/public`, `/data`, `/scripts`.
- [x] Setup `.env` template with `RAPIDAPI_KEY` and whatever else.

## Phase 2: The "Refresh" Engine (Data Maintenance)
- [x] Create `scripts/refresh-faa.js`: Implement `https` stream download of FAA ZIP.
- [x] Implement ZIP extraction using `adm-zip` to pull `MASTER.txt` into the `/data` folder.
- [x] Implement atomic swap logic: Ensure `MASTER.txt` is renamed to `master.csv` safely.
- [x] Add `npm run refresh` script to `package.json`.

## Phase 3: The Backend (API & Lookup)
- [x] Create `server.js`: Setup basic Express server and static file serving for `/public`.
- [x] Implement `POST /check-flight` route.
- [x] Integrate AeroDataBox API: Resolve Flight # and Date to a Tail Number (N-Number). API documentation is in "openapi-rapidapi-v1.json".
- [x] Implement **N-Number Normalization**: Strip 'N' prefix from API results for CSV matching.
- [x] Implement **Stream-based CSV Lookup**: Use `fs.createReadStream` and `readline` to find Year/Model in `master.csv`.
- [x] Add error handling for "Flight Not Found" and "Registration Not Found" scenarios.

## Phase 4: The Frontend (Minimalist UI)
- [x] Create `public/index.html`: Implement a single-input flight search UI (date and flight number).
- [x] Add Vanilla JS `fetch` logic to POST to `/check-flight`.
- [x] Implement CSS styling:
    - Center the card UI.
    - Large typography for the Age output
    - Subtext for Aircraft Model and Tail Number.
    - Use basic styles to make the UI look clean and modern.
- [x] Add loading state (e.g., "Pulling Plane Registration Number...", "Scanning FAA Records...", etc) while the stream is processing.

## Phase 5: Testing & Verification
- [x] **Minimalist Test Suite:** - Create lightweight test suite.
    - Mock the AeroDataBox API response.
    - Assert that the CSV stream correctly identifies a dummy N-number in a sample data file.
- [x] Review all code and identify any optimizations or improvements. Favor minimalism, neat structures, and organiztion.
- [x] Identify any possible edge cases or error states and make sure those are cleanly presented to the user.
 
## Phase 6: Hardening, Security & Testing
- [x] **Security Headers:** Implement `helmet` middleware to set secure HTTP headers (HSTS, CSP, etc.) and manually disable `app.disable('x-powered-by')`.
- [x] **Rate Limiting:** Implement `express-rate-limit` to prevent brute-force attacks on the search endpoint (e.g., max 10 requests per minute per IP).
- [x] **Input Sanitization:** Use `express-validator` to ensure `flightNumber` and `date` match expected regex patterns before processing.
- [x] **Dependency Audit:** Run `npm audit` and fix any high-severity vulnerabilities.
- [x] **Graceful Error Handling:** Ensure 500 errors do not leak stack traces or local file paths (like `/Users/name/planeage/data/...`) to the end user.

## Phase 7: Google Cloud Deployment (Buildpacks)
- [ ] Ensure `package.json` has a `"start": "node server.js"` script.
- [ ] Create `deploy.sh`: Use `gcloud run deploy --source .` (triggers Buildpacks).
- [ ] Create `refresh-job.sh`: Use `gcloud run jobs deploy --source .` for the maintenance task.
- [ ] Document the `gcloud scheduler` command to automate the weekly refresh.
