'use strict';

// What paid for each interview.
//
// The allocation replays every used interview in completion order and decides
// what covered it. It is the single source both the dashboard and the invoice
// read, so the tests that matter are the equivalence ones: given the fixtures
// the existing credit, pool, reopen and parent/child tests use, it must produce
// the same numbers the stored counters produce today.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
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

const { allocateInterviews } = require(path.join(ROOT, 'src', 'services', 'interviewAllocation.js'));

const PARENT = 'client_parent';
const CHILD = 'client_child';
const ROLE = 'role_1';
const ROLE_2 = 'role_2';
const CHILD_ROLE = 'role_child';

// Interviews completing an hour apart, so completion order is unambiguous.
function completed(count, { clientId = PARENT, roleId = ROLE, prefix = 'iv', from = '2026-09-01T00:00:00.000Z' } = {}) {
  const start = new Date(from).getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: clientId,
    role_id: roleId,
    status: 'completed',
    completed_at: new Date(start + i * 3600000).toISOString(),
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  included = 5,
  usagePriceCents = 2500,
  roles = [
    { id: ROLE, client_id: PARENT, title: 'Hygienist', status: 'active' },
    { id: ROLE_2, client_id: PARENT, title: 'Front Desk', status: 'active' }
  ],
  children = [],
  interviews = [],
  purchases = [],
  credits = [],
  pools = []
} = {}) {
  return createFakeSupabase({
    clients: [{ id: PARENT, parent_client_id: null, name: 'Acme Dental Group' }, ...children],
    client_plan_settings: [{
      client_id: PARENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 699,
      usage_interview_fee_cents: usagePriceCents,
      rollover_days: 90
    }],
    roles,
    interviews,
    role_interview_purchases: purchases,
    interview_credits: credits,
    client_interview_pools: pools
  });
}

const allocate = (db, asOf = '2026-10-01T00:00:00.000Z') =>
  allocateInterviews({ db, billingClientId: PARENT, asOf });

const sourcesFor = (result) => result.entries.map((entry) => entry.source);

// --- the fixed model ------------------------------------------------------

test('Essentials: interviews inside the allowance are covered by the role', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 5,
    interviews: completed(3)
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'own']);
  assert.equal(result.by_role.get(ROLE).own_remaining, 2);
  assert.equal(result.totals.credit_balance, 0);
});

test('Essentials: past the allowance there is no credit, so it is metered', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 2,
    interviews: completed(4)
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'usage', 'usage']);
  assert.equal(result.by_role.get(ROLE).own_remaining, 0);
});

test('paid top-ups extend the role allowance, matching availability today', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 2,
    purchases: [{ client_id: PARENT, role_id: ROLE, quantity: 3, status: 'paid' }],
    interviews: completed(4)
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'own', 'own']);
  assert.equal(result.by_role.get(ROLE).own_remaining, 1, '2 included + 3 bought less 4 used');
});

// --- the rollover model ---------------------------------------------------

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: PARENT,
  source_role_id: ROLE_2,
  quantity: 5,
  minted_at: '2026-08-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

test('Pro: the role allowance is spent before any credit', async () => {
  const db = makeDb({ included: 3, interviews: completed(5), credits: [credit({ quantity: 4 })] });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'own', 'credit', 'credit']);
  assert.equal(result.totals.credit_balance, 2, '4 minted less 2 spent');
});

test('Pro: credits are spent earliest expiry first', async () => {
  const db = makeDb({
    included: 0,
    interviews: completed(2),
    credits: [
      credit({ id: 'c_late', source_role_id: ROLE_2, quantity: 1, expires_at: '2026-12-01T00:00:00.000Z' }),
      credit({ id: 'c_soon', source_role_id: ROLE_2, quantity: 1, expires_at: '2026-10-15T00:00:00.000Z' })
    ]
  });

  const result = await allocate(db);

  assert.deepEqual(result.entries.map((e) => e.source_id), ['c_soon', 'c_late']);
});

