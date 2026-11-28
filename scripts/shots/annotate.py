"""
Compose marketing screenshots: app shot (left) + callout bullets (right).
Input : .shots/raw/*.png + .shots/raw/rects.json
Output: .shots/final/0N-*.png  (1600x1000)

Usage: python scripts/shots/annotate.py
"""

import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, '.shots', 'raw')
FINAL = os.path.join(ROOT, '.shots', 'final')
os.makedirs(FINAL, exist_ok=True)

W, H = 1600, 1000
DPR = 2

FONT_REG = 'C:/Windows/Fonts/msyh.ttc'
FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
ACCENT = (110, 168, 255, 255)
TEXT = (234, 241, 255, 255)
MUTED = (143, 162, 190, 255)
DIM = (104, 122, 148, 255)

SCENARIOS = [
    {
        'name': '01-hero',
        'num': '1',
        'title': '读数、位图、字段，都在一屏',
        'subtitle': 'HEX / DEC / OCT / BIN 四行，64 格位图，字段解码',
        'crop': ('main', 28),
        'bullets': [
            ('四进制读数', '点一行设为主进制，行尾按钮单独复制'),
            ('64 格位图', '点一下翻转这一位，位号标在格子上'),
            ('字段条', '定义过的字段显示在这里，点一下选中它的位段'),
        ],
    },
    {
        'name': '02-enable',
        'num': '2',
        'title': '拖选一段位，只读写这一段',
        'subtitle': '在位图上按住拖动，选区变成可读写的位使能',
        'crop': ('main', 28),
        'bullets': [
            ('框选 63:60', '读数只剩这 4 位：0x5 / 0101'),
            ('写 0x5 回车', '只改这 4 位，其他位不变'),
            ('扩展和其他操作', '扩到字节 / 16 / 32 位，或翻转、置 0、置 1'),
        ],
    },
    {
        'name': '03-fields',
        'num': '3',
        'title': '字段定义，写一行看一行',
        'subtitle': 'opcode 15:12、mode:4、flag 0:0，右边实时解码',
        'crop': ('dialog', '#fieldsDialog'),
        'bullets': [
            ('左边写定义', '一行一个，支持显式位段和游标分配'),
            ('右边看结果', 'U/S、HEX、BIN 跟着更新'),
            ('方案', '存成命名方案，JSON 导入导出'),
        ],
    },
    {
        'name': '04-history',
        'num': '4',
        'title': '每一步都能退回去',
        'subtitle': '表达式、位段写入、位翻转都会记一条，带前后值',
        'crop': ('dialog', '#historyDialog'),
        'bullets': [
            ('前后值', '每条记录都有 before → after'),
            ('恢复', '点恢复回到某一步'),
            ('快捷键', 'Ctrl / Cmd + Z 撤销，↑ / ↓ 翻表达式历史'),
        ],
    },
    {
        'name': '05-help',
        'num': '5',
        'title': '帮助就在插件里',
        'subtitle': '按 ? 打开：运算符、函数、字段语法、快捷键',
        'crop': ('dialog-window', '#helpDialog', 0.40, 1.0),
        'bullets': [
            ('函数表', '13 个函数和运算符优先级'),
            ('字段语法', '显式位段、游标分配、注释写法'),
            ('不联网', '本地运行，没有遥测和远程加载'),
        ],
    },
]


def load_fonts():
    fonts = {}
    try:
        fonts['reg'] = lambda s: ImageFont.truetype(FONT_REG, s)
        fonts['bold'] = lambda s: ImageFont.truetype(FONT_BOLD, s)
    except OSError:
        fonts['reg'] = lambda s: ImageFont.load_default()
        fonts['bold'] = fonts['reg']
    return fonts


def background():
    img = Image.new('RGB', (W, H), (9, 12, 20))
    top = Image.new('RGB', (W, H), (11, 17, 30))
    base = Image.new('L', (W, 1))
    for x in range(W):
        base.putpixel((x, 0), 0)
    gradient = Image.new('RGB', (1, H))
    for y in range(H):
        t = y / (H - 1)
        r = int(12 + (6 - 12) * t)
        g = int(18 + (9 - 18) * t)
        b = int(32 + (16 - 32) * t)
        gradient.putpixel((0, y), (r, g, b))
    img = gradient.resize((W, H))

    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-380, -420, 900, 520), fill=(58, 110, 240, 90))
    gd.ellipse((1050, 620, 1900, 1350), fill=(28, 70, 160, 55))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')

    # faint dot grid
    dots = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for y in range(0, H, 32):
        for x in range(0, W, 32):
            dd.point((x, y), fill=(120, 150, 200, 18))
    img = Image.alpha_composite(img.convert('RGBA'), dots).convert('RGB')
    return img


def crop_shot(shot, rect, mode, pad, frac=1.0, top=0.0):
    scale = DPR
    w = rect['w']
    h = rect['h'] * (frac - top)
    x0 = int((rect['x'] - pad) * scale)
    y0 = int((rect['y'] + rect['h'] * top - pad) * scale)
    x1 = int((rect['x'] + w + pad) * scale)
    y1 = int((rect['y'] + rect['h'] * top + h + pad) * scale)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(shot.width, x1), min(shot.height, y1)
    return shot.crop((x0, y0, x1, y1))


