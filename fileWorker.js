// fileWorker.js
//
// Runs off the main thread so that reading, encrypting, decrypting, and
// persisting file chunks never blocks the UI — this is the "Web Workers
// for chunking/reassembling files in IndexedDB" piece of the spec.
//
// Both sending and receiving are *pull-based*, one chunk at a time:
//   - SEND: the main thread only asks this worker for the next chunk once
//     the DataChannel's send buffer has drained below the backpressure
//     threshold (see webrtc.js). So at most one encrypted chunk exists
//     outside of the source File at any moment.
//   - RECEIVE: each incoming chunk is decrypted and written directly to
//     IndexedDB, then dropped. Nothing accumulates in memory as the
//     transfer progresses — this is what makes multi-GB transfers survive
//     "browser memory restrictions" instead of blowing the tab's heap.

import { encryptChunk, decryptChunk } from './crypto.js';
import { putChunk, putMeta } from './idb.js';

const CHUNK_SIZE = 16 * 1024; // 16KB — safe, broadly interoperable RTCDataChannel message size

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'send-file') {
      await handleSend(msg);
    } else if (msg.type === 'receive-chunk') {
      await handleReceive(msg);
    } else if (msg.type === 'finalize-receive') {
      await handleFinalize(msg);
    }
  } catch (err) {
    self.postMessage({ type: 'error', fileId: msg.fileId, message: err.message });
  }
};

async function handleSend({ fileId, file, key, requestedIndex }) {
  const start = requestedIndex * CHUNK_SIZE;
  if (start >= file.size) {
    self.postMessage({ type: 'send-complete', fileId });
    return;
  }
  const end = Math.min(start + CHUNK_SIZE, file.size);
  const raw = await file.slice(start, end).arrayBuffer();
  const encrypted = await encryptChunk(key, raw);
  self.postMessage(
    { type: 'chunk-ready', fileId, index: requestedIndex, buffer: encrypted },
    [encrypted]
  );
}

async function handleReceive({ fileId, index, buffer, key, stream }) {
  const decrypted = await decryptChunk(key, buffer);
  await putChunk(fileId, index, decrypted);

  if (stream) {
    // Only for recognized audio/video mime types (see webrtc.js) do we also
    // hand the raw decrypted bytes back to the main thread, so a
    // MediaSource player can start playback before the transfer finishes.
    // For everything else we deliberately do NOT echo the bytes back, to
    // keep memory flat regardless of file size.
    self.postMessage({ type: 'chunk-stored', fileId, index, buffer: decrypted }, [decrypted]);
  } else {
    self.postMessage({ type: 'chunk-stored', fileId, index });
  }
}

async function handleFinalize({ fileId, totalChunks, fileName, mimeType, size }) {
  await putMeta({ fileId, totalChunks, fileName, mimeType, size, complete: true });
  self.postMessage({ type: 'file-complete', fileId });
}
