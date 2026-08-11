const crypto = require('node:crypto');
const express = require('express');
const net = require('node:net');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { hasAnyActiveClientMembership } = require('./supportVoiceMembership');
const { buildSupportVoicePrompt, getSupportVoiceKnowledgeReadiness, SUPPORT_GREETING } = require('./supportVoiceKnowledge');
const {
  BROWSER_MAX_PAYLOAD,
  DEFAULT_VOICE,
  UPSTREAM_MAX_PAYLOAD,
  UPSTREAM_URL,
  buildAuthoritativeSessionUpdate,
  classifyProviderEvent,
  exactKeys,
  validateBrowserEvent,
  validatePreAttestationProviderEvent,
  validateSessionUpdated,
} = require('./supportVoiceProtocol');

const QA_ORIGIN = 'https://alphasourceai-com.onrender.com';
const PROTOCOL = 'alphascreen-support-v1';
const SESSION_PATH = '/api/support/voice';
const PENDING_TTL_MS = 60_000;
const MAX_SESSION_MS = 10 * 60_000;
const IDLE_MS = 120_000;
const MAX_SESSIONS = 20;
const MAX_PREAUTH = 50;
const ALL_FRAME_RATE = 40;
const ALL_FRAME_BURST = 80;
const AUDIO_FRAME_RATE = 25;
const AUDIO_FRAME_BURST = 50;
const AUDIO_BYTE_RATE = 256 * 1024;
const AUDIO_BYTE_BURST = 512 * 1024;
const INFLIGHT_MAX_FRAMES = 12;
const INFLIGHT_MAX_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_GRACE_MS = 10_000;
const UPSTREAM_CLOSE_GRACE_MS = 5_000;
const RATE_ACTIONS = new Set(['support_voice_session_create:user', 'support_voice_session_create:ip']);

function base64url(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createTokenBucket(ratePerSecond, burst, now = Date.now()) {
  return { ratePerSecond, burst, tokens: burst, updatedAt: now };
}

function consumeToken(bucket, cost = 1, now = Date.now()) {
  if (!bucket || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(now)) return false;
  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsedSeconds * bucket.ratePerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function parseJsonTextFrame(raw, maxBytes) {
  if (!raw || !Number.isInteger(raw.length) || raw.length <= 0 || raw.length > maxBytes) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function exactOrigin(req, env = process.env) {
  const origin = req.headers.origin;
  if (Array.isArray(origin) || typeof origin !== 'string' || !origin) return false;
  const allowed = new Set([QA_ORIGIN]);
  if (env.NODE_ENV !== 'production' && env.SUPPORT_VOICE_ALLOW_LOCAL_DEV === 'true') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash && allowed.has(origin);
  } catch {
    return false;
  }
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  noStore(res);
}

function rejectRequestBody(req, res, next) {
  const contentLength = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || (contentLength !== undefined && contentLength !== '0')) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  let sawByte = false;
  const onData = (chunk) => { if (chunk && chunk.length) sawByte = true; };
  req.on('data', onData);
  req.once('end', () => {
    req.removeListener('data', onData);
    if (sawByte) return res.status(400).json({ error: 'invalid_request' });
    next();
  });
}

function isPublicIp(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
      !/^fe[89ab]/.test(normalized) && !normalized.startsWith('ff') && !normalized.startsWith('2001:db8') && !normalized.startsWith('::ffff:');
  }
  return false;
}

function safeIp(req, mode) {
  const raw = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (isPublicIp(raw)) return raw;
  if (mode === 'best_effort') return null;
  throw new Error('SUPPORT_VOICE_IP_UNAVAILABLE');
}

