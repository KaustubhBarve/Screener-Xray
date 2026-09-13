"""
Screener X-Ray — icon generator.

Draws the extension icons at every size Chrome asks for. Dev-only tooling; the
extension ships the PNGs in icons/, not this script.

Python rather than Node because Pillow is already on this machine and does
anti-aliased rounded corners properly. Writing a rasteriser in Node to avoid one
dev dependency would be more code than the thing it draws.

Usage:  python tools/make-icons.py

THE MARK
    Three ascending bars standing on a cyan baseline, on the report's own navy.
    It is the product's chart language, in the product's palette, so the toolbar
    icon and the document it generates read as the same thing.

    An earlier version used the masthead's vertical cyan rule to the LEFT of the
    bars. At 16px that rule is indistinguishable from a fourth, tallest bar, and
    the mark reads as a meaningless bar cluster. Moving the cyan to the baseline
    makes it an axis — something bars stand on rather than compete with — and the
    chart becomes legible at every size.

    The shortest bar is sky rather than white so the ascent reads as a gradient
    as well as a height. Making all three the same tint tested flatter; making
    two of them sky lost the shortest one against the navy at 16px.

LEGIBILITY
    16px drives every decision. Geometry is computed as whole pixels AT THE
    TARGET SIZE and only then scaled up for drawing, so every bar edge lands
    exactly on a pixel boundary after downsampling and nothing turns to mush.
    The rounded corner is the only thing allowed to anti-alias.
"""

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')
SIZES = [16, 32, 48, 128]
SS = 8  # supersample factor, for corner anti-aliasing only

NAVY = (13, 26, 54, 255)      # --navy-deep #0D1A36
CYAN = (0, 178, 227, 255)     # --cyan      #00B2E3
WHITE = (255, 255, 255, 255)
SKY = (168, 219, 240, 255)    # --sky       #A8DBF0

BAR_COLOURS = (SKY, WHITE, WHITE)
BAR_HEIGHTS = (0.42, 0.68, 1.0)


def geometry(s):
    """Whole-pixel layout for one target size."""
    pad = max(1, round(s * 0.115))
    top, bottom = pad, s - pad
    left, right = pad, s - pad

    axis_h = max(1, round(s * 0.07))
    base = bottom - axis_h            # bars stand on the axis, not through it

    bar_gap = max(1, round(s * 0.05))
    span = right - left
    bar_w = max(1, (span - 2 * bar_gap) // 3)
    bars_left = left + (span - (bar_w * 3 + bar_gap * 2)) // 2

    height = base - top
    bars = []
    for i, f in enumerate(BAR_HEIGHTS):
        h = max(2, round(height * f))  # the shortest bar stays visible at 16px
        x0 = bars_left + i * (bar_w + bar_gap)
        bars.append((x0, base - h, x0 + bar_w, base))

    return {
        'radius': round(s * 0.2),
        'axis': (left, base, right, bottom),
        'bars': bars,
    }


def draw_icon(s):
    g = geometry(s)
    img = Image.new('RGBA', (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    box = lambda rect: [c * SS for c in rect]

    d.rounded_rectangle([0, 0, s * SS - 1, s * SS - 1],
                        radius=g['radius'] * SS, fill=NAVY)
    d.rectangle(box(g['axis']), fill=CYAN)
    for rect, colour in zip(g['bars'], BAR_COLOURS):
        d.rectangle(box(rect), fill=colour)

    return img.resize((s, s), Image.LANCZOS)


def contact_sheet(out):
    """16px blown up (the real test), then native sizes on light and on dark.

    The strips show the toolbar sizes only. 128 is the store icon and is judged
    at full size, not squinted at next to a 16."""
    strip_sizes = [s for s in SIZES if s <= 48]
    blow, margin, gutter = 8, 20, 12
    row_w = margin * 2 + sum(s + gutter for s in strip_sizes) - gutter
    cell_w = max(margin * 2 + 16 * blow, row_w)
    sheet = Image.new('RGBA', (cell_w, 330), (245, 246, 248, 255))
    d = ImageDraw.Draw(sheet)
    d.rectangle([0, 210, cell_w, 330], fill=(30, 33, 40, 255))

    big = draw_icon(16).resize((16 * blow, 16 * blow), Image.NEAREST)
    sheet.paste(big, (margin, 16), big)

    x = margin
    for s in strip_sizes:
        icon = Image.open(os.path.join(out, 'icon%d.png' % s))
        sheet.paste(icon, (x, 208 - s), icon)   # light strip, bottom-aligned
        sheet.paste(icon, (x, 298 - s), icon)   # dark strip
        x += s + gutter

    sheet.save(os.path.join(out, '_preview.png'))


def main():
    out = os.path.abspath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        path = os.path.join(out, 'icon%d.png' % s)
        draw_icon(s).save(path, 'PNG', optimize=True)
        print('  icon%-5d %5d bytes' % (s, os.path.getsize(path)))
    contact_sheet(out)
    print('  preview   icons/_preview.png (16px blown up; native on light then dark)')


if __name__ == '__main__':
    main()
