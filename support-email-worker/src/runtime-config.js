'use strict';
// Hosted QA entry point only. Original local installers/grants are never changed.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { validateGrant, QA, MAILBOX, OWNER } = require('./qa-config');
const { validateSendGrant } = require('./send-config');
const readPins = require('../../src/lib/supportEmailInstaller');
const sendPins = require('./send-oauth');
const READ_REDIRECT = require('../../src/lib/supportEmailOAuth').REDIRECT;
const NAME = 'alphascreen-alphy-mail-qa';
const PATHS = Object.freeze({ readClient: '/etc/secrets/alphy-read-client.json', readGrant: '/etc/secrets/alphy-read-grant.json',
  sendClient: '/etc/secrets/alphy-send-client.json', sendGrant: '/etc/secrets/alphy-send-grant.json', keys: '/etc/secrets/alphy-runtime-keys.json' });
const fail = () => { throw Error('SUPPORT_EMAIL_RUNTIME_CONFIG'); };
const secret = s => typeof s === 'string' && /^[\x21-\x7e]{20,8192}$/.test(s);

function validateRuntimeEnvironment(env) {
  if (env.SUPPORT_EMAIL_WORKER_ENABLED !== 'true') return null;
  if (env.RENDER !== 'true' || env.RENDER_SERVICE_NAME !== NAME || !/^crn-[a-z0-9]{20,30}$/.test(env.RENDER_SERVICE_ID || '') ||
      env.SUPABASE_URL !== QA || env.SUPPORT_EMAIL_ENVIRONMENT !== 'qa' || env.SUPPORT_EMAIL_MAILBOX !== MAILBOX ||
      env.SUPPORT_EMAIL_OWNER_TEST_SENDER !== OWNER || env.SUPPORT_EMAIL_OWNER_TEST_ONLY !== 'true' ||
      !['qa-draft', 'qa-owner-auto'].includes(env.SUPPORT_EMAIL_WORKER_MODE) || env.SUPPORT_EMAIL_SECRET_MOUNT_APPROVED !== 'true') fail();
  const auto = env.SUPPORT_EMAIL_WORKER_MODE === 'qa-owner-auto' && env.SUPPORT_EMAIL_WORKER_SEND_APPROVED === 'true' && env.SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED === 'true';
  return Object.freeze({ mode: auto ? 'qa-owner-auto' : 'qa-draft', serviceId: env.RENDER_SERVICE_ID });
}
function validateManifest(value) {
  let manifest;
  try { manifest = JSON.parse(value); } catch (_) { fail(); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== Object.keys(PATHS).sort().join(',')) fail();
  for (const entry of Object.values(manifest)) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'mode,uid' || !Number.isSafeInteger(entry.uid) || entry.uid < 0 ||
        !['0400', '0600', '0444', '0644'].includes(entry.mode)) fail();
  }
  return manifest;
}
function readMountedJson(filename) {
  if (!Object.values(PATHS).includes(filename) || process.platform !== 'linux') fail();
  const manifest = validateManifest(process.env.SUPPORT_EMAIL_MOUNT_MANIFEST);
  const expected = manifest[Object.keys(PATHS).find(k => PATHS[k] === filename)];
  for (const dir of ['/etc', '/etc/secrets']) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid()].includes(s.uid) || (s.mode & 0o022)) fail();
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const s = fs.fstatSync(fd);
    // Exact tuple pinned after metadata-only host inspection, never a mode range.
    if (!s.isFile() || s.nlink !== 1 || ![0, process.getuid()].includes(s.uid) ||
        s.uid !== expected.uid || (s.mode & 0o7777) !== parseInt(expected.mode, 8) || s.size < 2 || s.size > 32768) fail();
    bytes = Buffer.alloc(s.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== s.size) fail();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, s.size)));
  } catch (_) { fail(); }
  finally { if (bytes) bytes.fill(0); fs.closeSync(fd); }
}
function validateMountedClient(parsed, kind) {
  const send = kind === 'send', c = parsed?.web;
  if (!['read', 'send'].includes(kind) || !c || typeof c !== 'object' || Array.isArray(c) || Object.keys(parsed).length !== 1 ||
      Object.keys(c).some(k => !['client_id', 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_secret', 'redirect_uris', 'javascript_origins'].includes(k)) ||
      c.client_id !== (send ? sendPins.CLIENT : readPins.CLIENT) || c.project_id !== (send ? sendPins.PROJECT : readPins.PROJECT) ||
      c.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' || c.token_uri !== 'https://oauth2.googleapis.com/token' ||
      c.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' ||
      !Array.isArray(c.redirect_uris) || c.redirect_uris.length !== 1 || c.redirect_uris[0] !== (send ? sendPins.REDIRECT : READ_REDIRECT) ||
      (c.javascript_origins && (!Array.isArray(c.javascript_origins) || c.javascript_origins.length)) || !secret(c.client_secret) || c.client_secret.length > 256) fail();
  return Object.freeze({ clientId: c.client_id, clientSecret: c.client_secret });
}
function validateRuntimeKeys(keys) {
  if (!keys || Object.keys(keys).sort().join(',') !== 'supabaseServiceRoleKey,xaiApiKey' || !secret(keys.supabaseServiceRoleKey) || !secret(keys.xaiApiKey)) fail();
  try {
    const parts = keys.supabaseServiceRoleKey.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) fail();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Binding only; real service credential must pass server RPC before Gmail.
    if (claims.role !== 'service_role' || claims.ref !== 'yjjxzxoghlpguquknyso' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 < Date.now() + 240000) fail();
  } catch (_) { fail(); }
  return Object.freeze(keys);
}
function loadRuntimeConfig() {
  if (arguments.length) fail();
  const settings = validateRuntimeEnvironment(process.env);
  if (!settings) return null; // No file read, OAuth, network, database or model.
  const manifest = validateManifest(process.env.SUPPORT_EMAIL_MOUNT_MANIFEST);
  const readGrant = validateGrant(readMountedJson(PATHS.readGrant));
  const readClient = validateMountedClient(readMountedJson(PATHS.readClient), 'read');
  const keys = validateRuntimeKeys(readMountedJson(PATHS.keys));
  const sendClient = settings.mode === 'qa-owner-auto' ? validateMountedClient(readMountedJson(PATHS.sendClient), 'send') : null;
  const sendGrant = settings.mode === 'qa-owner-auto' ? validateSendGrant(readMountedJson(PATHS.sendGrant)) : null;
  const binding = createHash('sha256').update(JSON.stringify({ settings, manifest, keys, readClient, readGrant, sendClient, sendGrant })).digest('hex');
  return Object.freeze({ ...settings, keys, readClient, readGrant, sendClient, sendGrant, binding });
}
module.exports = { NAME, PATHS, validateRuntimeEnvironment, validateManifest, validateMountedClient, validateRuntimeKeys, readMountedJson, loadRuntimeConfig };
