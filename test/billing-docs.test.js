'use strict';

// The hand-off document has to stay true to the code.
//
// Three things in it are operational instructions someone will follow to turn
// this on — the webhook event, the env var and the cron path — and a wrong one
// means usage silently never gets billed. Those are pinned against the source.
// The migration list is pinned against the files on disk, so a later migration
// cannot be forgotten in the docs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'billing-models.md');
const doc = fs.readFileSync(DOC, 'utf8');

test('the document names the three models and who is on each', () => {
  for (const model of ['fixed', 'rollover', 'usage']) {
    assert.match(doc, new RegExp(`\`${model}\``), `${model} must be documented`);
  }
  for (const tier of ['Essentials', 'Pro', 'Enterprise']) {
    assert.match(doc, new RegExp(tier));
  }
});

test('the Stripe event the operator must subscribe to is the one the code handles', () => {
  const webhook = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8');
  assert.match(webhook, /event\.type === 'invoice\.created'/);
  assert.match(doc, /must be subscribed to `invoice\.created`/,
    'the operator will not think to add it unless the document says so');
});

test('the env var and cron path in the document are the ones the route uses', () => {
  const route = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'internal', 'usageBilling.js'), 'utf8');
  assert.match(route, /process\.env\.USAGE_BILLING_CRON_SECRET/);
  assert.match(route, /router\.post\('\/billing\/usage-invoices'/);

  assert.match(doc, /USAGE_BILLING_CRON_SECRET/);
  assert.match(doc, /POST \/internal\/billing\/usage-invoices/);
  assert.match(doc, /x-cron-secret/);
  assert.match(doc, /once a day/i, 'the schedule must be stated, not left to the reader');
});

test('every billing migration on disk is listed, and every listed one exists', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((name) => /^20261009\d{6}_(billing_models|interview_credits|usage_billing_ledger|billing_idempotency_keys|role_interview_purchase_failed_status|enterprise_pool_discounts|client_interview_pools|interviews_completed_at|client_plan_settings_money_units)\.sql$/.test(name));

  assert.equal(migrations.length, 9, 'expected the nine billing migrations');
  for (const name of migrations) {
    assert.match(doc, new RegExp(name.replace(/\./g, '\\.')), `${name} must be listed in the document`);
  }

  for (const listed of doc.match(/`\d{14}_[a-z_]+\.sql`/g) || []) {
    const name = listed.replace(/`/g, '');
    assert.ok(
      fs.existsSync(path.join(ROOT, 'supabase', 'migrations', name)),
      `the document lists ${name}, which does not exist`
    );
  }
});

test('the admin endpoints in the document are the ones registered', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  const documented = [
    ['POST', '/admin/billing/agreements/send'],
    ['POST', '/admin/clients/:id/usage-invoice'],
    ['GET', '/admin/clients/:id/billing-summary'],
    ['GET', '/clients/billing/credits'],
    ['GET', '/clients/billing/usage'],
    ['POST', '/internal/billing/usage-invoices']
  ];

  for (const [method, route] of documented) {
    assert.match(doc, new RegExp(`${method} ${route.replace(/[:/]/g, (c) => `\\${c}`)}`),
      `${method} ${route} must appear in the document`);
    assert.ok(inventory.includes(`${method} ${route}`),
      `${method} ${route} is documented but not registered`);
  }
});

test('the document states the rollback path and that the tables are kept', () => {
  assert.match(doc, /Rolling back/i);
  assert.match(doc, /Leave them in place/i,
    'dropping the tables would discard the record of what was billed');
});

test('the mixed money units are called out', () => {
  assert.match(doc, /`usage_interview_fee_cents` is in cents/,
    'the one field in cents among fields in dollars is the easiest thing to get wrong');
});

test('the new cron surface is inventoried in the public-surfaces findings', (t) => {
  // review/ holds client deliverables and is not tracked, so this only runs
  // where the findings document is actually present.
  const findingsPath = path.join(ROOT, 'review', 'findings-003-public-surfaces.md');
  if (!fs.existsSync(findingsPath)) return t.skip('review/findings-003-public-surfaces.md is not present');

  const findings = fs.readFileSync(findingsPath, 'utf8');
  assert.match(findings, /POST \/internal\/billing\/usage-invoices/);
  assert.match(findings, /USAGE_BILLING_CRON_SECRET/);
});

test('the migrations that change tables this repository does not define are called out', () => {
  // A migration touching `interviews`, `roles` or `client_plan_settings` is
  // changing a table whose access model lives outside this repository. Someone
  // applying these needs to know which ones those are.
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const created = fs.readdirSync(dir)
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join(' ');

  for (const table of ['interviews', 'roles', 'client_plan_settings']) {
    const createsIt = new RegExp('create table (if not exists )?(public\\.)?' + table + '\\b');
    assert.ok(
      !createsIt.test(created),
      table + ' is now created in this repository; the document says it is not'
    );
    assert.ok(doc.includes('`' + table + '`'), table + ' must be named in the document');
  }
  assert.match(doc, /does not define/i, 'the section must exist');
});

test('the completed_at migration still changes no access, as the document claims', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009190000_interviews_completed_at.sql'), 'utf8'
  );
  // Comments are stripped: the migration says in prose that it deliberately
  // grants nothing, and that sentence must not read as a grant.
  const statements = migration
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ')
    .toLowerCase();

  for (const statement of ['grant ', 'revoke ', 'enable row level security']) {
    assert.ok(!statements.includes(statement),
      `the migration must not ${statement.trim()} on public.interviews`);
  }
  assert.match(doc, /no RLS,\s+`grant` or `revoke` statement/,
    'the reason it has none must stay written down');
});

test('the client endpoints in the document include the pool read', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  assert.match(doc, /GET \/clients\/billing\/pool/);
  assert.ok(inventory.includes('GET /clients/billing/pool'));
});

test('the document says the dashboard figure is live and the invoice is the prior month', () => {
  assert.match(doc, /not the same number/i);
  assert.match(doc, /calendar month that has ended/i);
});

test('the frontend contract exists and is pointed at from the model document', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'billing-frontend-contract.md')));
  assert.match(doc, /billing-frontend-contract\.md/,
    'a frontend developer will not find it unless this document links to it');
});
