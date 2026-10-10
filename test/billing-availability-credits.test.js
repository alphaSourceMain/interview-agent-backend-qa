'use strict';

// Availability with credits.
//
// The contract being protected: a fixed or usage client sees exactly the numbers
// it saw before credits existed, and a rollover client sees its credits folded
// into what is left. Every figure is derived from the interviews table by the
// allocation — there is no stored counter to read.
//
// Which interview a credit paid for is the allocation's job and is tested there.
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

const limitEmails = [];
injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async (args) => { limitEmails.push(args); return { ok: true }; },
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const {
  getRoleInterviewAvailability,
  syncRoleInterviewLimitNotification
} = require(path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js'));

const CLIENT = 'client_1';
const ROLE = 'role_1';
const NOW = '2026-09-21T12:00:00.000Z';

const UNIQUE_KEYS = {
  interview_credits: (row) => (row.revoked_at == null ? `role:${row.source_role_id}` : null),
  interview_credit_draws: (row) => `interview:${row.interview_id}`
};

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  included = 5,
  purchases = [],
  interviews = [],
  credits = [],
  draws = [],
  drawnOffset = 0
} = {}) {
  return createFakeSupabase({
    clients: [{
      id: CLIENT,
      parent_client_id: null,
      email: 'owner@acmedental.example',
      name: 'Acme Dental Group',
      client_admin_name: 'Alex Rivera'
    }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 699,
      usage_interview_fee_cents: null,
      rollover_days: 90
    }],
    role_interview_purchases: purchases,
    interviews,
    roles: [
      { id: ROLE, client_id: CLIENT, title: 'Hygienist', interview_limit_notified_at: null },
      // The role a credit was minted from, so the reopened-role reduction has a
      // role to land on.
      { id: 'role_other', client_id: CLIENT, title: 'Front Desk', interview_limit_notified_at: null }
    ],
    interview_credits: credits
  }, { unique: UNIQUE_KEYS });
}

// Interviews carry a completion time because credit validity is judged against
// it: a credit pays for an interview only if it was live when that interview
// finished. They complete an hour apart so the order is unambiguous.
const COMPLETION_START = new Date('2026-09-10T00:00:00.000Z').getTime();
const used = (id, index = 0) => ({
  id,
  client_id: CLIENT,
  role_id: ROLE,
  status: 'completed',
  completed_at: new Date(COMPLETION_START + index * 3600000).toISOString()
});
const usedMany = (count, offset = 0) =>
  Array.from({ length: count }, (_, i) => used(`iv_${offset + i + 1}`, offset + i));

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: CLIENT,
  source_role_id: 'role_other',
  quantity: 4,
  remaining: 4,
  minted_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

const availabilityFor = (db) => getRoleInterviewAvailability({ db, roleId: ROLE, clientId: CLIENT });

test('rollover availability and billing credit readback are scoped to the role entity', async () => {
  const { allocateInterviews } = require('../src/services/interviewAllocation');
  const { readBillingForClient } = require('../src/services/billingReadModel');
  for (const creditOwner of [CLIENT, 'child_1']) {
    const db = makeDb({ included: 0 });
    db.tables.clients.push({ id: 'child_1', parent_client_id: CLIENT, name: 'Synthetic Entity' });
    db.tables.roles.push({ id: 'child_role', client_id: 'child_1', title: 'Synthetic Role' });
    db.tables.interview_credits.push(credit({ client_id: creditOwner, quantity: 5 }));
    db.tables.interviews.push({
      id: 'synthetic_entity_iv', client_id: creditOwner === CLIENT ? 'child_1' : CLIENT,
      role_id: creditOwner === CLIENT ? 'child_role' : ROLE,
      status: 'completed', completed_at: '2026-09-10T00:00:00.000Z'
    });
    const allocation = await allocateInterviews({ db, billingClientId: CLIENT, asOf: NOW });
    assert.equal(allocation.entries[0].source_id, null, 'another entity cannot draw the credit');
    assert.equal(allocation.credits[0].allocated, 0);
    for (const [clientId, roleId] of [[CLIENT, ROLE], ['child_1', 'child_role']]) {
      const available = await getRoleInterviewAvailability({ db, clientId, roleId, allocation });
      const expected = clientId === creditOwner ? 5 : 0;
      assert.equal(available.credit_interviews, expected);
      assert.equal(available.remaining_interviews, expected);
      const billing = await readBillingForClient({ db, clientId, asOf: NOW });
      assert.equal(available.credit_interviews, billing.credits.total_remaining);
    }
  }
});

