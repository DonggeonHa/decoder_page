import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';

const out = resolve('.test-output/benchmark');
mkdirSync(out, { recursive: true });
const old = execFileSync('git', ['show', 'c3d4113dd5ba7999adfd2b2fccb4336f7b4f79be:artifacts/offline-log-qr-generator.jsp'], { encoding: 'utf8' });
const current = readFileSync('artifacts/offline-log-qr-generator.jsp', 'utf8');
const sources = [['OldGenerator', old], ['NewGenerator', current]];
const files = [];
for (const [name, jsp] of sources) {
  const imports = [...jsp.matchAll(/<%@page import="([^"]+)"%>/g)].map(m => 'import ' + m[1] + ';').join('\n');
  const declaration = jsp.match(/<%!([\s\S]*?)%>/)[1];
  const file = join(out, name + '.java');
  writeFileSync(file, `${imports}\npublic class ${name} {\n${declaration}\n}`);
  files.push(file);
}
const bench = join(out, 'QrBenchmark.java');
writeFileSync(bench, `
public class QrBenchmark {
  static long sink;
  static String[] payloads = new String[20];
  static double run(boolean old) throws Exception {
    long start = System.nanoTime();
    for (String payload : payloads) {
      String png = old ? OldGenerator.createQrPngBase64(payload, 420) : NewGenerator.createQrPngBase64(payload, 420);
      sink += png.length();
    }
    return (System.nanoTime() - start) / 1000000.0 / payloads.length;
  }
  public static void main(String[] args) throws Exception {
    java.util.Random random = new java.util.Random(77);
    String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (int i = 0; i < payloads.length; i++) {
      StringBuilder b = new StringBuilder("GZQR:v1:benchmark:" + (i + 1) + ":200:");
      for (int j = 0; j < 1200; j++) b.append(alphabet.charAt(random.nextInt(64)));
      payloads[i] = b.toString();
    }
    for (int i = 0; i < 3; i++) { run(true); run(false); }
    double[] baseline = new double[7], optimized = new double[7];
    for (int i = 0; i < 7; i++) {
      if (i % 2 == 0) { baseline[i] = run(true); optimized[i] = run(false); }
      else { optimized[i] = run(false); baseline[i] = run(true); }
    }
    java.util.Arrays.sort(baseline); java.util.Arrays.sort(optimized);
    System.out.println("{\\"baselineMedianMsPerQr\\":" + baseline[3]
      + ",\\"optimizedMedianMsPerQr\\":" + optimized[3]
      + ",\\"speedup\\":" + baseline[3]/optimized[3]
      + ",\\"measuredImagesPerVersion\\":140,\\"sink\\":" + sink + "}");
  }
}
`);
const javaBin = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : name;
const core = resolve('.test-deps/core-3.5.3.jar');
execFileSync(javaBin('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', core, ...files, bench], { stdio: 'pipe' });
const result = execFileSync(javaBin('java'), ['-Djava.awt.headless=true', '-cp', [out, core].join(delimiter), 'QrBenchmark'], { encoding: 'utf8' }).trim();
writeFileSync(join(out, 'results.json'), result + '\n');
console.log(result);
