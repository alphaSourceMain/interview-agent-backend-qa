'use strict';

// Interview credits: minting, revoking, listing and drawing.
//
// The rules being protected are the ones a client would notice if they broke:
// only Pro clients mint, a role mints once however many times it is closed,
// credit already spent by other roles is not clawed back from them, and an
// interview can never spend two credits.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const {
  mintCreditForClosedRole,
  revokeCreditForReopenedRole,
  syncRoleCreditsForStatusChange
} = require(path.join(ROOT, 'src', 'services', 'interviewCredits.js'));

const CLIENT = 'client_1';
const NOW = '2026-09-21T12:00:00.000Z';

const UNIQUE_KEYS = {
  // Mirrors the partial unique index: one live credit per source role.
  interview_credits: (row) => (row.revoked_at == null ? `role:${row.source_role_id}` : null),
  interview_credit_draws: (row) => `interview:${row.interview_id}`
};

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  rolloverDays = 90,
  included = 30,
  purchases = [],
  interviews = [],
  credits = [],
  draws = [],
  roles = [{ id: 'role_1', client_id: CLIENT, rollover_drawn_offset: 0 }],
  ...rest
} = {}) {
  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 699,
      usage_interview_fee_cents: null,
      rollover_days: rolloverDays
    }],
    role_interview_purchases: purchases,
    interviews,
    roles,
    interview_credits: credits,
    interview_credit_draws: draws
  }, { unique: UNIQUE_KEYS, ...rest });
}

const usedInterview = (id) => ({ id, client_id: CLIENT, role_id: 'role_1', status: 'completed' });

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: CLIENT,
  source_role_id: 'role_1',
  quantity: 5,
  remaining: 5,
  minted_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

// --- minting ---------------------------------------------------------------

test('closing a Pro role mints its unused allowance', async () => {
  const db = makeDb({ included: 30, interviews: [usedInterview('iv_1'), usedInterview('iv_2')] });

  const result = await mintCreditForClosedRole({
    db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW
  });

  assert.equal(result.minted, true);
  assert.equal(result.quantity, 28, '30 included, 2 used');
  assert.equal(db.tables.interview_credits.length, 1);
  assert.equal(db.tables.interview_credits[0].quantity, 28,
    'the quantity is the whole record of the credit; what is left of it is derived');
  assert.equal(db.tables.interview_credits[0].remaining, undefined,
    'no balance is stored, so none can fall out of step');
  assert.equal(db.tables.interview_credits[0].source_role_id, 'role_1');
});

test('paid top-ups count toward what rolls over', async () => {
  const db = makeDb({
    included: 30,
    purchases: [{ client_id: CLIENT, role_id: 'role_1', quantity: 10, status: 'paid' }],
    interviews: [usedInterview('iv_1')]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.quantity, 39, '30 included + 10 purchased - 1 used');
});

test('an unpaid top-up does not roll over', async () => {
  const db = makeDb({
    included: 30,
    purchases: [{ client_id: CLIENT, role_id: 'role_1', quantity: 10, status: 'pending' }]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.quantity, 30);
});

test('the credit expires rollover_days after the role closed, not after the mint ran', async () => {
  const db = makeDb({ rolloverDays: 90 });

  const result = await mintCreditForClosedRole({
    db, clientId: CLIENT, roleId: 'role_1',
    closedAt: '2026-09-21T12:00:00.000Z',
    now: '2026-09-25T00:00:00.000Z'
  });

  assert.equal(result.expires_at, '2026-12-20T12:00:00.000Z');
});

test('a client-specific rollover window is honoured', async () => {
  const db = makeDb({ rolloverDays: 30 });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.expires_at, '2026-10-21T12:00:00.000Z');
});

test('a fully used role mints nothing', async () => {
  const db = makeDb({
    included: 2,
    interviews: [usedInterview('iv_1'), usedInterview('iv_2')]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'no_leftover' });
  assert.deepEqual(db.tables.interview_credits, []);
});

test('an Essentials role mints nothing — its allowance simply lapses', async () => {
  const db = makeDb({ planTier: 'basic', billingModel: 'fixed' });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'billing_model' });
  assert.deepEqual(db.tables.interview_credits, []);
});

test('an Enterprise role mints nothing — it is billed for usage instead', async () => {
  const db = makeDb({ planTier: 'enterprise', billingModel: 'usage' });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'billing_model' });
});

test('a legacy Pro row with no billing model still mints', async () => {
  const db = makeDb({ planTier: 'pro', billingModel: null });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, true);
});

