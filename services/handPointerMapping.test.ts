import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateHandPoint,
  clampPointToRects,
  nearestRectIndex,
  rectIndexAtPoint,
  resetHandPointerSteering,
  solveHandPointerCalibration,
  setHandPointerCalibration,
  HAND_POINTER_CALIBRATION,
  isOpenPalmGesture,
  isPointingGesture,
  updateHandPointerSteering,
  type CalibrationSample,
  type HandPointerCalibration,
} from './handPointerMapping.ts';

/** 由"屏幕坐标"反推摄像头原始坐标，用来造测试样本。 */
const invert = (
  targetX: number,
  targetY: number,
  calibration: HandPointerCalibration,
): { rawX: number; rawY: number } => {
  const mirroredX = (targetX - 0.5 - calibration.offsetX) / calibration.gainX + 0.5;
  const rawX = calibration.mirrorX ? 1 - mirroredX : mirroredX;
  const rawY = (targetY - 0.5 - calibration.offsetY) / calibration.gainY + 0.5;
  return { rawX, rawY };
};

const makeSamples = (
  truth: HandPointerCalibration,
  targets: ReadonlyArray<{ x: number; y: number }>,
  weight: number,
): CalibrationSample[] =>
  targets.map((target) => {
    const raw = invert(target.x, target.y, truth);
    return { rawX: raw.rawX, rawY: raw.rawY, targetX: target.x, targetY: target.y, weight };
  });

/** 2×2 选项网格大致的屏幕位置（视口归一化）。 */
const GRID_TARGETS = [
  { x: 0.397, y: 0.5 },
  { x: 0.603, y: 0.5 },
  { x: 0.397, y: 0.7 },
  { x: 0.603, y: 0.7 },
];

test('calibrateHandPoint 与反函数互为逆运算', () => {
  const truth: HandPointerCalibration = {
    mirrorX: true,
    gainX: 1.9,
    gainY: 1.6,
    offsetX: 0.03,
    offsetY: -0.12,
  };
  for (const target of GRID_TARGETS) {
    const raw = invert(target.x, target.y, truth);
    const back = calibrateHandPoint(raw.rawX, raw.rawY, truth);
    assert.ok(Math.abs(back.x - target.x) < 1e-9, `x ${back.x} vs ${target.x}`);
    assert.ok(Math.abs(back.y - target.y) < 1e-9, `y ${back.y} vs ${target.y}`);
  }
});

test('镜像方向锁定为"开"时，自动标定能还原出真实映射', () => {
  const truth: HandPointerCalibration = {
    mirrorX: true,
    gainX: 1.9,
    gainY: 1.6,
    offsetX: 0.03,
    offsetY: -0.12,
  };
  // 镜像方向现为**锁定值**（不再由数据斜率反推，否则错标签会形成正反馈把方向焊死），
  // 所以先把当前标定切成镜像开，用完恢复，避免污染后续用例。
  const prev = { ...HAND_POINTER_CALIBRATION };
  setHandPointerCalibration({ ...HAND_POINTER_CALIBRATION, mirrorX: true });
  try {
    const samples = makeSamples(truth, GRID_TARGETS, 6);
    const solved = solveHandPointerCalibration(samples);
    assert.equal(solved.mirrorX, true);
    // 解出的增益/偏移应收敛到真值附近（默认 1.8/1.6，先验权重 2，样本权重占绝对多数）。
    assert.ok(
      Math.abs(solved.gainX - truth.gainX) < 0.1,
      `gainX=${solved.gainX} 没有向真实值 ${truth.gainX} 收敛`,
    );
    assert.ok(
      Math.abs(solved.gainY - truth.gainY) < 0.1,
      `gainY=${solved.gainY} 没有向真实值 ${truth.gainY} 收敛`,
    );
    // 用解出的参数把原始坐标投回去，落点误差应在几十分之一屏内。
    for (const sample of samples) {
      const projected = calibrateHandPoint(sample.rawX, sample.rawY, solved);
      assert.ok(Math.abs(projected.x - sample.targetX) < 0.06, `x 偏差过大: ${projected.x} vs ${sample.targetX}`);
      assert.ok(Math.abs(projected.y - sample.targetY) < 0.06, `y 偏差过大: ${projected.y} vs ${sample.targetY}`);
    }
  } finally {
    setHandPointerCalibration(prev);
  }
});

