import {
  addMultiChunk,
  assembleMultiGzip,
  createMultiCollector,
  getMissingIndexes,
  getReceivedIndexes,
  parseQrPayload
} from "./protocol.js";
import { gunzipBase64Url } from "./gzip.js";
import { createQrScanner } from "./scanner.js";

var input = document.getElementById("input");
var output = document.getElementById("output");
var inputMeter = document.getElementById("inputMeter");
var outputMeter = document.getElementById("outputMeter");
var statusLine = document.getElementById("status");
var scanStatus = document.getElementById("scanStatus");
var multiStatus = document.getElementById("multiStatus");
var capabilityBadge = document.getElementById("capabilityBadge");
var environmentWarning = document.getElementById("environmentWarning");
var video = document.getElementById("video");
var scannerOverlay = document.getElementById("scannerOverlay");
var scanSingleBtn = document.getElementById("scanSingleBtn");
var scanMultiBtn = document.getElementById("scanMultiBtn");
var resetMultiBtn = document.getElementById("resetMultiBtn");
var stopScanBtn = document.getElementById("stopScanBtn");

var mode = "single";
var collector = createMultiCollector();
var scanner = createQrScanner({
  video: video,
  overlay: scannerOverlay,
  onScan: handleScannedValue,
  onStatus: setScanStatus
});

function setStatus(message, type) {
  statusLine.textContent = message || "";
  statusLine.className = type || "";
}

function setScanStatus(message, type) {
  scanStatus.textContent = message || "";
  scanStatus.className = "status " + (type || "");
}

function updateMeters() {
  inputMeter.textContent = input.value.length + " chars";
  outputMeter.textContent = output.value.length + " chars";
}

function detectEnvironment() {
  var warnings = [];
  var ua = navigator.userAgent || "";

  if (ua.indexOf("KAKAOTALK") >= 0) {
    warnings.push("카카오톡 안에서는 카메라 권한이 막힐 수 있습니다. Chrome에서 열어주세요.");
  }

  if (!window.isSecureContext) {
    warnings.push("보안 컨텍스트가 아닙니다. 카메라 스캔은 HTTPS 또는 Chrome 로컬 파일에서만 안정적입니다.");
  }

  if (!("BarcodeDetector" in window)) {
    warnings.push("BarcodeDetector가 없습니다. 최신 Chrome에서 열어주세요.");
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    warnings.push("이 브라우저에서는 카메라 접근 API를 사용할 수 없습니다.");
  }

  if (!("DecompressionStream" in window)) {
    warnings.push("GZIP 해제 API가 없습니다. 최신 Chrome에서 열어주세요.");
  }

  if (warnings.length) {
    environmentWarning.textContent = warnings.join(" ");
    environmentWarning.classList.remove("hidden");
    capabilityBadge.textContent = "Check needed";
    capabilityBadge.className = "badge error";
  } else {
    environmentWarning.classList.add("hidden");
    capabilityBadge.textContent = "Ready";
    capabilityBadge.className = "badge ok";
  }
}

async function decodeInput() {
  var raw = input.value;
  var parsed = parseQrPayload(raw);
  output.value = "";
  updateMeters();

  try {
    if (parsed.type === "empty") {
      setStatus("Input is empty.", "error");
      return;
    }

    if (parsed.type === "raw") {
      output.value = parsed.text;
      setStatus("RAW text loaded.", "ok");
      updateMeters();
      return;
    }

    if (parsed.type === "gzip") {
      output.value = await gunzipBase64Url(parsed.encoded);
      setStatus("GZIP decoded.", "ok");
      updateMeters();
      return;
    }

    if (parsed.type === "multi-gzip") {
      setStatus("멀티 QR 조각입니다. 멀티 QR 스캔으로 전체 조각을 모아주세요.", "error");
      return;
    }

    if (parsed.type === "invalid") {
      setStatus(parsed.reason, "error");
      return;
    }

    output.value = parsed.text;
    setStatus("No prefix found. Input copied to output.", "ok");
    updateMeters();
  } catch (error) {
    setStatus(error && error.message ? error.message : "Decode failed.", "error");
  }
}

