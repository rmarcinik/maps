# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
#
# Usage:
#   uv run test_streets.py <url>
#   uv run test_streets.py <url> --route
#
# First run needs browsers:
#   uv run --with playwright python -m playwright install chromium
#
# Example:
#   uv run test_streets.py "http://localhost:8081/#@41.9434869,-87.7781155,15.59z"

import sys
import random
import argparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

SAMPLE_FRACTION = 0.3   # test ~30% of visible streets
MIN_SAMPLE      = 8     # but always at least this many
MIN_STREETS     = 5     # fail if fewer total streets visible
MIN_BRIGHT      = 2     # at least this many streets at rank-priority color (#888+)
VALID_COLORS    = {'#ff3333', '#ccc', '#888', '#666', '#444'}
VALID_OPACITIES = {0.6, 1.0}


def wait_for_streets(page, timeout=15_000):
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('#street-svg text').length > 0",
            timeout=timeout,
        )
        return True
    except PlaywrightTimeout:
        return False


def get_streets(page):
    """Read streets from SVG overlay, grouped by path (one entry per street)."""
    return page.evaluate("""() => {
        const byId = {};
        for (const el of document.querySelectorAll('#street-svg text')) {
            if (el.getAttribute('display') === 'none') continue;
            const tp = el.querySelector('textPath');
            if (!tp) continue;
            const id = (tp.getAttribute('href') ?? '').slice(1);
            if (!id) continue;
            if (!byId[id]) {
                const path = document.getElementById(id);
                const name = path?.getAttribute('data-name') ?? '';
                if (!name) continue;
                byId[id] = {
                    name:          name.toUpperCase(),
                    words:         [],
                    color:         el.getAttribute('fill'),
                    opacity:       parseFloat(el.getAttribute('fill-opacity') ?? '1'),
                    fontWeight:    String(el.getAttribute('font-weight')),
                    fontSize:      el.getAttribute('font-size'),
                    letterSpacing: el.getAttribute('letter-spacing'),
                };
            }
            const word = tp.textContent.trim();
            if (word) byId[id].words.push(word);
        }
        return Object.values(byId)
            .filter(s => s.name)
            .map(({ words, ...rest }) => ({ ...rest, content: words.join(' ') }));
    }""")


def sample(streets):
    n = max(MIN_SAMPLE, int(len(streets) * SAMPLE_FRACTION))
    return random.sample(streets, min(n, len(streets)))


def check_street(s, failures):
    if s['color'] not in VALID_COLORS:
        failures.append(f"  {s['name']!r}: unexpected fill {s['color']!r}")
    if s['opacity'] not in VALID_OPACITIES:
        failures.append(f"  {s['name']!r}: unexpected fill-opacity {s['opacity']}")
    if s['fontWeight'] != '900':
        failures.append(f"  {s['name']!r}: font-weight={s['fontWeight']!r}, want '900'")
    if not s['content']:
        failures.append(f"  {s['name']!r}: no words rendered on path")
    if not s['name'].isupper():
        failures.append(f"  {s['name']!r}: name not uppercase in textPath")


def color_counts(streets):
    return {c: sum(1 for s in streets if s['color'] == c) for c in VALID_COLORS}


def run(url):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.goto(url)

        if not wait_for_streets(page):
            print("FAIL: no street text elements within 15s (server up? zoom >= 14?)")
            browser.close()
            return False

        page.wait_for_timeout(500)
        streets = get_streets(page)

        failures = []

        if len(streets) < MIN_STREETS:
            failures.append(f"  only {len(streets)} streets visible — need >= {MIN_STREETS}")
            for f in failures:
                print(f"FAIL: {f.strip()}")
            browser.close()
            return False

        sampled = sample(streets)
        for s in sampled:
            check_street(s, failures)

        bright = [s for s in streets if s['color'] in ('#ff3333', '#ccc', '#888')]
        if len(bright) < MIN_BRIGHT:
            failures.append(f"  only {len(bright)} bright streets — need >= {MIN_BRIGHT}")

        page.screenshot(path="test_streets.png")
        browser.close()

    counts = color_counts(streets)
    print(f"Streets: {len(streets)} total, {len(sampled)} sampled")
    print(f"Colors:  {counts}")
    print(f"Bright:  {len(bright)}")

    for f in failures:
        print(f"FAIL:{f}")
    if not failures:
        print("PASS")
    return not failures


def place_pin(page, x, y):
    page.evaluate(f"""() => {{
        document.querySelector('#map canvas').dispatchEvent(
            new MouseEvent('contextmenu', {{bubbles:true, clientX:{x}, clientY:{y}}})
        );
    }}""")
    page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
    page.click("#cm-place")
    page.wait_for_timeout(400)


def run_route(url):
    """Place two pins and verify that route streets turn red."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(url)

        if not wait_for_streets(page):
            print("FAIL: map did not load in time")
            browser.close()
            return False

        page.wait_for_timeout(500)
        before = get_streets(page)
        red_before = [s for s in before if s['color'] == '#ff3333']

        place_pin(page, 400, 450)
        place_pin(page, 800, 450)
        page.wait_for_timeout(800)

        after  = get_streets(page)
        red_after = [s for s in after if s['color'] == '#ff3333']

        # Sample non-route streets and verify they kept valid colors.
        non_route = [s for s in after if s['color'] != '#ff3333']
        sampled   = sample(non_route) if non_route else []
        failures  = []
        for s in sampled:
            check_street(s, failures)

        if red_before:
            failures.append(
                f"  {len(red_before)} red streets before route: {[s['name'] for s in red_before]}"
            )
        if not red_after:
            failures.append("  no red streets after route — route coloring not applied")

        page.screenshot(path="test_streets_route.png")
        browser.close()

    print(f"Red before: {len(red_before)}")
    print(f"Red after ({len(red_after)}): {[s['name'] for s in red_after]}")

    for f in failures:
        print(f"FAIL:{f}")
    if not failures:
        print("PASS")
    return not failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--route", action="store_true", help="test route coloring via pins")
    args = parser.parse_args()
    fn = run_route if args.route else run
    sys.exit(0 if fn(args.url) else 1)
