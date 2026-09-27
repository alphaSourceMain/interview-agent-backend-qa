'use strict';

// The Enterprise interview pool.
//
// A pool is bought once at signup and every role under the client — or under any
// of its child entities — draws from it. The two rules worth protecting are that
// an interview can only ever spend one unit, and that running out never stops
// anyone working: past the pool an interview is metered, not refused.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const {
  drawFromPool,
  getPoolRemaining,
  listAvailablePools,
  markPoolFailed,
  markPoolPaid
} = require(path.join(ROOT, 'src', 'services', 'interviewPool.js'));
const { getRoleInterviewAvailability } = require(path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js'));

const PARENT = 'client_parent';
const CHILD = 'client_child';
const ROLE = 'role_parent';
const CHILD_ROLE = 'role_child';

const UNIQUE_KEYS = {
  client_interview_pool_draws: (row) => `interview:${row.interview_id}`
};

const pool = (overrides = {}) => ({
  id: 'pool_1',
  client_id: PARENT,
  quantity_purchased: 10,
  quantity_remaining: 10,
  unit_price_cents: 2500,
  discount_pct: 0,
  total_cents: 25000,
  status: 'paid',
  created_at: '2026-09-01T00:00:00.000Z',
  paid_at: '2026-09-01T00:00:00.000Z',
  ...overrides
});

function makeDb({
  pools = [pool()],
  draws = [],
  interviews = [],
  purchases = [],
  billingModel = 'usage',
  planTier = 'enterprise',
  included = 0
} = {}) {
  return createFakeSupabase({
    clients: [
      { id: PARENT, parent_client_id: null, name: 'Acme Dental Group' },
      { id: CHILD, parent_client_id: PARENT, name: 'Acme Downtown', entity_label: 'Downtown' }
    ],
    client_plan_settings: [{
      client_id: PARENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 0,
      usage_interview_fee_cents: 2500,
      rollover_days: 90
    }],
    roles: [
      { id: ROLE, client_id: PARENT, title: 'Hygienist', rollover_drawn_offset: 0 },
      { id: CHILD_ROLE, client_id: CHILD, title: 'Front Desk', rollover_drawn_offset: 0 }
    ],
    interviews,
    role_interview_purchases: purchases,
    client_interview_pools: pools,
    client_interview_pool_draws: draws,
    interview_credits: [],
    interview_credit_draws: []
  }, { unique: UNIQUE_KEYS });
}

// --- what is spendable ----------------------------------------------------

test('only paid pools with interviews left are spendable', async () => {
  const db = makeDb({
    pools: [
      pool({ id: 'p_paid', quantity_remaining: 4 }),
      pool({ id: 'p_pending', status: 'pending', quantity_remaining: 0 }),
      pool({ id: 'p_spent', quantity_remaining: 0 }),
      pool({ id: 'p_failed', status: 'failed', quantity_remaining: 5 }),
      pool({ id: 'p_theirs', client_id: 'client_other', quantity_remaining: 9 })
    ]
  });

  const available = await listAvailablePools({ db, billingClientId: PARENT });

  assert.deepEqual(available.map((p) => p.id), ['p_paid']);
  assert.equal(await getPoolRemaining({ db, billingClientId: PARENT }), 4);
});

test('remaining sums across several paid pools', async () => {
  const db = makeDb({
    pools: [
      pool({ id: 'p_a', quantity_remaining: 3, created_at: '2026-09-01T00:00:00.000Z' }),
      pool({ id: 'p_b', quantity_remaining: 7, created_at: '2026-10-01T00:00:00.000Z' })
    ]
  });

  assert.equal(await getPoolRemaining({ db, billingClientId: PARENT }), 10);
});

// --- drawing --------------------------------------------------------------

const draw = (db, { clientId = PARENT, roleId = ROLE, interviewId = 'iv_1' } = {}) =>
  drawFromPool({ db, billingClientId: PARENT, clientId, roleId, interviewId });

test('a draw takes one unit and records who spent it', async () => {
  const db = makeDb();

  const result = await draw(db);

  assert.equal(result.drawn, true);
  assert.equal(result.pool_id, 'pool_1');
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 9);
  assert.equal(db.tables.client_interview_pool_draws.length, 1);
  assert.equal(db.tables.client_interview_pool_draws[0].role_id, ROLE);
  assert.equal(db.tables.client_interview_pool_draws[0].interview_id, 'iv_1');
});

