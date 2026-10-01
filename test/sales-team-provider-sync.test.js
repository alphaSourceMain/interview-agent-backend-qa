'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyGhlRouting, clearGhlRouting, restoreGhlRouting, syncGhl, verifySlack, verifyXai } = require('../src/lib/salesTeamProviderSync');

const env = {
  SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true',
  GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40),
  GHL_LOCATION_ID: 'location-1',
  SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 'x'.repeat(40),
};

const record = {
  member: {
    id: 'member-1',
    workspace_email: 'michael@alphasourceai.com',
    mobile_phone_e164: '+17205551212',
    ghl_user_id: 'ghl-user-1',
    slack_user_id: 'U123456789',
  },
  config: { notify_slack: true, notify_sms: true, notify_email: true },
  phone: {
    xai_agent_id: 'agent_example',
    xai_phone_number_e164: '+17205550001',
    handoff_token_rotated_at: '2026-09-21T00:00:00Z',
    xai_setup_status: 'verified',
    xai_verified_at: '2026-09-21T00:00:00Z',
    xai_verification_reference: 'qa-call-line-1',
    ghl_setup_status: 'verified',
    ghl_location_id: 'location-1',
    ghl_mobile_custom_value_id: 'mobile-value-1',
    ghl_mobile_custom_value_name: 'alphaScreen Line 1 Mobile',
    ghl_user_custom_value_id: 'user-value-1',
    ghl_user_custom_value_name: 'alphaScreen Line 1 GHL User ID',
  },
};

function ghlFake({
  failUserValueWrite = false,
  failMobileValueWrite = false,
  failRestore = false,
  mismatchFirstMobileWrite = false,
  email = record.member.workspace_email,
  roles = { type: 'account', role: 'user', locationIds: ['location-1'] },
  mobileValueName = record.phone.ghl_mobile_custom_value_name,
} = {}) {
  const state = {
    user: { id: 'ghl-user-1', email, phone: '+13035550000', active: true, roles },
    values: {
      'mobile-value-1': { id: 'mobile-value-1', name: mobileValueName, value: '+13035550001' },
      'user-value-1': { id: 'user-value-1', name: 'alphaScreen Line 1 GHL User ID', value: 'old-user' },
    },
    writes: [], userReads: 0, userWriteCount: 0, mobileWriteCount: 0,
  };
  const fetchImpl = async (url, options) => {
    const method = options.method;
    if (url.includes('slack.com')) return { ok: true, status: 200, json: async () => ({ ok: true, user: { id: 'U123456789', deleted: false } }) };
    if (url.endsWith('/users/ghl-user-1')) {
      if (method !== 'GET') { state.userWriteCount += 1; assert.fail('GHL user phone must never be written'); }
      state.userReads += 1;
      return { ok: true, status: 200, json: async () => ({ user: { ...state.user } }) };
    }
    const id = url.split('/').pop();
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id] } }) };
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['name', 'value']);
    state.writes.push([id, body.value]);
    if (id === 'mobile-value-1') state.mobileWriteCount += 1;
    if (id === 'mobile-value-1' && failMobileValueWrite && body.value === '+17205551212') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (id === 'user-value-1' && failUserValueWrite && body.value === 'ghl-user-1') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (failRestore && id === 'mobile-value-1' && body.value === '+13035550001') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    state.values[id] = { id, ...body };
    if (mismatchFirstMobileWrite && id === 'mobile-value-1' && state.mobileWriteCount === 1) {
      return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id], value: '+13035559999' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id] } }) };
  };
  return { state, fetchImpl };
}

test('Slack verification confirms the exact active member without sending a message', async () => {
  const { fetchImpl } = ghlFake();
  const result = await verifySlack(record, env, fetchImpl);
  assert.equal(result.status, 'synced');
  assert.equal(result.reference, 'U123456789');
});

test('GHL apply verifies the user and updates only SMS recipient and assigned-user values', async () => {
  const { state, fetchImpl } = ghlFake();
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'synced');
  assert.equal(state.userReads, 1);
  assert.equal(state.userWriteCount, 0);
  assert.equal(state.user.phone, '+13035550000');
  assert.equal(state.values['mobile-value-1'].value, '+17205551212');
  assert.equal(state.values['user-value-1'].value, 'ghl-user-1');
  assert.equal(result.previous.user.phone, '+13035550000');
  assert.deepEqual(state.writes, [['mobile-value-1', '+17205551212'], ['user-value-1', 'ghl-user-1']]);
});

