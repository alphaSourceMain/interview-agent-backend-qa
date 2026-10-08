'use strict';
// Synthetic closed-composition substitutes only; not Google/provider acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const { OWNER, MAILBOX } = require('../src/qa-config');
const { QA_PROFILE, getRuntimeProfile } = require('../src/runtime-profile');
const productionProfile = mode => getRuntimeProfile({ SUPPORT_EMAIL_ENVIRONMENT:'production', SUPPORT_EMAIL_WORKER_MODE:mode,
  SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'true', SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED:'true', SUPPORT_EMAIL_CUSTOMER_RESPONSES_APPROVED:'true' });
const nonce = '11111111-1111-4111-8111-111111111111', claim = '22222222-2222-4222-8222-222222222222';
async function harness(change = {}) {
  const events = [], writes = [];
  let reads = 0, off = !!change.off, state = null, elapsed = 0;
  const priorNow = Date.now, clockStart = priorNow();
  const cfg = { binding: 'fixed', mode: change.draftOnly ? 'qa-draft' : 'qa-owner-auto', profile: change.productionMode ? productionProfile(change.productionMode) : QA_PROFILE,
    readClient: {}, readGrant: { baselineHistoryId: '1', refreshToken: 'test' },
    sendClient: {}, sendGrant: { refreshToken: 'test' }, keys: { supabaseServiceRoleKey: 'test', xaiApiKey: 'test' } };
  const record = { sender: change.customer ? 'visitor@example.invalid' : OWNER, senderVerified: true, subject: 'Synthetic question', text: 'What is alphaScreen?', fingerprint: 'a'.repeat(64),
    threadKey: 'b'.repeat(64), messageKey: 'c'.repeat(64), gmailKey: 'd'.repeat(64), gmailId: 'abc', threadId: 'abc', rfcMessageId: '<test@example.invalid>' };
  const knowledge = { hash: 'e'.repeat(64), version: '2026-09-11.5' };
  const modules = {
    '../src/runtime-config': { loadRuntimeConfig() { events.push('config'); return off ? null : cfg; } },
    '../src/runtime-store': { createRuntimeStore: (_key,_deadline,_mode,profile) => { assert.equal(profile,cfg.profile); return ({ async call(op, _nonce, data) {
      events.push(op); writes.push({ op, data });
      if (change.errorOp === op) throw Error('PRIVATE DETAIL');
      if (op === 'acquire') return change.busy ? null : { nonce, cursor: change.seed ? null : '10', cutover_ms: Date.now()-10000, now_ms: Date.now()+(change.skew?6000:0), lease_ms: Date.now()+180000 };
      if (op === 'seen') return change.seen || null;
      if (op === 'claim') return change.duplicate ? null : claim;
      if (op === 'reserve') { state = 'reserved'; return true; }
      if (op === 'start') { state = 'submitting'; if (change.lostStart) throw Error('LOST'); if (change.prePostBudget) elapsed = 135000; return true; }
      if (op === 'cancel') { if (state === 'reserved') state = 'cancelled'; return state === 'cancelled'; }
      if (op === 'finish') { if (change.lostFinish) throw Error('LOST'); state = data.state; return true; }
      return true;
    } }); } },
    '../src/runtime-membership': { async recognizeRuntimeClient(_key,sender,_deadline,profile) { assert.equal(profile,cfg.profile); assert.equal(sender,record.sender); events.push('membership'); if (change.lookupError) throw Error(); return !!change.client; } },
    '../src/send-readonly-refresh': { async refreshSendReadonly() { events.push('readAuth'); return { mailbox: MAILBOX, accessToken: 'synthetic-read-token', expiresAt: Date.now()+3600000 }; } },
    '../src/send-oauth': { createSendOAuth: () => ({ async refresh() { events.push('sendAuth'); return { mailbox: MAILBOX, accessToken: 'synthetic-send-token', expiresAt: Date.now()+3600000 }; } }) },
    '../src/gmail-read': { ...require('../src/gmail-read'), async boundedJson(path) {
      events.push('read:'+path); if (path === 'profile') return { emailAddress: MAILBOX, historyId: '100' };
      return { id: 'abc', labelIds: change.sentLabel ? ['SENT'] : ['INBOX'] };
    }, decodeEnvelope(envelope, id) { if (id !== envelope.id || change.malformedEnvelope) throw Error('MALFORMED'); return Buffer.from('fixture'); } },
    '../src/raw-message': { headersAndBody: () => ({ headers: [], body: Buffer.from('fixture') }), one(_headers, name) {
      return ({ from: change.otherOwner ? 'other@example.invalid' : change.ambiguousFrom ? 'not an address' : change.postVerifyCustomer ? OWNER : record.sender, to: 'support@alphasourceai.com', 'delivered-to': MAILBOX, 'list-id': '<support.alphasourceai.com>' })[name];
    } },
    '../src/runtime-history': { async readHistory() { events.push('history'); if (change.historyError) throw Error('HISTORY'); return { ids: change.empty ? [] : ['abc'], next: '20' }; } },
    '../src/verified-gmail': { async readVerifiedInitial() {
      events.push('proof'); reads++;
      if (change.invalidProof || (change.invalidFresh && reads===2)) return { eligible: false, reason: 'unverified_group_delivery' };
      if (change.reply && reads===2) return { eligible: false, reason: 'not_initial_thread' };
      return { eligible: true };
    }, inspectVerified() { return { ...record, senderVerified: !(change.senderUnverified || (change.freshSenderUnverified && reads===2)) }; } },
    '../../src/lib/supportVoiceKnowledge': { readKnowledgeFiles: () => knowledge },
    '../../src/lib/supportEmailAdapters': { createXaiDraftGenerator: () => async request => {
      events.push('model'); assert.deepEqual(Object.keys(request).sort(), ['question','system']);
      assert.equal(request.system, change.client && !change.lookupError ? 'static-client' : 'static-public');
      if (change.offDuringModel) off = true;
      return { answer: change.invalidOutput ? 'password: private' : 'General static guidance.', human_review: !!change.modelReview };
    } },
    '../../src/lib/supportEmailPolicy': { ...require('../../src/lib/supportEmailPolicy'), buildEmailPrompt: a => ({ prompt: 'static-'+a, hash: knowledge.hash, version: knowledge.version }) },
    '../src/qa-mime': { buildQaMime: (sender,_body,profile) => { assert.equal(profile,cfg.profile); assert.equal(sender.sender,record.sender); return ({ raw: Buffer.from('wire fixture'), threadId:'abc',originalId:'abc' }); }, verifyQaSent() { events.push('sentCopy'); if (change.sentMismatch) throw Error('MISMATCH'); } },
  };
  const saved = new Map(), target = require.resolve('../src/runtime'), priorFetch = global.fetch;
  saved.set(target, require.cache[target]); delete require.cache[target];
  try {
    if (change.prePostBudget) Date.now = () => clockStart + elapsed;
    for (const [name,exports] of Object.entries(modules)) { const key = require.resolve(name); saved.set(key, require.cache[key]); require.cache[key] = { id:key, filename:key,loaded:true,exports }; }
    global.fetch = async (url, options) => {
      events.push('POST'); assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      assert.equal(options.headers.Authorization,'Bearer synthetic-send-token');
      if (change.lostPost) throw Error('PRIVATE TIMEOUT');
      return Response.json({ id:'def',threadId:'abc' });
    };
    let result, error;
    try { result = await require(target).runRuntime(); } catch (e) { error = e.message; }
    return { result,error,events,writes,state };
  } finally { Date.now = priorNow; global.fetch = priorFetch; for (const [key,value] of saved) { if(value) require.cache[key]=value; else delete require.cache[key]; } }
}
test('budget expiry after committed start but before fetch leaves submitting, not unknown', async()=>{
  const r = await harness({prePostBudget:true});
  assert.ok(r.error); assert.equal(r.state,'submitting');
  assert.ok(r.events.includes('start')); assert.ok(!r.events.includes('POST'));
  assert.ok(!r.events.includes('finish')); assert.ok(!r.events.includes('cancel')); assert.ok(!r.events.includes('complete'));
});
test('off has no secrets/provider/database work',async()=>{const r=await harness({off:true});assert.equal(r.result.status,'off');assert.deepEqual(r.events,['config']);});
for (const change of [{busy:true},{skew:true},{errorOp:'acquire'}]) test('lease loser/skew/failure does no Google/model/send',async()=>{
  const r=await harness(change);assert.ok(!r.events.includes('readAuth'));assert.ok(!r.events.includes('model'));assert.ok(!r.events.includes('complete'));
});
test('first seed occurs after lease/auth and makes no model/send',async()=>{const r=await harness({seed:true});assert.equal(r.result.status,'initialized_no_backfill');assert.ok(r.events.indexOf('acquire')<r.events.indexOf('readAuth'));assert.ok(r.events.includes('seed'));assert.ok(!r.events.includes('history'));});
for (const change of [{modelReview:true},{draftOnly:true}]) test('review/draft-only never reserves or opens sender',async()=>{
  const r=await harness(change);assert.equal(r.result.counts.draft,1);assert.ok(!r.events.includes('reserve'));assert.ok(!r.events.includes('sendAuth'));assert.ok(r.events.includes('complete'));
});
for (const productionMode of [undefined,'production-auto']) test('lookup error finishes bodyless human review with no model call or send',async()=>{
  const r=await harness({productionMode,customer:!!productionMode,lookupError:true});
  assert.equal(r.error,undefined); assert.equal(r.result.counts.review,1); assert.equal(r.result.counts.draft,0);
  for(const event of ['model','draft','sendAuth','reserve','POST']) assert.ok(!r.events.includes(event));
  assert.ok(r.events.includes('review')); assert.ok(r.events.includes('complete'));
});
for (const client of [false,true]) test('production-auto verified customer selects correct static audience and sends once',async()=>{
  const r=await harness({productionMode:'production-auto',customer:true,client});
  assert.equal(r.error,undefined);assert.equal(r.result.counts.sent,1);assert.equal(r.state,'accepted');
  assert.equal(r.events.filter(x=>x==='model').length,1);assert.equal(r.events.filter(x=>x==='POST').length,1);
  assert.ok(r.events.includes('complete'));
});
for(const productionMode of [undefined,'production-draft','production-canary']) test('QA/draft/canary exclude customers before membership or model',async()=>{
  const r=await harness({productionMode,customer:true,draftOnly:productionMode==='production-draft'});
  assert.equal(r.error,undefined);assert.equal(r.result.counts.skipped,1);
  for(const event of ['membership','model','claim','POST'])assert.ok(!r.events.includes(event));
});
for(const productionMode of [undefined,'production-draft','production-canary']) test('QA/draft/canary keep post-verify owner hard stop',async()=>{
  const r=await harness({productionMode,customer:true,postVerifyCustomer:true});
  assert.ok(r.error);for(const event of ['membership','model','claim','POST','complete'])assert.ok(!r.events.includes(event));
});
for (const change of [{client:true},{}]) test('static context send claims first, rereads, one POST, verified accepted then cursor',async()=>{
  const r=await harness(change);assert.equal(r.error,undefined);assert.equal(r.result.counts.sent,1);assert.equal(r.state,'accepted');
  assert.ok(r.events.indexOf('claim')<r.events.indexOf('model'));assert.equal(r.events.filter(x=>x==='POST').length,1);assert.equal(r.events.filter(x=>x==='proof').length,4);
  assert.ok(r.events.indexOf('start')<r.events.indexOf('POST'));assert.ok(r.events.indexOf('sentCopy')<r.events.indexOf('finish'));assert.ok(r.events.indexOf('finish')<r.events.indexOf('complete'));
});
for (const change of [{reply:true},{invalidOutput:true}]) test('visible human reply/invalid output finishes bodyless review no send',async()=>{
  const r=await harness(change);assert.equal(r.result.counts.review,1);assert.ok(r.events.includes('review'));assert.ok(!r.events.includes('reserve'));assert.ok(!r.events.includes('draft'));
});
for (const change of [{invalidProof:true},{senderUnverified:true},{ambiguousFrom:true},{malformedEnvelope:true},{historyError:true},{errorOp:'claim'},{errorOp:'draft'},{offDuringModel:true},{invalidFresh:true},{freshSenderUnverified:true}]) test('ambiguity holds cursor: '+Object.keys(change)[0],async()=>{
  const r=await harness(change);assert.ok(r.error);assert.ok(!r.events.includes('complete'));assert.ok(!r.events.includes('POST'));assert.ok(!r.events.includes('processed'));
});
for (const change of [{otherOwner:true},{sentLabel:true},{seen:'accepted_copy'},{duplicate:true}]) test('durable exclusion/duplicate never calls model',async()=>{
  const r=await harness(change);assert.equal(r.error,undefined);assert.ok(r.events.includes('processed'));assert.ok(!r.events.includes('model'));assert.ok(r.events.includes('complete'));
});
for (const change of [{lostStart:true},{lostPost:true},{sentMismatch:true},{lostFinish:true}]) test('unknown transport never retries/advances: '+Object.keys(change)[0],async()=>{
  const r=await harness(change);assert.ok(r.error);assert.ok(!r.events.includes('complete'));assert.ok(r.events.filter(x=>x==='POST').length<=1);
  assert.equal(r.state,change.lostPost||change.sentMismatch?'unknown':'submitting');if(change.lostStart)assert.ok(!r.events.includes('POST'));
});
