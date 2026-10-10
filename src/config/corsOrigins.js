'use strict';

const DEV_FRONTEND_ORIGIN = 'https://interview-agent-frontend-qa.onrender.com';

function strictHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

function resolveCorsOrigins({ env = process.env, frontendUrl, defaultOrigins = [] }) {
  const configured = String(env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (env.APP_ENV === 'development') {
    // No inherited QA/production/Wix/local origins on this isolated dev service.
    const values = [frontendUrl, ...configured];
    if (configured.length !== 1 || values.some(value => value !== DEV_FRONTEND_ORIGIN || strictHttpsOrigin(value) !== DEV_FRONTEND_ORIGIN)) return [];
    return [DEV_FRONTEND_ORIGIN];
  }
  return Array.from(new Set([...defaultOrigins, String(frontendUrl || '').replace(/\/+$/, ''), ...configured].filter(Boolean)));
}

module.exports = { DEV_FRONTEND_ORIGIN, strictHttpsOrigin, resolveCorsOrigins };
