import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext';

// --- Font ---
const FONT_CONTENDERS = {
    'Bebas Neue': { weight: 400 },
    'Archivo Black': { weight: 400 },
    'Courier Prime': { weight: 900 },
    'Roboto Slab': { weight: 900 }
};
const FONT_FAMILY = Object.keys(FONT_CONTENDERS)[3];
const FONT_WEIGHT = FONT_CONTENDERS[FONT_FAMILY].weight;

// --- Geometry helpers (pure) ---

// Intersect two geographic line segments [lng,lat][]. Returns {t, u, pt} or null.
function geoSegIntersect(p1, p2, p3, p4) {
    const dx1 = p2[0]-p1[0], dy1 = p2[1]-p1[1];
    const dx2 = p4[0]-p3[0], dy2 = p4[1]-p3[1];
    const denom = dx1*dy2 - dy1*dx2;
    if (Math.abs(denom) < 1e-12) return null;
    const dx3 = p3[0]-p1[0], dy3 = p3[1]-p1[1];
    const t = (dx3*dy2 - dy3*dx2) / denom;
    const u = (dx3*dy1 - dy3*dx1) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, u, pt: [p1[0] + t*dx1, p1[1] + t*dy1] };
}

// Normalize angle to (-180, 180].
function normalizeAngle(a) {
    while (a >  180) a -= 360;
    while (a <= -180) a += 360;
    return a;
}

// Compass bearing in degrees: east=0, north=90, CCW positive (matches atan2 convention).
function bearing(from, to) {
    return Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI;
}

// --- Text measurement ---

const LETTER_SPC = 2; // px, matches SVG letter-spacing="2"

const _measureCache = new Map();

function measureLabel(text, size = 11) {
    const key = size + '|' + text;
    if (_measureCache.has(key)) return _measureCache.get(key);
    const p = prepareWithSegments(text, `${FONT_WEIGHT} ${size}px ${FONT_FAMILY}`);
    let maxW = 0;
    walkLineRanges(p, Infinity, line => { if (line.width > maxW) maxW = line.width; });
    const result = { w: maxW + LETTER_SPC * text.length };
    _measureCache.set(key, result);
    return result;
}

// --- Road hierarchy ---

const SKIP_CLASSES = new Set([
    'path', 'track', 'footway', 'cycleway', 'steps', 'bridleway', 'pedestrian',
    'path_construction', 'track_construction', 'footway_construction', 'cycleway_construction',
]);

// Lower rank = more important.
const ROAD_RANK = {
    motorway: 1, motorway_construction: 1,
    trunk: 2,    trunk_construction: 2,
    primary: 3,  primary_construction: 3,
    secondary: 4, secondary_construction: 4,
    tertiary: 5,  tertiary_construction: 5,
    minor: 6,
    service: 7,
};

function streetRank(cls) { return ROAD_RANK[cls] ?? 8; }

// Routing cost multipliers. Lower = prefer this class.
const CLASS_MULT = {
    motorway: 8, motorway_construction: 8,
    trunk: 5,    trunk_construction: 5,
    primary: 0.5,   primary_construction: 0.5,
    secondary: 0.7, secondary_construction: 0.7,
    tertiary: 0.9,  tertiary_construction: 0.9,
    minor: 1.1,
    service: 1.4,
};

function classMult(cls) { return CLASS_MULT[cls] ?? 1.2; }

const TURN_COST = 0.002;

// --- Street rendering ---

const ROAD_LINE_LAYERS = [
    'road-path', 'road-service', 'road-minor', 'road-tertiary',
    'road-secondary', 'road-primary', 'road-trunk', 'road-motorway',
];

const NS = 'http://www.w3.org/2000/svg';

function streetFontSize(rank) {
    if (rank <= 2) return 24;
    if (rank <= 3) return 20;
    if (rank <= 5) return 18;
    return 16;
}

