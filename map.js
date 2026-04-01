// --- Geometry helpers (pure) ---

function circleSegmentIntersections(p1, p2, cx, cy, r) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const fx = p1.x - cx, fy = p1.y - cy;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a === 0) return [];
    const sq = Math.sqrt(disc);
    return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
        .filter((t) => t >= 0 && t <= 1)
        .map((t) => ({ x: p1.x + t * dx, y: p1.y + t * dy }));
}

function closestOnSegment(p1, p2, cx, cy) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - p1.x) * dx + (cy - p1.y) * dy) / len2));
    const x = p1.x + t * dx, y = p1.y + t * dy;
    return { x, y, dist: Math.hypot(x - cx, y - cy), angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

function buildFoci(W, H) {
    return [{ x: W / 2, y: H / 2, r: Math.min(W, H) * 0.4 }];
}

// --- Label placement (depends on map state) ---

function computePlacements(map, streetCache, foci) {
    const placements = new Map();
    for (const [name, lines] of streetCache) {
        let edgePt = null, closestPt = null;
        for (const focus of foci) {
            for (const line of lines) {
                const pts = line.map((c) => map.project(c));
                for (let i = 0; i < pts.length - 1; i++) {
                    const p1 = pts[i], p2 = pts[i + 1];
                    const cp = closestOnSegment(p1, p2, focus.x, focus.y);
                    if (cp.dist < focus.r) {
                        if (!closestPt || cp.dist < closestPt.dist) closestPt = cp;
                        if (!edgePt) {
                            const crosses = circleSegmentIntersections(p1, p2, focus.x, focus.y, focus.r);
                            if (crosses.length) edgePt = { ...crosses[0], angle: cp.angle };
                        }
                    }
                }
            }
        }
        if (!closestPt) continue;
        let angle = closestPt.angle;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        angle = Math.round(angle / 45) * 45;
        placements.set(name, { edgePt: edgePt ?? closestPt, closestPt, dist: closestPt.dist, angle });
    }
    return placements;
}

function nearestPerAxis(placements) {
    const axisNearest = new Map();
    for (const [name, p] of placements) {
        const axis = p.angle === -90 ? 90 : p.angle;
        const cur = axisNearest.get(axis);
        if (!cur || p.dist < placements.get(cur).dist) axisNearest.set(axis, name);
    }
    return new Set(axisNearest.values());
}

function applyLabelPositions(placements, centerStreets, labelEls, overlay) {
    const visible = new Set();
    for (const [name, p] of placements) {
        visible.add(name);
        const pt = centerStreets.has(name) ? p.closestPt : p.edgePt;
        if (!labelEls.has(name)) {
            const el = document.createElement("div");
            el.className = "street-label";
            el.textContent = name;
            overlay.appendChild(el);
            labelEls.set(name, el);
        }
        const el = labelEls.get(name);
        el.style.display = "";
        el.style.left = pt.x + "px";
        el.style.top = pt.y + "px";
        const abs = Math.abs(p.angle);
        const ox = abs >= 45 ? -8 : 0;
        const oy = abs <= 45 ? 8 : 0;
        el.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) rotate(${p.angle}deg)`;
    }
    for (const [name, el] of labelEls) {
        if (!visible.has(name)) el.style.display = "none";
    }
}

// --- Slow/fast path orchestration ---

function refreshCache(map, streetCache, labelEls) {
    if (map.getZoom() < 14) {
        streetCache.clear();
        for (const el of labelEls.values()) el.remove();
        labelEls.clear();
        return;
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

function positionLabels(map, streetCache, labelEls, overlay) {
    if (map.getZoom() < 14) {
        for (const el of labelEls.values()) el.style.display = "none";
        return;
    }
    const canvas = map.getCanvas();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const foci = buildFoci(W, H);
    const placements = computePlacements(map, streetCache, foci);
    const centerStreets = nearestPerAxis(placements);
    applyLabelPositions(placements, centerStreets, labelEls, overlay);
}

// --- Init ---

const map = new maplibregl.Map({
    container: "map",
    style: "style.json",
    center: [0, 20],
    zoom: 2,
    attributionControl: { compact: true },
    pitchWithRotate: false,
});

const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
});

map.addControl(geolocate, "bottom-right");
map.on("load", () => geolocate.trigger());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

const overlay = document.getElementById("street-labels");
let streetCache = new Map();
let labelEls = new Map();

const refresh = () => {
    const next = refreshCache(map, streetCache, labelEls);
    if (next) streetCache = next;
    positionLabels(map, streetCache, labelEls, overlay);
};

map.on("idle", refresh);
map.on("load", refresh);
map.on("move", () => positionLabels(map, streetCache, labelEls, overlay));
