/**
 * 手势指针的坐标映射与命中判定。
 *
 * HandController 已经把食指尖转换成**视口归一化坐标** `[0,1] × [0,1]`
 * （即 0 对应视口左/上边缘，1 对应右/下边缘）。这里的函数直接消费这个
 * 归一化坐标，把它映射到任意目标矩形，并做最近矩形命中判定。
 */

/**
 * 命中判定允许超出选项矩形多少像素。
 *
 * 判定是**纯粹的包含判定**：光标圆点在哪个选项框里，就选哪个；落在选项之间
 * 的空隙里就是没选中。留 8px 只是为了让"刚好压着边缘"也能选中，不会再出现
 * "光标明明在 A 上却高亮了 B"。
 */
export const HAND_HIT_PADDING_PX = 8;

/**
 * `nearestRectIndex` 的默认容差，只给"按钮悬停"这类需要宽容一点的场景用。
 * 选项命中判定一律走 `rectIndexAtPoint` 的包含判定。
 */
export const HAND_HIT_TOLERANCE_PX = 26;

/**
 * 相对指针的灵敏度：指尖在摄像头画面里横向走满 1（整幅画面宽），
 * 光标在屏幕上横向走 3.2 个屏幕宽度。
 *
 * 相对模式下灵敏度只影响"手要移动多少"，不影响准确度——光标永远跟着手走。
 * 取 3.2 是因为摄像头视野比屏幕宽得多，手只需小幅移动就能把光标推过整屏。
 */
export const HAND_POINTER_SENSITIVITY = 3.2;

/**
 * 指针加速：手动得快时把这一帧的位移再放大一截，甩手一下就能横穿屏幕；
 * 慢速微调时增益回到 1，仍然精细。
 *
 * 单帧位移（画面归一化）乘 `POINTER_ACCEL_K` 得到额外增益，上限
 * `POINTER_ACCEL_MAX`。检测噪声的单帧位移只有千分之几，加速对它几乎没有
 * 影响，所以不会把抖动一起放大。
 */
const POINTER_ACCEL_K = 16;
const POINTER_ACCEL_MAX = 1.2;

/**
 * 灵敏度可以用 `?handsens=3` 临时改（只影响本次会话）：手要挪多远才能把光标
 * 从屏幕一头推到另一头。相对模式下这只影响"费不费劲"，不影响准确度。
 */
let ACTIVE_SENSITIVITY = (() => {
  if (typeof window === 'undefined') return HAND_POINTER_SENSITIVITY;
  try {
    const raw = new URLSearchParams(window.location.search).get('handsens');
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.min(8, value) : HAND_POINTER_SENSITIVITY;
  } catch {
    return HAND_POINTER_SENSITIVITY;
  }
})();

/** 当前灵敏度（手指挪一屏的宽度，光标走几个屏幕宽）。 */
export const getHandPointerSensitivity = (): number => ACTIVE_SENSITIVITY;

/** 运行时改灵敏度，方便当场调到顺手为止（调试面板在用）。 */
export const setHandPointerSensitivity = (value: number): number => {
  if (!Number.isFinite(value)) return ACTIVE_SENSITIVITY;
  ACTIVE_SENSITIVITY = clamp(value, 0.5, 8);
  return ACTIVE_SENSITIVITY;
};

/**
 * 指针标定。摄像头装在屏幕上方、有视角差，且摄像头画幅（通常 4:3）与屏幕
 * （16:9）不同，所以**摄像头视野比屏幕宽得多**：手从屏幕最左划到最右，在
 * 摄像头画面里往往只走了 50%~65%。
 *
 * 若按 1:1 把画面铺满屏幕，光标会被整体往屏幕中心压缩，表现就是——
 * 指左边时光标偏右、指右边时光标偏左（"想点右边却点了左边"）。
 * 所以默认值必须带 gain > 1，再由实际使用中的采样自动收敛。
 *
 * - mirrorX：是否对原始 x 做 1-rawX 翻转。**默认 true**（标准摄像头方向下必须翻转
 *   光标才跟手）。换设备若相反，用 ?handdebug=1 的「翻转左右」一键改回并持久化。
 * - gainX / gainY：映射增益。1 = 画面 [0,1] 铺满屏幕；摄像头视野比屏幕宽，典型值 1.5~2。
 * - offsetX / offsetY：整体平移，单位是归一化比例。摄像头在屏幕上方，
 *   屏幕中心在画面里偏下，所以 offsetY 默认取负。
 */
export interface HandPointerCalibration {
  mirrorX: boolean;
  gainX: number;
  gainY: number;
  offsetX: number;
  offsetY: number;
}

// 出厂默认必须是"接近真实几何"的初值，而不是身份映射。
// 摄像头装在屏幕上方、画幅 4:3 而屏幕 16:9，视野比屏幕宽得多：手从屏幕最左划到
// 最右，在摄像头画面里往往只走了 55%~65%。若按 1:1（gain=1）把画面铺满屏幕，
// 光标会被整体往中心压缩——指左边时光标偏右、指右边时光标偏左（"想点右边却点了
// 左边"），表现正是历史反复出现的"指哪偏哪"。所以默认增益取 >1（横向约 1.8，
// 纵向约 1.6），把画面里约 0.55 的位移拉伸成整屏；摄像头在屏幕上方、屏幕中心在
// 画面里偏下，故 offsetY 取负。这个初值已经"基本指哪到哪"，再由答题时的安全自动
// 微调（recordHandPointerSample）把它收敛到当前摄像头摆放的精确几何，只会越调越准。
// mirrorX 默认取 true（由实测定死：用户确认「开镜像才是正常的」，即手往右 → raw x
// 变小 → 1-rawX 变大 → 光标往右，光标跟手）。方向由 solveHandPointerCalibration
// **锁定**，不会被自动学习改回去；换设备若相反，用 ?handdebug=1 面板「翻转左右」
// 一键切换并持久生效。
const DEFAULT_HAND_POINTER_CALIBRATION: HandPointerCalibration = {
  mirrorX: true,
  gainX: 1.8,
  gainY: 1.6,
  offsetX: 0,
  offsetY: -0.12,
};

