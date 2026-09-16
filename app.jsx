// app.jsx
//
// React UI. Loaded as a native ES module (transpiled in-browser by Babel
// standalone — see index.html) so the project needs zero build step to run.
// For a production build you'd swap this loading strategy for Vite/webpack
// and keep every other file (webrtc.js, fileWorker.js, etc.) unchanged.

import { PeerSession, assembleBlob } from './webrtc.js';

const { useState, useEffect, useRef, useCallback } = React;

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

/**
 * Best-effort progressive playback via MediaSource Extensions: chunks are
 * appended to a SourceBuffer as they arrive over the DataChannel, so a
 * video/audio file can start playing before the transfer finishes.
 *
 * This only works when the browser recognizes the exact mime type as
 * append-able (container + codec), which we can't always know for an
 * arbitrary uploaded file without a real demuxer. When it's not supported,
 * `streamable` stays false and the UI falls back to "play after transfer
 * completes" using the assembled Blob instead — same file, no loss of
 * functionality, just point at which playback can start.
 */
function useMediaSourceStream(mimeType, active) {
  const videoRef = useRef(null);
  const sbRef = useRef(null);
  const msRef = useRef(null);
  const queueRef = useRef([]);
  const [streamable, setStreamable] = useState(false);

  useEffect(() => {
    if (!active || !mimeType || !window.MediaSource || !MediaSource.isTypeSupported(mimeType)) {
      setStreamable(false);
      return;
    }
    const ms = new MediaSource();
    msRef.current = ms;
    const url = URL.createObjectURL(ms);
    if (videoRef.current) videoRef.current.src = url;

    const onOpen = () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sb.addEventListener('updateend', flush);
        sbRef.current = sb;
        setStreamable(true);
      } catch {
        setStreamable(false);
      }
    };
    ms.addEventListener('sourceopen', onOpen);
    return () => {
      ms.removeEventListener('sourceopen', onOpen);
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
    };
  }, [mimeType, active]);

  function flush() {
    const sb = sbRef.current;
    if (!sb || sb.updating || queueRef.current.length === 0) return;
    try {
      sb.appendBuffer(queueRef.current.shift());
    } catch {
      /* drop silently — fallback path still shows the file once complete */
    }
  }

  const appendChunk = useCallback(
    (buffer) => {
      if (!streamable || !buffer) return;
      queueRef.current.push(buffer);
      flush();
    },
    [streamable]
  );

  const endStream = useCallback(() => {
    const ms = msRef.current;
    if (ms && ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        /* noop */
      }
    }
  }, []);

  return { videoRef, streamable, appendChunk, endStream };
}

