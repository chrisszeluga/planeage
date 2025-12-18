# PlaneAge Implementation Tasks

## Phase 1: Environment & Foundation
- [ ] Initialize `package.json` with dependencies
- [ ] Create folder structure: `/public`, `/data`, `/scripts`.
- [ ] Setup `.env` template with `RAPIDAPI_KEY` and whatever else.

## Phase 2: The "Refresh" Engine (Data Maintenance)
- [ ] Create `scripts/refresh-faa.js`: Implement `https` stream download of FAA ZIP.
- [ ] Implement ZIP extraction using `adm-zip` to pull `MASTER.txt` into the `/data` folder.
- [ ] Implement atomic swap logic: Ensure `MASTER.txt` is renamed to `master.csv` safely.
- [ ] Add `npm run refresh` script to `package.json`.

## Phase 3: The Backend (API & Lookup)
- [ ] Create `server.js`: Setup basic Express server and static file serving for `/public`.
- [ ] Implement `POST /check-flight` route.
- [ ] Integrate AeroDataBox API: Resolve Flight # and Date to a Tail Number (N-Number). API documentation is in "openapi-rapidapi-v1.json".
- [ ] Implement **N-Number Normalization**: Strip 'N' prefix from API results for CSV matching.
- [ ] Implement **Stream-based CSV Lookup**: Use `fs.createReadStream` and `readline` to find Year/Model in `master.csv`.
- [ ] Add error handling for "Flight Not Found" and "Registration Not Found" scenarios.

## Phase 4: The Frontend (Minimalist UI)
- [ ] Create `public/index.html`: Implement a single-input flight search UI (date and flight number).
- [ ] Add Vanilla JS `fetch` logic to POST to `/check-flight`.
- [ ] Implement CSS styling:
    - Center the card UI.
    - Large typography for the Age output
    - Subtext for Aircraft Model and Tail Number.
    - Use basic styles to make the UI look clean and modern.
- [ ] Add loading state (e.g., "Pulling Plane Registration Number...", "Scanning FAA Records...", etc) while the stream is processing.

## Phase 5: Testing & Verification
- [ ] Verify that a 100MB+ `master.csv` does not cause memory spikes during lookup.
- [ ] Test edge cases: Codeshare flights (multiple results in API) and non-standard flight formats.

## Phase 6: Hardening, Security & Testing
- [ ] **Security Headers:** Implement `helmet` middleware to set secure HTTP headers (HSTS, CSP, etc.) and manually disable `app.disable('x-powered-by')`.
- [ ] **Rate Limiting:** Implement `express-rate-limit` to prevent brute-force attacks on the search endpoint (e.g., max 10 requests per minute per IP).
- [ ] **Input Sanitization:** Use `express-validator` to ensure `flightNumber` and `date` match expected regex patterns before processing.
- [ ] **Dependency Audit:** Run `npm audit` and fix any high-severity vulnerabilities in `adm-zip` or `express`.
- [ ] **Environment Protection:** Create a `.gitignore` specifically to prevent `.env` and `data/master.csv` (too large) from being committed to GitHub.
- [ ] **Minimalist Test Suite:** - Create lightweight test suite.
    - Mock the AeroDataBox API response.
    - Assert that the CSV stream correctly identifies a dummy N-number in a sample data file.
- [ ] **Graceful Error Handling:** Ensure 500 errors do not leak stack traces or local file paths (like `/Users/name/planeage/data/...`) to the end user.