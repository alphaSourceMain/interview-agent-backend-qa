'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { applyUsageToInvoice, createImmediateUsageInvoice } = require('../src/services/usageBilling');

const AS_OF = '2026-09-15T00:00:00.000Z';
function fixture({ stampFailure = false } = {}) {
  const db = createFakeSupabase({
    clients: [{ id: 'synthetic_client', stripe_customer_id: 'cus_synthetic', parent_client_id: null }],
    client_plan_settings: [{ client_id: 'synthetic_client', plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0, usage_interview_fee_cents: 2500 }],
    roles: [{ id: 'synthetic_role', client_id: 'synthetic_client', title: 'Synthetic Role' }],
    interviews: [{ id: 'synthetic_iv', client_id: 'synthetic_client', role_id: 'synthetic_role', status: 'completed', completed_at: '2026-08-10T00:00:00.000Z' }],
    usage_billing_ledger: []
  }, {
    unique: { usage_billing_ledger: row => row.interview_id },
    failOn: stampFailure ? { usage_billing_ledger: { op: 'update', error: { message: 'synthetic stamp outage' } } } : {}
  });
  const items = [];
  const invoices = [];
  const keys = new Map();
  let failFinalize = false;
  const stripe = {
    invoiceItems: {
      list: async ({ invoice }) => ({ data: items.filter(item => item.invoice === invoice), has_more: false }),
      create: async (payload, options) => {
        if (options?.idempotencyKey && keys.has(options.idempotencyKey)) return keys.get(options.idempotencyKey);
        const item = { id: `ii_synthetic_${items.length}`, ...payload, amount: payload.unit_amount * payload.quantity };
        items.push(item);
        if (options?.idempotencyKey) keys.set(options.idempotencyKey, item);
        return item;
      }
    },
    invoices: {
      create: async payload => { const invoice = { id: `in_synthetic_${invoices.length}`, status: 'draft', ...payload }; invoices.push(invoice); return invoice; },
      retrieve: async id => invoices.find(invoice => invoice.id === id),
      finalizeInvoice: async (id, payload) => {
        if (failFinalize) throw new Error('synthetic finalize outage');
        const invoice = invoices.find(row => row.id === id);
        Object.assign(invoice, { status: 'open' }, payload);
        return invoice;
      }
    }
  };
  return { db, stripe, items, invoices, keys, setFailFinalize: value => { failFinalize = value; } };
}

const apply = f => applyUsageToInvoice({ db: f.db, stripe: f.stripe, clientId: 'synthetic_client', customerId: 'cus_synthetic', invoiceId: 'in_synthetic', asOf: AS_OF });

test('a Stripe-accepted item is reconciled after a ledger-stamp failure without another charge', async () => {
  const f = fixture({ stampFailure: true });
  await assert.rejects(apply(f), /synthetic stamp outage/);
  assert.equal(f.items.length, 1);
  f.keys.clear(); // Simulate Stripe pruning the short-lived idempotency cache.
  f.db.tables.roles[0].title = 'Renamed Synthetic Role';
  await apply(f);
  assert.equal(f.items.length, 1, 'provider reconciliation must survive key expiry and role rename');
  assert.equal(f.db.tables.usage_billing_ledger[0].stripe_invoice_item_id, f.items[0].id);
});

test('an accepted item with a lost response is reconciled before any second provider write', async () => {
  const f = fixture();
  const create = f.stripe.invoiceItems.create;
  f.stripe.invoiceItems.create = async (...args) => {
    await create(...args);
    throw new Error('synthetic lost response');
  };
  await assert.rejects(apply(f), /synthetic lost response/);
  f.keys.clear();
  await apply(f);
  assert.equal(f.items.length, 1);
});

test('concurrent invoice attempts use the same stable provider idempotency key', async () => {
  const f = fixture();
  await Promise.all([apply(f), apply(f)]);
  assert.equal(f.items.length, 1);
});

test('legacy, duplicate or mismatched provider items fail closed without another charge', async () => {
  for (const mode of ['legacy', 'duplicate', 'mismatch']) {
    const f = fixture({ stampFailure: true });
    await assert.rejects(apply(f), /synthetic stamp outage/);
    if (mode === 'legacy') delete f.items[0].metadata.usage_operation;
    if (mode === 'duplicate') f.items.push({ ...f.items[0], id: 'ii_duplicate' });
    if (mode === 'mismatch') f.items[0].amount = 999;
    const before = f.items.length;
    await assert.rejects(apply(f), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.equal(f.items.length, before);
    assert.equal(f.db.tables.usage_billing_ledger[0].billed_at, null);
  }
});

test('a partial immediate invoice cannot auto-advance or be silently replaced on retry', async () => {
  const f = fixture({ stampFailure: true });
  const run = () => createImmediateUsageInvoice({ db: f.db, stripe: f.stripe, clientId: 'synthetic_client', asOf: AS_OF });
  await assert.rejects(run(), /synthetic stamp outage/);
  assert.equal(f.invoices[0].auto_advance, false);
  await assert.rejects(run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
  assert.equal(f.invoices.length, 1);
  assert.equal(f.invoices[0].status, 'draft');
});

test('a failed finalization remains a held draft and is reported rather than skipped as billed', async () => {
  const f = fixture();
  f.setFailFinalize(true);
  const run = () => createImmediateUsageInvoice({ db: f.db, stripe: f.stripe, clientId: 'synthetic_client', asOf: AS_OF });
  await assert.rejects(run(), /synthetic finalize outage/);
  assert.equal(f.invoices[0].auto_advance, false);
  await assert.rejects(run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
  assert.equal(f.invoices.length, 1);
});
