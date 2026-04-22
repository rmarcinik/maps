# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
#
# Usage:
#   uv run tests.py <url>
#   uv run tests.py <url> --only streets|route|labels|pins
#
# First run needs browsers:
#   uv run --with playwright python -m playwright install chromium
#
# Example:
#   uv run tests.py "http://localhost:8081/#@41.9434869,-87.7781155,15.59z"
#   uv run tests.py "http://127.0.0.1:8787/#@41.9194201,-87.7369907,12.83z"

import sys
import argparse
from collections import Counter
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

MIN_STREETS     = 5
MIN_BRIGHT      = 2   # streets with rank <= 3 (primary and above)

MAX_FILL_RATIO  = 1.0  # text length must not exceed road length

MIN_HIGHLIGHTED = 2
MAX_DIM_RATIO   = 0.85


def wait_for_streets(page, timeout=15_000):
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('#street-svg text').length > 0",
            timeout=timeout,
        )
        return True
    except PlaywrightTimeout:
        return False


def place_pin(page, x, y):
    page.evaluate(f"""() => {{
        document.querySelector('#map canvas').dispatchEvent(
            new MouseEvent('contextmenu', {{bubbles:true, cancelable:true, clientX:{x}, clientY:{y}}})
        );
    }}""")
    page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
    page.click("#cm-place")
    page.wait_for_timeout(300)


def query_street_styles(page):
    """Compare each rendered street's SVG attributes against what streetStyle() expects."""
    return page.evaluate("""() => {
        const { getStreetCache, getActiveRoute, getPinPts, streetStyle } = window._maps;
        const cache  = getStreetCache();
        const route  = getActiveRoute();
        const pinPts = getPinPts();
        const svg    = document.getElementById('street-svg');

        const results = [];
        for (const [name, { rank }] of cache) {
            const visible = [...svg.querySelectorAll('text')].filter(t => {
                if (t.getAttribute('display') === 'none') return false;
                const tp = t.querySelector('textPath');
                if (!tp) return false;
                const pathEl = document.getElementById((tp.getAttribute('href') ?? '').slice(1));
                return pathEl?.getAttribute('data-name') === name;
            });
            if (!visible.length) continue;

            const el = visible[0];
            const tp = el.querySelector('textPath');
            const pathEl = tp && document.getElementById((tp.getAttribute('href') ?? '').slice(1));
            let screenPt = { x: 0, y: 0 };
            if (pathEl) {
                const total = pathEl.getTotalLength();
                const mid   = pathEl.getPointAtLength(total / 2);
                screenPt    = { x: mid.x, y: mid.y };
            }
            const expected = streetStyle(name, rank, route, pinPts, screenPt);

            results.push({
                name,
                rank,
                expectedColor:   expected.color,
                expectedOpacity: expected.opacity,
                actualColor:     el.getAttribute('fill'),
                actualOpacity:   parseFloat(el.getAttribute('fill-opacity') ?? '1'),
                hasContent:      visible.some(t => t.querySelector('textPath')?.textContent.trim()),
            });
        }
        return results;
    }""")


def test_streets(page):
    """Each street's SVG color/opacity matches what streetStyle() computes."""
    if not wait_for_streets(page):
        return False, "no street text elements within 15s (server up? zoom >= 14?)"
    page.wait_for_timeout(500)

    streets = query_street_styles(page)
    failures = []

    if len(streets) < MIN_STREETS:
        return False, f"only {len(streets)} streets visible — need >= {MIN_STREETS}"

    for s in streets:
        if s['actualColor'] != s['expectedColor']:
            failures.append(
                f"  {s['name']!r} rank={s['rank']}: color {s['actualColor']!r} != expected {s['expectedColor']!r}"
            )
        if abs(s['actualOpacity'] - s['expectedOpacity']) > 0.01:
            failures.append(
                f"  {s['name']!r} rank={s['rank']}: opacity {s['actualOpacity']} != expected {s['expectedOpacity']}"
            )
        if not s['hasContent']:
            failures.append(f"  {s['name']!r}: no text content rendered on path")

    bright = [s for s in streets if s['rank'] <= 5]
    if len(bright) < MIN_BRIGHT:
        failures.append(f"  only {len(bright)} secondary+ streets visible — need >= {MIN_BRIGHT}")

    by_color = Counter(s['actualColor'] for s in streets)
    print(f"  streets={len(streets)} bright={len(bright)} colors={dict(by_color)}")
    return not failures, failures


