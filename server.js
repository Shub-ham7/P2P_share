// server.js
//
// Signaling server for P2P FileShare.
//
// Responsibility (and ONLY responsibility): let two browsers exchange the
// WebRTC handshake messages they need to find each other — SDP offer/answer
// and ICE candidates. Once the RTCPeerConnection between the two browsers
// is established, this server is completely out of the loop. No file bytes,
// no chunk data, no media ever passes through it or touches disk here.
//
// Rooms are simple 2-peer pairings identified by a room code the two users
// share out of band (a link). A room is closed to new joiners once it has
// two peers.

import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(
    'P2P FileShare signaling server.\n' +
      'This endpoint only relays SDP/ICE handshake messages between peers.\n' +
      'It never sees or stores file data — that travels directly between browsers over WebRTC.\n'
  );
});

const wss = new WebSocketServer({ server });

/** @type {Map<string, Map<string, import('ws').WebSocket>>} room -> (peerId -> ws) */
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'join': {
        const { room } = msg;
        if (!room || typeof room !== 'string') return;

        ws.room = room;
        if (!rooms.has(room)) rooms.set(room, new Map());
        const peers = rooms.get(room);

        if (peers.size >= 2) {
          send(ws, { type: 'room-full' });
          ws.close();
          return;
        }

        const existingPeerIds = [...peers.keys()];
        peers.set(ws.id, ws);

        send(ws, { type: 'joined', peerId: ws.id, peers: existingPeerIds });

        // Let whoever was already in the room know a peer showed up.
        for (const pid of existingPeerIds) {
          send(peers.get(pid), { type: 'peer-joined', peerId: ws.id });
        }
        break;
      }

      case 'signal': {
        // Pure relay: forward the SDP/ICE payload to the named peer only.
        const { room } = ws;
        if (!room || !rooms.has(room)) return;
        const peers = rooms.get(room);
        const target = peers.get(msg.to);
        if (target) {
          send(target, { type: 'signal', from: ws.id, data: msg.data });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) {
      const peers = rooms.get(ws.room);
      peers.delete(ws.id);
      for (const [, peerWs] of peers) {
        send(peerWs, { type: 'peer-left', peerId: ws.id });
      }
      if (peers.size === 0) rooms.delete(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[signaling] listening on :${PORT}`);
  console.log('[signaling] relays SDP/ICE only — file data never passes through this process.');
});