test('repeated GHL apply never writes the user phone', async () => {
  const { state, fetchImpl } = ghlFake();
  assert.equal((await syncGhl(record, env, fetchImpl)).status, 'synced');
  assert.equal((await syncGhl(record, env, fetchImpl)).status, 'synced');
  assert.equal(state.userReads, 2);
  assert.equal(state.userWriteCount, 0);
  assert.equal(state.user.phone, '+13035550000');
});

test('GHL routing rejects a line in another location before any provider write', async () => {
  const { state, fetchImpl } = ghlFake();
  const result = await syncGhl({ ...record, phone: { ...record.phone, ghl_location_id: 'location-2' } }, env, fetchImpl);
  assert.equal(result.status, 'action_required');
  assert.equal(result.errorCode, 'ghl_sales_location_mismatch');
  assert.deepEqual(state.writes, []);
});

test('GHL apply fails before writes when the GHL user email does not match Workspace', async () => {
  const { state, fetchImpl } = ghlFake({ email: 'different@alphasourceai.com' });
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_user_verification_failed');
  assert.deepEqual(state.writes, []);
});

for (const [label, roles] of [
  ['Agency User', { type: 'agency', role: 'user', locationIds: ['location-1'] }],
  ['Account Admin', { type: 'account', role: 'admin', locationIds: ['location-1'] }],
  ['multiple locations', { type: 'account', role: 'user', locationIds: ['location-1', 'location-2'] }],
  ['missing role scope', null],
]) {
  test(`GHL routing rejects ${label} before any provider write`, async () => {
    const { state, fetchImpl } = ghlFake({ roles });
    const result = await syncGhl(record, env, fetchImpl);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'ghl_user_access_scope_invalid');
    assert.deepEqual(state.writes, []);
  });
}