function streetStyle(name, rank, route, pinPts, screenPt) {
    const fontSize = streetFontSize(rank);
    if (route?.streets.has(name)) return { color: '#ff3333', opacity: 1, fontSize };
    if (pinPts.some(p => Math.hypot(screenPt.x - p.x, screenPt.y - p.y) < 200))
        return { color: '#ccc', opacity: 1, fontSize };
    if (rank <= 3) return { color: '#888', opacity: 1, fontSize };
    if (rank <= 5) return { color: '#666', opacity: 1, fontSize };
    return { color: '#444', opacity: 0.6, fontSize };
}

function pathD(pts) {
    return 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1) +
        pts.slice(1).map(p => ' L ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('');
}

// Flip point order if path runs right-to-left so text reads correctly.
function orientPts(pts) {
    const dx = pts.at(-1).x - pts[0].x;
    return dx < 0 ? pts.slice().reverse() : pts;
}

function pLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++)
        len += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    return len;
}

// Pick the longest projected line segment for a street — avoids concatenating
// disconnected tile segments into one path, which causes text to jump.
function longestLine(lines, map) {
    let bestPts = [], bestLen = 0;
    for (const line of lines) {
        const pts = line.map(c => map.project(c));
        const len = pLength(pts);
        if (len > bestLen) { bestLen = len; bestPts = pts; }
    }
    return { pts: bestPts, len: bestLen };
}

// Returns t ∈ [0,1] along segment p1→p2 where it crosses p3→p4, or null.
function screenSegIntersectT(p1, p2, p3, p4) {
    const dx1 = p2.x-p1.x, dy1 = p2.y-p1.y;
    const dx2 = p4.x-p3.x, dy2 = p4.y-p3.y;
    const denom = dx1*dy2 - dy1*dx2;
    if (Math.abs(denom) < 0.01) return null;
    const dx3 = p3.x-p1.x, dy3 = p3.y-p1.y;
    const t = (dx3*dy2 - dy3*dx2) / denom;
    const u = (dx3*dy1 - dy3*dx1) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return t;
}

// Arc-length along pts of the point geometrically closest to screen (cx, cy).
function closestToCenter(pts, cx, cy) {
    const cumLen = [0];
    for (let i = 1; i < pts.length; i++)
        cumLen.push(cumLen[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y));
    let bestArc = cumLen.at(-1) / 2, bestDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 0.01) continue;
        const t  = Math.max(0, Math.min(1, ((cx-pts[i].x)*dx + (cy-pts[i].y)*dy) / (segLen*segLen)));
        const dist = Math.hypot(pts[i].x + t*dx - cx, pts[i].y + t*dy - cy);
        if (dist < bestDist) { bestDist = dist; bestArc = cumLen[i] + t * (cumLen[i+1] - cumLen[i]); }
    }
    return bestArc;
}

// Returns sorted { pos, rank } objects along mainPts where others cross it.
// others: [{ pts, rank }]
function findCrossings(mainPts, others) {
    const cumLen = [0];
    for (let i = 1; i < mainPts.length; i++)
        cumLen.push(cumLen[i-1] + Math.hypot(mainPts[i].x-mainPts[i-1].x, mainPts[i].y-mainPts[i-1].y));

    const hits = [];
    for (const { pts: other, rank } of others) {
        for (let mi = 0; mi < mainPts.length-1; mi++) {
            for (let oi = 0; oi < other.length-1; oi++) {
                const t = screenSegIntersectT(mainPts[mi], mainPts[mi+1], other[oi], other[oi+1]);
                if (t !== null)
                    hits.push({ pos: cumLen[mi] + t * (cumLen[mi+1] - cumLen[mi]), rank });
            }
        }
    }
    return hits.sort((a, b) => a.pos - b.pos);
}

// Arc-length positions of sharp turns (> threshold degrees) along screen pts.
const TURN_THRESHOLD = 35; // degrees

