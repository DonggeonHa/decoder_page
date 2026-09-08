import test from 'node:test';
import assert from 'node:assert/strict';
import { createQrScanner } from '../scanner.js';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function environment(t, getUserMedia, detect = async () => [], play = async () => {}) {
  const names = ['window', 'navigator', 'BarcodeDetector', 'requestAnimationFrame'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({
    window: globalThis,
    navigator: { mediaDevices: { getUserMedia } },
    BarcodeDetector: class { async detect() { return detect(); } },
    requestAnimationFrame: () => {}
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    for (const name of names) {
      if (previous.get(name)) Object.defineProperty(globalThis, name, previous.get(name));
      else delete globalThis[name];
    }
  });
  const scanned = [];
  const video = { srcObject: null, play };
  const scanner = createQrScanner({ video, onScan: value => scanned.push(value), onStatus: () => {} });
  t.after(() => scanner.stop());
  return { scanner, scanned, video };
}

test('canceling while permission is pending releases a late camera stream', async t => {
  const permission = deferred();
  const entered = deferred();
  let stopped = false;
  const camera = { getTracks: () => [{ stop: () => { stopped = true; } }] };
  const { scanner, video } = environment(t, () => { entered.resolve(); return permission.promise; });
  const opening = scanner.start();
  await entered.promise;
  scanner.stop();
  permission.resolve(camera);
  await opening;
  assert.equal(scanner.isRunning(), false);
  assert.equal(video.srcObject, null);
  assert.equal(stopped, true);
});

test('a detection completed after stop cannot add a QR chunk', async t => {
  const detection = deferred();
  const camera = { getTracks: () => [{ stop() {} }] };
  const { scanner, scanned } = environment(t, async () => camera, () => detection.promise);
  await scanner.start();
  scanner.stop();
  detection.resolve([{ rawValue: 'GZQR:v1:late:1:2:AAA' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scanned, []);
});

test('video play failure closes the acquired camera', async t => {
  let stopped = false;
  const camera = { getTracks: () => [{ stop: () => { stopped = true; } }] };
  const { scanner, video } = environment(t, async () => camera, undefined, async () => { throw new Error('play failed'); });
  await assert.rejects(scanner.start(), /play failed/);
  assert.equal(stopped, true);
  assert.equal(video.srcObject, null);
  assert.equal(scanner.isRunning(), false);
});
