'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setGhlMobile, syncGhl, verifySlack, verifyXai } = require('../src/lib/salesTeamProviderSync');

const record = {
  member: { id: 'member-1', mobile_phone_e164: '+17205551212', slack_user_id: 'U123456789' },
  config: { notify_slack: true },
  phone: {
    xai_agent_id: 'agent_example',
    xai_phone_number_e164: '+17205550001',
    handoff_token_rotated_at: '2026-09-21T00:00:00Z',
    xai_setup_status: 'verified',
    xai_verified_at: '2026-09-21T00:00:00Z',
    xai_verification_reference: 'qa-call-line-1',
    ghl_setup_status: 'verified',
    ghl_location_id: 'location-1',
    ghl_mobile_custom_value_id: 'custom-value-1',
    ghl_mobile_custom_value_name: 'alphaScreen Line 1 Mobile',
  },
};

test('Slack verification confirms the exact active member without sending a message', async () => {
  let call;
  const result = await verifySlack(record, { SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true', SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 'x'.repeat(40) }, async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true, user: { id: 'U123456789', deleted: false } }) };
  });
  assert.equal(result.status, 'synced');
  assert.match(call.url, /users\.info\?user=U123456789$/);
  assert.equal(call.options.method, 'GET');
});

test('GHL synchronization updates only the managed mobile custom value', async () => {
  let call;
  const result = await syncGhl(record, { SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true', GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40) }, async (url, options) => {
    call = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ customValue: { id: 'custom-value-1', name: 'alphaScreen Line 1 Mobile', value: '+17205551212' } }) };
  });
  assert.equal(result.status, 'synced');
  assert.equal(call.options.method, 'PUT');
  assert.equal(call.options.headers.Version, 'v3');
  assert.deepEqual(call.body, { name: 'alphaScreen Line 1 Mobile', value: '+17205551212' });
  assert.doesNotMatch(JSON.stringify(call), /slack_user_id|workspace_email|ghl_user_id/);
});

test('provider checks fail closed when reusable line setup is not verified', async () => {
  assert.equal((await verifyXai({ ...record, phone: { ...record.phone, xai_setup_status: 'pending' } })).status, 'action_required');
  assert.equal((await syncGhl({ ...record, phone: { ...record.phone, ghl_setup_status: 'pending' } }, {}, async () => assert.fail('must not call GHL'))).status, 'action_required');
  assert.equal((await verifySlack({ ...record, member: { ...record.member, slack_user_id: '' } }, {}, async () => assert.fail('must not call Slack'))).status, 'action_required');
});

test('live Slack and GHL calls stay off behind the provider-sync flag', async () => {
  assert.equal((await verifySlack(record, { SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 'x'.repeat(40) }, async () => assert.fail('must not call Slack'))).status, 'action_required');
  assert.equal((await syncGhl(record, { GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40) }, async () => assert.fail('must not call GHL'))).status, 'action_required');
  assert.equal((await verifySlack({ ...record, config: { notify_slack: false } }, {}, async () => assert.fail('must not call Slack'))).status, 'not_applicable');
});

test('deactivation can clear the managed GHL mobile without changing line infrastructure', async () => {
  let body;
  const result = await setGhlMobile(record, '', { SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true', GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40) }, async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ customValue: { id: 'custom-value-1', name: 'alphaScreen Line 1 Mobile', value: '' } }) };
  });
  assert.equal(result.status, 'synced');
  assert.deepEqual(body, { name: 'alphaScreen Line 1 Mobile', value: '' });
});
