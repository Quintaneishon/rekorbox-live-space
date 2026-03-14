/**
 * LiveGraphVisualization
 *
 * 3-D force-graph driven by Rekordbox via WebSocket.
 *
 * Behaviour:
 *  - Graph data (nodes + KNN links) fetched once from the Node.js backend
 *  - WebSocket receives track_change / play_state events
 *  - Currently-playing node blinks yellow; camera flies to it automatically
 *  - No click-to-play: clicks only highlight a node's neighbours (navigation)
 *  - Now-playing bar is read-only (no transport buttons)
 *  - Search panel navigates + highlights, no audio
 */

import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import ForceGraph3D from 'react-force-graph-3d';

// ── Constants ────────────────────────────────────────────────────────────────
const API = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const WS  = import.meta.env.VITE_WS_URL     || 'ws://localhost:3001';

const STATIC_COLORS = [
  [255, 0, 0], [255, 105, 180], [138, 43, 226], [255, 215, 0],
  [0, 255, 255], [255, 140, 0], [34, 139, 34], [0, 0, 255],
  [128, 128, 128], [139, 69, 19],
];
const DEFAULT_COLOR           = [200, 200, 200];
const HIGHLIGHT_COLOR         = '#ffff00';
const HIGHLIGHT_NEIGHBOR      = '#ffffff';
const HIGHLIGHT_EDGE          = 'rgba(255,255,0,0.9)';
const DIM_NODE_OPACITY        = 0.12;
const DIM_LINK_OPACITY        = 0.03;
const PLAYING_COLOR_A         = '#ffffff';   // blink frame A
const PLAYING_SIZE            = 8;
const PLAYING_NEIGHBOR_SIZE   = 3;

const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

const buildGenreColorMap = (tags) => {
  const map = {};
  tags.forEach((tag, i) => {
    map[tag.toLowerCase()] =
      i < STATIC_COLORS.length
        ? STATIC_COLORS[i]
        : [Math.random()*255|0, Math.random()*255|0, Math.random()*255|0];
  });
  return map;
};

const getColor = (genre, colorMap) => {
  if (!genre || !colorMap) return DEFAULT_COLOR;
  return colorMap[genre.toLowerCase()] || DEFAULT_COLOR;
};