function isConfigurationReady(env, knowledge, scaleLeaseHealthy) {
  return env.SUPPORT_VOICE_ENABLED === 'true' &&
    env.SUPPORT_VOICE_SINGLE_INSTANCE_CONFIRMED === 'true' &&
    (env.SUPPORT_VOICE_XFF_MODE === 'strict' || env.SUPPORT_VOICE_XFF_MODE === 'best_effort') &&
    (env.SUPPORT_VOICE_ALLOW_LOCAL_DEV !== 'true' || env.NODE_ENV !== 'production') &&
    typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim().length >= 20 &&
    knowledge.ok === true && scaleLeaseHealthy === true;
}

function createSupportVoiceGateway(options = {}) {
  const env = options.env || process.env;
  const serviceDb = options.serviceDb || require('./supabaseClient').supabaseAdmin;
  const requireAuth = options.requireAuth;
  if (typeof requireAuth !== 'function') throw new Error('SUPPORT_VOICE_REQUIRE_AUTH_REQUIRED');
  const rateLimit = options.rateLimit || require('./rateLimit').checkAndIncrementRateLimit;
  const WebSocketClient = options.WebSocketClient || WebSocket;
  const testDuration = (name, fallback) => env.NODE_ENV === 'test' && Number.isInteger(options[name]) && options[name] > 0 ? options[name] : fallback;
  const idleMs = testDuration('idleMs', IDLE_MS);
  const maxSessionMs = testDuration('maxSessionMs', MAX_SESSION_MS);
  const pendingTtlMs = testDuration('pendingTtlMs', PENDING_TTL_MS);
  const heartbeatIntervalMs = testDuration('heartbeatIntervalMs', HEARTBEAT_INTERVAL_MS);
  const heartbeatGraceMs = testDuration('heartbeatGraceMs', HEARTBEAT_GRACE_MS);
  const rateTimeoutMs = testDuration('rateTimeoutMs', 2000);
  const router = express.Router();
  const monitorRouter = express.Router();
  const sessions = new Map();
  const userSessions = new Map();
  let preauthCount = 0;
  let scaleLeaseHealthy = options.scaleLeaseHealthy === true;
  let scaleLeaseUpdatedAt = scaleLeaseHealthy ? Date.now() : 0;
  let scalePollTimer = null;
  let attachedServer = null;
  const renderCommit = String(env.RENDER_GIT_COMMIT || '').trim();
  const renderServiceId = String(env.RENDER_SERVICE_ID || '').trim();
  const leaseRoute = renderCommit ? `support_voice_scale_lease:${renderCommit}` : '';
  const leaseSubject = renderServiceId ? digest(`ia-backend-qa\u001f${renderServiceId}`) : '';

  function configuration() {
    const knowledge = getSupportVoiceKnowledgeReadiness();
    const leaseFresh = scaleLeaseHealthy && Date.now() - scaleLeaseUpdatedAt <= 5000;
    return { knowledge, ready: isConfigurationReady(env, knowledge, leaseFresh), scaleLeaseHealthy: leaseFresh };
  }

  function publicHealth() {
    const config = configuration();
    return {
      enabled: env.SUPPORT_VOICE_ENABLED === 'true',
      configured: config.ready,
      knowledge_ok: config.knowledge.ok === true,
      version: config.knowledge.version || null,
      sha256: config.knowledge.sha256 || null,
      xff_mode: ['strict', 'best_effort'].includes(env.SUPPORT_VOICE_XFF_MODE) ? env.SUPPORT_VOICE_XFF_MODE : null,
      scale_lease_ok: config.scaleLeaseHealthy,
    };
  }

  function finalize(entry, reason = 'ended') {
    if (!entry || entry.phase === 'terminal') return;
    entry.phase = 'terminal';
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    if (entry.userHash) userSessions.delete(entry.userHash);
    if (entry.sessionId) sessions.delete(entry.sessionId);
    entry.credentialDigest = null;
    entry.userHash = null;
    const upstream = entry.upstream;
    try {
      if (entry.browser && entry.browser.readyState === WebSocket.OPEN) {
        const message = ['ended', 'idle_timeout', 'max_duration'].includes(reason)
          ? { type: 'ended', reason }
          : { type: 'error', code: 'support_voice_unavailable' };
        entry.browser.send(JSON.stringify(message));
      }
    } catch {}
    try { entry.browser?.close(1000, 'ended'); } catch {}
    try {
      upstream?.close();
      if (upstream && typeof upstream.terminate === 'function') {
        const terminateTimer = setTimeout(() => { try { upstream.terminate(); } catch {} }, UPSTREAM_CLOSE_GRACE_MS);
        terminateTimer.unref?.();
        upstream.once?.('close', () => clearTimeout(terminateTimer));
      }
    } catch {}
    if (entry.browserToUpstream) {
      entry.browserToUpstream.frames = 0;
      entry.browserToUpstream.bytes = 0;
    }
    if (entry.upstreamToBrowser) {
      entry.upstreamToBrowser.frames = 0;
      entry.upstreamToBrowser.bytes = 0;
    }
    entry.browser = null;
    entry.upstream = null;
  }

  function finalizeAll(reason = 'shutdown') {
    for (const entry of [...sessions.values()]) finalize(entry, reason);
  }

  async function refreshScaleLease() {
    if (env.NODE_ENV === 'test' && options.scaleLeaseHealthy === true) return;
    if (!leaseRoute || !leaseSubject || typeof serviceDb.from !== 'function') {
      scaleLeaseHealthy = false;
      scaleLeaseUpdatedAt = 0;
      finalizeAll('support_voice_unavailable');
      return;
    }
    try {
      const query = serviceDb.from('request_rate_limits').select('updated_at').eq('route_name', leaseRoute).eq('subject_key', leaseSubject);
      const result = typeof query.maybeSingle === 'function' ? await query.maybeSingle() : await query;
      const timestamp = result?.data?.updated_at;
      const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      const fresh = !result?.error && Number.isFinite(parsed) && parsed <= Date.now() + 1000 && Date.now() - parsed <= 5000;
      scaleLeaseHealthy = fresh;
      scaleLeaseUpdatedAt = fresh ? parsed : 0;
      if (!fresh) finalizeAll('support_voice_unavailable');
    } catch {
      scaleLeaseHealthy = false;
      scaleLeaseUpdatedAt = 0;
      finalizeAll('support_voice_unavailable');
    }
  }

  function validMonitorToken(req) {
    const expected = String(env.SUPPORT_VOICE_MONITOR_TOKEN || '');
    const header = String(req.headers.authorization || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(expected) || !header.startsWith('Bearer ')) return false;
    const supplied = header.slice(7);
    if (supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  monitorRouter.use((req, res, next) => {
    noStore(res);
    if (!validMonitorToken(req)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  monitorRouter.get('/instance', (_req, res) => {
    const instance = String(env.RENDER_INSTANCE_ID || env.HOSTNAME || '').trim();
    return res.json({
      service_id: renderServiceId || null,
      commit: renderCommit || null,
      instance_sha256: instance ? digest(instance) : null,
    });
  });
  monitorRouter.post('/scale-lease', express.json({ limit: '4kb', strict: true }), async (req, res) => {
    const body = req.body;
    const observedAt = typeof body?.observed_at === 'string' ? Date.parse(body.observed_at) : NaN;
    const instanceIds = Array.isArray(body?.instance_ids) ? body.instance_ids : [];
    const valid = exactKeys(body, ['service_id', 'commit', 'running_instances', 'autoscaling', 'active_deploy', 'observed_at', 'instance_ids']) &&
      body.service_id === renderServiceId && body.commit === renderCommit && body.running_instances === 1 &&
      body.autoscaling === false && body.active_deploy === false && instanceIds.length === 1 &&
      typeof instanceIds[0] === 'string' && /^[a-f0-9]{64}$/.test(instanceIds[0]) &&
      Number.isFinite(observedAt) && observedAt <= Date.now() + 1000 && Date.now() - observedAt <= 5000 &&
      leaseRoute === `support_voice_scale_lease:${renderCommit}`;
    if (!valid || typeof serviceDb.rpc !== 'function') {
      scaleLeaseHealthy = false;
      scaleLeaseUpdatedAt = 0;
      finalizeAll('support_voice_unavailable');
      return res.status(409).json({ ok: false });
    }
    try {
      const { data, error } = await serviceDb.rpc('check_and_increment_rate_limit', {
        p_route_name: leaseRoute,
        p_subject_key: leaseSubject,
        p_window_ms: 60000,
        p_max_count: 2147483647,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || row.allowed !== true) throw new Error('lease');
      scaleLeaseHealthy = true;
      scaleLeaseUpdatedAt = Date.now();
      return res.json({ ok: true });
    } catch {
      scaleLeaseHealthy = false;
      scaleLeaseUpdatedAt = 0;
      finalizeAll('support_voice_unavailable');
      return res.status(503).json({ ok: false });
    }
  });
  monitorRouter.delete('/scale-lease', async (_req, res) => {
    scaleLeaseHealthy = false;
    scaleLeaseUpdatedAt = 0;
    finalizeAll('support_voice_unavailable');
    try {
      if (!leaseRoute || !leaseSubject || typeof serviceDb.from !== 'function') throw new Error('lease');
      const table = serviceDb.from('request_rate_limits');
      if (!table || typeof table.delete !== 'function') throw new Error('lease');
      const query = table.delete().eq('route_name', leaseRoute).eq('subject_key', leaseSubject);
      const result = await query;
      if (result?.error) throw new Error('lease');
      return res.status(204).end();
    } catch {
      return res.status(503).json({ ok: false });
    }
  });

  function reserve(userHash) {
    if (userSessions.has(userHash)) return { error: 'conflict' };
    if (sessions.size >= MAX_SESSIONS) return { error: 'capacity' };
    const sessionId = base64url(16);
    const credential = base64url(32);
    const now = Date.now();
    const entry = {
      sessionId,
      credentialDigest: digest(credential),
      userHash,
      phase: 'pending',
      createdAt: now,
      expiresAt: now + pendingTtlMs,
      browser: null,
      upstream: null,
      timers: new Set(),
      speaking: false,
      idleExpired: false,
      responseEpoch: 0,
      responseActive: false,
      responseInterrupted: false,
      browserToUpstream: { frames: 0, bytes: 0 },
      upstreamToBrowser: { frames: 0, bytes: 0 },
    };
    const ttl = setTimeout(() => finalize(entry, 'expired'), pendingTtlMs);
    ttl.unref?.();
    entry.timers.add(ttl);
    sessions.set(sessionId, entry);
    userSessions.set(userHash, entry);
    return { entry, credential };
  }

  async function increment(action, subject, windowMs, maxCount) {
    if (!RATE_ACTIONS.has(action)) throw new Error('SUPPORT_VOICE_RATE_ACTION_INVALID');
    const result = await Promise.race([
      rateLimit({ routeName: action, subjectKey: digest(subject), windowMs, maxCount }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SUPPORT_VOICE_RATE_TIMEOUT')), rateTimeoutMs)),
    ]);
    if (!result || typeof result !== 'object' || typeof result.allowed !== 'boolean') throw new Error('SUPPORT_VOICE_RATE_RESULT_INVALID');
    return result.allowed;
  }

  router.use((req, res, next) => {
    noStore(res);
    if (!exactOrigin(req, env)) return res.status(403).json({ error: 'support_voice_unavailable' });
    setCors(req, res);
    next();
  });

  router.options(['/sessions', '/sessions/pending'], (req, res) => {
    const requestedMethod = String(req.headers['access-control-request-method'] || '');
    const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
    if (!['POST', 'DELETE'].includes(requestedMethod) || requestedHeaders.some((value) => value !== 'authorization')) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    return res.status(204).end();
  });

  router.post('/sessions', rejectRequestBody, requireAuth, async (req, res) => {
    const rawUserId = req.user?.id;
    const isAdmin = req.isGlobalAdmin === true;
    delete req.userToken;
    if (req.user) req.user.email = null;
    if (typeof rawUserId !== 'string' || !rawUserId) return res.status(401).json({ error: 'support_voice_unauthorized' });
    const userHash = digest(rawUserId);
    try {
      const member = isAdmin || await hasAnyActiveClientMembership({ serviceDb, userId: rawUserId });
      if (!member) return res.status(403).json({ error: 'support_voice_forbidden' });
      const config = configuration();
      if (!config.ready) return res.status(503).json({ error: 'support_voice_unavailable' });
      if (!await increment('support_voice_session_create:user', userHash, 15 * 60_000, 5)) return res.status(429).json({ error: 'support_voice_rate_limited' });
      const ip = safeIp(req, env.SUPPORT_VOICE_XFF_MODE);
      if (ip && !await increment('support_voice_session_create:ip', ip, 15 * 60_000, 20)) return res.status(429).json({ error: 'support_voice_rate_limited' });
      const reserved = reserve(userHash);
      if (reserved.error === 'conflict') return res.status(409).json({ error: 'support_voice_already_open' });
      if (reserved.error) return res.status(503).json({ error: 'support_voice_unavailable' });
      const onClose = () => { if (!res.writableFinished) finalize(reserved.entry, 'response_failed'); };
      res.once('close', onClose);
      res.once('error', onClose);
      return res.status(201).json({
        session_id: reserved.entry.sessionId,
        credential: reserved.credential,
        expires_at: new Date(reserved.entry.expiresAt).toISOString(),
      });
    } catch (_error) {
      return res.status(503).json({ error: 'support_voice_unavailable' });
    }
  });

  router.delete('/sessions/pending', rejectRequestBody, requireAuth, (req, res) => {
    const rawUserId = req.user?.id;
    delete req.userToken;
    if (req.user) req.user.email = null;
    if (typeof rawUserId === 'string' && rawUserId) {
      const entry = userSessions.get(digest(rawUserId));
      if (entry?.phase === 'pending') finalize(entry, 'abandoned');
    }
    return res.status(204).end();
  });

  router.get('/health', (_req, res) => {
    return res.json(publicHealth());
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: BROWSER_MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols(protocols) { return protocols.size === 1 && protocols.has(PROTOCOL) ? PROTOCOL : false; },
  });

  function consumeCredential(credential) {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return null;
    const credentialDigest = digest(credential);
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (entry.phase === 'pending' && now < entry.expiresAt && entry.credentialDigest && crypto.timingSafeEqual(Buffer.from(entry.credentialDigest), Buffer.from(credentialDigest))) {
        entry.phase = 'consumed';
        entry.credentialDigest = null;
        return entry;
      }
    }
    return null;
  }

  function guardedSend(entry, direction, socket, encoded, maxPayload) {
    const bytes = Buffer.byteLength(encoded);
    const counters = entry?.[direction];
    if (!counters || socket?.readyState !== WebSocket.OPEN || bytes <= 0 || bytes > maxPayload ||
        counters.frames + 1 > INFLIGHT_MAX_FRAMES || counters.bytes + bytes > INFLIGHT_MAX_BYTES ||
        socket.bufferedAmount > INFLIGHT_MAX_BYTES) return false;
    counters.frames += 1;
    counters.bytes += bytes;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      counters.frames = Math.max(0, counters.frames - 1);
      counters.bytes = Math.max(0, counters.bytes - bytes);
      if (error) finalize(entry, 'support_voice_unavailable');
    };
    try { socket.send(encoded, settle); } catch (error) { settle(error); return false; }
    return true;
  }

  function sendBrowser(entry, message) {
    return guardedSend(entry, 'upstreamToBrowser', entry.browser, JSON.stringify(message), UPSTREAM_MAX_PAYLOAD);
  }

  function sendUpstream(entry, message) {
    return guardedSend(entry, 'browserToUpstream', entry.upstream, JSON.stringify(message), BROWSER_MAX_PAYLOAD);
  }

  function clearEntryTimer(entry, key) {
    const timer = entry[key];
    if (!timer) return;
    clearTimeout(timer);
    entry.timers.delete(timer);
    entry[key] = null;
  }

  function resetIdle(entry) {
    clearEntryTimer(entry, 'idleTimer');
    const timer = setTimeout(() => {
      if (entry.speaking) entry.idleExpired = true;
      else finalize(entry, 'idle_timeout');
    }, idleMs);
    timer.unref?.();
    entry.idleTimer = timer;
    entry.timers.add(timer);
  }

  function startHeartbeat(entry) {
    const schedulePing = () => {
      if (entry.phase === 'terminal') return;
      const timer = setTimeout(() => {
        entry.timers.delete(timer);
        entry.heartbeatTimer = null;
        if (entry.phase === 'terminal' || entry.browser?.readyState !== WebSocket.OPEN) return finalize(entry, 'support_voice_unavailable');
        entry.awaitingPong = true;
        try { entry.browser.ping(); } catch { return finalize(entry, 'support_voice_unavailable'); }
        const deadline = setTimeout(() => {
          entry.timers.delete(deadline);
          entry.heartbeatDeadline = null;
          if (entry.awaitingPong) finalize(entry, 'support_voice_unavailable');
        }, heartbeatGraceMs);
        deadline.unref?.();
        entry.heartbeatDeadline = deadline;
        entry.timers.add(deadline);
      }, heartbeatIntervalMs);
      timer.unref?.();
      entry.heartbeatTimer = timer;
      entry.timers.add(timer);
    };
    entry.browser.on('pong', () => {
      if (!entry.awaitingPong || entry.phase === 'terminal') return;
      entry.awaitingPong = false;
      clearEntryTimer(entry, 'heartbeatDeadline');
      schedulePing();
    });
    schedulePing();
  }

  function connectUpstream(entry) {
    const built = buildSupportVoicePrompt();
    entry.phase = 'upstream_connecting';
    const upstream = new WebSocketClient(UPSTREAM_URL, {
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
      maxPayload: UPSTREAM_MAX_PAYLOAD,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    });
    entry.upstream = upstream;
    const setup = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 5000);
    setup.unref?.();
    entry.timers.add(setup);
    upstream.on('open', () => {
      if (entry.phase !== 'upstream_connecting') return finalize(entry, 'support_voice_unavailable');
      clearTimeout(setup);
      entry.timers.delete(setup);
      entry.phase = 'session_update_sent';
      upstream.send(JSON.stringify(buildAuthoritativeSessionUpdate({ prompt: built.prompt, voice: DEFAULT_VOICE })), (error) => {
        if (error) finalize(entry, 'support_voice_unavailable');
      });
      const ack = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 5000);
      ack.unref?.();
      entry.timers.add(ack);
      entry.ackTimer = ack;
    });
    upstream.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > UPSTREAM_MAX_PAYLOAD) return finalize(entry, 'support_voice_unavailable');
      const event = parseJsonTextFrame(raw, UPSTREAM_MAX_PAYLOAD);
      if (!event) return finalize(entry, 'support_voice_unavailable');
      if (validatePreAttestationProviderEvent(event)) {
        if (entry.phase === 'session_update_sent' ||
            (event.type === 'ping' && (entry.phase === 'greeting_sent' || entry.phase === 'ready'))) return;
        return finalize(entry, 'support_voice_unavailable');
      }
      if (event.type === 'session.updated') {
        if (entry.phase !== 'session_update_sent' || !validateSessionUpdated(event, { prompt: built.prompt, voice: DEFAULT_VOICE })) return finalize(entry, 'support_voice_unavailable');
        clearTimeout(entry.ackTimer);
        entry.timers.delete(entry.ackTimer);
        entry.phase = 'greeting_sent';
        const greetingTimer = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 2000);
        greetingTimer.unref?.();
        entry.timers.add(greetingTimer);
        upstream.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'force_message', role: 'assistant', interruptible: true, content: [{ type: 'output_text', text: SUPPORT_GREETING }] } }), (error) => {
          clearTimeout(greetingTimer);
          entry.timers.delete(greetingTimer);
          if (error) return finalize(entry, 'support_voice_unavailable');
          entry.phase = 'ready';
          if (!sendBrowser(entry, { type: 'ready' })) return finalize(entry, 'support_voice_unavailable');
          resetIdle(entry);
        });
        return;
      }
      if (entry.phase !== 'ready') return finalize(entry, 'support_voice_unavailable');
      const classified = classifyProviderEvent(event);
      if (classified.action === 'finalize') return finalize(entry, 'support_voice_unavailable');
      if (event.type === 'response.created') {
        if (entry.responseActive || entry.idleExpired) return finalize(entry, entry.idleExpired ? 'idle_timeout' : 'support_voice_unavailable');
        entry.responseEpoch += 1;
        entry.responseActive = true;
        entry.responseInterrupted = false;
        entry.speaking = true;
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        entry.responseInterrupted = entry.responseActive;
        entry.speaking = false;
      }
      if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') &&
          (!entry.responseActive || !entry.speaking || entry.responseInterrupted)) return;
      if (event.type === 'response.done') {
        if (!entry.responseActive) return;
        entry.responseActive = false;
        entry.speaking = false;
        if (entry.idleExpired) return finalize(entry, 'idle_timeout');
      }
      if (event.type === 'input_audio_buffer.speech_started') resetIdle(entry);
      if (classified.action === 'forward' && !sendBrowser(entry, classified.message)) return finalize(entry, 'support_voice_unavailable');
      if (classified.action === 'forward_many' && classified.messages.some((message) => !sendBrowser(entry, message))) return finalize(entry, 'support_voice_unavailable');
    });
    upstream.on('error', () => finalize(entry, 'support_voice_unavailable'));
    upstream.on('close', () => finalize(entry, 'ended'));
  }

  wss.on('connection', (socket) => {
    preauthCount += 1;
    let entry = null;
    let authenticated = false;
    let preauthReleased = false;
    const allFrames = createTokenBucket(ALL_FRAME_RATE, ALL_FRAME_BURST);
    const releasePreauth = () => {
      if (preauthReleased) return;
      preauthReleased = true;
      preauthCount = Math.max(0, preauthCount - 1);
    };
    const authTimer = setTimeout(() => { try { socket.close(1008, 'unauthorized'); } catch {} }, 5000);
    authTimer.unref?.();
    socket.once('message', (raw, isBinary) => {
      clearTimeout(authTimer);
      releasePreauth();
      if (!consumeToken(allFrames) || isBinary || raw.length > 1024) return socket.close(1008, 'unauthorized');
      const auth = parseJsonTextFrame(raw, 1024);
      if (!auth) return socket.close(1008, 'unauthorized');
      if (!exactKeys(auth, ['type', 'credential']) || auth.type !== 'authenticate') return socket.close(1008, 'unauthorized');
      entry = consumeCredential(auth.credential);
      auth.credential = null;
      if (!entry) return socket.close(1008, 'unauthorized');
      authenticated = true;
      entry.browser = socket;
      entry.allFrames = allFrames;
      entry.audioFrames = createTokenBucket(AUDIO_FRAME_RATE, AUDIO_FRAME_BURST);
      entry.audioBytes = createTokenBucket(AUDIO_BYTE_RATE, AUDIO_BYTE_BURST);
      const maximum = setTimeout(() => finalize(entry, 'max_duration'), maxSessionMs);
      maximum.unref?.();
      entry.timers.add(maximum);
      startHeartbeat(entry);
      try { connectUpstream(entry); } catch { return finalize(entry, 'support_voice_unavailable'); }
      socket.on('message', (frame, binary) => {
        if (!authenticated || !entry || !consumeToken(entry.allFrames) || binary || frame.length > BROWSER_MAX_PAYLOAD || entry.phase !== 'ready') return finalize(entry, 'protocol_error');
        const event = parseJsonTextFrame(frame, BROWSER_MAX_PAYLOAD);
        if (!event) return finalize(entry, 'protocol_error');
        const validated = validateBrowserEvent(event);
        if (!validated || entry.upstream?.readyState !== WebSocket.OPEN) return finalize(entry, 'protocol_error');
        if (validated.type === 'input_audio_buffer.append') {
          const audioBytes = Buffer.from(validated.audio, 'base64').length;
          if (!consumeToken(entry.audioFrames) || !consumeToken(entry.audioBytes, audioBytes)) return finalize(entry, 'protocol_error');
        }
        if (!sendUpstream(entry, validated)) return finalize(entry, 'support_voice_unavailable');
      });
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (!authenticated) releasePreauth();
      if (entry) finalize(entry, 'ended');
    });
    socket.on('error', () => {
      clearTimeout(authTimer);
      if (!authenticated) releasePreauth();
      if (entry) finalize(entry, 'support_voice_unavailable');
    });
  });

  function attach(server) {
    if (attachedServer === server) return;
    if (attachedServer) throw new Error('SUPPORT_VOICE_ALREADY_ATTACHED');
    attachedServer = server;
    if (env.NODE_ENV !== 'test') {
      scalePollTimer = setInterval(() => { void refreshScaleLease(); }, 2000);
      scalePollTimer.unref?.();
      void refreshScaleLease();
    }
    server.on('upgrade', (req, socket, head) => {
      let path;
      try { path = new URL(req.url, 'http://localhost').pathname; } catch { return socket.destroy(); }
      if (path !== SESSION_PATH || !configuration().ready || !exactOrigin(req, env)) return socket.destroy();
      const protocol = req.headers['sec-websocket-protocol'];
      if (typeof protocol !== 'string' || protocol !== PROTOCOL || preauthCount >= MAX_PREAUTH) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (websocket) => wss.emit('connection', websocket, req));
    });
  }

  return {
    attach,
    finalizeAll: () => {
      if (scalePollTimer) clearInterval(scalePollTimer);
      scalePollTimer = null;
      finalizeAll('shutdown');
    },
    health: configuration,
    publicHealth,
    monitorRouter,
    router,
    setScaleLeaseHealthyForTest(value) {
      if (env.NODE_ENV !== 'test') throw new Error('SUPPORT_VOICE_TEST_ONLY');
      scaleLeaseHealthy = value === true;
      scaleLeaseUpdatedAt = scaleLeaseHealthy ? Date.now() : 0;
    },
    _state: { sessions, userSessions, wss },
  };
}

module.exports = {
  ALL_FRAME_BURST,
  ALL_FRAME_RATE,
  AUDIO_BYTE_BURST,
  AUDIO_BYTE_RATE,
  AUDIO_FRAME_BURST,
  AUDIO_FRAME_RATE,
  BROWSER_MAX_PAYLOAD,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  IDLE_MS,
  INFLIGHT_MAX_BYTES,
  INFLIGHT_MAX_FRAMES,
  MAX_PREAUTH,
  MAX_SESSIONS,
  PENDING_TTL_MS,
  PROTOCOL,
  QA_ORIGIN,
  RATE_ACTIONS,
  SESSION_PATH,
  consumeToken,
  createTokenBucket,
  createSupportVoiceGateway,
  exactOrigin,
  isConfigurationReady,
  isPublicIp,
  rejectRequestBody,
  safeIp,
};
