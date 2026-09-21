# alphaScreen sales voice agents

QA implementation plan. Keep the four rep routes disabled until every recipient mapping and live delivery test is complete.

## Call path

Each purchased GHL number belongs to one representative:

- Michael Afesi: `+1 720-790-4187`
- Christopher Turean: `+1 719-881-8074`
- Epifanio Sierra: `+1 719-259-2989`
- Daniel Broyles: `+1 719-249-5855`

For each number, GHL rings the assigned user first. Enable Call Connect and a roughly 20-second timeout so a human must accept the call before it connects and the representative's mobile carrier voicemail does not answer. The second destination is that representative's dedicated Grok Voice number. Do not share one fallback number unless the dialed GHL number is carried into the agent session through a trusted provider field.

The Grok agent states that the named representative is unavailable, collects the caller's confirmed name, company, callback phone, email, and a short message, then asks whether the caller wants the message sent. It does not mention tools, providers, APIs, channels, or delivery mechanics. It sends at most once and only after explicit approval.

## Delivery service

`POST /api/sales/voice-handoff` accepts the six exact tool fields documented by `SALES_VOICE_TOOL`. A distinct bearer token identifies each representative. The request cannot choose a recipient. The backend resolves the fixed Workspace email, Slack member ID, GHL number, and GHL notification workflow from server configuration.

The global-admin **Sales Team & Call Routing** page is the operational source of truth for representative identity, the active GHL-number assignment, the Grok agent and fallback number, the approved agent context, transfer rules, and notification preferences. Active database assignments supersede the original representative-specific environment route table. The original table remains a rollback-compatible path during migration.

Each active assignment has a distinct handoff token. Only its SHA-256 digest is stored. Rotating it invalidates the old token immediately and returns the replacement once to the global admin for the corresponding Grok message tool. Never place the plaintext token in source, database metadata, logs, screenshots, or release evidence.

An approved message fans out to:

1. A Slack DM from the existing alphaScreen Sales app.
2. A natural-language email from the dedicated sales-agent sender, with the caller's confirmed email as Reply-To.
3. A representative-specific GHL inbound workflow. That workflow sends an internal SMS notification to the mapped GHL user, so the text originates inside GHL and follows that user's saved mobile notification number.

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
- `SALES_VOICE_GHL_WEBHOOKS_JSON`: object mapping each company-owned GHL number in E.164 format to that number's fixed `leadconnectorhq.com` notification-workflow webhook. This capability URL remains server-side; the admin page stores only the workflow identifier.

Keep the feature disabled unless all route objects validate. Never put bearer tokens in source, agent prompts, URLs, documentation, or logs.

## Remaining setup inputs

For each representative, create the Workspace account, Slack member, and GHL user, then provide the Workspace address, Slack member ID, and mobile number used by GHL notifications and call forwarding. Create one GHL inbound-webhook workflow per representative and target its SMS action to that fixed user. Create one draft Grok Voice agent per representative using `buildSalesVoiceAgentPrompt(repName)`, give it only the `notify_sales_representative` tool, and use its distinct bearer token.

The four named Grok Voice drafts were created on September 21, 2026. They have the representative-specific greeting and consent policy, caller phone visibility enabled, no phone number, and no tools. They remain unpublished drafts:

- Michael Afesi: `agent_1LDTasuwSoOhfbsZ`
- Christopher Turean: `agent_yWdm5vpifYr2z62K`
- Epifanio Sierra: `agent_b32kYrh6mSVlrSK3`
- Daniel Broyles: `agent_QzE6yzA9ZHC6P0wN`

No GHL number routing is changed merely by saving the admin record. **Apply changes** activates the database-owned recipient route and records the remaining GHL and Grok provider actions. Do not report either provider as synchronized until the saved GHL routing and published Grok agent have been verified.

Publishing agents, provisioning Grok phone numbers, adding the sales-agent Workspace alias, creating a GHL private integration or workflow webhook, and changing live GHL routing are separate external changes. Complete those only against the confirmed QA route after reviewing the exact configuration.

## Acceptance checks

- Mobile answered: the representative accepts through Call Connect; Grok does not answer.
- Mobile unanswered/rejected/airplane mode: the carrier voicemail never captures the call; the named Grok agent answers.
- Caller declines sharing: no Slack, email, or GHL text is sent.
- Caller approves after spelling corrections: all three notifications contain the corrected details and the agent never says a tool name.
- Duplicate tool call: the second call is suppressed.
- Wrong token, browser Origin, malformed fields, or arbitrary recipient attempt: request rejected.
- Each GHL number reaches only its assigned representative and agent.
- Rollback: disable `SALES_VOICE_HANDOFF_ENABLED`, remove the Grok tool, and restore the GHL number's previous backup route.
