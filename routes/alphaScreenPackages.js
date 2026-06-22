'use strict'

const express = require('express')
const { supabaseAdmin } = require('../src/lib/supabaseClient')
const {
  buildAlphaScreenPackageSnapshot,
  isAlphaScreenBillingCadenceSupported,
  listPublicAlphaScreenPackages,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('../src/lib/alphaScreenPackages')

const router = express.Router()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PERSONAL_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'ymail.com'
])
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = Number(process.env.ALPHASCREEN_PURCHASE_INTENT_RATE_MAX || 12)
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000
const INTENT_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000
const rateBuckets = new Map()

function rateLimit(req, res, next) {
  const now = Date.now()
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown'
  const current = rateBuckets.get(ip)
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : current
  bucket.count += 1
  rateBuckets.set(ip, bucket)
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      request_id: req.request_id || null
    })
  }
  return next()
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max)
}

function cleanPhone(value) {
  const raw = trimText(value, 40)
  return raw ? raw.replace(/[^\d+().\-\s]/g, '').slice(0, 40).trim() : ''
}

function cleanPath(value) {
  const raw = trimText(value, 500)
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com')
    return trimText(url.pathname || '/', 300)
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300)
  }
}

function isBusinessEmail(value) {
  const email = trimText(value, 254).toLowerCase()
  if (!EMAIL_RE.test(email)) return false
  const domain = email.split('@')[1] || ''
  return Boolean(domain && !PERSONAL_EMAIL_DOMAINS.has(domain))
}

function validationError(res, req, code, detail, fields = []) {
  return res.status(400).json({
    error: code,
    code,
    detail,
    fields,
    request_id: req.request_id || null
  })
}

function normalizePurchaseIntentInput(body = {}) {
  const rawPlanKey = trimText(body.plan_key || body.plan || body.selected_plan_key, 40).toLowerCase()
  const rawBillingCadence = trimText(body.billing_cadence || body.billing_interval || body.selected_billing_cadence, 40).toLowerCase()
  const planKey = normalizeAlphaScreenPlanKey(rawPlanKey)
  const billingCadence = normalizeBillingInterval(rawBillingCadence)
  const buyerEmail = trimText(body.buyer_email || body.email, 254).toLowerCase()

  return {
    raw_plan_key: rawPlanKey,
    raw_billing_cadence: rawBillingCadence,
    selected_plan_key: planKey,
    selected_billing_cadence: billingCadence,
    company_legal_name: trimText(body.company_legal_name || body.companyLegalName, 160),
    company_dba: trimText(body.company_dba || body.companyDba, 160),
    buyer_first_name: trimText(body.buyer_first_name || body.first_name || body.firstName, 80),
    buyer_last_name: trimText(body.buyer_last_name || body.last_name || body.lastName, 80),
    buyer_email: buyerEmail,
    buyer_phone: cleanPhone(body.buyer_phone || body.phone),
    buyer_title: trimText(body.buyer_title || body.title, 120),
    source_path: cleanPath(body.source_path || body.path),
    agreement_acknowledged: body.agreement_acknowledged === true,
    contact_acknowledged: body.contact_acknowledged === true
  }
}

function validatePurchaseIntentInput(input) {
  const missing = []
  if (!input.raw_plan_key) missing.push('plan_key')
  if (!input.raw_billing_cadence) missing.push('billing_cadence')
  if (!input.company_legal_name) missing.push('company_legal_name')
  if (!input.buyer_first_name) missing.push('buyer_first_name')
  if (!input.buyer_last_name) missing.push('buyer_last_name')
  if (!input.buyer_email) missing.push('buyer_email')
  if (!input.agreement_acknowledged) missing.push('agreement_acknowledged')
  if (!input.contact_acknowledged) missing.push('contact_acknowledged')
  if (missing.length) {
    return {
      ok: false,
      code: 'required_fields_missing',
      detail: 'Required purchase intent fields are missing.',
      fields: missing
    }
  }
  if (!['basic', 'pro'].includes(input.selected_plan_key)) {
    return { ok: false, code: 'invalid_plan', detail: 'Plan must be basic or pro.', fields: ['plan_key'] }
  }
  if (!input.selected_billing_cadence) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isAlphaScreenBillingCadenceSupported(input.selected_plan_key, input.selected_billing_cadence)) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isBusinessEmail(input.buyer_email)) {
    return { ok: false, code: 'invalid_email', detail: 'A valid work email is required.', fields: ['buyer_email'] }
  }
  return { ok: true }
}

