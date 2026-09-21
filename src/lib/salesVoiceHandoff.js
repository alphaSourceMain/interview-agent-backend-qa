'use strict';

const crypto = require('node:crypto');

const SALES_VOICE_TOOL = Object.freeze({
  type: 'function',
  name: 'notify_sales_representative',
  description: 'Send one caller-approved message to the assigned alphaScreen sales representative after confirming the caller name, company, callback phone, email, and reason for calling. Ask for spelling when unclear and never guess. Never mention this tool or its delivery mechanics aloud.',
  parameters: {
    type: 'object',
    properties: {
      caller_name: { type: 'string', description: 'Caller-provided full name with spelling confirmed; maximum 120 characters.' },
      company_name: { type: 'string', description: 'Caller-provided company name with spelling confirmed; maximum 160 characters.' },
      callback_phone: { type: 'string', description: 'Caller-confirmed callback number in North American E.164 format, such as +17205551212.' },
      contact_email: { type: 'string', description: 'Caller-provided email with spelling confirmed; maximum 254 characters.' },
      message: { type: 'string', description: 'Caller-approved reason for calling and requested follow-up; maximum 1000 characters.' },
      confirmed: { type: 'boolean', description: 'True only after the caller explicitly approves sharing all confirmed details with the sales representative.' }
    },
    required: ['caller_name', 'company_name', 'callback_phone', 'contact_email', 'message', 'confirmed'],
    additionalProperties: false
  }
});

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function validEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email);
}

function validSlackUserId(value) {
  return /^[UW][A-Z0-9]{8,20}$/.test(cleanText(value, 24));
}

function validE164(value) {
  return /^\+1[2-9]\d{9}$/.test(cleanText(value, 16));
}

function safeGhlWebhook(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /(^|\.)leadconnectorhq\.com$/i.test(url.hostname) ? url.toString() : '';
  } catch {
    return '';
  }
}

function validateSalesVoiceMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.confirmed !== true) return null;
  const expected = ['callback_phone', 'caller_name', 'company_name', 'confirmed', 'contact_email', 'message'];
  if (Object.keys(value).sort().join(',') !== expected.join(',')) return null;
  const callerName = cleanText(value.caller_name, 121);
  const companyName = cleanText(value.company_name, 161);
  const callbackPhone = cleanText(value.callback_phone, 17);
  const contactEmail = cleanText(value.contact_email, 255).toLowerCase();
  const message = cleanText(value.message, 1001);
  if (!callerName || callerName.length > 120 || !/\p{L}/u.test(callerName)) return null;
  if (!companyName || companyName.length > 160 || !/[\p{L}\p{N}]/u.test(companyName)) return null;
  if (!validE164(callbackPhone) || !validEmail(contactEmail)) return null;
  if (message.length < 5 || message.length > 1000) return null;
  const combined = `${callerName} ${companyName} ${message}`;
  if (/https?:\/\/|bearer\s|\b(?:sk-|SG\.)[a-z0-9_-]{12,}|\b\d{6}\b|\b(?:\d[ -]?){13,19}\b/i.test(combined)) return null;
  return Object.freeze({
    caller_name: callerName,
    company_name: companyName,
    callback_phone: callbackPhone,
    contact_email: contactEmail,
    message,
    confirmed: true
  });
}

