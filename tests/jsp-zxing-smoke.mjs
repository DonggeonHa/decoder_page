import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

const jspPath = resolve("artifacts/offline-log-qr-generator.jsp");
const jsp = readFileSync(jspPath, "utf8");
const declaration = jsp.match(/<%!([\s\S]*?)%>/)?.[1];
const mvnCommand = process.env.MAVEN_CMD || (process.platform === "win32" ? "mvn.cmd" : "mvn");

assert.ok(declaration, "expected JSP declaration block");

const tempDir = mkdtempSync(join(tmpdir(), "jsp-zxing-smoke-"));

try {
  const pomPath = join(tempDir, "pom.xml");
  const cpPath = join(tempDir, "cp.txt");
  const javaPath = join(tempDir, "JspZxingSmoke.java");

  writeFileSync(pomPath, buildPom());
  runMaven(["-q", "dependency:build-classpath", "-Dmdep.outputFile=cp.txt"], tempDir);

  const classpath = readFileSync(cpPath, "utf8").trim();
  assert.ok(classpath, "expected Maven to produce a ZXing classpath");

  writeFileSync(javaPath, buildHarness(declaration));
  execFileSync("javac", ["--release", "8", "-cp", classpath, javaPath], {
    cwd: tempDir,
    stdio: "pipe"
  });
  execFileSync("java", ["-cp", `${tempDir}${delimiter}${classpath}`, "JspZxingSmoke"], {
    cwd: tempDir,
    stdio: "pipe"
  });

  console.log("JSP ZXing smoke passed");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function runMaven(args, cwd) {
  if (process.platform === "win32" && mvnCommand.toLowerCase().endsWith(".cmd")) {
    const command = ["&", quoteForPowerShell(mvnCommand), ...args.map(quoteForPowerShell)].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      stdio: "pipe"
    });
    return;
  }

  execFileSync(mvnCommand, args, {
    cwd,
    stdio: "pipe"
  });
}

function quoteForPowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>local.smoke</groupId>
  <artifactId>jsp-zxing-smoke</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.google.zxing</groupId>
      <artifactId>core</artifactId>
      <version>3.5.3</version>
    </dependency>
    <dependency>
      <groupId>com.google.zxing</groupId>
      <artifactId>javase</artifactId>
      <version>3.5.3</version>
    </dependency>
  </dependencies>
</project>
`;
}

function buildHarness(declaration) {
  return `
import com.google.zxing.BinaryBitmap;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.Result;
import com.google.zxing.client.j2se.BufferedImageLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import javax.imageio.ImageIO;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

public class JspZxingSmoke {
${declaration}

  public static void main(String[] args) throws Exception {
    verifyRenderedQrPayloadsRoundTrip("short raw log");
    verifyRenderedQrPayloadsRoundTrip(repeatLine("STACKTRACE repeated line\\\\n", 200));
    verifyRenderedQrPayloadsRoundTrip(makeNoisyLog(9000));
  }

  private static void verifyRenderedQrPayloadsRoundTrip(String log) throws Exception {
    List<QrPayload> payloads = buildPayloads(log, "smokeid");
    if (payloads.isEmpty()) throw new AssertionError("expected at least one payload");

    StringBuilder multiEncoded = new StringBuilder();
    for (int i = 0; i < payloads.size(); i += 1) {
      QrPayload payload = payloads.get(i);
      String base64Png = createQrPngBase64(payload.text, QR_IMAGE_SIZE);
      String decodedQrText = decodeQrPng(base64Png);
      assertEquals(payload.text, decodedQrText, "rendered QR should decode to original payload text");

      if ("RAW".equals(payload.mode)) {
        assertEquals(log, payload.text.substring(RAW_PREFIX.length()), "RAW payload should contain exact log");
      } else if ("GZ".equals(payload.mode)) {
        assertEquals(log, gunzipBase64Url(payload.text.substring(GZIP_PREFIX.length())), "GZ payload should round trip");
      } else if ("GZQR".equals(payload.mode)) {
        String[] parts = payload.text.split(":", 6);
        multiEncoded.append(parts[5]);
      }
    }

    if (payloads.size() > 1) {
      assertEquals(log, gunzipBase64Url(multiEncoded.toString()), "GZQR payloads should assemble and round trip");
    }
  }

  private static String decodeQrPng(String base64Png) throws Exception {
    byte[] png = Base64.getDecoder().decode(base64Png);
    BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
    if (image == null) throw new AssertionError("PNG did not decode as an image");
    BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(new BufferedImageLuminanceSource(image)));
    Result result = new MultiFormatReader().decode(bitmap);
    return result.getText();
  }

  private static String gunzipBase64Url(String encoded) throws Exception {
    String compact = encoded.replaceAll("\\\\s+", "");
    int padding = (4 - (compact.length() % 4)) % 4;
    StringBuilder paddedBuilder = new StringBuilder(compact);
    for (int i = 0; i < padding; i += 1) paddedBuilder.append("=");
    byte[] compressed = Base64.getUrlDecoder().decode(paddedBuilder.toString());

    try (GZIPInputStream gzipIn = new GZIPInputStream(new ByteArrayInputStream(compressed));
         ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[1024];
      int read;
      while ((read = gzipIn.read(buffer)) != -1) out.write(buffer, 0, read);
      return out.toString(StandardCharsets.UTF_8.name());
    }
  }

  private static String repeatLine(String value, int count) {
    StringBuilder repeated = new StringBuilder();
    for (int i = 0; i < count; i += 1) repeated.append(value);
    return repeated.toString();
  }

  private static String makeNoisyLog(int length) {
    StringBuilder log = new StringBuilder();
    long seed = 0x5DEECE66DL;
    for (int i = 0; i < length; i += 1) {
      seed = (seed * 25214903917L + 11L) & ((1L << 48) - 1);
      int ch = 33 + (int) ((seed >>> 16) % 90);
      log.append((char) ch);
      if (i % 97 == 0) log.append('\\n');
    }
    return log.toString();
  }

  private static void assertEquals(Object expected, Object actual, String message) {
    if (expected == null ? actual != null : !expected.equals(actual)) {
      throw new AssertionError(message + " expected=[" + expected + "] actual=[" + actual + "]");
    }
  }
}
`;
}
