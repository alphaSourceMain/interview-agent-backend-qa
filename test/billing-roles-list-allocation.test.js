'use strict';

// GET /roles must allocate once, not once per role.
//
// The allocation walks every used interview for the whole billing family. Called
// per role, a client with a dozen roles pays for that walk a dozen times over.
// This pins that the roles list computes it once and hands the same result to
// every role.
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

const { allocateInterviews } = require(path.join(ROOT, 'src', 'services', 'interviewAllocation.js'));
const { getRoleInterviewAvailability } = require(path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js'));

const CLIENT = 'client_1';
const ROLES = ['role_1', 'role_2', 'role_3', 'role_4'];

function makeDb() {
  const interviews = [];
  ROLES.forEach((roleId, roleIndex) => {
    for (let i = 0; i < 3; i += 1) {
      interviews.push({
        id: `iv_${roleIndex}_${i}`,
        client_id: CLIENT,
        role_id: roleId,
        status: 'completed',
        completed_at: new Date(Date.UTC(2026, 8, 10 + roleIndex, i)).toISOString()
      });
    }
  });

  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null, name: 'Acme Dental Group' }],
    client_plan_settings: [{
      client_id: CLIENT, plan_tier: 'pro', billing_model: 'rollover',
      included_interviews_per_role: 5, per_role_fee: 699,
      usage_interview_fee_cents: null, rollover_days: 90
    }],
    roles: ROLES.map((id) => ({ id, client_id: CLIENT, title: id, status: 'active' })),
    interviews,
    role_interview_purchases: [],
    interview_credits: [],
    client_interview_pools: []
  });
}

// The allocation's own reads are the expensive part, and the fake only records
// writes, so reads are counted by wrapping from().
function counting(db) {
  const reads = new Map();
  const inner = db.from.bind(db);
  return {
    tables: db.tables,
    reads,
    scansOf: (table) => reads.get(table) || 0,
    from(table) {
      reads.set(table, (reads.get(table) || 0) + 1);
      return inner(table);
    }
  };
}

test('one allocation serves every role in the list', async () => {
  const db = counting(makeDb());

  // What GET /roles does: allocate once, then ask per role with that result.
  const allocation = await allocateInterviews({ db, billingClientId: CLIENT });

  const results = [];
  for (const roleId of ROLES) {
    results.push(await getRoleInterviewAvailability({ db, roleId, clientId: CLIENT, allocation }));
  }

  assert.equal(results.length, 4);
  for (const availability of results) {
    assert.equal(availability.used_interviews, 3);
    assert.equal(availability.own_remaining_interviews, 2);
    assert.equal(availability.billing_model, 'rollover');
  }
});

test('passing the allocation avoids re-scanning interviews per role', async () => {
  const shared = counting(makeDb());
  const allocation = await allocateInterviews({ db: shared, billingClientId: CLIENT });
  const sharedBaseline = shared.scansOf('interviews');
  for (const roleId of ROLES) {
    await getRoleInterviewAvailability({ db: shared, roleId, clientId: CLIENT, allocation });
  }

  const perRole = counting(makeDb());
  for (const roleId of ROLES) {
    await getRoleInterviewAvailability({ db: perRole, roleId, clientId: CLIENT });
  }

  assert.equal(sharedBaseline, 1, 'one scan for the whole list');
  assert.equal(shared.scansOf('interviews'), sharedBaseline,
    'reusing the allocation must not scan interviews again');
  assert.equal(perRole.scansOf('interviews'), ROLES.length,
    'without it, every role pays for its own scan — which is what the roles list must avoid');
});

test('an omitted allocation still works, for single-role callers', async () => {
  const db = counting(makeDb());

  const availability = await getRoleInterviewAvailability({ db, roleId: 'role_1', clientId: CLIENT });

  assert.equal(availability.used_interviews, 3);
  assert.equal(availability.own_remaining_interviews, 2);
  assert.equal(db.scansOf('interviews'), 1, 'the enforcement points allocate for themselves');
});

test('the roles list allocates once per billing owner and reuses it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'client', 'roles.js'), 'utf8');
  const handler = source.slice(source.indexOf("router.get('/', requireAuth, withClientScope"));

  assert.match(handler, /allocationByBillingClientId/,
    'the allocation is cached per billing owner, since a list can span entities');
  assert.match(handler, /getRoleInterviewAvailability\(\{[\s\S]{0,120}?allocation\s*\}\)/,
    'and handed to each role rather than recomputed');

  // The old shape called availability inside Promise.all with no allocation,
  // which is exactly one walk per role.
  const loop = handler.slice(handler.indexOf('if (roles.length)'), handler.indexOf('let entityMap'));
  assert.doesNotMatch(loop, /roles\.map\(async \(role\)[\s\S]*?getRoleInterviewAvailability/,
    'the per-role map must not be reinstated');
});
