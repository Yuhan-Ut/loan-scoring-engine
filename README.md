# Loan Scoring Engine Backend

This project implements a Node.js/TypeScript backend for a loan application scoring and disbursement system, including:

- A scoring engine based on the provided rubric
- An application state machine (including support for a `partially_approved` migration)
- A webhook-driven disbursement flow (with retries, timeouts, and an audit log)
- Admin endpoints for manual review and partial approvals

> Problem statement reference: `Take-Home, Backend.pdf`.

## Tech Stack

- **Runtime**: Node.js (LTS) + TypeScript
- **Framework**: Express
- **Database**: SQLite (local file)
- **Config management**: `src/config` module (weights, thresholds, duplicate window, webhook timeout, retry count, etc.)

## Getting Started

### Install dependencies

```bash
npm install
```

### Build & run

```bash
# Compile TypeScript
npm run build

# Start the server (built JS)
npm start

# Or run in dev mode (watch source)
npm run dev
```

By default the service listens on `http://localhost:3000`. A simple health check endpoint is:

- `GET /health` → `{"status":"ok"}`

## Project Structure

Core structure (aligned with the take-home requirements):

- `src/index.ts`: Application entrypoint; loads config, initializes the database, mounts Express routes and error handling.
- `src/config/`: Configuration module
  - `index.ts`: Runtime configuration (port, database path, duplicate window, webhook timeout, retry count, etc.).
  - `scoring.ts`: Scoring configuration (factor weights, thresholds, income tolerance, employment weights, debt-to-income bands, decision thresholds).
- `src/db/`: Database and migrations
  - `connection.ts`: Creates and exports the SQLite connection.
  - `migrations.ts`: Runs `CREATE TABLE IF NOT EXISTS ...` statements to create all tables.
- `src/domain/`: Domain models and state machine
  - `ApplicationStatus.ts`: Application status enum(s) and disbursement status enum.
  - `applicationStateMachine.ts`: Transition graph and `assertValidTransition` validation.
  - `errors.ts`: Typed error classes required by the spec:
    - `InvalidStateTransitionError`
    - `DuplicateApplicationError`
    - `WebhookReplayError`
    - plus a generic `ValidationError`.
- `src/scoring/`:
  - `scoringEngine.ts`: Pure scoring function `scoreApplication`.
- `src/services/`: Domain services
  - `applicationService.ts`: Handles submission, duplicate detection, scoring, status transitions, and disbursement record creation.
  - `disbursementService.ts`: Handles disbursement webhooks, retry logic, timeout checks, and audit event writes.
  - `adminService.ts`: Admin listing/detail/review decisions (including `partially_approved`).
- `src/routes/`: HTTP routes
  - `applications.ts`: Public application endpoints.
  - `webhook.ts`: Disbursement webhook endpoint.
  - `admin.ts`: Admin endpoints + Basic Auth.
- `scripts/`:
  - `simulate_disbursement.js`: Webhook simulator (success, failure, replay).

> The implementation will follow this structure as the code is filled in.

## Scoring Logic & Business Assumptions

### Scoring factors & weights

The scoring engine reads configuration from `src/config/scoring.ts`, including (illustrative):

- **Income Verification (30%)**: Consistency between stated and documented income.
- **Income Level (25%)**: Income level (whether income ≥ 3× loan amount).
- **Account Stability (20%)**: Account stability (ending balance, overdrafts, deposit consistency).
- **Employment Status (15%)**: Employment status (`employed > self-employed > unemployed`).
- **Debt-to-Income (10%)**: Withdrawals-to-deposits ratio.

### Interpretation of the “10% tolerance”

The spec is ambiguous about the 10% tolerance. This project makes the following **explicit and defensible assumption**:

- Use a **symmetric ±10% band** around `stated_monthly_income`. Documented income must fall within `stated_monthly_income ± 10%` to receive full points for the income-verification factor.
- If documented income is missing or outside this band, the factor receives partial or zero points (exact mapping is defined in config), which tends to push borderline cases into `flagged_for_review`.

Rationale for a symmetric band:

- Treats over-reporting and under-reporting symmetrically, avoiding systematic bias.
- Makes it easy to tune the tolerance later from configuration without touching core logic.

### Decision thresholds

Overall score thresholds are read from configuration and match the spec:

- `score >= 75` → auto-approve (`approved`)
- `50 <= score < 75` → flag for manual review (`flagged_for_review`)
- `score < 50` → auto-deny (`denied`)

## State Machine & `partially_approved`

### Application statuses

The primary application statuses are:

- `submitted` → `processing` → `approved | denied | flagged_for_review`
- After `flagged_for_review`:
  - `approved` (full approval)
  - `denied`
  - `partially_approved` (approval with a reduced loan amount)

All state transitions are enforced by a centralized state machine (`applicationStateMachine.ts`). Any update must go through `ApplicationService.transition`; otherwise an `InvalidStateTransitionError` is thrown.

### Mid-spec migration to add `partially_approved`

- The initial version only includes `approved / denied / flagged_for_review`, with statuses and transitions centralized in a single module.
- When adding `partially_approved`, we only need to:
  - Extend the enum with the new status.
  - Extend the transition map with `flagged_for_review → partially_approved`.
  - Use the `approved_loan_amount` column in the applications table to store the final approved amount.
- Existing data stays valid (original statuses unchanged), and the state machine continues to work for pre-existing applications.

## Webhook Disbursement Flow & Idempotency

### Webhook endpoint

- `POST /webhook/disbursement`

Request body:

