# JSP 수동 반영 가이드 — Java 8 / 기존 ZXing / 최대 200장

기준은 대화에서 보내주신 **0.5초 재생 플레이어가 있는 JSP**입니다. GitHub의 예전 카드 나열형 JSP를 기준으로 찾을 필요는 없습니다.

완성본: [offline-log-qr-generator.jsp](../artifacts/offline-log-qr-generator.jsp)

아래 순서대로 기존 코드를 **교체**하세요. 같은 메서드나 script를 아래에 덧붙이면 중복 선언 또는 타이머 충돌이 생깁니다. 기존 파일은 별도 이름으로 보관한 뒤 시작하세요. 설명 문장은 입력하지 않고 코드 블록만 입력합니다. 들여쓰기는 달라도 되지만 따옴표, 역슬래시, 대소문자는 같아야 합니다.

외부 QR JAR과 import 추가는 없습니다. 새로 사용한 WritableRaster와 MemoryCacheImageOutputStream은 Java 8 기본 클래스이며 코드에서 전체 이름을 사용합니다. 전달용 JSP만 인트라넷에 반영하면 됩니다. 검증용 scripts/tests/.test-deps는 WAS에 복사하지 않습니다.

## 1. 상수 확인

기존 MAX_QR_COUNT의 50을 200으로 바꿉니다. MAX_SOURCE_BYTES는 보내주신 값인 1000000을 유지합니다. 나머지 값도 아래와 맞춥니다.

```java
static final String RAW_PREFIX = "RAW:\n";
static final String GZIP_PREFIX = "GZ:\n";
static final String GZQR_PREFIX = "GZQR:v1:";
static final int RAW_SINGLE_LIMIT = 800;
static final int GZ_SINGLE_LIMIT = 1400;
static final int GZQR_CHUNK_SIZE = 1200;
static final int GZQR_PAYLOAD_LIMIT = 1500;
static final int QR_IMAGE_SIZE = 420;
static final int FRAME_DELAY_MS = 500;
static final int MAX_SOURCE_BYTES = 1000000;
static final int MAX_QR_COUNT = 200;
```

한 장의 조각 길이는 1200자 그대로입니다. 디코더도 최대 200장, 해제 결과 1000000 bytes로 맞췄으므로 추후 이 두 한도를 늘릴 때는 디코더 protocol.js의 상수도 같이 변경해야 합니다.

## 2. QrPayload 생성자의 byteLength 한 줄 교체

기존 this.byteLength = utf8Length(text); 를 다음으로 교체합니다. RAW만 UTF-8 길이를 계산하고, ASCII로만 구성된 GZ/GZQR은 문자열 길이를 씁니다.

```java
this.byteLength = "RAW".equals(mode) ? utf8Length(text) : text.length();
```

## 3. escapeHtml 교체 / hasLogText 추가

기존 escapeHtml 메서드 전체를 아래 것으로 교체하고 바로 아래에 hasLogText를 추가합니다.

```java
public static String escapeHtml(String input) {
    if (input == null) return "";
    StringBuilder result = null;
    for (int i = 0; i < input.length(); i++) {
        char c = input.charAt(i);
        String replacement = null;
        switch (c) {
            case '&': replacement = "&amp;"; break;
            case '<': replacement = "&lt;"; break;
            case '>': replacement = "&gt;"; break;
            case '"': replacement = "&quot;"; break;
            case '\'': replacement = "&#x27;"; break;
            default: break;
        }
        if (replacement != null && result == null) {
            result = new StringBuilder(input.length() + 32);
            result.append(input, 0, i);
        }
        if (result != null) {
            if (replacement == null) result.append(c);
            else result.append(replacement);
        }
    }
    return result == null ? input : result.toString();
}
```

```java
public static boolean hasLogText(String log) {
    if (log == null) return false;
    for (int i = 0; i < log.length(); i++) {
        if (log.charAt(i) > 0x20) return true;
    }
    return false;
}
```

