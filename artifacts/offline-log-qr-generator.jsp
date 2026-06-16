<%@page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>

<%@page import="com.google.zxing.BarcodeFormat"%>
<%@page import="com.google.zxing.EncodeHintType"%>
<%@page import="com.google.zxing.common.BitMatrix"%>
<%@page import="com.google.zxing.qrcode.QRCodeWriter"%>

<%@page import="javax.imageio.ImageIO"%>
<%@page import="java.awt.image.BufferedImage"%>
<%@page import="java.io.ByteArrayOutputStream"%>
<%@page import="java.io.IOException"%>
<%@page import="java.nio.charset.StandardCharsets"%>
<%@page import="java.util.ArrayList"%>
<%@page import="java.util.Base64"%>
<%@page import="java.util.HashMap"%>
<%@page import="java.util.List"%>
<%@page import="java.util.Map"%>
<%@page import="java.util.zip.GZIPOutputStream"%>

<%!
// BEGIN TESTABLE CORE
static final String RAW_PREFIX = "RAW:\n";
static final String GZIP_PREFIX = "GZ:\n";
static final String GZQR_PREFIX = "GZQR:v1:";
static final int RAW_SINGLE_LIMIT = 800;
static final int GZ_SINGLE_LIMIT = 1400;
static final int GZQR_CHUNK_SIZE = 1200;
static final int GZQR_PAYLOAD_LIMIT = 1500;
static final int QR_IMAGE_SIZE = 420;
static final int MAX_SOURCE_BYTES = 200000;
static final int MAX_QR_COUNT = 30;

static class QrPayload {
  public final String mode;
  public final String text;
  public final int index;
  public final int total;
  public final int byteLength;

  QrPayload(String mode, String text, int index, int total) {
    this.mode = mode;
    this.text = text;
    this.index = index;
    this.total = total;
    this.byteLength = utf8Length(text);
  }
}

public static String escapeHtml(String input) {
  if (input == null) return "";
  return input.replace("&", "&amp;")
      .replace("<", "&lt;")
      .replace(">", "&gt;")
      .replace("\"", "&quot;")
      .replace("'", "&#x27;");
}

public static List<QrPayload> buildPayloads(String log) throws IOException {
  return buildPayloads(log, createGroupId());
}

public static List<QrPayload> buildPayloads(String log, String groupId) throws IOException {
  List<QrPayload> payloads = new ArrayList<QrPayload>();
  if (log == null || log.trim().length() == 0) return payloads;

  byte[] rawBytes = log.getBytes(StandardCharsets.UTF_8);
  if (rawBytes.length > MAX_SOURCE_BYTES) {
    throw new IllegalArgumentException("Log is too large. Maximum source size is " + MAX_SOURCE_BYTES + " bytes.");
  }

  String rawPayload = RAW_PREFIX + log;
  if (canUseRawPayload(log) && rawBytes.length <= RAW_SINGLE_LIMIT && utf8Length(rawPayload) <= GZQR_PAYLOAD_LIMIT) {
    payloads.add(new QrPayload("RAW", rawPayload, 1, 1));
    return payloads;
  }

  String encoded = gzipBase64Url(rawBytes);
  String gzipPayload = GZIP_PREFIX + encoded;
  if (utf8Length(gzipPayload) <= GZ_SINGLE_LIMIT) {
    payloads.add(new QrPayload("GZ", gzipPayload, 1, 1));
    return payloads;
  }

  String safeGroupId = normalizeGroupId(groupId);
  int total = (encoded.length() + GZQR_CHUNK_SIZE - 1) / GZQR_CHUNK_SIZE;
  if (total > MAX_QR_COUNT) {
    throw new IllegalArgumentException("Compressed log is too large. Maximum QR count is " + MAX_QR_COUNT + ".");
  }

  for (int i = 0; i < total; i += 1) {
    int start = i * GZQR_CHUNK_SIZE;
    int end = Math.min(start + GZQR_CHUNK_SIZE, encoded.length());
    String chunk = encoded.substring(start, end);
    String payload = GZQR_PREFIX + safeGroupId + ":" + (i + 1) + ":" + total + ":" + chunk;
    payloads.add(new QrPayload("GZQR", payload, i + 1, total));
  }

  return payloads;
}