// v13：v12 把默认设为 mirrorX:false，用户实测确认「开镜像才是正常的」——翻回
// mirrorX:true。升 v13 清掉 v12 在关镜像方向下学到的标定与采样（截图证据：指右选项
// 时 raw x=0.395、ptr 仅 0.579，带着错误方向教的负 offset，必须作废重学）。
// v14：新增光标水平微调 nudge（整体左移 0.5 个选项框宽）后，自动学习的标签语义变了
// ——标签改为「框心 + nudge」。v13 的标定是按「框心」学的，套上新微调会把光标再往左
// 带偏半个框，必须作废重学，故升 v14。
const CALIBRATION_STORAGE_KEY = 'shuzhi.handPointerCalibration.v14';
const SAMPLES_STORAGE_KEY = 'shuzhi.handPointerSamples.v14';
/** 最多保留的自动学习采样点数，超出后丢弃最旧的。 */
const MAX_SAMPLES = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 把任意来源的标定参数收敛到可用区间，防止异常值把光标推出屏幕。 */
export const clampCalibration = (input: Partial<HandPointerCalibration>): HandPointerCalibration => ({
  mirrorX: input.mirrorX !== false,
  gainX: clamp(typeof input.gainX === 'number' && Number.isFinite(input.gainX) ? input.gainX : 1, 0.6, 3.5),
  gainY: clamp(typeof input.gainY === 'number' && Number.isFinite(input.gainY) ? input.gainY : 1, 0.6, 3.5),
  offsetX: clamp(typeof input.offsetX === 'number' && Number.isFinite(input.offsetX) ? input.offsetX : 0, -0.6, 0.6),
  offsetY: clamp(typeof input.offsetY === 'number' && Number.isFinite(input.offsetY) ? input.offsetY : 0, -0.6, 0.6),
});

const readJson = <T,>(key: string): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式下写入失败不影响本次会话使用。
  }
};

const removeKey = (key: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

const readStoredCalibration = (): HandPointerCalibration | null => {
  const parsed = readJson<Partial<HandPointerCalibration>>(CALIBRATION_STORAGE_KEY);
  if (!parsed || typeof parsed.gainX !== 'number' || typeof parsed.gainY !== 'number') return null;
  return clampCalibration({ ...DEFAULT_HAND_POINTER_CALIBRATION, ...parsed });
};

/**
 * 当前生效的标定参数。
 *
 * 采用"绝对映射"：手指在摄像头画面里的归一化位置，经 `calibrateHandPoint`
 * 换算成视口归一化坐标，再乘 innerWidth/innerHeight 得到像素位置，由浏览器
 * `elementFromPoint` 判定压在哪个选项上。
 *
 * 出厂默认接近真实几何（gainX≈1.8、gainY≈1.6、offsetY 为负，仅 `mirrorX` 默认
 * true 适配自拍预览），已经"基本指哪到哪"；答题过程中的安全自动微调会把残差收敛
 * 到当前摄像头摆放。
 *
 * 已保存的标定（v3）会被读取并复用，刷新后仍然生效；没有保存时才退回出厂默认。
 */
// 只清一次遗留的旧版本键；v4 结果要持久化，绝不能清。
removeKey('shuzhi.handPointerCalibration.v1');
removeKey('shuzhi.handPointerCalibration.v2');
removeKey('shuzhi.handPointerCalibration.v3');
removeKey('shuzhi.handPointerCalibration.v4');
removeKey('shuzhi.handPointerCalibration.v5');
removeKey('shuzhi.handPointerCalibration.v6');
removeKey('shuzhi.handPointerCalibration.v7');
removeKey('shuzhi.handPointerCalibration.v8');
removeKey('shuzhi.handPointerCalibration.v9');
removeKey('shuzhi.handPointerCalibration.v10');
removeKey('shuzhi.handPointerCalibration.v11');
removeKey('shuzhi.handPointerCalibration.v12');
removeKey('shuzhi.handPointerCalibration.v13');
removeKey('shuzhi.handPointerSamples.v2');
removeKey('shuzhi.handPointerSamples.v5');
removeKey('shuzhi.handPointerSamples.v3');
removeKey('shuzhi.handPointerSamples.v4');
removeKey('shuzhi.handPointerSamples.v6');
removeKey('shuzhi.handPointerSamples.v7');
removeKey('shuzhi.handPointerSamples.v8');
removeKey('shuzhi.handPointerSamples.v9');
removeKey('shuzhi.handPointerSamples.v10');
removeKey('shuzhi.handPointerSamples.v11');
removeKey('shuzhi.handPointerSamples.v12');
removeKey('shuzhi.handPointerSamples.v13');
removeKey('shuzhi.handPointerAutoLearnTrusted.v1');

// 优先用已保存的标定；没有（首次或已清）才退回出厂默认（接近真实几何的初值）。
export let HAND_POINTER_CALIBRATION: HandPointerCalibration =
  readStoredCalibration() ?? { ...DEFAULT_HAND_POINTER_CALIBRATION };

export const setHandPointerCalibration = (
  patch: Partial<HandPointerCalibration>,
  options: { persist?: boolean } = {},
) => {
  HAND_POINTER_CALIBRATION = clampCalibration({ ...HAND_POINTER_CALIBRATION, ...patch });
  if (options.persist !== false) writeJson(CALIBRATION_STORAGE_KEY, HAND_POINTER_CALIBRATION);
};

export const resetHandPointerCalibration = () => {
  HAND_POINTER_CALIBRATION = { ...DEFAULT_HAND_POINTER_CALIBRATION };
  removeKey(CALIBRATION_STORAGE_KEY);
};

/** 是否已经过自动学习（还是停留在出厂默认值）。 */
export const isHandPointerCalibrated = () => readStoredCalibration() !== null;

/**
 * 把摄像头画面归一化坐标（未镜像）转成视口归一化坐标并应用标定。
 * 结果会被 clamp 到 [0,1]，保证光标不会跑出屏幕。
 */
export const calibrateHandPoint = (
  rawX: number,
  rawY: number,
  calibration: HandPointerCalibration = HAND_POINTER_CALIBRATION,
): { x: number; y: number } => {
  const mirroredX = calibration.mirrorX ? 1 - rawX : rawX;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp01((mirroredX - 0.5) * calibration.gainX + 0.5 + calibration.offsetX),
    y: clamp01((rawY - 0.5) * calibration.gainY + 0.5 + calibration.offsetY),
  };
};