작은따옴표의 case 줄에는 **역슬래시가 포함**됩니다. &를 바꾸는 줄과 작은따옴표 줄을 특히 확인하세요.

## 4. buildPayloads 2개를 아래 3개로 교체

기존 buildPayloads(String log), buildPayloads(String log, String groupId) 두 메서드를 모두 제거하고 아래 블록을 넣습니다. 새 byte[] 오버로드는 요청에서 만든 UTF-8 배열을 재사용합니다.

```java
public static List<QrPayload> buildPayloads(String log) throws IOException {
    return buildPayloads(log, createGroupId());
}

public static List<QrPayload> buildPayloads(String log, String groupId) throws IOException {
    if (!hasLogText(log)) return new ArrayList<QrPayload>(0);
    if (log.length() > MAX_SOURCE_BYTES) {
        throw new IllegalArgumentException("Log source is too large. Maximum source size is " + MAX_SOURCE_BYTES + " bytes.");
    }
    return buildPayloads(log, log.getBytes(StandardCharsets.UTF_8), groupId);
}

// The request handler reuses this UTF-8 array for its size and payload generation.
public static List<QrPayload> buildPayloads(String log, byte[] rawBytes, String groupId) throws IOException {
    if (rawBytes.length > MAX_SOURCE_BYTES) {
        throw new IllegalArgumentException("Log source is too large. Maximum source size is " + MAX_SOURCE_BYTES + " bytes.");
    }
    if (rawBytes.length <= RAW_SINGLE_LIMIT && canUseRawPayload(log)) {
        String rawPayload = RAW_PREFIX + log;
        if (rawBytes.length + RAW_PREFIX.length() <= GZQR_PAYLOAD_LIMIT) {
            List<QrPayload> result = new ArrayList<QrPayload>(1);
            result.add(new QrPayload("RAW", rawPayload, 1, 1));
            return result;
        }
    }

    String encoded = gzipBase64Url(rawBytes);
    if (GZIP_PREFIX.length() + encoded.length() <= GZ_SINGLE_LIMIT) {
        List<QrPayload> result = new ArrayList<QrPayload>(1);
        result.add(new QrPayload("GZ", GZIP_PREFIX + encoded, 1, 1));
        return result;
    }

    String safeGroupId = normalizeGroupId(groupId);
    int total = (encoded.length() + GZQR_CHUNK_SIZE - 1) / GZQR_CHUNK_SIZE;
    if (total > MAX_QR_COUNT) {
        throw new IllegalArgumentException("Compressed log is too large. Required QR count: "
                + total + ". Maximum QR count: " + MAX_QR_COUNT + ".");
    }

    List<QrPayload> result = new ArrayList<QrPayload>(total);
    for (int i = 0; i < total; i++) {
        int start = i * GZQR_CHUNK_SIZE;
        String chunk = encoded.substring(start, Math.min(start + GZQR_CHUNK_SIZE, encoded.length()));
        String payload = GZQR_PREFIX + safeGroupId + ":" + (i + 1) + ":" + total + ":" + chunk;
        if (payload.length() > GZQR_PAYLOAD_LIMIT) {
            throw new IllegalArgumentException("QR payload exceeds " + GZQR_PAYLOAD_LIMIT + " bytes. Check chunk size.");
        }
        result.add(new QrPayload("GZQR", payload, i + 1, total));
    }
    return result;
}
```

200장이 넘으면 필요한 장수도 오류에 표시됩니다. 최종 payload 길이는 헤더를 포함해 매 조각 검사합니다.

## 5. gzipBase64Url 교체

```java
public static String gzipBase64Url(byte[] bytes) throws IOException {
    ByteArrayOutputStream baos = new ByteArrayOutputStream(8192);
    try (GZIPOutputStream gzip = new GZIPOutputStream(baos, 8192)) {
        gzip.write(bytes);
    }
    return Base64.getUrlEncoder().withoutPadding().encodeToString(baos.toByteArray());
}
```

