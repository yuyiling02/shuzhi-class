import React, { useEffect, useRef, useState } from 'react';
import { ControlRefs } from '../types';
import {
  HAND_HIT_PADDING_PX,
  HAND_POINTER_CALIBRATION,
  HitRect,
  getHandPointerSensitivity,
  getHandAimOffset,
  isHandPointerAutoLearnTrusted,
  resetHandAimOffset,
  resetHandPointerSteering,
  setHandPointerCalibration,
  setHandPointerSensitivity,
} from '../services/handPointerMapping';

/** 是否开启手势指针调试读数。地址栏加 `?handdebug=1` 即可打开。 */
export const isHandPointerDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('handdebug') === '1';
};

interface HandPointerDebugProps {
  controlRef: React.MutableRefObject<ControlRefs>;
  /** 当前命中的选项下标，由调用方传入，便于确认"命中"与"光标"是否一致。 */
  getHitOption?: () => number | null;
  /** 选项的矩形，用于在读数里核对命中判定所用的矩形。 */
  getOptionRects?: () => Array<HitRect | null>;
}

/**
 * 手势指针调试读数。
 *
 * 逐帧显示：原始指尖归一化坐标 → 标定后的视口归一化坐标 → 屏幕像素坐标，
 * 以及当前命中的选项下标和每个选项的基准矩形。用于判断偏移发生在哪一步：
 * - 原始坐标不动、光标却跑 → 标定参数问题（gain/offset）
 * - 手指往左、原始 x 反而变大 → 镜像方向反了（mirrorX）
 * - 光标压在选项上却不命中 → 基准矩形过期或容差问题
 */
const HandPointerDebug: React.FC<HandPointerDebugProps> = ({ controlRef, getHitOption, getOptionRects }) => {
  const [sample, setSample] = useState<string>('等待手部数据…');
  const rectSummaryRef = useRef<string>('');
  const [mirrorX, setMirrorX] = useState<boolean>(HAND_POINTER_CALIBRATION.mirrorX);
  const [sensitivity, setSensitivity] = useState<number>(() => getHandPointerSensitivity());
  const [aimOffset, setAimOffset] = useState<{ x: number; y: number }>(() => getHandAimOffset());

  useEffect(() => {
    let animFrame = 0;
    let lastUpdate = 0;

    const tick = () => {
      const now = performance.now();
      // 4Hz 更新，避免每帧 setState。
      if (now - lastUpdate > 250) {
        lastUpdate = now;
        const raw = controlRef.current.handRawFingertip;
        const pointer = controlRef.current.handPointer;
        const hit = getHitOption?.() ?? null;

        if (!raw || !pointer) {
          setSample('未检测到食指（请伸直食指并进入摄像头画面）');
        } else {
          const screenX = Math.round(pointer.x * window.innerWidth);
          const screenY = Math.round(pointer.y * window.innerHeight);
          const rects = getOptionRects?.() ?? [];
          const rectText = rects
            .map((rect, index) =>
              rect
                ? `#${index} [${Math.round(rect.left)},${Math.round(rect.top)} → ${Math.round(rect.right)},${Math.round(rect.bottom)}]`
                : `#${index} null`,
            )
            .join('  ');
          rectSummaryRef.current = rectText;
          setSample(
            [
              `原始 raw  x=${raw.x.toFixed(3)}  y=${raw.y.toFixed(3)}`,
              `标定 ptr  x=${pointer.x.toFixed(3)}  y=${pointer.y.toFixed(3)}`,
              `屏幕 px   x=${screenX}  y=${screenY}  (视口 ${window.innerWidth}×${window.innerHeight})`,
              `模式 绝对（标定映射 · ${isHandPointerAutoLearnTrusted() ? '已手动校准' : '出厂默认，建议校准'}）`,
              `命中  ${hit === null ? '无' : `#${hit}`}   包含判定 +${HAND_HIT_PADDING_PX}px`,
              `瞄准补偿 x=${aimOffset.x.toFixed(3)}  y=${aimOffset.y.toFixed(3)}（归一化屏宽，正=光标左移）`,
              rectText ? `矩形  ${rectText}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
      }
      animFrame = requestAnimationFrame(tick);
    };

    animFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame);
  }, [controlRef, getHitOption, getOptionRects]);

  const toggleMirrorX = () => {
    const next = !mirrorX;
    setMirrorX(next);
    setHandPointerCalibration({ mirrorX: next });
  };

  return (
    <div className="pointer-events-auto fixed bottom-4 left-4 z-[9998] rounded-xl border border-cyan-400/40 bg-slate-950/90 px-3 py-2 text-[10px] leading-5 text-cyan-200 shadow-lg backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-bold">手势调试</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('shuzhi:handcalibrate'))}
          className="rounded border border-emerald-400/50 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-400/20"
          title="指两次屏幕标记，解出真实映射，做到指哪选哪"
        >
          校准
        </button>
        <button
          type="button"
          onClick={toggleMirrorX}
          className="rounded border border-cyan-400/40 px-2 py-0.5 text-[10px] hover:bg-cyan-400/20"
        >
          镜像X: {mirrorX ? '开' : '关'}
        </button>
        <button
          type="button"
          onClick={() => {
            resetHandPointerSteering();
            setMirrorX(HAND_POINTER_CALIBRATION.mirrorX);
          }}
          className="rounded border border-rose-400/40 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-400/20"
          title="把光标放回屏幕中央并解除锚定"
        >
          光标归位
        </button>
        <button
          type="button"
          onClick={() => setAimOffset(resetHandAimOffset())}
          className="rounded border border-amber-400/40 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-400/20"
          title="清空自动学来的偏移补偿（光标被补偿推出框外时用）"
        >
          清瞄准补偿
        </button>
        <span className="flex items-center gap-1" title="手指挪一屏的宽度，光标走几个屏幕宽">
          <button
            type="button"
            onClick={() => setSensitivity(setHandPointerSensitivity(sensitivity - 0.4))}
            className="rounded border border-cyan-400/40 px-1.5 py-0.5 text-[10px] hover:bg-cyan-400/20"
          >
            −
          </button>
          <span className="tabular-nums">灵敏度 {sensitivity.toFixed(1)}</span>
          <button
            type="button"
            onClick={() => setSensitivity(setHandPointerSensitivity(sensitivity + 0.4))}
            className="rounded border border-cyan-400/40 px-1.5 py-0.5 text-[10px] hover:bg-cyan-400/20"
          >
            ＋
          </button>
        </span>
      </div>
      <pre className="whitespace-pre font-mono">{sample}</pre>
    </div>
  );
};

export default HandPointerDebug;
