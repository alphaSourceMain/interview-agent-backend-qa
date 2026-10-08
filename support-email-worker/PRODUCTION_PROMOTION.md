# alphy production promotion

This is a prepared release, not an activated customer responder. The isolated
worker does not deploy the application's sales/voice/backend branches.

## Immutable release gate

Record the exact source SHA, Grok 4.7 code verdict, Codex verdict, regression and
disposable SQL results, Blueprint validation and the following configuration.
No subsequent source change is covered without re-review. Never synchronize the
whole QA database or run an unfiltered `supabase db push` for this cutover.

## Separately authorized destinations

Before persistence, owner approval must explicitly cover the new production
Render cron, its recurring runtime cost, separate copies of alphy's existing
read/send OAuth clients and grants, the production Supabase service-role key and
xAI key, and retirement of the shared-mailbox QA responder. Service-role is a
privileged production database credential that bypasses RLS, not a limited role.
Nothing in this document is a credential or authorizes arbitrary customer mail.

Use only `alphascreen-alphy-mail-prod` in the approved My Workspace, with compiled
Supabase `rytlclkkcvvnkoncfaid`. Create from `render.production.yaml`, all defaults
OFF, no environment groups/disks. Pin the reviewed commit in the deploy. Inspect
provider's actual service ID, Node24.19, command, schedule, branch and Live SHA.
Never store secrets in Git, logs, a review packet or the main app's environment.

## Schema (defaults OFF)

Read-only preflight must find no `private_support_email` namespace or conflicting
public functions, and must confirm production membership structure and pg_cron.
Apply only these exact reviewed migrations, in order, to the production project:

1. `20261007202154_support_email_draft_guard.sql`
2. `20261008022721_support_email_qa_send_guard.sql`
3. `20261008152921_support_email_qa_runtime.sql`
4. `20261008181643_support_email_production_body_purge.sql`

The internal `qa_*` table/RPC/enum names are legacy engine names inside the
separate production DB, not QA connections. Do NOT apply the QA-only purge job.
No QA rows, accepted claims, history cursors or seed values are copied. Record
table/RPC ACL and RLS readback, OFF health, purge job (one exact production job)
and Supabase advisors. If any namespace/function/job exists, stop and reconcile,
do not overwrite. Body retention is seven days with hourly purge; durable
dedupe/delivery audit stays. Unknown/submitting must never auto-retry or reset.

## Retire shared-mailbox QA before seed

Verify QA database OFF, Render flags OFF, no active run and actual scheduled OFF.
Mark QA `SUPPORT_EMAIL_MAILBOX_RETIRED=true`, suspend its cron, and remove only its
five approved hosted secret copies after authority is confirmed. Preserve local
original grants and all QA audit records. Read back retirement/suspension/secret
absence. That QA responder must stay retired for this mailbox's lifetime. Future
QA work needs a different mailbox, grants, compiled profile and independent gate.
Separate production secret mounts only; do not share a running QA service mount.

## Production configuration matrix

All modes require exact Render/service/project/mailbox bindings, explicit release
and production-service-role approval, mount approval and validated private files.
Disabled master returns OFF before profiles, files or network. Unknown/missing
environment and mismatched JWT ref fail closed. QA cannot clear owner-only or
carry production release approval, and retired QA cannot run enabled.

| Setting | Draft | Canary | Customer auto |
| --- | --- | --- | --- |
| WORKER_MODE | production-draft | production-canary | production-auto |
| OWNER_TEST_ONLY | true | true | false |
| OWNER_TEST_SENDER | jason@gardner.ltd | jason@gardner.ltd | jason@gardner.ltd |
| CUSTOMER_RESPONSES_APPROVED | false | false | true |
| WORKER_SEND_APPROVED | false | true | true |
| HUMAN_CC_RULE_APPROVED | false | true | true |

Environment names have `SUPPORT_EMAIL_` prefix. Production draft/canary only
process the fixed owner; ordinary sender mail is left for humans without a model
call. Missing canary/auto send or CC flags fail, not silently downgrade to draft.
Customer auto additionally requires explicit owner approval for real responders.

## Controlled destination acceptance

1. With environment master OFF and DB OFF, deploy/read back exact approved SHA.
2. Mount separately approved copies of the five fixed secret files. Privately
   verify identity/scopes/JWT ref and projected mount metadata before enabling.
   Do not expose file values; never waive mount validation.
3. Enable the production owner-only profile with DB OFF; a run must be off_or_busy
   and produce no model/send. Check idle before any manual run, not cancellation.
4. Enable DB for the matching engine mode; fresh null-cursor seed captures Gmail's
   current history id and cutover time, with NO BACKFILL and no model/send.
5. Send one new owner-controlled initial canary through support@. Verify correct
   actual membership-selected static audience, one Sent/readback/accepted claim,
   delivered reply and approved signature. Test duplicate and same-thread reply
   with support@ copied; neither may generate or send again. Restore both gates
   OFF and verify actual scheduled OFF. No old-draft sweep or cursor reset.
6. Record actual public and client audience coverage honestly. QA's actual owner
   was recognized-client; unknown-public is covered by synthetic composition
   tests, not by changing that person's membership to manufacture acceptance.
   If production has only one actual audience fixture, record that limitation;
   any additional real fixture needs explicit bounded authorization.
7. Independent Grok/Codex acceptance of exact production destination results and
   customer activation matrix follows. Only then enable production-auto using
   the separately authorized flags; recheck scheduled run, recipient invariants
   and human-review handoffs. No production activation is implicit in a QA pass.

## Operations and stop

Humans must CC support@ on replies so alphy can see the thread was handled.
Private off-Group replies are invisible. A small last-proof-to-send race remains;
the system cannot recall already accepted messages. Attachments, sensitive/
account-specific requests, replies, automated mail and failed client lookups
remain for humans. Lookup failure stores bodyless review with no model call.
Client detection selects static guidance only, never authorizes account access.

Emergency stop: disable DB gate first, then Render master/send/CC; verify idle
and actual scheduled OFF. Preserve audit and permanent unknown/submitting
claims. Never enable QA as a fallback or reset cursors to replay mail. Roll back
only to a reviewed production-capable SHA while both gates stay OFF.
