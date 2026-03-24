/**
 * rekordbox-bridge.js
 *
 * Reads Rekordbox UI via AppleScript:
 *  - Deck 1 title  (item 192)
 *  - Deck 2 title  (item 215)
 *  - Crossfader    (item 185, range -1..+1, negative = deck1, positive = deck2)
 *
 * Fires POST /track to the local server when the on-air track changes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

const SERVER  = process.env.SERVER_URL || 'http://localhost:3001';
const POLL_MS = 1500;
const APPLESCRIPT_TIMEOUT_MS = 5000;

const SCRIPT_CONTENT = `tell application "System Events"
  set p to first process whose name contains "rekordbox"
  set w to first window of p
  set allItems to entire contents of w

  set deck1Title  to value of item 192 of allItems as string
  set deck2Title  to value of item 215 of allItems as string
  set crossfader  to value of item 185 of allItems as string

  return deck1Title & "|||" & deck2Title & "|||" & crossfader
end tell
`;

// Write AppleScript to a temp file once to avoid shell-escaping issues
const SCRIPT_PATH = join(tmpdir(), 'rekordbox-bridge.applescript');
writeFileSync(SCRIPT_PATH, SCRIPT_CONTENT);

async function readRekordbox() {
  try {
    const { stdout, stderr } = await execAsync(
      `osascript ${SCRIPT_PATH}`,
      { timeout: APPLESCRIPT_TIMEOUT_MS }
    );
    if (stderr) console.warn(`[bridge] AppleScript stderr: ${stderr.trim()}`);
    const parts = stdout.trim().split('|||');
    if (parts.length < 3) return null;
    return {
      deck1: parts[0].trim(),
      deck2: parts[1].trim(),
      crossfader: parseFloat(parts[2].trim()),
    };
  } catch (err) {
    console.warn(`[bridge] AppleScript error: ${err.message?.split('\n')[0]}`);
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
      body: JSON.stringify({ title, playing: true, playerNum: deck - 1 }),
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

  let prevDeck1   = '';  // last known deck1 title (fallback)
  let prevDeck2   = '';  // last known deck2 title (fallback)
  let prevOnAir   = null;
  let notified    = '';

  while (true) {
    const state = await readRekordbox();

    if (!state) {
      // error already logged in readRekordbox
    } else {
      const { deck1, deck2, crossfader } = state;
      const onAir = getOnAirDeck(state, prevOnAir);

      // Keep last known titles so we can fall back when the live read is empty
      if (deck1 && deck1 !== 'missing value') prevDeck1 = deck1;
      if (deck2 && deck2 !== 'missing value') prevDeck2 = deck2;

      // Use last known title as fallback if the current read came back empty
      const liveTitle = onAir === 1 ? deck1 : deck2;
      const fallback  = onAir === 1 ? prevDeck1 : prevDeck2;
      const onAirTitle = (liveTitle && liveTitle !== 'missing value') ? liveTitle : fallback;

      // Log crossfader for debugging (only when it changes significantly)
      if (prevOnAir !== onAir) {
        console.log(`[bridge] Crossfader=${crossfader.toFixed(2)} → deck${onAir} on air`);
      }

      // Notify when:
      //  1. The on-air deck changed, OR
      //  2. The on-air deck loaded a new track
      const titleChanged = onAirTitle !== notified;
      const deckChanged  = onAir !== prevOnAir && onAirTitle !== notified;

      if ((titleChanged || deckChanged) && onAirTitle) {
        await notifyTrack(onAirTitle, onAir);
        notified = onAirTitle;
      }

      prevOnAir = onAir;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();