function findTightTurns(pts) {
    const cumLen = [0];
    for (let i = 1; i < pts.length; i++)
        cumLen.push(cumLen[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y));
    const turns = [];
    for (let i = 1; i < pts.length - 1; i++) {
        const a1 = Math.atan2(pts[i].y - pts[i-1].y, pts[i].x - pts[i-1].x);
        const a2 = Math.atan2(pts[i+1].y - pts[i].y, pts[i+1].x - pts[i].x);
        let diff = Math.abs(a2 - a1) * 180 / Math.PI;
        if (diff > 180) diff = 360 - diff;
        if (diff > TURN_THRESHOLD) turns.push({ pos: cumLen[i], rank: Infinity });
    }
    return turns;
}

// Spring simulation: places word instances along a 1D path, avoiding obstacles.
// Returns [{ word, offset }] where offset is arc-length to the word's left edge.
const OBSTACLE_MARGIN = 20; // px exclusion radius around each obstacle, higher is more generous
const WORD_GAP        = 10;  // minimum px between word instances, higher is more generous
const DAMPING         = 0.2; // damping: slows down the simulation, lower is more viscous
const K_OBS           = 1000; // obstacle repulsion: pushes words away from obstacles
const K_WORD          = 1000; // word repulsion: pushes words away from each other, higher is more aggressive
const K_WALL          = 2000; // wall attraction: pulls words toward the edges of the path, higher is more aggressive
const K_EQ            = 25;   // equidistribution: pulls each word toward midpoint between neighbors
const K_ATTRACT       = 10;  // attraction toward crossings with important streets (rank 1–5), higher is greedier
const K_CENTER        = 80;  // attraction toward the on-screen center of the street (must outweigh K_ATTRACT)
const MAX_REPEATS     = 2;    // max times a street name repeats along its path
const DT              = 0.016; // time step: how often to update the simulation, lower is more accurate

const ABBREV = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    AVENUE: 'AVE', STREET: 'ST', BOULEVARD: 'BLVD', DRIVE: 'DR',
    ROAD: 'RD', LANE: 'LN', COURT: 'CT', PLACE: 'PL',
    PARKWAY: 'PKWY', HIGHWAY: 'HWY', EXPRESSWAY: 'EXPY',
    FREEWAY: 'FWY', TRAIL: 'TRL', CIRCLE: 'CIR', TERRACE: 'TER',
    EXTENSION: 'EXT', CROSSING: 'XING', JUNCTION: 'JCT',
};

// Build the initial particle list for a street, equally spaced.
function initSpring(name, totalLen, obstacles, fontSize) {
    const rawWords  = name.toUpperCase().split(' ').map(w => ABBREV[w] ?? w);
    const rawWidths = rawWords.map(w => measureLabel(w, fontSize).w);
    const cycleW    = rawWidths.reduce((s, w) => s + w, 0) + (rawWords.length - 1) * WORD_GAP;

    const excluded = obstacles.length * 2 * OBSTACLE_MARGIN;
    const n = Math.min(MAX_REPEATS, Math.max(1, Math.floor(Math.max(0, totalLen - excluded) / (cycleW + WORD_GAP))));

    const inst = [];
    for (let i = 0; i < n * rawWords.length; i++) {
        const wi = i % rawWords.length;
        inst.push({ word: rawWords[wi], hw: rawWidths[wi] / 2, c: 0, v: 0 });
    }
    const step = totalLen / inst.length;
    inst.forEach((w, i) => { w.c = step * (i + 0.5); });
    return inst;
}

