'use strict';

// Zero included interviews per role on an Enterprise agreement.
//
// Enterprise pricing is meant to be fully configurable, and nought included per
// role is a real setting: the client is billed from their interview pool and
// then the meter, from the first interview. The agreement path could not express
// it — the normalizer treated anything below one as absent, and the checkout
// route then refused the agreement as missing a required field. The admin route
// (POST /admin/clients/:id/subscription-checkout) always allowed it, so the two
// paths disagreed.
//
// These tests walk the same chain the finding named: the Agreement Generator's
// values → template_snapshot → buildAgreementInputFromRow → the public checkout
// route's required-field guard → the fees handed to Stripe.
//
// Supabase and Stripe are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const agreementServicePath = path.join(ROOT, 'src', 'services', 'membershipAgreements', 'index.js');
const checkoutRoutePath = path.join(ROOT, 'src', 'routes', 'public', 'membershipAgreements', 'checkout.js');
const rendererPath = path.join(ROOT, 'src', 'render', 'membershipAgreement.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });

const { normalizeMembershipAgreementInput } = require(rendererPath);

// What the Agreement Generator stores for an Enterprise client who has no
// included interviews and runs on a pool plus the meter.
const ZERO_INCLUDED_VALUES = Object.freeze({
  client_id: 'client_1',
  client_legal_name: 'Acme Dental Group',
  primary_admin_name: 'Alex Rivera',
  admin_email: 'alex@acmedental.example',
  membership_tier: 'enterprise',
  billing_option: 'monthly',
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: 0,
  additional_interview_fee: '0',
  usage_interview_fee_cents: 2500,
  pool_quantity: 50,
  initial_term_start: '2026-10-01',
  initial_renewal_date: '2027-10-01'
});

// --- the normalizer --------------------------------------------------------

test('zero included interviews survives the normalizer, as a number or a string', () => {
  for (const zero of [0, '0']) {
    const normalized = normalizeMembershipAgreementInput({
      ...ZERO_INCLUDED_VALUES, included_interviews_per_role: zero
    });
    assert.equal(normalized.included_interviews_per_role, '0',
      `${JSON.stringify(zero)} is a setting, not an absence`);
  }
});

test('an absent included count is still absent, so a missing field is still caught', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const normalized = normalizeMembershipAgreementInput({
      ...ZERO_INCLUDED_VALUES, included_interviews_per_role: missing
    });
    assert.equal(normalized.included_interviews_per_role, '');
  }
});

test('a zero Enterprise fee sent as a number is kept too', () => {
  // The same `||` that dropped the included count dropped a numeric zero fee.
  const normalized = normalizeMembershipAgreementInput({
    ...ZERO_INCLUDED_VALUES, per_role_fee: 0, additional_interview_fee: 0
  });

  assert.equal(normalized.per_role_fee, '0');
  assert.equal(normalized.additional_interview_fee, '0');
});

test('the camel-case key the admin form may send is accepted at zero', () => {
  const normalized = normalizeMembershipAgreementInput({
    ...ZERO_INCLUDED_VALUES,
    included_interviews_per_role: undefined,
    includedInterviewsPerRole: 0
  });

  assert.equal(normalized.included_interviews_per_role, '0');
});

test('a negative included count is refused rather than stored', () => {
  const normalized = normalizeMembershipAgreementInput({
    ...ZERO_INCLUDED_VALUES, included_interviews_per_role: -5
  });

  assert.equal(normalized.included_interviews_per_role, '');
});

// --- the checkout route ----------------------------------------------------

// The route stamps the agreement after the session is created. Nothing here
// tests that, so every builder returns itself and the result is always empty.
function chainableQuery() {
  const result = { data: null, error: null };
  const query = new Proxy({}, {
    get(_target, key) {
      // Awaiting the chain, with or without a terminator, succeeds with nothing.
      if (key === 'then') return (resolve) => Promise.resolve(result).then(resolve);
      if (key === 'maybeSingle' || key === 'single') return async () => result;
      return () => query;
    }
  });
  return query;
}

function agreementRow(values) {
  return {
    id: 'agreement_1',
    client_id: 'client_1',
    status: 'signed',
    is_current: true,
    checkout_status: null,
    agreement_expires_at: null,
    membership_tier: 'enterprise',
    billing_option: 'monthly',
    template_snapshot: { values }
  };
}

// The route reaches everything through one service module, so the real
// normalizer and the real buildAgreementInputFromRow stay in place and only the
// database, Stripe and the guards around them are replaced.
function loadApp(values, calls) {
  for (const p of [checkoutRoutePath, agreementServicePath, rendererPath]) delete require.cache[p];
  const realService = require(agreementServicePath);

  injectModule(agreementServicePath, {
    ...realService,
    publicAgreementTokenRateLimit: (req, res, next) => next(),
    readToken: () => 'token',
    hashToken: (token) => `hash:${token}`,
    loadAgreementByTokenHash: async () => agreementRow(values),
    isPublicPurchaseIntentAgreement: () => false,
    wantsEmbeddedCheckout: () => false,
    isExpired: () => false,
    requireParentAgreementClient: async () => ({ ok: true, clientId: 'client_1' }),
    createSubscriptionCheckoutSession: async (payload) => {
      calls.push(payload);
      return { session: { id: 'cs_1', url: 'https://checkout.test/cs_1' } };
    },
    supabaseAdmin: { from: () => chainableQuery() }
  });

  delete require.cache[checkoutRoutePath];
  const app = express();
  app.use(express.json());
  app.use('/public/membership-agreements', require(checkoutRoutePath));
  return app;
}

test('a zero-included Enterprise agreement reaches checkout', async () => {
  const calls = [];
  const app = loadApp(ZERO_INCLUDED_VALUES, calls);

  const res = await request(app)
    .post('/public/membership-agreements/checkout-session')
    .send({ token: 'token' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1, 'the agreement is not refused before Stripe is reached');
  assert.equal(calls[0].planTier, 'enterprise');
  assert.equal(calls[0].enterpriseFees.included_interviews_per_role, '0');
  assert.equal(calls[0].enterpriseFees.usage_interview_fee_cents, 2500,
    'a pool-and-meter client still carries its per-interview price');
});

test('an agreement with no included count at all is still refused', async () => {
  const calls = [];
  const app = loadApp({ ...ZERO_INCLUDED_VALUES, included_interviews_per_role: '' }, calls);

  const res = await request(app)
    .post('/public/membership-agreements/checkout-session')
    .send({ token: 'token' });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'invalid_enterprise_checkout_fields');
  assert.deepEqual(calls, [], 'an incomplete agreement must not reach Stripe');
});