// --- the response shape ----------------------------------------------------

test('an Essentials client sees exactly the numbers it saw before credits existed', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 5,
    purchases: [{ client_id: CLIENT, role_id: ROLE, quantity: 2, status: 'paid' }],
    interviews: usedMany(3)
  });

  assert.deepEqual(await availabilityFor(db), {
    included_interviews_per_role: 5,
    purchased_interviews: 2,
    used_interviews: 3,
    remaining_interviews: 4,
    own_remaining_interviews: 4,
    credit_interviews: 0,
    pool_remaining_interviews: 0,
    credit_drawn_offset: 0,
    billing_model: 'fixed'
  });
});

test('an Essentials role is never reduced by a credit, because it has none', async () => {
  // Under the rollover model a revoked credit reduces the role that minted it.
  // An Essentials client has no credits at all, so nothing can reduce a role.
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 5,
    credits: [credit({
      id: 'c_stray', source_role_id: ROLE, quantity: 5,
      minted_at: '2026-09-01T00:00:00.000Z', revoked_at: '2026-09-20T00:00:00.000Z'
    })]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.remaining_interviews, 5, 'credits belong to the rollover model only');
  assert.equal(availability.credit_drawn_offset, 0);
});

test('an Enterprise client sees no credits', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 2,
    interviews: usedMany(5),
    credits: [credit()]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.credit_interviews, 0, 'usage clients are invoiced, not credited');
  assert.equal(availability.remaining_interviews, null,
    'a usage role has no cap to report — interviews past the pool are metered, not refused');
  assert.equal(availability.pool_remaining_interviews, 0);
  assert.equal(availability.billing_model, 'usage');
});

test('a Pro client with no credits sees the same numbers as before', async () => {
  const db = makeDb({ included: 5, interviews: usedMany(2) });

  const availability = await availabilityFor(db);

  assert.equal(availability.remaining_interviews, 3);
  assert.equal(availability.own_remaining_interviews, 3);
  assert.equal(availability.credit_interviews, 0);
  assert.equal(availability.billing_model, 'rollover');
});