export interface PointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把视口归一化的手势指针坐标线性映射到目标矩形。
 *
 * @param normalizedX 视口归一化 x，0 = 视口左边缘，1 = 右边缘。
 * @param normalizedY 视口归一化 y，0 = 视口上边缘，1 = 下边缘。
 */
export const mapHandPointToRect = (
  normalizedX: number,
  normalizedY: number,
  rect: PointerRect,
): { x: number; y: number } => ({
  x: rect.left + normalizedX * rect.width,
  y: rect.top + normalizedY * rect.height,
});

/** 选项 hover 时被放大的比例（CSS `.quiz-option-card.is-hovered` 的 scale）。 */
export const OPTION_HOVER_SCALE = 1.05;

/** 选项 hover 时同时上移的像素（同上规则的 translateY(-6px)）。 */
export const OPTION_HOVER_LIFT_PX = 6;

export interface HitRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 取元素"未被 hover 放大时"的矩形。
 *
 * 选项 hover 时会 `scale(1.05)`，矩形随之变大；若直接用实时矩形做命中判定，
 * 指针明明已经移到 B，A 的放大矩形仍把指针包在里面形成"自我粘滞"。
 * 这里对处于 hover 的元素按放大比例反算回原始尺寸，因此可以每帧实时取矩形，
 * 不必缓存快照——窗口 resize、布局变化都不会让命中判定用上过期矩形。
 */
export const getUnhoveredRect = (
  element: HTMLElement | null,
  isHovered: boolean,
): HitRect | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!isHovered) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  // hover 态：scale(1.05) + translateY(-6px)。尺寸的还原按中心缩放反算，
  // 位移的还原则是把中心点往下移回 6px。
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2 + OPTION_HOVER_LIFT_PX;
  const width = rect.width / OPTION_HOVER_SCALE;
  const height = rect.height / OPTION_HOVER_SCALE;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    right: centerX + width / 2,
    bottom: centerY + height / 2,
  };
};

/**
 * 把指针约束到"候选项整体外扩 margin 像素"的范围内。
 *
 * 摄像头视野与屏幕的比例只能估个大概，增益偏大时光标会飞到选项区之外，
 * 结果就是"指着 A 却什么都没选中"。约束之后：光标永远不会掉出选项区，
 * 而且因为映射是单调的，越往某个方向指就越靠近那个方向的选项——
 * 增益偏大只会让光标顶到边缘，不会导致选错或选不中。
 */
export const clampPointToRects = (
  x: number,
  y: number,
  rects: ReadonlyArray<HitRect | null | undefined>,
  margin: number,
): { x: number; y: number } => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let found = false;
  for (const rect of rects) {
    if (!rect) continue;
    found = true;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!found) return { x, y };
  return {
    x: clamp(x, left - margin, right + margin),
    y: clamp(y, top - margin, bottom + margin),
  };
};

/** 视口矩形。用于 fixed 全屏覆盖层（答题层）内的指针映射。 */
export const getViewportRect = (): PointerRect => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

/** 元素矩形。用于浮层自身铺满某个容器（如 3D 舞台）时的指针映射。 */
export const getElementRect = (element: HTMLElement | null): PointerRect | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** 点到矩形的最短距离；点在矩形内为 0。 */
export const distanceToRect = (
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number } | null | undefined,
): number => {
  if (!rect) return Infinity;
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
};

/**
 * 取离指针最近的候选项下标；超出容差返回 null。
 *
 * 用"到矩形的最短距离"而不是"到中心的距离"：大卡片不会因为中心更远而被小
 * 卡片抢走，指针落在选项之间的间距里时也仍然归属最近的选项，不会突然丢失命中。
 */
export const nearestRectIndex = <T,>(
  x: number,
  y: number,
  candidates: readonly T[],
  getRect: (candidate: T) => { left: number; top: number; right: number; bottom: number } | null | undefined,
  tolerance: number = HAND_HIT_TOLERANCE_PX,
): number | null => {
  let best: { index: number; distance: number } | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const distance = distanceToRect(x, y, getRect(candidates[index]));
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) {
      best = { index, distance };
    }
  }
  return best ? best.index : null;
};

