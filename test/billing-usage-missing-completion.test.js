'use strict';

// Which month an interview is billed in, and what happens when its completion
// stamp is missing.
//
// The month comes from interviews.completed_at and nothing else: updated_at is
// not a completion time — on the scored-transcript path it can predate the
// finish — so billing never infers one from it. A used interview that reaches
// billing with no completed_at is billed on the invoice being built now, flagged
// in the logs, and stamped with the billing time so it behaves like any other
// row from then on. The ledger's unique interview_id is what stops it being
// billed a second time.
//
// Stripe and Supabase are stubbed; no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const usageBillingPath = path.join(ROOT, 'src', 'services', 'usageBilling.js');
const availabilityPath = path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js');
const allocationPath = path.join(ROOT, 'src', 'services', 'interviewAllocation.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });
injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const { applyUsageToInvoice, computeUnbilledUsage } = require(usageBillingPath);
const { getRoleInterviewAvailability } = require(availabilityPath);
const { allocateInterviews } = require(allocationPath);

const CLIENT = 'client_1';
const ROLE = 'role_1';
const CUSTOMER = 'cus_1';
const INVOICE = 'in_1';

// The invoice being built on 1 September bills August.
const BILLING_TIME = '2026-09-01T06:00:00.000Z';
const NEXT_BILLING_TIME = '2026-10-01T06:00:00.000Z';

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`
};

function interview(id, { completedAt, updatedAt = null, roleId = ROLE } = {}) {
  return {
    id,
    client_id: CLIENT,
    role_id: roleId,
    status: 'completed',
    completed_at: completedAt ?? null,
    updated_at: updatedAt
  };
}

function makeDb(interviews, { ledger = [] } = {}) {
  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER }],
    client_plan_settings: [{
      client_id: CLIENT, plan_tier: 'enterprise', billing_model: 'usage',
      included_interviews_per_role: 0, per_role_fee: 0,
      usage_interview_fee_cents: 2500, rollover_days: 90
    }],
    roles: [{ id: ROLE, client_id: CLIENT, title: 'Hygienist', status: 'active' }],
    interviews,
    usage_billing_ledger: ledger
  }, { unique: UNIQUE_KEYS });
}

function makeStripe() {
  const calls = { items: [] };
  return {
    calls,
    invoiceItems: {
      list: async () => ({ data: [], has_more: false }),
      create: async (payload) => {
        calls.items.push(payload);
        return { id: `ii_${calls.items.length}` };
      }
    }
  };
}

// Keeps the usage_missing_completed_at lines out of the test output, and lets a
// test read back what was flagged.
function captureWarnings(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (event, payload) => { lines.push({ event, payload }); };
  return Promise.resolve(fn())
    .then((value) => ({ value, lines }))
    .finally(() => { console.warn = real; });
}

const bill = (db, stripe, asOf = BILLING_TIME) => applyUsageToInvoice({
  db, stripe, clientId: CLIENT, customerId: CUSTOMER, invoiceId: INVOICE, asOf, now: asOf
});

// --- the month an interview belongs to -------------------------------------

test('only the prior calendar month is billed', async () => {
  const db = makeDb([
    interview('iv_july', { completedAt: '2026-07-20T10:00:00.000Z' }),
    interview('iv_aug', { completedAt: '2026-08-20T10:00:00.000Z' }),
    interview('iv_sep', { completedAt: '2026-09-01T05:00:00.000Z' })
  ]);

  const usage = await computeUnbilledUsage({ db, clientId: CLIENT, asOf: BILLING_TIME });

  assert.deepEqual(usage.lines[0].interview_ids, ['iv_aug'],
    'July was billed last month and September is not over');
  assert.equal(usage.month_label, 'August 2026');
});

test('the last second of the month is inside it, the first of the next is not', async () => {
  const db = makeDb([
    interview('iv_last', { completedAt: '2026-08-31T23:59:59.999Z' }),
    interview('iv_first', { completedAt: '2026-09-01T00:00:00.000Z' })
  ]);

  const usage = await computeUnbilledUsage({ db, clientId: CLIENT, asOf: BILLING_TIME });

  assert.deepEqual(usage.lines[0].interview_ids, ['iv_last']);
});

test('updated_at is never read as a completion time', async () => {
  // This is the row the old scan billed. Its updated_at falls in the month being
  // billed, but nothing stamped it complete, so the month is not taken from it.
  const db = makeDb([interview('iv_legacy', { completedAt: null, updatedAt: '2026-08-15T10:00:00.000Z' })]);

  const usage = await computeUnbilledUsage({ db, clientId: CLIENT, asOf: BILLING_TIME });

  assert.deepEqual(usage.missing_completed_at, [{ interview_id: 'iv_legacy', client_id: CLIENT }],
    'it is treated as unstamped, not as an August interview');
});

// --- a used interview with no completion stamp -----------------------------

test('an unstamped interview is billed on the invoice being built now', async () => {
  const db = makeDb([interview('iv_unstamped', { completedAt: null })]);
  const stripe = makeStripe();

  const { value: result } = await captureWarnings(() => bill(db, stripe));

  assert.equal(result.applied, true);
  assert.equal(result.items, 1);
  assert.equal(result.total_cents, 2500);
  assert.equal(stripe.calls.items.length, 1);
  assert.equal(stripe.calls.items[0].quantity, 1);
  assert.equal(db.tables.usage_billing_ledger.length, 1);
  assert.equal(db.tables.usage_billing_ledger[0].interview_id, 'iv_unstamped');
  assert.ok(db.tables.usage_billing_ledger[0].billed_at);
});

test('it is flagged once, with the interview and the client', async () => {
  const db = makeDb([interview('iv_unstamped', { completedAt: null })]);

  const { lines } = await captureWarnings(() => bill(db, makeStripe()));

  const flags = lines.filter((line) => line.event === 'usage_missing_completed_at');
  assert.equal(flags.length, 1, 'one line per interview, so the count means something');
  assert.equal(flags[0].payload.interview_id, 'iv_unstamped');
  assert.equal(flags[0].payload.client_id, CLIENT);
  assert.equal(flags[0].payload.stamped_completed_at, BILLING_TIME);
});

test('billing stamps it, so the next month does not bill it again', async () => {
  const db = makeDb([interview('iv_unstamped', { completedAt: null })]);

  await captureWarnings(() => bill(db, makeStripe()));

  const stamped = db.tables.interviews.find((row) => row.id === 'iv_unstamped');
  assert.equal(stamped.completed_at, BILLING_TIME, 'the billing time is the only defensible value');

  // Next month, on a fresh invoice, with last month's ledger row in place.
  const nextStripe = makeStripe();
  const next = await applyUsageToInvoice({
    db, stripe: nextStripe, clientId: CLIENT, customerId: CUSTOMER,
    invoiceId: 'in_2', asOf: NEXT_BILLING_TIME, now: NEXT_BILLING_TIME
  });

  assert.equal(next.applied, false);
  assert.equal(next.reason, 'nothing_unbilled');
  assert.deepEqual(nextStripe.calls.items, [], 'one interview, one charge, ever');
  assert.equal(db.tables.usage_billing_ledger.length, 1);
});

test('after the stamp the dashboard treats it as an ordinary interview', async () => {
  const db = makeDb([interview('iv_unstamped', { completedAt: null })]);

  const before = await allocateInterviews({ db, billingClientId: CLIENT });
  assert.equal(before.entries[0].completed_at, null);

  await captureWarnings(() => bill(db, makeStripe()));

  const after = await allocateInterviews({ db, billingClientId: CLIENT });
  assert.equal(after.entries[0].completed_at, BILLING_TIME);
  assert.equal(after.entries[0].ordered_at, BILLING_TIME);
  assert.equal(after.totals.used, 1, 'it is still one used interview, no more and no fewer');

  const availability = await getRoleInterviewAvailability({ db, roleId: ROLE, clientId: CLIENT });
  assert.equal(availability.used_interviews, 1);
});

test('an interview that never became used is neither billed nor stamped', async () => {
  const db = makeDb([{
    id: 'iv_abandoned', client_id: CLIENT, role_id: ROLE, status: 'in_progress',
    completed_at: null, updated_at: '2026-08-10T10:00:00.000Z'
  }]);
  const stripe = makeStripe();

  const { value: result } = await captureWarnings(() => bill(db, stripe));

  assert.equal(result.applied, false);
  assert.deepEqual(stripe.calls.items, []);
  assert.equal(db.tables.interviews[0].completed_at, null);
});
