<%@page import="javax.imageio.stream.MemoryCacheImageOutputStream"%>
<%@page import="java.awt.image.WritableRaster"%>
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
<%@page import="java.util.List"%>
<%@page import="java.util.HashMap"%>
<%@page import="java.util.Map"%>
<%@page import="java.util.Base64"%>
<%@page import="java.util.zip.GZIPOutputStream"%>

<%!
	/*
	 * JSP declaration 영역입니다.
	 * 이 블록에 선언한 static 상수/메서드/클래스는 JSP가 서블릿으로 컴파일 될 때
	 * 서블릿 클래스의 멤버로 들어갑니다
	 *
	 * 전체 흐름:
	 * 1. 로그가 짧고 앞뒤 공백 보존 문제가 없으면 RAW:<원문> 단일 QR을 만듭니다
	 * 2. RAW가 어렵거나 로그가 길면 GZIP 압축 후 GZ:<base64url> 단일 QR을 시도합니다
	 * 3. GZIP 결과도 한 QR에 담기 크면 GZQR:v1:<id>:<index>:<total>:<chunk> 여러 장으로 나눕니다
	*/
	// BEGIN TESTABLE CORE
	// 모바일 디코더와 약속한 payload prefix입니다. 임의로 변경하면 디코더도 같이 바꿔야합니다
	static final String RAW_PREFIX  = "RAW:\n";
	static final String GZIP_PREFIX = "GZ:\n";
	static final String GZQR_PREFIX = "GZQR:v1:";

	// QR 안정성을 위해 보수적으로 잡은 기준값입니다. 아래 범위는 Java 제한이 아니라 모바일 스캔 안정성 기준입니다.
	static final int RAW_SINGLE_LIMIT 	= 800;	// 권장 500 ~ 1200 bytes. 기본 800. 1200 초과 원문은 QR이 조밀해져 GZIP 권장
	static final int GZ_SINGLE_LIMIT 	= 1400;	// 권장 1000 ~ 1600 bytes. 실기기 스캔 검증 후 1800 까지 검증 가능
	static final int GZQR_CHUNK_SIZE 	= 1200;	// 권장 1000 ~ 1500 chars. 안정 우선은 1200, 검증 후 1800까지 검토 가능
	static final int GZQR_PAYLOAD_LIMIT = 1500;	// 권장 1300 ~ 1800 bytes. GZQR_CHUNK_SIZE보다 header 길이만큼 커야합니다
	static final int QR_IMAGE_SIZE 		= 420;	// 권장 380 ~ 600 px 권장.
	static final int FRAME_DELAY_MS 	= 500;  // 권장 400 ~ 600 권장.

	// 화면/서버 보호용 제한입니다. 너무 큰 로그가 들어오면 QR 생성 전에 거절합니다.
	static final int MAX_SOURCE_BYTES 	= 5000000; // 단독 사용자 설정. WAS 메모리와 POST 제한은 별도 확인 필요
	static final int MAX_QR_COUNT 		= 300;

	// QR 한 장에 들어갈 payload와 화면 표시용 메타데이터를 같이 들고 다니는 객체입니다.
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
			this.byteLength = "RAW".equals(mode) ? utf8Length(text) : text.length();
		}
	}

	// JSP 화면에 사용자 입력/에러 메시지를 다시 출력할 때 XSS를 막기 위한 HTML escaping 입니다.
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

	public static boolean hasLogText(String log) {
		if (log == null) return false;
		for (int i = 0; i< log.length(); i++) {
			if (log.charAt(i) > 0x20) return true;
		}

		return false;
	}

	public static List<QrPayload> buildPayloads(String log) throws IOException {
		return buildPayloads(log, createGroupId());
	}

	public static List<QrPayload> buildPayloads(String log, String groupId) throws IOException {
		if (!hasLogText(log)) {
			return new ArrayList<QrPayload>(0);
		}

		if (log.length() > MAX_SOURCE_BYTES) {
			throw new IllegalArgumentException("Log source is too large. Maximum source size is " + MAX_SOURCE_BYTES + " bytes.");
		}

		return buildPayloads(log, log.getBytes(StandardCharsets.UTF_8), groupId);
	}

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
			throw new IllegalArgumentException("Compressed log is too large. Required QR count: " + total + ". Maximum QR count: " + MAX_QR_COUNT + ".");
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


	// byte[] 로그를 GZIP으로 압축하고 base64url 문자열로 변환합니다.
	// withoutPadding()을 쓰면 QR payload에서 불필요한 '=' 문자를 줄일 수 있습니다.
	public static String gzipBase64Url(byte[] bytes) throws IOException {
		ByteArrayOutputStream baos = new ByteArrayOutputStream(8192);

		try (GZIPOutputStream gzip = new GZIPOutputStream(baos, 8192)) {
			gzip.write(bytes);
		}

		return Base64.getUrlEncoder().withoutPadding().encodeToString(baos.toByteArray());
	}

	public static boolean canUseRawPayload(String log) {
		if (log == null || log.length() == 0) return false;
		// RAW 안전 규칙:
		// 모바일 디코더는 스캔된 QR 문자열을 trim()한 뒤 prefix를 검사합니다.
		// 그래서 원문 앞뒤 공백/개행이 중요한 로그는 RAW로 보내면 손실될 수 있습니다.
		// 이런 경우에는 GZIP 경로를 타게 해서 원문을 byte 단위로 보존합니다.
		return !isDecoderTrimChar(log.charAt(0)) && !isDecoderTrimChar(log.charAt(log.length() - 1));
	}

	// JavaScript trim() 계열에서 제거될 수 있는 주요 공백 문자를 보수적으로 검사합니다.
	public static boolean isDecoderTrimChar(char c) {
		if (c == 0xFEFF) return true;
		if (c == 0x2028 || c == 0x2029) return true;
		if (c >= 0x0009 && c <= 0x000D) return true;
		if (c == 0x0020 || c == 0x00A0) return true;

		return Character.getType(c) == Character.SPACE_SEPARATOR;
	}

	// QR 용량 판다을 위한 UTF-8 byte 길이 계산 helper 입니다.
	public static int utf8Length(String value) {
		if (value == null) return 0;
		return value.getBytes(StandardCharsets.UTF_8).length;
	}

	// 멀티 QR 묶음 ID를 만듭니다.
	// 시간 + nano 일부를 섞어 같은 시각에 생성한 로그끼리도 ID가 겹칠 가능성을 낮춥니다.
	public static String createGroupId() {
		String millis = Long.toString(System.currentTimeMillis(), 36);
		String nanos = Long.toString(System.nanoTime() & 0xfffffL, 36);

		return normalizeGroupId(millis + nanos);
	}

	// GZQR payload는 콜론(:)으로 필드를 나누므로 groupid에는 안전한 문자만 남깁니다
	// 길이도 32자로 제한해 QR payload가 불필요하게 길어지지 않게 합니다.
	public static String normalizeGroupId(String groupId) {
		String value = groupId == null ? "" : groupId;
		StringBuilder safe = new StringBuilder(32);

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

	// 화면에는 QrPayload와 PNG base64 문자열을 같이 사용하므로 표시용 객체로 묶습니다.
	static class QrImage {
		public final QrPayload payload;
		public final String base64;

		QrImage(QrPayload payload, String base64) {
			this.payload = payload;
			this.base64 = base64;
		}
	}

	// ZXing BitMatrix를 만들고, 흑백 BufferedImage로 변환한 뒤 PNG base64 문자열로 변환합니다.
	public static String createQrPngBase64(String text, int size) throws Exception {
		Map<EncodeHintType, Object> hints = new HashMap<EncodeHintType, Object>();

		// QR payload는 UTF-8 텍스트로 넣습니다. MARGIN은 QR 주변 여백입니다.
		hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
		hints.put(EncodeHintType.MARGIN, Integer.valueOf(4));

		BitMatrix matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints);

		int width = matrix.getWidth();
		int height = matrix.getHeight();

		BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_BYTE_BINARY);

		WritableRaster raster = image.getRaster();
		int[] row = new int[width];

		for (int y = 0; y < height; y++) {
			for (int x = 0; x < width; x++) {
				row[x] = matrix.get(x, y) ? 0 : 1;
			}

			raster.setSamples(0, y, width, 1, 0, row);
		}

		// 파일로 저장하지 않고 data:image/png;base64 로 바로 보여주기 위해 메모리에서 인코딩합니다
		ByteArrayOutputStream baos = new ByteArrayOutputStream(8192);

		try (MemoryCacheImageOutputStream png = new MemoryCacheImageOutputStream(baos)) {
			if (!ImageIO.write(image, "png", png)) {
				throw new IOException("PNG writer is not available.");
			}

			png.flush();
		}

		return Base64.getEncoder().encodeToString(baos.toByteArray());
	}