/**
 * 选项元素上标记的索引属性名。命中判定不再自己算矩形，而是让浏览器回答
 * "这个坐标下压着哪个元素"，再用这个属性反查是第几个选项。
 */
export const HAND_OPTION_INDEX_ATTR = 'data-hand-option-index';

/**
 * 命中判定：问浏览器"屏幕这个点上压着哪个元素"，再往上找到带索引标记的
 * 选项容器。
 *
 * 这是唯一能保证"光标在哪个框里就选哪个"的做法——浏览器用的是元素**真正
 * 渲染出来的**几何（含 hover 的 scale / translateY、动画中途的形变、祖先的
 * transform），而我们自己用 getBoundingClientRect 反算"未放大尺寸"永远可能
 * 和肉眼看到的差一截，表现就是"明明在框里却选不中 / 要在框外才选得到"。
 */
export const optionIndexAtPoint = (x: number, y: number): number | null => {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const element = document.elementFromPoint(x, y);
  if (!element || typeof (element as Element).closest !== 'function') return null;
  const card = (element as Element).closest(`[${HAND_OPTION_INDEX_ATTR}]`);
  if (!card) return null;
  const raw = card.getAttribute(HAND_OPTION_INDEX_ATTR);
  const index = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(index) ? index : null;
};

/**
 * 选项命中的统一入口：优先用浏览器的真实命中结果，取不到时退回几何包含判定。
 *
 * 退回的意义在于：万一有透明装饰层盖在选项上，`elementFromPoint` 会返回那层
 * 而拿不到选项；此时按几何判定仍然和肉眼看到的一致。
 *
 * @param getRect 取第 index 个选项"未 hover 放大时"的矩形（兜底用）。
 */
export const hitOptionIndex = (
  x: number,
  y: number,
  optionCount: number,
  getRect: (index: number) => HitRect | null,
): number | null => {
  const fromDom = optionIndexAtPoint(x, y);
  if (fromDom !== null && fromDom >= 0 && fromDom < optionCount) return fromDom;

  const rects: Array<HitRect | null> = [];
  for (let index = 0; index < optionCount; index += 1) rects.push(getRect(index));
  const fromGeometry = rectIndexAtPoint(x, y, rects, (rect) => rect);
  return fromGeometry !== null && fromGeometry < optionCount ? fromGeometry : null;
};

