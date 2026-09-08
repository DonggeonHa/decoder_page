import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve('.test-deps');
await mkdir(root, { recursive: true });
const artifacts = [
  ['com/google/zxing', 'core', '3.5.3'],
  ['com/google/zxing', 'javase', '3.5.3'],
  ['org/apache/tomcat/embed', 'tomcat-embed-core', '9.0.115'],
  ['org/apache/tomcat/embed', 'tomcat-embed-jasper', '9.0.115'],
  ['org/apache/tomcat/embed', 'tomcat-embed-el', '9.0.115'],
  ['org/apache/tomcat', 'tomcat-annotations-api', '9.0.115'],
  ['org/eclipse/jdt', 'ecj', '3.26.0']
];
for (const [group, artifact, version] of artifacts) {
  const name = `${artifact}-${version}.jar`;
  const url = `https://repo.maven.apache.org/maven2/${group}/${artifact}/${version}/${name}`;
  const destination = resolve(root, name);
  let bytes;
  try { bytes = await readFile(destination); } catch { /* not downloaded yet */ }
  const checksumResponse = await fetch(url + '.sha1');
  if (!checksumResponse.ok) throw new Error(`Checksum HTTP ${checksumResponse.status}: ${name}`);
  const expected = (await checksumResponse.text()).trim().split(/\s/)[0];
  if (!bytes) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${name}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha1').update(bytes).digest('hex') !== expected) throw new Error('Checksum mismatch: ' + name);
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  if (createHash('sha1').update(bytes).digest('hex') !== expected) throw new Error('Existing checksum mismatch: ' + name);
  console.log(name + ' SHA256=' + createHash('sha256').update(bytes).digest('hex'));
}