// Advance one integration step. Returns maxV so the caller can detect rest.
function stepSpring(inst, totalLen, obstacles, centerPos) {
    let maxV = 0;
    for (let i = 0; i < inst.length; i++) {
        const { c, hw } = inst[i];
        let f = 0;

        for (const o of obstacles) {
            const dx    = c - o.pos;
            const pen   = Math.abs(dx) - hw - OBSTACLE_MARGIN;
            // Tighter surroundings = full repulsion; open space = softer push (min 25%).
            const scale = Math.max(0.25, 1 - (o.space ?? 0) / 300);
            f += K_OBS * scale * Math.sign(dx) / (Math.max(pen, 1) ** 2 + 1);
            if (o.rank <= 5)
                f += K_ATTRACT * (o.pos - c) / (o.rank * (Math.abs(dx) + 30));
        }

        for (let j = 0; j < inst.length; j++) {
            if (i === j) continue;
            const dx    = c - inst[j].c;
            const min   = hw + inst[j].hw + WORD_GAP;
            const absDx = Math.abs(dx);
            // Soft long-range repulsion: full at contact, tapers to zero at 2× min distance.
            if (absDx < min * 2)
                f += K_WORD * Math.sign(dx) * (min * 2 - absDx) / (min * 2);
        }

        // Equidistribution: pull toward midpoint between neighbors (or walls).
        const leftBound  = i > 0                  ? inst[i-1].c + inst[i-1].hw : 0;
        const rightBound = i < inst.length - 1    ? inst[i+1].c - inst[i+1].hw : totalLen;
        f += K_EQ * ((leftBound + rightBound) / 2 - c);

        // Soft pull toward the on-screen center of this street — outweighs K_ATTRACT.
        f += K_CENTER * (centerPos - c) / (Math.abs(centerPos - c) + 50);

        const lg = c - hw, rg = totalLen - hw - c;
        if (lg < 20) f += K_WALL / (lg * lg + 1);
        if (rg < 20) f -= K_WALL / (rg * rg + 1);

        inst[i].v = (inst[i].v + f * DT) * DAMPING;
        if (Math.abs(inst[i].v) < 0.5) inst[i].v = 0;
        maxV = Math.max(maxV, Math.abs(inst[i].v));
    }
    for (const w of inst) {
        w.c = Math.max(w.hw, Math.min(totalLen - w.hw, w.c + w.v));
    }
    return maxV;
}

// name → { pathEl, id, wordEls, inst, totalLen, obstacles } — reused across renders.
const _streetEls = new Map();
let _defsEl   = null;
let _idCounter = 0;

function makeWordEl(id) {
    const tp = document.createElementNS(NS, 'textPath');
    tp.setAttribute('href', '#' + id);
    const textEl = document.createElementNS(NS, 'text');
    textEl.setAttribute('font-family', `${FONT_FAMILY}, sans-serif`);
    textEl.setAttribute('font-weight', FONT_WEIGHT);
    textEl.setAttribute('letter-spacing', '2');
    textEl.appendChild(tp);
    return { textEl, tp };
}

// rAF loop — steps every live spring and writes startOffset each frame.
let _rafId = null;

function kickRaf() {
    if (_rafId !== null) return;
    _rafId = requestAnimationFrame(rafStep);
}

function rafStep() {
    _rafId = null;
    let anyActive = false;
    for (const els of _streetEls.values()) {
        if (!els.inst?.length) continue;
        const maxV = stepSpring(els.inst, els.totalLen, els.obstacles, els.centerPos);
        if (maxV > 0.5) anyActive = true;
        for (let i = 0; i < els.inst.length; i++)
            els.wordEls[i].tp.setAttribute('startOffset',
                (els.inst[i].c - els.inst[i].hw).toFixed(1));
    }
    if (anyActive) _rafId = requestAnimationFrame(rafStep);
}

