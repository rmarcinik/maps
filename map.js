import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext';

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
    const p = prepareWithSegments(text, `900 ${size}px Inter`);
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

const SEP = '  ·  ';
const NS  = 'http://www.w3.org/2000/svg';

function streetFontSize(rank) {
    if (rank <= 2) return 16;
    if (rank <= 3) return 13;
    if (rank <= 5) return 11;
    return 10;
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

function repeatText(name, pathPx, unitPx) {
    const unit = name.toUpperCase() + SEP;
    return unit.repeat(Math.ceil(pathPx / unitPx) + 1);
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

// name → { pathEl, textEl, tp } — reused across renders.
const _streetEls = new Map();
let _defsEl   = null;
let _idCounter = 0;

function renderStreets(map, streetCache, svgEl, { pins = [], route = null } = {}) {
    svgEl.style.transform = '';
    if (!_defsEl) {
        _defsEl = document.createElementNS(NS, 'defs');
        svgEl.prepend(_defsEl);
    }

    const pinPts = pins.map(p => map.project(p.lngLat));
    const seen   = new Set();

    for (const [name, { lines, rank }] of streetCache) {
        seen.add(name);

        const { pts: rawPts, len } = longestLine(lines, map);
        const pts = orientPts(rawPts);
        const mid = pts[Math.floor(pts.length / 2)];

        const { color, opacity, fontSize } = streetStyle(name, rank, route, pinPts, mid);
        const unit    = name.toUpperCase() + SEP;
        const content = repeatText(name, len, measureLabel(unit, fontSize).w);

        let els = _streetEls.get(name);
        if (!els) {
            const pathEl = document.createElementNS(NS, 'path');
            pathEl.setAttribute('fill', 'none');
            const id = 'sp' + _idCounter++;
            pathEl.id = id;

            const tp     = document.createElementNS(NS, 'textPath');
            tp.setAttribute('href', '#' + id);

            const textEl = document.createElementNS(NS, 'text');
            textEl.setAttribute('font-family', 'Inter, sans-serif');
            textEl.setAttribute('font-weight', '900');
            textEl.setAttribute('letter-spacing', '2');
            textEl.appendChild(tp);

            _defsEl.appendChild(pathEl);
            svgEl.appendChild(textEl);
            els = { pathEl, textEl, tp };
            _streetEls.set(name, els);
        }

        els.pathEl.setAttribute('d', pathD(pts));
        els.textEl.setAttribute('fill', color);
        els.textEl.setAttribute('fill-opacity', opacity);
        els.textEl.setAttribute('font-size', fontSize);
        els.tp.textContent = content;
    }

    // Remove elements for streets no longer visible.
    for (const [name, { pathEl, textEl }] of _streetEls) {
        if (!seen.has(name)) {
            pathEl.remove();
            textEl.remove();
            _streetEls.delete(name);
        }
    }
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
    // Filter to streets whose longest projected segment meets the minimum length.
    const next = new Map();
    for (const [name, entry] of raw) {
        const { len } = longestLine(entry.lines, map);
        if (len >= MIN_LABEL_PX) next.set(name, entry);
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
