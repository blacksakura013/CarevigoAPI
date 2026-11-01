# Save Stroke API

Express/Mongoose API for staff registration, authenticated patient profiles,
guest submissions with review, health records, and Thai CV risk assessment.
Node 20 is supported.

## Run and verify

Install the existing dependencies with `npm ci`. Configure the database and JWT
settings for your environment, then use `npm start` (port 8080 by default).
No database connection or environment file is needed for `npm test`.

Use `.env.example` as a list of local settings and copy it to the private
`.env.local` file for development. Both `.env` and `.env.local` are ignored by
Git. Production reads its database, JWT, SMTP and integration credentials from
the hosting service's environment variables; configure those before deployment.

Background review/outbox processing starts by default. Set
`REVIEW_WORKER_ENABLED=false` when starting a local diagnosis instance that must
not consume those background jobs. The database connection and HTTP routes still
start normally. This switch controls the background worker only; normal protected
review/profile/history reads can still perform their documented overdue-review
catch-up. Health and authentication session bootstrap endpoints do not run that
catch-up.

The tests use isolated model doubles and local HTTP servers; they do not modify
a live database. They cover authentication, patient ownership, session revocation,
temporary credentials, profile field restrictions, grouped health saves,
pagination/filtering, risk eligibility, and official calculator result fixtures.
Run `npm run test:integration:bigint` for opt-in integration checks against a fresh,
isolated local MongoDB process. This requires a local `mongod` binary (set
`CAREVIGO_TEST_MONGOD` to its path if it is not discovered). The harness does not read environment
files or connect to the application's configured database. Deployment checks remain
separate.

## Health progress (authenticated)

`GET /api/public/health/progress` requires an authenticated patient accessing
their own `citizenId`, or authorized staff. It is read-only: it does not approve
overdue submissions, refresh risk calculations, or send mail.

Select a period with `days=30|90|365|all` (default `90`), or a paired Gregorian
`from=YYYY-MM-DD&to=YYYY-MM-DD`. Date boundaries are inclusive calendar days in
Asia/Bangkok; all responses identify their `asOf` cutoff. The recorded date is
`submittedAt`, falling back to `createdAt`, and does not imply an actual test date.

The `schemaVersion: 1` response separates full-period summaries from detail
pagination. Summary counts include all review states. Comparisons use approved
records, including legacy records without a review-status field. Pending,
rejected and unknown statuses do not enter the trend. Each measurement has its
own count, first, previous and latest sample across the complete selected period;
the plotted series contains at most its latest 100 samples, with `hasEarlier`
indicating a shorter plotted history. Missing optional readings are never zeroes.

`reviewStatus=all|approved|pending|rejected` filters only detail records, with
`page` and `limit` (default 20, maximum 50). It does not change the approved
measurement comparisons. Detail records and latest approved records use a safe
projection; account credentials, legal proofs and staff actor identifiers are
omitted. Clinical values accept finite positive BSON int/double values; numeric
identity fields retain their exact decimal-string JSON representation.

`currentRisk` is the stored latest Thai CV assessment, independent of the selected
period. It is not a CVD trajectory or a replacement for clinical follow-up.

## Staff cohort reports (authenticated)

`GET /api/dashboard/cohorts` requires an active admin or superadmin session.
It is read-only: it does not approve pending records, refresh CV risk, run review
workers or send mail. Responses use `Cache-Control: no-store`.

The strict query accepts paired Gregorian `from`/`to` dates (inclusive Bangkok
calendar days, at most 366 days, ending no later than today), `disease`, literal
`search` (name, full name, citizen ID or province; maximum 100 characters),
`activity=all|recorded|none`, `page` and `limit` (default 20, maximum 50).
Omitting dates selects the current Thai calendar month through today. Records
use `submittedAt` when present, otherwise `createdAt`; invalid timestamps and
timestamps after the response's `asOf` instant are excluded. Profiles must have
a valid registration `createdAt` no later than the selected end/asOf.

`data.schemaVersion=1` includes `range`, normalized `filters`, `summary`,
`diseases`, bounded `timeline`, paginated `people`, and `pagination`.
`range.bucket` is `day` for up to 92 days and `month` otherwise, with timeline
dates respectively `YYYY-MM-DD` and `YYYY-MM`. Timeline gaps
contain zero counts only; reports do not invent clinical measurements.
The summary distinguishes unique people from record totals, with approval status
and `byType` counts. `cohortPeople`, `withRecords` and `withoutRecords` describe
the selected disease/search cohort before the activity filter; `people` and all
record totals describe the displayed cohort after it. Pagination does not change
aggregates. Missing legacy review status is approved; null/unrecognized status
is unknown. Non-submitters remain visible under `activity=all|none`.

Disease codes are `all`, `diabetes`, `hypertension`, `heart`, `stroke`, `cancer`,
`dyslipidemia`, `other`, `none` and `unknown`. Aliases and cancer prefixes map
to current reported profile groups, with duplicate aliases counted once per
person and overlapping groups allowed. A nonempty reported disease array counts
even when its confirmation flag is false; `none` requires a valid all-string
array that normalizes to empty and an explicit true confirmation. Missing/invalid disease data remains
unknown. These groups are not historical diagnoses or inferred from measurements.
`diseaseScope=current-profile-reported` makes this scope explicit. Distribution
cards ignore the selected disease for drill-down, respect search/activity, and
declare `distributionScope=search-and-activity-current-profile`.

