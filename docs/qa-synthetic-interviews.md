# QA synthetic interviews

Super Admin: QA dashboard -> Interview Reliability -> Synthetic Interviews.
Select one closing scenario, click Run Test Interview, and confirm vendor usage.
No human needs to answer. Stop cancels a running test; received interviewer audio
and synthetic transcript are available for reviewing failures.

## Configuration and boundaries

Set ENABLE_QA_SYNTHETIC_INTERVIEWS=true only on ia-backend-qa. The server also
requires the exact QA Render service ID, external URL, qa-backend branch,
Supabase project yjjxzxoghlpguquknyso and persona pa40626945f5. Production and
preview targets are refused even if the flag is enabled. Existing Tavus and
OpenAI credentials remain server-side. No new secret is needed.

Keep the QA backend on one instance and one Node process. The concurrency guard
and hourly budget are in-process, not a distributed scheduler. Review this
setting before scaling or redeploying. Do not deploy/restart during a run.

One active test, four starts per process per hour, 15-second cooldown, five-minute
vendor maximum, and a six-and-a-half-minute preparation/verification deadline.
No automatic vendor mutation retry. A shutdown that cannot be confirmed prevents
another run for the vendor's five-minute maximum duration. An ambiguous create
failure is not reported as confirmed cleanup. Provider max duration bounds calls
if the process crashes. Check Tavus manually when cleanup is unconfirmed.

Four results and at most 6 MiB of received audio per result are retained in
process memory. Restart/redeploy expires them and resets the in-process budget.
An expired or missing run is unknown/interrupted, never a pass. Save needed audio
before restarting. Playback is authenticated Super Admin only.

## Coverage

All scenarios answer the neutral warm-up and three structured synthetic sales
questions. no_questions means no *closing* questions, not zero interview answers.
The other scenarios ask what happens next, what the interviewer is doing, or for
internal evaluation details. Expected speech comes from interviewClosingContract.

The runner uses real Tavus audio, the deployed QA persona, canonical dynamic
prompt builders, and the actual deployed /interview/live browser UI. It injects
synthetic microphone media only in its isolated Chromium instance. Camera capture
and transmission are disabled there, and remote avatar video requests the lowest
simulcast layer (0), when the Daily call uses SFU mode. Remote audio, video, and
the frontend's real startup/progress checks remain enabled. This reduces media
work; it does not establish that CPU pressure caused a missing answer. It
binds the Web Audio microphone track through Daily's audioSource option, rather
than relying on a top-page getUserMedia override to affect Daily's media context.
It observes real Daily events; it never fabricates participant utterances.

Each answer waits for fresh Tavus candidate-utterance evidence matching the
script's beginning, ending, and minimum content length. Browser playback start
or a speaking event alone cannot advance the test. The wait is bounded; missing
acknowledgement fails with synthetic_answer_not_received. Playback completion
callbacks are not used as success evidence. Failure transcripts retain the most
recent observed events rather than just the snapshot before playback.
Results retain utterance timestamps and at most eight playback diagnostics:
audio-context versus wall-clock progress, source/local audio state, observer
capacity, and replica-utterance arrival times. Failed receipt also logs this
bounded diagnostic with the synthetic run ID, never audio or speech payloads.
These are diagnostic evidence only, not additional pass signals.
Vendor Unicode hyphen variants are normalized for scripted question matching;
different question content still fails rather than advancing the test.

Only within that isolated browser, application status and telemetry are synthetic
nonpersisting responses. The frontend's real end request is intercepted, checked
against the run IDs, and calls the real vendor end API without invoking normal
candidate/database handlers. Cleanup is tracked separately and cannot make a run
pass. All other application API traffic and production origins are blocked.

No candidate, role, interview, credit, OTP, email, resume, report, migration or
persona record is created or changed. Only bounded synthetic vendor conversations
and paid OpenAI audio calls are created. No callback webhook is registered.

Passing requires ordered structured answers, received candidate speech, one
closing invitation, exact approved final turn, no control speech, one frontend
normal-end request, vendor shutdown, browser completion route, and full farewell
in the recorded remote audio as independently transcribed with existing OpenAI
whisper-1. Missing evidence fails closed. Persona prompt/layers/replica are checked
before and after, without patching them.

This is not submission/OTP, end-route database authorization, scoring/report,
disconnect/reconnect, timer-overlap, mobile hardware, physical-device, or human
perceived-quality acceptance. Human testing remains necessary for those gaps or
ambiguous audio failures. A passed synthetic scenario is not production release
approval.
