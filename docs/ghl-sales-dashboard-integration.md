# GHL sales close integration

This integration is QA-first. GHL owns prospect/contact activity and the sales pipeline. alphaScreen owns agreements, signatures, Stripe payment state, client activation, and commission eligibility.

## Inbound contract

Create a GHL workflow that fires only when an opportunity enters the configured **Agreement/Checkout** stage. Its JSON request should contain opaque identifiers only:

```json
{
  "eventId": "{{workflow_execution.id}}",
  "locationId": "{{location.id}}",
  "opportunityId": "{{opportunity.id}}",
  "timestamp": "{{system.timestamp}}"
}
```

Send it to `POST /webhooks/ghl/sales-ready` with `Authorization: Bearer <GHL_SALES_WEBHOOK_SECRET>`. If the workflow supports the current GHL signed-webhook contract, also configure `GHL_WEBHOOK_PUBLIC_KEY` and set `GHL_WEBHOOK_REQUIRE_SIGNATURE=true`. The endpoint stores a SHA-256 body digest, never the raw provider payload, and re-fetches the opportunity and contact from GHL before importing anything.

The authoritative opportunity must match the configured QA location, pipeline, ready-stage, open status, contact, and exactly one active `sales_team_members.ghl_user_id` mapping. The salesperson receives a prefilled dashboard draft. Browser-supplied GHL contact and opportunity IDs are ignored; the server claims one immutable binding when the agreement is created.

## Outbound contract

Activation enqueues a service-role-only `ghl/sales_won` outbox row. Every worker attempt rechecks all of these alphaScreen facts:

1. `public_purchase_intents.channel = sales_assisted`, status is `completed`, and `activated_at` exists.
2. The current membership agreement is `signed`, checkout status is `paid`, and `checkout_paid_at` exists.
3. The linked client billing status is `active` and its subscription is active or trialing.
4. The immutable GHL binding still matches the configured location, pipeline, contact, opportunity, and original owner.

Only then does the worker set the opportunity to Won and add an idempotent activation note with alphaScreen client, agreement, payment, membership, discount, activation, and sale references. Retries first detect an existing Won state and note marker, so duplicate or reordered jobs cannot create duplicate notes or mutate another opportunity.

## Required QA configuration

- `GHL_PRIVATE_INTEGRATION_TOKEN`: location-scoped private integration with existing sales-team routing scopes plus `contacts.readonly`, `contacts.write`, `opportunities.readonly`, and `opportunities.write`.
- `GHL_LOCATION_ID`: exact QA GHL location.
- `GHL_SALES_PIPELINE_ID`: exact QA sales pipeline.
- `GHL_SALES_READY_STAGE_ID`: exact Agreement/Checkout stage.
- `GHL_SALES_WEBHOOK_SECRET`: random server-side bearer shared only with the fixed GHL workflow.
- `GHL_WEBHOOK_PUBLIC_KEY`: current GHL Ed25519 public key when signed delivery is available.
- `GHL_WEBHOOK_REQUIRE_SIGNATURE=true`: enable only when the selected GHL workflow delivery supplies `X-GHL-Signature`; otherwise the dedicated random bearer remains mandatory.
- `GHL_SALES_SYNC_ENABLED=true`: final outbound enable flag. Keep false until migration, scopes, pipeline IDs, inbound workflow, and admin mappings are verified.
- Existing `SALES_INTEGRATIONS_RUNNER_SECRET` and the scheduled `/internal/sales/integrations/process` worker.

Never put tokens, webhook secrets, customer payloads, or raw contact data in release evidence.

## Operations and rollback

The global-admin Sales Team page lists imported bindings and delivery state. **Reconcile** safely restores a missing idempotent outbox row. **Retry Won update** is available only for a failed delivery and revalidates every predicate before provider mutation.

To stop outbound mutation, set `GHL_SALES_SYNC_ENABLED=false`. To stop inbound imports, disable the fixed GHL workflow or rotate/remove `GHL_SALES_WEBHOOK_SECRET`. Do not delete bindings, receipts, audit events, or deliveries; they preserve attribution and incident evidence.
