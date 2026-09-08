import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { addMultiChunk, assembleMultiGzip, createMultiCollector, parseQrPayload } from '../protocol.js';
import { gunzipBase64Url } from '../gzip.js';

const output = resolve('.test-output/java');
mkdirSync(output, { recursive: true });
const javaBin = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : name;
const deps = ['core-3.5.3.jar', 'javase-3.5.3.jar'].map(name => resolve('.test-deps', name));
const jsp = readFileSync('artifacts/offline-log-qr-generator.jsp', 'utf8');
const imports = [...jsp.matchAll(/<%@page import="([^"]+)"%>/g)].map(m => `import ${m[1]};`).join('\n');
const declaration = jsp.match(/<%!([\s\S]*?)%>/)[1];
const baseline = execFileSync('git', ['show', 'c3d4113dd5ba7999adfd2b2fccb4336f7b4f79be:artifacts/offline-log-qr-generator.jsp'], { encoding: 'utf8' });
const legacyImage = baseline.match(/public static String createQrPngBase64[\s\S]*?(?=\n%>)/)[0].replace('createQrPngBase64', 'createBaselineQr');
const tests = readFileSync('tests/JspChecks.java.inc', 'utf8');
writeFileSync(join(output, 'JspChecks.java'), `${imports}\npublic class JspChecks {\n${declaration}\n${legacyImage}\n${tests}\n}`);
execFileSync(javaBin('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', deps.join(delimiter), join(output, 'JspChecks.java')], { stdio: 'pipe' });
console.log(execFileSync(javaBin('java'), ['-Djava.awt.headless=true', '-cp', [output, ...deps].join(delimiter), 'JspChecks', output], { encoding: 'utf8' }).trim());
globalThis.window = globalThis;
let count = 0;
for (const line of readFileSync(join(output, 'fixtures.txt'), 'utf8').trim().split('\n')) {
  const [expectedBase64, ...encodedPayloads] = line.split('|');
  const expected = Buffer.from(expectedBase64, 'base64').toString('utf8');
  const parsed = encodedPayloads.reverse().map(s => parseQrPayload(Buffer.from(s, 'base64').toString('utf8')));
  let actual;
  if (parsed[0].type === 'raw') actual = parsed[0].text;
  else if (parsed[0].type === 'gzip') actual = await gunzipBase64Url(parsed[0].encoded);
  else {
    const collector = createMultiCollector();
    for (const chunk of parsed) assert.equal(addMultiChunk(collector, chunk).ok, true);
    actual = await gunzipBase64Url(parseQrPayload(assembleMultiGzip(collector)).encoded);
  }
  assert.equal(actual, expected);
  count++;
}
console.log(`Java 8 generator -> JavaScript decoder: ${count} fixtures passed (including 300 reversed chunks).`);