%>

<%
	request.setCharacterEncoding("UTF-8");

	String submittedLog = request.getParameter("errorLog");
	boolean submitted = "POST".equalsIgnoreCase(request.getMethod());
	String errorMessage = "";

	List<QrPayload> qrPayloads = new ArrayList<QrPayload>();
	List<QrImage> qrImages = new ArrayList<QrImage>();

	int sourceBytes = 0;
	long generationMs = 0;

	if (submitted) {
		// 입력값이 없으면 QR 생성 로직을 타지 않고 화면에 에러만 보여줍니다.
		if (!hasLogText(submittedLog)) {
			errorMessage = "에러 로그를 입력하세요";
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

<!DOCTYPE html>
<html lang="ko">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>QR 생성기</title>
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
			height: 450px;
			box-sizing: border-box;
			padding: 12px;
			font-family: Consolas, "Courier New", monospace;
			font-size: 14px;
			line-height: 1.45;
			border: 1px solid #b8c0cc;
			background: #fff;
		}
		button, select, input {
			font-size: 16px;
			padding: 8px 12px;
		}
		button {
			cursor: pointer;
		}
		.notice,
		.error,
		.result-area,
		.player-area,
		.payload-debug-list {
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
		.player-area {
			text-align: center;
		}
		#qrPlayerImage {
			display: block;
			width: <%=QR_IMAGE_SIZE %>px;
			height: <%=QR_IMAGE_SIZE %>px;
			max-width: none;
			border: 0;
			background: #fff;
			image-rendering: pixelated;
		}
		.qr-screen {
			display: inline-block;
			max-width: 100%;
			overflow: auto;
			box-sizing: border-box;
			padding: 12px;
			border: 1px solid #d5dbe3;
			background: #fff;
		}
		.player-status {
			margin: 12px 0;
			font-size: 18px;
			font-weight: bold;
		}
		.controls {
			margin-top: 12px;
			display: flex;
			justify-content: center;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}
		#qrJumpIndex {
			width: 90px;
		}
		.payload-debug-list details {
			margin-top: 10px;
		}
		.payload-text {
			height: 120px;
			min-height: 90px;
			margin-top: 8px;
			font-size: 12px;
		}
	</style>
