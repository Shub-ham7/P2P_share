// idb.js
//
// Minimal IndexedDB wrapper. This is the piece that gets us around the
// "browser memory restriction" half of the core problem: instead of
// buffering an entire incoming file in a JS array/Blob in RAM, every
// decrypted chunk is written straight to IndexedDB as it arrives. A
// multi-gigabyte transfer never needs more than one chunk resident in
// memory at a time on either side.
//
// Runs fine inside a Web Worker (IndexedDB is available in worker scope),
// which is where this module is actually used from — see fileWorker.js.

const DB_NAME = 'p2p-fileshare';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';
const META_STORE = 'files';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: ['fileId', 'index'] });
        store.createIndex('byFile', 'fileId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'fileId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putChunk(fileId, index, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).put({ fileId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putMeta(meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(fileId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(fileId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Reads every chunk for a file back out in index order, for final assembly. */
export async function getAllChunksOrdered(fileId, totalChunks) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const index = tx.objectStore(CHUNK_STORE).index('byFile');
    const range = IDBKeyRange.only(fileId);
    const results = new Array(totalChunks);
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results[cursor.value.index] = cursor.value.data;
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(fileId, totalChunks) {
  const db = await openDB();
  const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNK_STORE);
  for (let i = 0; i < totalChunks; i++) chunkStore.delete([fileId, i]);
  tx.objectStore(META_STORE).delete(fileId);
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
  });
}
