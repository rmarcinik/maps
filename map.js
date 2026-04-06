import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext';

// --- Geometry helpers (pure) ---

function segmentIntersection(p1, p2, e1, e2) {
    const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
    const dx2 = e2.x - e1.x, dy2 = e2.y - e1.y;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-10) return null;
    const dx3 = e1.x - p1.x, dy3 = e1.y - p1.y;
    const t = (dx3 * dy2 - dy3 * dx2) / denom;
    const u = (dx3 * dy1 - dy3 * dx1) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
}

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

function closestOnSegment(p1, p2, cx, cy) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - p1.x) * dx + (cy - p1.y) * dy) / len2));
    const x = p1.x + t * dx, y = p1.y + t * dy;
    return { x, y, dist: Math.hypot(x - cx, y - cy), angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

function snapAngle(angle) {
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return Math.round(angle / 45) * 45;
}

// Find the first intersection between two projected polylines (arrays of {x,y} points).
// Returns the intersection point and the angle of the second polyline at that point, or null.
function findPolylineIntersection(pts1, pts2) {
    for (let i = 0; i < pts1.length - 1; i++) {
        for (let j = 0; j < pts2.length - 1; j++) {
            const pt = segmentIntersection(pts1[i], pts1[i + 1], pts2[j], pts2[j + 1]);
            if (pt) {
                const angle = Math.atan2(pts2[j + 1].y - pts2[j].y, pts2[j + 1].x - pts2[j].x) * 180 / Math.PI;
                return { ...pt, angle };
            }
        }
    }
    return null;
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

// --- Label collision detection ---

// Font spec must match the CSS: font: 300 13px/1 "Inter" + letter-spacing: 0.06em
const LABEL_FONT = '300 13px Inter';
const LABEL_H    = 14;  // px — line-height (13) + 1px breathing room
const LETTER_SPC = 0.06 * 13; // em×size = px per character gap

const _measureCache = new Map(); // text → {w, h}

function measureLabel(text) {
    if (_measureCache.has(text)) return _measureCache.get(text);
    const p = prepareWithSegments(text, LABEL_FONT);
    let maxW = 0;
    walkLineRanges(p, Infinity, line => { if (line.width > maxW) maxW = line.width; });
    const w = maxW + LETTER_SPC * text.length;
    const result = { w, h: LABEL_H };
    _measureCache.set(text, result);
    return result;
}

// 4 corners of a rect (w×h) centered at (x,y) rotated by angleDeg, CCW.
function labelCorners(x, y, angleDeg, w, h) {
    const a = angleDeg * Math.PI / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const hw = w / 2, hh = h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
        x: x + lx * cos - ly * sin,
        y: y + lx * sin + ly * cos,
    }));
}

// Project a set of corners onto axis (ax, ay), return [min, max].
function projectCorners(corners, ax, ay) {
    const dots = corners.map(c => c.x * ax + c.y * ay);
    return [Math.min(...dots), Math.max(...dots)];
}

// SAT overlap test for two oriented bounding boxes (each 4 corners).
function obbsOverlap(c1, c2) {
    const axes = [
        { ax: c1[1].x - c1[0].x, ay: c1[1].y - c1[0].y },
        { ax: c1[3].x - c1[0].x, ay: c1[3].y - c1[0].y },
        { ax: c2[1].x - c2[0].x, ay: c2[1].y - c2[0].y },
        { ax: c2[3].x - c2[0].x, ay: c2[3].y - c2[0].y },
    ];
    for (const { ax, ay } of axes) {
        const [a0, a1] = projectCorners(c1, ax, ay);
        const [b0, b1] = projectCorners(c2, ax, ay);
        if (a1 < b0 || b1 < a0) return false;
    }
    return true;
}

// True if any corner of the OBB is within `buffer` px of any route segment.
function labelNearRoute(corners, routePts, buffer) {
    for (const corner of corners)
        for (let i = 0; i < routePts.length - 1; i++)
            if (closestOnSegment(routePts[i], routePts[i + 1], corner.x, corner.y).dist < buffer)
                return true;
    return false;
}

const ROUTE_BUFFER = 14; // px clearance between label edge and route line

