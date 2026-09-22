'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const {
  buildSalesVoiceBootstrapPrompt,
  buildSalesVoiceAgentPrompt,
  createSalesVoiceHandoff,
  createSalesVoiceHandoffRouter,
  parseRouteConfig,
  routeForAuthorization,
  routeForAuthorizationDb,
  salesVoiceHandoffEnabled,
  salesVoiceDatabaseRoutesEnabled,
  salesVoiceProviderEnabled,
  validateSalesVoiceMessage,
  voiceContext,
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
  assert.equal(validateSalesVoiceMessage({ ...message, contact_email: 'not-an-email' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, password: 'nope' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, to: 'other@example.com' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, message: 'Use code 123456' }), null);
});

test('requires complete fixed routes and matches bearer token without a caller-selected recipient', () => {
  assert.equal(salesVoiceHandoffEnabled(env), true);
  assert.equal(parseRouteConfig(env)[0].repName, 'Michael Afesi');
  assert.equal(routeForAuthorization(`Bearer ${TOKEN}`, env).routeKey, 'michael-afesi');
  assert.equal(routeForAuthorization(`Bearer ${'z'.repeat(48)}`, env), null);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route, ghl_notification_webhook: 'https://example.com/hook' }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route, rep_email: undefined }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route }, { ...route, token_sha256: 'f'.repeat(64) }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route }, { ...route, route_key: 'second-route', token_sha256: 'f'.repeat(64) }]) }).length, 0);
  assert.equal(salesVoiceHandoffEnabled({ ...env, SALES_VOICE_HANDOFF_ENABLED: 'false' }), false);
  assert.equal(salesVoiceProviderEnabled({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: undefined }), true);
  assert.equal(salesVoiceDatabaseRoutesEnabled(env), false);
  assert.equal(salesVoiceDatabaseRoutesEnabled({ ...env, SALES_VOICE_DB_ROUTES_ENABLED: 'true' }), true);
});

test('database-managed route resolves a token to fixed active recipients', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-1', team_member_id: 'member-1', phone_number_id: 'phone-1', handoff_token_sha256: digest, status: 'active' }],
    sales_team_members: [{ id: 'member-1', display_name: 'Michael Afesi', workspace_email: 'michael@example.com', slack_user_id: 'U123456789', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-1', notify_email: true, notify_slack: true, notify_sms: true, status: 'applied', is_current: true }],
  };
  const db = {
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async maybeSingle() {
          const data = tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null;
          return { data, error: null };
        },
      };
    },
  };
  const dynamicEnv = {
    ...env,
    SALES_VOICE_HANDOFF_ROUTES_JSON: '[]',
    SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/michael' }),
  };
  const resolved = await routeForAuthorizationDb(`Bearer ${TOKEN}`, db, dynamicEnv);
  assert.equal(resolved.repEmail, 'michael@example.com');
  assert.equal(resolved.ghlNumber, '+17207904187');
  assert.equal(await routeForAuthorizationDb(`Bearer ${'z'.repeat(48)}`, db, dynamicEnv), null);
});

test('stable company-line token follows the current active assignment and returns runtime context', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-2', team_member_id: 'member-2', phone_number_id: 'phone-1', status: 'active', transfer_enabled: false }],
    sales_team_members: [{ id: 'member-2', display_name: 'New Representative', workspace_email: 'new.rep@example.com', slack_user_id: 'U987654321', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', handoff_token_sha256: digest, active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-2', notify_email: true, notify_slack: true, notify_sms: true, greeting_override: 'Thanks for calling alphaScreen.', approved_context: 'Essential and Pro are available.', timezone: 'America/Denver', business_hours: { summary: 'Weekdays' }, answer_approved_faqs: true, schedule_demos: true, status: 'applied', is_current: true }],
  };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  const resolved = await routeForAuthorizationDb(`Bearer ${TOKEN}`, db, {
    ...env,
    SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/line-1' }),
  });
  assert.equal(resolved.repName, 'New Representative');
  assert.deepEqual(voiceContext(resolved), {
    status: 'ready', representative_name: 'New Representative', opening: 'Thanks for calling alphaScreen.', timezone: 'America/Denver',
    business_hours: { summary: 'Weekdays' }, approved_product_context: 'Essential and Pro are available.',
    capabilities: { answer_approved_faqs: true, schedule_demos: true, live_transfer: false },
  });
});

