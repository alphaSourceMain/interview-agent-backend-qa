'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

const routePath = path.join(__dirname, '..', 'routes', 'alphaScreenPackages.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.inFilters = []
    this.gteFilters = []
    this.insertPayload = null
  }

  select(columns) {
    this.selectColumns = columns
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value })
    return this
  }

  in(column, values) {
    this.inFilters.push({ column, values: new Set((values || []).map(String)) })
    return this
  }

  gte(column, value) {
    this.gteFilters.push({ column, value })
    return this
  }

  order() {
    return this
  }

  limit() {
    return this
  }

  insert(payload) {
    this.insertPayload = payload
    return this
  }

  async maybeSingle() {
    if (this.db.lookupError) return { data: null, error: this.db.lookupError }
    const existing = this.db.existingIntent || null
    return { data: existing, error: null }
  }

  async single() {
    if (this.db.insertError) return { data: null, error: this.db.insertError }
    const row = {
      id: this.db.nextId || 'intent-1',
      ...this.insertPayload
    }
    this.db.inserts.push({ table: this.table, row })
    return { data: row, error: null }
  }
}

function makeDb(options = {}) {
  const db = {
    nextId: options.nextId || 'intent-1',
    existingIntent: options.existingIntent || null,
    lookupError: options.lookupError || null,
    insertError: options.insertError || null,
    inserts: [],
    touchedTables: [],
    from(table) {
      db.touchedTables.push(table)
      return new FakeQuery(db, table)
    }
  }
  return db
}

function buildApp(db, env = {}) {
  delete require.cache[routePath]
  delete require.cache[supabaseClientPath]
  const previous = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  injectModule(supabaseClientPath, { supabaseAdmin: db })
  const router = require(routePath)
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const app = express()
  app.use(express.json())
  app.use('/api/alphascreen', router)
  return app
}

