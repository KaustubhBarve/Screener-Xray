"""
Screener X-Ray — Chrome Web Store assets.

Builds the 1280x800 screenshots and the 440x280 promo tile. Dev-only tooling.

Usage:  python tools/make-store-assets.py

Pipeline, end to end, so the assets can always be regenerated after a UI change:
    tools/make-screenshots.js  renders report.html against a saved fixture using
                               the real report.js and chart.js, and writes a
                               self-contained HTML file
    headless Chrome            screenshots that file at 1280 wide
    this script                crops the bands the store wants, and draws the tile

Everything shown in a screenshot is genuinely rendered by the shipped code
against a real saved screener.in page. Nothing here is a mockup, and nothing is
retouched — the only operation applied to a capture is a crop.
"""

import os
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
STORE = os.path.join(ROOT, 'store')
ICONS = os.path.join(ROOT, 'icons')

SHOT_W, SHOT_H = 1280, 800
CAPTURE_H = 4200

NAVY = (13, 26, 54, 255)
CYAN = (0, 178, 227, 255)
WHITE = (255, 255, 255, 255)
SKY = (168, 219, 240, 255)
MUTED = (150, 168, 190, 255)

CHROME_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

# (fixture, y offset into the tall capture, output name, what it shows)
SHOTS = [
    ('manufacturer-ASIANPAINT.html', 0, 'screenshot-1-one-pager.png',
     'The one-pager: description, trend sentences, reported figures'),
    ('manufacturer-ASIANPAINT.html', 580, 'screenshot-2-thesis-and-charts.png',
     'Your thesis, saved locally, above the derived charts'),
    ('lossmaker-IDEA.html', 2140, 'screenshot-3-refusals.png',
     'Derived measures refusing to print a misleading figure'),
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    sys.exit('Chrome not found. Add its path to CHROME_CANDIDATES.')


def font(size, bold=False):
    """Prefer the same family the report uses; fall back rather than crash."""
    for name in (('segoeuib.ttf', 'arialbd.ttf') if bold else ('segoeui.ttf', 'arial.ttf')):
        for base in (r'C:\Windows\Fonts', '/Library/Fonts', '/usr/share/fonts/truetype/dejavu'):
            p = os.path.join(base, name)
            if os.path.isfile(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def capture(chrome, fixture):
    """Render one fixture and screenshot it tall. Returns the PIL image."""
    html = os.path.join(STORE, '_report-%s.html' % fixture.split('-')[0])
    png = os.path.join(STORE, '_tall-%s.png' % fixture.split('-')[0])

    subprocess.run(['node', os.path.join(ROOT, 'tools', 'make-screenshots.js'), fixture, html],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    subprocess.run([chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--force-device-scale-factor=1',
                    '--window-size=%d,%d' % (SHOT_W, CAPTURE_H),
                    '--screenshot=' + png, 'file:///' + html.replace('\\', '/')],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Image.open(png).convert('RGB')


def screenshots():
    chrome = find_chrome()
    captured = {}
    for fixture, offset, name, caption in SHOTS:
        if fixture not in captured:
            captured[fixture] = capture(chrome, fixture)
        tall = captured[fixture]
        if offset + SHOT_H > tall.height:
            sys.exit('%s: offset %d exceeds the capture' % (name, offset))
        shot = tall.crop((0, offset, SHOT_W, offset + SHOT_H))
        out = os.path.join(STORE, name)
        shot.save(out, 'PNG', optimize=True)
        print('  %-38s %s  %s' % (name, shot.size, caption))


def promo_tile():
    """440x280 small promo tile."""
    W, H = 440, 280
    img = Image.new('RGBA', (W, H), NAVY)
    d = ImageDraw.Draw(img)

    # The cyan rule from the report masthead, as the tile's spine.
    d.rectangle([0, 0, 5, H], fill=CYAN)

    icon = Image.open(os.path.join(ICONS, 'icon128.png')).resize((72, 72), Image.LANCZOS)
    img.paste(icon, (34, 36), icon)

    d.text((122, 42), 'Screener', font=font(27), fill=WHITE)
    d.text((122, 72), 'X-Ray', font=font(27, bold=True), fill=CYAN)

    d.line([(34, 140), (W - 34, 140)], fill=(60, 80, 110, 255), width=1)

    d.text((34, 158), 'A printable one-pager for screener.in,', font=font(15), fill=SKY)
    d.text((34, 180), 'with your own notes.', font=font(15), fill=SKY)

    # The positioning, not a feature list. This is what makes it different.
    d.text((34, 218), 'No scores.  No ratings.  Nothing leaves your device.',
           font=font(13), fill=MUTED)

    out = os.path.join(STORE, 'promo-tile-440x280.png')
    img.convert('RGB').save(out, 'PNG', optimize=True)
    print('  %-38s (440, 280)  small promo tile' % 'promo-tile-440x280.png')


def main():
    os.makedirs(STORE, exist_ok=True)
    screenshots()
    promo_tile()
    print('\nstore/ assets built. Intermediates are prefixed _ and are not uploaded.')


if __name__ == '__main__':
    main()