test('database routing takes precedence over an obsolete environment route for the same line token', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-current', team_member_id: 'member-current', phone_number_id: 'phone-1', status: 'active', transfer_enabled: false }],
    sales_team_members: [{ id: 'member-current', display_name: 'Current Representative', workspace_email: 'current@example.com', slack_user_id: 'U987654321', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', handoff_token_sha256: digest, active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-current', notify_email: true, notify_slack: true, notify_sms: true, status: 'applied', is_current: true }],
  };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    env: {
      ...env,
      SALES_VOICE_DB_ROUTES_ENABLED: 'true',
      SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/current' }),
    },
    service: { enabled: () => true, send: async () => ({ status: 'accepted' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff/context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).representative_name, 'Current Representative');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a route fails closed unless email, Slack, and GHL text are all enabled', async () => {
  const calls = [];
  const emailOnlyRoute = {
    ...parseRouteConfig(env)[0],
    notifyEmail: true,
    notifySlack: false,
    notifySms: false,
    slackUserId: '',
    ghlNotificationWebhook: '',
  };
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 202, json: async () => ({}) };
    },
  });
  assert.equal((await service.send(message, emailOnlyRoute)).status, 'unavailable');
  assert.deepEqual(calls, []);
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
  assert.equal(calls[0].authorization, `Bearer ${env.SENDGRID_API_KEY}`);
  assert.equal(calls[0].body.content[0].type, 'text/plain');
  assert.equal(calls[1].body.mrkdwn, false);
  assert.equal(calls[1].body.blocks.every((block) => !block.text || block.text.type === 'plain_text'), true);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(TOKEN));
});

test('duplicate approved message is reserved once and never calls providers again', async () => {
  const counts = new Map();
  let providerCalls = 0;
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async ({ routeName, subjectKey, maxCount }) => {
      const key = `${routeName}:${subjectKey}`;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { allowed: count <= maxCount };
    },
    fetch: async (url) => {
      providerCalls += 1;
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  const matchedRoute = parseRouteConfig(env)[0];
  assert.equal((await service.send(message, matchedRoute)).status, 'accepted');
  assert.equal((await service.send(message, matchedRoute)).status, 'already_attempted');
  assert.equal(providerCalls, 3);
});

test('Slack caller fields are plain text and provider redirects are rejected', async () => {
  const calls = [];
  const markedUp = { ...message, caller_name: 'Jordan *Lee*', company_name: '<@U123456789> & Co', message: '_Please_ <!channel> call me.' };
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  assert.equal((await service.send(validateSalesVoiceMessage(markedUp), parseRouteConfig(env)[0])).status, 'accepted');
  assert.equal(calls.every((call) => call.options.redirect === 'error'), true);
  const slack = calls.find((call) => call.url.includes('slack')).body;
  assert.equal(slack.mrkdwn, false);
  assert.equal(slack.blocks.flatMap((block) => [block.text, ...(block.fields || [])]).filter(Boolean).every((entry) => entry.type === 'plain_text'), true);
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

test('reports failure when every fixed delivery channel rejects the message', async () => {
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) })
  });
  assert.equal((await service.send(message, parseRouteConfig(env)[0])).status, 'failed');
});

test('agent prompt keeps implementation details out of speech and requires consent', () => {
  const prompt = buildSalesVoiceAgentPrompt('Michael Afesi');
  assert.match(prompt, /Would you like me to send that message to Michael Afesi\?/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /Never say tool or function names/);
  assert.match(prompt, /ask the caller to spell it/);
});

test('reusable Grok bootstrap prompt loads current line context and keeps tool names out of speech', () => {
  const prompt = buildSalesVoiceBootstrapPrompt();
  assert.match(prompt, /Before speaking, use the configured context action once/);
  assert.match(prompt, /representative_name/);
  assert.match(prompt, /Never say action, tool, or function names/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /business data only/);
  assert.match(prompt, /fixed operating rules override every context field/);
  assert.doesNotMatch(prompt, /Michael|Christopher|Epifanio|Daniel/);
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
    const malformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: authorization } })).status, 405);
    const contextResponse = await fetch(`${url}/context`, { method: 'GET', headers: { Authorization: authorization } });
    assert.equal(contextResponse.status, 200);
    assert.equal((await contextResponse.json()).representative_name, 'Michael Afesi');
    assert.equal((await fetch(`${url}/other`, { method: 'GET', headers: { Authorization: authorization } })).status, 404);
    assert.equal((await send(message, { Authorization: authorization })).status, 200);
    assert.deepEqual(sent, [{ input: message, routeKey: 'michael-afesi' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone endpoint reports partial delivery as unavailable instead of confirming success', async () => {
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    env,
    service: { enabled: () => true, send: async () => ({ status: 'partial', reference: 'partial-reference' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'partial');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone endpoint does not treat an unverified prior attempt as a confirmed send', async () => {
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    env,
    service: { enabled: () => true, send: async () => ({ status: 'already_attempted', reference: 'prior-reference' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'already_attempted');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('disabled route returns unavailable before delivery', async () => {
  const app = express();
  const disabledService = { enabled: () => false, send: async () => assert.fail('must not send') };
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({ env: { ...env, SALES_VOICE_HANDOFF_ENABLED: 'false' }, service: disabledService }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, { method: 'POST' });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