test('closing the same role twice mints once', async () => {
  const db = makeDb();

  const first = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });
  const second = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(first.minted, true);
  assert.equal(second.minted, false);
  assert.equal(second.reason, 'already_minted');
  assert.equal(second.credit.id, first.credit.id, 'the existing credit is returned, not a new one');
  assert.equal(db.tables.interview_credits.length, 1);
});

test('a revoked credit does not block a later mint for the same role', async () => {
  const db = makeDb({ credits: [credit({ revoked_at: '2026-09-10T00:00:00.000Z' })] });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, true, 'a reopened-then-reclosed role earns its allowance again');
  assert.equal(db.tables.interview_credits.length, 2);
});

test('a role whose availability cannot be read mints nothing', async () => {
  const db = makeDb({ failOn: { client_plan_settings: { op: 'select', error: { message: 'timeout' } } } });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, false, 'a failed read must never be treated as a zero balance');
});

// --- revoking --------------------------------------------------------------
//
// Revoking no longer counts what was spent or writes an offset: the allocation
// derives both by replaying the interviews charged to the credit. The rules
// that used to live here — a revoked credit's spent interviews stay spent, and
// the reopened role's own remaining is reduced by that many — are asserted in
// test/billing-interview-allocation.test.js.

test('reopening a role revokes its credit', async () => {
  const db = makeDb({ credits: [credit()] });

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(result.revoked, true);
  assert.equal(db.tables.interview_credits[0].revoked_at, NOW);
});

test('revoking records when, and nothing else', async () => {
  const db = makeDb({ credits: [credit({ quantity: 5 })] });

  await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  const stored = db.tables.interview_credits[0];
  assert.equal(stored.quantity, 5, 'the credit is not rewritten, only marked');
  assert.equal(stored.revoked_at, NOW);
  assert.deepEqual(
    db.calls.filter((call) => call.op !== 'select' && call.table === 'roles'),
    [],
    'no counter is written to the role'
  );
});

test('reopening a role that never minted is a no-op', async () => {
  const db = makeDb();

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.deepEqual(result, { revoked: false, reason: 'no_credit' });
});

test('an already revoked credit is not revoked again', async () => {
  const db = makeDb({ credits: [credit({ revoked_at: '2026-09-10T00:00:00.000Z', quantity: 5 })] });

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(result.revoked, false);
  assert.equal(db.tables.interview_credits[0].revoked_at, '2026-09-10T00:00:00.000Z',
    'the first revocation time stands');
});

// --- the route hook --------------------------------------------------------

test('closing a role through the hook mints, reopening revokes', async () => {
  const db = makeDb({ included: 10, interviews: [usedInterview('iv_1')] });

  const closed = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'inactive', closedAt: NOW, now: NOW
  });
  assert.equal(closed.minted, true);
  assert.equal(closed.quantity, 9);

  const reopened = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'active', now: NOW
  });
  assert.equal(reopened.revoked, true);
  assert.equal(db.tables.interview_credits[0].revoked_at, NOW);
});

test('a credit failure is logged and never fails the status change', async () => {
  const db = makeDb({ failOn: { interview_credits: { op: 'select', error: { message: 'timeout' } } } });
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args);
  let result;
  try {
    result = await syncRoleCreditsForStatusChange({
      db, clientId: CLIENT, roleId: 'role_1', status: 'inactive', closedAt: NOW, now: NOW
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(result, { skipped: true, reason: 'error' }, 'closing a role must still succeed');
  const logged = lines.find(([message]) => message === 'interview_credit_sync_failed');
  assert.ok(logged, 'the failure must be visible');
  assert.equal(logged[1].role_id, 'role_1');
});

test('a status the hook does not act on is skipped', async () => {
  const db = makeDb();

  const result = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'all', now: NOW
  });

  assert.deepEqual(result, { skipped: true, reason: 'status' });
});

test('both role-status routes run the credit hook after the status is written', () => {
  const fs = require('node:fs');
  const routes = [
    path.join(ROOT, 'src', 'routes', 'client', 'roles.js'),
    path.join(ROOT, 'src', 'routes', 'admin', 'roles.js')
  ];

  for (const routePath of routes) {
    const source = fs.readFileSync(routePath, 'utf8');
    assert.match(source, /require\('\.\.\/\.\.\/services\/interviewCredits'\)/,
      `${path.basename(path.dirname(routePath))}/roles.js must use the shared credit service`);
    assert.match(
      source,
      /role_status_update_failed[\s\S]*?not_found[\s\S]*?await syncRoleCreditsForStatusChange\(\{[\s\S]*?status,/,
      `${path.basename(path.dirname(routePath))}/roles.js must run the hook only after the update succeeded`
    );
  }
});
