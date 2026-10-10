# alphaScreen sales voice agents

QA implementation plan. Keep the four rep routes disabled until every recipient mapping and live delivery test is complete.

## Call path

The control plane has exactly four permanent company line slots:

- Line 1: `+1 720-790-4187`
- Line 2: `+1 719-881-8074`
- Line 3: `+1 719-259-2989`
- Line 4: `+1 719-249-5855`

Each slot keeps its GHL workflows, mobile and GHL-user custom values, and secure route token when personnel change. All four slots share one Grok Voice agent and fallback number. The dashboard changes the representative assigned to the slot without editing the Grok agent.

The fixed GHL call workflow first uses **Assign To User** in Dynamic mode with the line's managed GHL-user-ID value. It records the inbound caller and intended line through `POST /api/sales/voice-handoff/route`, then **Connect Call** rings the assigned user's configured mobile for 20 seconds with voicemail detection enabled. Unanswered calls connect to the shared Grok number. Apply routing verifies the selected GHL user, updates that user's phone to the dashboard mobile, and writes both managed values. A separate fixed GHL notification workflow sends the caller-approved SMS message to the same managed mobile value.

The shared Grok agent confirms the callback number, exchanges it for a short-lived routing reference, and then states that the resolved representative is unavailable. It collects the caller's confirmed name, company, email, and a short message, then asks whether the caller wants the message sent. It does not mention tools, providers, APIs, channels, routing references, or delivery mechanics. It sends at most once and only after explicit approval.

## Delivery service

`POST /api/sales/voice-handoff/route` accepts only the caller phone and a line-specific bearer token from the fixed GHL workflow. A repeated registration for the same unclaimed caller and line reuses that route instead of creating an ambiguous duplicate. `POST /api/sales/voice-handoff/context` accepts only the confirmed caller phone and the shared-agent bearer token; it returns the current representative context and an opaque one-time routing reference. If more than one live unclaimed route exists for the same caller number on different lines, context creation returns `409 route_ambiguous` instead of guessing a line. `POST /api/sales/voice-handoff` accepts the seven exact fields documented by `SALES_VOICE_TOOL`, including that reference. The request cannot choose a recipient. The backend atomically claims the reference and resolves the fixed Workspace email, Slack member ID, GHL number, and GHL notification workflow from the recorded line assignment.

The global-admin **Sales Team & Call Routing** page is the operational source of truth for representative identity, the active GHL-number assignment, the Grok agent and fallback number, the approved agent context, transfer rules, and notification preferences. Active database assignments supersede the original representative-specific environment route table. Once database routing is enabled, a token that belongs to a database-managed company line fails closed when its assignment or delivery configuration is unavailable; it can never fall through to an obsolete environment recipient. The original table remains a compatibility path only for tokens absent from the database during migration.

**Save draft** writes only the service-role draft table. It cannot change an active recipient or phone assignment. **Apply routing** validates the visible form, stages and confirms provider changes, then uses one database transaction to activate the identity, assignment, prompt version, sales-dashboard mapping, audit event, and provider-status jobs. Replacing an occupied slot requires the exact incumbent member ID. The transaction deactivates the former routing and sales-dashboard mapping while preserving the former account, attribution, sales, commissions, assignments, and audit history. A failed provider or database step restores the prior live route.

Each company line has a distinct stable bearer token. Only its SHA-256 digest is stored. The four GHL route webhooks use their respective line tokens. The shared entrypoint token also authenticates both Grok tools. Rotating a token invalidates the old token immediately and returns the replacement once to the global admin. Normal personnel changes do not rotate a token or require a Grok edit. Never place the plaintext token in source, database metadata, logs, screenshots, or release evidence.

The first Grok tool posts the confirmed callback number to `POST /api/sales/voice-handoff/context`. It receives only the current representative name, opening, approved product context, business hours, timezone, allowed capabilities, and an opaque routing reference. The second tool posts a caller-approved message and that unchanged reference to `POST /api/sales/voice-handoff`. Both tools use the shared entrypoint token. A reference expires after 15 minutes and can be claimed only once. Route cleanup preserves its parent event until the reference expires, so unrelated later calls cannot shorten that claim window.

An approved message fans out to:

