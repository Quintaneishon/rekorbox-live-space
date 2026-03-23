/**
 * rekordbox-live — server.js
 *
 * Express HTTP + WebSocket server.
 *  - Loads embeddings from Python backend once at startup
 *  - Listens to Rekordbox via Pro DJ Link
 *  - Broadcasts track events to all connected WebSocket clients
 *
 * WebSocket messages sent to clients:
 *   { type: 'init',         points: [...] }
 *   { type: 'track_change', title, idx, point, playing }
 *   { type: 'play_state',   playing, title, idx, point }
 *   { type: 'error',        message }
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadEmbeddings, getPoints, matchTitle } from './embeddings.js';
import { startProlinkListener } from './prolink.js';

const PORT             = parseInt(process.env.PORT || '3001', 10);
const PYTHON_BACKEND   = process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:5000';
const MODEL            = process.env.MODEL   || 'mert';
const DATASET          = process.env.DATASET || '95m';

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/points', (_req, res) => {
  const pts = getPoints();
  if (pts.length === 0) return res.status(503).json({ error: 'Embeddings not loaded yet' });
  res.json({ points: pts });
});

// Proxy /graph and /tags from Python backend so the frontend only needs this server
app.get('/graph', async (req, res) => {
  try {
    const { red = MODEL, dataset = DATASET, k } = req.query;
    const url = `${PYTHON_BACKEND}/graph?red=${red}&dataset=${dataset}${k ? `&k=${k}` : ''}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/tags', async (_req, res) => {
  try {
    const r = await fetch(`${PYTHON_BACKEND}/tags`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Manual track trigger — useful when running on the same machine as Rekordbox
// POST /track  { title: string, playing: bool }
// POST /play   { playing: bool }
let lastManualTitle = '';
app.post('/track', (req, res) => {
  const { title = '', playing = true } = req.body;
  lastManualTitle = title;
  const match = matchTitle(title);
  broadcast({
    type:    'track_change',
    title,
    playing: !!playing,
    idx:     match ? match.idx   : null,
    point:   match ? match.point : null,
    score:   match ? match.score : null,
  });
  const found = match ? `matched idx=${match.idx} (score=${match.score.toFixed(2)})` : 'no match';
  console.log(`[manual] track_change "${title}" playing=${playing} — ${found}`);
  res.json({ ok: true, found: !!match, idx: match?.idx ?? null });
});

app.post('/play', (req, res) => {
  const { playing = true } = req.body;
  const match = lastManualTitle ? matchTitle(lastManualTitle) : null;
  broadcast({
    type:    'play_state',
    playing: !!playing,
    title:   lastManualTitle,
    idx:     match ? match.idx   : null,
    point:   match ? match.point : null,
  });
  console.log(`[manual] play_state playing=${playing} "${lastManualTitle}"`);
  res.json({ ok: true });
});

// ─── HTTP + WebSocket on the same port ───────────────────────────────────────
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws, req) => {
  console.log(`[ws] Client connected (${req.socket.remoteAddress})`);

  // Send current embedding points immediately on connect
  const pts = getPoints();
  if (pts.length > 0) {
    ws.send(JSON.stringify({ type: 'init', points: pts }));
  }

  ws.on('close', () => console.log('[ws] Client disconnected'));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Load embeddings from Python backend
  try {
    await loadEmbeddings(PYTHON_BACKEND, MODEL, DATASET);
  } catch (err) {
    console.error('[boot] Failed to load embeddings:', err.message);
    console.error('       Make sure the Python backend is running and .env is correct.');
    process.exit(1);
  }

  // 2. Start HTTP + WS server
  httpServer.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    console.log(`[server] WebSocket on ws://localhost:${PORT}`);
  });

  // 3. Connect to Rekordbox via Pro DJ Link
  try {
    await startProlinkListener({
      // Fired when any deck loads/changes track OR MixstatusProcessor says it's on-air
      onNowPlaying(title, playerNum, playing) {
        const match = matchTitle(title);
        const log = match
          ? `idx=${match.idx} score=${match.score.toFixed(2)}`
          : 'no match';
        console.log(`[prolink→ws] deck${playerNum} now-playing "${title}" — ${log}`);
        broadcast({
          type:       'track_change',
          title,
          playing:    !!playing,
          playerNum:  playerNum ?? null,
          idx:        match ? match.idx   : null,
          point:      match ? match.point : null,
          score:      match ? match.score : null,
        });
      },

      // Fired when on-air deck pauses/resumes without a track change
      onPlayState(playing, title, playerNum) {
        const match = title ? matchTitle(title) : null;
        broadcast({
          type:      'play_state',
          playing:   !!playing,
          title,
          playerNum: playerNum ?? null,
          idx:       match ? match.idx   : null,
          point:     match ? match.point : null,
        });
      },
    });
    console.log('[prolink] Listener active');
  } catch (err) {
    console.warn('[prolink] Could not start Pro DJ Link listener:', err.message);
    console.warn('          Running in HTTP-only mode (no live Rekordbox data).');
  }

  // Graceful shutdown — close WS clients first, then HTTP server
  process.on('SIGINT', () => {
    console.log('\n[server] Shutting down…');
    // Close all open WebSocket connections so httpServer.close() can finish
    for (const client of wss.clients) client.terminate();
    httpServer.close(() => process.exit(0));
    // Hard kill after 2 s in case something else is still open
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

main();
