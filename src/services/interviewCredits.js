'use strict';

// Interview credits for the rollover billing model.
//
// A Pro client that closes a role keeps whatever allowance the role did not use:
// it is minted as a credit the client can spend on any other role until it
// expires. Reopening the role gives its own allowance back, so the credit is
// revoked — but anything already spent from it cannot be taken back from the
// roles that spent it, so the reopened role's own allowance is reduced by that
// much instead.
//
// Nothing here spends a credit. What a credit has left, and which interviews
// were charged to it, is worked out at read time by interviewAllocation from the
// interviews themselves — so there is no balance to keep in step and no draw
// row to reconcile.

const { getRoleInterviewAvailability } = require('./roleInterviewAvailability');
const { resolveBillingModel } = require('./billingModel');

const ROLLOVER_BILLING_MODEL = 'rollover';

function isUniqueViolation(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key value');
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nowIso(now) {
  return toIso(now) || new Date().toISOString();
}

function addDaysToIso(isoValue, days) {
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

async function findLiveCreditForRole(db, roleId) {
  const { data, error } = await db
    .from('interview_credits')
    .select('id,client_id,source_role_id,quantity,minted_at,expires_at,revoked_at')
    .eq('source_role_id', roleId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview credit lookup failed');
  return data || null;
}

// Mints the unused part of a closed role's allowance as client credit. Only the
// rollover model mints; every other model lets the allowance lapse.
async function mintCreditForClosedRole({ db, clientId, roleId, closedAt, now } = {}) {
  if (!db || !clientId || !roleId) return { minted: false, reason: 'invalid_request' };

  const existing = await findLiveCreditForRole(db, roleId);
  if (existing) return { minted: false, reason: 'already_minted', credit: existing };

  const billing = await resolveBillingModel({ db, clientId });
  if (billing.billing_model !== ROLLOVER_BILLING_MODEL) {
    return { minted: false, reason: 'billing_model' };
  }

  const availability = await getRoleInterviewAvailability({ db, roleId, clientId });
  // own_remaining_interviews excludes credits, so a credit can never be minted
  // out of another credit. It does not exist until the availability service
  // reports it, and remaining_interviews is the same number until then.
  const leftover = parseWholeNonNegative(
    availability?.own_remaining_interviews ?? availability?.remaining_interviews
  );
  if (leftover == null) return { minted: false, reason: 'availability_unavailable' };
  if (leftover <= 0) return { minted: false, reason: 'no_leftover' };

  const mintedAt = nowIso(now);
  const expiresAt = addDaysToIso(toIso(closedAt) || mintedAt, billing.rollover_days);
  if (!expiresAt) return { minted: false, reason: 'invalid_expiry' };

  const { data, error } = await db
    .from('interview_credits')
    .insert({
      client_id: clientId,
      source_role_id: roleId,
      quantity: leftover,
      minted_at: mintedAt,
      expires_at: expiresAt
    })
    .select('id,client_id,source_role_id,quantity,minted_at,expires_at,revoked_at')
    .maybeSingle();

  if (error) {
    // Two closes racing: the partial unique index lets exactly one through.
    if (isUniqueViolation(error)) {
      const winner = await findLiveCreditForRole(db, roleId);
      if (winner) return { minted: false, reason: 'already_minted', credit: winner };
    }
    throw new Error(error.message || 'Interview credit mint failed');
  }

  return { minted: true, credit: data, quantity: leftover, expires_at: expiresAt };
}

// Revokes a reopened role's credit.
//
// Interviews already charged to the credit stay charged: the allocation works
// out how many those were by replaying them, and reduces the reopened role's
// own remaining by that much. Nothing is counted or stored here.
async function revokeCreditForReopenedRole({ db, roleId, now } = {}) {
  if (!db || !roleId) return { revoked: false, reason: 'no_credit' };

  const credit = await findLiveCreditForRole(db, roleId);
  if (!credit) return { revoked: false, reason: 'no_credit' };

  const revokedAt = nowIso(now);
  const { data: revoked, error } = await db
    .from('interview_credits')
    .update({ revoked_at: revokedAt, updated_at: revokedAt })
    .eq('id', credit.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview credit revoke failed');
  if (!revoked) return { revoked: false, reason: 'already_revoked' };

  return { revoked: true, credit_id: credit.id };
}

// Called by both role-status routes after the status change has been written.
// Credits are an accounting side effect of closing or reopening a role, never a
// reason to refuse the change, so every failure here is logged and swallowed.
async function syncRoleCreditsForStatusChange({ db, clientId, roleId, status, closedAt, now } = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  try {
    if (normalizedStatus === 'inactive') {
      return await mintCreditForClosedRole({ db, clientId, roleId, closedAt, now });
    }
    if (normalizedStatus === 'active') {
      return await revokeCreditForReopenedRole({ db, roleId, now });
    }
    return { skipped: true, reason: 'status' };
  } catch (e) {
    console.error('interview_credit_sync_failed', {
      client_id: clientId || null,
      role_id: roleId || null,
      status: normalizedStatus || null,
      error: e?.message || String(e)
    });
    return { skipped: true, reason: 'error' };
  }
}

module.exports = {
  ROLLOVER_BILLING_MODEL,
  mintCreditForClosedRole,
  revokeCreditForReopenedRole,
  syncRoleCreditsForStatusChange
};
