'use strict';
// Authored data only. Build acceptance does not read any database or credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { PDFParse } = require('pdf-parse');
const { chromium } = require('../src/render/browserRuntime');
const { htmlToPdf } = require('../src/render/pdfRenderer');

async function main() {
  assert.equal(process.env.APP_ENV, 'development');
  // Only this isolated database/service pair may run the hosted build check.
  if (process.platform === 'linux') {
    assert.equal(process.env.SUPABASE_URL, 'https://hjombgfusdgsqipimhnc.supabase.co');
    assert.equal(process.env.RENDER_SERVICE_ID, 'srv-db5bfjlckfvc739klcvg');
  }
  const executable = process.platform === 'linux' ? await chromium.executablePath() : process.env.PUPPETEER_EXECUTABLE_PATH;
  assert.ok(executable);
  const version = await promisify(execFile)(executable, ['--version'], { timeout: 10000 });
  // Sparticuz ships its own Chromium build; major/protocol compatibility is
  // required, not an unsupported claim that it equals Google's patch build.
  assert.match(version.stdout, /(?:Chrome|Chromium|HeadlessChrome).*\b153\./);
  let connections = 0;
  const sink = http.createServer((req, res) => { connections++; res.end('blocked fixture'); });
  sink.on('upgrade', (_req, socket) => { connections++; socket.destroy(); });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${sink.address().port}`;
  try {
    const html = `<!doctype html><html><head><style>
      @page{size:A4 landscape;margin:14mm}body{font:15px Arial;color:#111a4c;background:#f8f9ff}
      h1{font-size:28px}.cards{display:flex;gap:18px}.card{background:white;padding:24px;border-radius:12px;flex:1}
      .score{color:#00a9d8;font-size:32px}p{line-height:1.6}.tag{color:#7259ca}
    </style></head><body><p class="tag">alphaScreen · SYNTHETIC DEV FIXTURE</p>
      <h1>Candidate Review Brief</h1><p>Authored Example · Fictional Account Executive</p>
      <div class="cards"><section class="card"><h2>Resume analysis</h2><p class="score">84%</p><p>Illustrative skills and experience summary.</p></section>
      <section class="card"><h2>Interview analysis</h2><p class="score">88%</p><p>Clear, specific examples in authored evidence.</p></section>
      <section class="card"><h2>Advanced evidence</h2><p>Response specificity: 86%</p><p>Signal confidence: Illustrative</p></section></div>
      <p>No real candidate, recording, or external asset is used.</p>
      <img src="${url}/image"><img src="file:///private/tmp/forbidden-dev-fixture">
      <script>fetch('${url}/fetch');new WebSocket('${url.replace('http:','ws:')}/ws')</script>
      </body></html>`;
    const pdf = Buffer.from(await htmlToPdf(html, { landscape: true }));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const parser = new PDFParse({ data: pdf });
    try { assert.match((await parser.getText()).text, /Candidate Review Brief/); }
    finally { await parser.destroy(); }
    assert.equal(connections, 0);
    if (process.env.DEV_PDF_SMOKE_OUTPUT && process.platform === 'darwin') {
      assert.equal(process.env.DEV_PDF_SMOKE_OUTPUT, '/private/tmp/alphascreen-dev-pdf-20261010.pdf');
      fs.writeFileSync(process.env.DEV_PDF_SMOKE_OUTPUT, pdf);
    }
    console.log(JSON.stringify({ devPdfSmoke: 'PASS', version: version.stdout.trim(), bytes: pdf.length,
      expectedText: true, externalConnections: connections, authoredFixtureOnly: true }));
  } finally { await new Promise(resolve => sink.close(resolve)); }
}
main().catch(error => { console.error('dev_pdf_smoke_failed:', error.message); process.exitCode = 1; });
