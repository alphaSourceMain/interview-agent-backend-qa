'use strict';

// GET /admin/roles reports the same billing figures as the client roles list,
// and pays for them once per payer.
//
// The administrator list is the one that spans clients: a page of roles can
// belong to a dozen different payers. The allocation walks every used interview
// belonging to a payer, so computing it per role would multiply that walk by the
// number of roles on the page. This pins one pass per billing owner, counted,
// for a list spanning two clients with three roles each.
//
// It also pins the four fields the list gained, chiefly billing_model — without
// it an administrator cannot tell whether a null remaining count means "no
// limit" or "could not be read".
//
// Supabase and auth are stubbed; no database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const adminRolesPath = path.join(ROOT, 'src', 'routes', 'admin', 'roles.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const jdReplacementPath = path.join(ROOT, 'src', 'services', 'roleJdReplacement.js');
const rubricPath = path.join(ROOT, 'src', 'services', 'generateRubric.js');
const tavusDocumentsPath = path.join(ROOT, 'src', 'services', 'tavusDocuments.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

// Two payers. PRO runs the rollover model with a credit; ENTERPRISE runs usage
// with a pool, so the two report different things from the same endpoint.
const PRO = 'client_pro';
const ENTERPRISE = 'client_ent';
const PRO_ROLES = ['role_pro_1', 'role_pro_2', 'role_pro_3'];
const ENT_ROLES = ['role_ent_1', 'role_ent_2', 'role_ent_3'];

function interviewsFor(roleIds, clientId, perRole) {
  const rows = [];
  roleIds.forEach((roleId, roleIndex) => {
    for (let i = 0; i < perRole; i += 1) {
      const at = new Date(Date.UTC(2026, 8, 5 + roleIndex, i)).toISOString();
      rows.push({
        id: `iv_${roleId}_${i}`,
        client_id: clientId,
        role_id: roleId,
        status: 'completed',
        completed_at: at,
        updated_at: at
      });
    }
  });
  return rows;
}

function makeDb() {
  return createFakeSupabase({
    clients: [
      { id: PRO, parent_client_id: null, name: 'Acme Dental Group' },
      { id: ENTERPRISE, parent_client_id: null, name: 'Northgate Group' }
    ],
    client_plan_settings: [
      {
        client_id: PRO, plan_tier: 'pro', billing_model: 'rollover',
        included_interviews_per_role: 5, per_role_fee: 699,
        usage_interview_fee_cents: null, rollover_days: 90
      },
      {
        client_id: ENTERPRISE, plan_tier: 'enterprise', billing_model: 'usage',
        included_interviews_per_role: 2, per_role_fee: 0,
        usage_interview_fee_cents: 2500, rollover_days: 90
      }
    ],
    roles: [
      ...PRO_ROLES.map((id) => ({ id, client_id: PRO, title: id, status: 'active' })),
      ...ENT_ROLES.map((id) => ({ id, client_id: ENTERPRISE, title: id, status: 'active' }))
    ],
    interviews: [
      ...interviewsFor(PRO_ROLES, PRO, 3),
      ...interviewsFor(ENT_ROLES, ENTERPRISE, 3)
    ],
    role_interview_purchases: [],
    interview_credits: [{
      id: 'credit_1', client_id: PRO, source_role_id: 'role_pro_closed', quantity: 4,
      minted_at: '2026-08-01T00:00:00.000Z', expires_at: '2026-12-01T00:00:00.000Z',
      revoked_at: null
    }],
    client_interview_pools: [{
      id: 'pool_1', client_id: ENTERPRISE, quantity_purchased: 10, status: 'paid',
      created_at: '2026-07-01T00:00:00.000Z', paid_at: '2026-07-01T00:00:00.000Z'
    }]
  });
}

// The allocation's cost is its read of the interviews table, so a pass is
// counted by wrapping from(). The fake records writes, not reads.
function counting(db) {
  const reads = new Map();
  const inner = db.from.bind(db);
  return {
    tables: db.tables,
    calls: db.calls,
    readsOf: (table) => reads.get(table) || 0,
    from(table) {
      reads.set(table, (reads.get(table) || 0) + 1);
      return inner(table);
    }
  };
}

function loadApp(db) {
  for (const p of [adminRolesPath, supabasePath, authPath, requireAdminPath, jdReplacementPath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(authPath, {
    requireAuth: (req, _res, next) => { req.user = { id: 'admin_1' }; next(); },
    withClientScope: (_req, _res, next) => next()
  });
  injectModule(requireAdminPath, { requireAdmin: (_req, _res, next) => next() });
  injectModule(jdReplacementPath, { getRoleJdReplacementEligibility: async () => ({}) });
  injectModule(rubricPath, { generateRubricAndKBForRole: async () => ({}), makeKBFromRubric: async () => ({}) });
  injectModule(tavusDocumentsPath, { ensureTavusDocumentForRole: async () => ({}) });

  const app = express();
  app.use(express.json());
  app.use('/admin', require(adminRolesPath));
  return app;
}

const listRoles = (db) => request(loadApp(db)).get('/admin/roles');

// --- one pass per payer ----------------------------------------------------

test('a list spanning two clients allocates twice, not once per role', async () => {
  const db = counting(makeDb());

  const res = await listRoles(db);

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 6, 'three roles each for two clients');
  assert.equal(db.readsOf('interviews'), 2,
    'one allocation per billing owner — six would mean one per role');
});

test('a list for a single client allocates once, however many roles it has', async () => {
  const db = counting(makeDb());

  const res = await request(loadApp(db)).get(`/admin/roles?client_id=${PRO}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 3);
  assert.equal(db.readsOf('interviews'), 1);
});

test('the count does not grow when the roles do', async () => {
  // Six more roles on the same two payers must not cost six more passes.
  const base = makeDb();
  for (let i = 4; i <= 6; i += 1) {
    base.tables.roles.push({ id: `role_pro_${i}`, client_id: PRO, title: `role_pro_${i}`, status: 'active' });
    base.tables.roles.push({ id: `role_ent_${i}`, client_id: ENTERPRISE, title: `role_ent_${i}`, status: 'active' });
  }
  const db = counting(base);

  const res = await listRoles(db);

  assert.equal(res.body.items.length, 12);
  assert.equal(db.readsOf('interviews'), 2, 'still one pass per payer');
});

// --- the fields the list gained --------------------------------------------

test('every role carries the four fields the client list already had', async () => {
  const res = await listRoles(counting(makeDb()));

  for (const item of res.body.items) {
    for (const field of [
      'included_interviews_per_role', 'purchased_interviews', 'used_interviews',
      'remaining_interviews', 'own_remaining_interviews', 'credit_interviews',
      'pool_remaining_interviews', 'billing_model'
    ]) {
      assert.ok(field in item, `${field} must be on every role`);
    }
  }
});

test('a Pro role reports its own remaining and the credit it can still spend', async () => {
  const res = await listRoles(counting(makeDb()));
  const role = res.body.items.find((item) => item.id === 'role_pro_1');

  assert.equal(role.billing_model, 'rollover');
  assert.equal(role.used_interviews, 3);
  assert.equal(role.own_remaining_interviews, 2, '5 included less 3 used');
  assert.equal(role.credit_interviews, 4, 'the unspent credit');
  assert.equal(role.remaining_interviews, 6, 'its own two plus the four on credit');
  assert.equal(role.pool_remaining_interviews, 0, 'credits are not a pool');
});

test('an Enterprise role reports no limit, and the pool that explains it', async () => {
  const res = await listRoles(counting(makeDb()));
  const role = res.body.items.find((item) => item.id === 'role_ent_1');

  assert.equal(role.billing_model, 'usage');
  assert.equal(role.used_interviews, 3);
  assert.equal(role.remaining_interviews, null,
    'null means there is no cap, not that the role is empty');
  assert.equal(role.pool_remaining_interviews, 7,
    '10 bought, 3 used past the included count — this is what a dashboard shows instead');
});

test('billing_model is what tells a null remaining count apart from an unreadable one', async () => {
  // A role whose client has no plan settings: every figure is null, and
  // billing_model is null too. An Enterprise role also reports a null remaining
  // count, but names its model — which is how the two are told apart.
  const db = makeDb();
  db.tables.clients.push({ id: 'client_unknown', parent_client_id: null, name: 'No Plan Ltd' });
  db.tables.roles.push({ id: 'role_unknown', client_id: 'client_unknown', title: 'Orphan', status: 'active' });

  const res = await listRoles(counting(db));
  const unreadable = res.body.items.find((item) => item.id === 'role_unknown');
  const enterprise = res.body.items.find((item) => item.id === 'role_ent_1');

  assert.equal(unreadable.remaining_interviews, null);
  assert.equal(unreadable.billing_model, null, 'unknown, and says so');
  assert.equal(enterprise.remaining_interviews, null);
  assert.equal(enterprise.billing_model, 'usage', 'no limit, and says so');
});

// --- nothing was taken away -------------------------------------------------

test('the four figures the list already reported are unchanged', async () => {
  const res = await listRoles(counting(makeDb()));
  const role = res.body.items.find((item) => item.id === 'role_pro_1');

  assert.equal(role.included_interviews_per_role, 5);
  assert.equal(role.purchased_interviews, 0);
  assert.equal(role.used_interviews, 3);
  assert.equal(role.remaining_interviews, 6);
  assert.ok('job_description_replacement' in role, 'the rest of the payload is untouched');
  assert.equal(role.title, 'role_pro_1');
});

test('reading the list writes nothing', async () => {
  const db = counting(makeDb());

  await listRoles(db);

  assert.deepEqual(db.calls.filter((call) => call.op !== 'select'), [],
    'a list must never draw down a balance');
});