1. A Slack DM from the existing alphaScreen Sales app.
2. A natural-language email from the dedicated sales-agent sender, with the caller's confirmed email as Reply-To.
3. The line's fixed GHL notification workflow. That workflow sends an SMS to the line's managed mobile value, so the text originates inside GHL.

The GHL workflow URL is restricted to HTTPS on a `leadconnectorhq.com` host. The service does not accept arbitrary callback URLs, recipient addresses, Slack IDs, or phone numbers from the agent. A 24-hour reservation suppresses duplicate sends of the same route and approved message. Only hashes and counters are written by this endpoint; message content is not logged or stored by alphaScreen.

Provider redirects are rejected. Slack renders every caller-provided field as plain text. Route keys, token hashes, emails, Slack member IDs, assigned GHL numbers, and workflow URLs must each be unique across the route table or the whole feature fails closed.

## Required configuration

- `SALES_VOICE_HANDOFF_ENABLED=true`
- `SALES_VOICE_FROM_EMAIL`: verified Workspace/SendGrid sender such as `sales-agent@alphasourceai.com`
- Existing `SENDGRID_API_KEY`
- Existing `SLACK_SALES_WON_BOT_TOKEN`
- `SALES_VOICE_HANDOFF_ROUTES_JSON`: one object per representative with:
  - `route_key`
  - `token_sha256` (the backend stores the SHA-256 digest, while the Grok tool stores the original random token)
  - `rep_name`
  - `rep_email`
  - `slack_user_id`
  - `ghl_number`
  - `ghl_notification_webhook`
- `SALES_VOICE_GHL_WEBHOOKS_JSON`: object mapping each company-owned GHL number in E.164 format to that number's fixed `leadconnectorhq.com` notification-workflow webhook. This capability URL remains server-side.
- `GHL_PRIVATE_INTEGRATION_TOKEN`: a location-scoped private integration with `locations/customValues.readonly`, `locations/customValues.write`, `users.readonly`, and `users.write`. Apply verifies the exact GHL user and Workspace email, updates the user's phone, and updates the selected line's preconfigured mobile and GHL-user-ID values.
- `SALES_VOICE_DB_ROUTES_ENABLED`: must be exactly `true` before an active database assignment can authenticate. This is separate from `SALES_VOICE_HANDOFF_ENABLED` so adding the admin schema cannot silently enable a previously empty environment route table.
- `SALES_TEAM_PROVIDER_SYNC_ENABLED=true`: separately enables the Slack membership check and the GHL managed routing writes. Keep it off until the private integration and fixed line workflows are verified in QA.

Keep the feature disabled unless all route objects validate. Never put bearer tokens in source, agent prompts, URLs, documentation, or logs.

## Remaining setup inputs

### Isolated line-3 QA staging exception

The call-test attestations create a staging dependency: an active recipient is needed to test the line, but the ordinary Apply gate requires the line and shared agent to be verified first. QA has a narrowly pinned exception for the former Epifanio line 3 only. It is enabled only when `APP_ENV=qa`, `SALES_TEAM_PROVIDER_SYNC_ENABLED=true`, `SALES_TEAM_QA_STAGED_MEMBER_ID` equals the approved QA test member ID, and `SALES_TEAM_QA_STAGED_PHONE_ID=21000000-0000-4000-8000-000000000003`. With any value absent or mismatched, the ordinary verified-before-Apply gate remains in force. Never configure this exception in production.

The exception permits Apply with the line-3 GHL setup and shared Grok setup still `pending`, provided both line tokens and every structural identifier are prepared. Slack membership must verify, and GHL must confirm the exact location-only user, email, mobile, and both managed line-3 values. The shared Grok provider job remains `action_required`; neither setup status is falsely marked verified, and the line-4 shared-entrypoint record is not changed. The same pin permits confirmed GHL restore and clear while line 3 remains pending; keep it configured until any rollback or deactivation has cleared the two managed line-3 values.

Stage and test only line 3. After Apply, read back the QA GHL user phone and both line-3 custom values before publishing its call workflow or enabling voice flags. Then conduct the controlled line-3 answered, unanswered, consent-declined, consent-approved, and failure/rollback checks using only approved QA destinations. A successful line-3 test can support marking line 3 GHL setup verified. The shared entrypoint remains pending until a separately approved four-line test; a line-3-only call is not a four-line verification reference. If the test fails, unpublish line 3, disable the voice flags, clear both line-3 managed values through deactivation, and confirm that the QA member is inactive. Do not remove the staging pin before the clear succeeds.

