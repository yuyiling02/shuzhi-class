"""分析皮肤图集贴图，统计 HSV 分布并用阈值分离血管像素，输出掩码与调色预览。"""
import colorsys
import numpy as np
from PIL import Image

SRC_TEX = 'scripts/_skin_src/part_0_basecolor.png'   # pbr-src 的 diffuse（7 部件共用）
ALT_TEX = 'scripts/_lod_img0.jpg'                    # interactive-lod 的 basecolor
OUT = 'scripts/_skin_render'

a = np.asarray(Image.open(SRC_TEX).convert('RGB'))
print('pbr-src diffuse:', a.shape, a.dtype)

# HSV（向量化）
rgb = a.astype(np.float32) / 255.0
mx = rgb.max(axis=2); mn = rgb.min(axis=2)
v = mx
s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
r, g, bl = rgb[..., 0], rgb[..., 1], rgb[..., 2]
d = np.maximum(mx - mn, 1e-6)
h = np.zeros_like(mx)
m1 = (mx == r); m2 = (mx == g) & ~m1; m3 = ~m1 & ~m2
h[m1] = ((g - bl) / d)[m1] % 6
h[m2] = ((bl - r) / d)[m2] + 2
h[m3] = ((r - g) / d)[m3] + 4
h = (h * 60) % 360

# 直方图：饱和度高的像素按色相分桶
mask_sat = (s > 0.25) & (v > 0.15)
hist, edges = np.histogram(h[mask_sat], bins=36, range=(0, 360))
print('\n高饱和像素色相分布 (每 10°):')
for i, cnt in enumerate(hist):
    if cnt > 0:
        print(f'  {int(edges[i]):3d}-{int(edges[i+1]):3d}°  {cnt/1e6:8.3f}M  {"#"*int(min(60, cnt/2e5))}')

# 像素统计
tot = a.shape[0] * a.shape[1]
print(f'\n总像素 {tot/1e6:.1f}M;  暗像素(v<0.15) {(v<0.15).sum()/tot*100:.1f}%')
print(f'高饱和(s>0.25) {mask_sat.sum()/tot*100:.1f}%')

# 分类试算：多组阈值，看各自占比
def report(name, m):
    print(f'  {name:<28} {m.sum()/tot*100:6.2f}%  ({m.sum()/1e6:.2f}M)')

print('\n候选分类占比：')
hue_red = ((h < 18) | (h > 345))
report('强红  h<18|>345 s>.45 v>.30', hue_red & (s > 0.45) & (v > 0.30))
report('强红  h<15|>350 s>.55 v>.35', ((h < 15) | (h > 350)) & (s > 0.55) & (v > 0.35))
report('蓝紫  200<h<265 s>.22 v>.25', (h > 200) & (h < 265) & (s > 0.22) & (v > 0.25))
report('蓝紫  205<h<255 s>.30 v>.30', (h > 205) & (h < 255) & (s > 0.30) & (v > 0.30))
report('黄    35<h<62 s>.40 v>.55', (h > 35) & (h < 62) & (s > 0.40) & (v > 0.55))
report('暗棕  v<.32 s>.20', (v < 0.32) & (s > 0.20))

# 输出分类预览（1/4 缩放）
Artery = ((h < 18) | (h > 345)) & (s > 0.45) & (v > 0.30)
Vein = (h > 200) & (h < 265) & (s > 0.22) & (v > 0.25)
prev = np.zeros_like(a)
prev[...] = (170, 170, 170)
prev[Artery] = (225, 45, 40)
prev[Vein] = (55, 90, 215)
pal = Image.fromarray(prev.astype(np.uint8)).resize((1024, 1024), Image.NEAREST)
pal.save(f'{OUT}/atlas_mask_preview.png')
print('\n已写出分类预览', f'{OUT}/atlas_mask_preview.png')

# 对比另一张贴图是否同源
try:
    b = np.asarray(Image.open(ALT_TEX).convert('RGB').resize(a.shape[1::-1]))
    diff = np.abs(b.astype(np.int16) - a.astype(np.int16)).mean()
    print(f'与 {ALT_TEX} 的平均像素差 = {diff:.1f}  (0=完全相同)')
except Exception as e:
    print('对比失败', e)
