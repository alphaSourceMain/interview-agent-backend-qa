'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyGhlRouting, clearGhlRouting, syncGhl, verifySlack, verifyXai } = require('../src/lib/salesTeamProviderSync');

const env = {
  SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true',
  GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40),
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
  failRestore = false,
  mismatchFirstUserWrite = false,
  email = record.member.workspace_email,
  mobileValueName = record.phone.ghl_mobile_custom_value_name,
} = {}) {
  const state = {
    user: { id: 'ghl-user-1', email, phone: '+13035550000', active: true, roles: { locationIds: ['location-1'] } },
    values: {
      'mobile-value-1': { id: 'mobile-value-1', name: mobileValueName, value: '+13035550001' },
      'user-value-1': { id: 'user-value-1', name: 'alphaScreen Line 1 GHL User ID', value: 'old-user' },
    },
    writes: [], userWriteCount: 0,
  };
  const fetchImpl = async (url, options) => {
    const method = options.method;
    if (url.includes('slack.com')) return { ok: true, status: 200, json: async () => ({ ok: true, user: { id: 'U123456789', deleted: false } }) };
    if (url.endsWith('/users/ghl-user-1')) {
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ user: { ...state.user } }) };
      const body = JSON.parse(options.body);
      state.writes.push(['user', body.phone]);
      state.userWriteCount += 1;
      state.user.phone = body.phone;
      if (failRestore && body.phone === '+13035550000') return { ok: false, status: 503, json: async () => ({}) };
      if (mismatchFirstUserWrite && state.userWriteCount === 1) {
        return { ok: true, status: 200, json: async () => ({ user: { ...state.user, phone: '+13035559999' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { ...state.user } }) };
    }
    const id = url.split('/').pop();
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id] } }) };
    const body = JSON.parse(options.body);
    state.writes.push([id, body.value]);
    if (id === 'user-value-1' && failUserValueWrite && body.value === 'ghl-user-1') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    state.values[id] = { id, ...body };
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

test('GHL apply verifies the user and atomically updates mobile forwarding plus both line values', async () => {
  const { state, fetchImpl } = ghlFake();
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'synced');
  assert.equal(state.user.phone, '+17205551212');
  assert.equal(state.values['mobile-value-1'].value, '+17205551212');
  assert.equal(state.values['user-value-1'].value, 'ghl-user-1');
  assert.equal(result.previous.user.phone, '+13035550000');
});

test('GHL apply fails before writes when the GHL user email does not match Workspace', async () => {
  const { state, fetchImpl } = ghlFake({ email: 'different@alphasourceai.com' });
  const result = await syncGhl(record, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_user_verification_failed');
  assert.deepEqual(state.writes, []);
});

test('GHL apply restores user phone and managed values when a later write fails', async () => {
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
});

test('GHL apply restores the prior route when a successful write has an unconfirmed response', async () => {
  const { state, fetchImpl } = ghlFake({ mismatchFirstUserWrite: true });
  const result = await applyGhlRouting(record, {
    mobile: record.member.mobile_phone_e164,
    ghlUserId: record.member.ghl_user_id,
    workspaceEmail: record.member.workspace_email,
  }, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_user_phone_write_200');
  assert.equal(state.user.phone, '+13035550000');
  assert.equal(state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(state.values['user-value-1'].value, 'old-user');
});

test('GHL apply reports an explicit operator error when restoration cannot be confirmed', async () => {
  const { fetchImpl } = ghlFake({ mismatchFirstUserWrite: true, failRestore: true });
  const result = await applyGhlRouting(record, {
    mobile: record.member.mobile_phone_e164,
    ghlUserId: record.member.ghl_user_id,
    workspaceEmail: record.member.workspace_email,
  }, env, fetchImpl);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ghl_restore_failed');
});

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
});

test('provider checks fail closed until reusable line setup and all notification channels are ready', async () => {
  assert.equal((await verifyXai({ ...record, phone: { ...record.phone, xai_setup_status: 'pending' } })).status, 'action_required');
  assert.equal((await syncGhl({ ...record, phone: { ...record.phone, ghl_setup_status: 'pending' } }, env, async () => assert.fail('must not call GHL'))).status, 'action_required');
  assert.equal((await verifySlack({ ...record, config: { ...record.config, notify_slack: false } }, env, async () => assert.fail('must not call Slack'))).status, 'action_required');
  assert.equal((await syncGhl(record, { ...env, SALES_TEAM_PROVIDER_SYNC_ENABLED: 'false' }, async () => assert.fail('must not call GHL'))).status, 'action_required');
});

test('Grok readiness comes from the shared entrypoint instead of the selected GHL line', async () => {
  const pendingLine = { ...record.phone, xai_setup_status: 'pending', xai_agent_id: null, xai_phone_number_e164: null };
  const result = await verifyXai({ ...record, phone: pendingLine, shared_voice_phone: record.phone });
  assert.equal(result.status, 'synced');
  assert.equal(result.reference, 'agent_example');
});