Joins use exact BSON int64 `userKey`/`internalId` links first. An existing numeric
link to another or missing person never falls back. When `userKey` is absent,
an ObjectId `userId` is authoritative; citizen ID fallback is used only without
an ObjectId link. This prevents contradictory legacy links from counting a
record for two people. IDs serialize as decimal strings; missing legacy profile
IDs are null. People contain names, province, reported groups, record counts and
`latestApprovedRecords`: at most one most recent approved record per known
category within the selected range. These four safe records include the recorded
date, positive finite BSON double/int measurements and optional submitted DOB/sex.
Missing, string, int64, Decimal128 and nonfinite clinical values remain unavailable;
pending/rejected records never supply these readings. This is a latest category
record, not a per-measurement trend or a new diagnosis. Account secrets, contact
details, private profile fields and review actors are excluded.

The isolated real-Mongo regression cases are
`test/admin-cohort-integration.test.js`; enable them with
`CAREVIGO_WORKFLOW_INTEGRATION=1`. Query boundary tests run in the normal suite.

## Internal 64-bit identifiers

Users, admins, health records, submissions, and review email jobs have an additive
`internalId` stored as a positive signed BSON int64 and represented as JavaScript
`bigint` inside the API. IDs are unique within each model; atomic named counters
allocate them across processes. Reserved/failed operations can leave gaps.
Relations use `userKey`, `submissionKey`, and `adminKey`; each submission also
reserves the health records' numeric identities before materialization so retries
retain the same record IDs.

Existing MongoDB `_id`, ObjectId relations, public route parameters, receipt tokens,
and response `userId`/`recordId` values are retained for compatibility. Internal
lookups prefer the numeric keys; fallback matches only rows missing a numeric
relation and cannot override a conflicting numeric link. A legacy row without an
internal ID remains readable until backfilled. Citizen IDs and six-digit PINs
remain strings, preserving leading zeroes. Pagination, counts, and clinical
measurements remain ordinary numbers.

All BigInt/BSON Long values are serialized to exact decimal **strings** in HTTP
JSON, for example `"internalId": "9007199254740993"`. Consumers must keep these as
strings (or native BigInt); converting them with `Number()` loses precision.
JWTs likewise carry decimal-string `internalId` claims, which are validated and
converted to BigInt for database lookups. Existing tokens without that claim
continue through the legacy identity path. Internal IDs accept only exact values
from 1 through 9223372036854775807; unsafe JavaScript number input, noncanonical
decimal text, and overflow are rejected. Profile/submission allowlists do not let
clients assign internal keys.

For an existing database, back up the database and pause application/worker writes
while applying the migration. Set `MONGO_URI` explicitly in the process environment
(the migration does not load `.env` files). It targets `carevigo_db`, matching the
API connection configuration. Then run:

```sh
npm run migrate:internal-ids
npm run migrate:internal-ids -- --apply
```

The first command is a **read-only dry run**: it reports missing identities,
relation conflicts, and work required without creating counters or indexes.
Resolve any reported conflicts before applying. `--apply` aligns counters with
existing/reserved keys, backfills missing IDs and links, and creates the unique
and relation indexes. `--batch-size=100` is configurable from 1 to 1000. Completed
identities are retained when interrupted and rerun; existing ObjectIds and public
links are preserved. Legacy health rows linked only by citizen ID receive a numeric
user key after resolving one matching patient; missing, ambiguous, or conflicting
references stop the apply run before writes. Restart API/worker processes after
the apply run succeeds.
No production migration or deployment has been performed by this change.

## Deployment settings

These examples are configuration guidance, not values copied from an environment:

```dotenv
# 0 for direct local access; set the exact known proxy count in production.
# Accepted integers: 0–5. Unset or invalid values do not enable proxy trust.
TRUST_PROXY_HOPS=0

# Patient login/change-password requests per IP in 15 minutes.
# Accepted integers: 1–10000. Default: 100, shared across those two routes.
PATIENT_LOGIN_IP_LIMIT=100

# Optional public frontend origin for LINE's patient sign-in instruction.
FRONTEND_URL=https://carevigo-frontend.onrender.com
```

Set `TRUST_PROXY_HOPS` only to the deployment's actual trusted forwarding hops so
IP limits identify clients behind a reverse proxy. The application never enables
unrestricted proxy trust. Patient login also limits each citizen-ID account to
five failed attempts per 15-minute window, without extending an active lockout
on every rejected attempt. Staff resets clear that account's failed-attempt state.
The current IP/account limit stores and grouped-save queue are per server process.

## Patient onboarding and authentication

The token examples in this section describe the explicit Bearer client contract.
The supplied browser frontend uses the cookie session contract documented under
"Browser cookies and session storage" below.

1. Staff sign in using `POST /api/auth/login` and register a patient using
   `POST /api/users/admin`. Registration accepts profile fields and a 13-digit
   `citizenId`; it cannot set credentials, account flags, or token versions.