// Suppress labels that overlap higher-priority labels or the route line.
// Turn labels (fromTurn:true) are anchors and are never removed.
function resolveCollisions(positions, routePts) {
    // Process: anchors first, then full-opacity, then dimmed.
    const sorted = [...positions.entries()].sort(([, a], [, b]) => {
        if (a.fromTurn !== b.fromTurn) return a.fromTurn ? -1 : 1;
        if (a.opacity  !== b.opacity)  return b.opacity - a.opacity;
        return a.label.length - b.label.length; // shorter names win ties
    });

    const placed = [];
    const result = new Map();

    for (const [name, pos] of sorted) {
        if (pos.fromTurn) {
            result.set(name, pos);
            const { w, h } = measureLabel(pos.label);
            placed.push(labelCorners(pos.x, pos.y, pos.angle, w, h));
            continue;
        }
        const { w, h } = measureLabel(pos.label);
        const corners = labelCorners(pos.x, pos.y, pos.angle, w, h);
        const blocked =
            placed.some(pc => obbsOverlap(corners, pc)) ||
            (routePts && labelNearRoute(corners, routePts, ROUTE_BUFFER));
        if (blocked) {
            result.set(name, { ...pos, opacity: 0 });
        } else {
            placed.push(corners);
            result.set(name, pos);
        }
    }
    return result;
}

// --- Road hierarchy ---

const SKIP_CLASSES = new Set([
    'path', 'track', 'footway', 'cycleway', 'steps', 'bridleway', 'pedestrian',
    'path_construction', 'track_construction', 'footway_construction', 'cycleway_construction',
]);

// Lower rank = more important. Roads not listed fall below service roads.
const ROAD_RANK = {
    motorway: 1, motorway_construction: 1,
    trunk: 2,    trunk_construction: 2,
    primary: 3,  primary_construction: 3,
    secondary: 4, secondary_construction: 4,
    tertiary: 5,  tertiary_construction: 5,
    minor: 6,
    service: 7,
};

function streetRank(cls) {
    return ROAD_RANK[cls] ?? 8;
}

// Routing cost multipliers. Lower = prefer this class.
// Highways get a large penalty so they're only used as a last resort.
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

// Penalty added per street change (~4 typical city-block lengths in degrees).
const TURN_COST = 0.002;

// Project all lines for a street to screen space (flat array of {x,y}).
function projectLines(map, lines) {
    return lines.flatMap(line => line.map(c => map.project(c)));
}

// --- Street intersection tree ---
//
// Each street is a node. Its label is placed at the intersection with its
// highest-ranked (lowest rank number) neighbour that has already been placed.
// Root nodes (no such neighbour) are labelled at the point closest to center.
//
// Returns Map<name, { pt: {x,y,angle} | null, rank, parentName: string | null }>
function buildStreetTree(map, streetCache) {
    const canvas = map.getCanvas();
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;

    // Project once, sort by rank ascending (most important first).
    const streets = [...streetCache.entries()]
        .map(([name, { lines, rank }]) => ({ name, rank, pts: projectLines(map, lines) }))
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    const tree = new Map();   // name → node
    const placed = [];        // streets whose labels are already decided (for intersection search)

    for (const street of streets) {
        // Find the closest-to-center point on this street for fallback / root placement.
        let closest = null;
        for (let i = 0; i < street.pts.length - 1; i++) {
            const cp = closestOnSegment(street.pts[i], street.pts[i + 1], cx, cy);
            if (!closest || cp.dist < closest.dist) closest = cp;
        }

        // Search already-placed streets for an intersection, preferring higher rank.
        let parentName = null;
        let intersectionPt = null;
        for (const parent of placed) {
            if (parent.rank >= street.rank) continue; // only attach to more important roads
            const pt = findPolylineIntersection(street.pts, parent.pts);
            if (pt) { parentName = parent.name; intersectionPt = pt; break; }
        }

        tree.set(street.name, {
            rank: street.rank,
            parentName,
            // Intersection point if found, otherwise closest-to-center on self.
            pt: intersectionPt ?? closest,
        });
        placed.push(street);
    }

    return tree;
}

// --- Label placement ---

const DIM = 0.2;

// Pixels to offset turn labels away from the path direction.
const TURN_LABEL_OFFSET = 28;

