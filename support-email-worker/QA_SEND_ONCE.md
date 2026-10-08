# One approved owner-only QA reply

This implementation must receive the mandatory independent exact-commit Grok
and Codex passes before any hosted migration, genuine consent or real send.
Design approval alone is not implementation approval.

Only one existing human-reviewed QA draft is eligible: UUID
`1afe67e6-78e7-4df9-a69a-cbb066351d9d`, client static guidance. Both body MD5
`3b5b4fcd3e944481c150ba00eb3ff5a2` and SHA256
`25796fcabdd1ea631b88a60e83d9c7bc0351c6b1f08acc6f36e3e2bdbdfb6f38`
are pinned without trimming. No new generation or private customer lookup runs.
It can send only from alphy to the owner's previously authorized test address.

## Credential and configuration boundary

The sender is isolated in its own Internal Google project:
`alphascreen-alphy-qa-sending`, number `581820238541`, client
`581820238541-evup8b38vdio8f53rultitdifc4dmmdl.apps.googleusercontent.com`.
Downloaded JSON must match that exact project, client prefix, endpoints and
redirect; old project/client pairs and mixed metadata are rejected. Google
revocation is project-wide, so a second client in the intake project is unsafe.
The separate Internal Google client has one callback at
`http://127.0.0.1:43873/oauth/callback`. It requests exactly Gmail send and
userinfo email, not Gmail read/modify/delete or admin permissions. Identity
must be Google's verified primary alphy email; client/audience/expiry/scope
checks remain mandatory on authorization and refresh. Extra scopes stop the
test; do not widen them to get a provider test to pass.

Approved new owner-only files are `Downloads/alphy-support-qa/isolated-send-client.json`
and `isolated-send-grant.json`. The unused old same-project sender JSON stays
untouched and is not used. Reads reject symlinks, hardlinks and unsafe ancestors;
new grant publication is exclusive, fsynced and never overwrites a file.
Access tokens are RAM-only. Only an uncommitted new send refresh token may be
revoked during failed connection cleanup. Neither committed send nor original
readonly credentials are ever written/revoked on refresh failure or rotation.
After any new sender-project revoke attempt (including an unconfirmed result),
stop; the original readonly grant must be refreshed and verified by a separately
reviewed read-only procedure before any further sender consent. Do not force
an artificial failure, retry consent, bypass flags or treat mocks as live proof.

Configuration comes only from the pinned private QA env file, not ambient
environment or command arguments. XAI_API_KEY is not selected or used.
SUPPORT_EMAIL_ENABLED is false in all send modes. Existing QA mode, URL,
owner-only sender, cutover and immutable original history baseline must match.

Consent mode requires SEND_CONNECTION_APPROVED=true, SEND_OAUTH_ENABLED=true,
SEND_ONCE_ENABLED=false; existing CONNECTION_APPROVED=false and OAUTH_ENABLED=false.
Send mode requires both connection approvals false, SEND_ONCE_ENABLED=true,
SEND_OAUTH_ENABLED=true, existing OAUTH_ENABLED=true solely for real readonly
refresh. All short names above have the SUPPORT_EMAIL_ prefix. Runtime does
not edit the env file. Operator setup turns all processing/connection/OAuth/
send flags back off after the test or a failed/abandoned connection.

## Irreversible at-most-one attempt

The QA-only private send_intents table has RLS and no browser policies. Direct
table privileges are denied even to service_role. Private guarded definers
and public invoker wrappers permit only the service role with auth.uid null.
The fixed-draft CHECK, permanent primary key, original proof and wire hash,
unguessable nonce and three-minute lease enforce one process's transitions:

reserved -> submitting -> accepted OR unknown; reserved -> cancelled.

There is no retry/resume/delete/reversal API. Any existing intent causes the
next command to stop before authentication or Gmail submission. A lost
reserve/start response stops without sending; a lost send/finish response can
leave unknown/submitting/accepted but never permits another attempt. This
is not an exactly-once external delivery promise.

The command verifies the real original raw Group signature, sealed Google ARC
sender proof and single-message thread, then repeats the full check before
reserve and before start. Static knowledge, reviewed body hashes and secure
config binding are rechecked. No model or inbound classifier is relaxed.
The narrow residual final-read/send race is accepted only for this attended
owner test, not a general live responder.

MIME is fully built before reserve/start: multipart related with plain/HTML
alternative and one local CID horizontal PNG. Both signature options are
hash-verified. Fixed owner/alphy addresses, original Subject/Message-ID/thread,
automatic-reply suppression headers and 240KiB wire limit reject injection,
extra recipients and oversized mail. No Date/Message-ID is fabricated.

Exactly one bounded fixed Gmail send POST follows a confirmed start. Readonly
alphy profile, exact returned raw Sent ID and two-message thread must then
match all submitted headers and exact MIME body bytes. Normal Google-added
transport/authentication headers are allowed; extra recipients are not.
Only after confirmed persistence can the command report
sent_copy_verified_owner_receipt_pending. External receipt still needs owner
confirmation. Duplicate rerun and one original-thread noninitial check do
not run the draft scanner or enable processing. An optional owner response
must reply to alphy only, not Reply All to the Group.

## Test boundaries

Synthetic unit suites cover strict scope/identity/config/path/CSRF checks,
no committed revocation, MIME limits/tampering, closed composition ordering,
reply/config races, lost responses and no retry. Module replacements exist
only in tests, not in the runtime command interface.

`test/support-email-send-db.test.js` accepts only an isolated temporary Unix
socket under `/private/tmp/alphy-send-db-test.*`, port55475 and a synthetic
database user. Each fixture first compiles the exact shipping migration,
then replaces only body pins in that disposable database so a fake body can
exercise transitions. It never edits the shipping migration. Eight concurrent
reserve/start operations must each yield exactly one winner. Production or
hosted QA URLs cannot enable these tests.

Before actual additive QA migration: verify the exact QA project, all proposed
objects absent and the approved draft current. Afterwards verify owners,
function source, private definer/public invoker placement, ACLs, RLS and
service/browser API behavior. No production or backend app deployment is part
of this increment. Any uncertain real send burns the permanent attempt;
do not erase its latch to retry.