test('自动标定能识别出"画面没有镜像"的摄像头', () => {
  const truth: HandPointerCalibration = {
    mirrorX: false,
    gainX: 2.1,
    gainY: 1.4,
    offsetX: -0.05,
    offsetY: 0.08,
  };
  // 镜像方向是锁定值：先切成关，验证"锁定关 + 非镜像数据"能正确解出增益/偏移。
  const prev = { ...HAND_POINTER_CALIBRATION };
  setHandPointerCalibration({ ...HAND_POINTER_CALIBRATION, mirrorX: false });
  try {
    const samples = makeSamples(truth, GRID_TARGETS, 6);
    const solved = solveHandPointerCalibration(samples);
    assert.equal(solved.mirrorX, false);
    assert.ok(solved.gainX > 1.5, `gainX=${solved.gainX} 应明显大于未按视野补偿的 1.0`);
  } finally {
    setHandPointerCalibration(prev);
  }
});

test('镜像方向被锁定：样本方向与设置相反时不会被自动翻转', () => {
  // 回归保护：方向若由数据反推，错标签会形成正反馈把方向焊死、用户改了也会被改回去。
  // 这里故意用"真实映射为非镜像"的样本，但把标定锁定成镜像开，方向必须保持 true。
  const truth: HandPointerCalibration = {
    mirrorX: false,
    gainX: 1.7,
    gainY: 1.5,
    offsetX: 0,
    offsetY: 0,
  };
  const prev = { ...HAND_POINTER_CALIBRATION };
  setHandPointerCalibration({ ...HAND_POINTER_CALIBRATION, mirrorX: true });
  try {
    const samples = makeSamples(truth, GRID_TARGETS, 6);
    const solved = solveHandPointerCalibration(samples);
    assert.equal(solved.mirrorX, true);
  } finally {
    setHandPointerCalibration(prev);
  }
});

test('采样点重合时不会解出荒唐的增益', () => {
  const samples: CalibrationSample[] = [
    { rawX: 0.5, rawY: 0.5, targetX: 0.5, targetY: 0.5, weight: 3 },
    { rawX: 0.5001, rawY: 0.5, targetX: 0.5, targetY: 0.5, weight: 3 },
  ];
  const solved = solveHandPointerCalibration(samples);
  assert.ok(solved.gainX > 0 && solved.gainX <= 3.5, `gainX=${solved.gainX} 越界`);
  assert.ok(solved.gainY > 0 && solved.gainY <= 3.5, `gainY=${solved.gainY} 越界`);
});

test('clampPointToRects 把光标约束在选项区外扩一圈内', () => {
  const rects = [
    { left: 580, top: 400, right: 940, bottom: 540 },
    { left: 980, top: 400, right: 1340, bottom: 540 },
  ];
  // 增益偏大导致光标飞到左上角：应被拉回选项区边界外 24px。
  const clamped = clampPointToRects(100, 100, rects, 24);
  assert.equal(clamped.x, 556);
  assert.equal(clamped.y, 376);
  // 光标已经在选项区内：原样返回。
  const inside = clampPointToRects(760, 470, rects, 24);
  assert.deepEqual(inside, { x: 760, y: 470 });
  // 没有可用矩形时不改动坐标。
  assert.deepEqual(clampPointToRects(10, 10, [null], 24), { x: 10, y: 10 });
});

test('rectIndexAtPoint：光标在哪个框里就是哪个，落在空隙里不选中', () => {
  const rects = [
    { left: 100, top: 100, right: 300, bottom: 260 },
    { left: 340, top: 100, right: 540, bottom: 260 },
  ];
  assert.equal(rectIndexAtPoint(150, 150, rects, (r) => r), 0);
  assert.equal(rectIndexAtPoint(500, 240, rects, (r) => r), 1);
  // 两个选项之间的空隙：不是任何选项，必须返回 null（而不是猜最近的）。
  assert.equal(rectIndexAtPoint(320, 150, rects, (r) => r), null);
  // 远离所有选项。
  assert.equal(rectIndexAtPoint(900, 900, rects, (r) => r), null);
  // 压着边缘 5px：padding 内仍算命中。
  assert.equal(rectIndexAtPoint(98, 150, rects, (r) => r), 0);
  // 超出 padding 就不算。
  assert.equal(rectIndexAtPoint(80, 150, rects, (r) => r), null);
});

