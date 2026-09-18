'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js');
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
};

const {
  buildSalesWonPayload,
  buildSlackSalesWonMessage,
  postSlackMessage,
  retryDelaySeconds
} = require('../src/lib/salesIntegrations');
const {
  createInternalSalesIntegrationsRouter,
  secretMatches
} = require('../routes/internalSalesIntegrations');

const DELIVERY_ID = '11111111-1111-4111-8111-111111111111';

function fakeSlackResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? options.retryAfter || null : null },
    async json() { return body; }
  };
}

async function invokeRouter(router, secret) {
  const handler = router.stack.find((layer) => layer.route?.path === '/process').route.stack[0].handle;
  const response = { statusCode: 200, body: null };
  const req = {
    request_id: 'req-test',
    get(name) { return String(name).toLowerCase() === 'x-cron-secret' ? secret : ''; }
  };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; }
  };
  await handler(req, res);
  return response;
}

test('sales-won Slack message is concise, financial, and safe for an internal channel', () => {
  const payload = buildSalesWonPayload({
    id: DELIVERY_ID,
    company_dba: 'Acme <!channel> & Dental',
    selected_plan_key: 'basic',
    selected_billing_cadence: 'annual',
    created_by_email: 'rep@alphasourceai.com',
    platform_fee_cents: 329900,
    promotion_discount_cents: 32990,
    initial_payment_cents: 362810,
    activated_at: '2026-09-18T21:30:00.000Z'
  }, { display_name: 'Michael Afesi' });
  const message = buildSlackSalesWonMessage(payload);
  const serialized = JSON.stringify(message);
  assert.match(message.text, /New alphaScreen membership activated/);
  assert.match(serialized, /Essential/);
  assert.match(serialized, /Michael Afesi/);
  assert.match(serialized, /\$3,628\.10/);
  assert.doesNotMatch(serialized, /<!channel>/);
  assert.match(serialized, /&lt;!channel&gt; &amp; Dental/);
  assert.doesNotMatch(serialized, /buyer_email|buyer_phone/i);
});

test('Slack delivery uses a bot token, fixed channel ID, and stable client message ID', async () => {
  let captured = null;
  const result = await postSlackMessage({
    id: DELIVERY_ID,
    payload: {
      purchase_intent_id: DELIVERY_ID,
      company_name: 'Acme Dental',
      membership: 'Pro',
      billing_cadence: 'Annual',
      sales_representative: 'Michael Afesi',
      platform_fee_cents: 649900,
      discount_cents: 0,
      initial_payment_cents: 656190,
      activated_at: '2026-09-18T21:30:00.000Z'
    }
  }, {
    env: {
      SLACK_SALES_WON_BOT_TOKEN: 'xoxb-test-token',
      SLACK_SALES_WON_CHANNEL_ID: 'C123SALES'
    },
    fetchImpl: async (url, request) => {
      captured = { url, request, body: JSON.parse(request.body) };
      return fakeSlackResponse({ ok: true, channel: 'C123SALES', ts: '123.456' });
    }
  });
  assert.equal(captured.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(captured.request.headers.Authorization, 'Bearer xoxb-test-token');
  assert.equal(captured.body.channel, 'C123SALES');
  assert.equal(captured.body.client_msg_id, DELIVERY_ID);
  assert.deepEqual(result, { external_message_id: '123.456', external_channel_id: 'C123SALES' });
});

test('Slack rate-limit response preserves retry timing without exposing credentials', async () => {
  await assert.rejects(
    postSlackMessage({ id: DELIVERY_ID, payload: {} }, {
      env: {
        SLACK_SALES_WON_BOT_TOKEN: 'xoxb-test-token',
        SLACK_SALES_WON_CHANNEL_ID: 'C123SALES'
      },
      fetchImpl: async () => fakeSlackResponse({ ok: false, error: 'ratelimited' }, {
        ok: false,
        status: 429,
        retryAfter: '45'
      })
    }),
    (error) => error.code === 'ratelimited' && error.retryable === true && error.retryAfterSeconds === 45
  );
  assert.equal(retryDelaySeconds(1, { retryAfterSeconds: 45 }), 45);
});

test('internal worker requires its dedicated secret and returns processor summary', async () => {
  assert.equal(secretMatches('runner-secret', 'runner-secret'), true);
  assert.equal(secretMatches('wrong', 'runner-secret'), false);
  assert.equal(secretMatches('', ''), false);

  const router = createInternalSalesIntegrationsRouter({
    db: {},
    env: { SALES_INTEGRATIONS_RUNNER_SECRET: 'runner-secret' },
    logger: { error() {} },
    processor: async () => ({ ok: true, delivered: 1 })
  });
  const denied = await invokeRouter(router, 'wrong');
  assert.equal(denied.statusCode, 401);
  const allowed = await invokeRouter(router, 'runner-secret');
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body, { ok: true, delivered: 1 });
});

test('sales integration migration provides a private idempotent SKIP LOCKED outbox', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260918214500_sales_integration_deliveries.sql'),
    'utf8'
  );
  assert.match(sql, /create table if not exists public\.sales_integration_deliveries/i);
  assert.match(sql, /create unique index if not exists sales_integration_deliveries_event_uidx/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /alter table public\.sales_integration_deliveries enable row level security/i);
  assert.match(sql, /revoke all on table public\.sales_integration_deliveries from anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_sales_integration_deliveries[\s\S]*to service_role/i);
});
