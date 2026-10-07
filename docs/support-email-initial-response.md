# alphy initial support email — QA draft-only foundation

## Scope and status

User approved implementation and a dedicated `alphy@alphasourceai.com` mailbox, not the owner's mailbox. `support@alphasourceai.com` remains a Google Group and the human support address. This isolated QA foundation does not change voice agents, sales routing, the Group, production, or existing backend HTTP handlers. It is not a live email responder. No send API or Gmail draft API exists here. `npm start` does not import or run the worker.

Only newly received, independently attested Group deliveries are eligible. Reply headers, localized reply/forward subjects, a thread with more than one message, self/internal mail, voice support handoffs, bounces, auto replies, ambiguous recipients, and excluded labels are rejected in code. Attachments, oversized/sensitive/quoted content and HTML-only mail do not reach the model. A duplicate claim never calls the model again, including after storage errors or a body purge. Last-moment thread changes discard the body.

## Knowledge and identity boundaries

`supportEmailPolicy` reuses `supportVoiceKnowledge.readKnowledgeFiles`, including SHA256 verification. Public inquiries select only the `public` section; eligible active clients select only the static `dashboard` section. This is the approved source shared with support voice, not a live sync with arbitrary Console agent edits. No account, candidate, billing, role, or interview record is provided to xAI.

Client guidance needs a provider-verified sender, a single confirmed non-deleted/non-banned Auth user, and an active client membership through the existing membership helper. Failure means public guidance and internal human review. Email equality is lowercase exact equality only: no Gmail dot removal, no plus-tag stripping, no fuzzy/domain/company matching. An email address in the message body or Reply-To cannot select client context. No visible text reveals the membership lookup outcome. This is guidance routing, not authentication or authority to reveal account data.

The fixed signature is:

    alphy
    AI support assistant | alphaSource

The model gets static knowledge and the untrusted plain-text question, with email addresses, phone-like numbers and URLs redacted, not the routing sender/recipient identifiers. This is conservative filtering, not a claim that all possible personal names or sensitive prose can be detected. It has no tools and returns strict JSON; extra fields, invalid output or transport errors are discarded. Account-action claims and deadlines flag a draft for human review. All drafts, even ones not individually flagged, need review in this phase.

## Storage

CLI-generated migration creates `private_support_email.drafts`, with RLS, revoked public/browser grants and service-only RPC functions. SHA256 keys uniquely identify mailbox/thread, mailbox/RFC Message-ID and mailbox/Gmail message. The atomic claim commits before model work. The one narrow Auth lookup is a private, service-only SECURITY DEFINER function with an empty search path; its role guard requires `service_role` with no end-user `auth.uid()`. A public SECURITY INVOKER wrapper exposes no auth row. No frontend route or permission is added.

Bodies expire after seven days. `purge_support_email_draft_bodies()` erases expired bodies but retains duplicate-protection keys. A reviewed maintenance schedule must be installed before live processing; expiry alone is not deletion. Never automatically clear claims or retry stuck/unknown generation. An operator may review failure reason codes, not blindly replay mail. Logs must omit body, addresses, access tokens, raw provider errors and connection strings.

## QA configuration (off by default)

The worker requires all of these:

- `SUPPORT_EMAIL_ENABLED=true`
- `SUPPORT_EMAIL_MODE=qa-draft`
- `SUPPORT_EMAIL_ENVIRONMENT=qa`
- `SUPABASE_URL=https://yjjxzxoghlpguquknyso.supabase.co`
- `SUPPORT_EMAIL_MAILBOX=alphy@alphasourceai.com`
- `SUPPORT_EMAIL_CUTOVER_AT`: the reviewed enablement instant, ISO8601
- `SUPPORT_EMAIL_BASELINE_HISTORY_ID`: Gmail profile history id captured at enablement

Do not enable yet. There is deliberately no runtime cron/start script: reviewed credential refresh and delivery/sender verifiers are required before wiring one. The default Group delivery verifier returns false. The test verifier is synthetic fixture evidence only and must never be substituted into a live job.

`createReadonlyGmail` accepts a short-lived token, checks its actual grants with Google, requires exactly `gmail.readonly`, and verifies its mailbox profile. It cannot refresh itself, send mail or create Gmail drafts. A later reviewed OAuth installer/refresh adapter is required; the Codex Gmail connector is not its credential. Credentials must not be shared from the owner's Gmail or unrelated alphaAccounts integration.

