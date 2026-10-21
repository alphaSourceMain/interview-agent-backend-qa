'use strict';

const express = require('express');
const { supabaseAdmin } = require('../../clients/supabase');
const notifications = require('../../services/publicLeadNotifications');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const rateBuckets = new Map();
const submittedBuckets = new Map();
const VALID_STATUSES = new Set(['partial', 'abandoned', 'submitted']);

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = rateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if(rateBuckets.size>1000)for(const [key,value] of rateBuckets)if(value.resetAt<=now)rateBuckets.delete(key);
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      request_id: req.request_id || null,
    });
  }
  return next();
}

function submittedRateLimit(req,res,next){
  if(req.body?.status!=='submitted')return next();
  const now=Date.now(),ip=String((req.headers['x-forwarded-for']||req.ip||'unknown')).split(',')[0].trim();
  const old=submittedBuckets.get(ip),bucket=old&&old.resetAt>now?old:{count:0,resetAt:now+RATE_WINDOW_MS};
  bucket.count++;submittedBuckets.set(ip,bucket);
  if(submittedBuckets.size>1000)for(const [key,value] of submittedBuckets)if(value.resetAt<=now)submittedBuckets.delete(key);
  if(bucket.count>10)return res.status(429).json({error:'rate_limited',code:'RATE_LIMIT_EXCEEDED',request_id:req.request_id||null});
  return next();
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function cleanPhone(value) {
  return trimText(value, 40).replace(/[^\d+().\-\s]/g, '').slice(0, 40);
}

function cleanPath(value) {
  const raw = trimText(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com');
    return trimText(url.pathname || '/', 300);
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300);
  }
}

function normalizeJsonObject(value, maxString = 300) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = trimText(key, 80);
    if (!safeKey || raw === null || raw === undefined) continue;
    if (typeof raw === 'string') out[safeKey] = trimText(raw, maxString);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[safeKey] = raw;
    else if (typeof raw === 'boolean') out[safeKey] = raw;
    else if (Array.isArray(raw)) out[safeKey] = raw.slice(0, 20).map((item) => trimText(item, 120));
    else out[safeKey] = trimText(JSON.stringify(raw), maxString);
  }
  return out;
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const email = trimText(fields.email, 254).toLowerCase();
  const phone = cleanPhone(fields.phone);
  const out = {
    first_name: trimText(fields.first_name, 80),
    last_name: trimText(fields.last_name, 80),
    email: EMAIL_RE.test(email) ? email : '',
    phone,
  };
  if (typeof fields.message === 'string') {
    out.message = trimText(fields.message, 2000);
  }
  return out;
}

function normalizeFieldsCompleted(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((field) => trimText(field, 80))
      .filter(Boolean)
      .slice(0, 30)
  ));
}

router.post('/draft', rateLimit, submittedRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const draftId = trimText(body.draft_id, 80);
    if (!UUID_RE.test(draftId)) {
      return res.status(400).json({
        error: 'invalid_draft_id',
        code: 'VALIDATION_ERROR',
        request_id: req.request_id || null,
      });
    }

    const status = trimText(body.status, 40);
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({
        error: 'invalid_status',
        code: 'VALIDATION_ERROR',
        request_id: req.request_id || null,
      });
    }

    const fields = normalizeFields(body.fields);
    const hasContact = Boolean(fields.email || fields.phone);
    if (!hasContact) {
      return res.status(400).json({
        error: 'contact_required',
        code: 'VALIDATION_ERROR',
        detail: 'A valid email or phone is required before saving a lead draft.',
        request_id: req.request_id || null,
      });
    }

    const isSubmitted = status === 'submitted';
    const now = new Date().toISOString();

    const row = {
      id: draftId,
      status,
      form_id: trimText(body.form_id, 120),
      form_type: trimText(body.form_type, 80),
      product_interest: trimText(body.product_interest, 120),
      first_name: fields.first_name || null,
      last_name: fields.last_name || null,
      email: fields.email || null,
      phone: fields.phone || null,
      message: isSubmitted ? (fields.message || null) : null,
      fields_completed: normalizeFieldsCompleted(body.fields_completed),
      last_field: trimText(body.last_field, 80) || null,
      source_path: cleanPath(body.source?.path) || '/',
      source_referrer_path: cleanPath(body.source?.referrer_path) || null,
      source_cta: trimText(body.source?.cta, 160) || null,
      utm: normalizeJsonObject(body.source?.utm, 160),
      anonymous_id: trimText(body.anonymous_id, 120),
      session_id: trimText(body.session_id, 120),
      privacy_notice_version: trimText(body.privacy_notice_version, 120),
      request_id: req.request_id || null,
      updated_at: now,
      submitted_at: isSubmitted ? now : null,
    };

    const config=notifications.configuration();
    const { data, error } = await supabaseAdmin.rpc('save_public_lead_capture',{
      p_row:row,p_notification_environment:config?.environment||null,
      p_notifications_activated_at:config?.activatedAt||null,
    });

    if (error) {
      console.error('[public-leads/draft] capture_failed', {code:error.code||'database_error'});
      return res.status(503).json({
        error: 'lead_capture_not_configured',
        code: 'LEAD_TABLE_ERROR',
        request_id: req.request_id || null,
      });
    }

    if(!data?.item?.id||!data.item.status)throw Error('invalid_capture_result');
    if(isSubmitted&&process.env.PUBLIC_LEAD_NOTIFICATIONS_ENABLED==='true'&&!config)
      console.warn('[public-leads] notification_configuration_held');
    if(data.notification)await notifications.deliver(data.notification,{
      db:supabaseAdmin,send:notification=>require('../../clients/sendgrid').sendPublicLeadNotification(notification),
    });

    return res.json({
      ok: true,
      item: data.item,
      request_id: req.request_id || null,
    });
  } catch (e) {
    console.error('[public-leads/draft] unexpected_capture_error');
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id: req.request_id || null,
    });
  }
});

module.exports = router;