Before hiring, finish the four company line slots: install the route-registration webhook in each GHL call workflow, point every unanswered branch to the shared Grok number, install the generic prompt from `buildSalesVoiceBootstrapPrompt()` and the fixed context and message tools on the shared agent, then publish and verify one test through each line. Keep the existing GHL mobile and GHL-user-ID custom values and notification workflows per line. Record the completed four-line QA reference before marking the shared entrypoint verified. Changing its agent or phone returns Grok to pending; changing a GHL workflow or custom-value identifier returns that line to pending.

For each representative, create the Workspace account, Slack member, GHL user, and sales-dashboard user. Then enter the name, Workspace address, mobile, Slack member ID, GHL user ID, sales-dashboard user ID, and chosen company line on the admin page. The reusable GHL workflow owns the fixed 20-second mobile ring window. **Apply routing** verifies the Slack member, verifies that the GHL user's email matches Workspace, updates GHL mobile forwarding and both line routing values, activates the sales-dashboard identity, and uses the already-published Grok agent's live context. Normal onboarding and turnover require no Grok or GHL editing.

Deactivation removes the active database recipient and clears both managed GHL line values. The fixed GHL call workflow must treat an empty user value as “skip the human leg” and route directly to the shared Grok fallback, so a former representative can never receive later calls.

Four Grok Voice drafts were created on September 21, 2026. The shared design uses the Line 4 agent and number; the other three agents remain unused and must not be deleted or reassigned without approval:

- Michael Afesi: `agent_1LDTasuwSoOhfbsZ`
- Christopher Turean: `agent_yWdm5vpifYr2z62K`
- Epifanio Sierra: `agent_b32kYrh6mSVlrSK3`
- Daniel Broyles: `agent_QzE6yzA9ZHC6P0wN`

**Save draft** never changes live routing. **Apply routing** shows the current occupant and requires an explicit replacement of that exact person, verifies Slack and the prepared Grok line, confirms the GHL user, phone, and both managed line values, and clears a previous line when the representative moves. It activates the database recipient only after every check passes. A failed database apply restores every affected GHL route and reports an explicit operator action if any restore is not confirmed. Provider status remains failed or action-required when any check fails, and **Sync providers** retries those checks against the applied line without changing the saved person.

Preparing or rotating a line token is allowed only when the line is free or assigned to the selected representative. Rotation updates the active compatibility assignment in the same transaction, invalidates the old bearer, and returns Grok setup to pending until the new token is installed and a new QA call is recorded.

Slack DM, GHL SMS, and Workspace email are mandatory for every active salesperson. Database route resolution fails closed unless all three are enabled and configured. Slack is `synced` only after `users.info` confirms the exact active member. GHL is `synced` only after its API confirms the exact user/email match, user phone, managed mobile value, and managed GHL-user-ID value. Grok is `synced` only after the reusable line setup is marked verified.

Configuring the one shared Grok agent, adding the four GHL route-registration steps, verifying the existing fixed GHL workflows/custom values, and adding the sales-agent Workspace alias are one-time QA setup actions. They must pass the release review and end-to-end four-line tests before the provider flags are enabled.

## Acceptance checks

- Mobile answered: the representative accepts through Call Connect; Grok does not answer.
- Mobile unanswered/rejected/airplane mode: the carrier voicemail never captures the call; the shared Grok agent answers and names the resolved representative after loading context.
- Caller declines sharing: no Slack, email, or GHL text is sent.
- Caller approves after spelling corrections: all three notifications contain the corrected details and the agent never says a tool name.
- Duplicate tool call: the second call is suppressed.
- Wrong token, browser Origin, malformed fields, or arbitrary recipient attempt: request rejected.
- Each GHL number reaches only its assigned representative, and the shared agent resolves the same representative before accepting a message.
- Rollback: disable `SALES_VOICE_HANDOFF_ENABLED`, remove the Grok tool, and restore the GHL number's previous backup route.