def fit(img, max_w, max_h):
    r = min(max_w / img.width, max_h / img.height)
    return img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))), Image.LANCZOS)


def rounded(img, radius):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius, fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def fade_edges(img, top_h, bottom_h):
    out = img.convert('RGBA')
    a = out.getchannel('A')
    px = a.load()
    for y in range(out.height):
        f = 1.0
        if y < top_h:
            f = y / top_h
        elif y > out.height - bottom_h:
            f = (out.height - y) / bottom_h
        if f < 1.0:
            for x in range(out.width):
                px[x, y] = int(px[x, y] * f)
    out.putalpha(a)
    return out


def wrap(text, font, max_w):
    lines = []
    cur = ''
    for ch in text:
        if ch == '\n':
            lines.append(cur)
            cur = ''
            continue
        trial = cur + ch
        if font.getlength(trial) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def draw_header(img, num, title, subtitle, fonts):
    d = ImageDraw.Draw(img)
    badge_x, badge_y = 64, 54
    d.ellipse((badge_x, badge_y, badge_x + 44, badge_y + 44), fill=ACCENT)
    f_num = fonts['bold'](24)
    tw = f_num.getlength(num)
    d.text((badge_x + 22 - tw / 2, badge_y + 8), num, font=f_num, fill=(10, 14, 22, 255))

    f_title = fonts['bold'](40)
    d.text((badge_x + 64, badge_y - 6), title, font=f_title, fill=TEXT)

    f_sub = fonts['reg'](20)
    d.text((badge_x + 64, badge_y + 48), subtitle, font=f_sub, fill=MUTED)


def draw_bullets(img, bullets, fonts, x, y, width):
    d = ImageDraw.Draw(img)
    f_h = fonts['bold'](22)
    f_b = fonts['reg'](17)
    cy = y
    for head, body in bullets:
        d.ellipse((x, cy + 8, x + 10, cy + 18), fill=ACCENT)
        d.text((x + 22, cy), head, font=f_h, fill=TEXT)
        cy += 34
        for line in wrap(body, f_b, width - 22):
            d.text((x + 22, cy), line, font=f_b, fill=DIM)
            cy += 27
        cy += 26
    return cy


def compose(sc, shot, rects, fonts, bg):
    item = dict((b['name'], b) for b in SCENARIOS)
    cfg = sc
    canvas = bg.copy()
    draw_header(canvas, cfg['num'], cfg['title'], cfg['subtitle'], fonts)

    mode = cfg['crop'][0]
    sel = cfg['crop'][1]
    top = 0.0
    if mode == 'main':
        rect = rects['#main']
        pad = sel
        frac = 1.0
    elif mode == 'dialog-window':
        rect = rects[sel]
        pad = 0
        top = cfg['crop'][2]
        frac = cfg['crop'][3]
    else:
        rect = rects[sel]
        pad = 0
        frac = 1.0

    cropped = crop_shot(shot, rect, mode, pad, frac, top)
    if mode in ('dialog', 'dialog-window'):
        card_w, card_h = 1000, 720
        img = fit(cropped, card_w, card_h)
        radius = 14
        if mode == 'dialog-window':
            img = fade_edges(img, 44, 56)
    else:
        card_w, card_h = 1000, 700
        img = fit(cropped, card_w, card_h)
        radius = 16

    card = rounded(img, radius)
    if mode == 'dialog-window':
        card = fade_edges(card, 44, 56)
    # shadow
    sh = Image.new('RGBA', (card.width + 80, card.height + 80), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((40, 44, 40 + card.width, 44 + card.height), radius=radius + 4, fill=(0, 0, 0, 170))
    sh = sh.filter(ImageFilter.GaussianBlur(24))

    left_x = 60
    area_top = 190
    area_h = 1000 - area_top - 40
    img_y = area_top + max(0, (area_h - card.height) // 2)
    img_x = left_x + max(0, (1000 - card.width) // 2)

    canvas.paste(sh, (img_x - 40, img_y - 44), sh)
    canvas.paste(card, (img_x, img_y), card)

    # hairline border
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle((img_x, img_y, img_x + card.width - 1, img_y + card.height - 1), radius=radius,
                        outline=(110, 150, 220, 70), width=1)

    # right column
    bx = 1140
    by = 200
    draw_bullets(canvas, cfg['bullets'], fonts, bx, by, 420)

    # footer brand
    f_small = fonts['reg'](16)
    d.text((64, 952), 'bitcalc · uTools 插件应用', font=f_small, fill=(95, 112, 138, 255))

    out = os.path.join(FINAL, cfg['name'] + '.png')
    canvas.convert('RGB').save(out, 'PNG', optimize=True)
    print('wrote', out, canvas.size)


def main():
    fonts = load_fonts()
    rects = json.load(open(os.path.join(RAW, 'rects.json'), encoding='utf-8'))
    bg = background()
    for cfg in SCENARIOS:
        shot = Image.open(os.path.join(RAW, cfg['name'] + '.png')).convert('RGB')
        compose(cfg, shot, rects[cfg['name']]['rects'], fonts, bg)


if __name__ == '__main__':
    main()
