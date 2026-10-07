'use strict';
const crypto = require('node:crypto');
const { Resolver } = require('node:dns/promises');
const { getPublicKey } = require('mailauth/lib/tools');
const pins = Object.freeze(require('./provider-pins.json'));
const fail = () => { throw new Error('SUPPORT_EMAIL_KEY_REJECTED'); };

function keyName(name) {
  return name === 'google._domainkey.alphasourceai.com' || /^[a-z0-9-]{1,40}\._domainkey\.google\.com$/.test(name);
}

function within(promise, milliseconds, cancel = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { cancel(); reject(new Error('SUPPORT_EMAIL_DEADLINE')); }, Math.max(1, milliseconds));
  })]).finally(() => clearTimeout(timer));
}

// Core is used by independent cryptographic fixtures; production cannot inject it.
function boundedResolver({ query, expectedPins, deadline }) {
  let lookups = 0, exhausted = false;
  const cache = new Map(); // One attempt only; no cross-message key cache.
  async function lookup(kind, name) {
    if (++lookups > 12 || Date.now() >= deadline) { exhausted = true; fail(); }
    return within(query(kind, name), Math.min(5000, deadline - Date.now()));
  }
  async function resolver(name, type) {
    if (type !== 'TXT' || !keyName(name) || !Object.hasOwn(expectedPins, name)) fail();
    if (cache.has(name)) return cache.get(name);
    let aliases;
    try { aliases = await lookup('CNAME', name); } catch (error) {
      if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) fail();
      aliases = [];
    }
    if (!Array.isArray(aliases) || aliases.length) fail();
    const rows = await lookup('TXT', name);
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || !rows[0].length || rows[0].some(v => typeof v !== 'string') || Buffer.byteLength(rows[0].join('')) > 8192) fail();
    const key = await getPublicKey('DKIM', name, 2048, async () => rows, { strict: true, hashAlgo: 'sha256' });
    if (key.testing || key.keyType !== 'rsa') fail();
    const object = crypto.createPublicKey(key.publicKey);
    const details = object.asymmetricKeyDetails;
    if (object.asymmetricKeyType !== 'rsa' || !details || details.modulusLength < 2048 || details.modulusLength > 4096 || details.publicExponent !== 65537n) fail();
    const hash = crypto.createHash('sha256').update(object.export({ type: 'spki', format: 'der' })).digest('hex');
    if (hash !== expectedPins[name]) fail();
    const frozen = Object.freeze([Object.freeze([...rows[0]])]);
    cache.set(name, frozen);
    return frozen;
  }
  return { resolver, assertBudget() { if (exhausted || Date.now() >= deadline) fail(); }, close() { cache.clear(); } };
}

function productionResolver(deadline) {
  const dns = new Resolver({ timeout: 5000, tries: 1 });
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  const core = boundedResolver({ deadline, expectedPins: pins, query: (kind, name) => kind === 'TXT' ? dns.resolveTxt(name) : dns.resolveCname(name) });
  return { ...core, close() { core.close(); dns.cancel(); } };
}
module.exports = { boundedResolver, productionResolver, within };
