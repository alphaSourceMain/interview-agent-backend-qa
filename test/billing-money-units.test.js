'use strict';

// Which money columns are dollars and which are cents.
//
// client_plan_settings mixes the two. Reading one as the other is a
// hundredfold error in a client's bill, so the meaning is recorded on the
// columns themselves, where anyone reading the table finds it.
//
// Pure text assertions on the migration; no database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(
  ROOT, 'supabase', 'migrations', '20260927120000_client_plan_settings_money_units.sql'
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

const DOLLAR_COLUMNS = ['platform_fee', 'per_role_fee', 'additional_interview_fee'];
const CENT_COLUMNS = ['usage_interview_fee_cents'];

test('every money column is commented', () => {
  for (const column of [...DOLLAR_COLUMNS, ...CENT_COLUMNS]) {
    assert.ok(sql.includes(`'${column}'`) || sql.includes(`.${column} is`),
      `${column} must carry a comment`);
  }
});

test('the dollar columns say dollars and the cents column says cents', () => {
  for (const column of DOLLAR_COLUMNS) {
    const at = sql.indexOf(`'${column}',`);
    assert.notEqual(at, -1, `${column} must be listed`);
    assert.match(sql.slice(at, at + 400), /DOLLARS\./,
      `${column} is stored in dollars and the comment must say so`);
  }
  for (const column of CENT_COLUMNS) {
    const at = sql.indexOf(`'${column}',`);
    assert.notEqual(at, -1, `${column} must be listed`);
    assert.match(sql.slice(at, at + 400), /CENTS\./);
  }
});

test('each comment gives a worked example, so the unit cannot be misread', () => {
  assert.match(sql, /1200 means \$1,200\.00/);
  assert.match(sql, /2500 means \$25\.00/);
});

test('the comment on the included count says zero is a setting', () => {
  assert.match(sql, /included_interviews_per_role is[\s\S]{0,400}?0 is a valid setting/i,
    'a reader must not assume 0 means unset');
});

test('the migration only comments — it changes no column and no value', () => {
  const statements = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ')
    .toLowerCase();

  for (const forbidden of ['alter table', 'update ', 'insert ', 'delete ', 'drop ']) {
    assert.ok(!statements.includes(forbidden),
      `a documentation migration must not ${forbidden.trim()}`);
  }
});

test('every comment is guarded on the column existing', () => {
  // public.client_plan_settings is not created by this repository, so a column
  // this migration names may not be there.
  const guards = (sql.match(/information_schema\.columns/g) || []).length;
  assert.ok(guards >= 2, 'both comment blocks must check before they comment');
});

test('the mixed units are documented for humans as well', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'billing-models.md'), 'utf8');
  assert.match(doc, /mixed units/i);
  const contract = fs.readFileSync(path.join(ROOT, 'docs', 'billing-frontend-contract.md'), 'utf8');
  assert.match(contract, /Money units are mixed/i);
});