test('a child entity interview spends the parent pool', async () => {
  const db = makeDb();

  const result = await draw(db, { clientId: CHILD, roleId: CHILD_ROLE, interviewId: 'iv_child' });

  assert.equal(result.drawn, true);
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 9,
    'the pool belongs to whoever pays');
  assert.equal(db.tables.client_interview_pool_draws[0].client_id, CHILD,
    'but the draw records the entity that ran it');
  assert.equal(db.tables.client_interview_pool_draws[0].role_id, CHILD_ROLE);
});

test('the oldest pool is spent first', async () => {
  const db = makeDb({
    pools: [
      pool({ id: 'p_new', created_at: '2026-10-01T00:00:00.000Z', quantity_remaining: 5 }),
      pool({ id: 'p_old', created_at: '2026-09-01T00:00:00.000Z', quantity_remaining: 5 })
    ]
  });

  const result = await draw(db);

  assert.equal(result.pool_id, 'p_old');
});

test('an exhausted pool is skipped for the next one', async () => {
  const db = makeDb({
    pools: [
      pool({ id: 'p_spent', created_at: '2026-09-01T00:00:00.000Z', quantity_remaining: 0 }),
      pool({ id: 'p_live', created_at: '2026-10-01T00:00:00.000Z', quantity_remaining: 2 })
    ]
  });

  assert.equal((await draw(db)).pool_id, 'p_live');
});

test('drawing twice for one interview spends one unit', async () => {
  const db = makeDb();

  const first = await draw(db, { interviewId: 'iv_1' });
  const second = await draw(db, { interviewId: 'iv_1' });

  assert.equal(first.drawn, true);
  assert.equal(second.drawn, false);
  assert.equal(second.reason, 'already_drawn');
  assert.equal(second.pool_id, first.pool_id);
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 9);
  assert.equal(db.tables.client_interview_pool_draws.length, 1);
});

test('an empty pool draws nothing, and that is not an error', async () => {
  const db = makeDb({ pools: [pool({ quantity_remaining: 0 })] });

  const result = await draw(db);

  assert.deepEqual(result, { drawn: false, reason: 'no_pool' });
  assert.deepEqual(db.tables.client_interview_pool_draws, []);
});

test('a client with no pool at all draws nothing', async () => {
  const db = makeDb({ pools: [] });

  assert.equal((await draw(db)).reason, 'no_pool');
});

test('a pool can be drawn down to exactly zero and no further', async () => {
  const db = makeDb({ pools: [pool({ quantity_purchased: 2, quantity_remaining: 2 })] });

  assert.equal((await draw(db, { interviewId: 'iv_1' })).drawn, true);
  assert.equal((await draw(db, { interviewId: 'iv_2' })).drawn, true);
  const third = await draw(db, { interviewId: 'iv_3' });

  assert.equal(third.drawn, false);
  assert.equal(third.reason, 'no_pool');
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 0);
  assert.equal(db.tables.client_interview_pool_draws.length, 2);
});

test('a draw needs a payer, a role and an interview', async () => {
  const db = makeDb();

  for (const args of [
    { billingClientId: '', roleId: ROLE, interviewId: 'iv_1' },
    { billingClientId: PARENT, roleId: '', interviewId: 'iv_1' },
    { billingClientId: PARENT, roleId: ROLE, interviewId: '' }
  ]) {
    assert.deepEqual(await drawFromPool({ db, ...args }), { drawn: false, reason: 'invalid_request' });
  }
  assert.deepEqual(db.tables.client_interview_pool_draws, []);
});

// --- paying for a pool ----------------------------------------------------

test('paying a pending pool makes its interviews spendable', async () => {
  const db = makeDb({ pools: [pool({ status: 'pending', quantity_remaining: 0, quantity_purchased: 8 })] });

  const result = await markPoolPaid({ db, poolId: 'pool_1', stripePaymentIntentId: 'pi_1' });

  assert.equal(result.paid, true);
  const row = db.tables.client_interview_pools[0];
  assert.equal(row.status, 'paid');
  assert.equal(row.quantity_remaining, 8);
  assert.equal(row.stripe_payment_intent_id, 'pi_1');
  assert.ok(row.paid_at);
});

test('a redelivered payment does not refill a pool already drawn down', async () => {
  const db = makeDb({ pools: [pool({ status: 'paid', quantity_purchased: 10, quantity_remaining: 3 })] });

  const result = await markPoolPaid({ db, poolId: 'pool_1' });

  assert.equal(result.paid, false);
  assert.equal(result.reason, 'already_paid');
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 3,
    'a second delivery must not hand back spent interviews');
});

test('a failed payment marks the pool failed and leaves it unspendable', async () => {
  const db = makeDb({ pools: [pool({ status: 'pending', quantity_remaining: 0 })] });

  assert.equal((await markPoolFailed({ db, poolId: 'pool_1' })).failed, true);
  assert.equal(db.tables.client_interview_pools[0].status, 'failed');
  assert.equal(await getPoolRemaining({ db, billingClientId: PARENT }), 0);
});