function renderStreets(map, streetCache, svgEl, { pins = [], route = null } = {}) {
    svgEl.style.transform = '';
    if (!_defsEl) {
        _defsEl = document.createElementNS(NS, 'defs');
        svgEl.prepend(_defsEl);
    }

    const pinPts = pins.map(p => map.project(p.lngLat));
    const seen   = new Set();

    // Project every street's longest line once.
    const projected = new Map();
    for (const [name, { lines }] of streetCache)
        projected.set(name, orientPts(longestLine(lines, map).pts));

    for (const [name, { rank }] of streetCache) {
        seen.add(name);

        const pts = projected.get(name);
        const len = pLength(pts);
        const mid = pts[Math.floor(pts.length / 2)];

        const { color, opacity, fontSize } = streetStyle(name, rank, route, pinPts, mid);

        const others = [];
        for (const [n, p] of projected) {
            if (n !== name) others.push({ pts: p, rank: streetCache.get(n)?.rank ?? 8 });
        }
        const obstacles = [...findCrossings(pts, others), ...findTightTurns(pts)];
        obstacles.sort((a, b) => a.pos - b.pos);
        for (let oi = 0; oi < obstacles.length; oi++) {
            const left  = oi > 0 ? obstacles[oi].pos - obstacles[oi-1].pos : obstacles[oi].pos;
            const right = oi < obstacles.length-1 ? obstacles[oi+1].pos - obstacles[oi].pos : len - obstacles[oi].pos;
            obstacles[oi].space = Math.min(left, right);
        }

        // Get or create the persistent entry.
        let els = _streetEls.get(name);
        if (!els) {
            const pathEl = document.createElementNS(NS, 'path');
            pathEl.setAttribute('fill', 'none');
            pathEl.setAttribute('data-name', name);
            const id = 'sp' + _idCounter++;
            pathEl.id = id;
            _defsEl.appendChild(pathEl);
            els = { pathEl, id, wordEls: [], inst: null, totalLen: -1, obstacles: [] };
            _streetEls.set(name, els);
        }

        els.pathEl.setAttribute('d', pathD(pts));
        els.obstacles  = obstacles;
        els.centerPos  = closestToCenter(pts, svgEl.clientWidth / 2, svgEl.clientHeight / 2);

        // Reinit particles only when the path length changes significantly.
        if (!els.inst || Math.abs(len - els.totalLen) > 10) {
            els.inst     = initSpring(name, len, obstacles, fontSize);
            els.totalLen = len;
        }

        // Sync word element pool size.
        while (els.wordEls.length < els.inst.length) {
            els.wordEls.push(makeWordEl(els.id));
            svgEl.appendChild(els.wordEls.at(-1).textEl);
        }

        // Update style and text content; startOffset is owned by the rAF loop.
        for (let i = 0; i < els.wordEls.length; i++) {
            const { textEl, tp } = els.wordEls[i];
            if (i < els.inst.length) {
                textEl.setAttribute('fill', color);
                textEl.setAttribute('fill-opacity', opacity);
                textEl.setAttribute('font-size', fontSize);
                tp.textContent = els.inst[i].word;
                textEl.removeAttribute('display');
            } else {
                textEl.setAttribute('display', 'none');
            }
        }
    }

    // Remove elements for streets no longer visible.
    for (const [name, { pathEl, wordEls }] of _streetEls) {
        if (!seen.has(name)) {
            pathEl.remove();
            for (const { textEl } of wordEls) textEl.remove();
            _streetEls.delete(name);
        }
    }

    kickRaf();
}

// --- Route graph & pathfinding ---

