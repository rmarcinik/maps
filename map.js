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

function computeLabelPositions(map, streetCache) {
    const tree = buildStreetTree(map, streetCache);
    const positions = new Map();

    for (const [name, { rank, parentName, pt }] of tree) {
        if (!pt) continue;
        const angle = snapAngle(pt.angle);
        // Root streets (no parent) are full opacity. Children dim with depth.
        const opacity = parentName ? (rank <= 5 ? 1 : DIM) : 1;
        positions.set(name, { x: pt.x, y: pt.y, angle, label: name, opacity });
    }

    return positions;
}

function positionLabels(map, streetCache, labelEls, overlay) {
    const positions = computeLabelPositions(map, streetCache);
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
map.on("load", () => { if (!initialPos) geolocate.trigger(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

const overlay = document.getElementById("street-labels");
let streetCache = new Map();
let labelEls = new Map();

const refresh = () => {
    streetCache = refreshCache(map, streetCache, labelEls);
    positionLabels(map, streetCache, labelEls, overlay);
};

map.on("idle", refresh);
map.on("load", refresh);
map.on("move", () => positionLabels(map, streetCache, labelEls, overlay));
map.on("moveend", () => {
    history.replaceState(null, "", "#" + formatUrlPosition(map.getCenter(), map.getZoom()));
});

window.addEventListener("hashchange", () => {
    const pos = parseUrlPosition(location.hash);
    if (pos) map.jumpTo({ center: pos.center, zoom: pos.zoom });
});