2. Staff call `POST /api/users/admin/:id/account` with `{}` to generate a random
   six-digit code, or `{ "password": "001234" }` to enter one. The response returns
   `temporaryPassword` once with a safe `patient` and `requiresPasswordChange`.
   Only a bcrypt hash is stored. A reset invalidates existing patient tokens.
3. The patient signs in using `POST /api/auth/patient/login` with `citizenId` and
   `password`. The response data is `{ accessToken, patient, requiresPasswordChange }`.
4. The initial token can call `GET /api/auth/patient/me` and
   `POST /api/auth/patient/change-password`. The latter requires `currentPassword`
   and a different new `password`: either six numeric digits or at least eight
   characters, with a maximum of 72 UTF-8 bytes. It returns a new access token.
5. After that change, the patient can read/update their own profile and health
   records. Patient access tokens expire after eight hours and include an account
   version checked against the database on every protected patient request.

Use `Authorization: Bearer <accessToken>` on protected requests. Safe patient
objects expose `accountEnabled` and `requiresPasswordChange`; they never expose
`passwordHash` or `tokenVersion`. Staff authentication remains separate, with an
independent IP limit of 100 login requests per 15 minutes.

Staff passwords now use bcrypt for login, changes, and newly seeded accounts. A
successful login with an existing legacy base64 credential migrates it to bcrypt
once; users keep their current password. The legacy comparison is timing-safe.
To create the initial staff account, explicitly set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` and run `node src/scripts/seedAdmin.js` in the configured backend
environment. The seed password must contain at least eight characters and no more
than 72 UTF-8 bytes. There is no hardcoded account/password, and seeding does not
reset an existing account. Credentials are not printed by the seed script.

## Staff password recovery

The staff sign-in page offers an email recovery flow. Recovery requests use the
same allowed browser origin and `X-Carevigo-Session: cookie` /
`X-Carevigo-Scope: admin` context as staff login, without requiring a current
session, session ID or CSRF token. Ambient cookies do not authorize recovery.

| POST route | Request | Result |
| --- | --- | --- |
| `/api/auth/forgot-password` | `{ email }` | Generic 202 for active, inactive, unknown and malformed email addresses |
| `/api/auth/reset-password/validate` | `{ token }` | 200 with `data: { valid: true }`; does not consume the link |
| `/api/auth/reset-password` | `{ token, password, confirmPassword }` | 200 with `data: null`; does not create a session |

An invalid, expired, superseded or used link returns 400 with
`code: RESET_LINK_INVALID`. New passwords require at least eight characters,
at most 72 UTF-8 bytes, and exactly matching confirmation. Invalid password
input leaves a valid link usable. Request, validation and completion endpoints
have separate IP limits of 5, 30 and 10 requests per 15 minutes. An active
account can receive one new link per minute; cooldown responses remain generic.

Only a SHA-256 hash of a random 32-byte capability and its expiry/request time
are stored, with recovery fields excluded from normal projections. Links expire
after 30 minutes, and requesting a newer link supersedes the previous one.
Validation is POST-only; GET requests cannot change credentials or consume a
link. Completion atomically compares the current hash, expiry and credential
version while saving the bcrypt password, incrementing the version and clearing
the recovery capability, so concurrent submissions can succeed only once.

The email link is `/admin/reset-password#token=...`; the fragment avoids sending
the capability to frontend access logs. Development uses the requesting origin
only when explicitly allowed by the normal origin policy. Production uses a
configured HTTPS `FRONTEND_URL` whose origin is in `CORS_ALLOWED_ORIGINS`, never
the request Host header. The email includes a large Thai HTML button and a
plaintext fallback, with no external assets. Existing private `EMAIL_USER` and
`EMAIL_PASS` configure SMTP. Sending runs asynchronously after the generic
response; its failure never exposes account existence or changes a newer link.
The caller can request another link after the cooldown. Recovery capabilities,
recipients, passwords and raw mail-provider responses are never logged by this
flow. Delivery diagnostics contain only a category, allowlisted SMTP code and
command, numeric response code, sanitized enhanced status and timestamp.

SMTP verification checks connectivity and authentication; it does not confirm
that the provider will accept a message. Gmail's `550 5.4.5` means the sender's
daily sending quota was exceeded. Wait for the provider to restore sending, or
configure a different authorized sender using `EMAIL_USER` and `EMAIL_PASS` in
the private local environment. Never put credentials in chat, source control or
browser settings. Failed recovery deliveries invalidate their capability and
are not queued for automatic resend: request a fresh link after sending works.

Both recovery and an authenticated staff password change invalidate all previous
staff cookies and Bearer tokens for that account, including outstanding recovery
links. They do not affect other staff or patient accounts. Staff credentials now
carry additive `tokenVersion`; old versionless tokens are accepted only while
the account remains at version zero. Legacy password migration compares the
original credential atomically, preventing a slow login from overwriting a
concurrent reset. Successful recovery returns the person to explicit sign-in.

## Routes and response contracts

Responses preserve the shared envelope: `statusCode`, `title`, `message`, `data`,
and pagination metadata (`total`, `page`, `limit`, `hasMore`) when applicable.