test('a Pro client with credits has them folded into what is left', async () => {
  const db = makeDb({
    included: 5,
    interviews: usedMany(2),
    credits: [
      credit({ id: 'c_a', source_role_id: 'role_a', quantity: 4 }),
      credit({ id: 'c_b', source_role_id: 'role_b', quantity: 3 })
    ]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.own_remaining_interviews, 3);
  assert.equal(availability.credit_interviews, 7);
  assert.equal(availability.remaining_interviews, 10);
});

test('a role with its own allowance gone still has its credits', async () => {
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [credit({ remaining: 4 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.own_remaining_interviews, 0);
  assert.equal(availability.remaining_interviews, 4);
});

test('expired and revoked credits count for nothing', async () => {
  // A fully spent credit is no longer expressed by a column — it is a credit
  // with every unit allocated to an interview, which the allocation tests cover.
  const db = makeDb({
    included: 1,
    credits: [
      credit({ id: 'c_expired', source_role_id: 'role_a', expires_at: '2026-01-01T00:00:00.000Z' }),
      credit({ id: 'c_revoked', source_role_id: 'role_b', revoked_at: NOW })
    ]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.credit_interviews, 0);
  assert.equal(availability.remaining_interviews, 1);
});

// The reduction a reopened role carries is no longer a stored column. It is
// derived: interviews charged to that role's credit before it was revoked stay
// charged, and that count is what comes off the role when it reopens.
test('a reopened role gives back its allowance minus what other roles already spent', async () => {
  const db = makeDb({
    included: 10,
    // ROLE runs twelve: its own ten, then two on the credit role_other minted
    // when it closed. role_other is then reopened and its credit revoked.
    interviews: usedMany(12),
    credits: [credit({
      id: 'c_reopened', source_role_id: 'role_other', quantity: 5,
      minted_at: '2026-09-01T00:00:00.000Z', revoked_at: '2026-09-20T00:00:00.000Z'
    })]
  });

  const availability = await getRoleInterviewAvailability({ db, roleId: 'role_other', clientId: CLIENT });

  assert.equal(availability.credit_drawn_offset, 2, 'two of its credit were spent before revocation');
  assert.equal(availability.own_remaining_interviews, 8, '10 included less the 2 already spent elsewhere');
});

test('a reduction larger than the allowance leaves zero, never a negative', async () => {
  const db = makeDb({
    included: 2,
    interviews: usedMany(9),
    credits: [credit({
      id: 'c_reopened', source_role_id: 'role_other', quantity: 9,
      minted_at: '2026-09-01T00:00:00.000Z', revoked_at: '2026-09-20T00:00:00.000Z'
    })]
  });

  const availability = await getRoleInterviewAvailability({ db, roleId: 'role_other', clientId: CLIENT });

  assert.equal(availability.own_remaining_interviews, 0);
});

test('a legacy Pro row with no billing model still gets its credits', async () => {
  const db = makeDb({ billingModel: null, included: 1, credits: [credit({ quantity: 2 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.billing_model, 'rollover');
  assert.equal(availability.remaining_interviews, 3);
});

test('every error path still answers with nulls, including the new keys', async () => {
  const db = makeDb();

  for (const args of [
    { db: null, roleId: ROLE, clientId: CLIENT },
    { db, roleId: '', clientId: CLIENT },
    { db, roleId: ROLE, clientId: '' }
  ]) {
    assert.deepEqual(await getRoleInterviewAvailability(args), {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null,
      own_remaining_interviews: null,
      credit_interviews: null,
      pool_remaining_interviews: null,
      credit_drawn_offset: null,
      billing_model: null
    });
  }
});

test('a Pro client with credits is not told the role is full', async () => {
  limitEmails.length = 0;
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [credit({ remaining: 4 })] });

  const availability = await availabilityFor(db);
  await syncRoleInterviewLimitNotification({
    db, roleId: ROLE, clientId: CLIENT,
    remainingInterviews: availability.remaining_interviews,
    roleTitle: 'Hygienist'
  });

  assert.deepEqual(limitEmails, [], 'four credits are still four interviews the client can run');
  assert.equal(db.tables.roles[0].interview_limit_notified_at, null);
});

test('a Pro client with no credits left is still told the role is full', async () => {
  limitEmails.length = 0;
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [] });

  const availability = await availabilityFor(db);
  await syncRoleInterviewLimitNotification({
    db, roleId: ROLE, clientId: CLIENT,
    remainingInterviews: availability.remaining_interviews,
    roleTitle: 'Hygienist'
  });

  assert.equal(availability.remaining_interviews, 0);
  assert.equal(limitEmails.length, 1);
});

// --- the enforcement points ------------------------------------------------

test('every enforcement point reads the shared function and never recomputes', () => {
  const sites = [
    ['src/routes/public/candidateSubmit.js', 'candidate submission'],
    ['src/routes/public/verifyOtp.js', 'OTP verification'],
    ['src/routes/public/textInterview.js', 'text interview'],
    ['src/routes/public/createTavusInterview.js', 'Tavus interview creation'],
    ['src/routes/admin/roles.js', 'admin roles']
  ];

  for (const [relative, label] of sites) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /getRoleInterviewAvailability/,
      `${label} must read capacity from the shared function`);
    assert.doesNotMatch(
      source,
      /included_interviews_per_role[\s\S]{0,80}?[+-][\s\S]{0,80}?purchased/,
      `${label} must not recompute the availability formula locally`
    );
  }
});

test('the interview paths record a fact and call no billing code', () => {
  // The whole point of the change-over: interview code writes completed_at and
  // nothing else. Balances and invoices are computed when someone asks.
  for (const relative of ['src/services/tavusEvents/index.js', 'src/routes/public/textInterview.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /require\(['"][^'"]*interviewCredits['"]\)/,
      `${relative} must not import the credit service`);
    assert.doesNotMatch(source, /require\(['"][^'"]*interviewPool['"]\)/,
      `${relative} must not import the pool service`);
    assert.doesNotMatch(source, /require\(['"][^'"]*usageBilling['"]\)/,
      `${relative} must not import the usage billing service`);
    assert.match(source, /interviewCompletion/, `${relative} records the completion fact`);
  }

  // The video handler keeps the stamp and drops everything else.
  const tavus = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tavusEvents', 'index.js'), 'utf8');
  assert.doesNotMatch(tavus, /getRoleInterviewAvailability/,
    'the video webhook no longer recomputes availability');
  assert.equal((tavus.match(/await recordInterviewCompletion\(/g) || []).length, 2,
    'both video paths still stamp the interview');
});
