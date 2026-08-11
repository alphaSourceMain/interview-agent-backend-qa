# QA dashboard browser voice support

The QA dashboard voice surface is a separate, informational-only support channel. It does not replace or modify the public alphaSource Support phone agent.

## Knowledge contract

- Version: `2026-08-10.1`
- Source snapshot: `src/content/support-voice-knowledge.json`
- Integrity file: `src/content/support-voice-knowledge.sha256`
- Enumerated sources: dashboard Help Center FAQ, rubric FAQ, public FAQ, public support topics, and public support questions.
- The backend validates the snapshot hash and prompt size before issuing a voice-session credential.

The agent has no tools, no customer/tenant context, and no product-data access. It must not request candidate data, credentials, payment data, interview content, transcripts, or other sensitive information. Account-specific and action requests are redirected to the Help Center or normal support process.

## Agent boundary

The browser support agent is separate from the public phone agent through its dedicated QA gateway, server-owned support prompt, static Help Center knowledge, Carina voice configuration, and audio-only Realtime session. The documented xAI Realtime browser path is configured per session and does not consume a Console Voice Agent entity ID. The existing Console phone agent is therefore unchanged. Do not add a Console agent ID as a readiness gate unless xAI documents and the runtime actually uses that identifier.

## Privacy contract

Conversation audio exists only in bounded process/browser memory while the live QA session is connected. alphaScreen does not persist recordings or transcripts in this phase. Text/transcript provider events are not forwarded or stored. Provider-side processing remains governed by xAI's API terms.

## Transport and authorization contract

- The dashboard uses only `https://ia-backend-qa.onrender.com`; it never receives an xAI credential or chooses the provider prompt, model, voice, tools, or target.
- Session creation requires the existing Supabase bearer authentication plus a service-role, count-only active-membership check. No client ID, membership record, role, email, raw user ID, or account context reaches xAI.
- The browser WebSocket accepts only `alphascreen-support-v1`, a one-time body-frame credential, bounded 24 kHz PCM16 audio, and clear-buffer control. It does not accept text, tools, functions, session overrides, or response instructions.
- The server sends one audio-only xAI session configuration with transcription and resumption disabled. Provider transcripts, text, conversation items, tools, searches, MCP, and function events are never forwarded.
- The `session.updated` attestation permits only xAI's bounded `event_id` and nullable `previous_item_id` envelope metadata in addition to the exact server-owned session contract. Unknown metadata and any capability, prompt, model, voice, modality, transcription, resumption, tool, or transport drift remain fail-closed.
- Before that attestation, only the exact bounded xAI `session.created`, `conversation.created`, and `ping` control envelopes are ignored. A valid content-free `ping` is also ignored during greeting or an attested session; a late session/conversation creation event terminates instead of resetting state. No control can make the browser ready or alter the authoritative session, and malformed, unknown, or capability-bearing messages remain fail-closed.
- Sessions are limited to one per user, 20 per process, ten minutes maximum, 120 seconds of user inactivity, and a 25-second ping/10-second pong deadline.

## Single-instance scale lease

This QA phase uses an in-memory one-time credential and therefore runs only while Render is manually fixed at one instance with autoscaling disabled. `scripts/monitor-support-voice-scale.js` is the mandatory operator monitor for the entire enabled acceptance window.

The monitor samples every two seconds and requires all of the following:

- Render `GET /v1/services/{serviceId}` reports a manually configured instance count of one and no enabled autoscaling;
- Render `GET /v1/services/{serviceId}/instances` returns exactly one instance;
- Render deploy inventory has no active deploy and contains the exact expected live commit;
- the backend's authenticated instance probe reports the same service and commit plus a bounded SHA-256 identity for the live backend process. Render's public instance ID and the container hostname are different identifiers, so they are independently validated rather than compared for equality.

Each matching sample renews a five-second, content-free shared lease in the existing `request_rate_limits` table. One transient request/transport failure receives one immediate bounded retry without renewing the lease from failed evidence. A second consecutive failure exits and revokes the lease; scale, deploy, or process-identity safety mismatches are never retried. A hard mismatch, sample gap over 2.5 seconds, explicit stop, or lease expiry disables new sessions and closes live sessions. Stopping the monitor revokes and deletes the operational lease row. Never enable the frontend or backend voice flag without the running monitor.

Required operator-only environment variables are `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `RENDER_GIT_COMMIT`, `SUPPORT_VOICE_MONITOR_TOKEN`, and `SUPPORT_VOICE_BACKEND_ORIGIN=https://ia-backend-qa.onrender.com`. Do not print or persist their values.

## Release order

1. Deploy the backend with the feature disabled and verify its exact commit and knowledge hash.
2. Confirm one Render instance, autoscaling off, no active deploy, and start the scale monitor.
3. Enable the QA backend flag only after the monitor is renewing a healthy lease.
4. Deploy the matching QA frontend knowledge snapshot, verify hash parity, and enable its QA-only control.
5. Run hosted acceptance, disable the frontend then backend feature, stop the monitor, and verify the lease row is absent.

Production flags remain off. A future FAQ change must regenerate the snapshot, update both repositories, and repeat the backend-first parity gate.
