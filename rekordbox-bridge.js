/**
 * rekordbox-bridge.js
 *
 * Reads Rekordbox UI via AppleScript.
 * Auto-detects UI element indices at startup instead of relying on hardcoded positions.
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

// Dump ALL items with their indices, separated by ||| per item and ::: between index and value
const DUMP_SCRIPT = `tell application "System Events"
  set p to first process whose name contains "rekordbox"
  set w to first window of p
  set allItems to entire contents of w
  set output to ""
  set itemCount to count of allItems
  repeat with i from 1 to itemCount
    try
      set itemVal to value of item i of allItems as string
      set output to output & i & ":::" & itemVal & "|||"
    on error
      set output to output & i & ":::[err]|||"
    end try
  end repeat
  return output
end tell
`;

const DUMP_PATH = join(tmpdir(), 'rekordbox-dump.applescript');
writeFileSync(DUMP_PATH, DUMP_SCRIPT);

// Read script using detected indices
function buildReadScript(idx) {
  return `tell application "System Events"
  set p to first process whose name contains "rekordbox"
  set w to first window of p
  set allItems to entire contents of w
  set deck1Title  to value of item ${idx.deck1} of allItems as string
  set deck2Title  to value of item ${idx.deck2} of allItems as string
  set crossfader  to value of item ${idx.xfader} of allItems as string
  set fader1      to value of item ${idx.fader1} of allItems as string
  set fader2      to value of item ${idx.fader2} of allItems as string
  return deck1Title & "|||" & deck2Title & "|||" & crossfader & "|||" & fader1 & "|||" & fader2
end tell
`;
}

const READ_PATH = join(tmpdir(), 'rekordbox-read.applescript');

// Known static UI labels to skip when looking for track titles
const UI_LABELS = new Set([
  'PERFORMANCE', 'Master Out', 'rekordbox', '2Deck Horizontal',
  'LOW', 'MID', 'HI', 'FX', 'Off', 'On', 'PARAM', 'S', 'M',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
  'N', 'O', 'P', '1/2', '3/4', 'missing value',
]);

async function dumpAllItems() {
  const { stdout } = await execAsync(`osascript ${DUMP_PATH}`, { timeout: 30000 });
  const map = new Map();
  for (const part of stdout.trim().split('|||')) {
    const sep = part.indexOf(':::');
    if (sep === -1) continue;
    const idx = parseInt(part.slice(0, sep).trim(), 10);
    const val = part.slice(sep + 3).trim();
    if (!isNaN(idx) && val && val !== '[err]' && val !== 'missing value') map.set(idx, val);
  }
  return map;
}

async function detectIndices() {
  console.log('[bridge] Auto-detecting UI element indices...');
  const items = await dumpAllItems();

  const titleCandidates = [];
  const faderCandidates = []; // integer 0–100
  const xfaderCandidates = []; // float 0–1

  for (const [idx, val] of items) {
    const num = parseFloat(val);

    // Track title: non-numeric string, > 10 chars, has a space, not a known label
    if (isNaN(num) && val.length > 10 && val.includes(' ') && !UI_LABELS.has(val)) {
      titleCandidates.push(idx);
    }

    // Channel fader: whole number in 0–100 range (may appear as "0", "100", "0.0", "100.0")
    if (!isNaN(num) && num >= 0 && num <= 100 && Math.round(num) === num) {
      faderCandidates.push({ idx, val: Math.round(num) });
    }

    // Crossfader: float in 0–1 range with decimal
    if (!isNaN(num) && num >= 0 && num <= 1 && val.includes('.')) {
      xfaderCandidates.push({ idx, val: num });
    }
  }

  if (titleCandidates.length < 2) {
    throw new Error(`Not enough track titles found (got ${titleCandidates.length}). Is a track loaded on both decks?`);
  }

  const deck1 = titleCandidates[0];
  const deck2 = titleCandidates[1];
  console.log(`[bridge]   deck1 title → item ${deck1}: "${items.get(deck1)}"`);
  console.log(`[bridge]   deck2 title → item ${deck2}: "${items.get(deck2)}"`);

  // Channel faders: find two integer candidates close together (within 6 indices)
  // where one is 0 and the other is ≥80 (one deck up, one down).
  // Fallback: both ≥80 (both decks raised).
  let fader1 = null, fader2 = null;
  const findFaderPair = (predicate) => {
    let best = null;
    for (let i = 0; i < faderCandidates.length; i++) {
      for (let j = i + 1; j < faderCandidates.length; j++) {
        const a = faderCandidates[i];
        const b = faderCandidates[j];
        const diff = Math.abs(a.idx - b.idx);
        if (diff <= 6 && predicate(a.val, b.val)) {
          if (!best || diff < best.diff) best = { pair: [a.idx, b.idx], diff };
        }
      }
    }
    return best ? best.pair : null;
  };

  // Best: one at 0, one at ≥80 (typical: one fader up, one down)
  let pair = findFaderPair((a, b) => (a === 0 && b >= 80) || (b === 0 && a >= 80));
  // Fallback: both ≥80 (both faders raised)
  if (!pair) pair = findFaderPair((a, b) => a >= 80 && b >= 80);

  if (pair) {
    // In Rekordbox's UI tree, deck2's fader has a lower index than deck1's fader
    [fader2, fader1] = pair;
  }

  if (!fader1 || !fader2) {
    // Fallback: take first two fader candidates near the title indices
    const nearby = faderCandidates.filter(f => f.idx < deck1);
    if (nearby.length >= 2) {
      fader1 = nearby[nearby.length - 2].idx;
      fader2 = nearby[nearby.length - 1].idx;
    } else if (faderCandidates.length >= 2) {
      fader1 = faderCandidates[0].idx;
      fader2 = faderCandidates[1].idx;
    } else {
      throw new Error('Could not detect channel faders. Make sure at least one fader is raised.');
    }
  }
  console.log(`[bridge]   fader1      → item ${fader1}: ${items.get(fader1)}`);
  console.log(`[bridge]   fader2      → item ${fader2}: ${items.get(fader2)}`);

  // Crossfader: pick the xfader candidate closest in index to the fader pair
  const faderMid = (fader1 + fader2) / 2;
  xfaderCandidates.sort((a, b) => Math.abs(a.idx - faderMid) - Math.abs(b.idx - faderMid));
  if (!xfaderCandidates.length) throw new Error('Could not detect crossfader.');
  const xfader = xfaderCandidates[0].idx;
  console.log(`[bridge]   crossfader  → item ${xfader}: ${items.get(xfader)}`);

  return { deck1, deck2, fader1, fader2, xfader };
}

function getOnAirDeck(state, prevOnAir) {
  const { crossfader, fader1, fader2 } = state;

  if (!isNaN(fader1) && !isNaN(fader2)) {
    const diff = fader1 - fader2;
    if (diff > 10)  return 1;
    if (diff < -10) return 2;
  }

  if (!isNaN(crossfader)) {
    if (crossfader < 0.35) return 1;
    if (crossfader > 0.65) return 2;
  }

  return prevOnAir ?? 1;
}

async function readRekordbox() {
  try {
    const { stdout, stderr } = await execAsync(
      `osascript ${READ_PATH}`,
      { timeout: APPLESCRIPT_TIMEOUT_MS }
    );
    if (stderr) console.warn(`[bridge] AppleScript stderr: ${stderr.trim()}`);
    const parts = stdout.trim().split('|||');
    if (parts.length < 5) return null;
    return {
      deck1:      parts[0].trim(),
      deck2:      parts[1].trim(),
      crossfader: parseFloat(parts[2].trim()),
      fader1:     parseFloat(parts[3].trim()),
      fader2:     parseFloat(parts[4].trim()),
    };
  } catch (err) {
    console.warn(`[bridge] AppleScript error: ${err.message?.split('\n')[0]}`);
    return null;
  }
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

  // Auto-detect indices with retry
  let idx;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      idx = await detectIndices();
      break;
    } catch (err) {
      console.warn(`[bridge] Detection attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        console.log('[bridge] Retrying in 3s...');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error('[bridge] Could not auto-detect indices. Make sure Rekordbox is open with tracks loaded on both decks.');
        process.exit(1);
      }
    }
  }

  // Write the read script with detected indices
  writeFileSync(READ_PATH, buildReadScript(idx));
  console.log('[bridge] Indices locked in. Starting poll loop.');

  let prevDeck1 = '';
  let prevDeck2 = '';
  let prevOnAir = null;
  let notified  = '';

  while (true) {
    const state = await readRekordbox();

    if (!state) {
      // error already logged
    } else {
      const { deck1, deck2, crossfader } = state;
      const onAir = getOnAirDeck(state, prevOnAir);

      if (deck1 && deck1 !== 'missing value') prevDeck1 = deck1;
      if (deck2 && deck2 !== 'missing value') prevDeck2 = deck2;

      const liveTitle  = onAir === 1 ? deck1 : deck2;
      const fallback   = onAir === 1 ? prevDeck1 : prevDeck2;
      const onAirTitle = (liveTitle && liveTitle !== 'missing value') ? liveTitle : fallback;

      if (prevOnAir !== onAir) {
        const { fader1, fader2 } = state;
        console.log(`[bridge] fader1=${fader1} fader2=${fader2} xfader=${isNaN(crossfader) ? '?' : crossfader.toFixed(2)} → deck${onAir} on air`);
      }

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