public static String gzipBase64Url(byte[] bytes) throws IOException {
  ByteArrayOutputStream baos = new ByteArrayOutputStream();
  GZIPOutputStream gzipOut = null;

  try {
    gzipOut = new GZIPOutputStream(baos);
    gzipOut.write(bytes);
    gzipOut.finish();
  } finally {
    if (gzipOut != null) gzipOut.close();
  }

  return Base64.getUrlEncoder().withoutPadding().encodeToString(baos.toByteArray());
}

public static boolean canUseRawPayload(String log) {
  if (log == null || log.length() == 0) return false;
  // RAW safety contract: the browser decoder trims the scanned QR string before parsing.
  // Boundary-trim-sensitive logs must use GZIP so the original text round-trips exactly.
  return !isDecoderTrimChar(log.charAt(0))
      && !isDecoderTrimChar(log.charAt(log.length() - 1));
}

public static boolean isDecoderTrimChar(char c) {
  if (c == 0xFEFF) return true;
  if (c == 0x2028 || c == 0x2029) return true;
  if (c >= 0x0009 && c <= 0x000D) return true;
  if (c == 0x0020 || c == 0x00A0) return true;
  return Character.getType(c) == Character.SPACE_SEPARATOR;
}

public static int utf8Length(String value) {
  if (value == null) return 0;
  return value.getBytes(StandardCharsets.UTF_8).length;
}

public static String createGroupId() {
  String millis = Long.toString(System.currentTimeMillis(), 36);
  String nanos = Long.toString(System.nanoTime() & 0xfffffL, 36);
  return normalizeGroupId(millis + nanos);
}

public static String normalizeGroupId(String groupId) {
  String value = groupId == null ? "" : groupId;
  StringBuilder safe = new StringBuilder();

  for (int i = 0; i < value.length() && safe.length() < 32; i += 1) {
    char c = value.charAt(i);
    boolean allowed = (c >= 'a' && c <= 'z')
        || (c >= 'A' && c <= 'Z')
        || (c >= '0' && c <= '9')
        || c == '_'
        || c == '-';
    if (allowed) safe.append(c);
  }

  if (safe.length() == 0) return "log" + Long.toString(System.currentTimeMillis(), 36);
  return safe.toString();
}
// END TESTABLE CORE

static class QrImage {
  public final QrPayload payload;
  public final String base64;

  QrImage(QrPayload payload, String base64) {
    this.payload = payload;
    this.base64 = base64;
  }
}

public static String createQrPngBase64(String text, int size) throws Exception {
  QRCodeWriter qrWriter = new QRCodeWriter();
  Map<EncodeHintType, Object> hints = new HashMap<EncodeHintType, Object>();
  hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
  hints.put(EncodeHintType.MARGIN, Integer.valueOf(2));

  BitMatrix bitMatrix = qrWriter.encode(text, BarcodeFormat.QR_CODE, size, size, hints);
  BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_BYTE_BINARY);

  for (int y = 0; y < size; y += 1) {
    for (int x = 0; x < size; x += 1) {
      image.setRGB(x, y, bitMatrix.get(x, y) ? 0x000000 : 0xFFFFFF);
    }
  }

  ByteArrayOutputStream baos = new ByteArrayOutputStream();
  if (!ImageIO.write(image, "png", baos)) {
    throw new IOException("PNG writer is not available.");
  }
  return Base64.getEncoder().encodeToString(baos.toByteArray());
}
%>

<%
String submittedLog = request.getParameter("errorLog");
boolean submitted = "POST".equalsIgnoreCase(request.getMethod());
String errorMessage = "";
List<QrPayload> qrPayloads = new ArrayList<QrPayload>();
List<QrImage> qrImages = new ArrayList<QrImage>();
int sourceBytes = utf8Length(submittedLog);

if (submitted) {
  if (submittedLog == null || submittedLog.trim().length() == 0) {
    errorMessage = "에러 로그를 입력하세요.";
  } else {
    try {
      qrPayloads = buildPayloads(submittedLog);
      for (int i = 0; i < qrPayloads.size(); i += 1) {
        QrPayload payload = qrPayloads.get(i);
        qrImages.add(new QrImage(payload, createQrPngBase64(payload.text, QR_IMAGE_SIZE)));
      }
    } catch (Exception e) {
      String detail = e.getMessage() == null ? e.getClass().getName() : e.getMessage();
      application.log("Offline log QR generation failed", e);
      errorMessage = "QR 생성 실패: " + detail;
      qrPayloads.clear();
      qrImages.clear();
    }
  }
}
%>