One polling page is capped at 25 messages; a next-page token stops the run for backlog review rather than silently starving older messages. MIME traversal and decoded text are bounded. Gmail's own `internalDate` and post-baseline history are checked after search; no historical backlog may be processed. Native fetch responses have a streaming byte cap and request deadlines.

## Remaining enablement work

1. Create/confirm a real Google Workspace `alphy@alphasourceai.com` mailbox and subscribe it to the support Group using **Every email**, not digest. This may require a Workspace license; do not create a paid account without Jason's approval. Keep human Group members and their delivery intact.
2. Verify external senders can post to support, and capture redacted initial/reply/human-response Group fixtures in that new mailbox. Existing evidence proves delivery to Jason only, not to alphy.
3. Implement and review independent provider-inserted authenticated Group delivery evidence and sender DMARC/ARC validation. Sender-supplied list/From/authentication headers must not serve as attestation. The placeholder verifier intentionally keeps live mail ineligible.
4. Approve/install a dedicated Gmail **read-only** OAuth client and secure token refresh in QA. Test wrong mailbox and overbroad scopes. Add no Gmail send capability in this phase.
5. Apply/review the migration in QA, run advisors and real service/browser denial checks, install body-purge maintenance, then add a separate bounded QA polling entry point. Confirm Auth schema compatibility and client membership query behavior.
6. Run controlled owner-only initial/reply/duplicate/human-race/loop fixtures and inspect drafts as escaped plain text. No real customer email or automatic send before the explicit gate.
7. Obtain Grok approval of the exact final code, configuration and hosted evidence before deploying/enabling.

## Local read-only OAuth preparation

`supportEmailOAuth.js` is a callable helper only, not a backend HTTP endpoint. It has no credential store or listener. An owner-approved dedicated internal Google client has been created separately through Google Console, but no mailbox grant has been issued. It is not imported by `app.js` or run by any start/cron command.

It requires separate `SUPPORT_EMAIL_OAUTH_ENABLED=true`, the exact QA environment/mode/Supabase URL/mailbox above, a dedicated `SUPPORT_EMAIL_GOOGLE_CLIENT_ID`, `SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET`, and exact `SUPPORT_EMAIL_GOOGLE_REDIRECT_URI=http://127.0.0.1:43871/oauth/callback`. These are documentation, not an instruction to save or enable them yet. Unlike polling, connecting does not require a baseline or SUPPORT_EMAIL_ENABLED=true: capture the initial Gmail baseline only after approved consent, before later enabling draft processing.

The helper constructs one five-minute, single-attempt state/PKCE authorization request with only Gmail read-only scope, requesting an explicit account chooser plus consent. It verifies token audience and authorized client, exact scope, absolute/relative expiry, and exact alphy profile before returning token material to a trusted future installer. It validates refreshed tokens the same way and never retries an authorization/token request automatically. Fixed Google endpoints use deadlines, bounded responses and deny redirects. Provider failures expose only generic reason codes. No secret is persisted or printed; future secure storage/rotation must be reviewed separately. Google's tokeninfo query-string introspection remains a documented credential-handling residual; never log those URLs.

Definitive wrong-account/client/scope/lifetime or missing-refresh-token rejection triggers one Google revoke POST with token in its body, no client secret, no retry and no logged token. Only HTTP 200 with a bounded discarded body confirms revocation; anything else returns REVOKE_UNCONFIRMED and no credential material. Provider/transport/parse outages do not revoke an existing grant. Refresh rejection prefers an issued rotated refresh token, otherwise the supplied refresh token, otherwise an issued access token. Consent returns the baseline once; refresh returns currentHistoryId separately so it cannot silently move the baseline forward.

A reviewed owner-operated loopback callback installer (bound only to 127.0.0.1, browser-origin/session/state protection, no code logging or third-party callback content), a dedicated internal Google client, action-time approval for the exact scope and persistent credential destination, and hosted QA checks are still required before real authorization. Client creation, consent, storage, loopback listener and hosted enablement are not authorized by this helper's review. Do not paste credentials into chat or use an unrelated OAuth client. This helper must not be wired to a send worker.

## Standalone owner-operated QA connection

`scripts/connectSupportEmailQa.js` and `supportEmailInstaller.js` implement a local one-time setup command, separate from the backend. The downloaded owner-only Web client JSON is pinned to the dedicated project/client, official endpoints and exact loopback redirect. The CLI supports only `/Users/jasongardner/Downloads/alphy-support-qa/grant.json` as its destination. It refuses existing grants; never overwrite or delete one to retry automatically.

