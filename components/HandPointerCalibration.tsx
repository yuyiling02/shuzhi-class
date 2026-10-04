import React, { useEffect, useRef, useState } from 'react';
import { ControlRefs } from '../types';
import {
  calibrateHandPointerFromRawPoints,
  markHandPointerAutoLearnTrusted,
} from '../services/handPointerMapping';

const CALIBRATE_EVENT = 'shuzhi:handcalibrate';

/** 校准是否正在进行（答题命中判定据此暂停，避免瞄准标记时误选选项）。 */
let CALIBRATION_ACTIVE = false;
export const isHandPointerCalibrationActive = (): boolean => CALIBRATION_ACTIVE;

/** 地址栏带 `?handcal=1` 时自动进入校准。 */
export const isHandPointerCalibrationRequested = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('handcal');
  } catch {
    return false;
  }
};

/** 两个校准标记的视口归一化位置：左上、右下（避开手指/摄像头固定够不到的极限角落）。 */
const TARGETS = [
  { x: 0.14, y: 0.22 },
  { x: 0.86, y: 0.78 },
] as const;

/** 指尖稳定多久算"指稳了"（毫秒）。 */
const STABLE_MS = 800;
/** 指尖原始坐标的稳定容差（归一化位移）。 */
const STABLE_TOLERANCE = 0.018;

interface HandPointerCalibrationProps {
  controlRef: React.MutableRefObject<ControlRefs>;
}

type Status = 'aiming' | 'done' | 'failed';

/**
 * 手势指针两点校准。
 *
 * 屏幕上先后出现两个标记，用食指指向标记中心保持约 0.8 秒即自动采集。
 * 两个"原始指尖坐标 → 已知屏幕位置"的观测足以直接解出线性映射（增益/偏移/镜像），
 * 从根上消除出厂默认值与真实摄像头摆放之间的偏差——这是"指向跟光标一致"的保证。
 *
 * 唤起方式：调试面板的"校准"按钮，或地址栏加 `?handcal=1`。
 */
const HandPointerCalibration: React.FC<HandPointerCalibrationProps> = ({ controlRef }) => {
  const [active, setActive] = useState<boolean>(isHandPointerCalibrationRequested);
  const [step, setStep] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);
  const [status, setStatus] = useState<Status>('aiming');
  const [sawFinger, setSawFinger] = useState<boolean>(false);
  const firstPointRef = useRef<{ x: number; y: number } | null>(null);

  // 向外同步激活状态（答题命中判定据此暂停）。
  useEffect(() => {
    CALIBRATION_ACTIVE = active && status !== 'done';
    return () => {
      CALIBRATION_ACTIVE = false;
    };
  }, [active, status]);

  // 调试面板的"校准"按钮通过自定义事件唤起。
  useEffect(() => {
    const open = () => {
      firstPointRef.current = null;
      setStep(0);
      setProgress(0);
      setStatus('aiming');
      setActive(true);
    };
    window.addEventListener(CALIBRATE_EVENT, open);
    return () => window.removeEventListener(CALIBRATE_EVENT, open);
  }, []);

  // 采集循环：指向标记的指尖稳定 STABLE_MS 后自动采集。
  useEffect(() => {
    if (!active || status !== 'aiming') return;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    let stableMs = 0;
    let prevTs = performance.now();
    let lastPct = -1;

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(100, now - prevTs);
      prevTs = now;
      const raw = controlRef.current?.handRawFingertip ?? null;
      setSawFinger(Boolean(raw));
      if (raw) {
        const moved = last ? Math.hypot(raw.x - last.x, raw.y - last.y) : Number.POSITIVE_INFINITY;
        stableMs = moved <= STABLE_TOLERANCE ? stableMs + dt : 0;
        last = { x: raw.x, y: raw.y };
        const pct = Math.round(Math.min(1, stableMs / STABLE_MS) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          setProgress(pct);
        }
        if (pct >= 100) {
          const captured = { x: raw.x, y: raw.y };
          if (step === 0) {
            firstPointRef.current = captured;
            setStep(1);
            setProgress(0);
            return; // step 变化会重建采集循环
          }
          const first = firstPointRef.current;
          const solved = first
            ? calibrateHandPointerFromRawPoints(first, captured, TARGETS[0], TARGETS[1])
            : null;
          if (solved) {
            // 手动校准可信，此后才允许"确认即采样"的自动微调。
            markHandPointerAutoLearnTrusted(true);
            setStatus('done');
            window.setTimeout(() => setActive(false), 1500);
          } else {
            setStatus('failed');
          }
          return;
        }
      } else {
        stableMs = 0;
        last = null;
        if (lastPct !== 0) {
          lastPct = 0;
          setProgress(0);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, status, step, controlRef]);

  if (!active) return null;

  const target = TARGETS[step];
  const targetLeft = target.x * window.innerWidth;
  const targetTop = target.y * window.innerHeight;
  const radius = 26;
  const size = radius * 2 + 24;
  const circumference = 2 * Math.PI * radius;

  const restart = () => {
    firstPointRef.current = null;
    setStep(0);
    setProgress(0);
    setStatus('aiming');
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      <div className="absolute inset-0 bg-slate-950/40" />

      {/* 当前目标标记：外圈是进度环，中心是指向点 */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: targetLeft, top: targetTop }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="rgba(34,211,238,0.08)" stroke="rgba(34,211,238,0.35)" strokeWidth={3} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress / 100)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
          <circle cx={size / 2} cy={size / 2} r={4} fill="#22d3ee" />
        </svg>
      </div>

      {/* 说明 / 状态 */}
      <div className="absolute left-1/2 top-8 -translate-x-1/2 rounded-xl border border-cyan-400/40 bg-slate-950/90 px-5 py-3 text-center text-sm text-cyan-100 shadow-lg backdrop-blur">
        {status === 'done' && <span>✅ 校准完成，现在指到哪个框就选哪个框</span>}
        {status === 'failed' && <span>⚠️ 两次采集的位置太接近，请分别指向两个标记后重试</span>}
        {status === 'aiming' && (
          <span>
            第 {step + 1}/2 步：用食指指向<strong>发光圆圈中心</strong>并保持不动
            {!sawFinger && '（未检测到食指，请伸直食指进入摄像头画面）'}
          </span>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="pointer-events-auto absolute bottom-8 left-1/2 flex -translate-x-1/2 gap-3">
        {(status === 'failed' || status === 'done') && (
          <button
            type="button"
            onClick={restart}
            className="rounded-lg border border-cyan-400/50 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/20"
          >
            重新校准
          </button>
        )}
        <button
          type="button"
          onClick={() => setActive(false)}
          className="rounded-lg border border-slate-400/40 px-4 py-2 text-sm text-slate-300 hover:bg-slate-400/20"
        >
          关闭
        </button>
      </div>
    </div>
  );
};

export default HandPointerCalibration;