/** 坐标是否落在这个元素真正渲染出来的范围内（用于按钮之类的命中判定）。 */
export const isPointInsideElement = (x: number, y: number, element: HTMLElement | null): boolean => {
  if (!element || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const hit = document.elementFromPoint(x, y);
  return Boolean(hit && (hit === element || element.contains(hit)));
};

/**
 * 纯包含判定：光标落在哪个矩形里就返回哪个的下标，落在空隙里返回 null。
 *
 * 和 `nearestRectIndex` 的区别是这里**不做"最近"猜测**——"光标在哪就选哪个"
 * 是唯一规则，多个矩形同时命中（理论上不会重叠）时取中心更近的那个。
 */
export const rectIndexAtPoint = <T,>(
  x: number,
  y: number,
  candidates: readonly T[],
  getRect: (candidate: T) => { left: number; top: number; right: number; bottom: number } | null | undefined,
  padding: number = HAND_HIT_PADDING_PX,
): number | null => {
  let best: { index: number; distance: number } | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const rect = getRect(candidates[index]);
    if (!rect) continue;
    if (x < rect.left - padding || x > rect.right + padding) continue;
    if (y < rect.top - padding || y > rect.bottom + padding) continue;
    const distance = Math.hypot(x - (rect.left + rect.right) / 2, y - (rect.top + rect.bottom) / 2);
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best ? best.index : null;
};

// ─── 相对指针（空中鼠标） ──────────────────────────────────

/**
 * 为什么不再做"画面坐标 → 屏幕坐标"的绝对映射：
 *
 * 摄像头装在屏幕上方、画幅 4:3 而屏幕 16:9，视野比屏幕宽得多。要把画面坐标
 * 直接换算成屏幕坐标，就必须知道"手在画面里走多少 = 走完一个屏幕宽"，而这个
 * 比例随摄像头型号、距离、摆放角度而变，只能估。估错了就是系统性的压缩/偏移：
 * 指左边光标偏右、指右边光标偏左，而且偏差能到几百像素——靠调 gain/offset 是
 * 猜不完的。
 *
 * 相对模式彻底绕开这个未知量：不关心手"在画面里的绝对位置"，只关心手**移动了
 * 多少**，把这个位移按比例加到光标上。于是：
 * - 方向对了就一定跟手（mirrorX 决定左右，只有两种可能）；
 * - 没有偏移、没有压缩，光标就是手；
 * - 手往哪挪，光标往哪挪，用户看着光标把它挪进想要的选项框即可。
 */
interface HandPointerSteering {
  /** 当前光标位置，视口归一化 [0,1]。 */
  x: number;
  y: number;
  /** 上一帧指尖的原始画面坐标；null = 还没锚定，下一帧原地锚定（不跳变）。 */
  rawX: number | null;
  rawY: number | null;
}

const steering: HandPointerSteering = { x: 0.5, y: 0.5, rawX: null, rawY: null };

/** 摄像头常见画幅比例，用来让纵向灵敏度和屏幕比例匹配（横竖位移手感一致）。 */
const CAMERA_FRAME_ASPECT = 4 / 3;

/**
 * 单帧位移超过这个比例就当作"重新捕捉/换了只手"，原地重新锚定，
 * 而不是让光标瞬移一大截。
 */
const STEERING_TELEPORT_THRESHOLD = 0.22;

/** 把光标放回屏幕中央并解除锚定（下一帧从手当前位置重新开始跟随）。 */
export const resetHandPointerSteering = (x: number = 0.5, y: number = 0.5) => {
  steering.x = clamp(x, 0, 1);
  steering.y = clamp(y, 0, 1);
  steering.rawX = null;
  steering.rawY = null;
};

/** 当前光标位置（视口归一化）。 */
export const getHandPointerSteering = (): { x: number; y: number } => ({ x: steering.x, y: steering.y });

/**
 * 用指尖的原始画面坐标推进光标，返回新的视口归一化光标位置。
 *
 * 每帧都把锚点更新到当前指尖位置，所以光标顶到屏幕边缘后再往回移动会立刻
 * 响应，不会出现"死区"。
 */
export const updateHandPointerSteering = (
  rawX: number,
  rawY: number,
  mirrorX: boolean = HAND_POINTER_CALIBRATION.mirrorX,
  sensitivity: number = ACTIVE_SENSITIVITY,
): { x: number; y: number } => {
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return { x: steering.x, y: steering.y };

  // 没锚定（刚开机/手刚被抓到）：记住此刻的手的位置，光标留在原地不动。
  if (steering.rawX === null || steering.rawY === null) {
    steering.rawX = rawX;
    steering.rawY = rawY;
    return { x: steering.x, y: steering.y };
  }

  const dx = rawX - steering.rawX;
  const dy = rawY - steering.rawY;
  steering.rawX = rawX;
  steering.rawY = rawY;

  // 手突然"瞬移"（丢帧后重新捕捉、换手）→ 只重新锚定，不让光标跟着瞬移。
  if (Math.hypot(dx, dy) > STEERING_TELEPORT_THRESHOLD) {
    return { x: steering.x, y: steering.y };
  }

  // 画面里手往右 → 原始坐标往左（摄像头看到的是对面），所以要翻转一次。
  const speed = Math.hypot(dx, dy);
  const boost = 1 + Math.min(speed * POINTER_ACCEL_K, POINTER_ACCEL_MAX);
  const gainX = (mirrorX ? -sensitivity : sensitivity) * boost;
  // 画面竖直方向 1 个单位对应的物理距离比水平方向短（画幅 4:3，屏幕 16:9），
  // 换算成屏幕高度的比例后纵向要乘这个系数，横竖手感才一致。
  const aspect = typeof window !== 'undefined' && window.innerHeight > 0
    ? window.innerWidth / window.innerHeight
    : 16 / 9;
  const gainY = sensitivity * (aspect / CAMERA_FRAME_ASPECT) * boost;

  steering.x = clamp(steering.x + dx * gainX, 0, 1);
  steering.y = clamp(steering.y + dy * gainY, 0, 1);
  return { x: steering.x, y: steering.y };
};

// ─── 手势形状判定 ────────────────────────────────────────────

/** MediaPipe 关键点的最小结构，避免这个文件去依赖上层类型。 */
export interface LandmarkLike {
  x: number;
  y: number;
}

/**
 * 一根手指（不含拇指）是否伸直。
 *
 * 用"指尖到手腕的距离 > 指根关节到手腕的距离"判断，而不是比较 y 坐标：
 * 这样手掌竖着、斜着、甚至横过来都能正确识别，只依赖手本身的形状。
 */
const isFingerStraight = (
  landmarks: Array<LandmarkLike | null | undefined>,
  tipIdx: number,
  pipIdx: number,
  wrist: LandmarkLike,
  ratio: number = 1.1,
): boolean => {
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  if (!tip || !pip) return false;
  const tipDistance = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const pipDistance = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  return tipDistance > pipDistance * ratio;
};

/** 食指是否伸直——能当指针用的前提。 */
export const isPointingGesture = (
  landmarks: Array<LandmarkLike | null | undefined> | null | undefined,
): boolean => {
  if (!landmarks || landmarks.length < 9) return false;
  const wrist = landmarks[0];
  if (!wrist) return false;
  const tip = landmarks[8];
  const pip = landmarks[6];
  if (!tip || !pip) return false;
  // 指尖在指根上方（手竖着指），或者明显比指根更远离手腕（手斜着指）。
  return tip.y < pip.y - 0.01 || isFingerStraight(landmarks, 8, 6, wrist, 1.08);
};

/**
 * 张开手掌（五指张开）——用作"下一题 / 继续"这类**非指向性**手势。
 *
 * 要求食指/中指/无名指/小指里至少 3 根伸直。只伸食指（指向作答）不满足，
 * 所以不会和答题时的指向手势冲突。
 */
export const isOpenPalmGesture = (
  landmarks: Array<LandmarkLike | null | undefined> | null | undefined,
): boolean => {
  if (!landmarks || landmarks.length < 21) return false;
  const wrist = landmarks[0];
  if (!wrist) return false;
  let straight = 0;
  for (const tipIdx of [8, 12, 16, 20]) {
    if (isFingerStraight(landmarks, tipIdx, tipIdx - 2, wrist, 1.15)) straight += 1;
  }
  return straight >= 3;
};

// ─── 自动标定 ────────────────────────────────────────────────

/**
 * 一次"屏幕目标点 ↔ 摄像头原始坐标"的观测。
 *
 * 由答题过程自动产生：用户稳定悬停 / 确认作答时，把他当时指尖的原始坐标
 * 和被选中的选项中心记下来，无需任何专门的校准流程。
 */
export interface CalibrationSample {
  rawX: number;
  rawY: number;
  targetX: number;
  targetY: number;
  weight: number;
}

let HAND_POINTER_SAMPLES: CalibrationSample[] = (() => {
  const stored = readJson<CalibrationSample[]>(SAMPLES_STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(
      (sample) =>
        sample &&
        [sample.rawX, sample.rawY, sample.targetX, sample.targetY].every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        ),
    )
    .slice(-MAX_SAMPLES);
})();

export const getHandPointerSamples = (): readonly CalibrationSample[] => HAND_POINTER_SAMPLES;

export const clearHandPointerSamples = () => {
  HAND_POINTER_SAMPLES = [];
  removeKey(SAMPLES_STORAGE_KEY);
  resetHandPointerCalibration();
};

const weightedLeastSquares = (
  samples: readonly CalibrationSample[],
  readRaw: (sample: CalibrationSample) => number,
  readTarget: (sample: CalibrationSample) => number,
): { slope: number; intercept: number } | null => {
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const sample of samples) {
    const w = Math.max(0.001, sample.weight ?? 1);
    const x = readRaw(sample);
    const y = readTarget(sample);
    weight += w;
    sumX += w * x;
    sumY += w * y;
    sumXX += w * x * x;
    sumXY += w * x * y;
  }
  if (weight <= 0) return null;
  const denominator = weight * sumXX - sumX * sumX;
  // 采样点几乎重合时解不出斜率（例如用户全程指着同一个选项）。
  if (Math.abs(denominator) < 1e-6) return null;
  const slope = (weight * sumXY - sumX * sumY) / denominator;
  return { slope, intercept: (sumY - slope * sumX) / weight };
};

