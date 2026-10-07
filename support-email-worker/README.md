# alphy raw-mail verifier — local QA increment

Separate Node24 package; install with `npm ci --ignore-scripts`, test with `npm test`. `mailauth` is exactly 7.1.1 with a separate integrity lockfile. No startup, polling, cron, model, store, send, provider credential file or deployment wiring exists here. The main Node20 backend package/lock/start path is unchanged.

`readVerifiedInitial` is a fixed read-only Gmail composition. Only canonical hex IDs, dedicated alphy profile, a 400KiB streamed JSON cap, a 256KiB complete raw cap, 64KiB/100-field header cap and a 15-second attempt are accepted. Gmail's padded or unpadded canonical base64url forms are supported. All policy/question data come from those same authenticated RFC822 bytes, never format=full. The minimal bound thread must contain only that message. Every call repeats raw, crypto and thread retrieval: no reusable cached attestation.

Group delivery requires unique critical headers signed by one exact Group full-body RSA-SHA256 DKIM signature. MIME headers are signed too. The parser accepts only a small bounded plain UTF8/ASCII or multipart-alternative subset; unusual MIME, encoded subjects, attachments, HTML-only, malformed/control/spoof content stay ineligible. Signed MIME1.0 comments are bounded in size/depth. RFC MIME-version comment handling: https://www.rfc-editor.org/rfc/rfc2045#section-4 .

Static client-guidance routing additionally requires a full Google ARC chain, contiguous instances, approved keys/algorithms/chain statuses, every AMS covering From, exact signed X-Original-Sender, and one sealed ingress mx.google.com DKIM pass for the exact From domain. Domain AUID is accepted, header.d must agree if present, a full mailbox AUID must match. AMS timestamp is optional; Group DKIM and ARC seals require timestamps, checked against receipt/current clock. Nothing here proves a person or authorizes customer data/actions. A sender-proof failure still permits public static guidance under mandatory human review, never client lookup.

Public SPKI hashes were obtained from an independently successful owner-controlled actual Group/Google proof on 2026-10-07. Only those exact names are allowed. Fixed public resolvers, CNAME/TXT checks, one TXT, strong non-testing RSA2048–4096/exponent65537, per-query/attempt/count caps and no sender-domain DNS are enforced. Key rotation fails closed and needs fresh proof plus review; do not bypass pins. One-attempt caches are cleared. Owned raw/body buffers are zeroed; immutable strings and library internals cannot promise secure erasure.

Opaque eligible decisions are private WeakMap entries tied to frozen raw-derived policy/question/fingerprint. Spreading or forging an object does not mint a decision. Package exports expose only the real composition/inspector. Test fixtures exercise the internal crypto core with independent synthetic keys/resolver but cannot issue production-branded decisions. The security boundary assumes trusted runtime/source/process globals, not hostile code with arbitrary imports or modified fetch/library implementations.

Actual owner-only readback accepted one initial email and rejected both two-message reply threads, with sender proof valid. Cryptographic synthetic failures and bounded transport/MIME tests are separate evidence, not provider acceptance. No bodies/addresses/signature values/credentials are retained in release packets.

This increment is NOT a complete responder. Later reviewed composition must use the existing exact readonly token refresh/client/scope checks, durable claim before model, static membership-only guidance selection, a fresh branded decision immediately before persistence, and mandatory human review. Hosted QA schema/maintenance, actual model/draft tests and a separate approved send credential/outbox/Group-visible human coordination remain pending. Processing and sending are off; production unchanged.
# Owner-only one-shot draft acceptance

`node qa-draft.js` is a separate local Node 24 command, never part of app startup.
It accepts no arguments or provider overrides. It reads only the pinned private
QA `.env`, existing client file, and readonly alphy grant. All real QA/OAuth,
owner-only, exact sender, cutover and original-baseline gates must pass.
No ambient environment is merged. Only the owner-approved external sender is
queried. Both static knowledge sections are hash-verified before any claim.
The durable service-only claim precedes generation; every draft requires human
review and a fresh cryptographic/thread recheck. Errors preserve bodyless claims
or review tombstones, never retry generation or ambiguous saves. The command
prints counts only; successful synthetic previews are returned in RAM for owner
acceptance and are not logged. There is no send transport or hosted scheduler.

Before a real run, the separately reviewed QA schema and fixed hourly body purge
must be installed and verified. The original saved OAuth history baseline never
moves. For this owner-only acceptance, the approved cutover may equal grant
capture, allowing only that owner's explicitly requested test intake; this is
not authority to backfill client/customer mail or to automatically enable a
responder. Leave processing off outside the controlled acceptance run.