async function handleScannedValue(rawValue) {
  var parsed = parseQrPayload(rawValue);

  if (parsed.type === "invalid") {
    setScanStatus(parsed.reason, "error");
    return;
  }

  if (parsed.type === "multi-gzip") {
    mode = "multi";
    await handleMultiPayload(parsed);
    return;
  }

  input.value = rawValue;
  updateMeters();

  if (mode === "single") {
    setScanStatus("단일 QR 인식 완료. 자동 해제를 시도합니다.", "ok");
    scanner.stop();
    setScanButtons(false);
    await decodeInput();
    return;
  }

  setScanStatus("단일 QR 값이 입력창에 들어갔습니다.", "ok");
}

async function handleMultiPayload(payload) {
  var result = addMultiChunk(collector, payload);

  if (!result.ok) {
    setScanStatus(result.reason, "error");
    renderMultiStatus("조각 처리 실패");
    return;
  }

  renderMultiStatus(result.duplicate ? "중복 조각 무시: " + payload.index : "조각 수집: " + payload.index);

  if (result.complete) {
    input.value = assembleMultiGzip(collector);
    updateMeters();
    setScanStatus("멀티 QR 조각 수집 완료. 자동 해제를 시도합니다.", "ok");
    scanner.stop();
    setScanButtons(false);
    await decodeInput();
  }
}

function renderMultiStatus(prefix) {
  var received = getReceivedIndexes(collector);
  var missing = getMissingIndexes(collector);

  if (!collector.id) {
    multiStatus.classList.add("hidden");
    multiStatus.textContent = "";
    resetMultiBtn.disabled = true;
    return;
  }

  multiStatus.classList.remove("hidden");
  resetMultiBtn.disabled = false;
  multiStatus.textContent = [
    prefix || "멀티 QR 수집 중",
    "ID: " + collector.id,
    "수집: " + received.length + " / " + collector.total,
    "받은 조각: " + (received.length ? received.join(", ") : "-"),
    "빠진 조각: " + (missing.length ? missing.join(", ") : "-")
  ].join("\n");
}

function resetMultiCollector() {
  collector = createMultiCollector();
  renderMultiStatus("");
}

function resetMultiScan() {
  resetMultiCollector();
  input.value = "";
  updateMeters();
  setScanStatus(mode === "multi" ? "멀티 QR 수집을 초기화했습니다. 다시 스캔하세요." : "멀티 QR 수집을 초기화했습니다.", "ok");
}

async function startScanner(nextMode) {
  mode = nextMode;
  if (mode === "multi") {
    resetMultiCollector();
    setScanStatus("멀티 QR 스캔을 시작합니다. 아무 순서로 스캔해도 됩니다.");
  } else {
    resetMultiCollector();
    setScanStatus("단일 QR 스캔을 시작합니다.");
  }

  try {
    setScanButtons(true);
    await scanner.start();
  } catch (error) {
    setScanButtons(false);
    setScanStatus(error && error.message ? error.message : "카메라를 시작하지 못했습니다.", "error");
  }
}

function setScanButtons(scanning) {
  scanSingleBtn.disabled = scanning;
  scanMultiBtn.disabled = scanning;
  stopScanBtn.disabled = !scanning;
}

async function pasteFromClipboard() {
  try {
    input.value = await navigator.clipboard.readText();
    updateMeters();
    setStatus("Pasted from clipboard.", "ok");
  } catch (error) {
    setStatus("Clipboard read was blocked. Paste manually.", "error");
  }
}

async function copyOutput() {
  if (!output.value) {
    setStatus("Output is empty.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("Output copied.", "ok");
  } catch (error) {
    output.focus();
    output.select();
    setStatus("Clipboard write was blocked. Copy manually.", "error");
  }
}

document.getElementById("decodeBtn").onclick = decodeInput;
document.getElementById("pasteBtn").onclick = pasteFromClipboard;
document.getElementById("clearBtn").onclick = function () {
  input.value = "";
  output.value = "";
  resetMultiCollector();
  setStatus("");
  setScanStatus("스캔 대기 중");
  updateMeters();
  input.focus();
};
document.getElementById("copyBtn").onclick = copyOutput;
scanSingleBtn.onclick = function () {
  startScanner("single");
};
scanMultiBtn.onclick = function () {
  startScanner("multi");
};
resetMultiBtn.onclick = resetMultiScan;
stopScanBtn.onclick = function () {
  scanner.stop();
  setScanButtons(false);
};
input.oninput = updateMeters;

detectEnvironment();
updateMeters();