기존 canUseRawPayload, isDecoderTrimChar, utf8Length, createGroupId는 그대로 둬도 됩니다. normalizeGroupId 안의 StringBuilder 생성만 아래처럼 바꿉니다.

```java
StringBuilder safe = new StringBuilder(32);
```

## 6. createQrPngBase64 전체 교체

흑백 행 단위 기록, 메모리 PNG 출력, 흰 여백 4칸을 적용합니다. QrImage 클래스는 기존 것을 유지합니다.

```java
public static String createQrPngBase64(String text, int size) throws Exception {
    Map<EncodeHintType, Object> hints = new HashMap<EncodeHintType, Object>();
    hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
    hints.put(EncodeHintType.MARGIN, Integer.valueOf(4));
    BitMatrix matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints);
    int width = matrix.getWidth();
    int height = matrix.getHeight();
    BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_BYTE_BINARY);
    java.awt.image.WritableRaster raster = image.getRaster();
    int[] row = new int[width];
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) row[x] = matrix.get(x, y) ? 0 : 1;
        raster.setSamples(0, y, width, 1, 0, row);
    }
    ByteArrayOutputStream baos = new ByteArrayOutputStream(8192);
    try (javax.imageio.stream.MemoryCacheImageOutputStream png =
            new javax.imageio.stream.MemoryCacheImageOutputStream(baos)) {
        if (!ImageIO.write(image, "png", png)) throw new IOException("PNG writer is not available.");
        png.flush();
    }
    return Base64.getEncoder().encodeToString(baos.toByteArray());
}
```

## 7. 요청 처리 scriptlet 전체 교체

선언부 <%! ... %> 다음에 있는 String submittedLog = request.getParameter("errorLog"); 로 시작하는 요청 처리 <% ... %> 블록을 다음으로 교체합니다. HTML 출력용 다른 <% ... %> 블록은 이 단계에서 건드리지 않습니다.

```jsp
<%
// Must precede getParameter(). A filter that already parsed parameters must also use UTF-8.
request.setCharacterEncoding("UTF-8");
String submittedLog = request.getParameter("errorLog");
boolean submitted = "POST".equalsIgnoreCase(request.getMethod());
String errorMessage = "";
List<QrPayload> qrPayloads = new ArrayList<QrPayload>();
List<QrImage> qrImages = new ArrayList<QrImage>();
int sourceBytes = 0;
long generationMs = 0;
if (submitted) {
    if (!hasLogText(submittedLog)) {
        errorMessage = "에러 로그를 입력하세요.";
    } else {
        long startedAt = System.nanoTime();
        try {
            if (submittedLog.length() > MAX_SOURCE_BYTES) {
                throw new IllegalArgumentException("Log source is too large. Maximum source size is " + MAX_SOURCE_BYTES + " bytes.");
            }
            byte[] rawBytes = submittedLog.getBytes(StandardCharsets.UTF_8);
            sourceBytes = rawBytes.length;
            qrPayloads = buildPayloads(submittedLog, rawBytes, createGroupId());
            qrImages = new ArrayList<QrImage>(qrPayloads.size());
            for (QrPayload payload : qrPayloads) {
                qrImages.add(new QrImage(payload, createQrPngBase64(payload.text, QR_IMAGE_SIZE)));
            }
        } catch (Exception e) {
            application.log("Offline log QR generation failed", e);
            String detail = e.getMessage() == null ? e.getClass().getName() : e.getMessage();
            errorMessage = "QR 생성 실패: " + detail;
            qrPayloads.clear();
            qrImages.clear();
        } finally {
            generationMs = (System.nanoTime() - startedAt) / 1000000L;
        }
    }
}
%>
```

request.setCharacterEncoding("UTF-8")는 getParameter보다 먼저 실행되어야 합니다. 앞단 필터가 이미 파라미터를 읽었다면 그 필터도 UTF-8이어야 합니다. 이때까지 반영한 뒤 기존 플레이어 상태로 저장/컴파일해도 됩니다.

