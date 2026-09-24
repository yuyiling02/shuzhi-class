"""
皮肤图集重绘 v4：3D 血管管网 + 解剖学部位配色。

为什么不用"从原图集提取血管"：
  该模型 UV 极度碎片化（脂肪层有 4.7 万个 UV 岛），原图里连续的一条血管线
  在模型上必然被切成碎点，无论阈值怎么调都只能得到斑点。
  改为在 3D 空间沿模型表面生成血管管网（蛇形随机游走 + 分叉），
  再按每个顶点的 UV 反写进图集 —— 任何视角下都是连续管状脉络。

流程：
  1) 部位平涂（保留柔和组织明暗），毛发部件纯平涂保证颜色完全一致
  2) 3D 生成动脉/静脉管网（真皮 + 皮下脂肪连续贯通）
  3) 按顶点 UV 把管网写进图集（芯 + 深色外缘，形成管状层次）
  4) 填满图集空隙（避免双线性过滤出现黑边）

输入  scripts/_skin_verts/part{0,1}.f32（scripts/skin-dump-verts.mjs 导出）
输出  scripts/_skin_src/atlas_painted_{4096,2048}.{png,jpg,raw}
"""
import os
import random
import numpy as np
from PIL import Image, ImageFilter

S = 4096
SRC = 'scripts/_skin_src'
PREV = 'scripts/_skin_render'
MASK = f'{SRC}/uvmask_u8.raw'
ATLAS = 'scripts/_lod_img0.jpg'
SEED = 20260922

PALETTE = {
    1: (0xEA, 0xD0, 0x8A),   # part_0 皮下脂肪层（参考图实测 #E4CA93）
    2: (0xE0, 0xA0, 0x8A),   # part_1 真皮层（参考图实测 #DA9E87）
    3: (0x36, 0x20, 0x0F),   # part_2 毛囊内与毛发同轴的根鞘/附加结构 → 与毛发统一黑棕
    4: (0x36, 0x20, 0x0F),   # part_3 毛发（毛干+毛球）黑棕色
    5: (0xD0, 0x8A, 0x70),   # part_4 表皮层（参考图实测上表面 #D39D84，再加深为肉橘肤色）
    6: (0x36, 0x20, 0x0F),   # part_5 毛囊（与毛发统一）
    7: (0x36, 0x20, 0x0F),   # part_6 毛干（与毛发统一）
}
FLAT_PARTS = {3, 4, 6, 7}               # 毛发类：纯平涂，颜色完全一致
HAIR_COLOR = np.array([0x36, 0x20, 0x0F], np.float32)   # 毛干穿出表皮的部分（在 part_4 网格里）
HAIR_EDGE_DARKEN = 1.00                # 毛发根部毛孔处完全使用表皮本色，与皮肤融为一体
HAIR_MASK = f'{SRC}/hair_uvmask.raw'                     # skin-hair-detect.mjs 产出
VESSEL_PARTS = {0, 1}                  # 生成血管的部件（part_0 脂肪 / part_1 真皮）
ARTERY = np.array([0xD2, 0x3F, 0x33], np.float32)
ARTERY_RIM = np.array([0xA0, 0x2B, 0x22], np.float32)
VEIN = np.array([0x6C, 0x84, 0xCE], np.float32)
VEIN_RIM = np.array([0x4A, 0x5F, 0xA8], np.float32)

R_CORE, R_RIM = 0.020, 0.031           # 血管芯半径 / 外缘半径（模型单位）
GRID = 0.006                           # 场栅格边长
N_PATHS = 22                           # 主血管条数
BRANCH_P = 0.05                        # 每步分叉概率
STEPS = 30                             # 每条血管步数
MAX_SAMPLES = 120000

ROLLS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]   # 8 邻域，边缘更平滑
DISK2 = [(dx, dy) for dx in range(-2, 3) for dy in range(-2, 3) if dx * dx + dy * dy <= 4]


def dilate(m, it=1):
    for _ in range(it):
        acc = m.copy()
        for dy, dx in ROLLS:
            acc |= np.roll(np.roll(m, dy, 0), dx, 1)
        m = acc
    return m


# ---------------- 1. 读取顶点（part_0 脂肪 + part_1 真皮） ----------------
def load_part(mi):
    return np.fromfile(f'scripts/_skin_verts/part{mi}.f32', dtype=np.float32).reshape(-1, 5)


