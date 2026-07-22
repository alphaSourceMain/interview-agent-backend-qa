'use strict';

const STABLE_ERRORS = new Set([
  'completed_interview_retake_blocked',
  'active_interview_attempt_exists',
  'replacement_not_authorized',
  'replacement_already_used',
  'interview_reset_reason_required',
  'interview_reset_other_detail_required',
  'interview_reset_not_eligible',
  'candidate_interview_state_requires_review',
  'no_substantive_candidate_response',
  'stale_access_invalidated',
  'reset_request_conflict',
  'prior_interview_binding_mismatch',
  'candidate_binding_mismatch',
  'recovery_attestation_required',
  'client_approval_required',
  'recovery_decision_invalid',
  'admin_scope_required',
  'role_inactive',
  'client_inactive',
  'video_recovery_only',
  'complete_report_bound',
  'replacement_already_authorized',
  'replacement_start_in_progress',
  'replacement_start_retry_exhausted',
  'recovery_start_binding_mismatch',
  'recovery_start_result_conflict',
  'interview_reset_reason_detail_too_long',
  'interview_recovery_email_disabled',
  'vendor_reconciliation_required',
  'vendor_reconciliation_manual_review',
  'vendor_binding_recovery_required',
  'vendor_binding_recovery_conflict',
]);

function isInterviewRecoveryCoreEnabled(env = process.env) {
  return String(env?.INTERVIEW_RECOVERY_CORE_ENABLED || '').trim().toLowerCase() === 'true';
}

function isInterviewRecoveryCoreEmailEnabled(env = process.env) {
  return String(env?.INTERVIEW_RECOVERY_CORE_EMAIL_ENABLED || '').trim().toLowerCase() === 'true';
}

function stableErrorCode(error) {
  const haystack = [error?.message, error?.details, error?.hint, error?.code]
    .filter(Boolean).join(' ').toLowerCase();
  for (const code of STABLE_ERRORS) if (haystack.includes(code)) return code;
  return null;
}

function errorStatus(code) {
  if (code === 'completed_interview_retake_blocked') return 409;
  if (code === 'candidate_interview_state_requires_review') return 409;
  if ([
    'active_interview_attempt_exists',
    'replacement_already_used',
    'replacement_already_authorized',
    'replacement_start_in_progress',
    'replacement_start_retry_exhausted',
    'reset_request_conflict',
    'complete_report_bound',
  ].includes(code)) return 409;
  if (['admin_scope_required', 'candidate_binding_mismatch', 'prior_interview_binding_mismatch'].includes(code)) return 403;
  if (code === 'interview_recovery_email_disabled') return 403;
  if (['vendor_reconciliation_required', 'vendor_reconciliation_manual_review',
    'vendor_binding_recovery_required', 'vendor_binding_recovery_conflict'].includes(code)) return 503;
  if (code) return 400;
  return 503;
}

function publicErrorDetail(code) {
  const detail = {
    completed_interview_retake_blocked: 'This candidate has completed the interview and cannot be authorized for another attempt.',
    active_interview_attempt_exists: 'An interview attempt is already active for this candidate and role.',
    replacement_not_authorized: 'A replacement interview has not been authorized.',
    replacement_already_used: 'The approved replacement interview has already been used.',
    interview_reset_reason_required: 'Choose a reset reason before authorizing replacement access.',
    interview_reset_other_detail_required: 'Provide a brief explanation when selecting Other.',
    interview_reset_not_eligible: 'This attempt is not eligible for replacement access.',
    candidate_interview_state_requires_review: 'The candidate interview history requires manual review before access can be reset.',
    no_substantive_candidate_response: 'No substantive candidate response was recorded.',
    stale_access_invalidated: 'This access code has been invalidated. Use the latest reset email.',
    reset_request_conflict: 'This reset request could not be accepted. Refresh and try again.',
    prior_interview_binding_mismatch: 'The selected interview does not belong to this candidate, client, and role.',
    candidate_binding_mismatch: 'The candidate does not belong to the selected client and role.',
    recovery_attestation_required: 'Confirm that required interview coverage was not completed or cannot be proven complete.',
    client_approval_required: 'Confirm that client approval has been recorded.',
    recovery_decision_invalid: 'Choose the one-video-replacement decision.',
    admin_scope_required: 'Administrator access is required.',
    role_inactive: 'The role is inactive.',
    client_inactive: 'The client is inactive.',
    video_recovery_only: 'Manual recovery is available only for video interviews.',
    complete_report_bound: 'A complete report is already bound to this interview.',
    replacement_already_authorized: 'A replacement interview has already been authorized.',
    replacement_start_in_progress: 'The approved replacement interview is already starting.',
    replacement_start_retry_exhausted: 'The approved replacement could not be started after the allowed retries. Contact support.',
    recovery_start_binding_mismatch: 'The replacement interview start could not be verified.',
    recovery_start_result_conflict: 'The replacement interview already has a different start result.',
    interview_reset_reason_detail_too_long: 'Reason detail must be 500 characters or fewer.',
    interview_recovery_email_disabled: 'Reset-and-send is not available. Use reset-only for this release.',
    vendor_reconciliation_required: 'The interview start is being verified. Please do not retry yet.',
    vendor_reconciliation_manual_review: 'The interview start requires support review. Please do not retry.',
    vendor_binding_recovery_required: 'The interview provider succeeded, but support must finish linking the interview. Please do not retry.',
    vendor_binding_recovery_conflict: 'The interview provider result conflicts with the stored interview. Support review is required.',
  };
  return detail[code] || 'The interview service is temporarily unavailable. Please try again shortly.';
}