function safePackageSummary(snapshot = {}) {
  return {
    plan_key: snapshot.plan_key || null,
    display_name: snapshot.display_name || null,
    billing_cadence: snapshot.billing_cadence || null,
    included_interviews: snapshot.included_interviews ?? null,
    included_interviews_per_role: snapshot.included_interviews_per_role ?? null,
    interview_duration_minutes: snapshot.interview_duration_minutes ?? null,
    max_interview_minutes: snapshot.max_interview_minutes ?? null,
    additional_interview_price: snapshot.additional_interview_price ?? null,
    additional_interview_fee: snapshot.additional_interview_fee ?? null,
    overage_price: snapshot.overage_price ?? null,
    per_role_fee: snapshot.per_role_fee ?? null
  }
}

function buildPurchaseIntentResponse(row, { duplicate = false } = {}) {
  const snapshot = row?.package_snapshot && typeof row.package_snapshot === 'object' ? row.package_snapshot : {}
  return {
    purchase_intent_id: row?.id || null,
    status: row?.status || 'pending',
    duplicate,
    selected_package: safePackageSummary(snapshot),
    next_step_message: duplicate
      ? 'A pending purchase request already exists for this company and package. The next step is membership agreement preparation.'
      : 'Purchase request received. The next step is membership agreement preparation.',
    request_id: row?.request_id || null
  }
}

router.get('/packages', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  return res.json({
    packages: listPublicAlphaScreenPackages(),
    request_id: req.request_id || null
  })
})

router.post('/purchase-intents', rateLimit, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const input = normalizePurchaseIntentInput(req.body || {})
    const validation = validatePurchaseIntentInput(input)
    if (!validation.ok) {
      return validationError(res, req, validation.code, validation.detail, validation.fields)
    }

    const packageSnapshot = buildAlphaScreenPackageSnapshot(input.selected_plan_key, input.selected_billing_cadence)
    if (!packageSnapshot) {
      return validationError(
        res,
        req,
        'package_snapshot_unavailable',
        'Package configuration is not available for this selection.',
        ['plan_key', 'billing_cadence']
      )
    }

    const duplicateCutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    const { data: existingIntent, error: duplicateErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,created_at')
      .eq('buyer_email', input.buyer_email)
      .eq('company_legal_name', input.company_legal_name)
      .eq('selected_plan_key', input.selected_plan_key)
      .eq('selected_billing_cadence', input.selected_billing_cadence)
      .in('status', ['pending'])
      .gte('created_at', duplicateCutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (duplicateErr) {
      console.error('[alphascreen/purchase-intents] duplicate_lookup_failed:', duplicateErr.message || duplicateErr)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: 'PURCHASE_INTENT_LOOKUP_FAILED',
        request_id
      })
    }

    if (existingIntent?.id) {
      const body = buildPurchaseIntentResponse(existingIntent, { duplicate: true })
      body.request_id = request_id
      return res.status(200).json(body)
    }

    const nowIso = new Date().toISOString()
    const insertPayload = {
      status: 'pending',
      selected_plan_key: input.selected_plan_key,
      selected_billing_cadence: input.selected_billing_cadence,
      package_snapshot: packageSnapshot,
      company_legal_name: input.company_legal_name,
      company_dba: input.company_dba || null,
      buyer_first_name: input.buyer_first_name,
      buyer_last_name: input.buyer_last_name,
      buyer_email: input.buyer_email,
      buyer_phone: input.buyer_phone || null,
      buyer_title: input.buyer_title || null,
      source_path: input.source_path || null,
      agreement_id: null,
      stripe_checkout_session_id: null,
      client_id: null,
      expires_at: new Date(Date.now() + INTENT_EXPIRATION_MS).toISOString(),
      created_at: nowIso,
      updated_at: nowIso
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .insert(insertPayload)
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,created_at')
      .single()

    if (insertErr) {
      console.error('[alphascreen/purchase-intents] insert_failed:', insertErr.message || insertErr)
      return res.status(503).json({
        error: 'purchase_intent_create_failed',
        code: 'PURCHASE_INTENT_CREATE_FAILED',
        request_id
      })
    }

    const body = buildPurchaseIntentResponse(inserted, { duplicate: false })
    body.request_id = request_id
    return res.status(201).json(body)
  } catch (e) {
    console.error('[alphascreen/purchase-intents] unexpected:', e?.message || e)
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id
    })
  }
})

router._test = {
  normalizePurchaseIntentInput,
  validatePurchaseIntentInput,
  safePackageSummary,
  buildPurchaseIntentResponse
}

module.exports = router
