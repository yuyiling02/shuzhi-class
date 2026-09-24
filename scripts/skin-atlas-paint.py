"""
按解剖部位重绘皮肤图集贴图（v3，最终版）：
  1) 部位平涂（保留极轻的组织明暗），毛发部件纯平涂保证颜色统一
  2) top-hat 细线检测提取血管 → 动脉红 / 静脉蓝（只作用于真皮与皮下脂肪）
  3) 形态学开运算去噪点，再把颜色向外扩张填满图集空隙（避免双线性/多级渐远过滤出现黑边）
  4) 输出 4096² 与 2048² 两版，供体积/画质取舍

输出（scripts/_skin_src/）：
  atlas_painted_4096.png / .raw
  atlas_painted_2048.png / .raw
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ATLAS = 'scripts/_lod_img0.jpg'
MASK = 'scripts/_skin_src/uvmask_u8.raw'
SRC = 'scripts/_skin_src'
PREV = 'scripts/_skin_render'
S = 4096

PALETTE = {
    1: (0xEF, 0xD2, 0x64),   # part_0 皮下脂肪层
    2: (0xE3, 0xA4, 0x94),   # part_1 真皮层
    3: (0xF4, 0xE7, 0xC4),   # part_2 腺体
    4: (0x2A, 0x18, 0x0C),   # part_3 毛发（毛干+毛球）黑棕色
    5: (0xF2, 0xC8, 0xA0),   # part_4 表皮层（肉橘肤色）
    6: (0x2A, 0x18, 0x0C),   # part_5 毛囊（与毛发统一）
    7: (0x2A, 0x18, 0x0C),   # part_6 毛干（与 part_3 统一）
}
FLAT_PARTS = {4, 6, 7}
VESSEL_PARTS = {1, 2}
ARTERY = np.array([0xD9, 0x35, 0x2B], dtype=np.float32)
ARTERY_DARK = np.array([0x9E, 0x27, 0x22], dtype=np.float32)
VEIN = np.array([0x63, 0x82, 0xD6], dtype=np.float32)
VEIN_DARK = np.array([0x44, 0x5E, 0xA8], dtype=np.float32)

ROLLS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def shifts(m):
    return [np.roll(np.roll(m, dy, 0), dx, 1) for dy, dx in ROLLS]


def dilate(m, it=1):
    for _ in range(it):
        m = m.copy()
        for s in shifts(m if False else m):
            pass
        acc = m.copy()
        for dy, dx in ROLLS:
            acc |= np.roll(np.roll(m, dy, 0), dx, 1)
        m = acc
    return m


def erode(m, it=1):
    for _ in range(it):
        acc = m.copy()
        for dy, dx in ROLLS:
            acc &= np.roll(np.roll(m, dy, 0), dx, 1)
        m = acc
    return m


atlas = np.asarray(Image.open(ATLAS).convert('RGB')).astype(np.float32)
mask = np.fromfile(MASK, dtype=np.uint8).reshape(S, S)
covered = mask > 0
vessel_zone = np.isin(mask, list(VESSEL_PARTS))

# 1. 明暗细节（大半径模糊 → 柔和渐变，避免高频噪点导致贴图体积膨胀）
luma = 0.2126 * atlas[..., 0] + 0.7152 * atlas[..., 1] + 0.0722 * atlas[..., 2]
blur = np.asarray(Image.fromarray(np.clip(luma, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(16)), dtype=np.float32)
detail = np.clip(blur / max(1.0, blur[covered].mean()), 0.94, 1.07).astype(np.float32)

# 2. 血管条带（目标：连续条状脉络，不要点状）
#    思路：top-hat 找线 → 高斯模糊桥接碎点 → 核心|桥接 阈值 → 开运算去孤立噪点
#    → 闭运算把邻近线段连成条 → 再适度加宽成清晰条带
r, g, b = atlas[..., 0], atlas[..., 1], atlas[..., 2]
redness = r - np.maximum(g, b)
blueness = b - 0.5 * (r + g)


def tophat(ch, rad):
    bg = np.asarray(Image.fromarray(np.clip(ch + 128, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rad)), dtype=np.float32) - 128
    return ch - bg


def gauss(ch, rad):
    return np.asarray(Image.fromarray(np.clip(ch, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rad)), dtype=np.float32)


red_hot, blue_hot = tophat(redness, 12), tophat(blueness, 12)

# 桥接：对响应做模糊，邻近碎片连成脊线（阈值取分位数：真皮本身偏远红，
# 只有 top ~1% 的 top-hat 响应才是真正的血管线，不能靠 raw redness 判断）
red_soft = gauss(np.clip(red_hot + 64, 0, 255), 5) - 64
blue_soft = gauss(np.clip(blue_hot + 64, 0, 255), 5) - 64

a_core = (red_hot > 30) & (redness > 40) & vessel_zone
a_link = (red_soft > 13) & (red_hot > 12) & vessel_zone
v_core = (blue_hot > 26) & (blueness > 0) & vessel_zone
v_link = (blue_soft > 11) & (blue_hot > 8) & vessel_zone
a = a_core | a_link
v = v_core | v_link

# 密度滤波：只保留"成线"的像素（7x7 邻域内血管响应密集），滤掉孤立散点
a = erode(dilate(a, 3), 2)
v = erode(dilate(v, 3), 2)
# 去残留小斑
a = dilate(erode(a, 1), 1)
v = dilate(erode(v, 1), 1)
# 连条（闭运算：把断开的线段焊成连续脉络）
a = erode(dilate(a, 4), 4)
v = erode(dilate(v, 4), 4)

# 加宽成清晰条带（4px 芯 + 2px 更深的外缘，形成管状观感）
a_strong = dilate(a, 4)
v_strong = dilate(v, 4)
a_weak = dilate(a, 7) & ~a_strong
v_weak = dilate(v, 7) & ~v_strong

print(f'血管像素：动脉 {a_strong.sum()/1e6:.3f}M+{a_weak.sum()/1e6:.3f}M  静脉 {v_strong.sum()/1e6:.3f}M+{v_weak.sum()/1e6:.3f}M  '
      f'（覆盖区 {covered.sum()/1e6:.2f}M）')

# 3. 合成
out = np.zeros_like(atlas)
filled = np.zeros((S, S), dtype=bool)
for pid, color in PALETTE.items():
    sel = mask == pid
    if not sel.any():
        continue
    base = np.array(color, dtype=np.float32)
    d = np.ones_like(detail) if pid in FLAT_PARTS else detail
    out[sel] = base[None, :] * d[sel][:, None]
    filled |= sel

for m, c in ((a_weak, ARTERY_DARK), (a_strong, ARTERY), (v_weak, VEIN_DARK), (v_strong, VEIN)):
    out[m] = c[None, :] * detail[m][:, None]
    filled |= m

# 4. 空隙填充：把颜色向外平铺扩张，填满图集（避免边缘滤到黑）
FILL_ROUNDS = 30
for i in range(FILL_ROUNDS):
    if filled.all():
        break
    empty = ~filled
    for dy, dx in ROLLS:
        nf = np.roll(np.roll(filled, dy, 0), dx, 1)
        nv = np.roll(np.roll(out, dy, 0), dx, 1)
        take = empty & nf
        out[take] = nv[take]
        filled |= take
out[~filled] = np.array([0xE8, 0xD5, 0xC0], dtype=np.float32)
print(f'填充完成：未覆盖 texel 从 {100*(~covered).sum()/covered.size:.1f}% 降到 {100*(~filled).sum()/filled.size:.2f}%')

img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
for size in (4096, 2048):
    im = img if size == S else img.resize((size, size), Image.LANCZOS)
    im.save(f'{SRC}/atlas_painted_{size}.png', optimize=True)
    im.convert('RGB').save(f'{SRC}/atlas_painted_{size}.jpg', quality=92, subsampling=0)
    open(f'{SRC}/atlas_painted_{size}.raw', 'wb').write(im.convert('RGB').tobytes())
    png = os.path.getsize(f'{SRC}/atlas_painted_{size}.png') / 1024
    jpg = os.path.getsize(f'{SRC}/atlas_painted_{size}.jpg') / 1024
    print(f'atlas_painted_{size}: PNG {png:.0f} KB   JPEG {jpg:.0f} KB')

img.resize((1100, 1100), Image.LANCZOS).save(f'{PREV}/paint_atlas_preview.png')