/**
 * 出厂默认值拆成 `screen = a * raw + b` 的斜率和截距，作为拟合的"先验"。
 *
 * 关键：先验只按权重去**平滑**拟合结果，而不是当成两个高杠杆的伪观测点丢进
 * 最小二乘——伪观测点放在画面两侧会凭杠杆效应压过真实采样，导致采样再多也
 * 收敛不到真实映射。
 */
/**
 * 自动学习把"当前标定"当成先验（而不是出厂默认值）。
 *
 * 这样即使只有极少量采样点、不足以解出斜率（例如刚完成两点校准后的首次作答
 * 只产生 1 个样本，最小二乘分母为零解不出），也会**保留**两点校准得到的映射，
 * 而不是回退到一套与摄像头摆放无关的出厂猜测——后者正是"指哪偏哪"的来源。
 *
 * 注意：先验的镜像方向必须与"数据判定的镜像方向"一致，否则镜像数据 + 非镜像
 * 先验会正负抵消、截距量级错配，解出错误的增益/偏移。镜像方向完全由数据斜率
 * 符号决定（见 solveHandPointerCalibration）。
 */

/** 先验相当于几次观测的话语权。采样越多，真实数据越占上风。取 2 让前几题就能快速收敛。 */
const PRIOR_WEIGHT = 2;

/**
 * 用采样点反解标定参数。对 `screen = a * raw + b` 做加权最小二乘：
 *
 * - `a < 0` 说明画面左右与屏幕相反 → mirrorX = true（镜像预览下的常态）。
 * - `|a|` 就是 gain：`|a| ≈ 1.8` 表示手在画面里走 0.55 就横穿了整块屏幕宽度。
 * - 截距 b 换算成 offset，解决摄像头不在屏幕正中带来的整体偏移。
 *
 * 采样少时结果贴近出厂默认值，采样多了就交给真实数据；采样点重合（例如用户
 * 全程指着同一个选项）解不出斜率时直接回落默认值，不会解出荒唐的增益。
 */