function parseRouteConfig(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(String(env.SALES_VOICE_HANDOFF_ROUTES_JSON || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return [];
  const routes = [];
  const uniqueValues = {
    tokenHash: new Set(),
    routeKey: new Set(),
    repEmail: new Set(),
    slackUserId: new Set(),
    ghlNumber: new Set(),
    ghlNotificationWebhook: new Set()
  };
  for (const entry of raw) {
    const tokenHash = cleanText(entry?.token_sha256, 64).toLowerCase();
    const routeKey = cleanText(entry?.route_key, 80).toLowerCase();
    const repName = cleanText(entry?.rep_name, 120);
    const repEmail = cleanText(entry?.rep_email, 254).toLowerCase();
    const slackUserId = cleanText(entry?.slack_user_id, 24);
    const ghlNumber = cleanText(entry?.ghl_number, 16);
    const ghlNotificationWebhook = safeGhlWebhook(entry?.ghl_notification_webhook);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routeKey) || !/^[a-f0-9]{64}$/.test(tokenHash) ||
        !repName || !validEmail(repEmail) || !validSlackUserId(slackUserId) ||
        !validE164(ghlNumber) || !ghlNotificationWebhook) return [];
    const candidate = { tokenHash, routeKey, repEmail, slackUserId, ghlNumber, ghlNotificationWebhook };
    if (Object.entries(candidate).some(([key, value]) => uniqueValues[key].has(value))) return [];
    Object.entries(candidate).forEach(([key, value]) => uniqueValues[key].add(value));
    routes.push(Object.freeze({ routeKey, tokenHash, repName, repEmail, slackUserId, ghlNumber, ghlNotificationWebhook }));
  }
  return routes;
}

function salesVoiceHandoffEnabled(env = process.env) {
  return salesVoiceProviderEnabled(env) &&
    parseRouteConfig(env).length > 0;
}

function salesVoiceProviderEnabled(env = process.env) {
  return env.SALES_VOICE_HANDOFF_ENABLED === 'true' &&
    validEmail(env.SALES_VOICE_FROM_EMAIL) &&
    cleanText(env.SENDGRID_API_KEY, 500).length > 20 &&
    cleanText(env.SLACK_SALES_WON_BOT_TOKEN, 500).length > 20;
}

function routeForAuthorization(authorization, env = process.env) {
  const match = /^Bearer ([^\s]{32,256})$/.exec(String(authorization || ''));
  if (!match) return null;
  const digest = hash(match[1]);
  let matched = null;
  for (const route of parseRouteConfig(env)) {
    if (crypto.timingSafeEqual(Buffer.from(route.tokenHash, 'hex'), Buffer.from(digest, 'hex'))) matched = route;
  }
  return matched;
}

function ghlWebhookForNumber(number, env = process.env) {
  let mapping;
  try {
    mapping = JSON.parse(String(env.SALES_VOICE_GHL_WEBHOOKS_JSON || '{}'));
  } catch {
    return '';
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return '';
  return safeGhlWebhook(mapping[number]);
}

async function routeForAuthorizationDb(authorization, db, env = process.env) {
  if (!db) return null;
  const match = /^Bearer ([^\s]{32,256})$/.exec(String(authorization || ''));
  if (!match) return null;
  const digest = hash(match[1]);
  const assignmentResult = await db
    .from('sales_phone_assignments')
    .select('id,team_member_id,phone_number_id,status')
    .eq('handoff_token_sha256', digest)
    .eq('status', 'active')
    .maybeSingle();
  if (assignmentResult.error || !assignmentResult.data) return null;
  const assignment = assignmentResult.data;
  const [memberResult, phoneResult] = await Promise.all([
    db.from('sales_team_members')
      .select('id,display_name,workspace_email,slack_user_id,status')
      .eq('id', assignment.team_member_id)
      .eq('status', 'active')
      .maybeSingle(),
    db.from('sales_phone_numbers')
      .select('id,e164,active')
      .eq('id', assignment.phone_number_id)
      .eq('active', true)
      .maybeSingle(),
  ]);
  const member = memberResult.data;
  const phone = phoneResult.data;
  if (memberResult.error || phoneResult.error || !member || !phone) return null;
  const repName = cleanText(member.display_name, 120);
  const repEmail = cleanText(member.workspace_email, 254).toLowerCase();
  const slackUserId = cleanText(member.slack_user_id, 24);
  const ghlNumber = cleanText(phone.e164, 16);
  const ghlNotificationWebhook = ghlWebhookForNumber(ghlNumber, env);
  if (!repName || !validEmail(repEmail) || !validSlackUserId(slackUserId) || !validE164(ghlNumber) || !ghlNotificationWebhook) return null;
  return Object.freeze({
    routeKey: cleanText(assignment.id, 80).toLowerCase(),
    tokenHash: digest,
    repName,
    repEmail,
    slackUserId,
    ghlNumber,
    ghlNotificationWebhook,
  });
}

function humanMessage(input, route) {
  return `${input.caller_name} from ${input.company_name} called your alphaScreen line while you were unavailable.\n\nThey asked me to pass along this message:\n\n${input.message}\n\nCallback: ${input.callback_phone}\nEmail: ${input.contact_email}`;
}

function emailBody(input, route) {
  return `Hi ${route.repName.split(/\s+/)[0]},\n\n${humanMessage(input, route)}\n\nThey confirmed these contact details and approved sharing this message with you.\n\nThanks,\nalphaSource Sales Assistant`;
}

function slackMessage(input, route) {
  return {
    text: `New caller message for ${route.repName}: ${input.company_name}`,
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📞 New caller message', emoji: true } },
      {
        type: 'section',
        fields: [
          { type: 'plain_text', text: `Caller\n${input.caller_name}`, emoji: true },
          { type: 'plain_text', text: `Company\n${input.company_name}`, emoji: true },
          { type: 'plain_text', text: `Callback\n${input.callback_phone}`, emoji: true },
          { type: 'plain_text', text: `Email\n${input.contact_email}`, emoji: true }
        ]
      },
      { type: 'section', text: { type: 'plain_text', text: `Message\n${input.message}`, emoji: true } }
    ]
  };
}

