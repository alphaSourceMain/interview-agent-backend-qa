'use strict';

const { supabaseAdmin } = require('./supabaseClient');
const { requireParentClient } = require('./clientBillingScope');
const {
  buildAlphaScreenPlanSettingsPayload,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('./alphaScreenPackages');
const { ensureUserAndSendRecovery, redactEmail } = require('./recoveryHelper');
const { sendMemberRecoveryEmail } = require('../../utils/mailer');
const { buildClientPwResetUrl } = require('../../config/urlConfig');

const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const PRIVILEGED_MEMBER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);

function pickId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function addMonthsToIso(isoValue, monthsToAdd) {
  if (!isoValue) return null;
  const d = new Date(isoValue);
  if (!Number.isFinite(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(monthsToAdd || 0));
  return d.toISOString();
}

function cleanText(value) {
  return String(value || '').trim();
}

function lowerEmail(value) {
  return cleanText(value).toLowerCase();
}

function getTemplateSnapshot(agreement) {
  return agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : {};
}

function getPackageSnapshot({ agreement, intent }) {
  const agreementSnapshot = getTemplateSnapshot(agreement);
  const snapshot = agreementSnapshot.package_snapshot && typeof agreementSnapshot.package_snapshot === 'object'
    ? agreementSnapshot.package_snapshot
    : null;
  if (snapshot) return snapshot;
  return intent?.package_snapshot && typeof intent.package_snapshot === 'object'
    ? intent.package_snapshot
    : null;
}

function publicPurchaseIntentIdFromAgreement(agreement) {
  const snapshot = getTemplateSnapshot(agreement);
  return cleanText(snapshot?.purchase_intent?.id || '');
}

function buildBuyerName(intent, agreement) {
  const first = cleanText(intent?.buyer_first_name);
  const last = cleanText(intent?.buyer_last_name);
  return `${first} ${last}`.trim() ||
    cleanText(agreement?.primary_admin_name) ||
    cleanText(intent?.buyer_email || agreement?.admin_email);
}

function buildClientName(intent, agreement) {
  return cleanText(intent?.company_legal_name) ||
    cleanText(agreement?.client_legal_name) ||
    cleanText(intent?.company_dba) ||
    'alphaScreen client';
}

function resolvePlanSelection({ agreement, intent, packageSnapshot, fallbackPlanTier, fallbackBillingInterval }) {
  const planKey = normalizeAlphaScreenPlanKey(
    packageSnapshot?.plan_key ||
    intent?.selected_plan_key ||
    agreement?.membership_tier ||
    fallbackPlanTier
  );
  const billingInterval = normalizeBillingInterval(
    packageSnapshot?.billing_cadence ||
    intent?.selected_billing_cadence ||
    agreement?.billing_option ||
    fallbackBillingInterval
  );

  if (!['basic', 'pro'].includes(planKey)) {
    const err = new Error('Public purchase agreement has an invalid membership key.');
    err.code = 'invalid_public_purchase_plan_key';
    throw err;
  }
  if (!billingInterval) {
    const err = new Error('Public purchase agreement has an invalid billing cadence.');
    err.code = 'invalid_public_purchase_billing_interval';
    throw err;
  }

  return { planKey, billingInterval };
}

async function loadPublicPurchaseIntent(db, agreement) {
  const agreementId = cleanText(agreement?.id);
  const snapshotIntentId = publicPurchaseIntentIdFromAgreement(agreement);
  if (snapshotIntentId) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,expires_at,created_at,updated_at')
      .eq('id', snapshotIntentId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
    if (data) return data;
  }

  if (!agreementId) return null;
  const { data, error } = await db
    .from('public_purchase_intents')
    .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,expires_at,created_at,updated_at')
    .eq('agreement_id', agreementId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
  return data || null;
}

async function ensureLinkedClient({ db, agreement, intent, planKey, billingInterval, fallbackClientId }) {
  const nowIso = new Date().toISOString();
  let clientId = cleanText(agreement?.client_id || intent?.client_id || fallbackClientId);
  if (!clientId) {
    const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
    const buyerName = buildBuyerName(intent, agreement);
    const { data: client, error: clientErr } = await db
      .from('clients')
      .insert({
        name: buildClientName(intent, agreement),
        email: buyerEmail,
        client_admin_name: buyerName || null,
        plan_tier: planKey,
        billing_interval: billingInterval,
        billing_status: 'inactive',
        subscription_status: 'incomplete',
        auto_renew: false
      })
      .select('id')
      .single();
    if (clientErr || !client?.id) throw new Error(clientErr?.message || 'Could not create public purchase client.');
    clientId = cleanText(client.id);
  }

  if (cleanText(agreement?.client_id) !== clientId) {
    const { error } = await db
      .from('membership_agreements')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', agreement.id);
    if (error) throw new Error(error.message || 'Agreement client link failed');
    agreement.client_id = clientId;
  }

  if (intent?.id && cleanText(intent.client_id) !== clientId) {
    const { error } = await db
      .from('public_purchase_intents')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', intent.id);
    if (error) throw new Error(error.message || 'Public purchase intent client link failed');
    intent.client_id = clientId;
  }

  return clientId;
}

function buildClientActivationPayload({ agreement, subscription, planKey, billingInterval, fallbackCustomerId, fallbackSubscriptionId }) {
  const status = cleanText(subscription?.status).toLowerCase();
  const isLive = LIVE_SUBSCRIPTION_STATUSES.has(status);
  const cancelAtTermEnd = subscription?.cancel_at_period_end === true;
  const currentTermEnd = toIsoFromUnixSeconds(
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null
  );
  const contractStartAt = toIsoFromUnixSeconds(subscription?.start_date) || new Date().toISOString();
  const contractEndAt = addMonthsToIso(contractStartAt, 12);
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const stripeBillingInterval = normalizeBillingInterval(intervalRaw);

  return {
    stripe_customer_id: pickId(subscription?.customer) || cleanText(fallbackCustomerId) || null,
    stripe_subscription_id: pickId(subscription?.id) || cleanText(fallbackSubscriptionId) || null,
    subscription_status: isLive ? status : 'active',
    billing_status: 'active',
    billing_interval: stripeBillingInterval || billingInterval,
    plan_tier: planKey,
    current_term_end: currentTermEnd || contractEndAt,
    cancel_at_term_end: isLive ? cancelAtTermEnd : false,
    auto_renew: typeof agreement?.auto_renew === 'boolean' ? agreement.auto_renew : (isLive ? !cancelAtTermEnd : true),
    cancel_effective_at: null,
    contract_start_at: contractStartAt,
    contract_end_at: contractEndAt
  };
}

async function findAuthUserByEmail(authAdmin, email, logger = console) {
  const normalizedEmail = cleanText(email);
  const emailLower = normalizedEmail.toLowerCase();
  if (!authAdmin?.listUsers || !emailLower) return null;
  try {
    const { data, error } = await authAdmin.listUsers({ email: normalizedEmail });
    if (error) {
      logger.error?.('[public-purchase-activation] list_users_failed', {
        email: redactEmail(normalizedEmail),
        error: error.message || error
      });
      return null;
    }
    return (data?.users || []).find((user) => lowerEmail(user?.email) === emailLower) || null;
  } catch (error) {
    logger.error?.('[public-purchase-activation] list_users_exception', {
      email: redactEmail(normalizedEmail),
      error: error?.message || error
    });
    return null;
  }
}

async function loadExistingMembership(db, clientId, email, userId) {
  const { data, error } = await db
    .from('client_members')
    .select('client_id,user_id,email,name,role')
    .eq('client_id', clientId);
  if (error) throw new Error(error.message || 'Client member lookup failed');

  const emailLower = lowerEmail(email);
  const normalizedUserId = cleanText(userId);
  return (data || []).find((row) => {
    const rowEmail = lowerEmail(row?.email);
    const rowUserId = cleanText(row?.user_id);
    return (emailLower && rowEmail === emailLower) || (normalizedUserId && rowUserId === normalizedUserId);
  }) || null;
}

function managerRoleFor(existingRole) {
  const role = cleanText(existingRole).toLowerCase();
  return PRIVILEGED_MEMBER_ROLES.has(role) ? role : 'manager';
}

async function upsertBuyerMembership({ db, clientId, email, name, userId }) {
  const existing = await loadExistingMembership(db, clientId, email, userId);
  const role = managerRoleFor(existing?.role);
  if (!existing) {
    const payload = {
      client_id: clientId,
      email,
      name,
      role,
      user_id: userId
    };
    try {
      const { error } = await db.from('client_members').insert(payload);
      if (error) throw error;
      return { status: 'created', role };
    } catch (error) {
      const duplicate = String(error?.code || '') === '23505' || /duplicate/i.test(String(error?.message || ''));
      if (!duplicate) throw new Error(error?.message || 'Client member insert failed');
      const duplicateRow = await loadExistingMembership(db, clientId, email, userId);
      if (!duplicateRow) throw new Error(error?.message || 'Client member insert failed');
      return upsertBuyerMembership({ db, clientId, email, name, userId });
    }
  }

  const updatePayload = {};
  if (managerRoleFor(existing.role) !== cleanText(existing.role).toLowerCase()) updatePayload.role = role;
  if (!cleanText(existing.name) && name) updatePayload.name = name;
  if (!lowerEmail(existing.email) && email) updatePayload.email = email;
  if (userId && cleanText(existing.user_id) !== userId) updatePayload.user_id = userId;

  if (!Object.keys(updatePayload).length) return { status: 'existing', role };

  let query = db.from('client_members').update(updatePayload).eq('client_id', clientId);
  if (cleanText(existing.email)) query = query.eq('email', cleanText(existing.email));
  else query = query.eq('user_id', cleanText(existing.user_id));
  const { error } = await query;
  if (error) throw new Error(error.message || 'Client member update failed');
  return { status: 'updated', role };
}

async function ensureBuyerAccountSetup({
  db,
  authAdmin,
  clientId,
  agreement,
  intent,
  requestId,
  logger,
  ensureRecovery,
  sendRecoveryEmail
}) {
  const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
  if (!buyerEmail) {
    const err = new Error('Public purchase buyer email is missing.');
    err.code = 'public_purchase_buyer_email_missing';
    throw err;
  }
  const buyerName = buildBuyerName(intent, agreement) || buyerEmail;
  const redirectTo = buildClientPwResetUrl({
    origin: 'public_purchase',
    checkout: 'success',
    client_id: clientId
  });

  const existingAuthUser = await findAuthUserByEmail(authAdmin, buyerEmail, logger);
  let authStatus = existingAuthUser ? 'existing_user' : 'created_user';
  let setupEmailStatus = existingAuthUser ? 'not_sent_existing_user' : 'not_sent';
  let userId = cleanText(existingAuthUser?.id);

  if (!userId) {
    const ensured = await ensureRecovery({
      email: buyerEmail,
      redirectTo,
      request_id: requestId,
      loggerPrefix: '[public-purchase-activation]'
    });
    userId = cleanText(ensured?.userId);
    authStatus = cleanText(ensured?.method) || 'created_user';

    const actionLink = cleanText(ensured?.actionLink);
    if (actionLink) {
      try {
        const emailResult = await sendRecoveryEmail(buyerEmail, actionLink, buyerName);
        setupEmailStatus = emailResult?.statusCode === 202
          ? 'sent'
          : emailResult?.skipped
            ? 'skipped'
            : 'send_failed';
        if (setupEmailStatus !== 'sent') {
          logger.warn?.('[public-purchase-activation] setup_email_not_sent', {
            email: redactEmail(buyerEmail),
            status: setupEmailStatus
          });
        }
      } catch (error) {
        setupEmailStatus = 'send_failed';
        logger.error?.('[public-purchase-activation] setup_email_failed', {
          email: redactEmail(buyerEmail),
          error: error?.message || error
        });
      }
    } else {
      setupEmailStatus = 'link_unavailable';
    }
  }

  if (!userId) {
    const err = new Error('Could not create or locate user for public purchase buyer.');
    err.code = 'public_purchase_auth_user_missing';
    throw err;
  }

  const membership = await upsertBuyerMembership({
    db,
    clientId,
    email: buyerEmail,
    name: buyerName,
    userId
  });

  return {
    auth_status: authStatus,
    user_id: userId,
    member_status: membership.status,
    member_role: membership.role,
    setup_email_status: setupEmailStatus
  };
}

async function activatePublicPurchaseAgreementCheckout(options = {}) {
  const db = options.db || supabaseAdmin;
  const authAdmin = options.authAdmin || supabaseAdmin.auth?.admin;
  const logger = options.logger || console;
  const requireParent = options.requireParentClient || requireParentClient;
  const ensureRecovery = options.ensureRecovery || ensureUserAndSendRecovery;
  const sendRecoveryEmail = options.sendRecoveryEmail || sendMemberRecoveryEmail;
  const agreementId = cleanText(options.agreementId);
  if (!agreementId) return { ok: false, status: 'agreement_missing' };

  const paidAt = cleanText(options.paidAt) || new Date().toISOString();
  const checkoutSessionId = cleanText(options.checkoutSessionId);

  const { data: agreement, error: agreementErr } = await db
    .from('membership_agreements')
    .select('id,client_id,status,is_current,checkout_status,checkout_session_id,checkout_paid_at,primary_admin_name,admin_email,client_legal_name,dba_trade_name,membership_tier,billing_option,auto_renew,template_snapshot')
    .eq('id', agreementId)
    .maybeSingle();
  if (agreementErr) throw new Error(agreementErr.message || 'Agreement lookup failed');
  if (!agreement) return { ok: false, status: 'agreement_not_found' };

  const intent = await loadPublicPurchaseIntent(db, agreement);
  const packageSnapshot = getPackageSnapshot({ agreement, intent });
  const { planKey, billingInterval } = resolvePlanSelection({
    agreement,
    intent,
    packageSnapshot,
    fallbackPlanTier: options.fallbackPlanTier,
    fallbackBillingInterval: options.fallbackBillingInterval
  });

  const clientId = await ensureLinkedClient({
    db,
    agreement,
    intent,
    planKey,
    billingInterval,
    fallbackClientId: options.fallbackClientId
  });
  const parentGuard = await requireParent(db, clientId, {
    route: 'public_purchase_webhook_activation',
    agreement_id: agreementId,
    client_id: clientId
  });
  if (!parentGuard?.ok) {
    const body = parentGuard?.body || {};
    const err = new Error(body.detail || body.error || 'Client billing scope check failed');
    err.code = body.code || body.error || 'CLIENT_BILLING_SCOPE_CHECK_FAILED';
    throw err;
  }

  const agreementPaidPayload = {
    checkout_status: 'paid',
    checkout_paid_at: paidAt
  };
  if (checkoutSessionId) agreementPaidPayload.checkout_session_id = checkoutSessionId;
  const { error: agreementUpdateErr } = await db
    .from('membership_agreements')
    .update(agreementPaidPayload)
    .eq('id', agreementId);
  if (agreementUpdateErr) throw new Error(agreementUpdateErr.message || 'Agreement checkout status update failed');

  if (intent?.id) {
    const intentPayload = {
      status: 'completed',
      client_id: clientId,
      updated_at: paidAt
    };
    if (checkoutSessionId) intentPayload.stripe_checkout_session_id = checkoutSessionId;
    const { error: intentUpdateErr } = await db
      .from('public_purchase_intents')
      .update(intentPayload)
      .eq('id', intent.id);
    if (intentUpdateErr) {
      logger.error?.('[public-purchase-activation] intent_completion_failed', {
        agreement_id: agreementId,
        purchase_intent_id: intent.id,
        error: intentUpdateErr.message,
        code: intentUpdateErr.code || null
      });
    }
  }

  const clientActivationPayload = buildClientActivationPayload({
    agreement,
    subscription: options.subscription,
    planKey,
    billingInterval,
    fallbackCustomerId: options.fallbackCustomerId,
    fallbackSubscriptionId: options.fallbackSubscriptionId
  });
  const { error: clientUpdateErr } = await db
    .from('clients')
    .update(clientActivationPayload)
    .eq('id', clientId);
  if (clientUpdateErr) throw new Error(clientUpdateErr.message || 'Client activation update failed');

  const planSettingsPayload = buildAlphaScreenPlanSettingsPayload({
    clientId,
    planKey,
    billingInterval
  });
  const { error: settingsErr } = await db
    .from('client_plan_settings')
    .upsert(planSettingsPayload, { onConflict: 'client_id' });
  if (settingsErr) throw new Error(settingsErr.message || 'Client plan settings upsert failed');

  const setup = await ensureBuyerAccountSetup({
    db,
    authAdmin,
    clientId,
    agreement,
    intent,
    requestId: options.requestId || null,
    logger,
    ensureRecovery,
    sendRecoveryEmail
  });

  return {
    ok: true,
    agreement_id: agreementId,
    purchase_intent_id: intent?.id || null,
    client_id: clientId,
    plan_key: planKey,
    billing_interval: billingInterval,
    plan_settings: planSettingsPayload,
    member_status: setup.member_status,
    member_role: setup.member_role,
    auth_status: setup.auth_status,
    setup_email_status: setup.setup_email_status
  };
}

async function resolvePublicCheckoutReturnState(options = {}) {
  const db = options.db || supabaseAdmin;
  const sessionId = cleanText(options.sessionId);
  const fallbackClientId = cleanText(options.fallbackClientId);
  const fallbackAgreementId = cleanText(options.agreementId);

  let agreement = null;
  if (sessionId) {
    const { data, error } = await db
      .from('membership_agreements')
      .select('id,client_id,checkout_status,checkout_session_id')
      .eq('checkout_session_id', sessionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Agreement checkout lookup failed');
    agreement = data || null;
  }
  if (!agreement && fallbackAgreementId) {
    const { data, error } = await db
      .from('membership_agreements')
      .select('id,client_id,checkout_status,checkout_session_id')
      .eq('id', fallbackAgreementId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Agreement checkout lookup failed');
    agreement = data || null;
  }

  let intent = null;
  if (sessionId) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,buyer_email,agreement_id,stripe_checkout_session_id,client_id')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent checkout lookup failed');
    intent = data || null;
  }
  if (!intent && agreement?.id) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,buyer_email,agreement_id,stripe_checkout_session_id,client_id')
      .eq('agreement_id', agreement.id)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent checkout lookup failed');
    intent = data || null;
  }

  const checkoutPaid = cleanText(agreement?.checkout_status).toLowerCase() === 'paid';
  const intentCompleted = !intent?.id || cleanText(intent.status).toLowerCase() === 'completed';
  const clientId = cleanText(agreement?.client_id || intent?.client_id || fallbackClientId);
  if (!checkoutPaid || !intentCompleted || !clientId) {
    return { status: 'payment_pending', client_id: clientId || null };
  }

  const { data: client, error: clientErr } = await db
    .from('clients')
    .select('id,billing_status,subscription_status')
    .eq('id', clientId)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
  const billingActive = cleanText(client?.billing_status).toLowerCase() === 'active';
  const subscriptionStatus = cleanText(client?.subscription_status).toLowerCase();
  const subscriptionActive = !subscriptionStatus || LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus) || subscriptionStatus === 'active';
  if (!client?.id || !billingActive || !subscriptionActive) {
    return { status: 'activation_pending', client_id: clientId };
  }

  const buyerEmail = lowerEmail(intent?.buyer_email);
  let memberQuery = db.from('client_members').select('client_id,user_id,email,role').eq('client_id', clientId);
  if (buyerEmail) memberQuery = memberQuery.eq('email', buyerEmail);
  const { data: members, error: memberErr } = await memberQuery;
  if (memberErr) throw new Error(memberErr.message || 'Client member lookup failed');
  const member = Array.isArray(members) ? members[0] : members;
  if (!member?.user_id) return { status: 'setup_pending', client_id: clientId };

  return { status: 'ready', client_id: clientId };
}

module.exports = {
  activatePublicPurchaseAgreementCheckout,
  resolvePublicCheckoutReturnState,
  buildClientActivationPayload,
  findAuthUserByEmail
};
