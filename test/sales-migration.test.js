'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260918195401_sales_workspace.sql')
const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()

test('sales migration keeps browser access behind service-role routes', () => {
  for (const table of ['sales_reps', 'sales_deal_previews', 'sales_deal_events', 'sales_enterprise_handoffs', 'sales_idempotency_keys']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`))
  }
})

test('sales migration adds ownership, GHL, promotion, and payment-start fields', () => {
  for (const field of ['created_by_user_id', 'ghl_contact_id', 'ghl_opportunity_id', 'promotion_code_id', 'term_start_basis', 'activated_at']) {
    assert.match(sql, new RegExp(`add column if not exists ${field}`))
  }
})
