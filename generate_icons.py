from PIL import Image, ImageDraw, ImageFont
import os

FONT_PATH = 'C:/Windows/Fonts/msyh.ttc'
BG = '#dc2626'
FG = '#ffffff'


def make_icon(size, top_text, bottom_text, out_path):
    img = Image.new('RGB', (size, size), BG)
    draw = ImageDraw.Draw(img)
    # choose font sizes relative to icon
    top_size = int(size * 0.30)
    bot_size = int(size * 0.22)
    top_font = ImageFont.truetype(FONT_PATH, top_size)
    bot_font = ImageFont.truetype(FONT_PATH, bot_size)

    # top text
    bbox = draw.textbbox((0, 0), top_text, font=top_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, size * 0.18 - th / 2), top_text, font=top_font, fill=FG)

    # bottom text
    bbox = draw.textbbox((0, 0), bottom_text, font=bot_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, size * 0.68 - th / 2), bottom_text, font=bot_font, fill=FG)

    img.save(out_path)
    print(out_path)


os.makedirs('icons', exist_ok=True)
make_icon(192, 'HICC', '实测实量', 'icons/icon-192.png')
make_icon(512, 'HICC', '实测实量', 'icons/icon-512.png')