```json
{
  "application_id": "abc-123",
  "status": "success",
  "transaction_id": "txn_456",
  "timestamp": "2026-01-15T10:30:00Z"
}
```

Business rules:

- `success` → disbursement status transitions to `disbursed`.
- `failed` → disbursement status becomes `disbursement_failed`, with up to N automatic retries based on config.
- **Replaying the same `transaction_id`**:
  - Must not change disbursement or application state (idempotent); the server returns 200 with a “no-op” style message.
  - Still writes an audit row marking this as a replay event.

### Retry vs audit log tradeoff

- **Product**: Disbursement should auto-retry up to 3 times on failure, then escalate to manual review.
- **Finance**: Each retry must be logged as a separate audit event with a unique retry ID.
- **Idempotency**: The same `transaction_id` replayed must not change state (no-op).

**How the backend reconciles this:**

- **Unique audit trail**: Every webhook call (success or failure) inserts one row into `disbursement_audit_events` with a unique `id` and `retry_sequence` (the attempt number). So each attempt is a distinct record.
- **Idempotency**: When a webhook arrives with a `transaction_id` that has already been processed to a terminal state (disbursed, disbursement_failed, or flagged_for_review), the handler returns without updating state. Same `transaction_id` replayed = no-op.
- **Auto-retry and escalation**: On each `failed` webhook we increment `retry_count`. After more than `maxDisbursementRetries` (e.g. 3) failures, we transition the disbursement and the application to `flagged_for_review` (reason: `disbursement_retries_exhausted`). So “3 failures → escalate” is enforced in the backend.

**Who triggers the retries?**

- **Demo**: The webhook simulator script sends multiple `failed` webhooks (e.g. with `transaction_id` `txn_fail_1`, `txn_fail_2`, `txn_fail_3`). Each is a distinct attempt; the backend counts them and escalates after the 3rd.
- **Production**: The payment provider (or a backend job that calls them) sends each retry; each attempt typically has its own `transaction_id`. The backend only processes webhooks and enforces count + escalation.

### Webhook timeout handling

- Config value `webhookTimeoutMs` defines the maximum time to wait for a webhook (default 5 minutes).
- **Admin endpoint** `POST /admin/disbursements/check-timeouts` (Basic Auth) scans for disbursements in `disbursement_queued` whose `created_at` is older than `now - webhookTimeoutMs`, and for each:
  - Updates the disbursement status to `flagged_for_review`.
  - Updates the linked application status to `flagged_for_review` (so it appears in the admin list).
  - Inserts an `application_state_transitions` row with reason `webhook_timeout` and actor `system`.
- You can call this endpoint on a schedule (e.g. cron) or manually for demos.

#### Loom: how to demo “timeout → flag for review”

1. **Short timeout for demo**: Start the server with a short timeout, e.g. `WEBHOOK_TIMEOUT_MS=15000` (15 seconds).
2. **Create an approved application**: Submit Scenario 1 (Jane Doe) so you get an `approved` application and its `application_id`. A disbursement row is created in `disbursement_queued` with `created_at = now`.
3. **Do not send a webhook**: Leave the disbursement waiting.
4. **Wait**: Wait at least 15 seconds (or whatever `WEBHOOK_TIMEOUT_MS` you set).
5. **Trigger the check**: Call `POST http://localhost:3000/admin/disbursements/check-timeouts` with Basic Auth (admin / password).
6. **Expected response**: `200 OK` with body like `{ "message": "Timeout check completed.", "flagged_count": 1, "flagged": [{ "application_id": "<id>", "disbursement_id": 1 }] }`.
7. **Verify**: Call `GET /admin/applications?status=flagged_for_review` and confirm that application appears; call `GET /admin/applications/:id` for that application and show the transition history including `webhook_timeout` and the disbursement status `flagged_for_review`.

## Duplicate Rules & Idempotency

### Application duplicate detection

- Rule: **same email + same loan amount within 5 minutes** is considered a duplicate submission.
- In `POST /applications`:
  - Query for existing records with the same email and loan amount within the last `duplicateWindowMinutes`.
  - If found, throw `DuplicateApplicationError`, return the original `application_id`, and do **not** create a new application.

### Webhook idempotency

- Idempotency is enforced at the `(application_id, transaction_id)` level:
  - If this combination has already reached a terminal state (success or final failure), subsequent webhooks with the same pair do not change state.
  - An additional audit row is still inserted with a replay flag for debugging and traceability.

## Test Scenarios & Loom Walkthrough

The project will include the 1–8 scenarios from the prompt (as JSON inputs or small scripts) to demonstrate:

- Scoring engine decisions (auto-approve / auto-deny / flagged for review).
- Duplicate submission rejection (scenario 7).
- Webhook replay idempotency (scenario 8).

Suggested Loom structure:

1. Architecture overview: code structure, scoring config, interpretation of income tolerance, how `partially_approved` fits into the state machine.
2. Happy path: submit application → auto-approve → successful disbursement webhook → status `disbursed` (using `scripts/simulate_disbursement.js`).
3. Failure and retries: webhook failure → automatic retries → multiple audit rows; demo replay vs idempotency handling.
4. **Webhook timeout**: no webhook within `webhookTimeoutMs` → call `POST /admin/disbursements/check-timeouts` → application and disbursement move to `flagged_for_review` (see “Loom: how to demo timeout → flag for review” above).
5. Idempotency and duplicates: duplicate application submissions + webhook replay to show the system is safe.

The implementation will adhere to the architecture and assumptions described here. Once the code is complete, running the commands in this README should be sufficient to reproduce all required demo scenarios.