async function request(app, body, headers = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/alphascreen/purchase-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function validBody(overrides = {}) {
  return {
    plan_key: 'basic',
    billing_cadence: 'monthly',
    company_legal_name: 'Acme Dental Group',
    company_dba: 'Acme Dental',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: 'alex@acmedental.example',
    buyer_phone: '+1 (555) 123-4567',
    buyer_title: 'Director of Operations',
    source_path: '/alphascreen/pricing?utm_source=test',
    agreement_acknowledged: true,
    contact_acknowledged: true,
    raw_payload: { must: 'not store' },
    anonymous_id: 'anon-secret',
    session_id: 'session-secret',
    ...overrides
  }
}

test('valid Basic monthly intent creates pending intent with central package snapshot', async () => {
  const db = makeDb({ nextId: 'intent-basic' })
  const response = await request(buildApp(db), validBody())

  assert.equal(response.status, 201)
  assert.equal(response.body.purchase_intent_id, 'intent-basic')
  assert.equal(response.body.status, 'pending')
  assert.equal(response.body.selected_package.plan_key, 'basic')
  assert.equal(response.body.selected_package.billing_cadence, 'monthly')
  assert.equal(response.body.selected_package.platform_fee, 299)
  assert.equal(response.body.selected_package.platform_fee_cents, 29900)
  assert.equal(response.body.selected_package.platform_monthly_fee, 299)
  assert.equal(response.body.selected_package.platform_annual_fee, 3229.2)
  assert.equal(response.body.selected_package.annual_discount_percent, 10)
  assert.equal(response.body.selected_package.included_interviews, 20)
  assert.equal(response.body.selected_package.interview_duration_minutes, 10)
  assert.equal(response.body.selected_package.additional_interview_price, 30)
  assert.equal(response.body.selected_package.per_role_fee, 399)

  assert.equal(db.inserts.length, 1)
  const row = db.inserts[0].row
  assert.equal(row.selected_plan_key, 'basic')
  assert.equal(row.selected_billing_cadence, 'monthly')
  assert.equal(row.status, 'pending')
  assert.equal(row.source_path, '/alphascreen/pricing')
  assert.equal(row.agreement_id, null)
  assert.equal(row.stripe_checkout_session_id, null)
  assert.equal(row.client_id, null)
  assert.equal(row.package_snapshot.included_interviews, 20)
  assert.equal(row.package_snapshot.platform_fee, 299)
  assert.equal(row.package_snapshot.platform_fee_cents, 29900)
  assert.equal(row.package_snapshot.platform_fee_billing_cadence, 'monthly')
  assert.equal(row.package_snapshot.platform_monthly_fee, 299)
  assert.equal(row.package_snapshot.platform_annual_fee, 3229.2)
  assert.equal(row.package_snapshot.per_role_fee, 399)
})

test('valid Pro annual intent creates pending intent when annual cadence is supported', async () => {
  const db = makeDb({ nextId: 'intent-pro' })
  const response = await request(buildApp(db), validBody({
    plan_key: 'pro',
    billing_cadence: 'annual',
    buyer_email: 'buyer@company.example'
  }))

  assert.equal(response.status, 201)
  assert.equal(response.body.selected_package.plan_key, 'pro')
  assert.equal(response.body.selected_package.billing_cadence, 'annual')
  assert.equal(response.body.selected_package.platform_fee, 6469.2)
  assert.equal(response.body.selected_package.platform_fee_cents, 646920)
  assert.equal(response.body.selected_package.platform_monthly_fee, 599)
  assert.equal(response.body.selected_package.platform_annual_fee, 6469.2)
  assert.equal(response.body.selected_package.annual_discount_percent, 10)
  assert.equal(response.body.selected_package.included_interviews, 30)
  assert.equal(response.body.selected_package.max_interview_minutes, 12)
  assert.equal(response.body.selected_package.additional_interview_fee, 35)
  assert.equal(db.inserts[0].row.package_snapshot.per_role_fee, 699)
  assert.equal(db.inserts[0].row.package_snapshot.platform_fee, 6469.2)
  assert.equal(db.inserts[0].row.package_snapshot.platform_fee_billing_cadence, 'annual')
})

test('invalid purchase intent inputs are rejected before insert', async () => {
  const cases = [
    [{ plan_key: 'enterprise' }, 'invalid_plan'],
    [{ billing_cadence: 'weekly' }, 'invalid_billing_cadence'],
    [{ buyer_email: 'not-an-email' }, 'invalid_email'],
    [{ buyer_email: 'buyer@gmail.com' }, 'invalid_email'],
    [{ company_legal_name: '' }, 'required_fields_missing']
  ]

  for (const [override, code] of cases) {
    const db = makeDb()
    const response = await request(buildApp(db), validBody(override))
    assert.equal(response.status, 400)
    assert.equal(response.body.code, code)
    assert.equal(db.inserts.length, 0)
  }
})

test('long strings are bounded before storage', async () => {
  const db = makeDb()
  const response = await request(buildApp(db), validBody({
    company_legal_name: 'C'.repeat(260),
    company_dba: 'D'.repeat(260),
    buyer_first_name: 'F'.repeat(140),
    buyer_last_name: 'L'.repeat(140),
    buyer_title: 'T'.repeat(180),
    buyer_phone: '+1 (555) 123-4567 ext raw text that should be bounded'
  }))

  assert.equal(response.status, 201)
  const row = db.inserts[0].row
  assert.equal(row.company_legal_name.length, 160)
  assert.equal(row.company_dba.length, 160)
  assert.equal(row.buyer_first_name.length, 80)
  assert.equal(row.buyer_last_name.length, 80)
  assert.equal(row.buyer_title.length, 120)
  assert.ok(row.buyer_phone.length <= 40)
})

test('purchase intent endpoint stores and returns no raw payload, session, IP, user-agent, client, user, agreement, or Stripe records', async () => {
  const db = makeDb()
  const response = await request(buildApp(db), validBody(), {
    'x-forwarded-for': '203.0.113.10',
    'user-agent': 'raw-test-agent'
  })

  assert.equal(response.status, 201)
  assert.deepEqual(Array.from(new Set(db.touchedTables)), ['public_purchase_intents'])
  assert.equal(db.inserts[0].row.client_id, null)
  assert.equal(db.inserts[0].row.agreement_id, null)
  assert.equal(db.inserts[0].row.stripe_checkout_session_id, null)
  const serializedRow = JSON.stringify(db.inserts[0].row)
  const serializedResponse = JSON.stringify(response.body)
  assert.doesNotMatch(serializedRow, /raw_payload|anon-secret|session-secret|203\.0\.113\.10|raw-test-agent|client_members|membership_agreements|stripe_customer|stripe_subscription/i)
  assert.doesNotMatch(serializedResponse, /raw_payload|anon-secret|session-secret|203\.0\.113\.10|raw-test-agent|buyer_email|company_legal_name/i)
})

test('duplicate pending intent returns existing safe response without inserting', async () => {
  const db = makeDb({
    existingIntent: {
      id: 'existing-intent',
      status: 'pending',
      selected_plan_key: 'basic',
      selected_billing_cadence: 'monthly',
      package_snapshot: {
        plan_key: 'basic',
        display_name: 'Basic',
        billing_cadence: 'monthly',
        platform_fee: 299,
        platform_fee_cents: 29900,
        platform_fee_billing_cadence: 'monthly',
        platform_monthly_fee: 299,
        platform_monthly_fee_cents: 29900,
        platform_annual_fee: 3229.2,
        platform_annual_fee_cents: 322920,
        annual_discount_percent: 10,
        included_interviews: 20,
        included_interviews_per_role: 20,
        interview_duration_minutes: 10,
        max_interview_minutes: 10,
        additional_interview_price: 30,
        additional_interview_fee: 30,
        overage_price: 30,
        per_role_fee: 399
      }
    }
  })
  const response = await request(buildApp(db), validBody())

  assert.equal(response.status, 200)
  assert.equal(response.body.purchase_intent_id, 'existing-intent')
  assert.equal(response.body.duplicate, true)
  assert.equal(db.inserts.length, 0)
})

test('purchase intent endpoint rate limits repeated requests', async () => {
  const db = makeDb()
  const app = buildApp(db, { ALPHASCREEN_PURCHASE_INTENT_RATE_MAX: '1' })

  const first = await request(app, validBody({ buyer_email: 'one@company.example' }), { 'x-forwarded-for': '198.51.100.20' })
  const second = await request(app, validBody({ buyer_email: 'two@company.example' }), { 'x-forwarded-for': '198.51.100.20' })

  assert.equal(first.status, 201)
  assert.equal(second.status, 429)
  assert.equal(second.body.code, 'RATE_LIMIT_EXCEEDED')
})
