/**
 * Loads embedding points from the Python backend once at startup.
 * Returns an array of { name, tag, coords: [x,y,z], audio } objects
 * plus a lookup map keyed by normalized title for fast track matching.
 */

let points = [];          // raw array from backend
let normalizedIndex = []; // [{ normalized, original, idx }]

/** Strip audio extension and normalize to lowercase with spaces. */
function normalize(str) {
  return str
    .replace(/\.[^.]+$/, '')       // remove extension
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')       // underscores/hyphens → spaces
    .replace(/[^\w\s]/g, ' ')      // strip punctuation (commas, dots, etc.)
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadEmbeddings(backendUrl, model, dataset) {
  const url = `${backendUrl}/embeddings?red=${model}&dataset=${dataset}&metodo=umap&dimensions=3`;
  console.log(`[embeddings] Fetching from ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Embeddings fetch failed: ${res.status} ${res.statusText}`);

  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Unexpected embeddings response shape');
  }

  points = json.data;
  normalizedIndex = points.map((p, idx) => ({
    normalized: normalize(p.name),
    original: p.name,
    idx,
  }));

  console.log(`[embeddings] Loaded ${points.length} points`);
  return points;
}

export function getPoints() {
  return points;
}

/**
 * Find the best matching point for a Rekordbox track title.
 * Returns { idx, point, score } or null if no reasonable match.
 *
 * Strategy:
 *  1. Exact normalized match
 *  2. Substring containment (longer contains shorter)
 *  3. Word overlap Jaccard score (threshold ≥ 0.4)
 */
export function matchTitle(rekordboxTitle) {
  if (!rekordboxTitle || normalizedIndex.length === 0) return null;

  const query = normalize(rekordboxTitle);

  // 1. Exact
  const exact = normalizedIndex.find(e => e.normalized === query);
  if (exact) return { idx: exact.idx, point: points[exact.idx], score: 1.0 };

  // 2. Substring
  const sub = normalizedIndex.find(
    e => e.normalized.includes(query) || query.includes(e.normalized)
  );
  if (sub) return { idx: sub.idx, point: points[sub.idx], score: 0.9 };

  // 3. Word-overlap Jaccard
  const qWords = new Set(query.split(' ').filter(Boolean));
  let best = null;
  let bestScore = 0;

  for (const entry of normalizedIndex) {
    const eWords = new Set(entry.normalized.split(' ').filter(Boolean));
    const intersection = [...qWords].filter(w => eWords.has(w)).length;
    const union = new Set([...qWords, ...eWords]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (best && bestScore >= 0.4) {
    return { idx: best.idx, point: points[best.idx], score: bestScore };
  }

  return null;
}