export const solveHandPointerCalibration = (
  samples: readonly CalibrationSample[],
): HandPointerCalibration => {
  const totalWeight = samples.reduce((sum, sample) => sum + Math.max(0.001, sample.weight ?? 1), 0);

  // 镜像方向**锁定为当前设置值，绝不由数据反推**。
  // 原因：一旦方向错了，选中的就是镜像后的错误选项，确认时又把"错误选项中心"当标签
  // 记进样本 → 数据自己也会反推出错误方向 → 正反馈，方向永远改不回来（这正是此前
  // 反复翻转却总被自动改回去的根因）。方向属于设备属性，应由用户用「翻转左右」决定。
  const mirrorX = HAND_POINTER_CALIBRATION.mirrorX;

  // 在"已镜像"的空间里做拟合：predictor 直接取 mirroredX，
  // 于是模型就是 target = gain * mirroredX + intercept，斜率恒为正 = 增益。
  const fitX = weightedLeastSquares(
    samples,
    (s) => (mirrorX ? 1 - s.rawX : s.rawX),
    (s) => s.targetX,
  );
  const fitY = weightedLeastSquares(samples, (s) => s.rawY, (s) => s.targetY);

  // 先验同样在镜像空间里构造，保证与拟合同号、可直接加权混合。
  const baseGainX = Math.abs(HAND_POINTER_CALIBRATION.gainX);
  const baseOffsetX = HAND_POINTER_CALIBRATION.offsetX;
  const priorSlopeX = baseGainX;
  const priorInterceptX = -0.5 * baseGainX + 0.5 + baseOffsetX;

  const baseGainY = Math.abs(HAND_POINTER_CALIBRATION.gainY);
  const baseOffsetY = HAND_POINTER_CALIBRATION.offsetY;
  const priorSlopeY = baseGainY;
  const priorInterceptY = -0.5 * baseGainY + 0.5 + baseOffsetY;

  // 斜率为负说明样本与锁定方向矛盾（多半是方向设错导致的错误标签）。
  // 此时**丢弃这批样本、保留先验**，而不是把负斜率当增益用——否则会把映射搞坏。
  const blendPositive = (
    fit: { slope: number; intercept: number } | null,
    priorSlope: number,
    priorIntercept: number,
  ) => {
    if (!fit || !(fit.slope > 1e-4)) return { slope: priorSlope, intercept: priorIntercept };
    return {
      slope: (totalWeight * fit.slope + PRIOR_WEIGHT * priorSlope) / (totalWeight + PRIOR_WEIGHT),
      intercept: (totalWeight * fit.intercept + PRIOR_WEIGHT * priorIntercept) / (totalWeight + PRIOR_WEIGHT),
    };
  };

  const x = blendPositive(fitX, priorSlopeX, priorInterceptX);
  const y = blendPositive(fitY, priorSlopeY, priorInterceptY);

  const gainX = x.slope;
  const gainY = y.slope;

  return clampCalibration({
    mirrorX,
    gainX,
    gainY,
    offsetX: x.intercept - 0.5 + 0.5 * gainX,
    offsetY: y.intercept - 0.5 + 0.5 * gainY,
  });
};

/**
 * 记录一次自动观测并立即重算标定。
 *
 * @param rawX / rawY 摄像头原始指尖归一化坐标（controlRef.current.handRawFingertip）
 * @param targetX / targetY 被选中选项中心的视口归一化坐标
 * @param weight 置信度权重：稳定悬停 1，确认作答 3
 */
