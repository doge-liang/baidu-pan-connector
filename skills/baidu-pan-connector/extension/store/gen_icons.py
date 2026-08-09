#!/usr/bin/env python3
"""Generate store icons (outputs PNG under ../icons/)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "icons"


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = max(1, size // 16)
    r = max(2, size // 5)
    bg = (15, 76, 129, 255)
    accent = (56, 189, 248, 255)
    soft = (148, 197, 255, 255)
    white = (255, 255, 255, 255)

    d.rounded_rectangle([m, m, size - m - 1, size - m - 1], radius=r, fill=bg)

    s = size
    cx, cy = s * 0.38, s * 0.52
    d.ellipse([cx - s * 0.22, cy - s * 0.12, cx + s * 0.08, cy + s * 0.18], fill=soft)
    d.ellipse([cx - s * 0.05, cy - s * 0.22, cx + s * 0.22, cy + s * 0.08], fill=white)
    d.ellipse([cx + s * 0.02, cy - s * 0.08, cx + s * 0.28, cy + s * 0.18], fill=soft)
    d.rounded_rectangle(
        [cx - s * 0.20, cy + s * 0.00, cx + s * 0.26, cy + s * 0.18],
        radius=max(1, s // 20),
        fill=white,
    )

    nx, ny = s * 0.72, s * 0.42
    d.line([(cx + s * 0.22, cy), (nx - s * 0.06, ny)], fill=accent, width=max(1, s // 14))
    nr = s * 0.14
    d.ellipse([nx - nr, ny - nr, nx + nr, ny + nr], fill=accent)
    ir = nr * 0.45
    d.polygon(
        [(nx, ny - ir), (nx + ir, ny), (nx, ny + ir), (nx - ir, ny)],
        fill=bg,
    )
    if size >= 48:
        dr = max(1, s // 28)
        d.ellipse(
            [
                nx + nr * 0.35,
                ny + nr * 0.35,
                nx + nr * 0.35 + dr * 2,
                ny + nr * 0.35 + dr * 2,
            ],
            fill=(34, 197, 94, 255),
        )
    return img


def main() -> None:
    for s in (16, 48, 128):
        path = OUT / f"icon{s}.png"
        make_icon(s).save(path, "PNG")
        print("wrote", path)

    promo = Image.new("RGBA", (440, 280), (15, 76, 129, 255))
    d = ImageDraw.Draw(promo)
    icon = make_icon(128)
    promo.paste(icon, (40, (280 - 128) // 2), icon)
    try:
        font = ImageFont.truetype("segoeui.ttf", 28)
        font_s = ImageFont.truetype("segoeui.ttf", 16)
    except OSError:
        font = ImageFont.load_default()
        font_s = font
    d.text((190, 95), "Baidu Pan", fill=(255, 255, 255, 255), font=font)
    d.text((190, 135), "Agent Connector", fill=(56, 189, 248, 255), font=font)
    d.text((190, 175), "Unofficial · Local Agent Bridge", fill=(180, 210, 240, 255), font=font_s)
    promo_path = OUT / "promo-440x280.png"
    promo.save(promo_path, "PNG")
    print("wrote", promo_path)


if __name__ == "__main__":
    main()
