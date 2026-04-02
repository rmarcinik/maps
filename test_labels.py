# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
#
# Usage:
#   uv run test_labels.py <url>
#
# First run needs browsers:
#   uv run --with playwright python -m playwright install chromium
#
# Example:
#   uv run test_labels.py "http://localhost:8080/#@41.9337355,-87.7022655,17.33z"

import sys
import argparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

DIM = 0.2
MIN_HIGHLIGHTED = 2      # at least this many labels at full opacity
MAX_DIM_RATIO   = 0.85   # fail if more than this fraction are dim


def get_opacity(el):
    raw = el.evaluate("e => e.style.opacity")
    return float(raw) if raw != "" else 0.0


def run(url):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.goto(url)

        # Wait until at least one label has a non-zero opacity (map settled + labels placed)
        try:
            page.wait_for_function(
                "() => [...document.querySelectorAll('.street-label')]"
                "      .some(el => parseFloat(el.style.opacity) > 0)",
                timeout=15_000,
            )
        except PlaywrightTimeout:
            print("FAIL: no visible street labels appeared within 15s")
            print("      (is the server running? is zoom >= 14?)")
            browser.close()
            return False

        labels = page.query_selector_all(".street-label")

        highlighted, dimmed, hidden = [], [], []
        for el in labels:
            text    = el.inner_text().strip()
            opacity = get_opacity(el)
            if opacity == 1.0:
                highlighted.append(text)
            elif opacity > 0.0:
                dimmed.append(text)
            else:
                hidden.append(text)

        page.screenshot(path="~/Downloads/test_screenshot.png")
        browser.close()

    total     = len(highlighted) + len(dimmed)
    dim_ratio = len(dimmed) / total if total > 0 else 1.0

    print(f"Highlighted  ({len(highlighted):2d}): {highlighted}")
    print(f"Dim          ({len(dimmed):2d}): {dimmed}")
    print(f"Hidden/stale ({len(hidden):2d}): {hidden}")
    print(f"Dim ratio: {dim_ratio:.0%}  ({len(dimmed)}/{total})")

    failures = []
    if len(highlighted) < MIN_HIGHLIGHTED:
        failures.append(
            f"only {len(highlighted)} highlighted label(s) — need >= {MIN_HIGHLIGHTED}"
        )
    if dim_ratio > MAX_DIM_RATIO:
        failures.append(
            f"dim ratio {dim_ratio:.0%} exceeds threshold {MAX_DIM_RATIO:.0%}"
        )

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return False

    print("PASS")
    return True


def place_pin(page, x, y):
    page.evaluate(f"""() => {{
        const canvas = document.querySelector('#map canvas');
        canvas.dispatchEvent(new MouseEvent('contextmenu', {{
            bubbles: true, cancelable: true, clientX: {x}, clientY: {y}
        }}));
    }}""")
    page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
    page.click("#cm-place")
    page.wait_for_timeout(300)


def run_pins(url):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(url)

        try:
            page.wait_for_function(
                "() => [...document.querySelectorAll('.street-label')]"
                "      .some(el => parseFloat(el.style.opacity) > 0)",
                timeout=15_000,
            )
        except PlaywrightTimeout:
            print("FAIL: map did not load in time")
            browser.close()
            return False

        def pin_count():
            return page.evaluate("() => document.querySelectorAll('.pin-marker').length")

        def route_coords():
            return page.evaluate(
                "() => map.getSource('route').serialize().data.geometry.coordinates.length"
            )

        failures = []

        # 1. Place first pin
        place_pin(page, 400, 450)
        if pin_count() != 1:
            failures.append(f"after 1st pin: expected 1 pin, got {pin_count()}")

        # 2. Place second pin — should produce a route
        place_pin(page, 700, 450)
        page.wait_for_timeout(800)
        if pin_count() != 2:
            failures.append(f"after 2nd pin: expected 2 pins, got {pin_count()}")
        if route_coords() < 2:
            failures.append(f"after 2nd pin: expected route coords, got {route_coords()}")

        # 3. Place third pin — oldest should be dropped (still 2)
        place_pin(page, 550, 300)
        if pin_count() != 2:
            failures.append(f"after 3rd pin (cycle): expected 2 pins, got {pin_count()}")

        # 4. Clear pins
        page.evaluate("""() => {
            const canvas = document.querySelector('#map canvas');
            canvas.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: 550, clientY: 300
            }));
        }""")
        page.wait_for_selector("#context-menu:not([hidden])", timeout=3000)
        page.click("#cm-clear")
        page.wait_for_timeout(300)
        if pin_count() != 0:
            failures.append(f"after clear: expected 0 pins, got {pin_count()}")
        if route_coords() != 0:
            failures.append(f"after clear: expected empty route, got {route_coords()} coords")

        page.screenshot(path="~/Downloads/test_screenshot_pins.png")
        browser.close()

    for f in failures:
        print(f"FAIL: {f}")
    if not failures:
        print("PASS")
    return not failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--pins", action="store_true", help="run pin placement tests")
    args = parser.parse_args()
    fn = run_pins if args.pins else run
    sys.exit(0 if fn(args.url) else 1)