export const recordHandPointerSample = (
  rawX: number,
  rawY: number,
  targetX: number,
  targetY: number,
  weight: number = 1,
) => {
  // 默认开启自动采样（HAND_POINTER_AUTO_LEARN_TRUSTED 默认 true）。出厂默认已接近
  // 真实几何、基本正确，确认时记下的"原始指尖 → 被选中选项中心"多为正确标注，
  // 只会让映射越调越准。显式关闭自动学习时此函数直接返回。
  if (!HAND_POINTER_AUTO_LEARN_TRUSTED) return;
  if (![rawX, rawY, targetX, targetY].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
  HAND_POINTER_SAMPLES = [...HAND_POINTER_SAMPLES, { rawX, rawY, targetX, targetY, weight }].slice(-MAX_SAMPLES);
  writeJson(SAMPLES_STORAGE_KEY, HAND_POINTER_SAMPLES);
  setHandPointerCalibration(solveHandPointerCalibration(HAND_POINTER_SAMPLES), { persist: true });
};

/**
 * 自动学习开关：默认开启。
 *
 * 出厂默认已经接近真实几何（基本正确），所以答题时"确认即采样"得到的标注大多是
 * 正确的——用户指的框大致就是光标落到的框——自动最小二乘只会把它收敛得更准，
 * 不会再出现早期"偏 → 选错 → 学错 → 更偏"的循环。手动两点校准可作为可选的快速
 * 拉准手段，但已非必需。显式调用 markHandPointerAutoLearnTrusted(false) 可关闭。
 */
const AUTO_LEARN_TRUSTED_KEY = 'shuzhi.handPointerAutoLearnTrusted.v2';

let HAND_POINTER_AUTO_LEARN_TRUSTED: boolean = (() => {
  if (typeof window === 'undefined') return true;
  try {
    // 默认开启（键不存在视为开启）；仅当显式写为 '0' 时才关闭。
    return window.localStorage.getItem(AUTO_LEARN_TRUSTED_KEY) !== '0';
  } catch {
    return true;
  }
})();

/** 是否已允许自动学习（即完成过手动校准）。 */
export const isHandPointerAutoLearnTrusted = (): boolean => HAND_POINTER_AUTO_LEARN_TRUSTED;

export const markHandPointerAutoLearnTrusted = (trusted: boolean = true) => {
  HAND_POINTER_AUTO_LEARN_TRUSTED = trusted;
  if (typeof window === 'undefined') return;
  try {
    if (trusted) window.localStorage.setItem(AUTO_LEARN_TRUSTED_KEY, '1');
    else window.localStorage.removeItem(AUTO_LEARN_TRUSTED_KEY);
  } catch {
    // 隐私模式下写入失败只影响下次会话的默认值。
  }
};

/**
 * 手动两点校准：用户用食指先后指向屏幕上的两个已知标记（左上、右下），
 * 用两次的原始指尖坐标直接解出线性映射，替代"出厂猜的"默认值。
 *
 * `calibrateHandPoint` 的公式 screen = (mirror(raw) − 0.5)·gain + 0.5 + offset
 * 等价于 screen = mirror(raw)·gain + (0.5 − 0.5·gain + offset)。
 * 已知 mirror(raw₁) → 0、mirror(raw₂) → 1，即可解出 gain 与 offset。
 *
 * 返回 null 表示两点太接近（手指没真正挪到标记上），拒绝应用以免解出荒唐增益。
 */
export const calibrateHandPointerFromRawPoints = (
  first: { x: number; y: number },
  second: { x: number; y: number },
  firstScreen: { x: number; y: number } = { x: 0, y: 0 },
  secondScreen: { x: number; y: number } = { x: 1, y: 1 },
): HandPointerCalibration | null => {
  if (
    ![first.x, first.y, second.x, second.y].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  ) {
    return null;
  }
  let mirrorX = HAND_POINTER_CALIBRATION.mirrorX;
  let x1 = mirrorX ? 1 - first.x : first.x;
  let x2 = mirrorX ? 1 - second.x : second.x;
  // 若镜像方向下第二点反而更靠左，说明镜像假设反了，自动纠正方向。
  const flipMirror = x2 < x1;
  if (flipMirror) {
    mirrorX = !mirrorX;
    x1 = mirrorX ? 1 - first.x : first.x;
    x2 = mirrorX ? 1 - second.x : second.x;
  }
  const y1 = first.y;
  const y2 = second.y;
  // 两个观测点（原始坐标跨度、屏幕目标跨度）都要足够大，否则解不稳。
  if (
    Math.abs(x2 - x1) < 0.12 ||
    Math.abs(y2 - y1) < 0.08 ||
    Math.abs(secondScreen.x - firstScreen.x) < 0.05 ||
    Math.abs(secondScreen.y - firstScreen.y) < 0.05
  ) {
    return null;
  }

  // 用标记"真实屏幕位置"作目标，而非写死的 (0,0)/(1,1)：
  // 这样手指指在标记中心时，指针就落在标记中心，偏移为零。
  const gainX = clamp((secondScreen.x - firstScreen.x) / (x2 - x1), 0.6, 3.5);
  const gainY = clamp((secondScreen.y - firstScreen.y) / (y2 - y1), 0.6, 3.5);
  const offsetX = clamp(firstScreen.x - 0.5 - (x1 - 0.5) * gainX, -0.6, 0.6);
  const offsetY = clamp(firstScreen.y - 0.5 - (y1 - 0.5) * gainY, -0.6, 0.6);
  const next: HandPointerCalibration = { mirrorX, gainX, gainY, offsetX, offsetY };
  // 旧样本是上一套映射的产物，全部作废，避免污染新一轮自动学习。
  clearHandPointerSamples();
  setHandPointerCalibration(next, { persist: true });
  return HAND_POINTER_CALIBRATION;
};

// ─── 个人瞄准偏移（自动闭环补偿） ─────────────────────────────
//
// 为什么需要它：固定种子（?handnudge，单位=选项框宽）只能治"当前这一次"的偏差。
// 真正的偏差来源很多——摄像头几何、装的上下位置、关键点误差、手指标记点偏差——
// 靠猜默认值永远调不准。所以改成**闭环**：每次确认时量"光标离框心差多少"，
// 按 AIM_OFFSET_GAIN 的比例累进，答几题后残差自动趋近 0，光标自己居中。
//
// 为什么限幅这么小（0.12 屏宽，约 0.4 个选项框）：
// 早期版本给到 ±0.4 屏宽（比一个框还宽），叠加固定种子后会把光标推出框外
// （用户实测"现在会往左边出框"）。补偿只能做**微调**，大偏差应该由 gain/offset
// 标定去解决，不能让补偿把光标甩出框。

const AIM_OFFSET_STORAGE_KEY = 'shuzhi.handAimOffset.v2';
/** 补偿上限（归一化屏宽）。约 0.4 个选项框，只够做微调。 */
const AIM_OFFSET_LIMIT = 0.12;
/** 每道题吸收多少残差。太大易过冲、太小收敛慢。 */
const AIM_OFFSET_GAIN = 0.25;

const clampAim = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(AIM_OFFSET_LIMIT, Math.max(-AIM_OFFSET_LIMIT, value));
};

let handAimOffset: { x: number; y: number } = { x: 0, y: 0 };

const loadHandAimOffset = (): { x: number; y: number } => {
  const stored = readJson<{ x?: unknown; y?: unknown }>(AIM_OFFSET_STORAGE_KEY);
  if (!stored) return { x: 0, y: 0 };
  const x = typeof stored.x === 'number' ? clampAim(stored.x) : 0;
  const y = typeof stored.y === 'number' ? clampAim(stored.y) : 0;
  return { x, y };
};

handAimOffset = loadHandAimOffset();
removeKey('shuzhi.handAimOffset.v1');

/** 当前个人瞄准偏移（归一化屏宽，x 正=光标再往左挪）。 */
export const getHandAimOffset = (): { x: number; y: number } => ({ ...handAimOffset });

/**
 * 记一次残差（cursor − 框心，归一化屏宽），按比例累进补偿。
 * 返回值即更新后的补偿量，调用方可直接用于下一帧。
 */
export const addHandAimOffset = (residualX: number, residualY: number): { x: number; y: number } => {
  handAimOffset = {
    x: clampAim(handAimOffset.x + (Number.isFinite(residualX) ? residualX : 0) * AIM_OFFSET_GAIN),
    y: clampAim(handAimOffset.y + (Number.isFinite(residualY) ? residualY : 0) * AIM_OFFSET_GAIN),
  };
  writeJson(AIM_OFFSET_STORAGE_KEY, handAimOffset);
  return { ...handAimOffset };
};

/** 清空自动补偿（调试面板用；怀疑补偿学歪了就点它）。 */
export const resetHandAimOffset = (): { x: number; y: number } => {
  handAimOffset = { x: 0, y: 0 };
  removeKey(AIM_OFFSET_STORAGE_KEY);
  return { ...handAimOffset };
};
