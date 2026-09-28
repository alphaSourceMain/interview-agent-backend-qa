'use strict';

// The interview-credits migration, asserted as text.
//
// The invariant that matters most is structural and enforced by an index rather
// than by application code: one live credit per closed role. The other thing
// pinned here is an absence — a credit stores what it was minted with and
// nothing about what is left of it, because that is derived from the interviews
// charged to it. A balance column would be a second source of truth.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260921130000_interview_credits.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

test('the table is created idempotently', () => {
  assert.match(sql, /create table if not exists public\.interview_credits/i);
});

test('a credit cannot be minted with a non-positive quantity', () => {
  assert.match(sql, /constraint interview_credits_quantity_check check \(quantity > 0\)/i);
});

test('a credit records where it came from and when it lapses', () => {
  for (const column of ['client_id uuid not null', 'source_role_id uuid not null', 'expires_at timestamptz not null', 'revoked_at timestamptz null']) {
    assert.match(sql, new RegExp(column.replace(/ /g, '\\s+'), 'i'), `missing column: ${column}`);
  }
});

test('a closed role can hold only one live credit', () => {
  assert.match(
    sql,
    /create unique index if not exists interview_credits_source_role_uidx[\s\S]*?on public\.interview_credits \(source_role_id\)[\s\S]*?where revoked_at is null/i,
    'a repeated close must not mint a second credit, but a revoked credit must not block a later one'
  );
});

test('nothing stores what is left of a credit', () => {
  assert.doesNotMatch(sql, /\bremaining\b/i,
    'a balance column would drift from the interviews it is meant to describe');
  assert.doesNotMatch(sql, /interview_credit_draws/i,
    'which interviews a credit paid for is derived, not recorded');
  assert.doesNotMatch(sql, /rollover_drawn_offset/i,
    'the reopened role reduction is derived from the revoked credit, not stored on the role');
});

test('the migration changes no table this repository does not define', () => {
  assert.doesNotMatch(sql, /alter table public\.roles/i,
    'public.roles carries an access model from outside this repository');
});

test('the index the credit lookup needs is present', () => {
  assert.match(sql, /create index if not exists interview_credits_client_expires_at_idx[\s\S]*?\(client_id, expires_at\)/i);
});

test('the table is row-level secured and service-role only', () => {
  assert.match(sql, /alter table public\.interview_credits enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.interview_credits\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.interview_credits[\s\S]*?to service_role/i);
});

test('the migration grants nothing to anon or authenticated', () => {
  const grants = sql.match(/grant[\s\S]*?;/gi) || [];
  for (const grant of grants) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i,
      `unexpected non-service-role grant: ${grant}`);
  }
});