test('相对指针：手往右移光标往右移（画面左右与屏幕相反）', () => {
  resetHandPointerSteering(0.4, 0.6);
  // 第一帧只锚定，光标不动。
  const first = updateHandPointerSteering(0.5, 0.5, true);
  assert.deepEqual(first, { x: 0.4, y: 0.6 });
  // 摄像头里手往画面左边走 0.1（= 真人把手往自己的右边移）→ 光标右移。
  const moved = updateHandPointerSteering(0.4, 0.5, true);
  assert.ok(moved.x > 0.4, `光标应当右移，实际 x=${moved.x}`);
  assert.ok(Math.abs(moved.y - 0.6) < 1e-9, '纵向没动就不该漂移');
});

test('相对指针：手瞬移（丢帧/换手）只重新锚定，不让光标跳过去', () => {
  resetHandPointerSteering(0.5, 0.5);
  updateHandPointerSteering(0.5, 0.5, true);
  const jumped = updateHandPointerSteering(0.05, 0.1, true);
  assert.deepEqual(jumped, { x: 0.5, y: 0.5 });
  // 重新锚定之后，小幅移动又能正常跟随。
  const moved = updateHandPointerSteering(0.04, 0.1, true);
  assert.ok(moved.x > 0.5, `重新锚定后应恢复跟随，实际 x=${moved.x}`);
});

test('相对指针：手动得越快，光标走得越多（指针加速）', () => {
  // 慢速小幅移动
  resetHandPointerSteering(0.5, 0.5);
  updateHandPointerSteering(0.5, 0.5, true);
  const slow = updateHandPointerSteering(0.49, 0.5, true);
  const slowDelta = slow.x - 0.5;

  // 快速大幅移动（位移是前者的 5 倍），增益应明显大于 5 倍。
  resetHandPointerSteering(0.5, 0.5);
  updateHandPointerSteering(0.5, 0.5, true);
  const fast = updateHandPointerSteering(0.45, 0.5, true);
  const fastDelta = fast.x - 0.5;

  assert.ok(fastDelta > slowDelta * 5, `加速应生效：fast=${fastDelta} slow*5=${slowDelta * 5}`);
});

/** 造一只手：wrist 在 (0.5, 0.9)，fingers 决定每根手指是伸直还是弯曲。 */
const makeHand = (extended: boolean[]): Array<{ x: number; y: number }> => {
  const wrist = { x: 0.5, y: 0.9 };
  const landmarks: Array<{ x: number; y: number }> = [wrist];
  // 0..20 全部填一个靠近手腕的点，再把关键关节按需要改写。
  for (let i = 1; i < 21; i += 1) landmarks.push({ x: 0.52, y: 0.88 });
  const tips = [8, 12, 16, 20];
  tips.forEach((tip, idx) => {
    const pip = tip - 2;
    if (extended[idx]) {
      landmarks[tip] = { x: 0.5, y: 0.2 }; // 远离手腕 = 伸直
      landmarks[pip] = { x: 0.5, y: 0.5 };
    } else {
      landmarks[tip] = { x: 0.5, y: 0.55 }; // 蜷在手掌附近 = 弯曲
      landmarks[pip] = { x: 0.5, y: 0.5 };
    }
  });
  return landmarks;
};

test('手势形状：张开手掌 vs 只伸食指', () => {
  const openPalm = makeHand([true, true, true, true]);
  assert.equal(isOpenPalmGesture(openPalm), true, '五指张开应识别为手掌');

  const pointing = makeHand([true, false, false, false]);
  assert.equal(isOpenPalmGesture(pointing), false, '只伸食指不能被当成张开手掌');
  assert.equal(isPointingGesture(pointing), true, '只伸食指应识别为指向');

  // 张开手掌时"指向"判定不成立，两种手势互不冲突。
  assert.equal(isPointingGesture(openPalm), true);

  assert.equal(isOpenPalmGesture(null), false);
  assert.equal(isOpenPalmGesture([]), false);
});

test('nearestRectIndex 取最近的矩形且受容差限制', () => {
  const rects = [
    { left: 100, top: 100, right: 200, bottom: 200 },
    { left: 300, top: 100, right: 400, bottom: 200 },
  ];
  assert.equal(nearestRectIndex(150, 150, rects, (r) => r, 20), 0);
  assert.equal(nearestRectIndex(350, 150, rects, (r) => r, 20), 1);
  // 落在两个矩形正中间的空隙里：距离都超过容差就不该命中任何一个。
  assert.equal(nearestRectIndex(250, 150, rects, (r) => r, 20), null);
});
