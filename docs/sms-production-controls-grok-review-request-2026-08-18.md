# Independent Senior QA review request: alphaScreen SMS production controls in QA

You are the mandatory independent Senior QA Test Engineer. Review the current uncommitted diff in this repository. This is a read-only review: do not edit files, run provider calls, send SMS, access credentials, or modify any hosted system.

Scope:

- signed Telnyx inbound STOP/START/HELP handling and deduplication;
- provider-independent suppression semantics, especially START release boundaries;
- Telnyx line-type lookup, keyed cache, and fail-closed eligibility;
- atomic daily spend reservation and provider breaker behavior;
- DB-authoritative keyed abuse limits without raw phone or IP storage;
- QA and production fail-closed enforcement;
- private-schema migration, SECURITY DEFINER wrappers, search_path, grants, RLS, and concurrency;
- monitoring readiness semantics, including use of the existing Telnyx Ed25519 webhook public key for both delivery and inbound events;
- PII, OTP, message-body, and secret leakage;
- compatibility with durable OTP issuance, cross-channel supersession, email fallback, and delivery outcome handling;
- adequacy of tests and any regression risk.

Sanitized validation evidence:

- focused backend control tests: 62 passed, 0 failed;
- complete backend suite: 1,012 passed, 0 failed, 128 intentionally skipped;
- disposable PostgreSQL durable OTP/SMS suite: 38 passed, 0 failed;
- frontend source suite: 237 passed, 0 failed;
- frontend TypeScript, production build, 13-route prerender, and 14-file HTML integrity: passed;
- git diff --check: passed.

Return one decision exactly: APPROVE, APPROVE_WITH_REQUIRED_CORRECTIONS, or REJECT. List required corrections separately from optional recommendations. Be explicit about any critical, high, or medium findings. Do not treat formal legal/compliance approval as a code defect; it remains owner-gated and pending.
