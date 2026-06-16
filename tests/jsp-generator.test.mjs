import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const jspPath = resolve("artifacts/offline-log-qr-generator.jsp");

test("offline JSP generator core builds RAW, GZ, and GZQR payloads", () => {
  assert.equal(existsSync(jspPath), true, "expected JSP artifact to exist");

  const jsp = readFileSync(jspPath, "utf8");
  assert.match(jsp, /BEGIN TESTABLE CORE/);
  assert.match(jsp, /END TESTABLE CORE/);
  assert.match(jsp, /List<QrPayload>/, "JSP should render one or more QR payloads");
  assert.match(jsp, /errorMessage/, "JSP should expose explicit errors instead of silent failures");
  assert.doesNotMatch(jsp, /Compression Error Occurred/, "JSP should not encode fake compression errors as RAW logs");

  const core = jsp.match(/\/\/ BEGIN TESTABLE CORE([\s\S]*?)\/\/ END TESTABLE CORE/)[1];
  const tempDir = mkdtempSync(join(tmpdir(), "jsp-core-"));
  const javaPath = join(tempDir, "JspCoreHarness.java");

  writeFileSync(javaPath, buildHarness(core));

  try {
    execFileSync("javac", ["--release", "8", javaPath], { cwd: tempDir, stdio: "pipe" });
    execFileSync("java", ["-cp", tempDir, "JspCoreHarness"], { cwd: tempDir, stdio: "pipe" });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function buildHarness(core) {
  return `
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

public class JspCoreHarness {
${core}

  public static void main(String[] args) throws Exception {
    verifyEscapeHtml();
    verifyRawPayload();
    verifyBoundaryWhitespaceAvoidsRawPayload();
    verifySingleGzipPayload();
    verifyMultiGzipPayload();
    verifyOversizeInputRejected();
    verifyQrCountLimitRejected();
  }

  private static void verifyEscapeHtml() {
    assertEquals("&lt;&gt;&amp;&quot;&#x27;", escapeHtml("<>&\\\"'"), "HTML escaping should cover JSP output");
  }

  private static void verifyRawPayload() throws Exception {
    String log = "short 로그 <>&";
    List<QrPayload> payloads = buildPayloads(log, "rawid");
    assertEquals(1, payloads.size(), "short log should produce one RAW QR");
    QrPayload payload = payloads.get(0);
    assertEquals("RAW", payload.mode, "short log mode");
    assertEquals("RAW:\\n" + log, payload.text, "short log payload");
    assertTrue(payload.byteLength <= RAW_SINGLE_LIMIT + RAW_PREFIX.getBytes(StandardCharsets.UTF_8).length, "RAW payload should stay small");
  }

  private static void verifyBoundaryWhitespaceAvoidsRawPayload() throws Exception {
    assertOneGzipPayloadRoundTrips("  indented first line\\nsecond line", "leading spaces");
    assertOneGzipPayloadRoundTrips("short log ", "trailing space");
    assertOneGzipPayloadRoundTrips("short log\\t", "trailing tab");
    assertOneGzipPayloadRoundTrips("short log\\n", "trailing newline");
    assertOneGzipPayloadRoundTrips("\\u00A0nonbreaking space", "leading nonbreaking space");
    assertOneGzipPayloadRoundTrips("byte order mark\\uFEFF", "trailing byte order mark");
    assertOneGzipPayloadRoundTrips("\\u2003em space", "leading em space");
    assertOneGzipPayloadRoundTrips("\\u2028line separator", "leading line separator");
    assertOneGzipPayloadRoundTrips("paragraph separator\\u2029", "trailing paragraph separator");
  }

  private static void verifySingleGzipPayload() throws Exception {
    String log = repeatLine("STACKTRACE line with repeated text\\n", 180);
    List<QrPayload> payloads = buildPayloads(log, "gzipid");
    assertEquals(1, payloads.size(), "compressible long log should produce one GZ QR");
    QrPayload payload = payloads.get(0);
    assertEquals("GZ", payload.mode, "gzip mode");
    assertTrue(payload.text.startsWith("GZ:\\n"), "gzip payload prefix");
    assertTrue(payload.byteLength <= GZ_SINGLE_LIMIT, "single gzip QR should respect byte limit");
    assertEquals(log, gunzipBase64Url(payload.text.substring("GZ:\\n".length())), "single gzip round trip");
  }

  private static void assertOneGzipPayloadRoundTrips(String log, String label) throws Exception {
    List<QrPayload> payloads = buildPayloads(log, "spaceid");
    assertEquals(1, payloads.size(), label + " should still fit one QR");
    QrPayload payload = payloads.get(0);
    assertEquals("GZ", payload.mode, label + " must avoid RAW because decoder trims scanned values");
    assertEquals(log, gunzipBase64Url(payload.text.substring("GZ:\\n".length())), label + " gzip round trip");
  }

  private static void verifyMultiGzipPayload() throws Exception {
    String log = makeNoisyLog();
    List<QrPayload> payloads = buildPayloads(log, "groupA");
    assertTrue(payloads.size() > 1, "less-compressible large log should produce multiple GZQR payloads");

    StringBuilder encoded = new StringBuilder();
    int total = payloads.size();
    for (int i = 0; i < payloads.size(); i += 1) {
      QrPayload payload = payloads.get(i);
      String[] parts = payload.text.split(":", 6);
      assertEquals("GZQR", parts[0], "multi prefix");
      assertEquals("v1", parts[1], "multi version");
      assertEquals("groupA", parts[2], "multi group id");
      assertEquals(String.valueOf(i + 1), parts[3], "1-based index");
      assertEquals(String.valueOf(total), parts[4], "total count");
      assertTrue(parts[5].length() <= GZQR_CHUNK_SIZE, "chunk should fit configured size");
      assertTrue(payload.byteLength <= GZQR_PAYLOAD_LIMIT, "full GZQR payload should fit configured byte limit");
      encoded.append(parts[5]);
    }

    assertEquals(log, gunzipBase64Url(encoded.toString()), "multi gzip round trip");
  }

  private static void verifyOversizeInputRejected() throws Exception {
    String log = repeatLine("x", MAX_SOURCE_BYTES + 1);
    try {
      buildPayloads(log, "oversize");
      throw new AssertionError("oversize log should be rejected before QR image generation");
    } catch (IllegalArgumentException expected) {
      assertTrue(expected.getMessage().contains("too large"), "oversize error should explain the source-size limit");
    }
  }

  private static void verifyQrCountLimitRejected() throws Exception {
    String log = makeNoisyLog(50000);
    try {
      buildPayloads(log, "manyparts");
      throw new AssertionError("large compressed log should be rejected before rendering too many QR images");
    } catch (IllegalArgumentException expected) {
      assertTrue(expected.getMessage().contains("Maximum QR count"), "QR count error should explain the chunk-count limit");
    }
  }

  private static String makeNoisyLog() {
    return makeNoisyLog(9000);
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

  private static String repeatLine(String value, int count) {
    StringBuilder repeated = new StringBuilder();
    for (int i = 0; i < count; i += 1) {
      repeated.append(value);
    }
    return repeated.toString();
  }

  private static String gunzipBase64Url(String encoded) throws Exception {
    String compact = encoded.replaceAll("\\\\s+", "");
    int padding = (4 - (compact.length() % 4)) % 4;
    StringBuilder paddedBuilder = new StringBuilder(compact);
    for (int i = 0; i < padding; i += 1) {
      paddedBuilder.append("=");
    }
    String padded = paddedBuilder.toString();
    byte[] compressed = Base64.getUrlDecoder().decode(padded);

    try (GZIPInputStream gzipIn = new GZIPInputStream(new ByteArrayInputStream(compressed));
         ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[1024];
      int read;
      while ((read = gzipIn.read(buffer)) != -1) {
        out.write(buffer, 0, read);
      }
      return out.toString(StandardCharsets.UTF_8.name());
    }
  }

  private static void assertTrue(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static void assertEquals(Object expected, Object actual, String message) {
    if (expected == null ? actual != null : !expected.equals(actual)) {
      throw new AssertionError(message + " expected=[" + expected + "] actual=[" + actual + "]");
    }
  }
}
`;
}
