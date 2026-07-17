'use strict';

const express = require('express');
const sg = require('@sendgrid/mail');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { authorizeReplacement, publicErrorDetail } = require('../src/lib/interviewAttemptService');
const { evaluateReplacementEligibility } = require('../src/lib/interviewLifecycle');
const { interviewAppBase: INTERVIEW_APP_BASE } = require('../config/urlConfig');
const { buildBrandedEmailShell, escapeHtml } = require('../utils/mailer');

const RESET_SUCCESS = 'Interview access reset. A new interview attempt is available.';
const COMPLETED_BLOCKED = 'This candidate has completed the interview and cannot be authorized for another attempt.';
const VALID_REASONS = new Set([
  'technical_issue',
  'candidate_disconnected',
  'incorrect_candidate_information',
  'admin_approved_replacement',
  'resume_upload_problem',
  'other',
]);

function resetLink(role, candidate) {
  const token = String(role?.slug_or_token || '').trim();
  const base = String(INTERVIEW_APP_BASE || '').replace(/\/+$/, '');
  if (!base || !token) return null;
  const query = new URLSearchParams({ candidate_id: String(candidate.id), email: String(candidate.email || '') });
  return `${base}/interview/${encodeURIComponent(token)}?${query.toString()}`;
}

function resetEmailHtml(candidateName, roleTitle, code, link) {
  const safeName = escapeHtml(candidateName || 'there');
  const safeRole = escapeHtml(roleTitle || 'your role');
  const safeCode = escapeHtml(code);
  const safeLink = escapeHtml(link || '');
  return buildBrandedEmailShell({
    title: 'Your interview access has been reset',
    preheader: 'A new interview attempt has been approved.',
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">Hi ${safeName}, a new interview attempt for ${safeRole} has been approved.</p>
      <p style="margin:0 0 12px;color:#C9D3FF;font-size:14px;line-height:1.55;">Use this verification code within 10 minutes:</p>
      <p style="margin:0 0 18px;"><span style="display:inline-block;background:#A78BFA;color:#0A1547;border-radius:10px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">${safeCode}</span></p>
      ${safeLink ? `<p style="margin:0;"><a href="${safeLink}" style="color:#CFCBFF;font-weight:700;">Open your interview</a></p>` : ''}
    `,
  });
}

async function loadRecoveryState(db, candidateId, clientId, roleId) {
  const { data: candidate, error: candidateError } = await db
    .from('candidates')
    .select('id,name,email,role_id,client_id,status,interview_status')
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .eq('role_id', roleId)
    .maybeSingle();
  if (candidateError) throw candidateError;
  if (!candidate) return null;
  const [{ data: attempts, error: attemptsError }, { data: resetEvents, error: eventsError }] = await Promise.all([
    db.from('interviews').select('id,attempt_number,status,is_active,has_substantive_response,retryable,replacement_eligible,created_at').eq('candidate_id', candidateId).eq('role_id', roleId),
    db.from('interview_reset_events').select('id').eq('candidate_id', candidateId).eq('role_id', roleId),
  ]);
  if (attemptsError) throw attemptsError;
  if (eventsError) throw eventsError;
  return { candidate, attempts: attempts || [], resetEvents: resetEvents || [] };
}

function createInterviewRecoveryRouter({ db = supabaseAdmin, emailSender } = {}) {
  const router = express.Router();
  const sendEmail = emailSender || (async ({ to, subject, text, html }) => {
    const apiKey = String(process.env.SENDGRID_API_KEY || '').trim();
    const from = String(process.env.SENDGRID_FROM || '').trim();
    if (!apiKey || !from) throw new Error('candidate_reset_email_not_configured');
    sg.setApiKey(apiKey);
    await sg.send({ to, from: { email: from, name: process.env.APP_NAME || 'Interview Agent' }, subject, text, html });
  });

  router.get('/:candidateId/eligibility', async (req, res) => {
    try {
      const candidateId = String(req.params.candidateId || '').trim();
      const clientId = String(req.query.client_id || '').trim();
      const roleId = String(req.query.role_id || '').trim();
      if (!candidateId || !clientId || !roleId) return res.status(400).json({ error: 'bad_request', code: 'reset_request_conflict', detail: 'candidate_id, client_id, and role_id are required.' });
      const state = await loadRecoveryState(db, candidateId, clientId, roleId);
      if (!state) return res.status(404).json({ error: 'not_found', code: 'interview_reset_not_eligible', detail: 'Candidate was not found for the selected client and role.' });
      const result = evaluateReplacementEligibility(state);
      return res.json({
        eligible: result.eligible,
        code: result.code,
        detail: result.code === 'completed_interview_retake_blocked' ? COMPLETED_BLOCKED : (result.code ? publicErrorDetail(result.code) : null),
      });
    } catch (error) {
      return res.status(503).json({ error: 'temporary_service_error', code: 'temporary_service_error', detail: 'Unable to review interview eligibility right now.' });
    }
  });

  router.post('/:candidateId/reset', async (req, res) => {
    const candidateId = String(req.params.candidateId || '').trim();
    const clientId = String(req.body?.client_id || '').trim();
    const roleId = String(req.body?.role_id || '').trim();
    const reasonCode = String(req.body?.reason_code || '').trim().toLowerCase();
    const reasonDetail = String(req.body?.reason_detail || '').trim();
    const resetMode = String(req.body?.mode || '').trim().toLowerCase();
    const idempotencyKey = String(req.body?.idempotency_key || '').trim();
    if (!candidateId || !clientId || !roleId || !VALID_REASONS.has(reasonCode) || !['reset_only', 'reset_and_send'].includes(resetMode) || !idempotencyKey) {
      return res.status(400).json({ error: 'bad_request', code: 'reset_request_conflict', detail: publicErrorDetail('reset_request_conflict') });
    }
    if (reasonCode === 'other' && !reasonDetail) {
      return res.status(400).json({ error: 'bad_request', code: 'interview_reset_other_detail_required', detail: publicErrorDetail('interview_reset_other_detail_required') });
    }
    let state;
    try {
      state = await loadRecoveryState(db, candidateId, clientId, roleId);
    } catch (_) {
      return res.status(503).json({ error: 'temporary_service_error', code: 'temporary_service_error', detail: 'Unable to reset interview access right now.' });
    }
    if (!state) return res.status(404).json({ error: 'not_found', code: 'interview_reset_not_eligible', detail: 'Candidate was not found for the selected client and role.' });
    const eligibility = evaluateReplacementEligibility(state);
    if (!eligibility.eligible) {
      const detail = eligibility.code === 'completed_interview_retake_blocked' ? COMPLETED_BLOCKED : publicErrorDetail(eligibility.code);
      return res.status(eligibility.code === 'completed_interview_retake_blocked' ? 409 : 400).json({ error: eligibility.code, code: eligibility.code, detail });
    }
    let authorization;
    try {
      authorization = await authorizeReplacement(db, {
        candidateId,
        roleId,
        clientId,
        actorUserId: req.user?.id,
        actorEmail: req.user?.email || null,
        reasonCode,
        reasonDetail,
        resetMode,
        idempotencyKey,
      });
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.code || 'temporary_service_error', code: error.code || 'temporary_service_error', detail: error.message });
    }

    let emailStatus = resetMode === 'reset_only' ? 'not_requested' : 'pending';
    if (resetMode === 'reset_and_send' && !authorization?.replayed) {
      const { data: claimed } = await db.rpc('claim_interview_reset_email', { p_reset_event_id: authorization.reset_event_id });
      if (claimed) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        try {
          const { data: role, error: roleError } = await db.from('roles').select('id,title,slug_or_token').eq('id', roleId).single();
          if (roleError || !role) throw roleError || new Error('reset_role_not_found');
          const { error: invalidateError } = await db.from('otp_tokens').update({ used: true, invalidated_at: new Date().toISOString(), invalidation_reason: 'stale_access_invalidated' }).eq('candidate_id', candidateId).eq('role_id', roleId).eq('used', false);
          if (invalidateError) throw invalidateError;
          const { error: tokenError } = await db.from('otp_tokens').insert({ candidate_email: state.candidate.email, candidate_id: candidateId, interview_id: authorization.replacement_interview_id, role_id: roleId, code, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false });
          if (tokenError) throw tokenError;
          const link = resetLink(role, state.candidate);
          await sendEmail({
            to: state.candidate.email,
            subject: 'Your interview access has been reset',
            text: `A new interview attempt has been approved. Your verification code is ${code}. ${link || ''}`,
            html: resetEmailHtml(state.candidate.name, role.title, code, link),
          });
          await db.from('interview_reset_events').update({ email_status: 'sent', email_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', authorization.reset_event_id);
          emailStatus = 'sent';
        } catch (error) {
          await db.from('interview_reset_events').update({ email_status: 'failed', email_failed_at: new Date().toISOString(), email_failure_summary: String(error?.message || 'send_failed').slice(0, 500), updated_at: new Date().toISOString() }).eq('id', authorization.reset_event_id);
          emailStatus = 'failed';
        }
      }
    }
    return res.status(200).json({
      ok: true,
      message: RESET_SUCCESS,
      reset_event_id: authorization?.reset_event_id || null,
      interview_id: authorization?.replacement_interview_id || null,
      attempt_number: authorization?.attempt_number || null,
      email_status: emailStatus,
      replayed: authorization?.replayed === true,
    });
  });

  return router;
}

module.exports = { createInterviewRecoveryRouter, RESET_SUCCESS, COMPLETED_BLOCKED };
