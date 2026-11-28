"use strict";

/**
 * Minimal protobuf wire reader — just enough to decode the Antigravity
 * conversation blobs. Malformed input ends the enumeration instead of
 * throwing, so a torn row never breaks the whole conversation.
 */
function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length && shift < 64n) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return { value, next: i };
    shift += 7n;
  }
  return null;
}

/** Iterate { number, wire, value?, data? } over a protobuf message. */
function* protoFields(buf) {
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return;
    i = key.next;
    const number = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return;
      i = v.next;
      yield { number, wire, value: v.value };
    } else if (wire === 2) {
      const size = readVarint(buf, i);
      if (!size) return;
      i = size.next;
      const len = Number(size.value);
      if (len > buf.length - i) return;
      yield { number, wire, data: buf.subarray(i, i + len) };
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      return;
    }
  }
}

function firstField(buf, number, wire) {
  for (const f of protoFields(buf)) {
    if (f.number === number && f.wire === wire) return f;
  }
  return null;
}

function varintField(buf, number) {
  const f = firstField(buf, number, 0);
  return f ? f.value : null;
}

function dataField(buf, number) {
  const f = firstField(buf, number, 2);
  return f ? f.data : null;
}

/** google.protobuf.Timestamp inside a wrapper field → epoch milliseconds. */
function timestampMs(buf) {
  const sec = varintField(buf, 1);
  if (sec == null) return 0;
  const ms = Number(sec) * 1000;
  return Number.isFinite(ms) ? ms : 0;
}

/** google.protobuf.Duration inside a wrapper field → milliseconds. */
function durationMs(buf) {
  const sec = varintField(buf, 1);
  const nanos = varintField(buf, 2);
  if (sec == null && nanos == null) return null;
  const s = sec == null ? 0n : BigInt(sec);
  const n = nanos == null ? 0n : BigInt(nanos);
  const ms = Number(s * 1000n + n / 1_000_000n);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

module.exports = { protoFields, firstField, varintField, dataField, timestampMs, durationMs };
