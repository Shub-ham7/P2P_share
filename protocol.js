// protocol.js
//
// RTCDataChannel messages are opaque binary blobs — there's no built-in
// notion of "which file / which chunk index does this belong to". Since a
// single DataChannel is reused for every file in a session (and transfers
// can interleave), each binary message is framed with a tiny header:
//
//   [1 byte fileIdLen] [fileId, utf8] [4 bytes uint32 index, little-endian] [payload]
//
// fileId is a short random id assigned per transfer (see webrtc.js).

export function frameChunk(fileId, index, payload) {
  const idBytes = new TextEncoder().encode(fileId);
  const headerLen = 1 + idBytes.byteLength + 4;
  const header = new ArrayBuffer(headerLen);
  const view = new DataView(header);
  view.setUint8(0, idBytes.byteLength);
  new Uint8Array(header, 1, idBytes.byteLength).set(idBytes);
  view.setUint32(1 + idBytes.byteLength, index, true);

  const payloadBytes = new Uint8Array(payload);
  const out = new Uint8Array(headerLen + payloadBytes.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(payloadBytes, headerLen);
  return out.buffer;
}

export function unframeChunk(buffer) {
  const view = new DataView(buffer);
  const idLen = view.getUint8(0);
  const fileId = new TextDecoder().decode(new Uint8Array(buffer, 1, idLen));
  const index = view.getUint32(1 + idLen, true);
  const payload = buffer.slice(1 + idLen + 4);
  return { fileId, index, payload };
}
