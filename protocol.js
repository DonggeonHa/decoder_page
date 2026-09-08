export var SINGLE_RAW_PREFIX = "RAW:";
export var SINGLE_GZIP_PREFIX = "GZ:";
export var MULTI_PREFIX = "GZQR:";
export var MAX_QR_COUNT = 300;
export var MAX_SOURCE_BYTES = 5000000;

export function stripSinglePrefix(value, prefix) {
  return value.slice(prefix.length).replace(/^\s+/, "");
}

export function parseQrPayload(value) {
  var raw = String(value || "").trim();

  if (!raw) {
    return { type: "empty" };
  }

  if (raw.indexOf(MULTI_PREFIX) === 0) {
    return parseMultiPayload(raw);
  }

  if (raw.indexOf(SINGLE_RAW_PREFIX) === 0) {
    return {
      type: "raw",
      text: stripSinglePrefix(raw, SINGLE_RAW_PREFIX)
    };
  }

  if (raw.indexOf(SINGLE_GZIP_PREFIX) === 0) {
    return {
      type: "gzip",
      encoded: stripSinglePrefix(raw, SINGLE_GZIP_PREFIX)
    };
  }

  return {
    type: "plain",
    text: raw
  };
}

export function parseMultiPayload(raw) {
  var parts = raw.split(":");
  if (parts.length < 6) {
    return {
      type: "invalid",
      reason: "GZQR format must be GZQR:v1:<id>:<index>:<total>:<chunk>."
    };
  }

  var version = parts[1];
  var id = parts[2];
  var index = Number(parts[3]);
  var total = Number(parts[4]);
  var chunk = parts.slice(5).join(":").replace(/\s+/g, "");

  if (version !== "v1") {
    return { type: "invalid", reason: "Unsupported GZQR version: " + version };
  }

  if (!id) {
    return { type: "invalid", reason: "GZQR id is empty." };
  }

  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    return { type: "invalid", reason: "GZQR index/total is invalid." };
  }

  if (total > MAX_QR_COUNT) {
    return { type: "invalid", reason: "Maximum QR count is " + MAX_QR_COUNT + "." };
  }

  if (!chunk) {
    return { type: "invalid", reason: "GZQR chunk is empty." };
  }

  return {
    type: "multi-gzip",
    version: version,
    id: id,
    index: index,
    total: total,
    chunk: chunk
  };
}

export function createMultiCollector() {
  return {
    id: "",
    total: 0,
    chunks: Object.create(null)
  };
}

export function addMultiChunk(collector, payload) {
  if (!collector || !payload || payload.type !== "multi-gzip") {
    return { ok: false, reason: "Invalid multi QR payload." };
  }

  if (!collector.id) {
    collector.id = payload.id;
    collector.total = payload.total;
  }

  if (collector.id !== payload.id) {
    return {
      ok: false,
      reason: "Different QR group. Expected " + collector.id + " but got " + payload.id + "."
    };
  }

  if (collector.total !== payload.total) {
    return {
      ok: false,
      reason: "Total count mismatch for QR group " + collector.id + "."
    };
  }

  if (collector.chunks[payload.index] && collector.chunks[payload.index] !== payload.chunk) {
    return {
      ok: false,
      reason: "Conflicting chunk for QR index " + payload.index + ". Reset multi QR and scan the same group again."
    };
  }

  var duplicate = collector.chunks[payload.index] === payload.chunk;
  collector.chunks[payload.index] = payload.chunk;

  return {
    ok: true,
    duplicate: duplicate,
    complete: isCollectorComplete(collector),
    received: getReceivedIndexes(collector),
    missing: getMissingIndexes(collector)
  };
}

export function isCollectorComplete(collector) {
  if (!collector || !collector.total) return false;

  for (var i = 1; i <= collector.total; i += 1) {
    if (!collector.chunks[i]) return false;
  }

  return true;
}

export function getReceivedIndexes(collector) {
  if (!collector || !collector.total) return [];

  var indexes = [];
  for (var i = 1; i <= collector.total; i += 1) {
    if (collector.chunks[i]) indexes.push(i);
  }

  return indexes;
}

export function getMissingIndexes(collector) {
  if (!collector || !collector.total) return [];

  var indexes = [];
  for (var i = 1; i <= collector.total; i += 1) {
    if (!collector.chunks[i]) indexes.push(i);
  }

  return indexes;
}

export function assembleMultiGzip(collector) {
  if (!isCollectorComplete(collector)) {
    throw new Error("Cannot assemble incomplete GZQR group.");
  }

  var combined = "";
  for (var i = 1; i <= collector.total; i += 1) {
    combined += collector.chunks[i];
  }

  return SINGLE_GZIP_PREFIX + combined;
}

export function base64UrlToBytes(value) {
  var compact = String(value || "").replace(/\s+/g, "");
  var normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  var paddingLength = (4 - (normalized.length % 4)) % 4;
  var padded = normalized + Array(paddingLength + 1).join("=");
  var binary = atob(padded);
  var bytes = new Uint8Array(binary.length);

  for (var i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
