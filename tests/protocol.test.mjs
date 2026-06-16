import test from "node:test";
import assert from "node:assert/strict";
import {
  addMultiChunk,
  assembleMultiGzip,
  createMultiCollector,
  getMissingIndexes,
  parseQrPayload
} from "../protocol.js";

test("parses single RAW payload", () => {
  assert.deepEqual(parseQrPayload("RAW:\nhello"), {
    type: "raw",
    text: "hello"
  });
});

test("RAW payload parsing trims boundary whitespace by contract", () => {
  assert.deepEqual(parseQrPayload("RAW:\n  hello \n"), {
    type: "raw",
    text: "hello"
  });
});

test("parses single GZIP payload", () => {
  assert.deepEqual(parseQrPayload("GZ:\nabc_def-123"), {
    type: "gzip",
    encoded: "abc_def-123"
  });
});

test("parses multi GZQR payload", () => {
  assert.deepEqual(parseQrPayload("GZQR:v1:logA:2:4:chunk-data"), {
    type: "multi-gzip",
    version: "v1",
    id: "logA",
    index: 2,
    total: 4,
    chunk: "chunk-data"
  });
});

test("rejects invalid multi GZQR index", () => {
  assert.equal(parseQrPayload("GZQR:v1:logA:5:4:chunk").type, "invalid");
});

test("collects chunks out of order and assembles GZIP input", () => {
  const collector = createMultiCollector();

  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:2:3:BBB")).complete, false);
  assert.deepEqual(getMissingIndexes(collector), [1, 3]);
  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:1:3:AAA")).complete, false);
  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:3:3:CCC")).complete, true);

  assert.equal(assembleMultiGzip(collector), "GZ:AAABBBCCC");
});

test("rejects chunks from a different group", () => {
  const collector = createMultiCollector();

  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:1:2:AAA")).ok, true);

  const result = addMultiChunk(collector, parseQrPayload("GZQR:v1:logB:2:2:BBB"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /Different QR group/);
});

test("rejects conflicting duplicate index without overwriting the first chunk", () => {
  const collector = createMultiCollector();

  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:1:2:AAA")).ok, true);

  const conflict = addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:1:2:XXX"));
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /Conflicting chunk/);

  assert.equal(addMultiChunk(collector, parseQrPayload("GZQR:v1:logA:2:2:BBB")).complete, true);
  assert.equal(assembleMultiGzip(collector), "GZ:AAABBB");
});
