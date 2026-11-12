"""Builds scripts/banner-glyphs.json: glyph outlines, advances and kerning
for the README banners, taken from the fonts the app bundles.

GitHub serves repository SVGs under a content policy that blocks embedded
fonts, so the banners set their type as vector paths instead. This script
only needs re-running when banners need characters the atlas lacks; the
banners themselves regenerate from the JSON with Node alone
(node scripts/make-banners.mjs).

Requires: pip install fonttools brotli uharfbuzz
Usage:    python scripts/build-glyph-atlas.py
"""
import io
import json
import pathlib
import re

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONTS = ROOT / "public" / "fonts"
OUT = ROOT / "scripts" / "banner-glyphs.json"

# Printable ASCII plus the few specials the Jamware spec labels use.
CHARS = [chr(c) for c in range(0x20, 0x7F)] + ["·", "×", "±", "→", "←", "↑", "↓", "•", "≤", "≥", "−", "©"]
# Pairs worth kerning in display type: letters, digits, common punctuation.
KERN_SET = (
    [chr(c) for c in range(ord("A"), ord("Z") + 1)]
    + [chr(c) for c in range(ord("a"), ord("z") + 1)]
    + list("0123456789.,-'") + [" "]
)


def to_ttf_bytes(font: TTFont) -> bytes:
    buf = io.BytesIO()
    font.flavor = None
    font.save(buf)
    return buf.getvalue()


def extract(font: TTFont, kern: bool) -> dict:
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    upm = font["head"].unitsPerEm
    os2 = font["OS/2"]
    glyphs = {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if name is None:
            continue
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        # Integer font units keep the atlas small; plenty at banner sizes.
        d = pen.getCommands()
        glyphs[ch] = {"d": round_path(d), "adv": gs[name].width}
    out = {
        "upm": upm,
        "ascender": os2.sTypoAscender,
        "descender": os2.sTypoDescender,
        "capHeight": getattr(os2, "sCapHeight", 0) or int(upm * 0.7),
        "glyphs": glyphs,
    }
    if kern:
        out["kern"] = kerning(to_ttf_bytes(font), [c for c in KERN_SET if c in glyphs])
    return out


TOKEN = re.compile(r"[MLHVQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def round_path(d: str) -> str:
    """SVGPathPen emits absolute M/L/H/V/Q/C/Z; round every number to an
    int and join compactly: "M1 2L3 4H9Z"."""
    res = ""
    for t in TOKEN.findall(d):
        if t in "MLHVQCZ":
            res += t
        else:
            res += ("" if res and res[-1] in "MLHVQCZ" else " ") + str(round(float(t)))
    return res


def kerning(ttf: bytes, chars: list) -> dict:
    face = hb.Face(ttf)
    font = hb.Font(face)

    def advances(text: str):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"kern": True, "liga": False})
        return [p.x_advance for p in buf.glyph_positions]

    single = {c: advances(c)[0] for c in chars}
    pairs = {}
    for a in chars:
        for b in chars:
            adv = advances(a + b)
            if len(adv) == 2:
                k = adv[0] - single[a]
                if k != 0:
                    pairs[a + b] = k
    return pairs


def main():
    archivo = TTFont(str(FONTS / "font-5.woff2"))
    # The app's display cut: font-stretch 125%, weight 800.
    display = instancer.instantiateVariableFont(archivo, {"wdth": 125, "wght": 800})
    atlas = {
        "display": extract(display, kern=True),
        "mono": extract(TTFont(str(FONTS / "font-10.woff2")), kern=False),
        "monoMedium": extract(TTFont(str(FONTS / "font-15.woff2")), kern=False),
    }
    OUT.write_text(json.dumps(atlas, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: "
          f"{len(atlas['display']['glyphs'])} display glyphs, "
          f"{len(atlas['display']['kern'])} kerning pairs, "
          f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
