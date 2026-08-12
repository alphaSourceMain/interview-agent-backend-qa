# Tavus HTTP reliability — QA design and acceptance record

## Scope and baseline

- Repository: `alphaSourceMain/interview-agent-backend-qa`
- Branch: `qa-backend`
- Source baseline: `0cd445a8e0f3ed4f31865ec6847e46cf620c0ee5`
- Initially deployed QA backend: `dc172534daa2864502c0998c1552426c3ab348f6`
- Database migration: not required and prohibited for this phase
- Frontend change: not required and prohibited for this phase
- Production change: prohibited

## Pre-change outbound inventory

The inventory distinguishes active application paths from manual scripts and
unreferenced legacy modules. "Retry" below means an HTTP-layer retry, not the
existing application recovery/reconciliation behavior.

| Class | Source / function | Method and endpoint | Client | Timeout before | Retry before | Failure behavior before | Safety / guard |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Active | `handlers/createTavusInterview.js` / `createTavusInterviewHandler` | `POST /v2/conversations` | axios | none | none | Maps most failures to `tavus_request_failed`; marks the outcome transmitted/ambiguous | `NOT_SAFE_TO_RETRY`; deterministic conversation name and later read-only reconciliation protect the one-provider-binding invariant, but Tavus documents no create idempotency key |
| Active | `lib/tavusDocuments.js` / `createTavusDocument` | `POST /v2/documents` | axios | 15 s aggregate | none | Converts provider failure to `missing_tavus_kb` | `NOT_SAFE_TO_RETRY`; a lost response can leave a created document without a returned binding |
| Active | `src/lib/tavusVendorReconciliation.js` / `findExactConversations` | `GET /v2/conversations?limit=100&page=1` | axios | none | none | Returns bounded `unavailable` evidence | `SAFE_TO_RETRY`; read-only, bounded single-page scan |
| Active | `src/lib/platformHealth/tavusHealth.js` / `fetchTavusConversationPage` | `GET /v2/conversations?limit=100` | generic fetch helper | aggregate abort timeout | none | Health check reports API unavailable | `SAFE_TO_RETRY`; read-only cached health probe |
| Active | `routes/tavus.js` / `/tavus/end-conversation` | `POST /v2/conversations/{id}/end` | axios | none | none | Returns normalized route-level upstream failure and preserves existing failure-state handling | `NOT_SAFE_TO_RETRY`; application duplicate-state guard exists, but Tavus does not document repeated end requests as idempotent |
| Active | `routes/webhook.js` / terminal tool-call branch | `POST /v2/conversations/{id}/end` | fetch | none | none | Logs failure; lifecycle/webhook processing continues | `NOT_SAFE_TO_RETRY`; same undocumented provider repeat semantics; existing application flow remains single-call |
| Latent branch | `routes/webhook.js` / `putJsonToStorage` | `GET` when the helper is passed an HTTP URL | fetch | none | none | Throws to the existing storage path | No active caller passes a URL. Transcript/perception callers store the callback body and must remain unchanged. If activated in future, it is a non-authenticated bounded-download concern, not an authenticated Tavus API call. |
| Inactive helper | `lib/tavusClient.js` / persona create and update | `POST /v2/personas`, `PATCH /v2/personas/{id}` | axios | none | none | Logs raw request/response bodies | `NOT_SAFE_TO_RETRY`; mutating persona operations, and current logging is overbroad |
| QA manual script | `scripts/patchTavusQaP1Persona.js` / `main` | `PATCH /v2/personas/{id}` | fetch | none | none | Exits nonzero and logs response | `NOT_SAFE_TO_RETRY`; explicitly owner-run mutation |
| QA manual script | `scripts/syncTavusPersona.js` / `fetchPersona`, `patchPersona` | `GET /v2/personas/{id}`, `PATCH /v2/personas/{id}` | fetch | none | none | Throws response-bearing messages | GET is `SAFE_TO_RETRY`; PATCH is `NOT_SAFE_TO_RETRY` |
| Unreferenced legacy | `lib/createTavusInterviewInternal.js` / `createTavusInterviewInternal` | `POST https://api.tavus.io/conversations` | node-fetch | none | none | Collapses to a generic create failure | `NOT_SAFE_TO_RETRY`; old endpoint/auth shape; no active importer found |
| Unreferenced legacy | `createTavusInterview.js` / `createTavusInterview` | `POST https://api.tavus.io/conversations` | node-fetch | none | none | Returns generic HTTP 500 | `NOT_SAFE_TO_RETRY`; old endpoint/auth shape; no active app mount/import found |
| Unreferenced legacy | `handlers/recordingReady.js` / `downloadFile` | `GET` arbitrary recording URL | node-fetch | none | none | Throws on non-2xx | `SAFE_TO_RETRY` if reactivated; no active importer/mount found |