// Build a planar graph by splitting every polyline at its intersections with
// all other polylines. This ensures roads connect at crossings even when the
// source features don't share endpoint coordinates.
//
// segments: [{ pts: [[lng,lat],...], name: string }]
// Returns { nodes: Map<key, [lng,lat]>, edges: Map<key, [{to, dist, name, bearing}]> }
function buildRouteGraph(segments) {
    // 1. Find all crossing points between every pair of polylines.
    const cuts = segments.map(() => []); // cuts[i] = [{ segIdx, t, pt }]

    for (let i = 0; i < segments.length; i++) {
        const A = segments[i].pts;
        for (let j = i + 1; j < segments.length; j++) {
            const B = segments[j].pts;
            for (let ai = 0; ai < A.length - 1; ai++) {
                for (let bj = 0; bj < B.length - 1; bj++) {
                    const hit = geoSegIntersect(A[ai], A[ai+1], B[bj], B[bj+1]);
                    if (hit) {
                        cuts[i].push({ segIdx: ai, t: hit.t, pt: hit.pt });
                        cuts[j].push({ segIdx: bj, t: hit.u, pt: hit.pt });
                    }
                }
            }
        }
    }

    // 2. Split each polyline at cut points and add directed edges with bearings.
    const PREC = 1e6;
    const nodeKey = c => `${Math.round(c[0]*PREC)},${Math.round(c[1]*PREC)}`;
    const nodes = new Map(); // key → [lng,lat]
    const edges = new Map(); // key → [{to, dist, name, bearing}]

    const ensureNode = c => {
        const k = nodeKey(c);
        if (!nodes.has(k)) nodes.set(k, c);
        return k;
    };

    const addEdge = (ka, kb, a, b, name, cls) => {
        const dist  = Math.hypot(b[0]-a[0], b[1]-a[1]);
        const b_fwd = bearing(a, b);
        const b_rev = bearing(b, a);
        if (!edges.has(ka)) edges.set(ka, []);
        if (!edges.has(kb)) edges.set(kb, []);
        edges.get(ka).push({ to: kb, dist, name, bearing: b_fwd, cls });
        edges.get(kb).push({ to: ka, dist, name, bearing: b_rev, cls });
    };

    for (let i = 0; i < segments.length; i++) {
        const { pts, name, cls } = segments[i];
        const chain = pts.map((pt, s) => ({ segIdx: s, t: 0, pt }));
        for (const c of cuts[i]) chain.push(c);
        chain.sort((a, b) => a.segIdx - b.segIdx || a.t - b.t);

        for (let c = 0; c < chain.length - 1; c++) {
            const ka = ensureNode(chain[c].pt);
            const kb = ensureNode(chain[c+1].pt);
            if (ka !== kb) addEdge(ka, kb, chain[c].pt, chain[c+1].pt, name, cls);
        }
    }

    return { nodes, edges };
}

function nearestNode(nodes, lngLat) {
    let best = null, bestDist = Infinity;
    for (const [k, c] of nodes) {
        const d = Math.hypot(c[0] - lngLat.lng, c[1] - lngLat.lat);
        if (d < bestDist) { bestDist = d; best = k; }
    }
    return best;
}

// Returns { keys, prevStreet, prevBearing } or null.
function dijkstra(edges, startKey, endKey) {
    const dist        = new Map([[startKey, 0]]);
    const prev        = new Map();
    const prevStreet  = new Map();
    const prevBearing = new Map();
    const inStreet    = new Map([[startKey, '']]);
    const visited     = new Set();
    const queue       = [[0, startKey]];

    while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, u] = queue.shift();
        if (visited.has(u)) continue;
        visited.add(u);
        if (u === endKey) break;
        const curStreet = inStreet.get(u);
        for (const { to, dist: w, name, bearing: b, cls } of (edges.get(u) || [])) {
            const turn = (curStreet && name !== curStreet) ? TURN_COST : 0;
            const nd   = d + w * classMult(cls) + turn;
            if (!dist.has(to) || nd < dist.get(to)) {
                dist.set(to, nd);
                prev.set(to, u);
                prevStreet.set(to, name);
                prevBearing.set(to, b);
                inStreet.set(to, name);
                queue.push([nd, to]);
            }
        }
    }

    if (!prev.has(endKey)) return null;

    const keys = [];
    let cur = endKey;
    while (cur !== startKey) {
        keys.unshift(cur);
        cur = prev.get(cur);
        if (cur === undefined) return null;
    }
    keys.unshift(startKey);
    return { keys, prevStreet, prevBearing };
}

