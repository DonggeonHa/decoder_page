import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { gunzipBase64Url } from '../gzip.js';
import { addMultiChunk, assembleMultiGzip, createMultiCollector, getMissingIndexes, parseQrPayload } from '../protocol.js';

test('GZIP preserves a leading BOM and surrounding whitespace', async () => {
  globalThis.window = globalThis;
  globalThis.window = globalThis;
  const original = '\uFEFF  한글 로그\r\n끝\t\n';
  const encoded = gzipSync(Buffer.from(original, 'utf8')).toString('base64url');
  assert.equal(await gunzipBase64Url(encoded), original);
});

test('invalid UTF-8 is rejected instead of silently replacing source bytes', async () => {
  globalThis.window = globalThis;
  globalThis.window = globalThis;
  const encoded = gzipSync(Buffer.from([0xc3, 0x28])).toString('base64url');
  await assert.rejects(gunzipBase64Url(encoded));
});

test('decompression rejects output beyond the JSP source-size limit', async () => {
  globalThis.window = globalThis;
  globalThis.window = globalThis;
  const encoded = gzipSync(Buffer.alloc(5000001, 65)).toString('base64url');
  await assert.rejects(gunzipBase64Url(encoded), /Decoded source exceeds/);
});

test('all 263 reverse-order chunks reconstruct their original gzip log', async () => {
  globalThis.window = globalThis;
  const expected = '\uFEFF  한글 로그 <>&\r\n' + 'source-263-part-log\r\n'.repeat(15000);
  const encoded = gzipSync(Buffer.from(expected, 'utf8')).toString('base64url');
  assert.ok(encoded.length >= 263);
  const collector = createMultiCollector();
  for (let i = 263; i >= 1; i--) {
    const chunk = encoded.slice(Math.floor((i - 1) * encoded.length / 263), Math.floor(i * encoded.length / 263));
    const parsed = parseQrPayload('GZQR:v1:reported-log:' + i + ':263:' + chunk);
    const result = addMultiChunk(collector, parsed);
    assert.equal(result.ok, true, parsed.reason || result.reason);
    if (i === 2) assert.deepEqual(getMissingIndexes(collector), [1]);
  }
  const assembled = parseQrPayload(assembleMultiGzip(collector));
  assert.equal(await gunzipBase64Url(assembled.encoded), expected);
});
test('decoded data over the old 1 MB cap is preserved', async () => {
  globalThis.window = globalThis;
  const original = '가'.repeat(400000);
  const encoded = gzipSync(Buffer.from(original, 'utf8')).toString('base64url');
  assert.equal(await gunzipBase64Url(encoded), original);
});
test('exactly 5,000,000 UTF-8 bytes are accepted', async () => {
  globalThis.window = globalThis;
  const original = '가'.repeat(1666666) + 'ab';
  const encoded = gzipSync(Buffer.from(original, 'utf8')).toString('base64url');
  assert.equal(await gunzipBase64Url(encoded), original);
});
