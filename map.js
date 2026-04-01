// --- Geometry helpers (pure) ---

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

// For non-center streets: place at the endpoint nearest the preferred edge.
// Vertical streets prefer the top endpoint (min y); if the top endpoint is
// in the bottom half it means the street doesn't reach top, so fall back to bottom.
// Horizontal streets prefer left, fall back to right.
function preferredEndpoint(endpoints, angle, W, H) {
    if (Math.abs(angle) >= 45) {
        const sorted = [...endpoints].sort((a, b) => a.y - b.y);
        return sorted[0].y < H / 2 ? sorted[0] : sorted[sorted.length - 1];
    } else {
        const sorted = [...endpoints].sort((a, b) => a.x - b.x);
        return sorted[0].x < W / 2 ? sorted[0] : sorted[sorted.length - 1];
    }
}

// --- Label placement ---

function computeLabelPositions(map, streetCache) {
    const canvas = map.getCanvas();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const cx = W / 2, cy = H / 2;

    // Collect closest-to-center point and screen endpoints for each street
    const streetData = new Map();
    for (const [name, lines] of streetCache) {
        let closest = null;
        const endpoints = [];
        for (const line of lines) {
            const pts = line.map(c => map.project(c));
            endpoints.push(pts[0], pts[pts.length - 1]);
            for (let i = 0; i < pts.length - 1; i++) {
                const cp = closestOnSegment(pts[i], pts[i + 1], cx, cy);
                if (!closest || cp.dist < closest.dist) closest = cp;
            }
        }
        if (!closest) continue;
        streetData.set(name, { closest, angle: snapAngle(closest.angle), endpoints, dist: closest.dist });
    }

    // Single centermost street
    let centerName = null, minDist = Infinity;
    for (const [name, { dist }] of streetData) {
        if (dist < minDist) { minDist = dist; centerName = name; }
    }

    const positions = new Map();
    for (const [name, { closest, angle, endpoints }] of streetData) {
        let x, y;
        if (name === centerName) {
            // Offset slightly from center so the label isn't on top of the street
            const abs = Math.abs(angle);
            x = closest.x + (abs >= 45 ? -16 : 0);
            y = closest.y + (abs <= 45 ?  16 : 0);
        } else {
            const pt = preferredEndpoint(endpoints, angle, W, H);
            x = pt.x; y = pt.y;
        }
        const pad = 40;
        x = Math.max(pad, Math.min(W - pad, x));
        y = Math.max(pad, Math.min(H - pad, y));
        positions.set(name, { x, y, angle });
    }
    return positions;
}

function positionLabels(map, streetCache, labelEls, overlay) {
    if (map.getZoom() < 14) {
        for (const el of labelEls.values()) el.style.display = "none";
        return;
    }
    const positions = computeLabelPositions(map, streetCache);
    const visible = new Set();
    for (const [name, { x, y, angle }] of positions) {
        visible.add(name);
        if (!labelEls.has(name)) {
            const el = document.createElement("div");
            el.className = "street-label";
            el.textContent = name;
            overlay.appendChild(el);
            labelEls.set(name, el);
        }
        const el = labelEls.get(name);
        const abs = Math.abs(angle);
        const ox = abs >= 45 ? -8 : 0;
        const oy = abs <= 45 ?  8 : 0;
        el.style.display = "";
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) rotate(${angle}deg)`;
    }
    for (const [name, el] of labelEls) {
        if (!visible.has(name)) el.style.display = "none";
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
        next.set(name, type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates);
    }
    for (const [name, el] of labelEls) {
        if (!next.has(name)) { el.remove(); labelEls.delete(name); }
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