function TransferRow({ transfer }) {
  const total = transfer.total || 1;
  const pct = Math.min(100, Math.round((transfer.progress / total) * 100));
  const isMedia = /^(video|audio)\//.test(transfer.mimeType || '');
  const incoming = transfer.direction === 'incoming';

  const { videoRef, streamable, appendChunk, endStream } = useMediaSourceStream(
    transfer.mimeType,
    isMedia && incoming
  );

  useEffect(() => {
    if (transfer.lastChunkBuffer) appendChunk(transfer.lastChunkBuffer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfer.lastChunkBuffer]);

  useEffect(() => {
    if (transfer.status === 'complete') endStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfer.status]);

  return (
    <div className="transfer-row">
      <div className="transfer-info">
        <span className="transfer-name" title={transfer.fileName}>
          {transfer.direction === 'incoming' ? '\u2B07' : '\u2B06'} {transfer.fileName}
        </span>
        <span className="transfer-size">{formatBytes(transfer.size)}</span>
        <span className={`transfer-status status-${transfer.status}`}>{transfer.status}</span>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <span className="progress-label">{pct}%</span>
      </div>

      {isMedia && incoming && (streamable || transfer.status === 'complete') && (
        <video
          ref={videoRef}
          controls
          className="preview"
          src={!streamable && transfer.status === 'complete' ? transfer.blobUrl : undefined}
        />
      )}

      {incoming && transfer.status === 'complete' && transfer.blobUrl && (
        <a className="download-link" href={transfer.blobUrl} download={transfer.fileName}>
          Download {transfer.fileName}
        </a>
      )}
    </div>
  );
}

function App() {
  const [room, setRoom] = useState(
    () => new URLSearchParams(location.search).get('room') || randomRoom()
  );
  const [status, setStatus] = useState('idle');
  const [transfers, setTransfers] = useState({});
  const sessionRef = useRef(null);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
  }, [room]);

  const updateTransfer = (fileId, patch) => {
    setTransfers((prev) => ({ ...prev, [fileId]: { ...(prev[fileId] || {}), ...patch } }));
  };

  const connect = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const signalingUrl = window.SIGNALING_URL || `${scheme}://${location.hostname}:8080`;
    const session = new PeerSession(signalingUrl, room);
    sessionRef.current = session;

    session.addEventListener('connected', () => setStatus('connected'));
    session.addEventListener('peer-left', () => setStatus('peer-left'));
    session.addEventListener('signaling-closed', () =>
      setStatus((s) => (s === 'connected' ? s : 'disconnected'))
    );
    session.addEventListener('error', (e) => console.error('[session]', e.detail));

    session.addEventListener('incoming-file', (e) => {
      const { fileId, fileName, mimeType, size, totalChunks } = e.detail;
      updateTransfer(fileId, {
        fileId,
        fileName,
        mimeType,
        size,
        total: totalChunks,
        progress: 0,
        direction: 'incoming',
        status: 'receiving',
      });
    });

    session.addEventListener('receive-progress', (e) => {
      const { fileId, received, buffer } = e.detail;
      updateTransfer(fileId, { progress: received, lastChunkBuffer: buffer });
    });

    session.addEventListener('receive-complete', async (e) => {
      const { fileId } = e.detail;
      const { blob } = await assembleBlob(fileId);
      const blobUrl = URL.createObjectURL(blob);
      updateTransfer(fileId, { status: 'complete', blobUrl });
    });

    session.addEventListener('send-progress', (e) => {
      const { fileId, index, totalChunks } = e.detail;
      updateTransfer(fileId, { progress: index + 1, total: totalChunks, status: 'sending' });
    });

    session.addEventListener('send-complete', (e) => {
      updateTransfer(e.detail.fileId, { status: 'complete', progress: 1, total: 1 });
    });

    session.connect();
    setStatus('connecting');
  };

  useEffect(() => () => sessionRef.current?.close(), []);

  const onFiles = (fileList) => {
    const session = sessionRef.current;
    if (!session || status !== 'connected') return;
    for (const file of fileList) {
      session.sendFile(file).then((fileId) => {
        updateTransfer(fileId, {
          fileId,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          progress: 0,
          total: Math.ceil(file.size / (16 * 1024)) || 1,
          direction: 'outgoing',
          status: 'sending',
        });
      });
    }
  };

  const shareLink = `${location.origin}${location.pathname}?room=${room}`;

  return (
    <div className="app">
      <header>
        <h1>P2P FileShare</h1>
        <p className="tagline">
          Direct browser-to-browser transfer over WebRTC. Files never touch a server —
          the signaling server only sees a handshake.
        </p>
      </header>

      <section className="room-panel">
        <label>
          Room code
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value.trim())}
            disabled={status !== 'idle'}
          />
        </label>
        <button onClick={connect} disabled={status !== 'idle'}>
          {status === 'idle' ? 'Connect' : status}
        </button>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(shareLink)}
        >
          Copy invite link
        </button>
        <span className={`status-badge status-${status}`}>{status}</span>
      </section>

      <section
        className={`dropzone ${status === 'connected' ? '' : 'dropzone-disabled'}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
      >
        <p>
          {status === 'connected'
            ? 'Drag files here to send, or'
            : 'Connect and wait for a peer to enable sending'}
        </p>
        <input type="file" multiple onChange={(e) => onFiles(e.target.files)} disabled={status !== 'connected'} />
      </section>

      <section className="transfers">
        {Object.values(transfers)
          .sort((a, b) => (a.fileName > b.fileName ? 1 : -1))
          .map((t) => (
            <TransferRow key={t.fileId} transfer={t} />
          ))}
      </section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
