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

import sys
import argparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

# ── constants ─────────────────────────────────────────────────────────────────

MIN_STREETS     = 5
MIN_BRIGHT      = 2   # streets with rank <= 3 (primary and above)

MIN_HIGHLIGHTED = 2
MAX_DIM_RATIO   = 0.85

# ── shared utilities ──────────────────────────────────────────────────────────

def wait_for_streets(page, timeout=15_000):
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('#street-svg text').length > 0",
            timeout=timeout,
        )
        return True
    except PlaywrightTimeout:
        return False


def wait_for_labels(page, timeout=15_000):
    try:
        page.wait_for_function(
            "() => [...document.querySelectorAll('.street-label')]"
            "      .some(el => parseFloat(el.style.opacity) > 0)",
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
        const { getStreetCache, getActiveRoute, streetStyle } = window._maps;
        const cache = getStreetCache();
        const route = getActiveRoute();
        const svg   = document.getElementById('street-svg');

        const results = [];
        for (const [name, { rank }] of cache) {
            const expected = streetStyle(name, rank, route, [], { x: 0, y: 0 });

            const visible = [...svg.querySelectorAll('text')].filter(t => {
                if (t.getAttribute('display') === 'none') return false;
                const tp = t.querySelector('textPath');
                if (!tp) return false;
                const pathEl = document.getElementById((tp.getAttribute('href') ?? '').slice(1));
                return pathEl?.getAttribute('data-name') === name;
            });
            if (!visible.length) continue;

            const el = visible[0];
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


# ── tests ─────────────────────────────────────────────────────────────────────

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

    bright = [s for s in streets if s['rank'] <= 3]
    if len(bright) < MIN_BRIGHT:
        failures.append(f"  only {len(bright)} primary+ streets visible — need >= {MIN_BRIGHT}")

    by_color = {}
    for s in streets:
        by_color[s['actualColor']] = by_color.get(s['actualColor'], 0) + 1
    print(f"  streets={len(streets)} bright={len(bright)} colors={by_color}")
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
    for s in after:
        if s['actualColor'] != s['expectedColor']:
            failures.append(
                f"  {s['name']!r}: color {s['actualColor']!r} != expected {s['expectedColor']!r}"
            )

    print(f"  red_before={len(red_before)} red_after={len(red_after)}: {[s['name'] for s in red_after]}")
    return not failures, failures


def test_labels(page):
    """Label highlighted/dim ratio."""
    if not wait_for_labels(page):
        return False, "no visible street labels appeared within 15s (server up? zoom >= 14?)"

    labels = page.query_selector_all(".street-label")
    highlighted, dimmed, hidden = [], [], []
    for el in labels:
        raw     = el.evaluate("e => e.style.opacity")
        opacity = float(raw) if raw != "" else 0.0
        text    = el.inner_text().strip()
        if opacity == 1.0:
            highlighted.append(text)
        elif opacity > 0.0:
            dimmed.append(text)
        else:
            hidden.append(text)

    total     = len(highlighted) + len(dimmed)
    dim_ratio = len(dimmed) / total if total > 0 else 1.0
    print(f"  highlighted={len(highlighted)} dimmed={len(dimmed)} hidden={len(hidden)} dim_ratio={dim_ratio:.0%}")

    failures = []
    if len(highlighted) < MIN_HIGHLIGHTED:
        failures.append(f"only {len(highlighted)} highlighted label(s) — need >= {MIN_HIGHLIGHTED}")
    if dim_ratio > MAX_DIM_RATIO:
        failures.append(f"dim ratio {dim_ratio:.0%} exceeds threshold {MAX_DIM_RATIO:.0%}")
    return not failures, failures


def test_pins(page):
    """Pin placement, route generation, cycling, and clear."""
    if not wait_for_labels(page):
        return False, "map did not load in time"

    pin_count = lambda: page.evaluate("() => document.querySelectorAll('.pin-marker').length")
    route_len = lambda: page.evaluate(
        "() => window._maps.map.getSource('route').serialize().data.geometry.coordinates.length"
    )

    failures = []

    place_pin(page, 400, 450)
    if pin_count() != 1:
        failures.append(f"after 1st pin: expected 1, got {pin_count()}")

    place_pin(page, 700, 450)
    page.wait_for_timeout(800)
    if pin_count() != 2:
        failures.append(f"after 2nd pin: expected 2, got {pin_count()}")
    if route_len() < 2:
        failures.append(f"after 2nd pin: expected route coords, got {route_len()}")

    place_pin(page, 550, 300)
    if pin_count() != 2:
        failures.append(f"after 3rd pin (cycle): expected 2, got {pin_count()}")

    page.evaluate("""() => {
        document.querySelector('#map canvas').dispatchEvent(
            new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:550, clientY:300})
        );
    }""")
    page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
    page.click("#cm-clear")
    page.wait_for_timeout(300)
    if pin_count() != 0:
        failures.append(f"after clear: expected 0 pins, got {pin_count()}")
    if route_len() != 0:
        failures.append(f"after clear: expected empty route, got {route_len()} coords")

    print(f"  pins after clear={pin_count()} route_coords={route_len()}")
    return not failures, failures


# ── runner ────────────────────────────────────────────────────────────────────

TESTS = {
    "streets": (test_streets, 390,  844),
    "route":   (test_route,  1280,  900),
    "labels":  (test_labels,  390,  844),
    "pins":    (test_pins,   1280,  900),
}


def run_all(url, only=None):
    names = [only] if only else list(TESTS)
    results = {}

    with sync_playwright() as p:
        for name in names:
            fn, w, h = TESTS[name]
            print(f"\n{name}")
            browser = p.chromium.launch()
            page    = browser.new_page(viewport={"width": w, "height": h})
            page.goto(url)
            passed, failures = fn(page)
            browser.close()

            if isinstance(failures, list):
                for f in failures:
                    print(f"  FAIL: {f.strip()}")
            elif failures:
                print(f"  FAIL: {failures}")

            results[name] = passed

    print("\n" + "─" * 30)
    for name, passed in results.items():
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    print("─" * 30)
    return all(results.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--only", choices=list(TESTS), help="run a single test suite")
    args = parser.parse_args()
    sys.exit(0 if run_all(args.url, args.only) else 1)
