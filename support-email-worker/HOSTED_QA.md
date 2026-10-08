# alphy hosted QA processor

This worker is a separate Node24 service, not imported by the website/backend.
Only the owner-controlled `jason@gardner.ltd` can be drafted or replied to.
Production and ordinary customers are rejected by compiled QA configuration.
The legacy local acceptance tools and their accepted-send tombstone are unchanged.

Modes: `qa-draft` never opens sender secrets or sends. `qa-owner-auto` sends only
newly generated safe static guidance with stored model-review false, verified
owner proof, successful membership lookup, and explicit host/send/race approvals.
A missing send/race approval makes the effective mode draft-only. The database
mode must match. Sensitive, account-action, reply, forwarded, attachment and
automatic messages are not sent. Identity matching selects static guidance only.

## Operations

Both `SUPPORT_EMAIL_WORKER_ENABLED=true` and the private database kill switch
must be on. Initial migration and deployment default off. `node tick.js` accepts
no arguments. Off exits zero without opening secrets or making network requests.
Rechecks occur before claim, generation, reserve, start and POST. Changing Render
env values requires a new deploy before the next process sees them. The database
kill switch immediately fences subsequent worker actions; a POST already in
flight cannot be recalled.

The first enabled run acquires the lease, refreshes the readonly grant, then seeds
the separate cursor from the current mailbox profile. It sends nothing and never
backfills old mail. Original grant history baseline is never written. Future runs
consume one bounded `messageAdded` history page. Incomplete pages, stale/expired
history, ambiguous proof/parse, provider errors and insufficient time hold the
cursor and exit nonzero; operator reconciliation is required. There is no automatic
full-sync reset or replay of an old draft. Lease is 180 seconds, run budget 150;
more than 5-second database/local clock skew stops before Google/model work.

Counts and generic errors only in logs. Database cursor timestamp is the last
completed page, not a guarantee of reply delivery. Review/claimed drafts and
unknown/submitting deliveries need human investigation. Seven-day draft body
purge stays active; permanent duplicate keys and delivery records are retained.

## Credentials and host metadata

Five fixed Render Secret Files, service-specific, never an environment group:

- `alphy-read-client.json`: existing dedicated readonly client.
- `alphy-read-grant.json`: copy of existing readonly grant, never modified/revoked.
- `alphy-send-client.json`: isolated sending-project client.
- `alphy-send-grant.json`: isolated exact send/email/OpenID grant.
- `alphy-runtime-keys.json`: exactly `supabaseServiceRoleKey` and `xaiApiKey` from QA.

JSON files are read only at `/etc/secrets/…`, bounded, no symlink/hardlink, with
trusted non-writable ancestors. While master is false, run `node inspect-mounts.js`
as the job command once. It prints only filenames' metadata tuples (no contents,
OAuth/network). Review that actual result and pin its manifest in
`SUPPORT_EMAIL_MOUNT_MANIFEST`, then set mount approval. Any mode/owner drift fails.
Linux-only runtime; local synthetic tests cannot supply provider dependencies to
the shipped command. Credentials must never be placed in Git, logs or evidence.

The paragraph above describes default direct mode; it intentionally rejects
Render's observed projected symlinks. Explicit `SUPPORT_EMAIL_SECRET_LAYOUT=
render-projected-v1` uses only the reviewed projected reader (no direct fallback).
Its pins are `/etc` root0/0755; `/etc/secrets` root0/group1000/03777; root-owned
singlelink public and `..data` links0777 with exact relative targets; generated
timestamp version directory root0/group1000/02755; and five regular singlelink
root0/group1000/0640 leaves. All runtime identity UID/eUID/GID/eGID must be1000.
The sticky mount protects root-owned names, while the backing directory/leaves
are not writable by the application. Every metadata tuple is checked with bigint
inodes before opens; only fixed backing leaves are opened with no-follow/nonblock.
FD stats match before/after bounded reads; buffers wiped/FDs closed on all paths.
Recollecting the complete projection rejects rotation/split versions with no retry.
Draft mode inspects five leaves but opens only readclient/readgrant/QAkeys.
Metadata-only inspect-mounts in this explicit layout returns five uid0/mode0640
pins only after two complete agreeing metadata walks, with zero file opens.
No provider directory is chmodded and no arbitrary symlink is followed.

## Human coordination and delivery

Humans must copy `support@alphasourceai.com` when replying. The last Group-visible
single-message proof must still hold before sending. Private replies never copied
to the Group and the last-check-to-POST race cannot be detected categorically;
the acknowledgement flag records this accepted operating rule, not a guarantee.
Model review and lookup failure never create an intent. Each draft/thread has at
most one submission attempt. Lost start response makes no POST; lost POST or
readback/finish stays unknown/submitting permanently, never retried automatically.
The exact owner-only MIME/Sent verification and branded signatures are reused.

## Deployment and acceptance gates

Dedicated Render cron in My Workspace, every five minutes, Node24.19.0, no disk,
auto-deploy off and isolated branch. Repo root is deliberately retained because
Render removes files outside rootDir and the worker reuses reviewed static shared
libraries/knowledge/assets. Build only installs `support-email-worker` with
`npm ci --ignore-scripts --prefix support-email-worker`; start only runs its tick.
No main backend dependencies are installed or app.js executed. No website service
or production migration.
Fresh exact-source/config Grok Build4.7 and Codex approval before schema/service
changes. Owner approved new service costs/QA secret copies/owner-only tests and
Group-CC rule on October8; that does not authorize production or customer replies.

Required actual hosted tests: fresh owner initial reply and external receipt;
repeat process no resend; Group-visible human/thread reply no send; review flag no
send; both static contexts; scheduled cursor continuation; off/kill-switch;
expired/backlog/lease overlap and unknown-send behavior. Synthetic and disposable
DB tests are separate evidence, not actual email/Render acceptance. Never force a
live Gmail timeout simply to manufacture an ambiguous real send; use controlled
local transport fault tests and operator-reviewed provider readbacks.

Production requires a separate reviewed configuration/source for broader intake,
production credential/schema mapping, synthetic canary and explicit activation.
This compiled owner-only QA runtime itself cannot be pointed at production.
