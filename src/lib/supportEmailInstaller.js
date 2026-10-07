// Explicit local QA connection only. Never imported by the hosted application.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createSupportEmailOAuth, REDIRECT } = require('./supportEmailOAuth');
const { READONLY_SCOPE } = require('./supportEmailAdapters');
const CLIENT = '940084368446-rmd990rkphtbbshq85tk357kcd3dl0t8.apps.googleusercontent.com';
const PROJECT = 'alphascreen-alphy-support';
const HOST = '127.0.0.1:43871';
const ORIGIN = 'http://' + HOST;
const MAILBOX = 'alphy@alphasourceai.com';
const fail = () => { throw new Error('SUPPORT_EMAIL_INSTALLER_CONFIG'); };
const equal = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };

function gates(env) {
  if (env.SUPPORT_EMAIL_CONNECTION_APPROVED !== 'true' || env.SUPPORT_EMAIL_OAUTH_ENABLED !== 'true' || env.SUPPORT_EMAIL_ENABLED !== 'false' || env.SUPPORT_EMAIL_ENVIRONMENT !== 'qa' ||
      env.SUPPORT_EMAIL_MODE !== 'qa-draft' || env.SUPABASE_URL !== 'https://yjjxzxoghlpguquknyso.supabase.co' || env.SUPPORT_EMAIL_MAILBOX !== MAILBOX) fail();
}
function acl(filename) {
  if (process.platform !== 'darwin') return;
  // Fixed binary, no shell, metadata only. Deny ACL grants even if POSIX bits look private.
  const listing = execFileSync('/bin/ls', ['-lde', filename], { encoding: 'utf8', maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] });
  const entries = listing.split('\n').slice(1).filter(line => line.trim());
  if (entries.some(line => !/^\s*\d+: .* deny [a-z_, ]+$/.test(line))) fail();
}
function ancestors(filename) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) fail();
  let dir = path.dirname(filename);
  while (dir !== path.dirname(dir)) {
    const s = fs.lstatSync(dir);
    // Sticky root-owned temporary parents are allowed only for synthetic tests.
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid()].includes(s.uid) ||
        ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) fail();
    acl(dir);
    dir = path.dirname(dir);
  }
}
function secureRead(filename) {
  ancestors(filename);
  acl(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 8192) fail();
    const buffer = Buffer.alloc(8193);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 8192) fail();
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function loadClient(filename, env) {
  gates(env);
  try {
    const parsed = secureRead(filename), c = parsed.web;
    const allowed = new Set(['client_id','project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_secret','redirect_uris','javascript_origins']);
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(parsed).length !== 1 || Object.keys(c).some(k=>!allowed.has(k)) ||
        c.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' || c.project_id !== PROJECT || c.client_id !== CLIENT || c.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
        c.token_uri !== 'https://oauth2.googleapis.com/token' || !Array.isArray(c.redirect_uris) || c.redirect_uris.length !== 1 || c.redirect_uris[0] !== REDIRECT ||
        (c.javascript_origins && (!Array.isArray(c.javascript_origins) || c.javascript_origins.length)) ||
        typeof c.client_secret !== 'string' || !/^[\x21-\x7e]{20,256}$/.test(c.client_secret)) fail();
    return { clientId: CLIENT, clientSecret: c.client_secret };
  } catch (_) { fail(); }
}