| Route | Access and behavior |
| --- | --- |
| `GET /api/auth/patient/me` | Own profile and refreshed assessment; data `{ patient, thaiCvRisk, requiresPasswordChange }` |
| `PATCH /api/auth/patient/me` | Own allowlisted profile fields; same response shape; initial password must already be changed |
| `POST /api/auth/patient/change-password` | Own current/new credential; issues a new versioned token |
| `POST /api/users/admin` | Staff registration; the legacy `POST /api/users` also requires staff and only creates |
| `GET /api/users/admin` | Staff list; optional `page`, `limit`, `status`, `search`, `riskLevel` |
| `POST /api/users/admin/:id/account` | Staff provisions/resets a temporary code |
| `PATCH /api/users/admin/:id/approve` | Staff approval |
| `GET /api/users/:id/full` | Staff or the matching ready patient; profile and health grouped by type |
| `GET /api/users/search?citizenId=...` | Staff or the matching ready patient; never anonymous |
| `POST /api/public/health` | Staff or the matching ready patient; existing registered patient only |
| `GET /api/public/health` | Staff or the matching ready patient; `citizenId`, optional `type`, `page`, `limit` |
| `GET /api/dashboard/*` | Staff only |
| `GET /api/public/patient-profile?citizenId=...` | Anonymous personal-field prefill from an active verified official profile; five fields only |
| `POST /api/public/submissions` | Guest write-only health batch; no existing profile lookup |
| `GET /api/public/submissions/:id?token=...` | Opaque receipt token scoped to that submission only |
| `GET /api/reviews` | Staff review queue and completed history |
| `GET /api/reviews/settings` | Staff policy, recipient count, delivery counts, review counts |
| `POST /api/reviews/decision` | Staff single, selected, or explicit filtered snapshot decision |
| `GET /api/reviews/email?token=...` | Expiring email capability; minimized read-only confirmation view |
| `POST /api/reviews/email` | Email capability confirmation for approve/reject |

Member search treats text literally and checks names, full name, citizen ID,
phone, and province. `riskLevel` accepts `low`, `moderate`, `high`, or `unavailable`.
Member/history pages are stable newest-first with a maximum size of 100. The
legacy word `public` in the health route does not grant public health-history access. A temporary
account blocked from data routes receives HTTP 403 with `code: PASSWORD_CHANGE_REQUIRED`.
LINE profile commands direct users to sign in until verified account linking exists.

Health types are `blood_pressure`, `sugar`, `cholesterol`, and `bmi`. Save data uses
`{ citizenId, type, value, weight?, height? }`; BP requires `systolic` and `diastolic`
(pulse optional), sugar requires FBS or HbA1c, cholesterol requires `total`, and BMI
requires positive top-level `weight` and `height`. Saves return `recordId`, BMI,
the legacy BMI category, and a `thaiCvRisk` assessment snapshot when available.
After grouped saves, refresh `/api/auth/patient/me` to calculate from all persisted
latest BP/cholesterol values. If assessment refresh fails after a health save,
the saved record still succeeds and can be reassessed without duplicating it.

## Profile and Thai CV risk model

Profile additions are `smokingStatus` (`never`, `current`, `former`, or empty for
unknown), optional `smokingQuitMonths`, `chronicDiseasesConfirmed`, and
`cancerDetails`. Diseases support multiple choices; legacy diabetes/lipid aliases
are normalized. An unanswered disease history is never treated as no diabetes.

