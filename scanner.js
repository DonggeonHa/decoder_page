export function createQrScanner(options) {
  var video = options.video;
  var onScan = options.onScan;
  var onStatus = options.onStatus;
  var overlay = options.overlay;
  var detector = null;
  var stream = null;
  var running = false;
  var starting = false;
  var generation = 0;
  var lastRawValue = "";
  var lastScanAt = 0;

  function setOverlay(message, visible) {
    if (!overlay) return;
    overlay.textContent = message || "";
    overlay.classList.toggle("hidden", !visible);
  }

  async function ensureDetector() {
    if (!("BarcodeDetector" in window)) {
      throw new Error("BarcodeDetector가 없습니다. 최신 Chrome에서 열어주세요.");
    }
    if (!detector) {
      if (BarcodeDetector.getSupportedFormats) {
        var formats = await BarcodeDetector.getSupportedFormats();
        if (formats.indexOf("qr_code") < 0) throw new Error("이 브라우저는 QR 스캔을 지원하지 않습니다.");
      }
      detector = new BarcodeDetector({ formats: ["qr_code"] });
    }
  }

  function release(camera) {
    if (camera) camera.getTracks().forEach(function (track) { track.stop(); });
  }

  async function start() {
    if (running || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("이 브라우저에서는 카메라 접근을 사용할 수 없습니다.");
    }
    var token = ++generation;
    starting = true;
    try {
      await ensureDetector();
      if (token !== generation) return;
      var camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      if (token !== generation) { release(camera); return; }
      stream = camera;
      video.srcObject = camera;
      await video.play();
      if (token !== generation) return;
      running = true;
      lastRawValue = "";
      lastScanAt = 0;
      setOverlay("QR을 화면 중앙에 맞춰주세요.", false);
      onStatus("카메라 스캔 중");
      scanLoop(token);
    } catch (error) {
      if (token !== generation) return;
      stop();
      throw error;
    } finally {
      if (token === generation) starting = false;
    }
  }

  function stop() {
    generation++;
    starting = false;
    running = false;
    release(stream);
    stream = null;
    video.srcObject = null;
    setOverlay("카메라가 꺼져 있습니다.", true);
    onStatus("스캔 중지됨");
  }

  async function scanLoop(token) {
    if (!running || token !== generation) return;
    try {
      var codes = await detector.detect(video);
      if (!running || token !== generation) return;
      if (codes && codes.length > 0) {
        var rawValue = codes[0].rawValue || "";
        var now = Date.now();
        if (rawValue && (rawValue !== lastRawValue || now - lastScanAt > 1500)) {
          lastRawValue = rawValue;
          lastScanAt = now;
          await onScan(rawValue);
        }
      }
    } catch (error) {
      if (running && token === generation) {
        onStatus(error && error.message ? error.message : "QR 스캔 중 오류가 발생했습니다.");
      }
    }
    if (running && token === generation) requestAnimationFrame(function () { scanLoop(token); });
  }

  return { start: start, stop: stop, isRunning: function () { return running; } };
}