/** Normalise a filename / Rekordbox title for fuzzy matching */
const normalize = (s) =>
  s.replace(/\.[^.]+$/, '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

// ── Component ────────────────────────────────────────────────────────────────
export const LiveGraphVisualization = () => {
  const fgRef        = useRef();
  const containerRef = useRef(null);

  const [graphData,      setGraphData]      = useState({ nodes: [], links: [] });
  const [genreColorMap,  setGenreColorMap]  = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);

  // WebSocket
  const [wsStatus,       setWsStatus]       = useState('connecting');

  // Playback state (driven by WS)
  //deckTracks: Map of playerNum → { nodeId, title, tag, playing }
  // When Pro DJ Link is not active, playerNum is always 0 (manual control)
  const [deckTracks,    setDeckTracks]    = useState(new Map());
  const [isPlaying,     setIsPlaying]     = useState(false);
  const [currentTrack,  setCurrentTrack]  = useState(null); // most recent { title, tag }

  // Derived: set of all nodeIds currently playing across all decks
  const playingNodeIds = useMemo(() => {
    const ids = new Set();
    deckTracks.forEach(d => { if (d.playing && d.nodeId) ids.add(d.nodeId); });
    return ids;
  }, [deckTracks]);

  // Blink: toggle every 500 ms when playing
  const [blinkOn, setBlinkOn] = useState(false);
  useEffect(() => {
    if (!isPlaying) { setBlinkOn(false); return; }
    const id = setInterval(() => setBlinkOn(b => !b), 500);
    return () => clearInterval(id);
  }, [isPlaying]);

  // Highlight (for search / click-to-highlight)
  const [highlightNodeId, setHighlightNodeId] = useState(null);
  const [searchQuery,     setSearchQuery]     = useState('');

  // ── Graph data load ────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const [tagsRes, graphRes] = await Promise.all([
          fetch(`${API}/tags`),
          fetch(`${API}/graph`),
        ]);
        if (!tagsRes.ok)  throw new Error(`/tags HTTP ${tagsRes.status}`);
        if (!graphRes.ok) throw new Error(`/graph HTTP ${graphRes.status}`);

        const tags  = await tagsRes.json();
        const graph = await graphRes.json();

        setGenreColorMap(buildGenreColorMap(Array.isArray(tags) ? tags : []));
        setGraphData({ nodes: graph.nodes || [], links: graph.links || [] });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // ── Neighbour map (for highlight + dimming) ───────────────────────────────
  const neighborMap = useMemo(() => {
    const map = new Map();
    graphData.links.forEach(link => {
      const s = typeof link.source === 'object' ? link.source.id : link.source;
      const t = typeof link.target === 'object' ? link.target.id : link.target;
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s).add(t);
      map.get(t).add(s);
    });
    return map;
  }, [graphData]);

  // For highlight: prefer explicit search highlight, fall back to first playing node
  const firstPlayingId     = useMemo(() => [...playingNodeIds][0] ?? null, [playingNodeIds]);
  const activeHighlight    = highlightNodeId ?? firstPlayingId;
  const highlightNeighbors = useMemo(
    () => (activeHighlight !== null ? (neighborMap.get(activeHighlight) || new Set()) : new Set()),
    [activeHighlight, neighborMap],
  );
  const isHighlightActive = activeHighlight !== null;

  // ── Camera fly ───────────────────────────────────────────────────────────
  const flyToNode = useCallback((node) => {
    if (!fgRef.current || !node) return;
    const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
    fgRef.current.cameraPosition(
      { x: nx, y: ny + 120, z: nz + 300 },
      { x: nx, y: ny, z: nz },
      2000,
    );
  }, []);

  // ── Find graph node by filename (fuzzy) ───────────────────────────────────
  const findNode = useCallback((filename) => {
    if (!filename) return null;
    const q = normalize(filename);
    // exact first
    let found = graphData.nodes.find(n => normalize(n.name) === q);
    if (found) return found;
    // substring
    found = graphData.nodes.find(n => normalize(n.name).includes(q) || q.includes(normalize(n.name)));
    if (found) return found;
    // word-overlap
    const qWords = new Set(q.split(' ').filter(Boolean));
    let best = null, bestScore = 0;
    for (const n of graphData.nodes) {
      const nw = new Set(normalize(n.name).split(' ').filter(Boolean));
      const inter = [...qWords].filter(w => nw.has(w)).length;
      const union = new Set([...qWords, ...nw]).size;
      const score = union > 0 ? inter / union : 0;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return bestScore >= 0.4 ? best : null;
  }, [graphData.nodes]);

  // ── WebSocket ────────────────────────────────────────────────────────────
  useEffect(() => {
    let ws;
    let reconnectTimer;

    const connect = () => {
      setWsStatus('connecting');
      ws = new WebSocket(WS);

      ws.onopen  = () => { setWsStatus('open'); };
      ws.onerror = () => setWsStatus('error');
      ws.onclose = () => { setWsStatus('closed'); reconnectTimer = setTimeout(connect, 3000); };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'track_change') {
          const filename  = msg.point?.name || msg.title || '';
          const node      = findNode(filename);
          const playerNum = msg.playerNum ?? 0;

          setDeckTracks(prev => {
            const next = new Map(prev);
            next.set(playerNum, {
              nodeId:  node?.id ?? null,
              title:   msg.title,
              tag:     node?.tag || msg.point?.tag || '',
              playing: !!msg.playing,
            });
            return next;
          });
          setCurrentTrack({ title: msg.title, tag: node?.tag || msg.point?.tag || '' });
          setIsPlaying(!!msg.playing);
          if (node) flyToNode(node);
        }

        if (msg.type === 'play_state') {
          const playerNum = msg.playerNum ?? 0;
          setIsPlaying(msg.playing);
          setDeckTracks(prev => {
            const next = new Map(prev);
            const deck = next.get(playerNum);
            if (deck) next.set(playerNum, { ...deck, playing: !!msg.playing });
            return next;
          });
        }
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData.nodes, findNode, flyToNode]);

  // ── Node colours ─────────────────────────────────────────────────────────
  const nodeColor = useCallback((node) => {
    const isOnAir   = playingNodeIds.has(node.id);
    const isHighlit = node.id === activeHighlight;
    const isNeighbor = highlightNeighbors.has(node.id);

    if (isOnAir) {
      // Blink between white and genre colour; all on-air decks blink together
      return blinkOn ? PLAYING_COLOR_A : rgbToHex(...getColor(node.tag, genreColorMap));
    }

    if (isHighlightActive) {
      if (isHighlit)  return HIGHLIGHT_COLOR;
      if (isNeighbor) return HIGHLIGHT_NEIGHBOR;
      const c = getColor(node.tag, genreColorMap);
      return `rgba(${c[0]},${c[1]},${c[2]},${DIM_NODE_OPACITY})`;
    }

    const c = getColor(node.tag, genreColorMap);
    return rgbToHex(...c);
  }, [genreColorMap, playingNodeIds, activeHighlight, isHighlightActive, highlightNeighbors, blinkOn]);

  const nodeVal = useCallback((node) => {
    if (playingNodeIds.has(node.id))     return PLAYING_SIZE;
    if (node.id === activeHighlight)     return 6;
    if (highlightNeighbors.has(node.id)) return PLAYING_NEIGHBOR_SIZE;
    return 1;
  }, [playingNodeIds, activeHighlight, highlightNeighbors]);

  const linkColor = useCallback((link) => {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (isHighlightActive) {
      const hit = s === activeHighlight || t === activeHighlight;
      return hit ? HIGHLIGHT_EDGE : `rgba(100,100,100,${DIM_LINK_OPACITY})`;
    }
    if (link.sameGenre) {
      const src = typeof link.source === 'object' ? link.source : null;
      if (src) { const c = getColor(src.tag, genreColorMap); return `rgba(${c[0]},${c[1]},${c[2]},0.6)`; }
      return 'rgba(255,255,255,0.4)';
    }
    return 'rgba(100,100,100,0.15)';
  }, [genreColorMap, isHighlightActive, activeHighlight]);

  const linkWidth = useCallback((link) => {
    if (isHighlightActive) {
      const s = typeof link.source === 'object' ? link.source.id : link.source;
      const t = typeof link.target === 'object' ? link.target.id : link.target;
      return s === activeHighlight || t === activeHighlight ? 2 : 0.1;
    }
    return link.sameGenre ? 0.8 : 0.3;
  }, [isHighlightActive, activeHighlight]);

  const nodeLabel = useCallback((node) => {
    const playing = playingNodeIds.has(node.id) ? ' ▶ NOW PLAYING' : '';
    return `<div style="background:rgba(0,0,0,0.85);color:white;padding:6px 10px;border-radius:4px;font-size:13px">
      <b>${node.name}</b>${playing}<br/>Genre: ${node.tag}
    </div>`;
  }, [playingNodeIds]);

  // Click → highlight neighbours (no audio)
  const handleNodeClick = useCallback((node) => {
    setHighlightNodeId(prev => prev === node.id ? null : node.id);
  }, []);

  // ── Search ───────────────────────────────────────────────────────────────
  const filteredSongs = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return graphData.nodes
      .filter(n => n.name.toLowerCase().includes(q) || n.tag.toLowerCase().includes(q))
      .slice(0, 50);
  }, [searchQuery, graphData.nodes]);

  const handleSearchSelect = useCallback(async (node) => {
    const live = graphData.nodes.find(n => n.id === node.id);
    if (!live) return;
    setHighlightNodeId(live.id);
    setSearchQuery('');
    flyToNode(live);
    // Also set as now playing
    await fetch(`${API}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: live.name, playing: true }),
    }).catch(() => {});
  }, [graphData.nodes, flyToNode]);

  const handlePauseResume = useCallback(async () => {
    await fetch(`${API}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playing: !isPlaying }),
    }).catch(() => {});
  }, [isPlaying]);

  // ── WS status badge ──────────────────────────────────────────────────────
  const wsLabel = { connecting: 'Connecting…', open: 'Live', closed: 'Reconnecting…', error: 'Error' }[wsStatus] || wsStatus;
  const wsColor = { connecting: '#ffd700', open: '#00ff88', closed: '#ff6060', error: '#ff6060' }[wsStatus] || '#888';

  // ── Track colour for now-playing bar ─────────────────────────────────────
  const trackC = getColor(currentTrack?.tag, genreColorMap);
  const trackColorStr = `rgb(${trackC[0]},${trackC[1]},${trackC[2]})`;

  // ── Loading / error screens ───────────────────────────────────────────────
  if (loading) return (
    <div style={S.fullCenter}>
      <div style={S.spinner} />
      <p style={{ marginTop: 20, color: 'white' }}>Loading graph…</p>
      <p style={{ color: '#888', fontSize: 12, marginTop: 6 }}>{API}</p>
    </div>
  );

  if (error) return (
    <div style={S.fullCenter}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
      <h2 style={{ color: 'white' }}>Error</h2>
      <p style={{ color: '#aaa' }}>{error}</p>
    </div>
  );

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        nodeColor={nodeColor}
        nodeLabel={nodeLabel}
        nodeVal={nodeVal}
        nodeResolution={8}
        nodeOpacity={0.9}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkOpacity={0.6}
        onNodeClick={handleNodeClick}
        backgroundColor="#121212"
        showNavInfo={false}
      />

      {/* WS status — top left */}
      <div style={S.statusBadge}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: wsColor, boxShadow: `0 0 6px ${wsColor}` }} />
        <span style={{ fontSize: 11, color: wsColor, fontWeight: 600 }}>{wsLabel}</span>
        {currentTrack && (
          <button onClick={handlePauseResume} style={{
            marginLeft: 8, padding: '3px 10px', borderRadius: 4, border: 'none',
            background: isPlaying ? 'rgba(255,100,100,0.2)' : 'rgba(0,255,136,0.2)',
            color: isPlaying ? '#ff6464' : '#00ff88',
            cursor: 'pointer', fontSize: 11, fontWeight: 700,
          }}>
            {isPlaying ? '⏸ Pause' : '▶ Resume'}
          </button>
        )}
      </div>

      {/* Now-playing bar — shows all on-air decks */}
      {deckTracks.size > 0 && (
        <div style={{ ...S.nowPlaying, flexDirection: 'column', gap: 6, borderColor: `${trackColorStr}55` }}>
          {[...deckTracks.entries()].map(([num, deck]) => {
            if (!deck.title) return null;
            const dc = getColor(deck.tag, genreColorMap);
            const dColorStr = `rgb(${dc[0]},${dc[1]},${dc[2]})`;
            return (
              <div key={num} style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#888', marginRight: 8, minWidth: 44 }}>
                  {deckTracks.size > 1 ? `DECK ${num + 1}` : ''}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {deck.title}
                  </div>
                  {deck.tag && <div style={{ fontSize: 10, color: dColorStr, marginTop: 1 }}>{deck.tag}</div>}
                </div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: deck.playing ? '#00ff88' : '#555', marginLeft: 12, flexShrink: 0 }}>
                  {deck.playing ? '▶ LIVE' : 'PAUSED'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Genre legend — top right */}
      {genreColorMap && (
        <div style={S.legend}>
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>Genres</div>
          {Object.entries(genreColorMap).map(([g, c]) => (
            <div key={g} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ width: 10, height: 10, background: `rgb(${c[0]},${c[1]},${c[2]})`, marginRight: 8, borderRadius: 2 }} />
              <span>{g}</span>
            </div>
          ))}
        </div>
      )}

      {/* Search panel — bottom left */}
      <div style={S.search}>
        <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 2 }}>Search Songs</div>
        <div style={{ fontSize: 10, opacity: 0.45, marginBottom: 8 }}>Click a song to set as now playing</div>
        <input
          type="text"
          placeholder="Song name or genre…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={S.input}
        />
        {searchQuery && (
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
            {filteredSongs.length} result{filteredSongs.length !== 1 ? 's' : ''}
          </div>
        )}
        {filteredSongs.length > 0 && (
          <div style={{ overflowY: 'auto', maxHeight: 260 }}>
            {filteredSongs.map(node => {
              const c = getColor(node.tag, genreColorMap);
              return (
                <div
                  key={node.id}
                  onClick={() => handleSearchSelect(node)}
                  style={S.searchItem}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'transparent'; }}
                >
                  <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11, opacity: 0.7 }}>
                    <span style={{ width: 8, height: 8, minWidth: 8, background: `rgb(${c[0]},${c[1]},${c[2]})`, borderRadius: '50%' }} />
                    <span>{node.tag}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {searchQuery && !filteredSongs.length && (
          <div style={{ padding: 12, textAlign: 'center', opacity: 0.5, fontSize: 12 }}>No results</div>
        )}
        {highlightNodeId !== null && !searchQuery && (
          <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(255,255,0,0.08)', borderRadius: 4, fontSize: 11, border: '1px solid rgba(255,255,0,0.3)' }}>
            {highlightNeighbors.size} connections.{' '}
            <span onClick={() => setHighlightNodeId(null)} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Clear</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  fullCenter: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#121212', color: 'white', flexDirection: 'column' },
  spinner: { width: 50, height: 50, border: '5px solid rgba(255,255,255,0.2)', borderTop: '5px solid white', borderRadius: '50%', animation: 'spin 1s linear infinite' },
  statusBadge: { position: 'absolute', top: 14, left: 14, display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.75)', color: 'white', padding: '7px 12px', borderRadius: 8, fontSize: 12, zIndex: 10, backdropFilter: 'blur(8px)' },
  nowPlaying: { position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', width: 'min(520px, 88vw)', background: 'rgba(0,0,0,0.9)', border: '1px solid', borderRadius: 10, padding: '12px 18px', display: 'flex', alignItems: 'center', zIndex: 10, backdropFilter: 'blur(12px)', boxShadow: '0 4px 30px rgba(0,0,0,0.7)', color: 'white' },
  legend: { position: 'absolute', top: 14, right: 14, background: 'rgba(0,0,0,0.8)', color: 'white', padding: 12, borderRadius: 4, fontSize: 12, maxHeight: 'calc(100vh - 180px)', overflowY: 'auto', zIndex: 10 },
  search: { position: 'absolute', bottom: 80, left: 10, background: 'rgba(0,0,0,0.9)', color: 'white', padding: 12, borderRadius: 8, fontSize: 13, zIndex: 10, width: 300, maxHeight: 420, display: 'flex', flexDirection: 'column', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' },
  input: { padding: '8px 12px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4, color: 'white', fontSize: 13, outline: 'none', marginBottom: 8 },
  searchItem: { padding: 8, marginBottom: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 4, cursor: 'pointer', border: '1px solid transparent', transition: 'all 0.15s' },
};