test('Pro: a credit minted after an interview cannot pay for it', async () => {
  const db = makeDb({
    included: 0,
    interviews: completed(1, { from: '2026-08-01T00:00:00.000Z' }),
    credits: [credit({ quantity: 5, minted_at: '2026-09-01T00:00:00.000Z' })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['usage'], 'the credit did not exist yet');
  assert.equal(result.totals.credit_balance, 5, 'and is still unspent');
});

test('Pro: an expired credit does not pay for a later interview', async () => {
  const db = makeDb({
    included: 0,
    interviews: completed(1, { from: '2026-11-01T00:00:00.000Z' }),
    credits: [credit({ quantity: 5, expires_at: '2026-10-01T00:00:00.000Z' })]
  });

  const result = await allocate(db, '2026-11-02T00:00:00.000Z');

  assert.deepEqual(sourcesFor(result), ['usage']);
  assert.equal(result.totals.credit_balance, 0, 'an expired credit is worth nothing');
});

test('Pro: revocation is not retroactive, and what was spent reduces the reopened role', async () => {
  // The equivalence case for rollover_drawn_offset: a credit minted when role_2
  // closed, three interviews charged to it, then role_2 reopened and the credit
  // revoked. The stored offset was 3; the allocation derives the same.
  const db = makeDb({
    included: 0,
    interviews: completed(3, { roleId: ROLE, from: '2026-08-05T00:00:00.000Z' }),
    credits: [credit({
      quantity: 5,
      source_role_id: ROLE_2,
      minted_at: '2026-08-01T00:00:00.000Z',
      revoked_at: '2026-09-01T00:00:00.000Z'
    })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['credit', 'credit', 'credit'],
    'interviews already charged stay charged');
  assert.equal(result.by_role.get(ROLE_2).drawn_from_revoked, 3,
    'this is what rollover_drawn_offset stored');
  assert.equal(result.totals.credit_balance, 0, 'a revoked credit is worth nothing going forward');
});

test('Pro: an interview after revocation cannot use the revoked credit', async () => {
  const db = makeDb({
    included: 0,
    interviews: completed(1, { from: '2026-09-15T00:00:00.000Z' }),
    credits: [credit({ quantity: 5, revoked_at: '2026-09-01T00:00:00.000Z' })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['usage']);
});

test('Pro: the reopened role own remaining is reduced by what was spent', async () => {
  const db = makeDb({
    included: 5,
    roles: [
      { id: ROLE, client_id: PARENT, title: 'Hygienist', status: 'active' },
      { id: ROLE_2, client_id: PARENT, title: 'Front Desk', status: 'active' }
    ],
    // role_1 runs seven: its own five, then two on role_2's credit.
    interviews: completed(7, { roleId: ROLE, from: '2026-08-05T00:00:00.000Z' }),
    credits: [credit({
      quantity: 5, source_role_id: ROLE_2,
      minted_at: '2026-08-01T00:00:00.000Z', revoked_at: '2026-09-01T00:00:00.000Z'
    })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'own', 'own', 'own', 'credit', 'credit']);
  // role_1 has spent its own five. role_2 used none of its own, but two of its
  // credit were spent before revocation, so it comes back with three of five.
  assert.equal(result.by_role.get(ROLE).own_remaining, 0);
  assert.equal(result.by_role.get(ROLE_2).drawn_from_revoked, 2);
  assert.equal(result.by_role.get(ROLE_2).own_remaining, 3);
});

test('Pro: credits stay with the child that earned them', async () => {
  const db = makeDb({
    included: 0,
    children: [{ id: CHILD, parent_client_id: PARENT, name: 'Downtown', entity_label: 'Downtown' }],
    roles: [
      { id: ROLE, client_id: PARENT, title: 'Hygienist', status: 'active' },
      { id: CHILD_ROLE, client_id: CHILD, title: 'Front Desk', status: 'active' }
    ],
    interviews: completed(1, { clientId: PARENT, roleId: ROLE, prefix: 'p' }),
    credits: [credit({ client_id: CHILD, source_role_id: CHILD_ROLE, quantity: 5 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['usage'],
    "the parent cannot spend a child's credit");
});

// --- the usage model ------------------------------------------------------

const pool = (overrides = {}) => ({
  id: 'pool_1',
  client_id: PARENT,
  quantity_purchased: 10,
  status: 'paid',
  created_at: '2026-08-01T00:00:00.000Z',
  paid_at: '2026-08-01T00:00:00.000Z',
  ...overrides
});

test('Enterprise: the pool pays before anything is metered', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0,
    interviews: completed(3), pools: [pool({ quantity_purchased: 2 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['pool', 'pool', 'usage']);
  assert.equal(result.totals.pool_remaining, 0);
  assert.equal(result.totals.usage, 1);
});

test('Enterprise: included first, then the pool, then the meter', async () => {
  // The order a usage client's interviews are paid for, in one run: two free on
  // the role's included count, two out of the pool, the rest metered.
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 2,
    interviews: completed(5), pools: [pool({ quantity_purchased: 2 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own', 'pool', 'pool', 'usage']);
  assert.deepEqual(result.entries.map((entry) => entry.interview_id),
    ['iv_1', 'iv_2', 'iv_3', 'iv_4', 'iv_5'], 'in completion order');
  assert.equal(result.totals.own, 2);
  assert.equal(result.totals.pool, 2);
  assert.equal(result.totals.usage, 1);
  assert.equal(result.totals.pool_remaining, 0);
  assert.equal(result.by_role.get(ROLE).own_remaining, 0);
});

test('Enterprise: the included count is per role, and the pool is shared across them', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 1,
    interviews: [
      ...completed(2, { roleId: ROLE, prefix: 'a' }),
      ...completed(2, { roleId: ROLE_2, prefix: 'b', from: '2026-09-02T00:00:00.000Z' })
    ],
    pools: [pool({ quantity_purchased: 1 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'pool', 'own', 'usage'],
    'each role gets its one free interview; the single pooled one goes to whoever runs first');
  assert.equal(result.totals.own, 2);
  assert.equal(result.totals.pool, 1);
  assert.equal(result.totals.usage, 1);
});

test('Enterprise: the included count is free before anything is metered', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 25,
    interviews: completed(2), pools: []
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['own', 'own'],
    'an Enterprise agreement gives each role an included count, and it is free');
});

test('Enterprise: a child role draws the parent pool', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0,
    children: [{ id: CHILD, parent_client_id: PARENT, name: 'Downtown', entity_label: 'Downtown' }],
    roles: [
      { id: ROLE, client_id: PARENT, title: 'Hygienist', status: 'active' },
      { id: CHILD_ROLE, client_id: CHILD, title: 'Front Desk', status: 'active' }
    ],
    interviews: completed(2, { clientId: CHILD, roleId: CHILD_ROLE, prefix: 'c' }),
    pools: [pool({ quantity_purchased: 5 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['pool', 'pool']);
  assert.equal(result.totals.pool_remaining, 3);
});

test('Enterprise: pools are spent oldest first', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0,
    interviews: completed(2),
    pools: [
      pool({ id: 'p_new', created_at: '2026-09-01T00:00:00.000Z', quantity_purchased: 1 }),
      pool({ id: 'p_old', created_at: '2026-08-01T00:00:00.000Z', quantity_purchased: 1 })
    ]
  });

  const result = await allocate(db);

  assert.deepEqual(result.entries.map((e) => e.source_id), ['p_old', 'p_new']);
});

test('Enterprise: an unpaid pool pays for nothing', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0,
    interviews: completed(2), pools: [pool({ status: 'pending' })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['usage', 'usage']);
  assert.equal(result.totals.pool_remaining, 0);
});

test('Enterprise: a closed role still allocates, exactly like an open one', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0,
    roles: [{ id: ROLE, client_id: PARENT, title: 'Hygienist', status: 'inactive' }],
    interviews: completed(2), pools: [pool({ quantity_purchased: 1 })]
  });

  const result = await allocate(db);

  assert.deepEqual(sourcesFor(result), ['pool', 'usage'],
    'role status has never affected whether an interview counts');
});

// --- ordering and determinism ---------------------------------------------

test('allocation follows completion order, not insertion order', async () => {
  const db = makeDb({
    included: 1,
    interviews: [
      { id: 'iv_late', client_id: PARENT, role_id: ROLE, status: 'completed', completed_at: '2026-09-10T00:00:00.000Z' },
      { id: 'iv_early', client_id: PARENT, role_id: ROLE, status: 'completed', completed_at: '2026-09-01T00:00:00.000Z' }
    ],
    credits: [credit({ quantity: 1 })]
  });

  const result = await allocate(db);

  assert.equal(result.entries[0].interview_id, 'iv_early');
  assert.equal(result.entries[0].source, 'own', 'the earlier interview takes the allowance');
  assert.equal(result.entries[1].source, 'credit');
});

test('a row with no completed_at is ordered by updated_at but stays unstamped', async () => {
  const db = makeDb({
    included: 5,
    interviews: [
      { id: 'iv_legacy', client_id: PARENT, role_id: ROLE, status: 'completed', completed_at: null, updated_at: '2026-09-01T00:00:00.000Z' }
    ]
  });

  const result = await allocate(db);

  assert.equal(result.totals.used, 1, 'the interview is not dropped');
  assert.equal(result.entries[0].ordered_at, '2026-09-01T00:00:00.000Z',
    'ordering needs a value, so updated_at stands in');
  assert.equal(result.entries[0].completed_at, null,
    'billing must see that the completion stamp is missing, not a guess at it');
});

test('the same inputs give the same answer', async () => {
  const build = () => makeDb({
    included: 2,
    interviews: completed(5),
    credits: [credit({ quantity: 2 }), credit({ id: 'c_2', quantity: 2, expires_at: '2026-11-01T00:00:00.000Z' })]
  });

  const first = await allocate(build());
  const second = await allocate(build());

  assert.deepEqual(first.entries, second.entries);
  assert.deepEqual(first.totals, second.totals);
});

test('interviews that never became used are not allocated', async () => {
  const db = makeDb({
    included: 5,
    interviews: [
      ...completed(1),
      { id: 'iv_started', client_id: PARENT, role_id: ROLE, status: 'Started', completed_at: '2026-09-02T00:00:00.000Z' },
      {
        id: 'iv_no_substance', client_id: PARENT, role_id: ROLE, status: 'completed',
        has_substantive_response: false, conversation_progress_state: 'NoSubstantiveCandidateResponse',
        completed_at: '2026-09-03T00:00:00.000Z'
      }
    ]
  });

  const result = await allocate(db);

  assert.equal(result.totals.used, 1,
    'a candidate who said nothing substantive is not a billable interview');
});

test('a client with no plan settings allocates nothing', async () => {
  const db = createFakeSupabase({
    clients: [{ id: PARENT, parent_client_id: null }],
    client_plan_settings: [],
    roles: [], interviews: [], role_interview_purchases: [],
    interview_credits: [], client_interview_pools: []
  });

  const result = await allocate(db);

  assert.equal(result.billing_model, null);
  assert.deepEqual(result.entries, []);
});

test('missing arguments allocate nothing without touching the database', async () => {
  const db = makeDb();
  assert.deepEqual((await allocateInterviews({ db, billingClientId: '' })).entries, []);
  assert.deepEqual((await allocateInterviews({ db: null, billingClientId: PARENT })).entries, []);
  assert.deepEqual(db.calls, []);
});
