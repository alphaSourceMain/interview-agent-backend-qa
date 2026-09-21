# alphaScreen sales voice agents

QA implementation plan. Keep the four rep routes disabled until every recipient mapping and live delivery test is complete.

## Call path

Each purchased GHL number belongs to one representative:

- Michael Afesi: `+1 720-790-4187`
- Christopher Turean: `+1 719-881-8074`
- Epifanio Sierra: `+1 719-259-2989`
- Daniel Broyles: `+1 719-249-5855`

Each number is a permanent company line slot. Its GHL workflows, GHL mobile custom value, Grok agent, Grok phone number, and Grok bearer token are configured once and stay with the company number when personnel change. The dashboard changes the representative assigned to the slot.

The fixed GHL call workflow connects to that line's managed mobile custom value with Call Connect and a roughly 20-second timeout, then connects to the line's fixed Grok number. This prevents the representative's carrier voicemail from silently taking the call. A separate fixed GHL notification workflow sends the caller-approved SMS message to the same managed mobile value.

The Grok agent states that the named representative is unavailable, collects the caller's confirmed name, company, callback phone, email, and a short message, then asks whether the caller wants the message sent. It does not mention tools, providers, APIs, channels, or delivery mechanics. It sends at most once and only after explicit approval.

## Delivery service

`POST /api/sales/voice-handoff` accepts the six exact tool fields documented by `SALES_VOICE_TOOL`. A distinct bearer token identifies each representative. The request cannot choose a recipient. The backend resolves the fixed Workspace email, Slack member ID, GHL number, and GHL notification workflow from server configuration.

The global-admin **Sales Team & Call Routing** page is the operational source of truth for representative identity, the active GHL-number assignment, the Grok agent and fallback number, the approved agent context, transfer rules, and notification preferences. Active database assignments supersede the original representative-specific environment route table. The original table remains a rollback-compatible path during migration.

**Save draft** writes only the service-role draft table. It cannot change an active recipient or phone assignment. **Save & apply changes** validates the visible form, then uses one database transaction to activate the identity, assignment, prompt version, sales-dashboard mapping, audit event, and provider-status jobs. Changing assignment fields closes the previous assignment and creates a new historical row. Deactivation is also transactional and can be reversed to a draft from the admin page.

Each company line has a distinct stable bearer token. Only its SHA-256 digest is stored. Rotating it invalidates the old token immediately and returns the replacement once to the global admin for both fixed Grok tools. Normal personnel changes do not rotate the token or require a Grok edit. Never place the plaintext token in source, database metadata, logs, screenshots, or release evidence.

The first Grok tool reads `GET /api/sales/voice-handoff/context` before the agent speaks. It receives only the current representative name, opening, approved product context, business hours, timezone, and allowed capabilities. The second tool posts a caller-approved message to `POST /api/sales/voice-handoff`. Both tools use the same line token. The request cannot choose a recipient.

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
- `GHL_PRIVATE_INTEGRATION_TOKEN`: a location-scoped private integration with `locations/customValues.readonly` and `locations/customValues.write`. Apply uses it only to update the selected line's preconfigured mobile custom value.
- `SALES_VOICE_DB_ROUTES_ENABLED`: must be exactly `true` before an active database assignment can authenticate. This is separate from `SALES_VOICE_HANDOFF_ENABLED` so adding the admin schema cannot silently enable a previously empty environment route table.
- `SALES_TEAM_PROVIDER_SYNC_ENABLED=true`: separately enables the Slack membership check and the GHL managed-mobile write. Keep it off until the private integration and fixed line workflows are verified in QA.

Keep the feature disabled unless all route objects validate. Never put bearer tokens in source, agent prompts, URLs, documentation, or logs.

## Remaining setup inputs

Before hiring, finish the four company line slots: provision one Grok number per existing agent, install the generic prompt from `buildSalesVoiceBootstrapPrompt()`, add the fixed context and message tools, publish and verify each agent, create the GHL mobile custom value and two fixed workflows per line, and record those safe provider identifiers on `sales_phone_numbers`. Record the completed Grok QA call reference before marking the agent verified. Changing an agent, phone, workflow, or custom-value identifier automatically returns that provider to pending.

For each representative, create the Workspace account, Slack member, GHL user, and sales-dashboard user. Then enter the name, Workspace address, mobile, Slack member ID, GHL user ID, sales-dashboard user ID, and chosen company line on the admin page. **Save & apply changes** verifies the Slack member, updates the GHL line's mobile value, activates the sales-dashboard identity, and uses the already-published Grok agent's live context. Normal onboarding and turnover require no Grok or GHL editing.

Deactivation removes the active database recipient and clears the managed GHL mobile value. The fixed GHL call workflow must treat an empty mobile value as “skip the human leg” and route directly to its fixed Grok fallback, so a former representative can never receive later calls.

The four Grok Voice drafts were created on September 21, 2026. Until line setup is completed, they remain unpublished and must not be reported as ready:

- Michael Afesi: `agent_1LDTasuwSoOhfbsZ`
- Christopher Turean: `agent_yWdm5vpifYr2z62K`
- Epifanio Sierra: `agent_b32kYrh6mSVlrSK3`
- Daniel Broyles: `agent_QzE6yzA9ZHC6P0wN`

**Save draft** never changes live routing. **Save & apply changes** first updates the selected line's GHL mobile value, verifies the Slack member, and checks the verified Grok line; it activates the database recipient only after every enabled check passes. A failed database apply restores the prior GHL mobile value on a best-effort basis and reports failure. Provider status remains failed or action-required when any check fails, and **Sync providers** retries those checks against the applied line without changing the saved person.

Slack, GHL SMS, and email delivery follow the current applied voice configuration independently. Disabled channels are not called and are not required for route resolution. Slack is `synced` only after `users.info` confirms the exact active member. GHL is `synced` only after its API confirms the managed mobile value. Grok is `synced` only after the reusable line setup is marked verified.

Provisioning the four Grok phone numbers, creating and verifying the fixed GHL workflows/custom values, creating the GHL private integration, and adding the sales-agent Workspace alias are one-time QA setup actions. They must pass the release review and end-to-end line tests before the provider flags are enabled.

## Acceptance checks

- Mobile answered: the representative accepts through Call Connect; Grok does not answer.
- Mobile unanswered/rejected/airplane mode: the carrier voicemail never captures the call; the named Grok agent answers.
- Caller declines sharing: no Slack, email, or GHL text is sent.
- Caller approves after spelling corrections: all three notifications contain the corrected details and the agent never says a tool name.
- Duplicate tool call: the second call is suppressed.
- Wrong token, browser Origin, malformed fields, or arbitrary recipient attempt: request rejected.
- Each GHL number reaches only its assigned representative and agent.
- Rollback: disable `SALES_VOICE_HANDOFF_ENABLED`, remove the Grok tool, and restore the GHL number's previous backup route.