## 8. head와 form 속성, 요약 표시 수정

head의 charset 다음에 아래 태그를 추가합니다(이미 있으면 중복 추가하지 않습니다).

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

기존 form 시작 태그를 아래와 같이 바꿉니다.

```html
<form method="post" action="" accept-charset="UTF-8">
```

생성 결과 summary의 QR 개수 다음에 다음 줄을 추가하면 생성 시간을 비교할 수 있습니다.

```jsp
<br>서버 생성 시간: <%= generationMs %> ms
```

기존 style 블록 전체를 다음으로 교체합니다. 이미지 자체의 8px 검은 테두리를 없애고 바깥 qr-screen에 여백을 둡니다. 작은 화면에서는 QR 영역을 스크롤하며 원본 420px를 유지합니다. 브라우저 확대율 100%에서 확인하세요.

```jsp
<style>
body { font-family: Arial, "Malgun Gothic", sans-serif; margin: 0; padding: 24px; color: #1f2933; background: #f6f7f9; }
.wrap { max-width: 980px; margin: 0 auto; }
textarea { width: 100%; height: 450px; box-sizing: border-box; padding: 12px; font-family: Consolas, monospace; font-size: 14px; line-height: 1.45; border: 1px solid #b8c0cc; background: #fff; }
button, select, input { font-size: 16px; padding: 8px 12px; }
button { cursor: pointer; }
.notice, .error, .result-area, .player-area, .payload-debug-list { border: 1px solid #d5dbe3; background: #fff; padding: 16px; margin-top: 18px; }
.error { border-color: #d9534f; color: #a12622; background: #fff4f4; }
.summary { line-height: 1.7; }
.player-area { text-align: center; }
.qr-screen { display: inline-block; max-width: 100%; overflow: auto; box-sizing: border-box; padding: 12px; border: 1px solid #d5dbe3; background: #fff; }
#qrPlayerImage { display: block; width: <%= QR_IMAGE_SIZE %>px; height: <%= QR_IMAGE_SIZE %>px; max-width: none; border: 0; background: #fff; image-rendering: pixelated; }
.player-status { margin: 12px 0; font-size: 18px; font-weight: bold; }
.controls { margin-top: 12px; display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 8px; }
#qrJumpIndex { width: 90px; }
.payload-debug-list details { margin-top: 10px; }
.payload-text { height: 120px; font-size: 12px; }
</style>
```

## 9. player-area HTML 교체

기존 <div class="player-area">부터 그 영역의 닫는 </div>까지를 아래 블록으로 교체합니다. 다음에 나오는 payload-debug-list 영역은 유지합니다.

```jsp
<div class="player-area">
<div class="qr-screen"><img id="qrPlayerImage" src="data:image/png;base64,<%= qrImages.get(0).base64 %>" alt="QR Code" width="<%= QR_IMAGE_SIZE %>" height="<%= QR_IMAGE_SIZE %>"></div>
<div id="qrPlayerStatus" class="player-status" aria-live="polite">준비됨</div>
<div class="controls">
<button type="button" onclick="startPlay()">재생</button>
<button type="button" onclick="stopPlay()">일시정지</button>
<button type="button" onclick="prevFrame()">이전</button>
<button type="button" onclick="nextFrame()">다음</button>
<button type="button" onclick="resetPlay()">처음으로</button>
</div>
<div class="controls">
<label for="qrSpeed">표시 시간</label>
<select id="qrSpeed" onchange="changeSpeed()">
<option value="500">0.5초</option><option value="700">0.7초</option>
<option value="1000">1초</option><option value="1500">1.5초</option>
</select>
<label for="qrJumpIndex">QR 번호</label>
<input id="qrJumpIndex" type="number" min="1" max="<%= qrImages.size() %>" value="1">
<button type="button" onclick="jumpFrame()">이동</button>
</div>
</div>
```

