// webrtc.js
//
// Ties everything together: WebSocket signaling to find a peer and swap
// SDP/ICE, an RTCPeerConnection configured with STUN (and optionally TURN)
// for NAT traversal, and two DataChannels — one for small JSON control
// messages, one for binary file chunks.
//
// Backpressure: RTCDataChannel.send() will happily let you queue
// gigabytes into `bufferedAmount` if you call it in a tight loop, which
// defeats the whole point of chunking (you'd just move the memory problem
// from "one big file" to "one big send buffer"). Instead we track
// `bufferedAmount`, stop asking the worker for more chunks once it passes
// a high-water mark, and resume via the `bufferedamountlow` event once the
// channel has drained below a low-water mark. This keeps memory bounded on
// the sending side the same way IndexedDB keeps it bounded on the
// receiving side.

import { frameChunk, unframeChunk } from './protocol.js';
import { generateKey, exportKey, importKey } from './crypto.js';
import { getMeta, getAllChunksOrdered, deleteFile } from './idb.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // TURN relay — required as a fallback for peers behind symmetric NAT or
  // restrictive corporate firewalls, where a direct STUN-discovered path is
  // impossible and traffic must be relayed. Plug in your own TURN server
  // (e.g. self-hosted coturn, or a managed provider) here:
  // {
  //   urls: 'turn:your-turn-server.example.com:3478',
  //   username: 'YOUR_USERNAME',
  //   credential: 'YOUR_CREDENTIAL',
  // },
];

const HIGH_WATER_MARK = 1024 * 1024; // pause requesting new chunks above 1MB buffered
const LOW_WATER_MARK = 256 * 1024; // resume once buffered drains below 256KB
const CHUNK_SIZE = 16 * 1024;

