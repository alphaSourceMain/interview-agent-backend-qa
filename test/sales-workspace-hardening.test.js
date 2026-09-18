'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { promotionEligibilityError } = require('../routes/sales')

test('sales promotion validation rejects restrictions that cannot be honored before checkout', () => {
  const pricing = { platform_fee_cents: 29900, first_role_prepay_cents: 0 }
  assert.match(
    promotionEligibilityError({ restrictions: { first_time_transaction: true } }, pricing),
    /customer history/i
  )
  assert.match(
    promotionEligibilityError({ restrictions: { minimum_amount: 40000, minimum_amount_currency: 'usd' } }, pricing),
    /minimum/i
  )
  assert.match(
    promotionEligibilityError({ coupon: { applies_to: { products: ['prod_restricted'] } } }, pricing),
    /product-restricted/i
  )
  assert.equal(promotionEligibilityError({ restrictions: {} }, pricing), '')
})

test('sales migration prevents preview reuse and concurrent active buyer duplicates', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260918195401_sales_workspace.sql'), 'utf8')
  assert.match(sql, /add column if not exists sales_preview_id uuid references public\.sales_deal_previews\(id\)/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_sales_preview_uidx/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_active_sales_buyer_uidx[\s\S]*lower\(buyer_email\)[\s\S]*channel = 'sales_assisted'/i)
})

test('agreement checkout webhooks do not fall through to generic client activation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhookStripe.js'), 'utf8')
  assert.match(source, /if \(!isPaidAgreementCheckout\) \{[\s\S]*buildClientSubscriptionUpdatesFromStripe/i)
  assert.match(source, /const isAgreementCheckoutInvoice =[\s\S]*metadataSource === 'agreement_checkout'/i)
  assert.match(source, /customerId && !isManagedSubscriptionInvoice && !isAgreementCheckoutInvoice/i)
})
