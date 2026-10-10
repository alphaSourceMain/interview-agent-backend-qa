'use strict';

// Volume pricing for the Enterprise interview pool.
//
// The rule is "the highest threshold at or below the quantity wins", so the
// cases that matter are the boundaries: exactly on a threshold, one either side,
// and below the lowest. A missing or unreadable threshold must charge list
// price — undercharging silently is worse than charging full and being told.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const { priceEnterprisePool } = require(path.join(ROOT, 'src', 'services', 'enterprisePoolPricing.js'));

// The seeded thresholds, as the migration inserts them.
const SEEDED = [
  { id: 'd1', min_quantity: 20, discount_pct: 0 },
  { id: 'd2', min_quantity: 30, discount_pct: 5 },
  { id: 'd3', min_quantity: 50, discount_pct: 10 }
];

const makeDb = (rows = SEEDED) => createFakeSupabase({ enterprise_pool_discounts: rows });

const price = (quantity, unitPriceCents = 2500, rows) =>
  priceEnterprisePool({ db: makeDb(rows), quantity, unitPriceCents });

// --- the thresholds -------------------------------------------------------

test('exactly on a threshold takes that threshold', async () => {
  assert.equal((await price(20)).discount_pct, 0);
  assert.equal((await price(30)).discount_pct, 5);
  assert.equal((await price(50)).discount_pct, 10);
});

test('one above a threshold stays on it', async () => {
  assert.equal((await price(21)).discount_pct, 0);
  assert.equal((await price(31)).discount_pct, 5);
  assert.equal((await price(51)).discount_pct, 10);
});

test('one below a threshold takes the one under it', async () => {
  assert.equal((await price(29)).discount_pct, 0, 'still in the 20 band');
  assert.equal((await price(49)).discount_pct, 5, 'still in the 30 band');
});

test('a quantity below the lowest threshold gets no discount', async () => {
  const result = await price(19);
  assert.equal(result.discount_pct, 0);
  assert.equal(result.threshold_min, null, 'no threshold applied at all');
  assert.equal(result.total_cents, 19 * 2500);
});

test('a hundred takes the top band', async () => {
  const result = await price(100);
  assert.equal(result.discount_pct, 10);
  assert.equal(result.threshold_min, 50);
  assert.equal(result.total_cents, Math.round(100 * 2500 * 0.9));
  assert.equal(result.total_cents, 225000);
});

test('an empty threshold table charges list price', async () => {
  const result = await price(100, 2500, []);
  assert.equal(result.discount_pct, 0);
  assert.equal(result.threshold_min, null);
  assert.equal(result.total_cents, 250000);
});

test('the applied threshold is reported, not just the percentage', async () => {
  assert.equal((await price(45)).threshold_min, 30);
  assert.equal((await price(50)).threshold_min, 50);
});

// --- the arithmetic -------------------------------------------------------

test('the returned shape is the full quote', async () => {
  assert.deepEqual(await price(50, 2500), {
    quantity: 50,
    unit_price_cents: 2500,
    discount_pct: 10,
    discounted_unit_price_cents: 2250,
    total_cents: 112500,
    threshold_min: 50
  });
});

test('rounding lands on the total, not on each unit', async () => {
  // 33 x 333 = 10,989; less 5% = 10,439.55, which rounds to 10,440.
  // Rounding per unit first would give 316 x 33 = 10,428 — twelve cents adrift.
  const result = await price(33, 333);

  assert.equal(result.total_cents, 10440);
  assert.notEqual(result.total_cents, result.discounted_unit_price_cents * result.quantity);
});

test('a zero per-interview price is a real price and totals zero', async () => {
  const result = await price(50, 0);
  assert.equal(result.total_cents, 0);
  assert.equal(result.discount_pct, 10, 'the band still applies, it is just worth nothing');
});

test('no discount leaves the total exactly the list amount', async () => {
  const result = await price(25, 2500);
  assert.equal(result.total_cents, 62500);
  assert.equal(result.discounted_unit_price_cents, 2500);
});

// --- refusals -------------------------------------------------------------

test('a quantity that is not a positive whole number is refused', async () => {
  for (const quantity of [0, -5, 2.5, 'ten', null, undefined]) {
    await assert.rejects(
      () => price(quantity),
      /positive whole number/,
      `quantity ${JSON.stringify(quantity)} must be refused`
    );
  }
});

test('a unit price that is not whole cents is refused', async () => {
  for (const unitPrice of [-1, 25.5, 'free', null]) {
    await assert.rejects(
      () => price(50, unitPrice),
      /whole number of cents/,
      `unit price ${JSON.stringify(unitPrice)} must be refused`
    );
  }
});

test('pricing without a database is refused rather than guessed', async () => {
  await assert.rejects(
    () => priceEnterprisePool({ db: null, quantity: 50, unitPriceCents: 2500 }),
    /requires a database/
  );
});

test('an unreadable discount percentage charges list price and says so', async () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args);
  let result;
  try {
    result = await price(50, 2500, [{ id: 'd1', min_quantity: 50, discount_pct: 'half off' }]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.discount_pct, 0, 'never guess a discount');
  assert.equal(result.total_cents, 125000);
  assert.ok(lines.find(([message]) => message === 'enterprise_pool_discount_unreadable'));
});

// --- the migration --------------------------------------------------------

test('the migration pins the thresholds, the bounds and service-role access', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009170000_enterprise_pool_discounts.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.enterprise_pool_discounts/i);
  assert.match(sql, /min_quantity integer not null unique/i,
    'one row per threshold, so a re-run cannot duplicate a band');
  assert.match(sql, /discount_pct numeric\(5,2\) not null/i);
  assert.match(sql, /check \(discount_pct >= 0 and discount_pct <= 100\)/i);
  assert.match(sql, /check \(min_quantity > 0\)/i);
  assert.match(sql, /values \(20, 0\), \(30, 5\), \(50, 10\)/i);
  assert.match(sql, /on conflict \(min_quantity\) do nothing/i,
    're-running must not overwrite a percentage changed by hand');

  assert.match(sql, /alter table public\.enterprise_pool_discounts enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.enterprise_pool_discounts\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.enterprise_pool_discounts\s*\n?to service_role/i);

  for (const grant of (sql.match(/grant[\s\S]*?;/gi) || [])) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i, `unexpected grant: ${grant}`);
  }
});