Pre-change active direct-call count: **6** Tavus API operations. The URL branch
inside `putJsonToStorage` is latent; no active transcript, perception, or
recording caller passes it a URL. The three manual/inactive Tavus modules add six
more request operations, but are not active application paths.

## Official Tavus documentation findings

- The current API uses `https://tavusapi.com/v2` and the `x-api-key` header.
- The Create Conversation documentation does not document an idempotency key or
  duplicate-suppression contract.
- The End Conversation documentation does not document repeated end requests
  as idempotent.
- The official reference documents provider errors/statuses per endpoint but
  does not establish a general `Retry-After` guarantee.
- Some endpoints document HTTP 429. A valid `Retry-After` response will be
  honored only for retry-safe operations and only within the client's wait cap.
- Undocumented mutation idempotency is not inferred.

## Operation retry classification

| Operation | Classification | Transport policy |
| --- | --- | --- |
| Create conversation | `NOT_SAFE_TO_RETRY` | Explicit timeout, one attempt. Any post-dispatch timeout/network failure remains an ambiguous outcome for existing reconciliation. |
| Create document | `NOT_SAFE_TO_RETRY` | Explicit timeout, one attempt. |
| Create persona | `NOT_SAFE_TO_RETRY` | Explicit timeout, one attempt. |
| Patch persona | `NOT_SAFE_TO_RETRY` | Explicit timeout, one attempt. |
| Get PAL | `SAFE_TO_RETRY` | Up to three total attempts under the bounded read policy. |
| Patch/publish PAL | `NOT_SAFE_TO_RETRY` | One attempt. Pronunciation sync reads back exact attachment state before deciding any reconciliation. |
| Get/list pronunciation dictionaries | `SAFE_TO_RETRY` | Up to three total attempts under the bounded read policy. |
| Create/update pronunciation dictionary | `NOT_SAFE_TO_RETRY` | One attempt. Persistent provider identity and explicit ambiguous states prevent blind duplicate creation/update. |
| End conversation | `NOT_SAFE_TO_RETRY` | Explicit timeout, one attempt; retain caller single-flight/application guards. |
| Get/list conversations | `SAFE_TO_RETRY` | Up to three total attempts on transient network errors, timeouts, 408, 429, 502, 503, and 504. |
| Get persona | `SAFE_TO_RETRY` | Same bounded read policy. |
| Latent external artifact GET | Inactive / separate concern | Do not route through the authenticated Tavus client and do not change transcript/perception storage semantics. If activated later, use a non-authenticated bounded downloader. |

## Canonical client design

The repository will expose one Tavus-specific transport module at
`src/lib/tavusHttpClient.js`. It will own:

- Tavus base URL and `x-api-key` construction;
- exact operation definitions and retry classification;
- finite total-request, connect, response-header, and response-body timeouts;
- bounded transient retry policy;
- bounded exponential backoff with injectable jitter, delay, and transport;
- capped `Retry-After` parsing;
- bounded JSON/text parsing and no-content handling;
- a normalized `TavusProviderError` shape;
- metadata-only structured telemetry and redaction.

The client is Tavus-specific, not a generic HTTP framework. It will use an exact
Node-20-compatible `undici` dependency so connect, header, body, and aggregate
timeouts are explicit. Test seams inject transport, sleep, and randomness; tests
must not sleep in real time.

Timeout classes and operation assignments (all finite and centralized):

| Operation | Class | Per-attempt aggregate | Connect | Response headers | Response body | Attempts / overall cap |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Recovery list conversations, GET persona | Read | 8 s | 3 s | 5 s | 5 s | 3 total attempts |
| Platform-health list conversations | Health read | 2 s | 1 s | 1.5 s | 1.5 s | 2 total attempts and 4.5 s overall operation cap, preserving the current approximately 4 s health budget |
| Create conversation | Mutation | 12 s | 3 s | 8 s | 8 s | 1 attempt; every HTTP-attempt failure remains ambiguous |
| End conversation | Mutation | 12 s | 3 s | 8 s | 8 s | 1 attempt |
| Create/patch persona | Mutation | 12 s | 3 s | 8 s | 8 s | 1 attempt |
| Create document | Long provider mutation | 20 s | 4 s | 15 s | 15 s | 1 attempt; never reduces the existing 15 s aggregate timeout |

