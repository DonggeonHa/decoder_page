import { base64UrlToBytes } from "./protocol.js";

export async function gunzipBase64Url(encoded) {
  if (!("DecompressionStream" in window)) {
    throw new Error("GZIP 해제가 지원되지 않습니다. 최신 Chrome에서 열어주세요.");
  }

  var bytes = base64UrlToBytes(encoded);
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  var buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8").decode(buffer);
}
