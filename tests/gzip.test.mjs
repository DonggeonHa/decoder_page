import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { gunzipBase64Url } from '../gzip.js';

test('GZIP preserves a leading BOM and surrounding whitespace', async () => {
  globalThis.window = globalThis;
  const original = '\uFEFF  한글 로그\r\n끝\t\n';
  const encoded = gzipSync(Buffer.from(original, 'utf8')).toString('base64url');
  assert.equal(await gunzipBase64Url(encoded), original);
});

test('invalid UTF-8 is rejected instead of silently replacing source bytes', async () => {
  globalThis.window = globalThis;
  const encoded = gzipSync(Buffer.from([0xc3, 0x28])).toString('base64url');
  await assert.rejects(gunzipBase64Url(encoded));
});

test('decompression rejects output beyond the JSP source-size limit', async () => {
  globalThis.window = globalThis;
  const encoded = gzipSync(Buffer.alloc(1000001, 65)).toString('base64url');
  await assert.rejects(gunzipBase64Url(encoded), /1000000/);
});