export class PeerSession extends EventTarget {
  constructor(signalingUrl, room) {
    super();
    this.signalingUrl = signalingUrl;
    this.room = room;
    this.peerId = null;
    this.remotePeerId = null;
    this.pc = null;
    this.controlChannel = null;
    this.fileChannel = null;
    this.ws = null;
    this.key = null; // AES-GCM CryptoKey shared over the DataChannel post-handshake

    this.worker = new Worker(new URL('./fileWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorkerMessage(e.data);

    this.outgoing = new Map(); // fileId -> { file, totalChunks, nextIndex, awaitingWorker }
    this.incoming = new Map(); // fileId -> { totalChunks, receivedCount, fileName, mimeType, size }
  }

  connect() {
    this.ws = new WebSocket(this.signalingUrl);
    this.ws.onmessage = (e) => this._onSignal(JSON.parse(e.data));
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'join', room: this.room }));
    this.ws.onclose = () => this._emit('signaling-closed');
    this.ws.onerror = () => this._emit('error', { message: 'Signaling connection failed.' });
  }

  async _onSignal(msg) {
    switch (msg.type) {
      case 'joined':
        this.peerId = msg.peerId;
        if (msg.peers.length > 0) {
          this.remotePeerId = msg.peers[0];
          await this._createPeerConnection(true);
        }
        break;
      case 'peer-joined':
        this.remotePeerId = msg.peerId;
        await this._createPeerConnection(false);
        break;
      case 'signal':
        await this._handleRTCSignal(msg.data);
        break;
      case 'peer-left':
        this._emit('peer-left');
        break;
      case 'room-full':
        this._emit('error', { message: 'This room already has two peers.' });
        break;
      default:
        break;
    }
  }

  async _createPeerConnection(isInitiator) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this._sendSignal({ candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      this._emit('connection-state', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') this._emit('connected');
    };

    if (isInitiator) {
      this.key = await generateKey();
      this.controlChannel = this.pc.createDataChannel('control', { ordered: true });
      this.fileChannel = this.pc.createDataChannel('file', { ordered: true });
      this._wireChannels();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this._sendSignal({ sdp: this.pc.localDescription });
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === 'control') this.controlChannel = e.channel;
        if (e.channel.label === 'file') this.fileChannel = e.channel;
        this._wireChannels();
      };
    }
  }

  async _handleRTCSignal(data) {
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignal({ sdp: this.pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch {
        // benign: candidates can arrive after the connection is already up
      }
    }
  }

  _sendSignal(data) {
    this.ws.send(JSON.stringify({ type: 'signal', to: this.remotePeerId, data }));
  }

  _wireChannels() {
    if (!this.controlChannel || !this.fileChannel) return;

    this.controlChannel.onopen = () => this._maybeShareKey();
    this.controlChannel.onmessage = (e) => this._onControlMessage(JSON.parse(e.data));

    this.fileChannel.binaryType = 'arraybuffer';
    this.fileChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    this.fileChannel.onmessage = (e) => this._onFileChunk(e.data);
    this.fileChannel.onbufferedamountlow = () => this._pumpAllSenders();
  }

  async _maybeShareKey() {
    if (this.key) {
      const exported = await exportKey(this.key);
      this._sendControl({ type: 'key-exchange', key: exported });
    }
  }

  _sendControl(obj) {
    if (this.controlChannel?.readyState === 'open') this.controlChannel.send(JSON.stringify(obj));
  }

  async _onControlMessage(msg) {
    switch (msg.type) {
      case 'key-exchange':
        this.key = await importKey(msg.key);
        break;
      case 'file-offer':
        this.incoming.set(msg.fileId, {
          totalChunks: msg.totalChunks,
          receivedCount: 0,
          fileName: msg.fileName,
          mimeType: msg.mimeType,
          size: msg.size,
        });
        this._emit('incoming-file', msg);
        break;
      default:
        break;
    }
  }

  // ---------------- SENDING ----------------

  async sendFile(file) {
    const fileId = crypto.randomUUID().slice(0, 8);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;

    this._sendControl({
      type: 'file-offer',
      fileId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      totalChunks,
    });

    this.outgoing.set(fileId, { file, totalChunks, nextIndex: 0, awaitingWorker: false });
    this._pumpSender(fileId);
    return fileId;
  }

  _pumpAllSenders() {
    for (const fileId of this.outgoing.keys()) this._pumpSender(fileId);
  }

  _pumpSender(fileId) {
    const state = this.outgoing.get(fileId);
    if (!state) return;
    if (state.awaitingWorker) return;
    if (state.nextIndex >= state.totalChunks) return;
    if (this.fileChannel.bufferedAmount > HIGH_WATER_MARK) return; // backpressure

    state.awaitingWorker = true;
    this.worker.postMessage({
      type: 'send-file',
      fileId,
      file: state.file,
      key: this.key,
      requestedIndex: state.nextIndex,
    });
  }

  // ---------------- RECEIVING ----------------

  _onFileChunk(buffer) {
    const { fileId, index, payload } = unframeChunk(buffer);
    const state = this.incoming.get(fileId);
    const stream = !!(state && /^(video|audio)\//.test(state.mimeType));
    this.worker.postMessage(
      { type: 'receive-chunk', fileId, index, buffer: payload, key: this.key, stream },
      [payload]
    );
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'chunk-ready': {
        const state = this.outgoing.get(msg.fileId);
        if (!state) return;
        state.awaitingWorker = false;
        const framed = frameChunk(msg.fileId, msg.index, msg.buffer);
        this.fileChannel.send(framed);
        state.nextIndex += 1;
        this._emit('send-progress', {
          fileId: msg.fileId,
          index: msg.index,
          totalChunks: state.totalChunks,
        });
        this._pumpSender(msg.fileId);
        break;
      }
      case 'send-complete':
        this.outgoing.delete(msg.fileId);
        this._emit('send-complete', { fileId: msg.fileId });
        break;
      case 'chunk-stored': {
        const state = this.incoming.get(msg.fileId);
        if (!state) return;
        state.receivedCount += 1;
        this._emit('receive-progress', {
          fileId: msg.fileId,
          received: state.receivedCount,
          total: state.totalChunks,
          buffer: msg.buffer,
        });
        if (state.receivedCount === state.totalChunks) {
          this.worker.postMessage({
            type: 'finalize-receive',
            fileId: msg.fileId,
            totalChunks: state.totalChunks,
            fileName: state.fileName,
            mimeType: state.mimeType,
            size: state.size,
          });
        }
        break;
      }
      case 'file-complete':
        this._emit('receive-complete', { fileId: msg.fileId });
        break;
      case 'error':
        this._emit('error', msg);
        break;
      default:
        break;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  close() {
    this.controlChannel?.close();
    this.fileChannel?.close();
    this.pc?.close();
    this.ws?.close();
    this.worker.terminate();
  }
}

/** Reads a completed file back out of IndexedDB as a single Blob (for download / non-streamed preview). */
export async function assembleBlob(fileId) {
  const meta = await getMeta(fileId);
  if (!meta) throw new Error('File metadata not found');
  const chunks = await getAllChunksOrdered(fileId, meta.totalChunks);
  return { blob: new Blob(chunks, { type: meta.mimeType }), meta };
}

export { deleteFile };
