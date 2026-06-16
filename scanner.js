export function createQrScanner(options) {
  var video = options.video;
  var onScan = options.onScan;
  var onStatus = options.onStatus;
  var overlay = options.overlay;
  var detector = null;
  var stream = null;
  var running = false;
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
      detector = new BarcodeDetector({ formats: ["qr_code"] });
    }
  }

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("이 브라우저에서는 카메라 접근을 사용할 수 없습니다.");
    }

    await ensureDetector();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });

    video.srcObject = stream;
    await video.play();
    running = true;
    setOverlay("QR을 화면 중앙에 맞춰주세요.", false);
    onStatus("카메라 스캔 중");
    scanLoop();
  }

  function stop() {
    running = false;

    if (stream) {
      stream.getTracks().forEach(function (track) {
        track.stop();
      });
      stream = null;
    }

    video.srcObject = null;
    setOverlay("카메라가 꺼져 있습니다.", true);
    onStatus("스캔 중지됨");
  }

  async function scanLoop() {
    if (!running) return;

    try {
      var codes = await detector.detect(video);
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
      onStatus(error && error.message ? error.message : "QR 스캔 중 오류가 발생했습니다.");
    }

    requestAnimationFrame(scanLoop);
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () {
      return running;
    }
  };
}
