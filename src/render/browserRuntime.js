'use strict';

const chromiumModule = require('@sparticuz/chromium');
const chromium = chromiumModule.default || chromiumModule;
const puppeteer = require('puppeteer-core');

// Explicit server flags: no disabled web security, real profile, remote browser,
// or external PDF service. Puppeteer owns a fresh temporary profile and pipe.
const SERVER_ARGS = Object.freeze([
  '--disable-domain-reliability', '--disable-print-preview', '--no-default-browser-check',
  '--no-pings', '--font-render-hinting=none', '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', '--disable-webgl', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--metrics-recording-only',
]);
const LINUX_ARGS = Object.freeze(['--single-process', '--no-zygote', '--in-process-gpu']);

async function browserLaunchOptions(executablePath, extraArgs = []) {
  chromium.setGraphicsMode = false;
  const dev = process.env.APP_ENV === 'development';
  return {
    executablePath: executablePath || await chromium.executablePath(),
    args: [...SERVER_ARGS, ...(process.platform === 'linux' ? LINUX_ARGS : []),
      ...(dev ? ['--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] : []), ...extraArgs],
    headless: process.platform === 'linux' ? 'shell' : true,
    pipe: true,
    protocolTimeout: 90000,
  };
}

module.exports = { chromium, puppeteer, browserLaunchOptions };
