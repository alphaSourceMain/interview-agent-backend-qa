'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

const {
  buildAlphaScreenPlanSettingsPayload,
  getAlphaScreenPlanSettingsDefaults,
  getAlphaScreenStripePriceEnvName,
  getAlphaScreenStripePriceId,
  listPublicAlphaScreenPackages
} = require('../src/lib/alphaScreenPackages')

const routePath = path.join(__dirname, '..', 'routes', 'alphaScreenPackages.js')

async function request(app, pathname) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
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

function buildApp() {
  delete require.cache[routePath]
  const router = require(routePath)
  const app = express()
  app.use('/api/alphascreen', router)
  return app
}

test('central package config returns canonical Basic and Pro values', () => {
  assert.deepEqual(getAlphaScreenPlanSettingsDefaults('basic'), {
    per_role_fee: 399,
    included_interviews_per_role: 20,
    additional_interview_fee: 30,
    max_interview_minutes: 10
  })
  assert.deepEqual(getAlphaScreenPlanSettingsDefaults('pro'), {
    per_role_fee: 699,
    included_interviews_per_role: 30,
    additional_interview_fee: 35,
    max_interview_minutes: 12
  })
})

test('webhook Basic provisioning payload uses 20 interviews, 10 minutes, and $30 overage', () => {
  const payload = buildAlphaScreenPlanSettingsPayload({
    clientId: 'client-basic',
    planKey: 'basic',
    billingInterval: 'monthly'
  })

  assert.deepEqual(payload, {
    client_id: 'client-basic',
    plan_tier: 'basic',
    billing_interval: 'monthly',
    platform_fee: null,
    per_role_fee: 399,
    included_interviews_per_role: 20,
    additional_interview_fee: 30,
    max_interview_minutes: 10
  })
})

test('webhook Pro provisioning payload uses 30 interviews, 12 minutes, and $35 overage', () => {
  const payload = buildAlphaScreenPlanSettingsPayload({
    clientId: 'client-pro',
    planKey: 'pro',
    billingInterval: 'annual'
  })

  assert.deepEqual(payload, {
    client_id: 'client-pro',
    plan_tier: 'pro',
    billing_interval: 'annual',
    platform_fee: null,
    per_role_fee: 699,
    included_interviews_per_role: 30,
    additional_interview_fee: 35,
    max_interview_minutes: 12
  })
})

test('central package config defines Stripe price env var names without reading secrets', () => {
  assert.equal(getAlphaScreenStripePriceEnvName('basic', 'monthly'), 'STRIPE_PRICE_BASIC_MONTHLY')
  assert.equal(getAlphaScreenStripePriceEnvName('basic', 'annual'), 'STRIPE_PRICE_BASIC_ANNUAL')
  assert.equal(getAlphaScreenStripePriceEnvName('pro', 'monthly'), 'STRIPE_PRICE_PRO_MONTHLY')
  assert.equal(getAlphaScreenStripePriceEnvName('pro', 'annual'), 'STRIPE_PRICE_PRO_ANNUAL')
  assert.equal(getAlphaScreenStripePriceId('basic', 'monthly', { STRIPE_PRICE_BASIC_MONTHLY: 'price_test_basic_monthly' }), 'price_test_basic_monthly')
})

test('public package endpoint exposes safe package data and no Stripe secrets', async () => {
  const previousBasicMonthly = process.env.STRIPE_PRICE_BASIC_MONTHLY
  const previousProAnnual = process.env.STRIPE_PRICE_PRO_ANNUAL
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_test_basic_monthly_secret_value'
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_test_pro_annual_secret_value'
  try {
    const response = await request(buildApp(), '/api/alphascreen/packages')
    assert.equal(response.status, 200)
    assert.equal(Array.isArray(response.body.packages), true)
    assert.equal(response.body.packages.length, 2)

    const basic = response.body.packages.find((item) => item.plan_key === 'basic')
    const pro = response.body.packages.find((item) => item.plan_key === 'pro')
    assert.equal(basic.included_interviews, 20)
    assert.equal(basic.interview_duration_minutes, 10)
    assert.equal(basic.overage_price, 30)
    assert.equal(pro.included_interviews, 30)
    assert.equal(pro.interview_duration_minutes, 12)
    assert.equal(pro.overage_price, 35)

    const basicMonthly = basic.billing_cadences.find((item) => item.key === 'monthly')
    const proAnnual = pro.billing_cadences.find((item) => item.key === 'annual')
    assert.equal(basicMonthly.stripe_price_configured, true)
    assert.equal(proAnnual.stripe_price_configured, true)

    const serialized = JSON.stringify(response.body)
    assert.doesNotMatch(serialized, /price_test_basic_monthly_secret_value/)
    assert.doesNotMatch(serialized, /price_test_pro_annual_secret_value/)
    assert.doesNotMatch(serialized, /STRIPE_SECRET|sk_live|sk_test/)
  } finally {
    if (previousBasicMonthly === undefined) delete process.env.STRIPE_PRICE_BASIC_MONTHLY
    else process.env.STRIPE_PRICE_BASIC_MONTHLY = previousBasicMonthly
    if (previousProAnnual === undefined) delete process.env.STRIPE_PRICE_PRO_ANNUAL
    else process.env.STRIPE_PRICE_PRO_ANNUAL = previousProAnnual
  }
})

test('public package listing exposes price configuration flags, not price id values', () => {
  const packages = listPublicAlphaScreenPackages({
    env: {
      STRIPE_PRICE_BASIC_MONTHLY: 'price_test_basic_monthly',
      STRIPE_PRICE_PRO_MONTHLY: ''
    }
  })
  const basic = packages.find((item) => item.plan_key === 'basic')
  const pro = packages.find((item) => item.plan_key === 'pro')

  assert.equal(basic.billing_cadences.find((item) => item.key === 'monthly').stripe_price_configured, true)
  assert.equal(pro.billing_cadences.find((item) => item.key === 'monthly').stripe_price_configured, false)
  assert.doesNotMatch(JSON.stringify(packages), /price_test_basic_monthly|STRIPE_PRICE_/)
})