async function postJson(url, body, headers, fetchImpl, timeoutMs = 8000) {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body)
  });
  let responseBody = {};
  try { responseBody = await response.json(); } catch { responseBody = {}; }
  return { ok: response.ok, status: response.status, body: responseBody };
}

function createSalesVoiceHandoff(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || global.fetch;
  const rateLimit = options.rateLimit || require('./rateLimit').checkAndIncrementRateLimit;
  const routeModeEnabled = options.db ? salesVoiceProviderEnabled(env) : salesVoiceHandoffEnabled(env);
  async function reserve(routeName, subjectKey, windowMs, maxCount) {
    let timer;
    try {
      return (await Promise.race([
        rateLimit({ routeName, subjectKey: hash(subjectKey), windowMs, maxCount }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('rate_timeout')), 2500); })
      ]))?.allowed === true;
    } finally { clearTimeout(timer); }
  }

  async function send(input, route) {
    if (!routeModeEnabled || !route) return { status: 'unavailable' };
    const reference = hash(`${route.routeKey}:${JSON.stringify(input)}`).slice(0, 32);
    try {
      if (!await reserve('sales_voice_handoff_global', 'all', 3600000, 100) ||
          !await reserve('sales_voice_handoff_route', route.routeKey, 3600000, 30)) return { status: 'rate_limited', reference };
      if (!await reserve('sales_voice_handoff_once', `${route.routeKey}:${JSON.stringify(input)}`, 86400000, 1)) {
        return { status: 'already_attempted', reference };
      }
    } catch {
      return { status: 'unavailable', reference };
    }

    const message = humanMessage(input, route);
    const deliveries = await Promise.allSettled([
      postJson('https://api.sendgrid.com/v3/mail/send', {
        personalizations: [{ to: [{ email: route.repEmail }] }],
        from: { email: cleanText(env.SALES_VOICE_FROM_EMAIL, 254).toLowerCase(), name: 'alphaSource Sales Assistant' },
        reply_to: { email: input.contact_email, name: input.caller_name },
        subject: `Caller message from ${input.company_name}`,
        content: [{ type: 'text/plain', value: emailBody(input, route) }],
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } }
      }, { Authorization: `Bearer ${env.SENDGRID_API_KEY}` }, fetchImpl),
      postJson('https://slack.com/api/chat.postMessage', {
        channel: route.slackUserId,
        client_msg_id: reference,
        ...slackMessage(input, route)
      }, { Authorization: `Bearer ${env.SLACK_SALES_WON_BOT_TOKEN}` }, fetchImpl),
      postJson(route.ghlNotificationWebhook, {
        event: 'alphaScreen_sales_missed_call',
        event_id: reference,
        representative: route.repName,
        assigned_number: route.ghlNumber,
        caller_name: input.caller_name,
        company_name: input.company_name,
        callback_phone: input.callback_phone,
        contact_email: input.contact_email,
        message
      }, {}, fetchImpl)
    ]);
    const accepted = deliveries.map((result, index) => {
      if (result.status !== 'fulfilled' || !result.value.ok) return false;
      if (index === 0) return result.value.status === 202;
      if (index === 1) return result.value.body?.ok === true;
      return true;
    });
    const acceptedCount = accepted.filter(Boolean).length;
    return {
      status: acceptedCount === 3 ? 'accepted' : acceptedCount > 0 ? 'partial' : 'failed',
      reference
    };
  }
  return { send, enabled: () => routeModeEnabled };
}

