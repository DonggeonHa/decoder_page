import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join, delimiter, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('.');
const out = resolve('.test-output/browser');
mkdirSync(out, { recursive: true });
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'text/plain');
    response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser, java;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript(() => {
    window.__queue = [];
    window.__copied = '';
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['qr_code']; }
      async detect() { return window.__queue.length ? [{ rawValue: window.__queue.shift() }] : []; }
    };
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const stream = canvas.captureStream(10);
      canvas.getContext('2d').fillRect(0, 0, 640, 480);
      return stream;
    } });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__copied = value; } } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const original = '\uFEFF  한글 로그\r\n끝\t\n';
  const encoded = gzipSync(Buffer.from(original, 'utf8')).toString('base64url');
  const split = Math.floor(encoded.length / 2);
  const first = `GZQR:v1:resume:1:2:${encoded.slice(0, split)}`;
  const second = `GZQR:v1:resume:2:2:${encoded.slice(split)}`;
  await page.click('#scanMultiBtn');
  await page.evaluate(value => window.__queue.push(value), first);
  await page.waitForFunction(() => document.getElementById('multiStatus').textContent.includes('수집: 1 / 2'));
  await page.click('#copyMissingBtn');
  assert.equal(await page.evaluate(() => window.__copied), '2');
  await page.click('#stopScanBtn');
  await page.click('#scanMultiBtn');
  await page.evaluate(value => window.__queue.push(value), second);
  await page.waitForFunction(() => document.getElementById('output').value.length > 0, null, { timeout: 2500 });
  assert.equal(await page.inputValue('#output'), original.replace(/\r\n/g, '\n'));
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => window.__copied), original, 'Copy must preserve CRLF and BOM beyond textarea normalization');
  await page.click('#clearBtn');
  await page.fill('#input', first);
  await page.click('#decodeBtn');
  await page.fill('#input', second);
  await page.click('#decodeBtn');
  await page.waitForFunction(() => document.getElementById('output').value.length > 0);
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => window.__copied), original, 'Pasted chunks must assemble through the real UI');
  await page.screenshot({ path: join(out, 'decoder-complete.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser decoder: pause/resume, missing-number copy, pasted chunks, exact BOM/CRLF clipboard output passed. Camera hardware was simulated.');
  if (process.argv.includes('--decoder-only')) process.exitCode = 0;
  else {
    const webroot = join(out, 'webroot');
    mkdirSync(webroot, { recursive: true });
    copyFileSync('artifacts/offline-log-qr-generator.jsp', join(webroot, 'qr.jsp'));
    const jars = readdirSync('.test-deps').filter(n => n.endsWith('.jar')).map(n => resolve('.test-deps', n));
    const javaBin = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : name;
    execFileSync(javaBin('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', jars.join(delimiter), '-d', out, 'tests/LocalJspServer.java'], { stdio: 'pipe' });
    java = spawn(javaBin('java'), ['-Djava.awt.headless=true', '-cp', [out, ...jars].join(delimiter), 'LocalJspServer', webroot, join(out, 'tomcat')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let javaLog = '';
    java.stderr.on('data', data => { javaLog += data; });
    const port = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('JSP server startup timeout: ' + javaLog)), 15000);
      java.on('exit', code => { clearTimeout(timer); reject(new Error('JSP server exit ' + code + ': ' + javaLog)); });
      java.stdout.on('data', data => {
        const match = String(data).match(/PORT=(\d+)/);
        if (match) { clearTimeout(timer); accept(Number(match[1])); }
      });
    });
    const jspPage = await context.newPage();
    jspPage.on('pageerror', error => errors.push(error.message));
    await jspPage.goto(`http://127.0.0.1:${port}/qr.jsp`);
    let seed = 8123;
    const log = '한글 POST 확인\n' + Array.from({ length: 60000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String.fromCharCode(33 + ((seed >>> 8) % 94)); }).join('');
    await jspPage.fill('[name=errorLog]', log);
    await Promise.all([jspPage.waitForNavigation(), jspPage.click('button[type=submit]')]);
    await jspPage.waitForFunction(() => window.qrFrames && window.qrFrames.length > 50);
    const count = await jspPage.evaluate(() => qrFrames.length);
    assert.ok(count <= 200);
    assert.ok((await jspPage.inputValue('[name=errorLog]')).startsWith('한글 POST 확인\n'));
    assert.equal(await jspPage.locator('#qrPlayerImage').evaluate(img => img.getBoundingClientRect().width), 420);
    await jspPage.fill('#qrJumpIndex', '50');
    await jspPage.click('button:has-text("이동")');
    await jspPage.waitForFunction(() => currentIndex === 49);
    await jspPage.selectOption('#qrSpeed', '700');
    await jspPage.click('button:has-text("재생")');
    await jspPage.waitForFunction(() => currentIndex !== 49);
    await jspPage.click('button:has-text("일시정지")');
    const stoppedIndex = await jspPage.evaluate(() => currentIndex);
    await jspPage.waitForTimeout(900);
    assert.equal(await jspPage.evaluate(() => currentIndex), stoppedIndex);
    assert.ok(await jspPage.evaluate(() => Object.keys(frameCache).length <= 3));
    await jspPage.screenshot({ path: join(out, 'jsp-player.png'), fullPage: true });
    writeFileSync(join(out, 'tomcat.log'), javaLog);
    assert.deepEqual(errors, []);
    console.log(`Java 8/Tomcat JSP POST: ${count} QR frames, UTF-8, 420px display, jump/speed/pause, three-frame preload passed.`);
  }
} finally {
  if (java && java.exitCode === null) {
    java.stdin.end('stop');
    await Promise.race([once(java, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (java.exitCode === null) java.kill();
  }
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