test('a pool that is already paid cannot be marked failed', async () => {
  const db = makeDb({ pools: [pool({ status: 'paid' })] });

  assert.equal((await markPoolFailed({ db, poolId: 'pool_1' })).failed, false);
  assert.equal(db.tables.client_interview_pools[0].status, 'paid');
});

test('marking an unknown pool is refused, not silently ignored', async () => {
  const db = makeDb();

  assert.deepEqual(await markPoolPaid({ db, poolId: 'pool_missing' }), { paid: false, reason: 'not_found' });
});

// --- what availability reports --------------------------------------------

const availabilityFor = (db, roleId = ROLE, clientId = PARENT) =>
  getRoleInterviewAvailability({ db, roleId, clientId });

test('a usage role reports the pool and no cap', async () => {
  const db = makeDb({ pools: [pool({ quantity_purchased: 6 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.pool_remaining_interviews, 6);
  assert.equal(availability.remaining_interviews, null, 'usage roles are metered, never capped');
  assert.equal(availability.billing_model, 'usage');
  assert.equal(availability.included_interviews_per_role, 0,
    'the per-role included count is not meaningful under this model');
});

test('a child role sees the parent pool', async () => {
  const db = makeDb({ pools: [pool({ quantity_purchased: 6 })] });

  const availability = await availabilityFor(db, CHILD_ROLE, CHILD);

  assert.equal(availability.pool_remaining_interviews, 6);
  assert.equal(availability.remaining_interviews, null);
});

test('an empty pool still reports no cap, so interviews carry on', async () => {
  // Genuinely exhausted: one interview bought, one run.
  const db = makeDb({
    pools: [pool({ quantity_purchased: 1 })],
    interviews: [{
      id: 'iv_1', client_id: PARENT, role_id: ROLE, status: 'completed',
      completed_at: '2026-09-02T00:00:00.000Z'
    }]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.pool_remaining_interviews, 0);
  assert.equal(availability.remaining_interviews, null,
    'running out must never read as full — past the pool an interview is billed');
});

test('a usage client with a stored included count still ignores it', async () => {
  const db = makeDb({ included: 25, pools: [pool({ quantity_purchased: 1 })] });

  assert.equal((await availabilityFor(db)).included_interviews_per_role, 0);
});

test('legacy paid top-ups on a usage role are still counted', async () => {
  const db = makeDb({
    purchases: [{ client_id: PARENT, role_id: ROLE, quantity: 4, status: 'paid' }],
    pools: [pool({ quantity_purchased: 2 })]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.purchased_interviews, 4);
  assert.equal(availability.own_remaining_interviews, 4);
  assert.equal(availability.pool_remaining_interviews, 2);
});

test('the other models are untouched by the pool', async () => {
  for (const [planTier, billingModel] of [['basic', 'fixed'], ['pro', 'rollover']]) {
    const db = makeDb({ planTier, billingModel, included: 5, pools: [pool({ quantity_purchased: 9 })] });

    const availability = await availabilityFor(db);

    assert.equal(availability.pool_remaining_interviews, 0, `${billingModel} has no pool`);
    assert.equal(availability.remaining_interviews, 5, 'and still reports a real cap');
  }
});

// --- the migration --------------------------------------------------------

test('the migration pins the invariants the service relies on', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260925130000_client_interview_pools.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.client_interview_pools/i);
  assert.match(sql, /create table if not exists public\.client_interview_pool_draws/i);
  assert.match(sql, /interview_id uuid not null unique/i,
    'one draw per interview is what stops a double spend');
  assert.match(sql, /pool_id uuid not null references public\.client_interview_pools\(id\) on delete cascade/i);
  assert.match(sql, /check \(quantity_remaining >= 0 and quantity_remaining <= quantity_purchased\)/i,
    'a pool can never go negative or exceed what was bought');
  assert.match(sql, /check \(status in \('pending', 'paid', 'failed', 'voided', 'refunded'\)\)/i);
  assert.match(sql, /alter table public\.client_interview_pools enable row level security/i);
  assert.match(sql, /alter table public\.client_interview_pool_draws enable row level security/i);
  assert.match(sql, /grant select, insert, update, delete on table[\s\S]*?public\.client_interview_pools,[\s\S]*?public\.client_interview_pool_draws[\s\S]*?to service_role/i);

  for (const grant of (sql.match(/grant[\s\S]*?;/gi) || [])) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i, `unexpected grant: ${grant}`);
  }
});
