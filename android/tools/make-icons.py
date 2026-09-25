#!/usr/bin/env python3
"""Regenerates the Android launcher icons from the repository logo.

    python3 android/tools/make-icons.py

Needs Pillow (`pip install pillow`). Outputs:

  res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
  res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher_round.png
  res/drawable-xxhdpi/ic_launcher_foreground.png   (adaptive icon, API 26+)

The notification icon (`res/drawable/ic_notification.xml`) is a hand-written
vector and is not touched by this script.
"""

import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src", "main", "res")
LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "logo.webp")

# Sampled from the logo background (the orange disc).
PLATE = (18, 18, 18, 255)
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def circle_mask(size, supersample=4):
    mask = Image.new("L", (size * supersample, size * supersample), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * supersample - 1, size * supersample - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def round_icon(src, size):
    art = src.resize((size, size), Image.LANCZOS)
    art.putalpha(circle_mask(size))
    return art


def main():
    try:
        src = Image.open(LOGO).convert("RGBA")
    except FileNotFoundError:
        sys.exit("logo.webp not found at " + os.path.normpath(LOGO))

    for density, size in DENSITIES.items():
        folder = os.path.join(ROOT, f"mipmap-{density}")
        os.makedirs(folder, exist_ok=True)

        round_icon(src, size).save(os.path.join(folder, "ic_launcher_round.png"))

        plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(plate).rounded_rectangle(
            (0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=PLATE
        )
        plate.alpha_composite(round_icon(src, size))
        plate.save(os.path.join(folder, "ic_launcher.png"))
        print("wrote", folder, size)

    fg_folder = os.path.join(ROOT, "drawable-xxhdpi")
    os.makedirs(fg_folder, exist_ok=True)
    foreground = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    foreground.alpha_composite(src.resize((432, 432), Image.LANCZOS))
    foreground.save(os.path.join(fg_folder, "ic_launcher_foreground.png"))
    print("wrote", fg_folder, 432)


if __name__ == "__main__":
    main()