`thaiCvRisk` is independent of the old `cvdRisk` field, which remains a BMI category
for compatibility. The true assessment uses Ramathibodi's
[Thai CV risk score 2.5, updated 23 April 2021](https://www.rama.mahidol.ac.th/cardio_vascular_risk/thai_cv_risk_score/)
and its [official total-cholesterol calculator source](https://www.rama.mahidol.ac.th/cardio_vascular_risk/thai_cv_risk_score/scripts/formular.js).
It estimates 10-year cardiovascular risk from age, sex, systolic BP, diabetes,
total cholesterol, and current smoking; former smoking is not current smoking.

Following the source's stated clinical population, calculations are restricted to
Thai adults aged 35–70 without established heart disease, stroke, valvular disease,
or arrhythmia. Systolic input must be 70–220 mmHg and total cholesterol greater
than 0 through 280 mg/dL, matching the source UI range. Out-of-range measurements
can still be recorded; they are not silently clamped to produce an assessment.
Age uses the Bangkok calendar date. Compact `YYYYMMDD` and ISO `YYYY-MM-DD`
birth dates are supported.

Each assessment includes `status` (`calculated`, `incomplete`, `ineligible`), raw
`score`, `level`, `displayScore`, `missing`, `reason`, model/source metadata,
`inputs`, and `calculatedAt`. Unknown fields do not produce a percentage.
The requested colors use raw values: green below 10%, yellow from 10% through
20% inclusive, and red above 20%. Display preserves those boundaries and shows
`>30%` above 30%, as the official UI does, while retaining the raw score.

`User.thaiCvRisk` stores the latest assessment and health records keep snapshots.
Dashboard `summary.thaiCvRisk` counts unique users in `low`, `moderate`, `high`,
`incomplete`, `ineligible`, plus `totalCalculated`. Older profiles without an
assessment count as incomplete until refreshed. Legacy `highRiskUsers` and
`highRiskRecords` continue to describe high-BMI history for existing clients.
The fixed golden fixtures in `test/fixtures/thai-cv-official.json` were generated
by executing the official calculator function and require no network access in tests.

## Guest submissions, review, and retained history

Guest submission is deliberately separate from private profile/history reads.
`GET /api/public/patient-profile?citizenId=...` provides the explicitly public
prefill: an exact 13-digit ID returns `{ firstName, lastName, gender, birthDate,
phone }` in `data`, or `data: null` when no active verified official profile
matches. A login account is not required. This route uses an explicit database
projection and never returns citizen/internal IDs, email, account/security fields,
smoking, disease history, risk, legal evidence or measurements. Pending/rejected
profiles and submitted guest snapshots are excluded. Only one scalar `citizenId`
query parameter is accepted; extra parameters/operators/arrays return 400. The
lookup has its own 10-per-IP-per-minute limit, separate from guest submission,
and every response (including errors/429) uses `Cache-Control: no-store`. Request
logs omit the query. Other profile/search/history routes keep their authentication
and ownership checks. Clients normalize stored Gregorian birth dates and gender
labels before mapping the five fields into the form; clinical fields stay empty.

`POST /api/public/submissions` accepts `{ citizenId, profile, records, clientRequestId? }`.
The profile uses the same allowlist as patient editing; security fields are ignored.
Zero to four unique health types are allowed; health measurements are optional.
An empty `records: []` saves a profile-only submission with its explicit consent.
The optional `clientRequestId` is a UUID:
reuse it with identical data after an uncertain network result to recover the same
submission/receipt. Reusing it with changed data returns HTTP 409. A guest can
create an unverified pending profile, but can never overwrite an existing profile.
The submitted demographic/disease information remains an immutable record snapshot.

HTTP 202 data contains `submissionId`, stable `recordIds`, original `submittedAt`,
`reviewStatus`, `reviewDueAt`, `receiptToken`, and `clientRequestId`. New submissions
start pending. A profile-only response adds `profileOnly: true` and `recordIds: []`.
Receipt reads return only that
submission's records, expected `recordCount`, original `submittedAt`, deadline, and
`processing` if recovery is still preparing rows. Receipt tokens expire after 30 days;
authenticated patient/staff history retains every record independently of that expiry.
Guest submission/receipt routes are limited to 10 requests per IP per minute.

Both the 202 acknowledgement and scoped receipt include `thaiCvRisk`, assessed
only from that Submission's profile, blood pressure and total cholesterol at its
original `submittedAt`. It is available while review is pending and does not read
an existing patient's profile/history or save additional clinical results. Retries
retain the same assessment date. Missing inputs (including `records: []`) return
`incomplete` with a null score; age/disease exclusions return `ineligible`. The
response allowlists derived assessment fields and exposes only the submitted
profile marker and measurement timestamps in `inputs`, without personal fields.

Profile-only submissions retain `profileReviewStatus`, `profileReviewHistory`,
deadline and review metadata directly on Submission. They allocate no Health IDs
and create no Health rows, measurement values or fictional patient health history.
Their receipt keeps `recordCount: 0` and `records: []`, with separate safe
`profileReview`/status/history metadata that excludes the submitted personal fields.
The admin queue exposes one virtual row with `type: profile`,
`reviewEntity: submission-profile`, and `_id` equal to the submission ID. It carries
the submitted profile and the same ownership protections as health review rows.
Selected, mixed and all-filtered review decisions accept these IDs, preserve the
confirmation snapshot, and append an atomic audit event exactly once. Queue
pagination merges both entities in MongoDB; review settings counts include both,
while clinical dashboard/history counts continue to count actual Health records.
Dashboard "today" totals and user-registration date groups use Asia/Bangkok,
independent of the server timezone; stored timestamps remain Gregorian UTC.
The first successful profile ready-write uses MongoDB's current date after the
Submission is durable. Queue snapshots and settings exclude an incomplete
ready-write until recovery, so a delayed request cannot enter an already confirmed
bulk-review snapshot. Recovery preserves an existing ready timestamp and any
automatic-review audit; it never publishes extra Health records.
Profile approval reviews the submitted snapshot and does not overwrite an existing
official profile. Rejection retains the snapshot and audit. Authenticated profile
editing and staff verification remain separate workflows.

Profile-only notifications explicitly describe personal information without
measurement results. A valid admin email capability shows a virtual profile review
item and the profile allowlist; opening it only reads. Explicit email decisions,
same-day 23:59 automatic approval, duplicate retries and interrupted-worker recovery
all use the Submission's own state and never manufacture a Health row. Leaving an
entire category blank is allowed; entering a category still requires its necessary
pair or primary measurement (for example, both blood-pressure values).

Guest records begin `pending`; authenticated saves are `approved`. Review decisions
change only a pending record to `approved` or `rejected`, using an atomic database
condition, and append an audit event in the same write. A duplicate/racing decision
cannot reverse the outcome. Rejected records are retained in receipt, patient,
staff, and review history. Events include `status`/`to`, `from`, `at`, `source`,
`reason`, and actor identifiers when relevant. No review endpoint deletes records.

The automatic deadline is **23:59 on the submission's calendar day in Asia/Bangkok**.
A submission after 23:59 is already due; it is not deferred to the following day.
A background worker checks every minute, starts catch-up after database connection,
and private history/profile/receipt/review reads catch up overdue records. Decision
POSTs also catch up first so a late confirmation cannot override an automatic decision.
The deadline is stored in MongoDB and survives a stopped/restarted server. Deadline
checks run independently of slow mail delivery.

Review list responses add top-level `snapshotAt`. For selected records send
`{ ids: [...], action: "approve"|"reject", reason? }` (up to 100 IDs). To apply a
decision to an entire explicitly confirmed filter send
`{ all: true, filters: { status: "pending", search? }, cutoff: snapshotAt, action, reason? }`.
The service processes bounded batches of 100 until the matching snapshot is complete.
`materializedAt` prevents rows recovered after confirmation entering that snapshot;
`createdAt`/`submittedAt` retain original clinical ordering. The response reports
`changed`, `skipped`, and `matched`. Queue status filters are `pending`, `approved`,
`rejected`, and `all`; legacy records without a review state count as approved.
Dashboard health also accepts `reviewStatus` with those values.

### Staff dashboard record queries

`GET /api/dashboard/health` applies all filters before pagination. Parameters:

| Parameter | Accepted values |
| --- | --- |
| `page`, `limit` | Positive integers; limit at most100 |
| `type` | `all`, `blood_pressure`, `sugar`, `cholesterol`, `bmi` |
| `search` | Bounded literal text matching joined member name, citizen ID or province |
| `reviewStatus` | `all`, `pending`, `approved`, `rejected` |
| `riskLevel` | `all`, `low`, `moderate`, `high`, `unavailable` |
| `bmiLevel` | `all`, `underweight`, `normal`, `risk_low`, `risk_medium`, `risk_high` |
| `sort` | `newest`, `oldest`, `name`, `risk_desc`, `risk_asc` |

Malformed, repeated/non-scalar and unsupported filter values return400. Search
is escaped text, not an executable regular expression. Thai CV filtering uses
the valid JSON numeric assessment (BSON double/int) stored with each record:
below10,10 through20, above20 percent; invalid/missing results are unavailable,
not zero. Legacy BMI
groups remain a separate filter. Sorts use an ID tie-breaker; unavailable CV
scores remain last in either score direction.

The response's `total`, `page`, `limit` and `hasMore` describe the filtered record
set. `data.records` contains that page; `data.summary` is the global record
count per type, including all review states, with `data.summaryScope: "all"`.
Thus changing a filter does not change the meaning of the four dashboard cards.
Legacy records without reviewStatus are included in approved queries. Numeric
userKey ownership stays authoritative and IDs stay decimal strings in JSON.
The endpoint retains its existing active staff authorization; no public patient
lookup or additional health write is introduced.

Only approved/legacy measurements feed true CV assessment. On guest approval,
newly approved records additionally receive an assessment based on their immutable
submitted profile, marked `inputs.profileSource: submitted-profile`. The primary
patient profile is never replaced; its own latest assessment may remain incomplete
until the authenticated owner updates missing information.

## Review email delivery

Notifications reuse the existing email transport and `EMAIL_USER`/`EMAIL_PASS`
configuration. Every active admin receives an individual notification job. The
database outbox is prepared idempotently, even if initial record or job creation
was interrupted; the persisted Submission stores the recovery source and stable
record IDs. SMTP failure never changes a successfully accepted submission into a
failed save. Failed jobs retry with exponential backoff (one minute up to one hour).
Jobs with expired seven-day review tokens enter terminal `expired` state and are
not sent/retried. Settings expose counts only, including failed/expired jobs.

Email tokens are opaque, scoped to one submission and an active admin, and checked
using a stored hash. Raw tokens are reconstructed for pending delivery using an
HMAC secret; they are not stored in the outbox. Links open the frontend
`/review-email?token=...&action=approve|reject` confirmation page. Opening a link,
including by a mail scanner, never changes record state: an explicit POST is required.
Capability responses and private API responses use `Cache-Control: no-store`;
request logs exclude query strings so link tokens are not logged.

Outbox workers claim jobs using an expiring lease for recovery across instances.
As with SMTP generally, delivery is at least once: interruption after SMTP accepts
a message but before recording `sent` may cause a retry. Tests stub email delivery;
no live SMTP send, production database migration, or live deployment was performed.

## Browser cookies and session storage

The browser client uses HTTP-only session cookies; it must not persist access
tokens, refresh tokens, passwords, citizen IDs, health profiles, or CSRF tokens
in localStorage. Patient and staff cookies are separate and can coexist. A
request selects exactly one scope, so an ambient staff cookie cannot turn an
anonymous submission or a patient request into a staff action.

Browser requests send `X-Carevigo-Session: cookie` and
`X-Carevigo-Scope: patient|admin`, with credentials enabled. Cookie login uses the
existing `POST /api/auth/patient/login` or `POST /api/auth/login` endpoint. It
returns the existing `data.patient` or `data.admin` and
`data.session = { scope, sessionId, expiresAt, csrfToken }`, with no JWT fields.
`expiresAt` is an ISO timestamp. `sessionId` is a public generation marker, not
an authentication credential. Hold session metadata and profiles in memory.

After reload, `GET /api/auth/session?scope=patient|admin` with those two headers
restores the current profile and session metadata from the cookie. It also works
before a patient's required initial password change. Every other protected
cookie request must send `X-Carevigo-Session-Id` matching that session. A stale
browser tab receives HTTP 409 with `code: SESSION_CHANGED`; it must discard its
stale profile and bootstrap again. This failure does not clear a newer cookie.
The API exposes the matching response header through CORS.

Protected POST/PATCH/PUT/DELETE requests additionally send `X-CSRF-Token` from
the session metadata. Missing or incorrect tokens receive HTTP 403 with
`code: CSRF_INVALID`. Cookie requests require an allowlisted browser Origin;
when a same-origin browser omits Origin, `Sec-Fetch-Site: same-origin` is
accepted. Cookie login requires the allowed origin and scope headers but does
not require an existing session's CSRF token. Anonymous guest submissions and
token-scoped email confirmations keep their own authorization rules and do not
implicitly consume cookies. Cookie JWTs cannot be replayed through the Bearer
authentication path to bypass these protections.

`POST /api/auth/logout` sends `{ scope }` with the scope, generation and CSRF
headers. It revokes that MongoDB session before expiring only its own cookie.
Other roles and other devices remain signed in. Password changes rotate the
cookie, generation and CSRF token, and revoke every cookie session of the
changed account. Patient token-version checks and staff active/role checks also
run on each authenticated request. Authentication, logout and password mutation
responses can change cookies; browser clients should serialize those operations
across tabs (the supplied client uses Web Locks where available).

Cookies are host-only with `HttpOnly` and `Path=/api`. Patient sessions expire
after 8 hours; staff sessions after 7 days. Production cookies use `Secure` and
default to `SameSite=None` for the current cross-site Render deployment. Local
development defaults to `SameSite=Lax` without Secure on HTTP. Set
`COOKIE_SAME_SITE=lax` or `strict` for a suitable same-site deployment; `none`
always enables Secure, including outside production. Cookies require HTTPS
when Secure is enabled.

`CORS_ALLOWED_ORIGINS` optionally replaces the browser origin allowlist with a
comma-separated list of exact origins, without trailing slashes or URL paths.
Defaults are `http://localhost:3000`, `http://127.0.0.1:3000`, and
`https://carevigo-frontend.onrender.com`. The CORS and CSRF checks share this
configuration. Outside production, the defaults also include the exact origins
`http://localhost:3001` and `http://127.0.0.1:3001`, for a second local frontend.
An explicitly configured list replaces all defaults, including in development.
Add each deployed frontend origin explicitly; wildcard origins
are not supported for credentialed requests.

MongoDB's `AuthSession` collection stores a hash of each random session ID,
scope, account reference with its exact BigInt key when available, credential
version and expiry. Following a password change or recovery, cleanup removes
only sessions older than the committed credential version, including legacy
rows without a version. A new-password login that completes while that cleanup
is delayed remains valid; current and later generations are preserved. Explicit
account-wide revocation without a version bound still removes all sessions.
It does not store plaintext cookie JWTs or CSRF tokens. An expiry TTL index
removes old rows, while authentication checks expiry immediately rather than
waiting for MongoDB cleanup. All API instances share the collection, so logout
revocation survives restarts and works across instances. Ensure this collection
and its TTL index can be created under the deployment's database permissions.
Existing explicit Bearer clients retain their response contract and do not use
this collection.

Some browsers block third-party cookies even with `SameSite=None; Secure`.
For consistent browser support, serve the API through the frontend's own
HTTPS origin (a reverse proxy at `/api`), configure the frontend with
`REACT_APP_API_URL=/api`, and allow that origin in `CORS_ALLOWED_ORIGINS`.
Forward request Cookie and response Set-Cookie headers through the proxy.
An appropriate shared custom domain is another deployment option. The client
verifies the cookie after login and displays a recoverable error when the
browser refuses it; it does not fall back to storing JWTs in localStorage.

## Versioned notices and agreements for new data

New guest submissions, authenticated health saves, patient profile PATCHes and
staff registrations (including the legacy registration path) require an
`agreements` object in the request body. Login, logout, private reads, receipts
and review decisions remain available without accepting new documents. Existing
authentication and patient ownership checks run before a protected data write.
Missing, unchecked or stale agreements return HTTP 422 with
`code: LEGAL_AGREEMENT_REQUIRED` and a Thai explanation before any new personal
data is written.

Patient and guest bodies use:

```json
{
  "agreements": {
    "termsVersion": "2026-11-01",
    "privacyVersion": "2026-11-01",
    "termsAccepted": true,
    "healthDataConsent": true
  }
}
```

Staff registration or staff-entered health data uses an authority attestation:

```json
{
  "agreements": {
    "termsVersion": "2026-11-01",
    "privacyVersion": "2026-11-01",
    "termsAccepted": true,
    "privacyNoticeAcknowledged": true,
    "lawfulAuthorityConfirmed": true
  }
}
```

A staff attestation never creates a patient's health-consent claim, even if a
client submits that extra boolean. These are separate statements by different
actors. Checkbox values must be actual booleans, not strings or numbers.
Versions in `src/utils/legal.js` must match the documents and frontend constants
when a new version is released. Browser memory may hold unchecked form state;
localStorage and sessionStorage are not evidence of acceptance.

The server records a `legalAgreement` proof containing the accepted versions,
applicable booleans, server `acceptedAt`, purposes (`health-records` and
`cv-risk-assessment`), source (`guest-consent`, `patient-consent` or
`staff-attestation`) and authenticated actor ID/exact BigInt actor key when
available. Submitted timestamps, actors, purposes and proof/history fields are
ignored. No IP address or user-agent collection is added.

New profiles store their initial proof and `legalAgreementHistory`. Profile
edits atomically replace the latest proof and append a new history entry. A
guest's original proof stays in the durable Submission and its materialized
Health records. Retry fingerprints include normalized agreement booleans and
document versions, excluding server timestamps. Identical retries reuse the
existing proof and never add another history entry or retimestamp acceptance.
Staff-submitted health records retain the staff attestation on that record.
Existing records remain without consent evidence unless a later explicit new
write supplies it; migration and review workers do not fabricate historical
consent.

This implements versioned notices and recorded acceptance, not a certification
of PDPA compliance or an automated determination of lawful authority. The
general notice describes contacting the service provider for privacy requests;
this change adds no organization-specific identity, invented retention period
or automatic withdrawal/deletion engine.

For optional AI features, configure `OPENAI_API_KEY` only in the server's private
environment; the client is initialized when needed. Do not commit API keys,
passwords or environment files, or place secrets in `REACT_APP_*` settings.
Any credential previously committed must be revoked and replaced through its
provider outside this code change; deleting it from current code does not
revoke earlier copies.

## Deep workflow verification and startup readiness

`src/createApp.js` constructs the same Express middleware and routes used by the
server without loading environment files, opening ports, connecting to a database,
or starting review workers. `src/app.js` starts listening only after MongoDB is
connected. `/api/health` returns 200 with `mongodb: CONNECTED` while connected,
or 503 with `status: NOT_READY` after disconnection; a configured URI alone is
not a readiness signal. API error and preflight responses use `Cache-Control:
no-store`, and request logs omit URL queries containing capability tokens.

An unavailable `/api/health` response includes `Retry-After: 3`, exposed through
CORS for the frontend's bounded readiness polling; a ready 200 response omits it.
Use an anonymous health GET to wait for a suspended host to wake before sending
the original login or save request. Retrying readiness must never replay a save
or other mutation. A backend interval cannot wake its own suspended process;
this improves cold-start handling without changing hosting plans or adding pings.
The review worker catches up overdue approvals and queued email after startup;
it cannot run at 23:59 while the host suspends the process.

Run the normal regression suite and the two explicit integration suites:

```powershell
npm test
npm run test:integration:bigint
npm run test:integration:workflow
```

The integration suites require an installed `mongod` executable. Optionally set
`CAREVIGO_TEST_MONGOD` to its path. They create their own randomly assigned
loopback port and fresh temporary data directory, never load `.env` or use an
existing `MONGO_URI`, and stop only their own MongoDB process before removing its
data directory. An unavailable executable skips those opt-in suites explicitly.
The workflow fixture sets the test process's index-build disk threshold to zero
for its tiny temporary database; this does not change a deployed MongoDB server.
Choose a temporary directory on a drive with sufficient space when necessary.

The workflow suite exercises actual HTTP routes, middleware, Mongoose schemas,
indexes and numeric joins, with counters above JavaScript's safe integer limit.
Only external email delivery is replaced. Cases cover registration with legal
proof, staff-issued PINs, mandatory password changes and revocation, account
isolation, profile/measurement saves and CV risk, concurrent guest idempotency,
selected/all review snapshots, retained rejection audit, explicit email actions,
23:59 Bangkok catch-up, SMTP retry and stale worker leases, and disabled-account
logout. The BigInt suite separately exercises migration dry runs, allocations,
schema write paths and joins. Neither suite sends real email or uses real patients.

Additional HTTP regressions verify that a staff PIN reset invalidates all previous
patient sessions, simultaneous password changes have exactly one successful
version update, and ObjectId profile routes plus staff management endpoints reject
cross-account access and operator-shaped query/body input. To collect one complete
coverage report, including both opt-in suites without running their databases in
parallel, use:

```powershell
$env:CAREVIGO_BIGINT_INTEGRATION = "1"
$env:CAREVIGO_WORKFLOW_INTEGRATION = "1"
node --test --test-concurrency=1 --experimental-test-coverage
```

Flow failure handling preserves durable results: a saved profile remains a
successful response if CV refresh must be retried, with
`data.assessmentRefreshPending: true`. A later profile read recalculates the
assessment. Outbox updates require the current lease nonce so an expired worker
cannot replace a newer worker's result. Logout validates session identity and CSRF
before revocation even if the account has since been disabled or demoted. Legacy
staff Bearer tokens are still accepted in their original format, but every request
checks the account's current active status, staff role and credential version.
