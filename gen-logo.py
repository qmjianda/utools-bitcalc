# 生成 bitcalc 插件图标（256x256 PNG）
# 设计：深色圆角底 + 2×2 位格，右上格为蓝色。
from PIL import Image, ImageDraw

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 外框与四格位图。
d.rounded_rectangle([4, 4, 252, 252], radius=58, fill=(15, 23, 42, 255))
d.rounded_rectangle([8, 8, 248, 248], radius=54, outline=(30, 41, 59, 255), width=3)

MARGIN = 36
GAP = 16
CELL = (SIZE - MARGIN * 2 - GAP) // 2
WHITE = (248, 250, 252, 255)
BLUE = (37, 99, 235, 255)

for row in range(2):
    for col in range(2):
        x0 = MARGIN + col * (CELL + GAP)
        y0 = MARGIN + row * (CELL + GAP)
        color = BLUE if row == 0 and col == 1 else WHITE
        d.rounded_rectangle(
            [x0, y0, x0 + CELL, y0 + CELL],
            radius=16,
            fill=color,
        )

img.save("logo.png")
print("logo.png generated:", img.size)
