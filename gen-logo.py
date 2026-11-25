# 生成 bitcalc 占位 logo（256x256 PNG）
# 设计：深色背景 + 8x8 bit 网格，部分格子点亮构成 "bit" 意象
from PIL import Image, ImageDraw

SIZE = 256
img = Image.new("RGB", (SIZE, SIZE), (24, 26, 36))  # 深蓝黑背景
d = ImageDraw.Draw(img)

# 8x8 网格，留边距
MARGIN = 32
GRID = 8
CELL = (SIZE - 2 * MARGIN) // GRID  # 24
GAP = 4

# 点亮图案：0b 二进制编码，行 0..7，每行 8 位（1 = 亮）
pattern = [
    0b11101110,
    0b00010001,
    0b11101110,
    0b00000000,
    0b11101010,
    0b11100000,
    0b11101010,
    0b11101110,
]

ON = (94, 234, 212)      # 亮青绿
OFF = (58, 62, 80)       # 暗灰

for row in range(GRID):
    for col in range(GRID):
        bit = (pattern[row] >> (GRID - 1 - col)) & 1
        x0 = MARGIN + col * CELL
        y0 = MARGIN + row * CELL
        color = ON if bit else OFF
        d.rounded_rectangle(
            [x0, y0, x0 + CELL - GAP, y0 + CELL - GAP],
            radius=3, fill=color,
        )

img.save("logo.png")
print("logo.png generated:", img.size)
