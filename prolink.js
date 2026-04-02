/**
 * Pro DJ Link listener — uses MixstatusProcessor so the "now playing" track
 * reflects what is actually on-air through the mixer, not just the sync master.
 *
 * During a mix, BOTH decks can be on-air simultaneously.
 * onNowPlaying(title, playerNumber) fires when a track becomes fully on-air.
 * onTrackChange(title, playerNumber, playing) fires on any deck state change.
 * onPlayState(playing, title) fires when the on-air deck pauses/resumes.
 *
 * Port conflict with Rekordbox on same machine:
 * The reuseAddr patch lets us bind port 50000 alongside Rekordbox.
 * If that still fails, server.js catches the error and runs HTTP-only.
 */

// Patch dgram BEFORE prolink-connect is imported so all sockets use reuseAddr
import dgram from 'dgram';
const _origCreate = dgram.createSocket.bind(dgram);
dgram.createSocket = function (opts, cb) {
  if (typeof opts === 'string') opts = { type: opts };
  opts = { ...opts, reuseAddr: true, reusePort: true };
  return cb ? _origCreate(opts, cb) : _origCreate(opts);
};

import pkg from 'prolink-connect';
const { bringOnline, MixstatusProcessor } = pkg;

export async function startProlinkListener({ onNowPlaying, onPlayState }) {
  console.log('[prolink] Bringing network online (reuseAddr=true)…');
  const network = await bringOnline();

  console.log('[prolink] Waiting for Pioneer device on the network…');
  await network.autoconfigFromPeers();

  console.log('[prolink] Device found. Connecting…');
  network.connect();

  console.log('[prolink] Network connected. Starting status monitoring…');
  network.statusEmitter.start();

  // MixstatusProcessor watches all decks and fires 'nowPlaying' when a
  // track becomes the on-air track (crossfader/channel-fader based).
  const processor = new MixstatusProcessor();

  // Track last known title per player so we can emit play/pause changes
  const playerTitles  = new Map(); // playerNumber → title
  const playerPlaying = new Map(); // playerNumber → bool

  network.statusEmitter.on('status', (status) => {
    // Feed every deck status into the processor
    processor.handleStatus(status);

    const num    = status.deviceId;
    const title  = status.trackTitle || status.trackInfo?.title || '';
    const playing = status.isPlaying ?? false;

    if (!title) return;

    const prevTitle   = playerTitles.get(num);
    const prevPlaying = playerPlaying.get(num);

    // New track loaded on this deck
    if (title !== prevTitle) {
      playerTitles.set(num,  title);
      playerPlaying.set(num, playing);
      console.log(`[prolink] Deck ${num} track → "${title}" playing=${playing}`);
      onNowPlaying(title, num, playing);
      return;
    }

    // Same track, play state changed
    if (playing !== prevPlaying) {
      playerPlaying.set(num, playing);
      console.log(`[prolink] Deck ${num} play state → ${playing} "${title}"`);
      onPlayState(playing, title, num);
    }
  });

  // MixstatusProcessor emits 'nowPlaying' when a track transitions on-air
  // (more accurate than raw status during actual DJ mixing with a mixer)
  processor.on('nowPlaying', (state) => {
    const title = state.track?.title || state.trackTitle || '';
    const num   = state.deviceId ?? state.playerNumber ?? null;
    if (title) {
      console.log(`[prolink] MixProcessor nowPlaying deck=${num} "${title}"`);
      onNowPlaying(title, num, true);
    }
  });

  return network;
}
