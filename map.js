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

function computeLabelPositions(map, streetCache, { pins: activePins = [], routeStreets: routes = new Set() } = {}) {
    const tree = buildStreetTree(map, streetCache);
    const positions = new Map();

    for (const [name, { rank, parentName, pt }] of tree) {
        if (!pt) continue;
        const angle = snapAngle(pt.angle);

        let opacity;
        if (routes.size > 0) {
            // Two-pin mode: route streets always full, others normal hierarchy.
            opacity = routes.has(name) ? 1 : (parentName ? (rank <= 5 ? 1 : DIM) : 1);
        } else if (activePins.length === 1) {
            // One-pin mode: streets within 200px of pin skip the dim penalty.
            const pinPt = map.project(activePins[0].lngLat);
            const near = Math.hypot(pt.x - pinPt.x, pt.y - pinPt.y) < 200;
            opacity = (parentName && rank > 5 && !near) ? DIM : 1;
        } else {
            opacity = parentName ? (rank <= 5 ? 1 : DIM) : 1;
        }

        positions.set(name, { x: pt.x, y: pt.y, angle, label: name, opacity });
    }

    return positions;
}

function positionLabels(map, streetCache, labelEls, overlay, pinCtx) {
    const positions = computeLabelPositions(map, streetCache, pinCtx);
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
function buildRouteGraph(segments) {
    // segments: [{pts: [[lng,lat],...], name}]

    // 1. For every pair of polylines, find intersection points and record
    //    which segment index (along each polyline) they fall on.
    const cuts = segments.map(() => []); // cuts[i] = [{t, pt, j}] along polyline i

    for (let i = 0; i < segments.length; i++) {
        const A = segments[i].pts;
        for (let j = i + 1; j < segments.length; j++) {
            const B = segments[j].pts;
            for (let ai = 0; ai < A.length - 1; ai++) {
                for (let bj = 0; bj < B.length - 1; bj++) {
                    // Segment-segment intersection in geographic space (small area, linear ok)
                    const p1 = A[ai], p2 = A[ai + 1], p3 = B[bj], p4 = B[bj + 1];
                    const dx1 = p2[0]-p1[0], dy1 = p2[1]-p1[1];
                    const dx2 = p4[0]-p3[0], dy2 = p4[1]-p3[1];
                    const denom = dx1*dy2 - dy1*dx2;
                    if (Math.abs(denom) < 1e-12) continue;
                    const dx3 = p3[0]-p1[0], dy3 = p3[1]-p1[1];
                    const t = (dx3*dy2 - dy3*dx2) / denom;
                    const u = (dx3*dy1 - dy3*dx1) / denom;
                    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
                    const pt = [p1[0] + t*dx1, p1[1] + t*dy1];
                    cuts[i].push({ segIdx: ai, t, pt });
                    cuts[j].push({ segIdx: bj, t: u, pt });
                }
            }
        }
    }

    // 2. Split each polyline at its cut points, producing a list of sub-segments.
    const nodes = new Map(); // key → [lng,lat]
    const edges = new Map(); // key → [{to, dist, name}]
    const PREC = 1e6;
    const key = c => `${Math.round(c[0]*PREC)},${Math.round(c[1]*PREC)}`;

    const addEdge = (a, b, dist, name) => {
        if (!edges.has(a)) edges.set(a, []);
        edges.get(a).push({ to: b, dist, name });
    };

    const ensureNode = c => {
        const k = key(c);
        if (!nodes.has(k)) nodes.set(k, c);
        return k;
    };

    for (let i = 0; i < segments.length; i++) {
        const { pts, name } = segments[i];
        // Build ordered list of (segIdx, t, pt) for all points along this polyline.
        const chain = [];
        for (let s = 0; s < pts.length; s++) chain.push({ segIdx: s, t: 0, pt: pts[s] });
        for (const c of cuts[i]) chain.push(c);
        chain.sort((a, b) => a.segIdx - b.segIdx || a.t - b.t);

        for (let c = 0; c < chain.length - 1; c++) {
            const ka = ensureNode(chain[c].pt);
            const kb = ensureNode(chain[c + 1].pt);
            if (ka === kb) continue;
            const d = Math.hypot(chain[c].pt[0]-chain[c+1].pt[0], chain[c].pt[1]-chain[c+1].pt[1]);
            addEdge(ka, kb, d, name);
            addEdge(kb, ka, d, name);
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

function dijkstra(edges, startKey, endKey) {
    const dist = new Map([[startKey, 0]]);
    const prev = new Map();
    const prevStreet = new Map();
    const visited = new Set();
    const queue = [[0, startKey]];

    while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, u] = queue.shift();
        if (visited.has(u)) continue;
        visited.add(u);
        if (u === endKey) break;
        for (const { to, dist: w, name } of (edges.get(u) || [])) {
            const nd = d + w;
            if (!dist.has(to) || nd < dist.get(to)) {
                dist.set(to, nd);
                prev.set(to, u);
                prevStreet.set(to, name);
                queue.push([nd, to]);
            }
        }
    }

    if (!prev.has(endKey)) return null;

    const streets = new Set();
    const keys = [];
    let cur = endKey;
    while (cur !== startKey) {
        keys.unshift(cur);
        streets.add(prevStreet.get(cur));
        cur = prev.get(cur);
        if (cur === undefined) return null;
    }
    keys.unshift(startKey);
    return { keys, streets };
}

function computeRoute(map, pin1, pin2) {
    const features = map.queryRenderedFeatures({ layers: ['road-name-data'] });
    const segments = [];
    for (const f of features) {
        if (SKIP_CLASSES.has(f.properties.class)) continue;
        const type = f.geometry.type;
        const lines = type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const pts of lines) segments.push({ pts, name: f.properties.name || '' });
    }
    const { nodes, edges } = buildRouteGraph(segments);
    const start = nearestNode(nodes, pin1.lngLat);
    const end = nearestNode(nodes, pin2.lngLat);
    if (!start || !end) return null;
    const result = dijkstra(edges, start, end);
    if (!result) return null;
    const streets = new Set([...result.streets].filter(Boolean));
    return { coords: result.keys.map(k => nodes.get(k)), streets };
}

// --- Pin management ---

function repositionPins(map) {
    for (const pin of pins) {
        const pt = map.project(pin.lngLat);
        pin.element.style.left = pt.x + 'px';
        pin.element.style.top = pt.y + 'px';
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

    routeStreets = new Set();
    if (pins.length === 2) {
        const route = computeRoute(map, pins[0], pins[1]);
        routeStreets = route ? route.streets : new Set();
        updateRouteLayer(map, route ? route.coords : []);
    } else {
        updateRouteLayer(map, []);
    }

    repositionPins(map);
    positionLabels(map, streetCache, labelEls, overlay, { pins, routeStreets });
}

function updateRouteLayer(map, coords) {
    const src = map.getSource('route');
    if (!src) return;
    src.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.length > 1 ? coords : [] },
    });
}

// --- Cache (slow path) ---

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
let labelEls = new Map();
let pins = [];
let routeStreets = new Set();

const pinCtx = () => ({ pins, routeStreets });

const refresh = () => {
    streetCache = refreshCache(map, streetCache, labelEls);
    if (pins.length === 2) {
        const route = computeRoute(map, pins[0], pins[1]);
        routeStreets = route ? route.streets : new Set();
        updateRouteLayer(map, route ? route.coords : []);
    }
    positionLabels(map, streetCache, labelEls, overlay, pinCtx());
};

map.on("idle", refresh);
map.on("load", refresh);
map.on("move", () => {
    contextMenu.hidden = true;
    repositionPins(map);
    positionLabels(map, streetCache, labelEls, overlay, pinCtx());
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
    contextMenu.style.top = e.clientY + 'px';
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
    routeStreets = new Set();
    updateRouteLayer(map, []);
    positionLabels(map, streetCache, labelEls, overlay, pinCtx());
    contextMenu.hidden = true;
});