<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>에러 로그 QR 생성기</title>
<style>
body {
  font-family: Arial, "Malgun Gothic", sans-serif;
  margin: 0;
  padding: 24px;
  color: #1f2933;
  background: #f6f7f9;
}
.wrap {
  max-width: 980px;
  margin: 0 auto;
}
textarea {
  width: 100%;
  min-height: 220px;
  box-sizing: border-box;
  padding: 12px;
  font-family: Consolas, "Courier New", monospace;
  font-size: 14px;
  line-height: 1.45;
  border: 1px solid #b8c0cc;
  background: #fff;
}
button {
  margin-top: 12px;
  padding: 10px 20px;
  font-size: 16px;
  cursor: pointer;
}
.notice,
.error,
.result-area,
.qr-card {
  border: 1px solid #d5dbe3;
  background: #fff;
  padding: 16px;
  margin-top: 18px;
}
.error {
  border-color: #d9534f;
  color: #a12622;
  background: #fff4f4;
}
.summary {
  margin: 8px 0 0;
  line-height: 1.7;
}
.qr-list {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 16px;
}
.qr-card {
  width: 450px;
  max-width: 100%;
  box-sizing: border-box;
  margin-top: 0;
}
.qr-card img {
  width: 100%;
  max-width: 420px;
  height: auto;
  border: 1px solid #333;
  background: #fff;
}
.payload-text {
  min-height: 90px;
  margin-top: 8px;
  font-size: 12px;
}
</style>
</head>
<body>
<div class="wrap">
  <h2>에러 로그 QR 생성기</h2>
  <p class="notice">짧은 로그는 RAW 단일 QR, 긴 로그는 GZIP 단일 QR, 더 긴 로그는 GZQR 멀티 QR로 생성합니다.</p>
  <p class="notice">현재 QR 설정: 원문 최대 <%= MAX_SOURCE_BYTES %> bytes, GZ 단일 최대 <%= GZ_SINGLE_LIMIT %> bytes, GZQR 조각 최대 <%= GZQR_CHUNK_SIZE %> chars, QR 최대 <%= MAX_QR_COUNT %>개, 이미지 <%= QR_IMAGE_SIZE %>px.</p>

  <form method="post" action="">
    <textarea name="errorLog" placeholder="여기에 에러 로그를 붙여넣으세요"><%= escapeHtml(submittedLog) %></textarea>
    <br>
    <button type="submit">QR 코드로 변환하기</button>
  </form>

  <% if (errorMessage.length() > 0) { %>
    <div class="error"><%= escapeHtml(errorMessage) %></div>
  <% } %>

  <% if (!qrImages.isEmpty()) { %>
    <div class="result-area">
      <h3>생성 완료</h3>
      <p class="summary">
        원문 UTF-8 길이: <strong><%= sourceBytes %></strong> bytes<br>
        생성 방식: <strong><%= escapeHtml(qrPayloads.get(0).mode) %></strong><br>
        QR 개수: <strong><%= qrImages.size() %></strong>
      </p>

      <% if (qrImages.size() > 1) { %>
        <p class="notice">외부망 디코더에서 멀티 QR 스캔을 선택한 뒤 아래 QR을 아무 순서로 모두 스캔하세요.</p>
      <% } %>

      <div class="qr-list">
        <% for (int i = 0; i < qrImages.size(); i += 1) {
          QrImage qr = qrImages.get(i);
          QrPayload payload = qr.payload;
        %>
          <div class="qr-card">
            <h4>QR <%= payload.index %> / <%= payload.total %> - <%= escapeHtml(payload.mode) %></h4>
            <p class="summary">QR payload 길이: <strong><%= payload.byteLength %></strong> bytes</p>
            <img src="data:image/png;base64,<%= qr.base64 %>" alt="QR Code <%= payload.index %>">
            <details>
              <summary>QR payload 확인</summary>
              <textarea class="payload-text" readonly><%= escapeHtml(payload.text) %></textarea>
            </details>
          </div>
        <% } %>
      </div>
    </div>
  <% } %>
</div>
</body>
</html>
