import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, extname } from 'node:path';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('.');
const out = resolve('.test-output/export');
mkdirSync(out, { recursive: true });
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'text/plain');
    response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    acceptDownloads: true
  });
  // Only the external OS clipboard boundary is simulated. Decode, DOM, Blob,
  // object URLs and downloaded bytes all use the real browser implementation.
  await context.addInitScript(() => {
    window.__writes = [];
    window.__clipboardDenied = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => {
        if (window.__clipboardDenied) throw new DOMException('Denied', 'NotAllowedError');
        window.__writes.push(text);
      }
    } });
    window.__createdUrls = [];
    window.__revokedUrls = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.__createdUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = url => { window.__revokedUrls.push(url); revoke(url); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const transfers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' || !request.url().startsWith('http://127.0.0.1:')) transfers.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.clock.install();

  async function decode(text) {
    const encoded = gzipSync(Buffer.from(text, 'utf8')).toString('base64url');
    await page.fill('#input', 'GZ:' + encoded);
    await page.click('#decodeBtn');
    await page.waitForFunction(length => document.getElementById('output').value.length === length,
      text.replace(/\r\n?/g, '\n').length);
  }

  async function downloadBytes() {
    assert.equal(await page.locator('#downloadBtn').count(), 1, 'Output must offer TXT export');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
    assert.match(download.suggestedFilename(), /^decoded-log-[\dT-]+\.txt$/);
    assert.equal(await download.failure(), null);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  // Regression: 3,221,754 chars must never be sent to the OS clipboard.
  const reportedSize = 'x'.repeat(3221754);
  await decode(reportedSize);
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => window.__writes.length), 0, 'Large output must bypass OS clipboard');
  assert.match(await page.locator('#exportStatus').textContent(), /TXT/);
  assert.deepEqual(await downloadBytes(), Buffer.from(reportedSize));
  console.log('PASS: reported 3,221,754-char size bypasses clipboard and downloads intact.');

  // Regression: using textarea.value instead of the retained source loses CRLF.
  const exact = '\uFEFF  한글 로그 😀\r\n둘째 줄\r끝\t\n';
  await decode(exact);
  assert.deepEqual(await downloadBytes(), Buffer.from(exact, 'utf8'));
  await page.click('#copyBtn');
  await page.waitForFunction(() => window.__writes.length === 1);
  assert.equal(await page.evaluate(() => window.__writes[0]), exact);
  assert.match(await page.locator('#exportStatus').textContent(), /확인/);
  console.log('PASS: original UTF-8/BOM/CRLF/lone CR/emoji/whitespace preserved; small copy remains available.');

  await decode('x'.repeat(200000));
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => window.__writes.at(-1).length), 200000);
  const writesAtBoundary = await page.evaluate(() => window.__writes.length);
  await decode('x'.repeat(200001));
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => window.__writes.length), writesAtBoundary);
  assert.match(await page.locator('#exportStatus').textContent(), /TXT/);
  await decode(exact);
  await page.evaluate(() => {
    window.__originalWrite = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => new Promise(resolve => { window.__finishCopy = resolve; });
  });
  await page.click('#copyBtn');
  await page.click('#clearBtn');
  await page.evaluate(async () => { window.__finishCopy(); await Promise.resolve(); });
  assert.equal(await page.locator('#exportStatus').textContent(), '', 'Late copy response must not undo Clear status');
  await page.evaluate(() => { navigator.clipboard.writeText = window.__originalWrite; });
  await decode(exact);
  console.log('PASS: 200,000/200,001 copy policy boundary and late clipboard response after Clear.');

  await page.evaluate(() => { window.__clipboardDenied = true; });
  await page.click('#copyBtn');
  await page.waitForFunction(() => document.getElementById('exportStatus').classList.contains('error'));
  assert.match(await page.locator('#exportStatus').textContent(), /TXT/);
  assert.deepEqual(await downloadBytes(), Buffer.from(exact, 'utf8'));
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }); });
  await page.click('#copyBtn');
  assert.match(await page.locator('#exportStatus').textContent(), /TXT/);
  assert.deepEqual(await downloadBytes(), Buffer.from(exact, 'utf8'));
  console.log('PASS: clipboard denied/unavailable does not prevent local TXT export.');

  const maximum = '가'.repeat(1666666) + 'ab';
  await decode(maximum);
  const maximumBytes = await downloadBytes();
  assert.equal(maximumBytes.length, 5000000);
  assert.deepEqual(maximumBytes, Buffer.from(maximum, 'utf8'));
  await page.click('#copyBtn');
  assert.match(await page.locator('#exportStatus').textContent(), /TXT/);
  await page.locator('.panel').last().screenshot({ path: join(out, 'mobile-export.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile output controls must fit without horizontal scroll');
  console.log('PASS: exactly 5 MB UTF-8 downloaded byte-for-byte; mobile-sized layout fits.');

  const longEnough = 'GZ:' + gzipSync(Buffer.from(maximum + 'x', 'utf8')).toString('base64url');
  await page.fill('#input', longEnough);
  await page.click('#decodeBtn');
  await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
  assert.equal(await page.inputValue('#output'), '');
  assert.equal(await page.locator('#downloadBtn').isDisabled(), true, 'Failed decode must not export stale text');
  await decode('new small log');
  await page.click('#clearBtn');
  assert.equal(await page.locator('#downloadBtn').isDisabled(), true, 'Clear must disable export');
  assert.equal(await page.locator('#exportStatus').textContent(), '');
  await page.clock.fastForward(61000);
  const urls = await page.evaluate(() => ({ created: window.__createdUrls, revoked: window.__revokedUrls }));
  assert.deepEqual([...urls.revoked].sort(), [...urls.created].sort(), 'Download object URLs must be released');
  assert.deepEqual(transfers, [], 'Export must not upload data or make external requests');
  assert.deepEqual(errors, []);
  console.log('PASS: empty/stale output blocked, object URLs released, no uploads, no browser exceptions.');
  await context.close();
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
