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

        page.screenshot(path="test_screenshot.png")
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


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"usage: uv run {sys.argv[0]} <url>")
        sys.exit(1)
    sys.exit(0 if run(sys.argv[1]) else 1)
