'use strict';

const VALID_INTERVIEW_TYPES = new Set(['BASIC', 'DETAILED', 'TECHNICAL']);

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeInterviewType(value) {
  const raw = cleanText(value).toUpperCase();
  return VALID_INTERVIEW_TYPES.has(raw) ? raw : null;
}

function defaultGenerateRubricAndKBForRole(roleId) {
  const { generateRubricAndKBForRole } = require('../../generateRubric');
  return generateRubricAndKBForRole(roleId);
}

async function enrichRoleJobDescription({
  db,
  roleId,
  clientId,
  jdStoragePath,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const safeRoleId = cleanText(roleId);
  const safeClientId = cleanText(clientId);
  const safeJdStoragePath = cleanText(jdStoragePath);
  if (!safeRoleId || !safeClientId || !safeJdStoragePath) return { enriched: false };

  const { error: roleJdUpdateErr } = await db
    .from('roles')
    .update({ job_description_url: safeJdStoragePath })
    .eq('id', safeRoleId)
    .eq('client_id', safeClientId);
  if (roleJdUpdateErr) throw new Error(roleJdUpdateErr.message || 'Role JD update failed');

  await generateRubricAndKBForRole(safeRoleId);
  return { enriched: true };
}

async function createOrRecoverRoleForPurchase({
  db,
  clientId,
  roleTitle,
  interviewType,
  jdStoragePath,
  pendingRolePurchaseId = null,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const safeClientId = cleanText(clientId);
  const safeTitle = cleanText(roleTitle);
  if (!safeClientId) throw new Error('Pending role client missing');
  if (!safeTitle) throw new Error('Pending role title missing');
  const normalizedInterviewType = normalizeInterviewType(interviewType);
  const safePendingRolePurchaseId = cleanText(pendingRolePurchaseId);

  let linkedRoleId = null;
  if (safePendingRolePurchaseId) {
    const { data: linkedRole, error: linkedRoleErr } = await db
      .from('roles')
      .select('id')
      .eq('client_id', safeClientId)
      .eq('pending_role_purchase_id', safePendingRolePurchaseId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (linkedRoleErr) throw new Error(linkedRoleErr.message || 'Role recovery lookup failed');
    linkedRoleId = linkedRole?.id || null;
  }

  let role = linkedRoleId ? { id: linkedRoleId } : null;
  if (!role) {
    const insertPayload = {
      client_id: safeClientId,
      title: safeTitle,
      interview_type: normalizedInterviewType
    };
    if (safePendingRolePurchaseId) insertPayload.pending_role_purchase_id = safePendingRolePurchaseId;
    const { data: insertedRole, error: createdRoleErr } = await db
      .from('roles')
      .insert(insertPayload)
      .select('id')
      .single();
    if (createdRoleErr) throw new Error(createdRoleErr.message || 'Role creation failed');
    role = insertedRole;
  }

  await enrichRoleJobDescription({
    db,
    roleId: role.id,
    clientId: safeClientId,
    jdStoragePath,
    generateRubricAndKBForRole
  });

  return {
    role,
    linkedRoleId,
    recovered: Boolean(linkedRoleId)
  };
}

async function finalizePendingRolePurchase({
  db,
  pendingRolePurchase,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const pendingId = cleanText(pendingRolePurchase?.id);
  if (!pendingId) throw new Error('Pending role purchase id missing');

  const created = await createOrRecoverRoleForPurchase({
    db,
    clientId: pendingRolePurchase.client_id,
    roleTitle: pendingRolePurchase.role_title,
    interviewType: pendingRolePurchase.interview_type,
    jdStoragePath: pendingRolePurchase.jd_storage_path,
    pendingRolePurchaseId: pendingId,
    generateRubricAndKBForRole
  });

  const { data: finalizedPendingRolePurchase, error: finalizeErr } = await db
    .from('pending_role_purchases')
    .update({
      finalized_role_id: created.role.id,
      status: 'finalized',
      finalized_at: new Date().toISOString()
    })
    .eq('id', pendingId)
    .is('finalized_role_id', null)
    .in('status', created.linkedRoleId ? ['pending', 'paid', 'finalizing'] : ['finalizing'])
    .select('id')
    .maybeSingle();
  if (finalizeErr || !finalizedPendingRolePurchase) {
    throw new Error(finalizeErr?.message || 'Pending role purchase finalize failed');
  }

  return {
    role: created.role,
    pending_role_purchase_id: pendingId,
    recovered: created.recovered
  };
}

async function findUnusedFirstRolePrepayCredit({ db, billingClientId }) {
  const safeBillingClientId = cleanText(billingClientId);
  if (!safeBillingClientId) return null;
  const { data, error } = await db
    .from('client_role_credits')
    .select('id')
    .eq('billing_client_id', safeBillingClientId)
    .eq('credit_type', 'first_role_prepay')
    .eq('status', 'unused')
    .is('used_at', null)
    .is('used_by_role_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'First-role prepay credit lookup failed');
  return data || null;
}

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function finalizePrepaidRoleCredit({
  db,
  billingClientId,
  clientId,
  roleTitle,
  interviewType,
  jdStoragePath,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole,
  throwOnEnrichmentError = true,
  logger = console
}) {
  const safeBillingClientId = cleanText(billingClientId);
  const safeClientId = cleanText(clientId);
  const safeTitle = cleanText(roleTitle);
  if (!safeBillingClientId) throw new Error('Billing client id is required for first-role prepay credit.');
  if (!safeClientId) throw new Error('Client id is required for first-role prepay credit.');
  if (!safeTitle) throw new Error('Role title is required for first-role prepay credit.');

  const { data, error } = await db.rpc('consume_first_role_prepay_credit', {
    p_billing_client_id: safeBillingClientId,
    p_source_client_id: safeClientId,
    p_role_title: safeTitle,
    p_interview_type: normalizeInterviewType(interviewType),
    p_jd_storage_path: cleanText(jdStoragePath) || null
  });
  if (error) throw new Error(error.message || 'First-role prepay credit consumption failed');

  const row = firstRpcRow(data);
  if (!row?.ok || !row?.role_id) {
    return {
      applied: false,
      status: cleanText(row?.status) || 'credit_not_available'
    };
  }

  let enrichmentStatus = 'skipped';
  try {
    const enrichment = await enrichRoleJobDescription({
      db,
      roleId: row.role_id,
      clientId: safeClientId,
      jdStoragePath,
      generateRubricAndKBForRole
    });
    enrichmentStatus = enrichment.enriched ? 'completed' : 'skipped';
  } catch (error) {
    enrichmentStatus = 'failed';
    logger.error?.('[role-purchase-finalizer] prepaid_role_enrichment_failed', {
      role_id: row.role_id,
      credit_id: row.credit_id || null,
      client_id: safeClientId,
      billing_client_id: safeBillingClientId,
      error: error?.message || error
    });
    if (throwOnEnrichmentError) throw error;
  }

  return {
    applied: true,
    status: 'used',
    role_id: row.role_id,
    credit_id: row.credit_id || null,
    enrichment_status: enrichmentStatus
  };
}

module.exports = {
  createOrRecoverRoleForPurchase,
  enrichRoleJobDescription,
  finalizePendingRolePurchase,
  finalizePrepaidRoleCredit,
  findUnusedFirstRolePrepayCredit,
  normalizeInterviewType
};
