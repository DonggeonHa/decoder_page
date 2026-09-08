import { base64UrlToBytes, MAX_SOURCE_BYTES } from "./protocol.js?v=20260908-300qr-5mb";

export async function gunzipBase64Url(encoded) {
  if (!("DecompressionStream" in window)) {
    throw new Error("GZIP 해제가 지원되지 않습니다. 최신 Chrome에서 열어주세요.");
  }

  var bytes = base64UrlToBytes(encoded);
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  var reader = stream.getReader();
  var chunks = [];
  var length = 0;
  try {
    while (true) {
      var part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_SOURCE_BYTES) {
        throw new Error("Decoded source exceeds " + MAX_SOURCE_BYTES + " bytes.");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(function () {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  var buffer = new Uint8Array(length);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    buffer.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(buffer);
}
