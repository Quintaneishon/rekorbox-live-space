/**
 * rekordbox-bridge.js
 *
 * Reads Rekordbox UI via AppleScript:
 *  - Deck 1 title  (item 192)
 *  - Deck 2 title  (item 213)
 *  - Crossfader    (item 185, range -1..+1, negative = deck1, positive = deck2)
 *
 * Fires POST /track to the local server when the on-air track changes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SERVER  = process.env.SERVER_URL || 'http://localhost:3001';
const POLL_MS = 1500;

const SCRIPT = `
tell application "System Events"
  set p to first process whose name contains "rekordbox"
  set w to first window of p
  set allItems to entire contents of w

  set deck1Title  to value of item 192 of allItems as string
  set deck2Title  to value of item 213 of allItems as string
  set crossfader  to value of item 185 of allItems as string

  return deck1Title & "|||" & deck2Title & "|||" & crossfader
end tell
`;

async function readRekordbox() {
  try {
    const { stdout } = await execAsync(`osascript -e '${SCRIPT.replace(/\n/g, '\n').replace(/'/g, "'\"'\"'")}'`);
    const parts = stdout.trim().split('|||');
    if (parts.length < 3) return null;
    return {
      deck1: parts[0].trim(),
      deck2: parts[1].trim(),
      crossfader: parseFloat(parts[2].trim()),
    };
  } catch {
    return null;
  }
}

// Crossfader: negative value = deck 1 dominant, positive = deck 2 dominant
// Threshold: if |crossfader| < 0.15, both decks are mixing (report the one that just changed)
function getOnAirDeck(state, prevOnAir) {
  const { crossfader } = state;
  if (crossfader < -0.15) return 1;
  if (crossfader >  0.15) return 2;
  // Centered — keep previous on-air deck
  return prevOnAir ?? 1;
}

async function notifyTrack(title, deck) {
  try {
    const res = await fetch(`${SERVER}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, playing: true }),
    });
    const data = await res.json();
    const match = data.found ? `idx=${data.idx}` : 'no match';
    console.log(`[bridge] deck${deck} on-air → "${title}" (${match})`);
  } catch (err) {
    console.error(`[bridge] Server error: ${err.message}`);
  }
}

async function main() {
  console.log(`[bridge] Polling Rekordbox every ${POLL_MS}ms → ${SERVER}`);

  let prevDeck1   = '';
  let prevDeck2   = '';
  let prevOnAir   = null;
  let notified    = '';

  while (true) {
    const state = await readRekordbox();

    if (!state) {
      console.warn('[bridge] Rekordbox not found or AppleScript failed');
    } else {
      const { deck1, deck2, crossfader } = state;
      const onAir = getOnAirDeck(state, prevOnAir);
      const onAirTitle = onAir === 1 ? deck1 : deck2;

      // Log crossfader for debugging (only when it changes significantly)
      if (prevOnAir !== onAir) {
        console.log(`[bridge] Crossfader=${crossfader.toFixed(2)} → deck${onAir} on air`);
      }

      // Notify when:
      //  1. The on-air deck changed, OR
      //  2. The on-air deck loaded a new track
      const titleChanged  = onAirTitle !== notified;
      const deckChanged   = onAir !== prevOnAir && onAirTitle !== notified;

      if ((titleChanged || deckChanged) && onAirTitle && onAirTitle !== 'missing value') {
        await notifyTrack(onAirTitle, onAir);
        notified = onAirTitle;
      }

      prevDeck1 = deck1;
      prevDeck2 = deck2;
      prevOnAir = onAir;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();