async function claimInterviewAttempt(db, { candidateId, roleId, clientId }) {
  const rpcName = isInterviewRecoveryCoreEnabled()
    ? 'claim_candidate_interview_attempt_core'
    : 'claim_candidate_interview_attempt';
  const { data, error } = await db.rpc(rpcName, {
    p_candidate_id: candidateId,
    p_role_id: roleId,
    p_client_id: clientId,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'temporary_service_error';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.interview_id) {
    const wrapped = new Error('The interview service is temporarily unavailable. Please try again shortly.');
    wrapped.code = 'temporary_service_error';
    wrapped.status = 503;
    throw wrapped;
  }
  return {
    ...row,
    start_claimed: row.start_claimed !== false,
    authorized_replacement: row.authorized_replacement === true,
  };
}

async function getRecoveryEligibility(db, args) {
  const { data, error } = await db.rpc('get_interview_recovery_core_eligibility', {
    p_candidate_id: args.candidateId,
    p_role_id: args.roleId,
    p_client_id: args.clientId,
    p_prior_interview_id: args.priorInterviewId || null,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'temporary_service_error';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  return data || { eligible: false, blockers: ['temporary_service_error'] };
}

async function authorizeReplacement(db, args) {
  const { data, error } = await db.rpc('authorize_interview_replacement_core', {
    p_candidate_id: args.candidateId,
    p_role_id: args.roleId,
    p_client_id: args.clientId,
    p_prior_interview_id: args.priorInterviewId,
    p_actor_user_id: args.actorUserId,
    p_actor_email: args.actorEmail || null,
    p_actor_role: args.actorRole || 'admin',
    p_decision: args.decision,
    p_reason_code: args.reasonCode,
    p_reason_detail: args.reasonDetail || null,
    p_reset_mode: args.resetMode,
    p_required_coverage_attested: args.requiredCoverageAttested === true,
    p_client_approval_acknowledged: args.clientApprovalAcknowledged === true,
    p_idempotency_key: args.idempotencyKey,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'temporary_service_error';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  return Array.isArray(data) ? data[0] : data;
}

async function completeRecoveryStart(db, args) {
  const { data, error } = await db.rpc('complete_interview_recovery_start_core', {
    p_interview_id: args.interviewId,
    p_authorization_id: args.authorizationId,
    p_success: args.success === true,
    p_failure_code: args.failureCode || null,
    p_vendor_conversation_id: args.conversationId || null,
    p_vendor_conversation_url: args.conversationUrl || null,
    p_effective_persona_id: args.effectivePersonaId || null,
    p_effective_replica_id: args.effectiveReplicaId || null,
    p_effective_document_id: args.effectiveDocumentId || null,
    p_failure_category: args.failureCategory || null,
    p_vendor_external_reference: args.externalReference || null,
    p_resolution_source: args.resolutionSource || null,
    p_claim_token: args.claimToken || null,
    p_request_id: args.requestId || null,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'temporary_service_error';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  return data;
}

async function recordVendorBindingFailure(db, args) {
  const { data, error } = await db.rpc('record_interview_recovery_binding_failure_core', {
    p_interview_id: args.interviewId,
    p_authorization_id: args.authorizationId,
    p_claim_token: args.claimToken,
    p_vendor_external_reference: args.externalReference,
    p_vendor_conversation_id: args.conversationId,
    p_vendor_conversation_url: args.conversationUrl,
    p_effective_persona_id: args.effectivePersonaId || null,
    p_effective_replica_id: args.effectiveReplicaId || null,
    p_effective_document_id: args.effectiveDocumentId || null,
    p_failure_code: args.failureCode || 'database_binding_failed',
    p_request_id: args.requestId || null,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'vendor_binding_recovery_required';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  return data;
}

async function recoverVendorBinding(db, args) {
  const { data, error } = await db.rpc('recover_interview_vendor_binding_core', {
    p_interview_id: args.interviewId,
    p_authorization_id: args.authorizationId,
    p_actor_user_id: args.actorUserId,
    p_actor_email: args.actorEmail || null,
    p_request_id: args.requestId || null,
  });
  if (error) {
    const wrapped = new Error(publicErrorDetail(stableErrorCode(error)));
    wrapped.code = stableErrorCode(error) || 'vendor_binding_recovery_required';
    wrapped.status = errorStatus(wrapped.code);
    wrapped.cause = error;
    throw wrapped;
  }
  return Array.isArray(data) ? data[0] : data;
}

module.exports = {
  STABLE_ERRORS,
  stableErrorCode,
  errorStatus,
  publicErrorDetail,
  isInterviewRecoveryCoreEnabled,
  isInterviewRecoveryCoreEmailEnabled,
  claimInterviewAttempt,
  getRecoveryEligibility,
  authorizeReplacement,
  completeRecoveryStart,
  recordVendorBindingFailure,
  recoverVendorBinding,
};
