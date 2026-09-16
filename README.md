# P2P FileShare

A browser-based, direct peer-to-peer file-sharing and media-streaming tool.
Files travel straight from one browser to another over a WebRTC
DataChannel — a signaling server helps the two browsers *find* each other,
then gets out of the way entirely. No file, of any size, is ever stored on
or passed through a server.

```
┌────────────┐   SDP / ICE only    ┌────────────┐
│  Browser A │ ◄─────────────────► │  Browser B │
└─────┬──────┘   (via signaling)   └─────┬──────┘
      │ 1. join room                     │ 1. join room
      │ 2. exchange offer/answer         │ 2. exchange offer/answer
      │ 3. exchange ICE candidates       │ 3. exchange ICE candidates
      └──────────────┬────────────────────┘
                      │
             Node.js WebSocket
             signaling server
             (relays handshake
              messages only)

Once connected:

┌────────────┐   RTCDataChannel, encrypted chunks   ┌────────────┐
│  Browser A │ ═══════════════════════════════════► │  Browser B │
│ Web Worker │        (direct, or via TURN relay     │ Web Worker │
│  chunks +  │         if a direct path is           │ decrypts + │
│  encrypts  │         impossible)                   │ writes to  │
│  the file  │                                       │ IndexedDB  │
└────────────┘                                       └────────────┘
```

## Core problem this solves

1. **File-size upload limits** — there's no upload at all. The file never
   goes to a server, so there's no server-side size cap, no storage cost,
   and no upload-then-download round trip.
2. **Browser memory restrictions** — a naive implementation reads the whole
   file into memory (or into one giant `ArrayBuffer`/`Blob` on the receiving
   side) and would fall over on anything beyond a few hundred MB. This
   project never holds more than one chunk (16KB) in JS memory at a time on
   *either* side:
   - **Sender**: a Web Worker reads the file with `File.slice()` one 16KB
     window at a time, encrypts it, and hands it to the main thread only
     when the DataChannel's send buffer has room (backpressure — see
     below). It never loads the file into a single buffer.
   - **Receiver**: each incoming chunk is decrypted and written straight to
     IndexedDB inside a Web Worker, then discarded. The full file is only
     ever materialized as a `Blob` at the very end, by reading the chunks
     back out of IndexedDB (`assembleBlob` in `webrtc.js`) — and even that
     step is optional; large files can be left in IndexedDB and streamed
     out on demand instead.
3. **NAT traversal** — see below.

## Architecture & stack

| Layer | Tech | File(s) |
|---|---|---|
| UI | React 18 (loaded via CDN, Babel standalone — zero build step) | `client/app.jsx` |
| Chunking / reassembly | Web Workers + Web Streams-style slicing, writing into IndexedDB | `client/fileWorker.js`, `client/idb.js` |
| Framing | Custom binary header per DataChannel message (`fileId` + chunk index) | `client/protocol.js` |
| Encryption | WebCrypto `AES-GCM`, per-chunk IV, key exchanged over the DataChannel | `client/crypto.js` |
| P2P transport | `RTCPeerConnection` + `RTCDataChannel`, STUN/TURN | `client/webrtc.js` |
| Signaling | Node.js `ws` WebSocket server — SDP/ICE relay only | `server/server.js` |

## NAT traversal, explained

Almost every real device sits behind a NAT (home router, carrier-grade NAT,
corporate firewall), so two browsers can't normally open a direct
connection to each other's private IP:

- **STUN** (`stun.l.google.com:19302` here) asks a public server "what does
  my traffic look like from the outside?" — it returns the caller's public
  IP:port. Both peers exchange these as ICE candidates via the signaling
  server, and if their NATs are "well-behaved" (full-cone / restricted
  cone), the browsers can open a direct UDP path straight to each other.
  This is the common case and it's free — no relay bandwidth cost.