function prepareStore(filename) {
  try {
    const dir = path.dirname(filename);
    ancestors(dir); // Parent must already exist; no recursive mkdir.
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) fail();
    acl(dir);
    ancestors(filename);
    if (fs.existsSync(filename) || fs.lstatSync(dir).ino !== s.ino) fail();
    // Detect dangling target links as well as regular existing files.
    try { fs.lstatSync(filename); fail(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } catch (_) { fail(); }
}
function storeGrant(filename, grant, env, now = Date.now) {
  gates(env);
  if (grant.mailbox !== MAILBOX || grant.scope !== READONLY_SCOPE || typeof grant.refreshToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(grant.refreshToken) ||
      typeof grant.baselineHistoryId !== 'string' || !/^\d{1,30}$/.test(grant.baselineHistoryId) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now()) fail();
  prepareStore(filename);
  const tmp = path.join(path.dirname(filename), '.grant-' + randomBytes(16).toString('hex'));
  let fd, linked = false, inode;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    inode = fs.fstatSync(fd).ino;
    fs.writeFileSync(fd, JSON.stringify({ clientId: CLIENT, mailbox: MAILBOX, scope: READONLY_SCOPE,
      refreshToken: grant.refreshToken, baselineHistoryId: grant.baselineHistoryId, capturedAt: new Date(now()).toISOString(), accessTokenExpiresAt: grant.expiresAt }) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    gates(env); ancestors(filename);
    fs.linkSync(tmp, filename); linked = true; // Exclusive, atomic publication; never overwrite.
    fs.unlinkSync(tmp);
    const saved = secureRead(filename);
    if (saved.refreshToken !== grant.refreshToken || saved.clientId !== CLIENT) fail();
    const dirFd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.lstatSync(tmp).ino === inode) fs.unlinkSync(tmp); } catch (_) { /* Only own unpublished temporary name. */ }
    // The exclusive publication link is the commit point. Never revoke or erase a committed grant.
    const error = new Error('SUPPORT_EMAIL_INSTALLER_STORAGE'); error.committed = linked; throw error;
  }
}

function createInstaller({ env, client, destination, fetchImpl = fetch, now = Date.now, save = storeGrant }) {
  gates(env);
  if (client.clientId !== CLIENT || typeof client.clientSecret !== 'string') fail();
  const oauthEnv = { ...env, SUPPORT_EMAIL_GOOGLE_CLIENT_ID: CLIENT, SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET: client.clientSecret,
    SUPPORT_EMAIL_GOOGLE_REDIRECT_URI: REDIRECT };
  const oauth = createSupportEmailOAuth({ env: oauthEnv, fetchImpl, now });
  const bootstrap = randomBytes(32).toString('base64url'), session = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const deadline = now() + 300000;
  let stage = 'new', canceled = false;
  const response = (status, body, extra = {}) => ({ status, headers: { ...headers, ...extra }, body });
  const denied = () => response(403, '<p>Connection request rejected.</p>');
  const ended = code => ({ ...response(code === 'CONNECTED' ? 200 : 400, code === 'CONNECTED' ? '<p>alphy QA read-only connection saved. Automatic replies remain off.</p>' : '<p>Connection failed. Check the local status; do not retry without review.</p>'), terminal: code });
  function cookie(header) {
    const values = typeof header === 'string' ? header.split(';').map(v => v.trim()).filter(v => v.startsWith('alphy_qa_session=')) : [];
    return values.length === 1 && equal(values[0].slice('alphy_qa_session='.length), session);
  }
  return {
    bootstrapUrl: ORIGIN + '/oauth/bootstrap/' + bootstrap,
    deadline,
    abort() { canceled = true; },
    async handle({ method, url, headers: h = {}, body = '' }) {
      if (h.host !== HOST || typeof url !== 'string' || url.length > 8192 || !url.startsWith('/') || url.startsWith('//')) return denied();
      try { gates(env); } catch (_) { stage = 'done'; return ended('CONFIG_CHANGED'); }
      if (canceled || now() >= deadline) { stage = 'done'; return ended('EXPIRED'); }
      const u = new URL(url, ORIGIN);
      if (stage === 'new' && method === 'GET' && u.pathname === '/oauth/bootstrap/' + bootstrap && !u.search) {
        if (h.origin && h.origin !== ORIGIN) return denied();
        if (h['sec-fetch-site'] && !['none', 'same-origin'].includes(h['sec-fetch-site'])) return denied();
        stage = 'form';
        return response(200, '<h1>alphy QA connection</h1><p>Connect only alphy@alphasourceai.com with Gmail read-only access. No sending or automatic processing.</p>' +
          '<p>Client: '+CLIENT+'</p><p>Redirect: '+REDIRECT+'</p><p>Grant: /Users/jasongardner/Downloads/alphy-support-qa/grant.json</p>' +
          '<form action="/oauth/connect" method="post"><input type="hidden" name="csrf" value="' + csrf + '"><button>Connect alphy read-only</button></form>',
          { 'Set-Cookie': 'alphy_qa_session=' + session + '; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=300',
            'Content-Security-Policy': "default-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action http://127.0.0.1:43871" });
      }
      if (!cookie(h.cookie)) return denied();
      if (u.pathname === '/oauth/connect' && method === 'POST' && stage === 'form') {
        if (u.search || h.origin !== ORIGIN || h['content-type'] !== 'application/x-www-form-urlencoded' || Buffer.byteLength(body) > 256) return denied();
        const p = new URLSearchParams(body);
        if ([...p.keys()].length !== 1 || !equal(p.get('csrf'), csrf)) return denied();
        gates(env); stage = 'waiting';
        const auth = new URL(oauth.begin());
        if (auth.origin + auth.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth' || auth.searchParams.get('client_id') !== CLIENT ||
            auth.searchParams.get('redirect_uri') !== REDIRECT || auth.searchParams.get('scope') !== READONLY_SCOPE) { stage='done'; return ended('FAILED'); }
        return response(303, '', { Location: auth.href });
      }
      if (u.pathname === '/oauth/callback' && method === 'GET' && stage === 'waiting') {
        stage = 'busy'; // First authenticated exact-path callback is terminal, even malformed.
        const allowed = new Set(['state', 'code', 'error', 'scope', 'authuser', 'prompt', 'iss']);
        const keys = [...u.searchParams.keys()];
        if (keys.some(k => !allowed.has(k)) || keys.length !== new Set(keys).size || !u.searchParams.has('state') ||
            u.searchParams.has('code') === u.searchParams.has('error') || (u.searchParams.has('iss') && u.searchParams.get('iss') !== 'https://accounts.google.com')) {
          stage='done'; return ended('FAILED');
        }
        let grant;
        try {
          gates(env);
          grant = await oauth.complete(Object.fromEntries(u.searchParams));
          gates(env);
          if (canceled || now() >= deadline) throw new Error('EXPIRED');
          save(destination, grant, env, now);
          stage = 'done'; return ended('CONNECTED');
        } catch (e) {
          let status = e.message === 'SUPPORT_EMAIL_OAUTH_REVOKE_UNCONFIRMED' ? 'REVOKE_UNCONFIRMED' : 'FAILED';
          if (grant && !e.committed) { try { await oauth.revoke(grant.refreshToken); } catch (_) { status = 'REVOKE_UNCONFIRMED'; } }
          stage = 'done'; return ended(status);
        }
      }
      return denied();
    },
  };
}

