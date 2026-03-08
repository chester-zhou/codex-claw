#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
APP_ICON_DIR = ROOT / "iOSNote" / "Assets.xcassets" / "AppIcon.appiconset"
MASTER_SIZE = 1024
ICON_SPECS = [
    ("icon-20@2x.png", 40),
    ("icon-20@3x.png", 60),
    ("icon-29@2x.png", 58),
    ("icon-29@3x.png", 87),
    ("icon-40@2x.png", 80),
    ("icon-40@3x.png", 120),
    ("icon-60@2x.png", 120),
    ("icon-60@3x.png", 180),
    ("icon-1024.png", 1024),
]


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = (
        ["/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf"]
        if bold
        else ["/System/Library/Fonts/Supplemental/Arial.ttf"]
    )
    fallback = (
        ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
        if bold
        else ["/System/Library/Fonts/Geneva.ttf", "/System/Library/Fonts/Helvetica.ttc"]
    )

    for path in [*candidates, *fallback]:
        font_path = Path(path)
        if font_path.exists():
            return ImageFont.truetype(str(font_path), size=size)

    return ImageFont.load_default()


def draw_vertical_gradient(image: Image.Image, top_color: tuple[int, int, int], bottom_color: tuple[int, int, int]) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    for y in range(height):
        ratio = y / max(height - 1, 1)
        color = tuple(int(top + (bottom - top) * ratio) for top, bottom in zip(top_color, bottom_color))
        draw.line((0, y, width, y), fill=color)


def add_soft_orb(image: Image.Image, bbox: tuple[int, int, int, int], color: tuple[int, int, int, int], blur_radius: int) -> None:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(bbox, fill=color)
    image.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur_radius)))


def add_core_badge(base: Image.Image) -> None:
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((204, 198, 846, 860), radius=220, fill=(11, 18, 16, 92))
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(44)))

    badge = Image.new("RGBA", base.size, (0, 0, 0, 0))
    badge_draw = ImageDraw.Draw(badge)
    badge_draw.rounded_rectangle((214, 178, 830, 842), radius=210, fill=(18, 27, 24, 255))
    badge_draw.rounded_rectangle((254, 216, 790, 800), radius=186, outline=(63, 83, 76, 255), width=4)
    base.alpha_composite(badge)


def draw_claw_symbol(base: Image.Image) -> None:
    symbol = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(symbol)

    coral = (223, 110, 79, 255)
    cream = (244, 236, 224, 255)
    moss = (119, 145, 130, 255)

    draw.ellipse((360, 332, 650, 622), fill=cream)
    draw.ellipse((424, 396, 586, 558), fill=(18, 27, 24, 255))

    draw.rounded_rectangle((602, 338, 670, 560), radius=30, fill=coral)
    draw.rounded_rectangle((304, 414, 384, 478), radius=28, fill=coral)

    draw.polygon(((632, 262), (792, 356), (668, 438)), fill=coral)
    draw.polygon(((598, 282), (728, 250), (676, 408)), fill=coral)

    draw.rounded_rectangle((324, 572, 678, 624), radius=26, fill=moss)
    draw.rounded_rectangle((360, 650, 642, 688), radius=19, fill=(84, 106, 96, 255))
    draw.rounded_rectangle((388, 716, 594, 744), radius=14, fill=(84, 106, 96, 255))

    base.alpha_composite(symbol.filter(ImageFilter.GaussianBlur(0.4)))

    draw = ImageDraw.Draw(base)
    font = load_font(108, bold=True)
    draw.text((314, 164), "CC", font=font, fill=(240, 231, 218, 255))


def create_master_icon() -> Image.Image:
    base = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 255))
    draw_vertical_gradient(base, (232, 221, 205), (209, 196, 175))
    add_soft_orb(base, (566, 20, 1080, 440), (255, 255, 255, 90), 72)
    add_soft_orb(base, (-120, 706, 300, 1124), (169, 124, 96, 64), 60)
    add_core_badge(base)
    draw_claw_symbol(base)
    return base.convert("RGB")


def save_icons() -> None:
    APP_ICON_DIR.mkdir(parents=True, exist_ok=True)
    master = create_master_icon()
    master.save(APP_ICON_DIR / "icon-1024.png", format="PNG")

    for filename, size in ICON_SPECS:
        if filename == "icon-1024.png":
            continue
        resized = master.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(APP_ICON_DIR / filename, format="PNG")


if __name__ == "__main__":
    save_icons()