// Build a map of street name → screen-space label position derived from route turns.
// When a street appears in multiple turns, keep the one with the largest |turnAngle|.
// Labels are offset away from the direction of travel so they don't sit on the route line:
//   fromStreet → offset in the direction of inBearing (behind the turn, along the street we came from)
//   toStreet   → offset opposite outBearing (behind where we're going on the new street)
function turnLabelPositions(map, turns) {
    const out = new Map(); // name → {x, y, angle}
    const R = Math.PI / 180;
    for (const turn of turns) {
        const pt = map.project(turn.coord);

        // fromStreet: step in direction of inBearing (screen y is flipped vs lat)
        const fx =  Math.cos(turn.inBearing  * R) * TURN_LABEL_OFFSET;
        const fy = -Math.sin(turn.inBearing  * R) * TURN_LABEL_OFFSET;
        // toStreet: step opposite outBearing
        const tx = -Math.cos(turn.outBearing * R) * TURN_LABEL_OFFSET;
        const ty =  Math.sin(turn.outBearing * R) * TURN_LABEL_OFFSET;

        for (const [name, b, ox, oy] of [
            [turn.fromStreet, turn.inBearing,  fx, fy],
            [turn.toStreet,   turn.outBearing, tx, ty],
        ]) {
            if (!name) continue;
            const prev = out.get(name);
            if (!prev || Math.abs(turn.turnAngle) > prev.turnAngle) {
                out.set(name, { x: pt.x + ox, y: pt.y + oy, angle: snapAngle(b), turnAngle: Math.abs(turn.turnAngle) });
            }
        }
    }
    return out;
}

function computeLabelPositions(map, streetCache, { pins = [], route = null } = {}) {
    const tree    = buildStreetTree(map, streetCache);
    const turnPts = route ? turnLabelPositions(map, route.turns) : new Map();
    const pinPts  = pins.map(p => map.project(p.lngLat));
    const positions = new Map();

    for (const [name, { rank, parentName, pt }] of tree) {
        if (!pt) continue;

        // Route streets: prefer turn intersection position over tree position.
        const override = turnPts.get(name);
        const { x, y, angle } = override
            ? { x: override.x, y: override.y, angle: override.angle }
            : { x: pt.x, y: pt.y, angle: snapAngle(pt.angle) };

        // Opacity: route streets and streets near any pin are always full.
        let opacity;
        const nearPin = pinPts.some(p => Math.hypot(x - p.x, y - p.y) < 200);
        if (route) {
            opacity = (route.streets.has(name) || nearPin) ? 1 : (parentName ? (rank <= 5 ? 1 : DIM) : 1);
        } else if (nearPin) {
            opacity = 1;
        } else {
            opacity = parentName ? (rank <= 5 ? 1 : DIM) : 1;
        }

        positions.set(name, { x, y, angle, label: name, opacity, fromTurn: !!override });
    }

    // When a route is active, always show turn-intersection labels even if the
    // street isn't in the cache (e.g. zoomed out past the label layer).
    for (const [name, { x, y, angle }] of turnPts) {
        if (!positions.has(name))
            positions.set(name, { x, y, angle, label: name, opacity: 1, fromTurn: true });
    }

    return positions;
}

