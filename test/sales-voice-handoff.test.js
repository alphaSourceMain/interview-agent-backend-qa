'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const {
  buildSalesVoiceAgentPrompt,
  createSalesVoiceHandoff,
  createSalesVoiceHandoffRouter,
  parseRouteConfig,
  routeForAuthorization,
  salesVoiceHandoffEnabled,
  validateSalesVoiceMessage
} = require('../src/lib/salesVoiceHandoff');

const TOKEN = 'm'.repeat(48);
const route = {
  route_key: 'michael-afesi',
  token_sha256: crypto.createHash('sha256').update(TOKEN).digest('hex'),
  rep_name: 'Michael Afesi',
  rep_email: 'michael@example.com',
  slack_user_id: 'U123456789',
  ghl_number: '+17207904187',
  ghl_notification_webhook: 'https://services.leadconnectorhq.com/hooks/example'
};
const env = {
  SALES_VOICE_HANDOFF_ENABLED: 'true',
  SALES_VOICE_FROM_EMAIL: 'sales-agent@alphasourceai.com',
  SENDGRID_API_KEY: 'SG.' + 'a'.repeat(40),
  SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 'b'.repeat(40),
  SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([route])
};
const message = {
  caller_name: 'Jordan Lee',
  company_name: 'Northstar Dental',
  callback_phone: '+17205551212',
  contact_email: 'jordan@example.com',
  message: 'Please call me about an alphaScreen Pro membership.',
  confirmed: true
};

test('validates exact caller-approved fields', () => {
  assert.deepEqual(validateSalesVoiceMessage(message), message);
  assert.equal(validateSalesVoiceMessage({ ...message, confirmed: false }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, callback_phone: '720-555-1212' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, password: 'nope' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, message: 'Use code 123456' }), null);
});

test('requires complete fixed routes and matches bearer token without a caller-selected recipient', () => {
  assert.equal(salesVoiceHandoffEnabled(env), true);
  assert.equal(parseRouteConfig(env)[0].repName, 'Michael Afesi');
  assert.equal(routeForAuthorization(`Bearer ${TOKEN}`, env).routeKey, 'michael-afesi');
  assert.equal(routeForAuthorization(`Bearer ${'z'.repeat(48)}`, env), null);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route, ghl_notification_webhook: 'https://example.com/hook' }]) }).length, 0);
});

test('fans an approved message out to fixed email, Slack DM, and GHL workflow', async () => {
  const calls = [];
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization || '' });
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ received: true }) };
    }
  });
  const result = await service.send(message, parseRouteConfig(env)[0]);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.personalizations[0].to[0].email, 'michael@example.com');
  assert.equal(calls[0].body.reply_to.email, 'jordan@example.com');
  assert.match(calls[0].body.content[0].value, /Hi Michael,/);
  assert.equal(calls[1].body.channel, 'U123456789');
  assert.equal(calls[2].body.representative, 'Michael Afesi');
  assert.equal(calls[2].body.assigned_number, '+17207904187');
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(TOKEN));
});

test('reports partial success without retrying accepted channels', async () => {
  let count = 0;
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      count += 1;
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({ ok: false }) };
    }
  });
  const result = await service.send(message, parseRouteConfig(env)[0]);
  assert.equal(result.status, 'partial');
  assert.equal(count, 3);
});

test('agent prompt keeps implementation details out of speech and requires consent', () => {
  const prompt = buildSalesVoiceAgentPrompt('Michael Afesi');
  assert.match(prompt, /Would you like me to send that message to Michael Afesi\?/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /Never say tool or function names/);
  assert.match(prompt, /ask the caller to spell it/);
});

test('phone endpoint identifies a fixed route from its token and rejects browser or malformed requests', async () => {
  const sent = [];
  const service = {
    enabled: () => true,
    send: async (input, matchedRoute) => {
      sent.push({ input, routeKey: matchedRoute.routeKey });
      return { status: 'accepted', reference: 'test-reference' };
    }
  };
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({ env, service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/voice-handoff`;
    const send = (body, headers = {}) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const authorization = `Bearer ${TOKEN}`;
    assert.equal((await send(message)).status, 401);
    assert.equal((await send(message, { Authorization: authorization, Origin: 'https://evil.example' })).status, 401);
    assert.equal((await send({ ...message, confirmed: false }, { Authorization: authorization })).status, 400);
    assert.equal((await send(message, { Authorization: authorization })).status, 200);
    assert.deepEqual(sent, [{ input: message, routeKey: 'michael-afesi' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