async function listenInstaller(installer) {
  let active = 0, stopping;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    active++;
    let body = '', result;
    try {
      for await (const part of req) { body += part.toString('utf8'); if (Buffer.byteLength(body) > 256) throw new Error('SIZE'); }
      result = await installer.handle({ method: req.method, url: req.url, headers: req.headers, body });
    } catch (_) { result = { status: 400, headers, body: '<p>Connection request rejected.</p>' }; }
    if (!res.destroyed) { res.writeHead(result.status, result.headers); res.end(result.body, () => { if (result.terminal) finish(result.terminal); }); }
    else if (result.terminal) finish(result.terminal);
    active--;
    if (stopping && active === 0) resolveDone(stopping);
  });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const timer = setTimeout(() => finish('EXPIRED'), Math.max(1, installer.deadline - Date.now()));
  function finish(status) {
    if (!stopping || status === 'REVOKE_UNCONFIRMED') stopping = status;
    if (status !== 'CONNECTED') installer.abort();
    clearTimeout(timer); server.close(); server.closeAllConnections();
    if (active === 0) resolveDone(stopping);
  }
  server.on('clientError', (_, socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43871, '127.0.0.1', resolve); });
  } catch (_) { clearTimeout(timer); server.close(); throw new Error('SUPPORT_EMAIL_INSTALLER_LISTEN'); }
  return { address: server.address(), done, close: () => finish('CLOSED') };
}

module.exports = { CLIENT, PROJECT, HOST, ORIGIN, loadClient, prepareStore, storeGrant, createInstaller, listenInstaller };