이전/다음/번호 이동은 재생을 멈춘 상태에서 이동합니다. 멀티 QR 초기화는 디코더에서 새 로그를 읽을 때 사용합니다.

## 10. 플레이어 script 전체 교체

기존 var qrFrames = [ 로 시작하는 script 전체를 다음으로 교체합니다. 기존 setInterval, qrPayloadIndexes, qrPayloadTotals 배열은 새 블록과 함께 남겨두지 않습니다. script는 기존과 같이 QR이 생성된 경우에만 출력되는 if 블록 안에 둡니다.

```jsp
<script>
// BEGIN QR PLAYER
var qrFrames = [
<% for (int i = 0; i < qrImages.size(); i++) { %>
"data:image/png;base64,<%= qrImages.get(i).base64 %>"<%= i + 1 < qrImages.size() ? "," : "" %>
<% } %>
];
var qrModes = [
<% for (int i = 0; i < qrPayloads.size(); i++) { %>
"<%= qrPayloads.get(i).mode %>"<%= i + 1 < qrPayloads.size() ? "," : "" %>
<% } %>
];
var qrPayloadLengths = [
<% for (int i = 0; i < qrPayloads.size(); i++) { %>
<%= qrPayloads.get(i).byteLength %><%= i + 1 < qrPayloads.size() ? "," : "" %>
<% } %>
];
var currentIndex = 0;
var playTimer = null;
var playing = false;
var frameDelayMs = <%= FRAME_DELAY_MS %>;
var renderToken = 0;
var frameCache = {};
var qrPlayerImage = document.getElementById("qrPlayerImage");
var qrPlayerStatus = document.getElementById("qrPlayerStatus");

function normalizeIndex(index) {
    return (index % qrFrames.length + qrFrames.length) % qrFrames.length;
}
function updatePlayerStatus() {
    qrPlayerStatus.textContent = "QR " + (currentIndex + 1) + " / " + qrFrames.length
        + " - " + qrModes[currentIndex] + " (" + qrPayloadLengths[currentIndex] + " bytes)"
        + (playing ? " / 재생 중" : " / 일시정지")
        + " / 한 바퀴 약 " + (qrFrames.length * frameDelayMs / 1000) + "초";
}
function prepareFrame(index, callback) {
    var item = frameCache[index];
    if (item) {
        if (item.ready) { if (callback) callback(); }
        else if (callback) item.callbacks.push(callback);
        return;
    }
    item = { image: new Image(), ready: false, callbacks: callback ? [callback] : [] };
    frameCache[index] = item;
    item.image.onload = function () {
        item.ready = true;
        var callbacks = item.callbacks;
        item.callbacks = [];
        for (var i = 0; i < callbacks.length; i++) callbacks[i]();
    };
    item.image.onerror = function () {
        delete frameCache[index];
        item.callbacks = [];
        stopPlay();
        qrPlayerStatus.textContent = "QR " + (index + 1) + " 이미지 로드 실패";
    };
    item.image.src = qrFrames[index];
}
function showFrame(index, afterShow) {
    index = normalizeIndex(index);
    var token = ++renderToken;
    prepareFrame(index, function () {
        if (token !== renderToken) return;
        currentIndex = index;
        qrPlayerImage.src = qrFrames[index];
        document.getElementById("qrJumpIndex").value = index + 1;
        updatePlayerStatus();
        var next = normalizeIndex(index + 1);
        var next2 = normalizeIndex(index + 2);
        for (var key in frameCache) {
            if (Number(key) !== index && Number(key) !== next && Number(key) !== next2) delete frameCache[key];
        }
        prepareFrame(next);
        prepareFrame(next2);
        if (afterShow) afterShow();
    });
}
function scheduleNext() {
    clearTimeout(playTimer);
    if (!playing) return;
    playTimer = setTimeout(function () {
        showFrame(currentIndex + 1, scheduleNext);
    }, frameDelayMs);
}
function startPlay() {
    stopPlay();
    if (qrFrames.length < 2) return;
    playing = true;
    updatePlayerStatus();
    scheduleNext();
}
function stopPlay() {
    playing = false;
    renderToken++;
    clearTimeout(playTimer);
    playTimer = null;
    updatePlayerStatus();
}
function nextFrame() { stopPlay(); showFrame(currentIndex + 1); }
function prevFrame() { stopPlay(); showFrame(currentIndex - 1); }
function resetPlay() { stopPlay(); showFrame(0); }
function changeSpeed() {
    frameDelayMs = Number(document.getElementById("qrSpeed").value);
    updatePlayerStatus();
    if (playing) scheduleNext();
}
function jumpFrame() {
    var number = Number(document.getElementById("qrJumpIndex").value);
    if (number !== Math.floor(number) || number < 1 || number > qrFrames.length) {
        qrPlayerStatus.textContent = "1 ~ " + qrFrames.length + " 사이의 정수를 입력하세요.";
        return;
    }
    stopPlay();
    showFrame(number - 1);
}
document.getElementById("qrSpeed").value = String(frameDelayMs);
document.getElementById("qrJumpIndex").onkeydown = function (event) {
    if (event.key === "Enter" || event.keyCode === 13) { event.preventDefault(); jumpFrame(); }
};
window.addEventListener("pagehide", stopPlay);
showFrame(0);
// END QR PLAYER
</script>
```

재생은 준비된 프레임을 표시한 뒤 다음 타이머를 예약합니다. JS가 유지하는 preload 객체는 현재/다음/다다음 최대 3개입니다. 브라우저 자체의 이미지 캐시는 별도입니다.

## 11. 직접 입력 후 확인 순서

1. 저장 인코딩 UTF-8 / Java 8 / 기존 ZXing JAR로 JSP가 열리는지 확인합니다.
2. 짧은 한글과 <>&를 입력합니다. RAW 한 장으로 생성되고 디코더 결과가 일치해야 합니다.
3. 앞 공백과 마지막 개행이 있는 짧은 로그를 입력합니다. GZ로 생성되고 공백이 유지되어야 합니다.
4. 50장이 넘던 로그를 입력합니다. 200장 이하면 생성되고, 넘으면 필요한 장수가 표시되어야 합니다.
5. QR 50번으로 이동, 이전/다음, 처음으로, 표시 시간 0.5/0.7/1/1.5초를 확인합니다.
6. 디코더에서 몇 장 받은 뒤 중지 → 이어서 스캔합니다. 받은 번호가 유지되어야 합니다. 새로고침하면 수집 상태는 지워집니다.
7. 빠진 번호를 확인해 JSP에서 해당 번호로 이동합니다. 복원이 끝나면 Copy Output으로 복사합니다.

타이핑 오류가 잦은 항목: byte[] 오버로드 누락, catch/finally의 중괄호, MemoryCacheImageOutputStream 철자, scriptlet의 <% %>, 쉼표를 출력하는 JSP 삼항식, 기존 script 중복입니다.

## 적용 범위와 검증 한계

200장은 항상 만드는 장수가 아니라 상한입니다. 입력의 압축 후 크기에 따라 실제 장수가 정해집니다. WAS/프록시의 POST 제한은 JSP의 100만 bytes와 별개이며 폼 URL 인코딩으로 요청 본문이 더 커질 수 있습니다. 실제 WAS 설정은 변경하지 않았습니다.

원문 검증 기준은 서버가 받은 문자열입니다. 브라우저 textarea/폼에 붙여넣기 전의 파일 바이트와는 개행 방식이 달라질 수 있습니다. 디코더의 정상 Copy Output 경로는 복원 문자열의 BOM과 CRLF를 유지하며, 권한 실패 후 수동 선택 복사에는 브라우저의 개행 정규화가 적용될 수 있습니다.

구체적인 실행 결과와 카메라 미검증 범위는 [검증 결과](VALIDATION.md)를 확인하세요.
