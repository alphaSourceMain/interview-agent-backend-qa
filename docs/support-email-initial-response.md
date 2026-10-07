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

CLI-generated migration creates `private_support_email.drafts`, with RLS, revoked public/browser grants and service-only RPC functions. SHA256 keys uniquely identify mailbox/thread, mailbox/RFC Message-ID and mailbox/Gmail message. The atomic claim commits before model work. The one narrow Auth lookup is a private, service-only SECURITY DEFINER function with an empty search path; a public SECURITY INVOKER wrapper exposes no auth row. No frontend route or permission is added.

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

## Later automatic send release

This foundation does not implement the requested live automatic reply yet. That needs a separate reviewed sending phase: verified `support@` send-as or approved sender, correct reply threading and RFC auto-response headers, a delivery outbox with delivery-unknown tombstones, pre-send thread/history checks, human support coordination and a reviewed instant-off control. A new flag cannot turn the present draft worker into a sender. Approving a dedicated mailbox is not approval to grant sending scopes or reply to existing customer threads.

Human replies outside the designated mailbox cannot be reliably detected by Gmail thread lookup alone. Configure/test shared Group-visible replies (and an explicit coordination policy) before enabling auto-send. Do not promise exactly-once email delivery or zero races across separate Google users without that evidence.

## Verification

    node --test test/support-email.test.js

Disposable PostgreSQL bootstrap and assertions are in `test/fixtures/support-email-db-*.sql`. Apply the migration only to a fresh disposable database for those tests, not to an existing live database. The test roles and fake auth schema are not production migrations.