function createSalesVoiceHandoffRouter(options = {}) {
  const express = require('express');
  const router = express.Router();
  const env = options.env || process.env;
  const db = options.db || null;
  const service = options.service || createSalesVoiceHandoff(options);
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!service.enabled()) return res.status(503).json({ status: 'unavailable' });
    if (req.headers.origin) return res.status(401).json({ status: 'unauthorized' });
    let route = routeForAuthorization(req.headers.authorization, env);
    if (!route && db) {
      try {
        route = await routeForAuthorizationDb(req.headers.authorization, db, env);
      } catch {
        return res.status(503).json({ status: 'unavailable' });
      }
    }
    if (!route) return res.status(401).json({ status: 'unauthorized' });
    req.salesVoiceRoute = route;
    next();
  });
  router.post('/', express.json({ limit: '4kb', strict: true }), async (req, res) => {
    const input = validateSalesVoiceMessage(req.body);
    if (!input) return res.status(400).json({ status: 'invalid_request' });
    try {
      const result = await service.send(input, req.salesVoiceRoute);
      return res.status(['accepted', 'partial', 'already_attempted'].includes(result.status) ? 200 : 503).json(result);
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
  router.all('/', (_req, res) => res.status(405).json({ status: 'method_not_allowed' }));
  router.use((_req, res) => res.status(404).json({ status: 'not_found' }));
  router.use((_error, _req, res, _next) => res.status(400).json({ status: 'invalid_request' }));
  return router;
}

function buildSalesVoiceAgentPrompt(repName) {
  const name = cleanText(repName, 120);
  if (!name) throw new Error('Representative name is required');
  return `You are the alphaSource sales assistant answering ${name}'s alphaScreen sales line when ${name} is unavailable.\n\nOpen with: "Hi, you've reached ${name}'s alphaScreen line. ${name} is unavailable right now, but I can take a message and make sure it reaches them."\n\nYour job is to collect a concise callback request, not to conduct a sales call. Ask one question at a time for the caller's full name, company name, callback phone, email, and reason for calling. Confirm the phone and email. If any name, company, or email spelling is unclear, ask the caller to spell it; never guess. Do not request payment details, passwords, authentication codes, candidate records, resumes, interview content, or other sensitive information. Do not promise a response time.\n\nRead back the contact details and a short natural-language message. Then ask: "Would you like me to send that message to ${name}?" Only after an explicit yes may you use the configured message action with confirmed=true. If the caller declines, do not send anything. Send at most once per call.\n\nNever say tool or function names, API, endpoint, parameters, providers, or delivery mechanics. Say only that you can send a message to ${name}. After an accepted or partial result, say: "Your message has been sent to ${name}." For any other result, say you could not confirm the message was sent and suggest calling back later. Do not retry.`;
}

module.exports = {
  SALES_VOICE_TOOL,
  buildSalesVoiceAgentPrompt,
  createSalesVoiceHandoff,
  createSalesVoiceHandoffRouter,
  parseRouteConfig,
  routeForAuthorization,
  routeForAuthorizationDb,
  salesVoiceHandoffEnabled,
  salesVoiceProviderEnabled,
  validateSalesVoiceMessage
};
