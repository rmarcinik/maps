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

function pointInRect(p, r) {
    return p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;
}

// Extend a short label-anchor segment along its direction to span the full screen,
// so we test whether the road's LINE crosses the inner rect, not just the anchor.
function extendSegment(p1, p2, scale = 500) {
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    return [
        { x: cx - dx * scale, y: cy - dy * scale },
        { x: cx + dx * scale, y: cy + dy * scale },
    ];
}

function segmentRectIntersections(p1, p2, rect) {
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
    const edges = [
        [{ x: rect.x1, y: rect.y1 }, { x: rect.x2, y: rect.y1 }],
        [{ x: rect.x1, y: rect.y2 }, { x: rect.x2, y: rect.y2 }],
        [{ x: rect.x1, y: rect.y1 }, { x: rect.x1, y: rect.y2 }],
        [{ x: rect.x2, y: rect.y1 }, { x: rect.x2, y: rect.y2 }],
    ];
    return edges
        .map(([e1, e2]) => segmentIntersection(p1, p2, e1, e2))
        .filter(Boolean)
        .map(pt => ({ ...pt, angle }));
}

// --- Label placement ---

const DIM = 0.2;
const SKIP_CLASSES = new Set([
    'path', 'track', 'footway', 'cycleway', 'steps', 'bridleway', 'pedestrian',
    'path_construction', 'track_construction', 'footway_construction', 'cycleway_construction',
]);

function computeLabelPositions(map, streetCache) {
    const canvas = map.getCanvas();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const cx = W / 2, cy = H / 2;
    // Margin shrinks with zoom: 1/3 at z14 → 1/5 at z17+, so more streets are
    // highlighted as you zoom in and the visible area shrinks to a few blocks.
    const t = Math.max(0, Math.min(1, (map.getZoom() - 14) / 3));
    const margin = 1/3 + t * (1/5 - 1/3);
    const rect = { x1: W * margin, y1: H * margin, x2: W * (1 - margin), y2: H * (1 - margin) };

    const positions = new Map(); // key → { x, y, angle, label, opacity }

    for (const [name, lines] of streetCache) {
        const intersections = [];
        let closest = null;
        let anyInside = false;

        for (const line of lines) {
            const pts = line.map(c => map.project(c));
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i], p2 = pts[i + 1];
                intersections.push(...segmentRectIntersections(...extendSegment(p1, p2), rect));
                if (!anyInside && (pointInRect(p1, rect) || pointInRect(p2, rect))) anyInside = true;
                const cp = closestOnSegment(p1, p2, cx, cy);
                if (!closest || cp.dist < closest.dist) closest = cp;
            }
        }

        // Multiple extended anchor segments hit the same rect edge at slightly different
        // points — deduplicate by keeping one intersection per edge (left/right/top/bottom).
        const seen = new Set();
        const unique = intersections.filter(pt => {
            const eps = 0.5;
            pt.edge =
                Math.abs(pt.x - rect.x1) < eps ? 'L' :
                Math.abs(pt.x - rect.x2) < eps ? 'R' :
                Math.abs(pt.y - rect.y1) < eps ? 'T' : 'B';
            if (seen.has(pt.edge)) return false;
            seen.add(pt.edge);
            return true;
        });

        if (unique.length > 0) {
            unique.forEach((pt, i) => {
                const angle = snapAngle(pt.angle);
                const opacity = Math.abs(angle) === 45 ? DIM : 1;
                positions.set(name + "\x00" + i, { x: pt.x, y: pt.y, angle, label: name, opacity, edge: pt.edge });
            });
        } else if (closest) {
            // Inside rect (short street) or entirely outside — full or dim opacity
            const opacity = anyInside ? 1 : DIM;
            positions.set(name, { x: closest.x, y: closest.y, angle: snapAngle(closest.angle), label: name, opacity });
        }
    }

    return positions;
}

function positionLabels(map, streetCache, labelEls, overlay) {
    const positions = computeLabelPositions(map, streetCache);
    const visible = new Set();
    const ANCHOR = { L: '-100%,-50%', R: '0%,-50%', T: '-50%,-100%', B: '-50%,0%' };
    for (const [key, { x, y, angle, label, opacity, edge }] of positions) {
        visible.add(key);
        if (!labelEls.has(key)) {
            const el = document.createElement("div");
            el.className = "street-label";
            el.textContent = label;
            overlay.appendChild(el);
            labelEls.set(key, el);
        }
        const el = labelEls.get(key);
        const [tx, ty] = (ANCHOR[edge] ?? '-50%,-50%').split(',');
        el.style.opacity = opacity;
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.transform = `translate(${tx}, ${ty}) rotate(${angle}deg)`;
    }
    // Stale entries have no valid current position — hide rather than dim
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
        next.set(name, type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates);
    }
    for (const [key, el] of labelEls) {
        if (!next.has(key.split("\x00")[0])) { el.remove(); labelEls.delete(key); }
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