parts = {mi: load_part(mi) for mi in sorted(VESSEL_PARTS)}
cloud = np.concatenate([parts[mi][:, :3] for mi in sorted(VESSEL_PARTS)])
print(f'血管载体顶点：{len(cloud)} 个')

# ---------------- 2. 顶点邻接栅格 ----------------
QCELL = 0.05
q0 = cloud.min(axis=0) - QCELL
qidx = ((cloud - q0) / QCELL).astype(np.int64)
qkey = qidx[:, 0] * 1000000 + qidx[:, 1] * 1000 + qidx[:, 2]
order = np.argsort(qkey, kind='stable')
skey = qkey[order]
uq, st = np.unique(skey, return_index=True)
ends = np.append(st[1:], len(order))
grid = {(int(k) // 1000000, (int(k) // 1000) % 1000, int(k) % 1000): order[st[i]:ends[i]]
        for i, k in enumerate(uq)}


def cell_of(p):
    return ((p - q0) / QCELL).astype(np.int64)


def neighbours(p):
    c = cell_of(p)
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                s = grid.get((int(c[0]) + dx, int(c[1]) + dy, int(c[2]) + dz))
                if s is not None:
                    out.append(s)
    return np.concatenate(out) if out else None


rng = random.Random(SEED)
samples = []        # [(point, kind)] kind: 0=动脉 1=静脉
branches = []       # [(point, heading)]


def trace(start_pt, heading, kind, steps, spawn=True):
    cur = np.asarray(start_pt, np.float32).copy()
    h = np.asarray(heading, np.float32)
    h = h / (np.linalg.norm(h) + 1e-9)
    out = [cur.copy()]
    for _ in range(steps):
        pool = neighbours(cur)
        if pool is None:
            break
        p = cloud[pool]
        d = np.linalg.norm(p - cur, axis=1)
        ok = (d > 0.020) & (d < 0.055)
        if not ok.any():
            break
        p, d = p[ok], d[ok]
        dirs = (p - cur) / d[:, None]
        score = dirs @ h - 0.9 * np.abs(d - 0.035) + rng.random() * 0.0 + np.array(
            [rng.random() for _ in range(len(p))]) * 0.7
        nxt = p[int(np.argmax(score))]
        n = max(2, int(d[int(np.argmax(score))] / 0.004))
        for t in np.linspace(0, 1, n)[1:]:
            out.append(cur + (nxt - cur) * t)
        h = 0.75 * h + 0.25 * dirs[int(np.argmax(score))]
        h /= np.linalg.norm(h) + 1e-9
        cur = nxt.copy()
        if spawn and rng.random() < BRANCH_P and len(branches) < 60 and len(samples) + len(out) < MAX_SAMPLES:
            ax = np.cross(h, np.array([0, 1, 0], np.float32))
            if np.linalg.norm(ax) < 0.1:
                ax = np.cross(h, np.array([1, 0, 0], np.float32))
            ax /= np.linalg.norm(ax) + 1e-9
            ang = rng.choice([-1, 1]) * rng.uniform(0.9, 1.6)
            branches.append((cur.copy(), h * np.cos(ang) + ax * np.sin(ang)))
    return out


for _ in range(N_PATHS):
    i0 = rng.randrange(len(cloud))
    heading = np.array([rng.gauss(0, 1), 0.35 * rng.gauss(0, 1), rng.gauss(0, 1)], np.float32)
    kind = 0 if rng.random() < 0.55 else 1
    samples.extend((p, kind) for p in trace(cloud[i0], heading, kind, STEPS))

for pt, bh in list(branches):
    if len(samples) > MAX_SAMPLES:
        break
    pool = neighbours(pt)
    start = cloud[pool[np.argmin(np.linalg.norm(cloud[pool] - pt, axis=1))]] if pool is not None else pt
    kind = 0 if rng.random() < 0.55 else 1
    samples.extend((p, kind) for p in trace(start, bh, kind, max(8, STEPS // 2), spawn=False))

print(f'血管采样点：{len(samples)}')

# ---------------- 3. 栅格化血管场 ----------------
lo = cloud.min(axis=0) - 0.05
dims = np.ceil((cloud.max(axis=0) - lo + 0.05) / GRID).astype(int) + 2
field = np.zeros(tuple(dims), np.uint8)


def sphere_offsets(r):
    rad = int(np.ceil(r / GRID))
    return [(dx, dy, dz) for dx in range(-rad, rad + 1) for dy in range(-rad, rad + 1)
            for dz in range(-rad, rad + 1) if (dx * dx + dy * dy + dz * dz) * GRID * GRID <= r * r]


OFF_CORE, OFF_RIM = sphere_offsets(R_CORE), sphere_offsets(R_RIM)
CORE_RIDX, RIM_RIDX = {0: 1, 1: 3}, {0: 2, 1: 4}   # 1/3=动脉/静脉芯, 2/4=动脉/静脉缘


def stamp(offs, val_of_kind):
    """把一批采样点的球体写进场（必须分两遍：先全部外缘，再全部芯，
    否则后一个采样点的外缘会把前一个的芯抹掉）"""
    for p, kind in samples:
        g = ((p - lo) / GRID).astype(int)
        val = val_of_kind[kind]
        for dx, dy, dz in offs:
            x, y, z = g[0] + dx, g[1] + dy, g[2] + dz
            if 0 <= x < dims[0] and 0 <= y < dims[1] and 0 <= z < dims[2]:
                field[x, y, z] = val


stamp(OFF_RIM, RIM_RIDX)
stamp(OFF_CORE, CORE_RIDX)
print(f'血管场占用栅格：{int((field > 0).sum())} / {field.size}'
      f'（芯 {int(np.isin(field, [1, 3]).sum())}）')

# ---------------- 4. 按顶点 UV 投影成标签图 ----------------
lab = np.zeros((S, S), np.uint8)   # 0=无 1=动脉芯 2=动脉缘 3=静脉芯 4=静脉缘
lab_flat = lab.reshape(-1)


def paint_disk(px, py, val, r_offsets):
    """在 UV 空间按圆盘笔刷涂标签，避免顶点投影留下的空隙造成散点"""
    for dx, dy in r_offsets:
        x = np.clip(px + dx, 0, S - 1)
        y = np.clip(py + dy, 0, S - 1)
        lab_flat[y * S + x] = val


for mi in sorted(VESSEL_PARTS):
    v = parts[mi]
    g = np.clip(((v[:, :3] - lo) / GRID).astype(np.int64), [0, 0, 0], dims - 1)
    val = field[g[:, 0], g[:, 1], g[:, 2]]
    sel = val > 0
    if not sel.any():
        continue
    px = np.clip((v[sel, 3] * S).astype(np.int64), 0, S - 1)
    py = np.clip((v[sel, 4] * S).astype(np.int64), 0, S - 1)
    val = val[sel]
    for want in (2, 4, 1, 3):            # 先缘后芯，芯最后覆盖
        s2 = val == want
        if s2.any():
            paint_disk(px[s2], py[s2], want, DISK2)
print('标签图（圆盘投影）：', {int(k): int((lab == k).sum()) for k in np.unique(lab)})

# 顶点投影仍会有稀疏处：芯再膨胀 1px、外缘扩到 5px（芯优先），保证条带连续
a_core = dilate(lab == 1, 1)
v_core = dilate(lab == 3, 1) & ~a_core
a_zone = dilate((lab == 1) | (lab == 2), 5) | dilate(lab == 1, 6)
v_zone = dilate((lab == 3) | (lab == 4), 5) | dilate(lab == 3, 6)
a_rim = a_zone & ~a_core & ~v_core
v_rim = v_zone & ~v_core & ~a_core & ~a_rim
print('已绘制：动脉', int(a_core.sum()), '+', int(a_rim.sum()), ' 静脉', int(v_core.sum()), '+', int(v_rim.sum()))

# ---------------- 5. 合成图集 ----------------
atlas = np.asarray(Image.open(ATLAS).convert('RGB')).astype(np.float32)
mask = np.fromfile(MASK, dtype=np.uint8).reshape(S, S)
covered = mask > 0

luma = 0.2126 * atlas[..., 0] + 0.7152 * atlas[..., 1] + 0.0722 * atlas[..., 2]
blur = np.asarray(Image.fromarray(np.clip(luma, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(16)), np.float32)
detail = np.clip(blur / max(1.0, blur[covered].mean()), 0.94, 1.07).astype(np.float32)

out = np.zeros_like(atlas)
filled = np.zeros((S, S), bool)
for pid, color in PALETTE.items():
    sel = mask == pid
    if not sel.any():
        continue
    base = np.array(color, np.float32)
    d = np.ones_like(detail) if pid in FLAT_PARTS else detail
    out[sel] = base[None, :] * d[sel][:, None]
    filled |= sel

# 细长部件（腺体/毛发/毛囊/毛干）的 UV 岛是极细长条，掩码点采样会漏掉大量 texel，
# 漏掉的会被后续"填空"用邻近浅色覆盖 → 表现为毛发发白。这里按顶点投影用圆盘笔刷补画。
BRUSH_R = 3
DISK3 = [(dx, dy) for dx in range(-BRUSH_R, BRUSH_R + 1) for dy in range(-BRUSH_R, BRUSH_R + 1)
         if dx * dx + dy * dy <= BRUSH_R * BRUSH_R]
THIN_PARTS = (3, 4, 6, 7)      # mask pid（part_2 / part_3 / part_5 / part_6）
for pid in THIN_PARTS:
    v = np.fromfile(f'scripts/_skin_verts/part{pid - 1}.f32', dtype=np.float32).reshape(-1, 5)
    px = np.clip((v[:, 3] * S).astype(np.int64), 0, S - 1)
    py = np.clip((v[:, 4] * S).astype(np.int64), 0, S - 1)
    c = np.array(PALETTE[pid], np.float32)
    for dx, dy in DISK3:
        ix = np.clip(px + dx, 0, S - 1)
        iy = np.clip(py + dy, 0, S - 1)
        out[iy, ix] = c
        filled[iy, ix] = True
    print(f'  细长部件补画 part_{pid - 1}：{len(px)} 顶点 × 圆盘 r={BRUSH_R}')


# ---------------- 6. 按 3D 高度混合毛发/毛囊颜色（消除皮肤顶面黑斑） ----------------
# 参考图：毛发与表皮衔接处（毛孔开口）是皮肤本色，只有高出表皮较多的毛发尖端才显黑棕。
# 对 mask=4（part_3 毛发）、mask=6（part_5 毛囊）、mask=7（part_6 毛干）的每个顶点，
# 计算它相对于局部表皮顶面的高度 h：
#   h < 0.01      → 完全肉橘色（衔接处/毛孔）
#   h > 0.12      → 完全黑棕色（毛发尖端）
#   之间线性过渡
# 用 BRUSH_R3 圆盘按顶点 UV 写回对应 mask 区域，这样既保留毛发结构，
# 又把穿出皮肤表面的根部染成皮肤色，避免顶视图出现黑棕色斑块。
def build_surface_heightfield(verts_pos, cell=0.03, med_w=7):
    """用表皮顶点建立局部顶面高度场，返回 sheetY(x, z)"""
    xs, ys, zs = verts_pos[:, 0], verts_pos[:, 1], verts_pos[:, 2]
    mn_x, mx_x = xs.min() - cell, xs.max() + cell
    mn_z, mx_z = zs.min() - cell, zs.max() + cell
    gx = int(np.ceil((mx_x - mn_x) / cell)) + 1
    gz = int(np.ceil((mx_z - mn_z) / cell)) + 1
    buckets = [[] for _ in range(gx * gz)]
    for x, y, z in zip(xs, ys, zs):
        ix = min(gx - 1, max(0, int((x - mn_x) / cell)))
        iz = min(gz - 1, max(0, int((z - mn_z) / cell)))
        buckets[iz * gx + ix].append(y)
    top = np.full((gz, gx), np.nan, np.float32)
    for iz in range(gz):
        for ix in range(gx):
            b = buckets[iz * gx + ix]
            if len(b) >= 4:
                b.sort()
                top[iz, ix] = b[int(len(b) * 0.9)]   # 90 分位：比 max 更稳，能排除穿插的毛干
    half = med_w // 2
    top_f = top.copy()
    for iz in range(gz):
        for ix in range(gx):
            vals = []
            for dz in range(-half, half + 1):
                for dx in range(-half, half + 1):
                    jx, jz = ix + dx, iz + dz
                    if 0 <= jx < gx and 0 <= jz < gz:
                        v = top[jz, jx]
                        if not np.isnan(v):
                            vals.append(v)
            if len(vals) >= 3:
                vals.sort()
                top_f[iz, ix] = vals[len(vals) // 2]
    for _ in range(60):
        done = True
        new_top = top_f.copy()
        for iz in range(gz):
            for ix in range(gx):
                if not np.isnan(top_f[iz, ix]):
                    continue
                s, cnt = 0, 0
                for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    jx, jz = ix + dx, iz + dz
                    if 0 <= jx < gx and 0 <= jz < gz:
                        v = top_f[jz, jx]
                        if not np.isnan(v):
                            s += v
                            cnt += 1
                if cnt:
                    new_top[iz, ix] = s / cnt
                    done = False
        top_f = new_top
        if done:
            break

    def sheetY(x, z):
        fx = min(gx - 1.001, max(0, (x - mn_x) / cell))
        fz = min(gz - 1.001, max(0, (z - mn_z) / cell))
        ix0, iz0 = int(fx), int(fz)
        tx, tz = fx - ix0, fz - iz0
        v00 = top_f[iz0, ix0]
        v10 = top_f[iz0, min(gx - 1, ix0 + 1)]
        v01 = top_f[min(gz - 1, iz0 + 1), ix0]
        v11 = top_f[min(gz - 1, iz0 + 1), min(gx - 1, ix0 + 1)]
        if np.isnan(v00) or np.isnan(v10) or np.isnan(v01) or np.isnan(v11):
            return np.nanmax(top_f)
        return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz

    return sheetY


# 毛发/毛囊颜色与局部表皮顶面高度的关系：
# 参考图：皮肤表面（毛孔/毛发根部）应与表皮同色，只有皮肤内部深处的毛发保留深色。
# 因此只要顶点高度不低于表皮太多，就染成肉橘色；只保留深入真皮/皮下组织的毛发为黑棕色。
SURF_HAIR_LOW = -0.03           # 低于此值视为皮肤内部深处 → 黑棕色
SURF_HAIR_MID = 0.00            # 高于/等于此值 → 完全肉橘色
BRUSH_R3 = 5
DISK5 = [(dx, dy) for dx in range(-BRUSH_R3, BRUSH_R3 + 1) for dy in range(-BRUSH_R3, BRUSH_R3 + 1)
         if dx * dx + dy * dy <= BRUSH_R3 * BRUSH_R3]
SURF_HAIR_PIDS = {4: 2, 6: 5, 7: 6}   # mask pid → 顶点文件 part_i

print('构建局部表皮顶面高度场...')
sheetY = build_surface_heightfield(np.fromfile('scripts/_skin_verts/part4.f32', dtype=np.float32).reshape(-1, 5)[:, :3])
skin_color = np.array(PALETTE[5], np.float32)   # 表皮肉橘色
hair_color = HAIR_COLOR.copy()

for pid, part_i in SURF_HAIR_PIDS.items():
    v = np.fromfile(f'scripts/_skin_verts/part{part_i}.f32', dtype=np.float32).reshape(-1, 5)
    pos = v[:, :3]
    px = np.clip((v[:, 3] * S).astype(np.int64), 0, S - 1)
    py = np.clip((v[:, 4] * S).astype(np.int64), 0, S - 1)
    h = pos[:, 1] - np.array([sheetY(x, z) for x, z in pos[:, ::2]])

    def hair_color_by_h(hv):
        # 皮肤内部深处 → 黑棕；接近或高出表皮 → 肉橘；中间短区间过渡
        c = np.zeros((len(hv), 3), np.float32)
        in_hair = hv <= SURF_HAIR_LOW
        in_skin = hv >= SURF_HAIR_MID
        c[in_hair] = hair_color
        c[in_skin] = skin_color
        trans = (hv > SURF_HAIR_LOW) & (hv < SURF_HAIR_MID)
        if trans.any():
            t = (hv[trans] - SURF_HAIR_LOW) / (SURF_HAIR_MID - SURF_HAIR_LOW)
            c[trans] = hair_color[None, :] * (1 - t)[:, None] + skin_color[None, :] * t[:, None]
        return c

    vert_colors = hair_color_by_h(h)
    near_skin = (h >= SURF_HAIR_LOW).sum()
    print(f'  高度混合 part_{part_i} (pid={pid})：顶点 {len(v)}，h∈[{h.min():.3f}, {h.max():.3f}]，'
          f'近表皮 {near_skin} 个')
    # 把每个顶点的颜色按圆盘写回该部件的 UV 区域
    c_arr = np.zeros((len(DISK5), len(v), 3), np.float32)
    for i, (dx, dy) in enumerate(DISK5):
        c_arr[i] = vert_colors
    # 为避免循环太慢，用向量化写入：每圈处理一个偏移
    for i, (dx, dy) in enumerate(DISK5):
        ix = np.clip(px + dx, 0, S - 1)
        iy = np.clip(py + dy, 0, S - 1)
        # 只覆盖本 mask 区域；若该顶点落在冲突/其他 mask，则跳过（不污染表皮）
        take = mask[iy, ix] == pid
        out[iy, ix] = np.where(take[:, None], c_arr[i], out[iy, ix])
        filled[iy, ix] = np.where(take, True, filled[iy, ix])

for m, c in ((a_rim, ARTERY_RIM), (v_rim, VEIN_RIM), (a_core, ARTERY), (v_core, VEIN)):
    out[m] = c[None, :] * detail[m][:, None]
    filled |= m

# 毛干穿出表皮的那一段几何在 part_4（表皮）网格里，掩码按部件分不开，
# 由 skin-hair-detect.mjs 在 3D 上识别（高于局部表皮表面 + 管状性）后给出 UV 掩码。
# 必须放在血管之后：血管外缘是"膨胀 5~6px"的区域，可能压到毛干的 UV 岛。
if os.path.exists(HAIR_MASK):
    hm = np.fromfile(HAIR_MASK, dtype=np.uint8).reshape(S, S) > 0
    # 毛发与表皮衔接处应该是表皮本色（参考图：毛孔开口为皮肤色）。
    # 为了消除皮肤顶面的黑棕色斑块，这里不再保留毛干核心的深色，
    # 而是把整段穿出表皮的毛干都用表皮肉橘色覆盖，让它完全融入皮肤。
    skin_hair_color = np.array(PALETTE[5], np.float32) * HAIR_EDGE_DARKEN
    out[hm] = skin_hair_color[None, :] * detail[hm][:, None]
    filled |= hm
    print(f'  毛干（part_4 内突出几何）补画：{int(hm.sum())} texel 用表皮本色覆盖')
else:
    print(f'  ！未找到 {HAIR_MASK}，跳过毛干补画（先跑 scripts/skin-hair-detect.mjs）')

for _ in range(30):
    if filled.all():
        break
    empty = ~filled
    for dy, dx in ROLLS:
        nf = np.roll(np.roll(filled, dy, 0), dx, 1)
        nv = np.roll(np.roll(out, dy, 0), dx, 1)
        take = empty & nf
        out[take] = nv[take]
        filled |= take
out[~filled] = np.array([0xE8, 0xD5, 0xC0], np.float32)
print(f'填充完成：未覆盖 texel {100*(~covered).sum()/covered.size:.1f}% → {100*(~filled).sum()/filled.size:.2f}%')

img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
for size in (4096, 2048):
    im = img if size == S else img.resize((size, size), Image.LANCZOS)
    im.save(f'{SRC}/atlas_painted_{size}.png', optimize=True)
    im.convert('RGB').save(f'{SRC}/atlas_painted_{size}.jpg', quality=92, subsampling=0)
    open(f'{SRC}/atlas_painted_{size}.raw', 'wb').write(im.convert('RGB').tobytes())
    print(f'atlas_painted_{size}: PNG {os.path.getsize(f"{SRC}/atlas_painted_{size}.png")/1024:.0f} KB')

img.resize((1100, 1100), Image.LANCZOS).save(f'{PREV}/paint_atlas_preview.png')

dbg = np.zeros((S, S, 3), np.uint8)
dbg[covered] = (235, 225, 215)
dbg[a_rim] = (0xA5, 0x28, 0x1F)
dbg[v_rim] = (0x45, 0x5F, 0xA6)
dbg[a_core] = (0xE8, 0x3A, 0x2E)
dbg[v_core] = (0x6B, 0x8B, 0xE0)
Image.fromarray(dbg).resize((1100, 1100), Image.LANCZOS).save(f'{PREV}/vessel_mask_preview.png')
print('done')