// Returns { coords, streets, turns } or null.
function computeRoute(map, pin1, pin2) {
    const features = map.queryRenderedFeatures({ layers: ['road-name-data'] });
    const segments = [];
    for (const f of features) {
        if (SKIP_CLASSES.has(f.properties.class)) continue;
        const type = f.geometry.type;
        if (type !== 'LineString' && type !== 'MultiLineString') continue;
        const lines = type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const pts of lines) segments.push({ pts, name: f.properties.name || '', cls: f.properties.class });
    }

    const { nodes, edges } = buildRouteGraph(segments);
    const start = nearestNode(nodes, pin1.lngLat);
    const end   = nearestNode(nodes, pin2.lngLat);
    if (!start || !end) return null;

    const result = dijkstra(edges, start, end);
    if (!result) return null;

    const { keys, prevStreet, prevBearing } = result;
    const streets = new Set(keys.slice(1).map(k => prevStreet.get(k)).filter(Boolean));

    // Build turns for reference (used by future features if needed).
    const turns = [];
    for (let i = 1; i < keys.length - 1; i++) {
        const fromStreet = prevStreet.get(keys[i]);
        const toStreet   = prevStreet.get(keys[i + 1]);
        if (fromStreet === toStreet) continue;
        const inBearing  = prevBearing.get(keys[i]);
        const outBearing = prevBearing.get(keys[i + 1]);
        turns.push({
            coord: nodes.get(keys[i]),
            fromStreet,
            toStreet,
            inBearing,
            outBearing,
            turnAngle: normalizeAngle(outBearing - inBearing),
        });
    }

    return { streets, turns };
}

// --- Pin management ---

function repositionPins(map) {
    for (const pin of pins) {
        const pt = map.project(pin.lngLat);
        pin.element.style.left = pt.x + 'px';
        pin.element.style.top  = pt.y + 'px';
    }
}

function placePinAt(lngLat) {
    if (pins.length >= 2) {
        pins[0].element.remove();
        pins.shift();
    }
    const el = document.createElement('div');
    el.className = 'pin-marker';
    overlay.appendChild(el);
    pins.push({ lngLat, element: el });

    activeRoute = pins.length === 2 ? computeRoute(map, pins[0], pins[1]) : null;

    repositionPins(map);
    renderStreets(map, streetCache, svgEl, { pins, route: activeRoute });
}

// --- Street cache (slow path) ---

// Minimum screen length (px) for the longest visible segment of a street.
// Streets shorter than this on screen are not worth labeling.
const MIN_LABEL_PX = 120;

function refreshCache(map, streetCache) {
    if (map.getZoom() < 12) { streetCache.clear(); return streetCache; }
    const raw = new Map(); // name → { lines[], rank }
    const layers = map.getZoom() < 14
        ? ['road-major-data']
        : ['road-major-data', 'road-name-data'];
    for (const f of map.queryRenderedFeatures({ layers })) {
        const name = f.properties.name;
        const type = f.geometry.type;
        if (!name) continue;
        if (type !== 'LineString' && type !== 'MultiLineString') continue;
        if (SKIP_CLASSES.has(f.properties.class)) continue;
        const lines = type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        const rank  = streetRank(f.properties.class);
        if (raw.has(name)) {
            const e = raw.get(name);
            e.lines.push(...lines);
            e.rank = Math.min(e.rank, rank);
        } else {
            raw.set(name, { lines, rank });
        }
    }
    // Filter to streets with enough total projected length to be worth labeling.
    const next = new Map();
    for (const [name, entry] of raw) {
        const totalLen = entry.lines.reduce((s, l) => s + pLength(l.map(c => map.project(c))), 0);
        if (totalLen >= MIN_LABEL_PX) next.set(name, entry);
    }
    return next;
}

// --- URL position (pure) ---

