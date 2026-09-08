  static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  static String noise(int length) {
    java.util.Random random = new java.util.Random(91827);
    StringBuilder value = new StringBuilder(length);
    for (int i = 0; i < length; i++) value.append((char) (33 + random.nextInt(94)));
    return value.toString();
  }

  static void fixture(java.io.PrintWriter out, String text) throws Exception {
    List<QrPayload> payloads = buildPayloads(text, "checks");
    out.print(Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)));
    for (QrPayload p : payloads) {
      check(p.byteLength <= GZQR_PAYLOAD_LIMIT, "full payload limit");
      out.print("|" + Base64.getEncoder().encodeToString(p.text.getBytes(StandardCharsets.UTF_8)));
    }
    out.println();
  }

  static int harderScans = 0;
  static void rendered(String payload) throws Exception {
    byte[] bytes = Base64.getDecoder().decode(createQrPngBase64(payload, 420));
    BufferedImage image = ImageIO.read(new java.io.ByteArrayInputStream(bytes));
    check(image.getWidth() == 420 && image.getHeight() == 420, "image dimensions");
    Map<EncodeHintType, Object> hints = new HashMap<EncodeHintType, Object>();
    hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
    hints.put(EncodeHintType.MARGIN, Integer.valueOf(4));
    BitMatrix expected = new QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 420, 420, hints);
    for (int y = 0; y < 420; y++) for (int x = 0; x < 420; x++) {
      check((image.getRGB(x, y) & 0xffffff) == (expected.get(x, y) ? 0 : 0xffffff), "PNG pixel differs from ZXing matrix");
    }
    com.google.zxing.BinaryBitmap bitmap = new com.google.zxing.BinaryBitmap(
        new com.google.zxing.common.HybridBinarizer(
            new com.google.zxing.client.j2se.BufferedImageLuminanceSource(image)));
    String decoded;
    try {
      decoded = new com.google.zxing.qrcode.QRCodeReader().decode(bitmap).getText();
    } catch (com.google.zxing.ReaderException failure) {
      BufferedImage legacy = ImageIO.read(new java.io.ByteArrayInputStream(Base64.getDecoder().decode(createBaselineQr(payload, 420))));
      for (int y = 0; y < 420; y++) for (int x = 0; x < 420; x++) {
        check(image.getRGB(x, y) == legacy.getRGB(x, y), "default finder regression versus baseline pixels");
      }
      Map<com.google.zxing.DecodeHintType, Object> readHints = new HashMap<com.google.zxing.DecodeHintType, Object>();
      // The pixel-level check above verifies our PNG encoder. This fallback tests
      // QR data decoding at a known location, not camera/finder detection quality.
      readHints.put(com.google.zxing.DecodeHintType.PURE_BARCODE, Boolean.TRUE);
      decoded = new com.google.zxing.qrcode.QRCodeReader().decode(bitmap, readHints).getText();
      harderScans++;
    }
    check(payload.equals(decoded), "PNG -> QR reader must preserve payload: " + payload.substring(0, Math.min(55, payload.length())));
  }

  public static void main(String[] args) throws Exception {
    List<QrPayload> large = buildPayloads(noise(60000), "large");
    check(large.size() > 50 && large.size() <= 300, "60000 noisy chars must work above 50 QR frames");
    check("&lt;&gt;&amp;&quot;&#x27;".equals(escapeHtml("<>&\"'")), "escaping");
    check(buildPayloads(" \r\n\t", "blank").isEmpty(), "blank input");
    check("RAW".equals(buildPayloads(noise(800), "raw").get(0).mode), "800 byte RAW boundary");
    check(!"RAW".equals(buildPayloads(noise(801), "gz").get(0).mode), "801 byte boundary");
    String sized = noise(360000);
    int low = 60000, high = sized.length();
    String exactly300 = null;
    while (low <= high) {
      int middle = (low + high) / 2;
      try {
        List<QrPayload> result = buildPayloads(sized.substring(0, middle), "boundary");
        if (result.size() == 300) { exactly300 = sized.substring(0, middle); break; }
        low = middle + 1;
      } catch (IllegalArgumentException expected) { high = middle - 1; }
    }
    check(exactly300 != null, "exactly 300 frames accepted");
    try { buildPayloads(sized, "over"); throw new AssertionError("301+ frames must reject"); }
    catch (IllegalArgumentException expected) {
      check(expected.getMessage().contains("Required QR count"), "error must report required count");
    }
    char[] oversized = new char[5000001];
    java.util.Arrays.fill(oversized, 'x');
    try { buildPayloads(new String(oversized)); throw new AssertionError("source limit"); }
    catch (IllegalArgumentException expected) { check(expected.getMessage().contains("source"), "source error"); }
    try (java.io.PrintWriter out = new java.io.PrintWriter(new java.io.File(args[0], "fixtures.txt"), "UTF-8")) {
      fixture(out, "short 한글 로그 <>&");
      fixture(out, "  한글 로그\r\n끝\t\n");
      fixture(out, "\uFEFFBOM과 한글\r\n끝\n");
      fixture(out, noise(60000));
      fixture(out, exactly300);
    }
    rendered("RAW:\nshort 한글 로그");
    rendered(buildPayloads("  한글 로그\n").get(0).text);
    List<QrPayload> all = buildPayloads(exactly300, "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    for (QrPayload payload : all) rendered(payload.text);
    System.out.println("Java 8: source/RAW/300-frame boundaries, escaping, 302 PNG pixel/data checks passed. Default finder misses requiring PURE_BARCODE: " + harderScans + " (pixels identical to baseline).");
  }