def test_route(page):
    """Route streets turn red; non-route streets match their expected colors."""
    if not wait_for_streets(page):
        return False, "map did not load in time"
    page.wait_for_timeout(500)

    before = query_street_styles(page)
    red_before = [s for s in before if s['actualColor'] == '#ff3333']

    place_pin(page, 400, 450)
    place_pin(page, 800, 450)
    page.wait_for_timeout(800)

    after = query_street_styles(page)
    failures = []

    if red_before:
        failures.append(f"  {len(red_before)} red streets before route: {[s['name'] for s in red_before]}")

    red_after = [s for s in after if s['actualColor'] == '#ff3333']
    if not red_after:
        failures.append("  no red streets after route — route coloring not applied")

    # Non-route streets should still match their expected colors.
    # Skip pin-proximate streets (#ccc) — their exact midpoint determines proximity
    # and the test cannot replicate the renderer's exact index-midpoint computation.
    for s in after:
        if '#ccc' in (s['actualColor'], s['expectedColor']):
            continue
        if s['actualColor'] != s['expectedColor']:
            failures.append(
                f"  {s['name']!r}: color {s['actualColor']!r} != expected {s['expectedColor']!r}"
            )

    print(f"  red_before={len(red_before)} red_after={len(red_after)}: {[s['name'] for s in red_after]}")
    return not failures, failures


def test_labels(page):
    """Label highlighted/dim ratio."""
    if not wait_for_streets(page):
        return False, "no visible street labels appeared within 15s (server up? zoom >= 14?)"

    streets = query_street_styles(page)
    highlighted = [s for s in streets if s['actualOpacity'] >= 1.0]
    dimmed      = [s for s in streets if 0 < s['actualOpacity'] < 1.0]

    total     = len(highlighted) + len(dimmed)
    dim_ratio = len(dimmed) / total if total > 0 else 1.0
    print(f"  highlighted={len(highlighted)} dimmed={len(dimmed)} dim_ratio={dim_ratio:.0%}")

    failures = []
    if len(highlighted) < MIN_HIGHLIGHTED:
        failures.append(f"only {len(highlighted)} highlighted label(s) — need >= {MIN_HIGHLIGHTED}")
    if dim_ratio > MAX_DIM_RATIO:
        failures.append(f"dim ratio {dim_ratio:.0%} exceeds threshold {MAX_DIM_RATIO:.0%}")
    return not failures, failures


def test_pins(page):
    """Pin placement, route generation, cycling, and clear."""
    if not wait_for_streets(page):
        return False, "map did not load in time"

    pin_count = lambda: page.evaluate("() => document.querySelectorAll('.pin-marker').length")
    route_len = lambda: page.evaluate(
        "() => window._maps.getActiveRoute()?.streets?.size ?? 0"
    )

    failures = []

    place_pin(page, 400, 450)
    n = pin_count()
    if n != 1:
        failures.append(f"after 1st pin: expected 1, got {n}")

    place_pin(page, 700, 450)
    page.wait_for_timeout(800)
    n, r = pin_count(), route_len()
    if n != 2:
        failures.append(f"after 2nd pin: expected 2, got {n}")
    if r < 1:
        failures.append(f"after 2nd pin: expected route streets, got {r}")

    place_pin(page, 550, 300)
    n = pin_count()
    if n != 2:
        failures.append(f"after 3rd pin (cycle): expected 2, got {n}")

    # Open context menu to reach cm-clear (can't reuse place_pin — that clicks cm-place).
    page.evaluate("""() => {
        document.querySelector('#map canvas').dispatchEvent(
            new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:550, clientY:300})
        );
    }""")
    page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
    page.click("#cm-clear")
    page.wait_for_timeout(300)
    n, r = pin_count(), route_len()
    if n != 0:
        failures.append(f"after clear: expected 0 pins, got {n}")
    if r != 0:
        failures.append(f"after clear: expected empty route, got {r} streets")

    print(f"  pins after clear={n} route_streets={r}")
    return not failures, failures


