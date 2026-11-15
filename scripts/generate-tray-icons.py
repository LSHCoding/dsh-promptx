"""生成菜单栏 / 托盘图标，输出到 assets/tray/。

从 icon.svg 提取 P 字标和光标。macOS 用模板图（黑色 + 透明，系统按明暗自动着色），
文件名带 Template 后缀；Windows、Linux 用彩色图。三种状态：normal、warn（右下角一个点）、error（右下角一个叉）。

用法：python scripts/generate-tray-icons.py（需要 Pillow）
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'tray'
SS = 8  # 先放大画再缩小，得到抗锯齿的边缘


def load_monogram() -> Image.Image:
    root = ET.parse(ROOT / 'icon.svg').getroot()
    group = root.find('{http://www.w3.org/2000/svg}g')
    if group is None:
        raise ValueError('icon.svg 缺少 P 字标分组')
    paths = group.findall('{http://www.w3.org/2000/svg}path')
    if len(paths) != 2:
        raise ValueError('P 字标应包含轮廓和光标两条路径')

    # 当前 SVG 的轮廓使用 M/C/H/V/Z。遇到其他命令报错，避免输出缺笔的菜单栏图标。
    outline = ImageDraw.Outline()
    tokens = iter(re.findall(r'[A-Za-z]|-?\d+(?:\.\d+)?', paths[0].attrib['d']))
    x = y = 0.0
    for command in tokens:
        if command == 'M':
            x, y = float(next(tokens)), float(next(tokens))
            outline.move(x, y)
        elif command == 'C':
            points = [float(next(tokens)) for _ in range(6)]
            outline.curve(*points)
            x, y = points[-2:]
        elif command == 'H':
            x = float(next(tokens))
            outline.line(x, y)
        elif command == 'V':
            y = float(next(tokens))
            outline.line(x, y)
        elif command == 'Z':
            outline.close()
        else:
            raise ValueError(f'不支持的字标路径命令 {command}')

    glyph = Image.new('L', (1024, 1024), 0)
    draw = ImageDraw.Draw(glyph)
    draw.shape(outline, fill=255)
    cursor = re.fullmatch(r'M\s*([\d.]+)[ ,]+([\d.]+)\s*v\s*([\d.]+)', paths[1].attrib['d'])
    if cursor is None:
        raise ValueError('光标应为竖直线段')
    cx, top, height = map(float, cursor.groups())
    radius = float(paths[1].attrib['stroke-width']) / 2
    draw.rounded_rectangle([cx - radius, top - radius, cx + radius, top + height + radius], radius=radius, fill=255)
    # 原 SVG 对字标分组的平移、等比缩放在裁切后由菜单栏尺寸统一适配。
    bounds = glyph.getbbox()
    if bounds is None:
        raise ValueError('P 字标为空')
    return glyph.crop(bounds)


def draw_glyph(size: int, color: tuple[int, int, int, int], state: str, background: tuple[int, int, int, int] | None, glyph: Image.Image) -> Image.Image:
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = big / 16  # 以 16 格为单位描述图形
    if background is not None:
        d.rounded_rectangle([0.5 * u, 0.5 * u, 15.5 * u, 15.5 * u], radius=3.5 * u, fill=background)
    scale = min(13 * u / glyph.width, 14 * u / glyph.height)
    mask = glyph.resize((round(glyph.width * scale), round(glyph.height * scale)), Image.LANCZOS)
    img.paste(color, ((big - mask.width) // 2, (big - mask.height) // 2), mask)
    if state != 'normal':
        # 状态标记：先挖出一圈透明的边，再画实心点或叉
        cx, cy, r = 12.6 * u, 12.6 * u, 3.2 * u
        d.ellipse([cx - r - u, cy - r - u, cx + r + u, cy + r + u], fill=(0, 0, 0, 0))
        mark = color if background is None else ((231, 76, 60, 255) if state == 'error' else (245, 166, 35, 255))
        if state == 'warn':
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=mark)
        else:
            w = max(1, round(1.3 * u))
            d.line([(cx - r * 0.8, cy - r * 0.8), (cx + r * 0.8, cy + r * 0.8)], fill=mark, width=w)
            d.line([(cx - r * 0.8, cy + r * 0.8), (cx + r * 0.8, cy - r * 0.8)], fill=mark, width=w)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    glyph = load_monogram()
    OUT.mkdir(parents=True, exist_ok=True)
    black = (0, 0, 0, 255)
    white = (255, 255, 255, 255)
    brand = (65, 118, 230, 255)
    for state in ('normal', 'warn', 'error'):
        # macOS 模板图：16 px 与 @2x 的 32 px
        draw_glyph(16, black, state, None, glyph).save(OUT / f'tray-{state}Template.png')
        draw_glyph(32, black, state, None, glyph).save(OUT / f'tray-{state}Template@2x.png')
        # Windows、Linux：品牌色底 + 白色图形，深浅任务栏上都看得清
        draw_glyph(16, white, state, brand, glyph).save(OUT / f'tray-{state}.png')
        draw_glyph(32, white, state, brand, glyph).save(OUT / f'tray-{state}@2x.png')
    print('wrote', sorted(p.name for p in OUT.iterdir()))


if __name__ == '__main__':
    main()