</head>
<body>
	<div class="wrap">
		<h2>에러 로그 생성기</h2>

		<%--현재 JSP가 어떤 기준으로 QR을 나누는지 운영자가 바로 볼 수 있게 안내합니다. --%>
		<p class="notice">짧은 로그는 RAW 단일 QR, 긴 로그는 GZIP 단일 QR, 더 긴 로그는 GZQR 멀티 QR로 생성합니다</p>
		<p class="notice">현재 QR 설정 : 원문 최대 <%= MAX_SOURCE_BYTES %> bytes, GZ 단일 최대 <%= GZ_SINGLE_LIMIT %> bytes, GZQR 조각 최대 <%= GZQR_CHUNK_SIZE %> chars, QR 최대 <%= MAX_QR_COUNT %>개, 이미지 <%= QR_IMAGE_SIZE %>px.</p>

		<%-- 사용자는 WAS 에러 로그를 textarea에 붙여넣고 submit합니다. --%>
		<form method="post" action="" accept-charset="UTF-8">
			<textarea name="errorLog" placeholder="여기에 붙여넣으세요"><%= escapeHtml(submittedLog) %></textarea>
			<br>
			<button type="submit">QR 코드로 변환하기</button>
		</form>

		<%-- 입력 오류나 QR 생성 오류가 있으면 여기에서 표시합니다 --%>
		<%
			if (errorMessage.length() > 0) {
		%>
				<div class="error"><%= escapeHtml(errorMessage) %></div>
		<%
			}
		%>

		<%-- QR 생성이 성공한 경우에만 결과 영역을 표시합니다. --%>
		<%
			if (!qrImages.isEmpty()) {
		%>
				<div class="result-area">
					<h3>생성 완료</h3>

					<%-- 원문 크기, 생성 방식, QR 개수를 요약합니다 --%>
					<p class="summary">
						원문 UTF-8 길이: <strong><%= sourceBytes %></strong> bytes<br>
						생성 방식: <strong><%= escapeHtml(qrPayloads.get(0).mode) %></strong><br>
						QR 개수: <strong><%= qrImages.size() %></strong><br>
						서버 생성 시간: <%= generationMs %>ms
					</p>

					<%-- 멀티 QR이면 모바일 디코더에서 모든 조각을 스캔해야 복원됩니다 --%>
					<%
						if (qrImages.size() > 1) {
					%>
							<p class="notice">모바일 디코더에서 멀티 QR 스캔을 선택 한 뒤 아래 QR을 아무 순서로 모두 스캔하세요</p>
					<%
						}
					%>
				</div>

				<div class="player-area">
					<div class="qr-screen">
						<img id="qrPlayerImage" src="data:image/png;base64,<%= qrImages.get(0).base64 %>" alt="QR Code" width="<%= QR_IMAGE_SIZE %>" height="<%=QR_IMAGE_SIZE %>">
					</div>
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
							<option value="500">0.5초</option>
							<option value="700">0.7초</option>
							<option value="1000">1초</option>
							<option value="1500">1.5초</option>
						</select>

						<label for="qrJumpIndex">QR 번호</label>
						<input id="qrJumpIndex" type="number" min="1" max="<%=qrImages.size() %>" value="1">
						<button type="button" onclick="jumpFrame()">이동</button>
					</div>
				</div>

				<div class="payload-debug-list">
					<strong>QR payload 확인</strong>
				<%
					for (int i = 0; i < qrImages.size(); i += 1) {
						QrImage qr = qrImages.get(i);
						QrPayload payload = qr.payload;
				%>
						<details>
							<summary>QR <%= payload.index %> / <%= payload.total %> - <%= escapeHtml(payload.mode) %> (<%=payload.byteLength %> bytes)</summary>
							<textarea class="payload-text" readonly><%= escapeHtml(payload.text) %></textarea>
						</details>
				<%
					}
				%>
				</div>
				<script>
					var qrFrames = [
						<%
							for (int i = 0; i < qrImages.size(); i += 1) {
						%>
								"data:image/png;base64,<%=qrImages.get(i).base64%>"<%= i + 1 < qrImages.size() ? "," : "" %>
						<%
							}
						%>
					];
					var qrModes = [
						<%
							for (int i = 0; i < qrPayloads.size(); i += 1) {
						%>
								"<%= qrPayloads.get(i).mode%>"<%= i + 1 < qrPayloads.size() ? "," : "" %>
						<%
							}
						%>
					];
					var qrPayloadLengths = [
						<%
							for (int i = 0; i < qrPayloads.size(); i += 1) {
						%>
								<%= qrPayloads.get(i).byteLength%><%= i + 1 < qrPayloads.size() ? "," : "" %>
						<%
							}
						%>
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
						qrPlayerStatus.textContent = "QR " + (currentIndex + 1) + " / " + qrFrames.length + " - " + qrModes[currentIndex] + " (" + qrPayloadLengths[currentIndex] + " bytes)" + (playing ? " / 재생 중" : " / 일시정지") + " / 한 바퀴 약 " + (qrFrames.length * frameDelayMs / 1000) + "초";
					}

					function prepareFrame(index, callback) {
						var item = frameCache[index];

						if (item) {
							if (item.ready) {
								if (callback) callback();
							} else if (callback) {
								item.callbacks.push(callback);
							}

							return;
						}

						item = {
							image: new Image(),
							ready: false,
							callbacks: callback ? [callback] : []
						};

						frameCache[index] = item;

						item.image.onload = function () {
							item.ready = true;

							var callbacks = item.callbacks;
							item.callbacks = [];

							for (var i = 0; i < callbacks.length; i++) {
								callbacks[i]();
							}
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
								if (Number(key) !== index && Number(key) !== next && Number(key) !== next2) {
									delete frameCache[key];
								}
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

					function nextFrame() {
						stopPlay();
						showFrame(currentIndex + 1);
					}

					function prevFrame() {
						stopPlay();
						showFrame(currentIndex - 1);
					}

					function resetPlay() {
						stopPlay();
						showFrame(0);
					}

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
						if (event.key === "Enter" || event.keyCode === 13) {
							event.preventDefault();
							jumpFrame();
						}
					};

					window.addEventListener("pagehide", stopPlay);
					showFrame(0);
				</script>
		<%
			}
		%>
	</div>
</body>
</html>