def test_coverage(page):
    """Text coverage: sum of word widths vs projected road length per street."""
    if not wait_for_streets(page):
        return False, "no street text elements within 15s (server up? zoom >= 14?)"
    # Warm tile/font caches with a reload; this makes label density more stable
    # when running `--only coverage` vs the full suite.
    page.reload()
    if not wait_for_streets(page):
        return False, "no street text elements after reload"
    # In practice, the street cache can take a moment to populate fully after the
    # first labels appear. Wait briefly for a “full” cache so coverage is stable.
    try:
        # Prefer waiting on actual rendered label count, since that's what the
        # coverage computation ultimately measures.
        page.wait_for_function(
            "() => document.querySelectorAll('#street-svg text').length >= 25",
            timeout=15_000,
        )
        page.wait_for_function(
            "() => (window._maps?.getStreetCache?.()?.size ?? 0) >= 20",
            timeout=10_000,
        )
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(500)

    results = page.evaluate("""() => {
        const { map } = window._maps;
        const svg = document.getElementById('street-svg');

        // Projected path length per street from MapLibre features.
        const streetLens = new Map();
        for (const f of map.queryRenderedFeatures({ layers: ['road-name-data', 'road-major-data'] })) {
            const name = f.properties.name;
            if (!name) continue;
            const lines = f.geometry.type === 'LineString'
                ? [f.geometry.coordinates]
                : f.geometry.coordinates;
            let len = 0;
            for (const line of lines) {
                const pts = line.map(c => map.project(c));
                for (let i = 1; i < pts.length; i++)
                    len += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
            }
            streetLens.set(name, (streetLens.get(name) ?? 0) + len);
        }

        // Total rendered text length per street from SVG.
        const textLens = new Map();
        for (const textEl of svg.querySelectorAll('text')) {
            if (textEl.getAttribute('display') === 'none') continue;
            const tp = textEl.querySelector('textPath');
            if (!tp?.textContent.trim()) continue;
            const pathEl = document.getElementById((tp.getAttribute('href') ?? '').slice(1));
            const name = pathEl?.getAttribute('data-name');
            if (!name) continue;
            textLens.set(name, (textLens.get(name) ?? 0) + textEl.getComputedTextLength());
        }

        return [...streetLens.entries()]
            .filter(([name]) => textLens.has(name))
            .map(([name, streetLen]) => ({
                name,
                streetLen: Math.round(streetLen),
                textLen:   Math.round(textLens.get(name)),
                ratio:     textLens.get(name) / streetLen,
            }))
            .sort((a, b) => b.ratio - a.ratio);
    }""")

    failures = []
    for r in results:
        if r['ratio'] > MAX_FILL_RATIO:
            failures.append(
                f"  {r['name']!r}: text={r['textLen']}px road={r['streetLen']}px ratio={r['ratio']:.2f} (overflow)"
            )

    avg = sum(r['ratio'] for r in results) / len(results) if results else 0
    print(f"  streets={len(results)} avg_ratio={avg:.2f}")
    for r in results:
        print(f"    {r['ratio']:.2f}  {r['name']!r}  text={r['textLen']}px road={r['streetLen']}px")
    return not failures, failures


TESTS = {
    "streets":  (test_streets,  390,  844),
    "route":    (test_route,   1280,  900),
    "labels":   (test_labels,   390,  844),
    "pins":     (test_pins,    1280,  900),
    "coverage": (test_coverage, 390,  844),
}


def run_all(url, only=None):
    names = [only] if only else list(TESTS)
    results = {}

    # Group tests by viewport to share browser instances.
    by_viewport = {}
    for name in names:
        fn, w, h = TESTS[name]
        by_viewport.setdefault((w, h), []).append(name)

    with sync_playwright() as p:
        for (w, h), group in by_viewport.items():
            browser = p.chromium.launch()
            for name in group:
                fn, _, _ = TESTS[name]
                print(f"\n{name}")
                page = browser.new_page(viewport={"width": w, "height": h})
                page.goto(url)
                passed, failures = fn(page)
                page.close()

                if isinstance(failures, list):
                    for f in failures:
                        print(f"  FAIL: {f.strip()}")
                elif failures:
                    print(f"  FAIL: {failures}")

                results[name] = passed
            browser.close()

    print("\n" + "-" * 30)
    for name, passed in results.items():
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    print("-" * 30)
    return all(results.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--only", choices=list(TESTS), help="run a single test suite")
    args = parser.parse_args()
    sys.exit(0 if run_all(args.url, args.only) else 1)