- **TURN** is the fallback for when that's not possible — e.g. **symmetric
  NAT**, where the NAT maps a different external port for every
  destination, so the STUN-discovered address is useless for a
  peer-to-peer connection. TURN is a relay server both peers connect to;
  it forwards encrypted packets between them. It costs relay bandwidth
  (unlike STUN, which is a one-time lookup), which is why WebRTC always
  tries the direct/STUN path first and only falls back to TURN when ICE
  connectivity checks fail. A TURN server config slot is left in
  `client/webrtc.js` (`ICE_SERVERS`) — point it at a self-hosted
  [coturn](https://github.com/coturn/coturn) instance or a managed
  provider to make transfers reliable across restrictive networks.

## Backpressure (why the transfer doesn't just OOM the tab)

`RTCDataChannel.send()` will accept data faster than the network can drain
it — calling it in a tight loop just grows `bufferedAmount` without bound,
silently turning your "chunked" transfer back into "the whole file in
memory," just one layer down. `webrtc.js` tracks this explicitly:

- Stop asking the worker for the next chunk once `bufferedAmount` exceeds a
  high-water mark (1MB).
- Resume via the native `bufferedamountlow` event once it drains below a
  low-water mark (256KB), using `bufferedAmountLowThreshold`.

This keeps memory flat on the sending side regardless of whether the file
is 10MB or 10GB, and lets multiple files send concurrently without one
starving the others.

## End-to-end encryption

WebRTC DataChannels are already encrypted in transit via mandatory DTLS —
that's part of the spec, not something this project adds. On top of that,
this project generates a fresh AES-GCM key per session and encrypts every
chunk at the application layer before it ever reaches the DataChannel. The
key is exchanged only after the DataChannel is open — it never touches the
signaling server. The reasoning (good viva material):

- It's defense-in-depth: if a TURN relay is in the path, DTLS is
  terminated *at* the relay (the relay is a legitimate participant in the
  DTLS session), so the relay operator could in principle see plaintext.
  The application-layer AES-GCM envelope means a TURN relay only ever
  handles ciphertext it cannot read.
- It keeps the trust boundary in this app's own code rather than fully
  outsourcing confidentiality to the browser's WebRTC stack and whichever
  TURN provider is configured.

## Live media preview while transferring

For incoming files with a `video/*` or `audio/*` mime type, the UI attempts
progressive playback via **MediaSource Extensions**: as chunks arrive
(already in order, since the DataChannel is configured `ordered: true`),
they're appended straight to a `SourceBuffer` so playback can start before
the transfer finishes. This only works when the browser recognizes the
exact container/codec as appendable, which isn't guaranteed for an
arbitrary uploaded file without a full demuxer — when it's not supported,
the UI cleanly falls back to "play once the transfer completes," using the
Blob assembled from IndexedDB. Same file either way; only the moment
playback can start differs.

## Running it

Requires Node.js (server) and any modern browser (client) — no build
tooling needed for the client.

```bash
# 1. Start the signaling server
cd server
npm install
npm start          # listens on :8080

# 2. Serve the client (any static file server works; ES modules need http(s), not file://)
cd ../client
npx serve -l 5173 .
# or: python3 -m http.server 5173

# 3. Open two browser tabs / two devices on the same network
open http://localhost:5173
```

Both tabs will land on the same room code automatically if you open the
same link (the "Copy invite link" button puts `?room=<code>` in your
clipboard — send that to the other person). Click **Connect** in both
tabs, wait for the status badge to say `connected`, then drag a file into
either tab.

To test across two different networks (not just two tabs on localhost),
deploy `server/` somewhere reachable (Render, Railway, a small VPS, etc.),
point `client`'s `window.SIGNALING_URL` at it, and add TURN credentials to
`ICE_SERVERS` in `client/webrtc.js` — plain STUN is often not enough once
real-world NATs and firewalls are involved.

## Known limitations / next steps

- Rooms are capped at 2 peers (simplest correct implementation of 1:1
  transfer); extending to N-peer mesh or an SFU-style fan-out is a natural
  next step for group sharing.
- No resumable transfers across a page reload yet — the chunk index
  written to IndexedDB *could* support resuming a dropped transfer
  (metadata + partial chunk set already persist), but the UI doesn't wire
  that up yet.
- Progressive MSE playback depends on codec/container support in the
  browser and isn't guaranteed for every file — see above.
- The demo client loads React from a CDN for a zero-build setup; a real
  deployment would bundle it.