test('GHL apply restores only managed values when a later write fails', async () => {
  const { state, fetchImpl } = ghlFake({ failUserValueWrite: true });
  const result = await applyGhlRouting(record, {
    mobile: record.member.mobile_phone_e164,
    ghlUserId: record.member.ghl_user_id,
    workspaceEmail: record.member.workspace_email,
  }, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(state.user.phone, '+13035550000');
  assert.equal(state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(state.values['user-value-1'].value, 'old-user');
  assert.equal(state.userWriteCount, 0);
});

test('GHL apply restores the prior route when a successful write has an unconfirmed response', async () => {
  const { state, fetchImpl } = ghlFake({ mismatchFirstMobileWrite: true });
  const result = await applyGhlRouting(record, {
    mobile: record.member.mobile_phone_e164,
    ghlUserId: record.member.ghl_user_id,
    workspaceEmail: record.member.workspace_email,
  }, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_custom_value_write_200');
  assert.equal(state.user.phone, '+13035550000');
  assert.equal(state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(state.values['user-value-1'].value, 'old-user');
  assert.equal(state.userWriteCount, 0);
});

test('GHL apply reports an explicit operator error when restoration cannot be confirmed', async () => {
  const { fetchImpl } = ghlFake({ mismatchFirstMobileWrite: true, failRestore: true });
  const result = await applyGhlRouting(record, {
    mobile: record.member.mobile_phone_e164,
    ghlUserId: record.member.ghl_user_id,
    workspaceEmail: record.member.workspace_email,
  }, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_restore_failed');
});

test('GHL apply failure on the first managed value leaves the assigned user unchanged', async () => {
  const { state, fetchImpl } = ghlFake({ failMobileValueWrite: true });
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(state.values['user-value-1'].value, 'old-user');
  assert.equal(state.userWriteCount, 0);
});

for (const previousPhone of ['+13035550000', '']) {
  test(`GHL restore ignores prior user phone ${previousPhone || '(empty)'}`, async () => {
    const { state, fetchImpl } = ghlFake();
    const result = await restoreGhlRouting({
      record,
      previous: {
        user: { id: 'ghl-user-1', phone: previousPhone },
        mobileValue: { id: 'mobile-value-1', name: record.phone.ghl_mobile_custom_value_name, value: '+13035550001' },
        userValue: { id: 'user-value-1', name: record.phone.ghl_user_custom_value_name, value: 'old-user' },
      },
    }, env, fetchImpl);
    assert.equal(result.status, 'synced');
    assert.equal(state.user.phone, '+13035550000');
    assert.equal(state.userWriteCount, 0);
    assert.deepEqual(state.writes.map(([id]) => id), ['user-value-1', 'mobile-value-1']);
  });
}

for (const mobile of ['', 'not-a-mobile']) {
  test(`GHL invalid SMS recipient ${mobile || '(missing)'} fails before provider write`, async () => {
    const { state, fetchImpl } = ghlFake();
    const result = await applyGhlRouting(record, {
      mobile, ghlUserId: record.member.ghl_user_id, workspaceEmail: record.member.workspace_email,
    }, env, fetchImpl);
    assert.equal(result.status, 'action_required');
    assert.deepEqual(state.writes, []);
    assert.equal(state.userWriteCount, 0);
  });
}

test('GHL apply refuses a renamed managed value before any provider write', async () => {
  const { state, fetchImpl } = ghlFake({ mobileValueName: 'Unexpected value name' });
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_custom_value_name_mismatch');
  assert.deepEqual(state.writes, []);
});

test('deactivation clears both line routing values without deleting or disabling the GHL user', async () => {
  const { state, fetchImpl } = ghlFake();
  const result = await clearGhlRouting(record, env, fetchImpl);
  assert.equal(result.status, 'synced');
  assert.equal(state.values['mobile-value-1'].value, '');
  assert.equal(state.values['user-value-1'].value, '');
  assert.equal(state.user.active, true);
  assert.equal(state.user.phone, '+13035550000');
  assert.equal(state.userWriteCount, 0);
});

test('provider checks fail closed until reusable line setup and all notification channels are ready', async () => {
  assert.equal((await verifyXai({ ...record, phone: { ...record.phone, xai_setup_status: 'pending' } })).status, 'action_required');
  assert.equal((await syncGhl({ ...record, phone: { ...record.phone, ghl_setup_status: 'pending' } }, env, async () => assert.fail('must not call GHL'))).status, 'action_required');
  assert.equal((await verifySlack({ ...record, config: { ...record.config, notify_slack: false } }, env, async () => assert.fail('must not call Slack'))).status, 'action_required');
  assert.equal((await syncGhl(record, { ...env, SALES_TEAM_PROVIDER_SYNC_ENABLED: 'false' }, async () => assert.fail('must not call GHL'))).status, 'action_required');
});

test('only the pinned QA member on line 3 can stage pending GHL values; Grok remains unverified', async () => {
  const qaMemberId = '4be26cba-e80a-4913-951c-b9aa21273712';
  const stagedRecord = {
    ...record,
    member: { ...record.member, id: qaMemberId },
    phone: { ...record.phone, id: '21000000-0000-4000-8000-000000000003', shared_voice_entrypoint: false, ghl_setup_status: 'pending' },
    shared_voice_phone: { ...record.phone, id: '21000000-0000-4000-8000-000000000004', shared_voice_entrypoint: true, xai_setup_status: 'pending' },
  };
  const stagedEnv = {
    ...env, APP_ENV: 'qa', SALES_TEAM_QA_STAGED_MEMBER_ID: qaMemberId,
    SALES_TEAM_QA_STAGED_PHONE_ID: stagedRecord.phone.id,
  };
  const { state, fetchImpl } = ghlFake();
  assert.equal((await verifyXai(stagedRecord)).status, 'action_required');
  assert.equal((await syncGhl(stagedRecord, stagedEnv, fetchImpl)).status, 'synced');
  assert.equal(state.values['mobile-value-1'].value, record.member.mobile_phone_e164);
  assert.equal((await clearGhlRouting(stagedRecord, stagedEnv, fetchImpl)).status, 'synced');
  assert.equal(state.values['mobile-value-1'].value, '');
  assert.equal(state.values['user-value-1'].value, '');
  for (const unsafeEnv of [
    { ...stagedEnv, APP_ENV: 'production' },
    { ...stagedEnv, SALES_TEAM_QA_STAGED_MEMBER_ID: 'another-member' },
    { ...stagedEnv, SALES_TEAM_QA_STAGED_PHONE_ID: '21000000-0000-4000-8000-000000000004' },
  ]) {
    const guarded = await syncGhl(stagedRecord, unsafeEnv, async () => assert.fail('must not call GHL'));
    assert.equal(guarded.errorCode, 'ghl_line_setup_unverified');
  }
});

test('Grok readiness comes from the shared entrypoint instead of the selected GHL line', async () => {
  const pendingLine = { ...record.phone, xai_setup_status: 'pending', xai_agent_id: null, xai_phone_number_e164: null };
  const result = await verifyXai({ ...record, phone: pendingLine, shared_voice_phone: record.phone });
  assert.equal(result.status, 'synced');
  assert.equal(result.reference, 'agent_example');
});
