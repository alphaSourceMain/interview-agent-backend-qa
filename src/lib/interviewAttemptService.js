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
]);

function stableErrorCode(error) {
  const haystack = [error?.message, error?.details, error?.hint, error?.code]
    .filter(Boolean).join(' ').toLowerCase();
  for (const code of STABLE_ERRORS) if (haystack.includes(code)) return code;
  return null;
}

function errorStatus(code) {
  if (code === 'completed_interview_retake_blocked') return 409;
  if (code === 'candidate_interview_state_requires_review') return 409;
  if (code === 'active_interview_attempt_exists' || code === 'replacement_already_used' || code === 'reset_request_conflict') return 409;
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
  };
  return detail[code] || 'The interview service is temporarily unavailable. Please try again shortly.';
}

async function claimInterviewAttempt(db, { candidateId, roleId, clientId }) {
  const { data, error } = await db.rpc('claim_candidate_interview_attempt', {
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
  return row;
}

async function authorizeReplacement(db, args) {
  const { data, error } = await db.rpc('authorize_interview_replacement', {
    p_candidate_id: args.candidateId,
    p_role_id: args.roleId,
    p_client_id: args.clientId,
    p_actor_user_id: args.actorUserId,
    p_actor_email: args.actorEmail || null,
    p_reason_code: args.reasonCode,
    p_reason_detail: args.reasonDetail || null,
    p_reset_mode: args.resetMode,
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

module.exports = {
  STABLE_ERRORS,
  stableErrorCode,
  errorStatus,
  publicErrorDetail,
  claimInterviewAttempt,
  authorizeReplacement,
};