The latent external URL branch is not assigned to the authenticated Tavus
client. If it becomes active in a later task it will require a separately
reviewed non-authenticated download policy, bounded response size, and signed-URL
redaction.

Retry-safe operations use at most two retries after the original request.
Backoff is exponential from 100 ms, has bounded injected jitter, and is capped
at 1 s. A valid `Retry-After` value is preferred but capped at 1 s. The health
operation has its own two-attempt and 4.5-second total cap. No unsafe
mutation will retry automatically, including a failure believed to be
pre-dispatch, because the provider contract does not prove an idempotent replay.

Normalized errors contain only bounded fields: provider, operation, category,
HTTP status, retryability, attempts, timeout flag/phase, safe provider request
identifier, and a sanitized provider code/message. Payloads, transcripts,
candidate data, URLs containing signed query strings, API keys, and auth headers
are excluded.

Telemetry is limited to:

- `tavus_request_started`
- `tavus_request_retry`
- `tavus_request_succeeded`
- `tavus_request_failed`
- `tavus_request_timeout`

Only operation, attempt, bounded status/category, retry decision/delay, and
final outcome are recorded. Duration is intentionally not emitted in this QA
slice; adding a coarse duration bucket remains a nonblocking observability
follow-up rather than a reliability requirement.

## Caller compatibility and error-adapter contract

`TavusProviderError` will expose these stable bounded caller fields directly:

- `status` and `httpStatus` (same normalized provider status where present);
- `providerCode` and sanitized `message`;
- `category`, `retryable`, and `attemptCount`;
- `timeout` and `timeoutPhase`;
- safe provider request identifier where present.

Migrated call sites will stop reading `error.response.*`. The end route will
preserve its current HTTP status mapping while returning only a bounded sanitized
detail, never a raw provider body. Document/persona paths will stop logging raw
request or response bodies. Create-conversation will preserve the existing
`annotateTavusCreateError` contract: any error after the HTTP attempt begins,
including connect/DNS/reset/timeout failures, is passed as
`requestTransmitted: true` and remains an ambiguous provider outcome. The client
will not invent a definite pre-acceptance classification. Missing configuration
or pre-request document preparation remains outside that HTTP-attempt rule.

## Inactive and latent exceptions

- The two unreferenced `api.tavus.io` create modules remain documented inactive
  exceptions. Updating their obsolete endpoint/auth/payload would be an
  unrequested behavioral modernization of dead code. Existing webhook-auth
  static tests continue to inspect them.
- `handlers/recordingReady.js` remains an inactive arbitrary-download exception;
  it must not receive an authenticated Tavus API client.
- The inactive persona helper and QA persona scripts will migrate to the shared
  client and remove raw provider-body logging because they are genuine Tavus API
  operations that may be run manually.
- The latent `putJsonToStorage` URL branch remains unchanged. No callback path
  will be changed from storing its webhook body to fetching a URL.

The final search gate requires no active `tavusapi.com`, `x-api-key`, or direct
Tavus fetch/axios call outside the canonical client. Every remaining match must
be a test fixture, documentation, or one of the explicitly documented inactive
exceptions above.

## Circuit-breaker decision

`CIRCUIT_BREAKER_NOT_JUSTIFIED`

The call volume is modest, finite timeout plus bounded operation-aware retry is
sufficient to fail fast, and a circuit breaker would add cross-instance state
and reset complexity on Render while risking false-open denial after Tavus
recovers. No breaker will be added in this phase.

## QA implementation and pre-deploy validation

- Pre-fix red gate: `test/tavus-http-client.test.js` failed because the shared
  client did not exist, establishing the missing abstraction before correction.
- Focused Tavus client and operation-safety matrix: 28/28 passed.
- Focused transport and preservation regressions: 230/230 passed.
- Complete Node 20 backend suite: 760 tests, 686 passed, 74 database-gated tests
  skipped in the non-database run, 0 failed.
- Disposable PostgreSQL suites: 126/126 passed with 0 skipped and 0 failed.
- Render-equivalent build and changed-file syntax checks passed.
- `git diff --check` passed; no frontend, schema, migration, or production file
  is part of this change set.
- Grok Build 4.5 code review decision: `APPROVE`; no required corrections.
  Nonblocking observations were limited to optional duration buckets, redundant
  Agent header/body defaults that are overridden per request, and the injected
  fetch test seam relying on the aggregate abort deadline.
