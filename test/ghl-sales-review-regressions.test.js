'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js');
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} },
};

const {
  markGhlOpportunityWon,
  upsertGhlBinding,
} = require('../src/lib/ghlSalesIntegration');
const {
  createGhlSalesWebhookRouter,
  reserveReceipt,
  webhookIdentifiers,
} = require('../routes/ghlSalesWebhook');
const {
  processGhlSalesWonDelivery,
  reconcileSalesWonDeliveries,
} = require('../src/lib/salesIntegrations');
const { resetFailedGhlDelivery } = require('../routes/adminSalesTeam');

const INTENT_ID = '11111111-1111-4111-8111-111111111111';
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222';
const REP_ID = '33333333-3333-4333-8333-333333333333';

class MemoryQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.mutation = null;
    this.orderField = null;
    this.ascending = true;
    this.limitCount = null;
  }

  select() { return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  is(column, value) { this.filters.push((row) => value === null ? row[column] == null : row[column] === value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  not(column, operator, value) {
    if (operator !== 'is') throw new Error(`unsupported not operator ${operator}`);
    this.filters.push((row) => value === null ? row[column] != null : row[column] !== value);
    return this;
  }
  order(column, options = {}) { this.orderField = column; this.ascending = options.ascending === true; return this; }
  limit(value) { this.limitCount = Number(value); return this; }
  insert(value) { this.mutation = { type: 'insert', value: { ...value } }; return this; }
  update(value) { this.mutation = { type: 'update', value: { ...value } }; return this; }

  rows() {
    let rows = (this.db.tables[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orderField) {
      rows = [...rows].sort((left, right) => String(left[this.orderField] || '').localeCompare(String(right[this.orderField] || '')) * (this.ascending ? 1 : -1));
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  duplicateFor(row) {
    const rows = this.db.tables[this.table] || [];
    if (this.table === 'ghl_sales_webhook_receipts') return rows.some((item) => item.event_key === row.event_key);
    if (this.table === 'ghl_sales_sync_events') return rows.some((item) => item.idempotency_key === row.idempotency_key);
    if (this.table === 'sales_integration_deliveries') {
      return rows.some((item) => item.integration === row.integration && item.event_type === row.event_type && item.event_key === row.event_key);
    }
    return false;
  }

  execute(single) {
    if (this.mutation?.type === 'insert') {
      const row = { id: crypto.randomUUID(), ...this.mutation.value };
      if (this.duplicateFor(row)) return { data: null, error: { code: '23505', message: 'duplicate' } };
      this.db.tables[this.table] ||= [];
      this.db.tables[this.table].push(row);
      return { data: single ? { ...row } : [{ ...row }], error: null };
    }
    if (this.mutation?.type === 'update') {
      const hook = this.db.updateHooks[this.table];
      if (hook) {
        delete this.db.updateHooks[this.table];
        hook(this);
      }
      const rows = this.rows();
      for (const row of rows) Object.assign(row, this.mutation.value);
      return { data: single ? (rows[0] ? { ...rows[0] } : null) : rows.map((row) => ({ ...row })), error: null };
    }
    const rows = this.rows();
    return { data: single ? (rows[0] ? { ...rows[0] } : null) : rows.map((row) => ({ ...row })), error: null };
  }

  maybeSingle() { return Promise.resolve(this.execute(true)); }
  single() { return Promise.resolve(this.execute(true)); }
  then(resolve, reject) {
    try { resolve(this.execute(false)); } catch (error) { reject(error); }
  }
}

class MemoryDb {
  constructor(tables = {}) {
    this.tables = tables;
    this.updateHooks = {};
  }

  from(table) {
    this.tables[table] ||= [];
    return new MemoryQuery(this, table);
  }

  async rpc(name, args) {
    if (name === 'list_missing_ghl_sales_won_intents') {
      const existing = new Set(this.tables.sales_integration_deliveries
        .filter((row) => row.integration === 'ghl' && row.event_type === 'sales_won')
        .map((row) => row.purchase_intent_id));
      const data = this.tables.public_purchase_intents
        .filter((row) => row.channel === 'sales_assisted' && row.status === 'completed' && row.activated_at && row.ghl_opportunity_id && !existing.has(row.id))
        .sort((left, right) => left.activated_at.localeCompare(right.activated_at))
        .slice(0, args.p_limit)
        .map((row) => ({ id: row.id }));
      return { data, error: null };
    }
    if (name === 'claim_sales_integration_deliveries') {
      const rows = this.tables.sales_integration_deliveries.filter((row) =>
        row.integration === args.p_integration &&
        ['pending', 'retry'].includes(row.status) &&
        row.attempt_count < row.max_attempts
      ).slice(0, args.p_limit);
      for (const row of rows) {
        row.status = 'processing';
        row.attempt_count += 1;
        row.lock_token = args.p_lock_token;
        row.locked_at = args.p_now;
      }
      return { data: rows.map((row) => ({ ...row })), error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  }
}

function invokeWebhook(router, rawBody, headers) {
  const route = router.stack.find((layer) => layer.route?.path === '/sales-ready');
  const handler = route.route.stack[route.route.stack.length - 1].handle;
  const outcome = { statusCode: 200, body: null };
  const req = {
    body: rawBody,
    headers,
    request_id: 'review-regression',
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
  const res = {
    status(code) { outcome.statusCode = code; return this; },
    json(body) { outcome.body = body; return body; },
  };
  return Promise.resolve(handler(req, res)).then(() => outcome);
}

test('fresh processing webhook receipts return 503 and stale receipts are reclaimed for one import', async () => {
  const rawBody = Buffer.from(JSON.stringify({ opportunityId: 'opp_qa', locationId: 'location_qa', eventId: 'evt_qa' }));
  const identifiers = webhookIdentifiers(JSON.parse(rawBody.toString('utf8')), {});
  const values = { ...identifiers, bodyDigest: crypto.createHash('sha256').update(rawBody).digest('hex') };
  const headers = { authorization: 'Bearer webhook-secret' };
  const env = { GHL_SALES_WEBHOOK_SECRET: 'webhook-secret', GHL_LOCATION_ID: 'location_qa' };

  const freshDb = new MemoryDb({ ghl_sales_webhook_receipts: [], ghl_sales_sync_events: [] });
  await reserveReceipt(freshDb, values); // Simulate a process stopping immediately after durable reservation.
  freshDb.tables.ghl_sales_webhook_receipts[0].attempt_count = 1;
  freshDb.tables.ghl_sales_webhook_receipts[0].first_received_at = new Date().toISOString();
  freshDb.tables.ghl_sales_webhook_receipts[0].last_received_at = new Date().toISOString();
  let freshImports = 0;
  const freshRouter = createGhlSalesWebhookRouter({
    db: freshDb,
    env,
    logger: { warn() {} },
    importer: async () => { freshImports += 1; return { binding: { id: 'binding_fresh', status: 'ready' }, created: true }; },
  });
  const freshResult = await invokeWebhook(freshRouter, rawBody, headers);
  assert.equal(freshResult.statusCode, 503);
  assert.deepEqual(freshResult.body, { error: 'ghl_receipt_processing', replayed: true });
  assert.equal(freshImports, 0);

  freshDb.tables.ghl_sales_webhook_receipts[0].last_received_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const staleResult = await invokeWebhook(freshRouter, rawBody, headers);
  assert.equal(staleResult.statusCode, 201);
  assert.equal(freshImports, 1);
  assert.equal(freshDb.tables.ghl_sales_webhook_receipts[0].status, 'completed');
  assert.equal(freshDb.tables.ghl_sales_webhook_receipts[0].attempt_count, 2);
});

test('admin retry resets an exhausted GHL delivery so the claim predicate can take it again', async () => {
  const db = new MemoryDb({
    sales_integration_deliveries: [{
      id: DELIVERY_ID,
      purchase_intent_id: INTENT_ID,
      integration: 'ghl',
      event_type: 'sales_won',
      event_key: `ghl_sales_won:${INTENT_ID}`,
      status: 'failed',
      attempt_count: 8,
      max_attempts: 8,
      locked_at: '2026-09-22T00:00:00.000Z',
      lock_token: crypto.randomUUID(),
    }],
    ghl_sales_deal_bindings: [{ id: 'binding_qa', purchase_intent_id: INTENT_ID, status: 'exception' }],
  });
  await resetFailedGhlDelivery(db, db.tables.sales_integration_deliveries[0]);
  assert.equal(db.tables.sales_integration_deliveries[0].attempt_count, 0);
  assert.equal(db.tables.sales_integration_deliveries[0].status, 'retry');
  assert.equal(db.tables.sales_integration_deliveries[0].lock_token, null);

  const claimed = await db.rpc('claim_sales_integration_deliveries', {
    p_limit: 10,
    p_lock_token: crypto.randomUUID(),
    p_now: new Date().toISOString(),
    p_integration: 'ghl',
  });
  assert.equal(claimed.data.length, 1);
  assert.equal(claimed.data[0].attempt_count, 1);
  assert.equal(claimed.data[0].status, 'processing');
});

test('Won retry re-runs signed-and-paid predicates before any provider write', async () => {
  let providerCalls = 0;
  const db = new MemoryDb({
    public_purchase_intents: [{
      id: INTENT_ID,
      status: 'completed',
      channel: 'sales_assisted',
      activated_at: '2026-09-22T12:00:00.000Z',
      client_id: 'client_qa',
      agreement_id: 'agreement_qa',
      ghl_contact_id: 'contact_qa',
      ghl_opportunity_id: 'opp_qa',
    }],
    clients: [{ id: 'client_qa', billing_status: 'active', subscription_status: 'active' }],
    membership_agreements: [{ id: 'agreement_qa', status: 'signed', checkout_status: 'pending_payment', checkout_paid_at: null }],
    ghl_sales_deal_bindings: [{
      id: 'binding_qa', purchase_intent_id: INTENT_ID, opportunity_id: 'opp_qa', contact_id: 'contact_qa',
      location_id: 'location_qa', pipeline_id: 'pipeline_qa', ready_stage_id: 'ready_qa',
      provider_owner_user_id: 'owner_qa', status: 'exception', manual_review_required: false,
    }],
  });
  await assert.rejects(
    processGhlSalesWonDelivery(db, {
      id: DELIVERY_ID,
      purchase_intent_id: INTENT_ID,
      payload: { binding_id: 'binding_qa' },
      attempt_count: 1,
    }, {
      env: {},
      fetchImpl: async () => { providerCalls += 1; throw new Error('provider must not be called'); },
    }),
    (error) => error.code === 'ghl_agreement_not_signed_and_paid'
  );
  assert.equal(providerCalls, 0);
});

test('GHL reconciliation skips 100 existing deliveries and enqueues the newer missing sale', async () => {
  const intents = Array.from({ length: 101 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    status: 'completed',
    channel: 'sales_assisted',
    activated_at: new Date(Date.UTC(2026, 8, 20, 0, index)).toISOString(),
    client_id: `client_${index}`,
    agreement_id: `agreement_${index}`,
    ghl_contact_id: `contact_${index}`,
    ghl_opportunity_id: `opportunity_${index}`,
    sales_won_enqueued_at: '2026-09-22T00:00:00.000Z',
    sales_rep_slack_enqueued_at: '2026-09-22T00:00:00.000Z',
  }));
  const missing = intents[100];
  const existingDeliveries = intents.slice(0, 100).map((intent, index) => ({
    id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    integration: 'ghl',
    event_type: 'sales_won',
    event_key: `ghl_sales_won:${intent.id}`,
    purchase_intent_id: intent.id,
    status: 'delivered',
  }));
  const db = new MemoryDb({
    public_purchase_intents: intents,
    sales_integration_deliveries: existingDeliveries,
    sales_reps: [],
    clients: [{ id: missing.client_id, billing_status: 'active', subscription_status: 'active' }],
    membership_agreements: [{ id: missing.agreement_id, status: 'signed', checkout_status: 'paid', checkout_paid_at: '2026-09-22T12:00:00.000Z' }],
    ghl_sales_deal_bindings: [{
      id: 'binding_missing', purchase_intent_id: missing.id, location_id: 'location_qa',
      contact_id: missing.ghl_contact_id, opportunity_id: missing.ghl_opportunity_id,
      pipeline_id: 'pipeline_qa', ready_stage_id: 'ready_qa', provider_owner_user_id: 'owner_qa',
      status: 'linked', manual_review_required: false,
    }],
  });
  const result = await reconcileSalesWonDeliveries({ db, limit: 100, logger: { warn() {} } });
  assert.equal(result.scanned, 1);
  assert.equal(result.enqueued, 1);
  const created = db.tables.sales_integration_deliveries.filter((row) => row.purchase_intent_id === missing.id);
  assert.equal(created.length, 1);
  assert.equal(created[0].event_key, `ghl_sales_won:${missing.id}`);
});

test('a claim racing the webhook preserves linked attribution and blocks Won after an owner change', async () => {
  const binding = {
    id: 'binding_race', location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_original',
    pipeline_id: 'pipeline_qa', ready_stage_id: 'ready_qa', provider_owner_user_id: 'owner_original',
    sales_team_member_id: 'member_original', sales_rep_user_id: REP_ID,
    purchase_intent_id: null, status: 'ready',
  };
  const db = new MemoryDb({ ghl_sales_deal_bindings: [binding] });
  db.updateHooks.ghl_sales_deal_bindings = () => {
    binding.purchase_intent_id = INTENT_ID;
    binding.status = 'linked';
  };
  const refreshed = await upsertGhlBinding(db, {
    location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_changed',
    pipeline_id: 'pipeline_changed', ready_stage_id: 'ready_changed', provider_owner_user_id: 'owner_changed',
    sales_team_member_id: 'member_changed', sales_rep_user_id: '44444444-4444-4444-8444-444444444444',
    status: 'ready', company_name: 'Updated Dental', opportunity_name: 'Updated opportunity', updated_at: new Date().toISOString(),
  });
  assert.equal(refreshed.binding.purchase_intent_id, INTENT_ID);
  assert.equal(refreshed.binding.provider_owner_user_id, 'owner_original');
  assert.equal(refreshed.binding.sales_rep_user_id, REP_ID);
  assert.equal(refreshed.binding.contact_id, 'contact_original');
  assert.equal(refreshed.binding.pipeline_id, 'pipeline_qa');
  assert.equal(refreshed.binding.status, 'linked');

  const methods = [];
  await assert.rejects(
    markGhlOpportunityWon({ id: DELIVERY_ID }, {
      intent: { id: INTENT_ID, ghl_opportunity_id: 'opp_qa' },
      binding: refreshed.binding,
      agreement: {},
    }, {
      env: {
        GHL_PRIVATE_INTEGRATION_TOKEN: `pit-${'x'.repeat(40)}`,
        GHL_LOCATION_ID: 'location_qa',
        GHL_SALES_PIPELINE_ID: 'pipeline_qa',
        GHL_SALES_READY_STAGE_ID: 'ready_qa',
        GHL_SALES_SYNC_ENABLED: 'true',
      },
      fetchImpl: async (_url, request) => {
        methods.push(request.method);
        return {
          ok: true,
          status: 200,
          async json() {
            return { opportunity: {
              id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa',
              pipelineStageId: 'ready_qa', status: 'open', contactId: 'contact_original', assignedTo: 'owner_changed',
            } };
          },
        };
      },
    }),
    (error) => error.code === 'ghl_owner_changed'
  );
  assert.deepEqual(methods, ['GET']);
});

test('migration reconciliation helper uses NOT EXISTS and stays service-role only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260922154521_ghl_sales_dashboard_integration.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.list_missing_ghl_sales_won_intents/i);
  assert.match(sql, /not exists[\s\S]*delivery\.integration = 'ghl'[\s\S]*delivery\.event_type = 'sales_won'/i);
  assert.match(sql, /revoke all on function public\.list_missing_ghl_sales_won_intents\(integer\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.list_missing_ghl_sales_won_intents\(integer\)[\s\S]*to service_role/i);
});
