"""生成菜单栏 / 托盘图标，输出到 assets/tray/。

图形与插件图标一致：圆角框里一个「>_」提示符。macOS 用模板图（黑色 + 透明，系统按明暗自动着色），
文件名带 Template 后缀；Windows、Linux 用彩色图。三种状态：normal、warn（右下角一个点）、error（右下角一个叉）。

用法：python scripts/generate-tray-icons.py（需要 Pillow）
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'tray'
SS = 8  # 先放大画再缩小，得到抗锯齿的边缘


def draw_glyph(size: int, color: tuple[int, int, int, int], state: str, background: tuple[int, int, int, int] | None) -> Image.Image:
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = big / 16  # 以 16 格为单位描述图形
    stroke = max(1, round(1.4 * u))
    if background is not None:
        d.rounded_rectangle([0.5 * u, 0.5 * u, 15.5 * u, 15.5 * u], radius=3.5 * u, fill=background)
    d.rounded_rectangle([1.5 * u, 2.5 * u, 14.5 * u, 13.5 * u], radius=2.5 * u, outline=color, width=stroke)
    d.line([(4.5 * u, 5.8 * u), (7 * u, 8 * u), (4.5 * u, 10.2 * u)], fill=color, width=stroke, joint='curve')
    d.line([(8.5 * u, 10.4 * u), (11.8 * u, 10.4 * u)], fill=color, width=stroke)
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
    OUT.mkdir(parents=True, exist_ok=True)
    black = (0, 0, 0, 255)
    white = (255, 255, 255, 255)
    brand = (65, 118, 230, 255)
    for state in ('normal', 'warn', 'error'):
        # macOS 模板图：16 px 与 @2x 的 32 px
        draw_glyph(16, black, state, None).save(OUT / f'tray-{state}Template.png')
        draw_glyph(32, black, state, None).save(OUT / f'tray-{state}Template@2x.png')
        # Windows、Linux：品牌色底 + 白色图形，深浅任务栏上都看得清
        draw_glyph(16, white, state, brand).save(OUT / f'tray-{state}.png')
        draw_glyph(32, white, state, brand).save(OUT / f'tray-{state}@2x.png')
    print('wrote', sorted(p.name for p in OUT.iterdir()))


if __name__ == '__main__':
    main()