function parseUrlPosition(hash) {
    const m = hash.match(/^#?@(-?\d+\.?\d*),(-?\d+\.?\d*),([\d.]+)z$/);
    if (!m) return null;
    return { center: [parseFloat(m[2]), parseFloat(m[1])], zoom: parseFloat(m[3]) };
}

function formatUrlPosition(center, zoom) {
    return `@${center.lat.toFixed(7)},${center.lng.toFixed(7)},${zoom.toFixed(2)}z`;
}

// --- Init ---

const initialPos = parseUrlPosition(location.hash);

const map = new maplibregl.Map({
    container: 'map',
    style: 'style.json',
    center: initialPos ? initialPos.center : [0, 20],
    zoom:   initialPos ? initialPos.zoom   : 2,
    attributionControl: { compact: true },
    pitchWithRotate: false,
});

const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
});

map.addControl(geolocate, 'bottom-right');

map.on('load', () => {
    if (!initialPos) geolocate.trigger();
    // Fade road lines out as typography takes over at zoom 14.
    ROAD_LINE_LAYERS.forEach(id => {
        if (map.getLayer(id))
            map.setPaintProperty(id, 'line-opacity',
                ['interpolate', ['linear'], ['zoom'], 13, 0.4, 14, 0]);
    });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

const svgEl  = document.getElementById('street-svg');
const overlay = document.getElementById('street-labels');
let streetCache = new Map();
let pins        = [];
let activeRoute = null;

const ctx = () => ({ pins, route: activeRoute });

// Reference state saved after each full render — used to CSS-transform the
// frozen SVG during panning/zooming without touching the DOM.
let _refRender = null; // { centerGeo, centerPx: {x,y}, zoom }

function applyMoveTransform() {
    if (!_refRender) return;
    const { centerGeo, centerPx, zoom: refZoom } = _refRender;
    const s        = Math.pow(2, map.getZoom() - refZoom);
    const newCtr   = map.project(centerGeo);
    const tx       = newCtr.x - centerPx.x * s;
    const ty       = newCtr.y - centerPx.y * s;
    svgEl.style.transformOrigin = '0 0';
    svgEl.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
}

const refresh = () => {
    streetCache = refreshCache(map, streetCache);
    renderStreets(map, streetCache, svgEl, ctx());
    _refRender = {
        centerGeo: map.getCenter(),
        centerPx:  { x: svgEl.clientWidth / 2, y: svgEl.clientHeight / 2 },
        zoom:      map.getZoom(),
    };
};

map.on('idle',    refresh);
map.on('load',    refresh);
map.on('move', () => {
    contextMenu.hidden = true;
    repositionPins(map);
    applyMoveTransform();
});
map.on('moveend', () => {
    history.replaceState(null, '', '#' + formatUrlPosition(map.getCenter(), map.getZoom()));
});

window.addEventListener('hashchange', () => {
    const pos = parseUrlPosition(location.hash);
    if (pos) map.jumpTo({ center: pos.center, zoom: pos.zoom });
});

// --- Context menu ---

const contextMenu = document.getElementById('context-menu');
let contextLngLat = null;

map.getCanvas().addEventListener('contextmenu', e => {
    e.preventDefault();
    contextLngLat = map.unproject([e.clientX, e.clientY]);
    document.getElementById('cm-clear').style.display = pins.length ? '' : 'none';
    contextMenu.style.left = e.clientX + 'px';
    contextMenu.style.top  = e.clientY + 'px';
    contextMenu.hidden = false;
});

map.on('click', () => { contextMenu.hidden = true; });

document.getElementById('cm-place').addEventListener('click', () => {
    if (contextLngLat) placePinAt(contextLngLat);
    contextMenu.hidden = true;
});

document.getElementById('cm-clear').addEventListener('click', () => {
    for (const pin of pins) pin.element.remove();
    pins = [];
    activeRoute = null;
    renderStreets(map, streetCache, svgEl, ctx());
    contextMenu.hidden = true;
});