Start requires the documented QA OAuth gates plus **SUPPORT_EMAIL_ENABLED=false** and **SUPPORT_EMAIL_CONNECTION_APPROVED=true** explicitly. The latter records separate owner approval, not a substitute for it. Every action and final storage checks those gates again. It listens only at 127.0.0.1:43871 for five minutes, prints only a one-use private local bootstrap URL and a final STORED/FAILED/REVOKE_UNCONFIRMED code, and requires a HttpOnly Secure SameSite=Lax cookie plus CSRF/Origin validation before Google authorization. The unpredictable bootstrap can be opened from a desktop/chat link; a supplied mismatched Origin is denied. Connect POST requires exact local Origin, or Chrome's no-referrer Origin:null only when Sec-Fetch-Site=same-origin, Sec-Fetch-Mode=navigate and Sec-Fetch-Dest=document; it still requires cookie and constant-time CSRF. Unqualified/cross-site null origins are denied. A valid POST returns a static generated/validated Google authorization link instead of a cross-origin form redirect, retaining strict form-action, no scripts and no-referrer. Callback state/PKCE and exact verified alphy/read-only grant remain mandatory. No token, code, provider body or callback query is printed, echoed or served. Invalid unauthenticated requests do not consume the legitimate flow. Browser pages have no external content and deny caching/referrers/framing. First authenticated exact-path callbacks are terminal, including malformed query strings; optional iss must equal https://accounts.google.com.

After **separate action-time approval for the actual grant and this persistent destination**, successful consent stores only refreshToken, mailbox, clientId, scope, baselineHistoryId, capturedAt and accessTokenExpiresAt in an owner-only 0700 directory / 0600 file outside Git. capturedAt is not worker enablement. The short-lived access token is not persisted. Exclusive atomic hardlink publication is the commit point and prevents replacement. Before commit, a post-grant storage/gate/timeout failure attempts one revoke and reports REVOKE_UNCONFIRMED if Google cannot confirm it. After commit, cleanup/durability failure reports FAILED but retains the committed grant without revoking; inspect that file and Google access manually before proceeding. Never restart by erasing it. macOS ACL grants are rejected on each checked ancestor/directory/file (deny-only ACLs accepted). POSIX modes/owners, O_NOFOLLOW file handles and exclusive publication are checked. Node has no native openat: path ancestors are checked instead; race protection depends on trusted root/owner-only mutation of those paths. Sticky root-owned temporary ancestors are accepted only for the synthetic test filesystem, while the production CLI path is pinned to Downloads. Filesystem threat model excludes a malicious process already running as the owner or root; those processes can access the owner's files and localhost cookies. These residuals must be explicitly reviewed.

Do not execute the real installer before exact-candidate review and approval. Synthetic tests bind only loopback and use fake provider responses; passing them does not prove real tokeninfo compatibility. No deployment/polling/migration is performed by the command. A stored grant is not a live responder. Group delivery attestation, hosted draft tests, signature MIME integration and sending gates below remain required.

SIGINT/SIGTERM and the global timeout cancel the local flow and allow any in-flight exchange to settle through the post-grant revoke path before returning a final status. SIGKILL, power loss or process/runtime failure cannot guarantee revocation; if consent occurred without STORED, inspect Google's app access before retrying. This is not a crash-proof grant transaction.

## Later automatic send release

This foundation does not implement the requested live automatic reply yet. That needs a separate reviewed sending phase: verified `support@` send-as or approved sender, correct reply threading and RFC auto-response headers, a delivery outbox with delivery-unknown tombstones, pre-send thread/history checks, human support coordination and a reviewed instant-off control. A new flag cannot turn the present draft worker into a sender. Approving a dedicated mailbox is not approval to grant sending scopes or reply to existing customer threads.

Human replies outside the designated mailbox cannot be reliably detected by Gmail thread lookup alone. Configure/test shared Group-visible replies (and an explicit coordination policy) before enabling auto-send. Do not promise exactly-once email delivery or zero races across separate Google users without that evidence.

## Verification

    node --test test/support-email.test.js

Disposable PostgreSQL bootstrap and assertions are in `test/fixtures/support-email-db-*.sql`. Apply the migration only to a fresh disposable database for those tests, not to an existing live database. The test roles and fake auth schema are not production migrations.