function positionLabels(map, streetCache, labelEls, overlay, ctx) {
    const raw = computeLabelPositions(map, streetCache, ctx);
    const routePts = ctx.route ? ctx.route.coords.map(c => map.project(c)) : null;
    const positions = resolveCollisions(raw, routePts);
    const visible = new Set();
    for (const [key, { x, y, angle, label, opacity }] of positions) {
        visible.add(key);
        if (!labelEls.has(key)) {
            const el = document.createElement("div");
            el.className = "street-label";
            el.textContent = label;
            overlay.appendChild(el);
            labelEls.set(key, el);
        }
        const el = labelEls.get(key);
        el.style.opacity = opacity;
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    }
    for (const [key, el] of labelEls) {
        if (!visible.has(key)) el.style.opacity = 0;
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
        const dist = Math.hypot(b[0]-a[0], b[1]-a[1]);
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
//
// turns: one entry per street change along the route:
//   { coord, fromStreet, toStreet, inBearing, outBearing, turnAngle }
//
// Bearings are in degrees, east=0, north=90, CCW positive (standard atan2).
// turnAngle is the signed angle from inBearing to outBearing, normalized to (-180, 180].
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
    const coords  = keys.map(k => nodes.get(k));
    const streets = new Set(keys.slice(1).map(k => prevStreet.get(k)).filter(Boolean));

    // Build turns: emit one entry wherever the street name changes.
    const turns = [];
    for (let i = 1; i < keys.length - 1; i++) {
        const fromStreet = prevStreet.get(keys[i]);
        const toStreet   = prevStreet.get(keys[i + 1]);
        if (fromStreet === toStreet) continue;
        const inBearing  = prevBearing.get(keys[i]);
        const outBearing = prevBearing.get(keys[i + 1]);
        turns.push({
            coord:      nodes.get(keys[i]),
            fromStreet,
            toStreet,
            inBearing,
            outBearing,
            turnAngle: normalizeAngle(outBearing - inBearing),
        });
    }

    return { coords, streets, turns };
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
    updateRouteLayer(activeRoute?.coords ?? []);

    repositionPins(map);
    positionLabels(map, streetCache, labelEls, overlay, { pins, route: activeRoute });
}

// Trim `dist` degrees off each end of a coordinate polyline.
function trimPolyline(coords, dist) {
    if (coords.length < 2) return coords;
    let pts = coords.slice();

    for (const forward of [true, false]) {
        let rem = dist;
        while (pts.length > 2) {
            const a = forward ? pts[0] : pts[pts.length - 2];
            const b = forward ? pts[1] : pts[pts.length - 1];
            const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (d <= rem) { rem -= d; forward ? pts.shift() : pts.pop(); }
            else {
                const t = rem / d;
                const np = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                if (forward) pts[0] = np; else pts[pts.length - 1] = np;
                break;
            }
        }
    }
    return pts;
}

// Offset in degrees to pull the route line away from the pin markers (~15 m).
const ROUTE_PIN_OFFSET = 0.00015;

function updateRouteLayer(coords) {
    const src = map.getSource('route');
    if (!src) return;
    const display = coords.length > 1 ? trimPolyline(coords, ROUTE_PIN_OFFSET) : [];
    src.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: display },
    });
}

// --- Street cache (slow path) ---

function refreshCache(map, streetCache, labelEls) {
    if (map.getZoom() < 14) {
        streetCache.clear();
        for (const el of labelEls.values()) el.remove();
        labelEls.clear();
        return streetCache;
    }
    const next = new Map();
    for (const f of map.queryRenderedFeatures({ layers: ["road-name-data"] })) {
        const name = f.properties.name;
        const type = f.geometry.type;
        if (!name || next.has(name)) continue;
        if (type !== "LineString" && type !== "MultiLineString") continue;
        if (SKIP_CLASSES.has(f.properties.class)) continue;
        const lines = type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
        next.set(name, { lines, rank: streetRank(f.properties.class) });
    }
    for (const [key, el] of labelEls) {
        if (!next.has(key)) { el.remove(); labelEls.delete(key); }
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
    container: "map",
    style: "style.json",
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

map.addControl(geolocate, "bottom-right");
map.on("load", () => {
    if (!initialPos) geolocate.trigger();
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ff3333', 'line-width': 3, 'line-opacity': 0.85 } });
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

const overlay = document.getElementById("street-labels");
let streetCache = new Map();
let labelEls    = new Map();
let pins        = [];
let activeRoute = null;

const ctx = () => ({ pins, route: activeRoute });

const refresh = () => {
    streetCache = refreshCache(map, streetCache, labelEls);
    positionLabels(map, streetCache, labelEls, overlay, ctx());
};

map.on("idle",    refresh);
map.on("load",    refresh);
map.on("move", () => {
    contextMenu.hidden = true;
    repositionPins(map);
    positionLabels(map, streetCache, labelEls, overlay, ctx());
});
map.on("moveend", () => {
    history.replaceState(null, "", "#" + formatUrlPosition(map.getCenter(), map.getZoom()));
});

window.addEventListener("hashchange", () => {
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
    updateRouteLayer([]);
    positionLabels(map, streetCache, labelEls, overlay, ctx());
    contextMenu.hidden = true;
});
