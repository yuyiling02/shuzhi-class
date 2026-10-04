
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ControlRefs, HandLandmarks } from '../types';
import { createQuizSession, getQuizResult, QuizSession, QuizQuestion } from '../services/quizData';
import { prepareXiaozhiSpeech, speakXiaozhi, stopXiaozhiSpeech } from '../services/xiaozhiSpeechService';
import { X, Trophy, Star, Clock, CheckCircle2, XCircle, Zap, Sparkles, Loader2, SkipForward } from 'lucide-react';
import {
  HAND_OPTION_INDEX_ATTR,
  addHandAimOffset,
  getHandAimOffset,
  recordHandPointerSample,
} from '../services/handPointerMapping';
import HandPointerDebug, { isHandPointerDebugEnabled } from './HandPointerDebug';
import HandPointerCalibration, { isHandPointerCalibrationActive } from './HandPointerCalibration';

/**
 * 在若干选项里找"离光标最近的那个框中心"。
 *
 * 这比"问浏览器光标压在哪个元素上"更鲁棒：当摄像头摆放导致指针整体偏移时，
 * 手指朝向哪个框，离光标最近的框中心就是哪个框——选中的一定是你想选的。
 * 自动学习也用这个中心当标签，于是映射会收敛到真实几何，指针最终贴合手指。
 */
const nearestOptionIndex = (
  px: number,
  py: number,
  optionEls: (HTMLDivElement | null)[],
  count: number,
): { index: number | null; centerX: number; centerY: number } => {
  let best = -1;
  let bestDist = Infinity;
  let bestCx = 0;
  let bestCy = 0;
  for (let i = 0; i < count; i += 1) {
    const el = optionEls[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
      bestCx = cx;
      bestCy = cy;
    }
  }
  // 手放下/在框外很远时不选中，避免误触。
  const threshold = Math.max(window.innerWidth, window.innerHeight) * 0.45;
  if (best < 0 || bestDist > threshold) {
    return { index: null, centerX: 0, centerY: 0 };
  }
  return { index: best, centerX: bestCx, centerY: bestCy };
};

/**
 * 光标微调 = 固定种子（框宽倍数）+ 自动闭环补偿（个人瞄准偏移）。
 *
 * 固定种子：整体往左挪 0.75 个选项框宽（用户实测光标偏右约 3/4 个框）。以**实际
 * 选项框宽度**为单位，自适应布局与屏幕；可用 `?handnudge=0.75` 临时覆盖
 * （正数往左、负数往右）。
 *
 * 自动闭环补偿（根治偏移的关键）：固定种子只能治"当前这一次"的偏差，换设备、挪
 * 摄像头就会复发。所以每次确认时测量「光标离框心差多少」（残差），交给服务层的
 * `addHandAimOffset` 按比例累进并持久化（限幅很小，只做微调，避免把光标推出框外）。
 * 答几题后残差会自动收敛到 0，光标自己居中，无需手调 `?handnudge`；
 * 怀疑补偿学歪了就用 `?handdebug=1` 面板的「清瞄准补偿」一键复位。
 *
 * 注意：偏移必须同时作用于「光标绘制」「命中判定」「自动学习的标签」三处，
 * 否则自动学习会把偏移学回去、导致光标和选中的框互相错位。
 */
const HAND_POINTER_NUDGE_DEFAULT_BOXES = 0.75;
const readHandNudgeBoxes = (): number => {
  if (typeof window === 'undefined') return HAND_POINTER_NUDGE_DEFAULT_BOXES;
  const raw = new URLSearchParams(window.location.search).get('handnudge');
  if (raw === null) return HAND_POINTER_NUDGE_DEFAULT_BOXES;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : HAND_POINTER_NUDGE_DEFAULT_BOXES;
};

/** 取当前选项框的实际宽度（px），用于把「框宽倍数」换算成像素。 */
const measureOptionBoxWidth = (optionEls: (HTMLDivElement | null)[], count: number): number => {
  for (let i = 0; i < count; i += 1) {
    const el = optionEls[i];
    if (el) return el.getBoundingClientRect().width;
  }
  return 0;
};

interface QuizOverlayProps {
  stageRef: React.RefObject<HTMLElement>;
  controlRef: React.MutableRefObject<ControlRefs>;
  cameraActive: boolean;
  onExit: () => void;
  subjectFilter?: string;
  onComplete?: (result: ReturnType<typeof getQuizResult>, session: QuizSession) => void;
}

type QuizPhase = 'intro' | 'reading' | 'answering' | 'result' | 'summary';

/** 结果页"张开手掌 → 下一题"需要保持多久（毫秒）。 */
const NEXT_GESTURE_HOLD_MS = 800;

/**
 * 某根手指是否基本伸直：指尖到手腕的距离明显大于指根到手腕的距离。
 * 用于判断"张开手掌"手势，避免依赖 MediaPipe 的额外手势分类。
 */
const isFingerStraight = (
  landmarks: HandLandmarks,
  tipIdx: number,
  pipIdx: number,
  wrist: { x: number; y: number },
  ratio: number = 1.1,
): boolean => {
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  if (!tip || !pip) return false;
  const tipDistance = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const pipDistance = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  return tipDistance > pipDistance * ratio;
};

/** 张开手掌：四指中至少三指伸直即视为"手掌张开"。 */
const isOpenPalmGesture = (landmarks: HandLandmarks): boolean => {
  if (!landmarks || landmarks.length < 21) return false;
  const wrist = landmarks[0];
  if (!wrist) return false;
  let straight = 0;
  for (const tipIdx of [8, 12, 16, 20]) {
    if (isFingerStraight(landmarks, tipIdx, tipIdx - 2, wrist, 1.15)) straight += 1;
  }
  return straight >= 3;
};

// ─── Component ───────────────────────────────────────────
const QuizOverlay: React.FC<QuizOverlayProps> = ({ stageRef, controlRef, cameraActive, onExit, subjectFilter, onComplete }) => {
  const [phase, setPhase] = useState<QuizPhase>('intro');
  const [session, setSession] = useState<QuizSession>(() => createQuizSession(5, subjectFilter));
  const [countdown, setCountdown] = useState(3);
  const [hoveredOption, setHoveredOption] = useState<number | null>(null);
  const [hoverProgress, setHoverProgress] = useState(0); // 0 to 1
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [expandedWrongId, setExpandedWrongId] = useState<string | null>(null);
  const [xiaozhiExplainingId, setXiaozhiExplainingId] = useState<string | null>(null);

  const speakQuiz = useCallback((text: string) => speakXiaozhi(text, {
    onStart: () => setVoiceError(''),
    onError: (error) => {
      console.warn('[Quiz voice] Browser speech unavailable:', error);
      setVoiceError('当前浏览器语音播报暂不可用，答题流程将继续');
    },
  }), []);

  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const restartBtnRef = useRef<HTMLButtonElement>(null);
  const exitBtnRef = useRef<HTMLButtonElement>(null);
  const restartProgressRef = useRef<HTMLDivElement>(null);
  const exitProgressRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  /** 最近一次测到的选项框宽度（px），结果页没有选项时用它在那里也做同样的左移微调。 */
  const optionWidthRef = useRef(0);
  /** 最近一帧光标的屏幕坐标，确认时用来算「离框心差多少」。 */
  const lastCursorRef = useRef({ x: 0, y: 0 });
  const pointerSmoothRef = useRef({ x: 0, y: 0, initialized: false });
  const pointerStableRef = useRef({ x: 0, y: 0, initialized: false });
  const pointerStableSinceRef = useRef(0);
  const hoverStartRef = useRef<number>(0);
  const hoverOptionRef = useRef<number | null>(null);
  const hoverCandidateRef = useRef<{ option: number | null; frames: number }>({ option: null, frames: 0 });
  const lastProgressPctRef = useRef<number>(-1);
  const phaseRef = useRef(phase);
  const sessionRef = useRef(session);
  const reportedSessionRef = useRef<number | null>(null);
  /** 结果页"张开手掌 → 下一题"的进度条：直接改 DOM，避免每帧 re-render。 */
  const nextGestureBarRef = useRef<HTMLDivElement>(null);
  /** 答题区摄像头小框的视频元素，复用 HandController 公布的同一路 MediaStream。 */
  const smallCamRef = useRef<HTMLVideoElement>(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    prepareXiaozhiSpeech();
    return () => stopXiaozhiSpeech();
  }, []);

  const currentQuestion: QuizQuestion | null =
    session.currentIndex < session.questions.length
      ? session.questions[session.currentIndex]
      : null;

  const quizResult = phase === 'summary' ? getQuizResult(session) : null;

  useEffect(() => {
    if (phase !== 'summary' || !quizResult || reportedSessionRef.current === session.startTime) return;
    reportedSessionRef.current = session.startTime;
    onComplete?.(quizResult, session);
  }, [onComplete, phase, quizResult, session]);

  // ─── Phase: INTRO ──────────────────────────────────────
  useEffect(() => {
    if (phase !== 'intro') return;
    let cancelled = false;
    (async () => {
      // Don't await speech so countdown starts immediately
      speakQuiz('答题模式已开启，准备好了吗？');
      
      // countdown 3, 2, 1
      for (let i = 3; i >= 1; i--) {
        if (cancelled) return;
        setCountdown(i);
        await new Promise(r => setTimeout(r, 1000));
      }
      if (cancelled) return;
      setPhase('reading');
    })();
    return () => { cancelled = true; };
  }, [phase, speakQuiz]);

  // ─── Phase: READING (TTS only, no typewriter) ─────────────────
  useEffect(() => {
    if (phase !== 'reading' || !currentQuestion) return;
    setSelectedAnswer(null);
    setIsCorrect(null);
    setHoveredOption(null);
    setHoverProgress(0);
    setShowExplanation(false);
    hoverOptionRef.current = null;
    pointerSmoothRef.current.initialized = false;
    pointerStableRef.current.initialized = false;
    pointerStableSinceRef.current = 0;
    hoverCandidateRef.current = { option: null, frames: 0 };

    const qText = currentQuestion.question;

    // Speak the question
    speakQuiz(`第 ${sessionRef.current.currentIndex + 1} 题。${qText}`);
    
    // Immediately advance to answering phase
    setPhase('answering');

  }, [phase, currentQuestion, speakQuiz]);

  // ─── Phase: ANSWERING — hand hover detection ───────────
  useEffect(() => {
    if (phase !== 'answering' || !currentQuestion) return;
    const HOVER_CONFIRM_MS = 1200;
    let animFrame: number;
    const optionCount = currentQuestion.options.length;

    const checkHover = () => {
      if (phaseRef.current !== 'answering') return;

      let hitOption: number | null = null;

      // 1. 食指指向判定：消费 HandController 每帧算好的绝对映射指针 handPointer。
      // 校准进行中暂停命中，避免瞄准校准标记时误选选项。
      if (cameraActive && !isHandPointerCalibrationActive()) {
        const handPointer = controlRef.current.handPointer;
        const handLm = controlRef.current.interactionHandLandmarks;
        if (handPointer && handLm && handLm.length > 17) {
          // 弯曲的食指不可靠。要求食指伸直，避免手掌/其他手指在移动时误选。
          const wrist = handLm[0];
          const indexTip = handLm[8];
          const indexPip = handLm[6];
          const tipDistance = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y);
          const pipDistance = Math.hypot(indexPip.x - wrist.x, indexPip.y - wrist.y);
          const isPointing = indexTip.y < indexPip.y - 0.01 || tipDistance > pipDistance * 1.08;
          if (!isPointing) {
            // 手收回（非指向）：隐藏光标、命中置空；相对指针会在手势重捕时自动重新锚定。
            hitOption = null;
            if (pointerRef.current) pointerRef.current.style.opacity = '0';
            pointerStableRef.current.initialized = false;
            pointerStableSinceRef.current = 0;
          } else {
            // handPointer 是"手指在屏幕上指到的位置"的估计值（绝对映射 + 自动标定）。
            // 摄像头摆放带来的整体偏移会让它和真实手指略有出入，所以选中不靠"光标压在
            // 哪个元素上"，而是取"离光标最近的选项框中心"——手指朝向哪个框就选哪个框。
            // 水平微调：整体左移「半个选项框」的宽度（用户实测光标偏右半个框）。
            // screenX 已经带上这个偏移，后面的命中/绘制/稳定判定都基于它，保持一致。
            const boxWidth = measureOptionBoxWidth(optionRefs.current, optionCount);
            if (boxWidth > 0) optionWidthRef.current = boxWidth;
            const aim = getHandAimOffset();
            const nudgePx = (boxWidth > 0 ? boxWidth : optionWidthRef.current) * readHandNudgeBoxes()
              + aim.x * window.innerWidth;
            const nudgePy = aim.y * window.innerHeight;
            const screenX = handPointer.x * window.innerWidth - nudgePx;
            const screenY = handPointer.y * window.innerHeight - nudgePy;
            lastCursorRef.current.x = screenX;
            lastCursorRef.current.y = screenY;

            const nearest = nearestOptionIndex(screenX, screenY, optionRefs.current, optionCount);
            hitOption = nearest.index;

            // 光标连续跟随手指（绝对映射后的位置），不吸附到框——用户能看见光标实时
            // 移动，并自己把手指挪到想选的框上。框高亮 + 停顿确认即选中该框；自动学习
            // 会把映射收敛到"光标正好落在框心"，答几道题后光标自然居中到框中间。
            if (pointerRef.current) {
              pointerRef.current.style.transform = `translate(${screenX}px, ${screenY}px)`;
              pointerRef.current.style.opacity = '1';
            }

            const now = performance.now();
            const stable = pointerStableRef.current;
            const movement = stable.initialized ? Math.hypot(screenX - stable.x, screenY - stable.y) : Infinity;
            if (!stable.initialized || movement > 20) {
              stable.x = screenX;
              stable.y = screenY;
              stable.initialized = true;
              pointerStableSinceRef.current = now;
            } else {
              stable.x = stable.x * 0.8 + screenX * 0.2;
              stable.y = stable.y * 0.8 + screenY * 0.2;
            }
          }
        } else {
          if (pointerRef.current) pointerRef.current.style.opacity = '0';
          pointerStableRef.current.initialized = false;
          pointerStableSinceRef.current = 0;
        }
      }

      // Update hover state
      if (hitOption !== null && pointerStableRef.current.initialized && performance.now() - pointerStableSinceRef.current >= 140) {
        // Require a few consecutive frames before switching options. This filters
        // single-frame detector jitter at the boundary between adjacent cards.
        const candidate = hoverCandidateRef.current;
        if (candidate.option === hitOption) candidate.frames += 1;
        else hoverCandidateRef.current = { option: hitOption, frames: 1 };
        const candidateReady = hoverOptionRef.current === hitOption || hoverCandidateRef.current.frames >= 4;

        if (!candidateReady) {
          // Do not let the previous card continue counting while a new card is
          // being verified at a boundary.
          hoverStartRef.current = performance.now();
          lastProgressPctRef.current = 0;
          setHoverProgress(0);
        } else if (hoverOptionRef.current === hitOption) {
          // Same option — accumulate hover time
          const elapsed = performance.now() - hoverStartRef.current;
          const progress = Math.min(1, Math.max(0, elapsed / HOVER_CONFIRM_MS));
          // 只在 progress 的整数 % 变化时才 setState，避免每帧 re-render
          const progressPct = Math.round(progress * 100);
          if (progressPct !== lastProgressPctRef.current) {
            lastProgressPctRef.current = progressPct;
            setHoverProgress(progress);
          }

          if (progress >= 1) {
            // Confirmed! 用这次命中记录一次自动标定：原始指尖坐标 → 该选项中心，
            // 让后续映射越来越准（手不用挪到屏幕边就能指到框里）。
            const raw = controlRef.current.handRawFingertip;
            const optEl = optionRefs.current[hitOption];
            if (raw && optEl) {
              const r = optEl.getBoundingClientRect();
              const centerX = (r.left + r.right) / 2;
              const centerY = (r.top + r.bottom) / 2;

              // ① 自动闭环补偿（根治偏移）：量一下"确认瞬间光标离框心差多少"，
              //    按服务层的增益累进（限幅很小，只做微调，避免把光标推出框外）。
              const residualX = (lastCursorRef.current.x - centerX) / window.innerWidth;
              const residualY = (lastCursorRef.current.y - centerY) / window.innerHeight;
              const nextAim = addHandAimOffset(residualX, residualY);

              // ② 自动标定：标签记「物理投影位置」= 框心 + 微调量（含自动补偿量）。
              //    因为光标显示时会左移 nudge，映射必须先偏右同样的量，光标才落在框心；
              //    若这里记框心、显示却左移，自动学会把偏移学回去，光标与选中框会错位。
              const learnNudgePx = optionWidthRef.current * readHandNudgeBoxes()
                + nextAim.x * window.innerWidth;
              const learnNudgePy = nextAim.y * window.innerHeight;
              recordHandPointerSample(
                raw.x,
                raw.y,
                (centerX + learnNudgePx) / window.innerWidth,
                (centerY + learnNudgePy) / window.innerHeight,
                3,
              );
            }
            confirmAnswer(hitOption);
            return;
          }
        } else if (candidateReady) {
          // Switched to a different option (or first hit)
          hoverOptionRef.current = hitOption;
          // Require a short settle period after entering a new option.
          hoverStartRef.current = performance.now() + 140;
          lastProgressPctRef.current = 0;
          setHoveredOption(hitOption);
          setHoverProgress(0);
        }
      } else {
        // No option hovered
        hoverCandidateRef.current = { option: null, frames: 0 };
        if (hoverOptionRef.current !== null) {
          hoverOptionRef.current = null;
          lastProgressPctRef.current = -1;
          setHoveredOption(null);
          setHoverProgress(0);
        }
      }

      animFrame = requestAnimationFrame(checkHover);
    };

    animFrame = requestAnimationFrame(checkHover);
    return () => cancelAnimationFrame(animFrame);
  }, [phase, cameraActive, currentQuestion]);

  // ─── Phase: SUMMARY — hand hover detection ───────────
  useEffect(() => {
    if (phase !== 'summary') return;
    const HOVER_CONFIRM_MS = 2000;
    let animFrame: number;
    let restartHoverStart = 0;
    let exitHoverStart = 0;

    const checkHover = () => {
      if (phaseRef.current !== 'summary') return;

      if (cameraActive) {
        const handPointer = controlRef.current.handPointer;
        if (handPointer) {
          // 结果页同样左移「半个框」，与答题阶段的映射保持一致（重玩/退出按钮的命中
          // 判定也用这个坐标，否则映射被学成偏右半个框后会点不中按钮）。
          const resultAim = getHandAimOffset();
          const resultNudgePx = optionWidthRef.current * readHandNudgeBoxes()
            + resultAim.x * window.innerWidth;
          const resultNudgePy = resultAim.y * window.innerHeight;
          const targetX = handPointer.x * window.innerWidth - resultNudgePx;
          const targetY = handPointer.y * window.innerHeight - resultNudgePy;

          if (!pointerSmoothRef.current.initialized) {
            pointerSmoothRef.current.x = targetX;
            pointerSmoothRef.current.y = targetY;
            pointerSmoothRef.current.initialized = true;
          } else {
            pointerSmoothRef.current.x = pointerSmoothRef.current.x * 0.85 + targetX * 0.15;
            pointerSmoothRef.current.y = pointerSmoothRef.current.y * 0.85 + targetY * 0.15;
          }

          const screenX = pointerSmoothRef.current.x;
          const screenY = pointerSmoothRef.current.y;

            if (pointerRef.current) {
              pointerRef.current.style.transform = `translate(${screenX}px, ${screenY}px)`;
              pointerRef.current.style.opacity = '1';
            }

            const margin = 10;
            let hitRestart = false;
            let hitExit = false;

            if (restartBtnRef.current) {
              const rect = restartBtnRef.current.getBoundingClientRect();
              if (screenX >= rect.left - margin && screenX <= rect.right + margin &&
                  screenY >= rect.top - margin && screenY <= rect.bottom + margin) {
                hitRestart = true;
              }
            }

            if (exitBtnRef.current) {
              const rect = exitBtnRef.current.getBoundingClientRect();
              if (screenX >= rect.left - margin && screenX <= rect.right + margin &&
                  screenY >= rect.top - margin && screenY <= rect.bottom + margin) {
                hitExit = true;
              }
            }

            const now = Date.now();

            if (hitRestart) {
              if (restartHoverStart === 0) restartHoverStart = now;
              exitHoverStart = 0;
              if (exitProgressRef.current) exitProgressRef.current.style.width = '0%';
              const progress = Math.min((now - restartHoverStart) / HOVER_CONFIRM_MS, 1);
              if (restartProgressRef.current) restartProgressRef.current.style.width = `${progress * 100}%`;
              if (progress >= 1) {
                // handleRestart will be called when click confirms, but it's defined later.
                // We can't directly call it here because it's captured in the closure. 
                // So we'll click the button ref instead.
                restartBtnRef.current?.click();
                restartHoverStart = 0;
                if (restartProgressRef.current) restartProgressRef.current.style.width = '0%';
              }
            } else if (hitExit) {
              if (exitHoverStart === 0) exitHoverStart = now;
              restartHoverStart = 0;
              if (restartProgressRef.current) restartProgressRef.current.style.width = '0%';
              const progress = Math.min((now - exitHoverStart) / HOVER_CONFIRM_MS, 1);
              if (exitProgressRef.current) exitProgressRef.current.style.width = `${progress * 100}%`;
              if (progress >= 1) {
                exitBtnRef.current?.click();
                exitHoverStart = 0;
                if (exitProgressRef.current) exitProgressRef.current.style.width = '0%';
              }
            } else {
              restartHoverStart = 0;
              exitHoverStart = 0;
              if (restartProgressRef.current) restartProgressRef.current.style.width = '0%';
              if (exitProgressRef.current) exitProgressRef.current.style.width = '0%';
            }
          }
        } else {
          if (pointerRef.current) pointerRef.current.style.opacity = '0';
          restartHoverStart = 0;
          exitHoverStart = 0;
          if (restartProgressRef.current) restartProgressRef.current.style.width = '0%';
          if (exitProgressRef.current) exitProgressRef.current.style.width = '0%';
        }

      animFrame = requestAnimationFrame(checkHover);
    };

    animFrame = requestAnimationFrame(checkHover);
    return () => cancelAnimationFrame(animFrame);
  }, [phase, cameraActive]);

  const checkHitOnOptions = (screenX: number, screenY: number, count: number): number | null => {
    const activeOption = hoverOptionRef.current;
    const strictHits: Array<{ index: number; distance: number }> = [];
    for (let idx = 0; idx < count; idx++) {
      const el = optionRefs.current[idx];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (
        screenX >= rect.left && screenX <= rect.right &&
        screenY >= rect.top && screenY <= rect.bottom
      ) {
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        strictHits.push({ index: idx, distance: Math.hypot(screenX - cx, screenY - cy) });
      }
    }
    if (strictHits.length) {
      return strictHits.sort((a, b) => a.distance - b.distance)[0].index;
    }

    // Keep a modest hysteresis zone for the currently selected card, but never
    // expand every card at once (which made neighboring options overlap).
    if (activeOption !== null) {
      const el = optionRefs.current[activeOption];
      if (el) {
        const rect = el.getBoundingClientRect();
        const margin = 22;
        if (screenX >= rect.left - margin && screenX <= rect.right + margin &&
            screenY >= rect.top - margin && screenY <= rect.bottom + margin) {
          return activeOption;
        }
      }
    }
    return null;
  };

  // ─── Answer confirmation ───────────────────────────────
  const confirmAnswer = useCallback((optionIndex: number) => {
    if (phaseRef.current !== 'answering' || !currentQuestion) return;
    
    phaseRef.current = 'result'; // Synchronously block duplicate calls
    setPhase('result');
    setSelectedAnswer(optionIndex);
    
    const correct = optionIndex === currentQuestion.correctIndex;
    setIsCorrect(correct);
    setHoveredOption(null);
    setHoverProgress(0);
    hoverOptionRef.current = null;

    // Record answer
    setSession(prev => {
      const newAnswers = [...prev.answers];
      newAnswers[prev.currentIndex] = optionIndex;
      return { ...prev, answers: newAnswers };
    });
  }, [currentQuestion]);

  // ─── Advance to next question (shared by auto-advance & skip) ───
  const advanceToNextQuestion = useCallback(() => {
    const nextIndex = sessionRef.current.currentIndex + 1;
    if (nextIndex >= sessionRef.current.questions.length) {
      setPhase('summary');
    } else {
      setSession(prev => ({ ...prev, currentIndex: nextIndex }));
      setPhase('reading');
    }
  }, []);

  // Skip the current result narration: stop speaking and jump to the next question.
  const skipResult = useCallback(() => {
    stopXiaozhiSpeech();
    advanceToNextQuestion();
  }, [advanceToNextQuestion]);

  // ─── Phase: RESULT ───────────────────────────────────────
  useEffect(() => {
    if (phase !== 'result' || !currentQuestion || selectedAnswer === null) return;
    let cancelled = false;
    let advanceTimer: number | null = null;

    const correct = selectedAnswer === currentQuestion.correctIndex;
    
    const advanceNext = () => {
      if (cancelled) return;
      advanceToNextQuestion();
    };

    if (correct) {
      speakQuiz('回答正确！');
      const timer = setTimeout(advanceNext, 2000);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    } else {
      (async () => {
        // Keep the quiz moving if local synthesis or audio playback stalls.
        const safeSpeak = (text: string, maxWait: number) => Promise.race([
          speakQuiz(text),
          new Promise<void>(r => setTimeout(r, maxWait))
        ]);

        await safeSpeak(`很遗憾，正确答案是 ${String.fromCharCode(65 + currentQuestion.correctIndex)}：${currentQuestion.options[currentQuestion.correctIndex]}`, 4000);
        if (cancelled) return;
        
        setShowExplanation(true);
        await safeSpeak(currentQuestion.explanation, 10000);
        if (cancelled) return;
        
        advanceTimer = window.setTimeout(advanceNext, 2000);
      })();
      
      return () => {
        cancelled = true;
        if (advanceTimer !== null) window.clearTimeout(advanceTimer);
      };
    }
  }, [phase, currentQuestion, selectedAnswer, speakQuiz, advanceToNextQuestion]);

  // ─── Phase: RESULT — 张开手掌直接进入下一题 ──────────────
  /**
   * 结果页原本要等播报讲完（答错时还要讲解析）才自动进下一题。这里给一个
   * 手势出口：张开手掌停住 0.8 秒就跳过播报进入下一题，全程不用碰鼠标。
   *
   * 用"张开手掌"而不是"指向"，是因为答题时用的是伸食指，两者不冲突——
   * 作答完手自然张开即可，不会在答题过程中被误判成"下一题"。
   */
  useEffect(() => {
    // 进入结果页先把答题用的光标收起来，避免它停在某个选项上误导。
    if (phase === 'result' && pointerRef.current) pointerRef.current.style.opacity = '0';
    if (phase !== 'result' || !cameraActive) return;

    let animFrame = 0;
    let holdStart = 0;

    const setBar = (width: string) => {
      if (nextGestureBarRef.current) nextGestureBarRef.current.style.width = width;
    };

    const check = () => {
      if (phaseRef.current !== 'result') return;
      const landmarks = controlRef.current.interactionHandLandmarks;
      const now = performance.now();

      if (isOpenPalmGesture(landmarks)) {
        if (!holdStart) holdStart = now;
        const progress = Math.min(1, (now - holdStart) / NEXT_GESTURE_HOLD_MS);
        setBar(`${Math.round(progress * 100)}%`);
        if (progress >= 1) {
          setBar('0%');
          skipResult();
          return;
        }
      } else {
        holdStart = 0;
        setBar('0%');
      }

      animFrame = requestAnimationFrame(check);
    };

    animFrame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(animFrame);
  }, [phase, cameraActive, skipResult, controlRef]);

  // ─── Answer-area camera small box ───────────────────────
  /** 复用 HandController 公布的同一路摄像头流，渲染一个小的自视图。 */
  useEffect(() => {
    const video = smallCamRef.current;
    // 摄像头小框的 <video> 只在 answering / result 阶段挂载，所以 phase 也必须进
    // 依赖：否则 cameraActive 变 true（intro 阶段）时视频还没挂上，effect 拿到
    // 的 smallCamRef 是 null 直接返回，等进入答题视频挂载后 effect 不再触发，
    // srcObject 永远没被设置，小窗就一片黑。
    if (!video || !cameraActive) return;
    let cancelled = false;
    let retry: number | null = null;

    const attach = () => {
      if (cancelled) return;
      const stream = controlRef.current.webcamStream;
      if (stream && video.srcObject !== stream) {
        video.srcObject = stream;
        // 某些浏览器在 srcObject 晚于 autoPlay 属性赋值后不会自动播放，显式 play。
        const playAttempt = video.play();
        if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
      } else if (!stream) {
        retry = window.setTimeout(attach, 200);
      }
    };
    attach();

    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
    };
  }, [cameraActive, controlRef, phase]);

  // ─── Speak summary on enter ────────────────────────────
  useEffect(() => {
    if (phase !== 'summary') return;
    const result = getQuizResult(sessionRef.current);
    speakQuiz(`答题结束！你共答对 ${result.correctCount} 题，正确率 ${result.accuracy}%，总用时 ${result.totalTime} 秒。`);
  }, [phase, speakQuiz]);

  // ─── Click fallback for non-camera mode ────────────────
  const handleOptionClick = (index: number) => {
    if (phase !== 'answering') return;
    confirmAnswer(index);
  };

  // ─── Xiaozhi explain wrong question ────────────────────
  const handleXiaozhiExplain = (q: QuizQuestion) => {
    // 正在讲解这道题时再点一次 = 跳过播报
    if (xiaozhiExplainingId === q.id) {
      stopXiaozhiSpeech();
      setXiaozhiExplainingId(null);
      return;
    }
    setXiaozhiExplainingId(q.id);
    const text = `这道题「${q.question}」的正确答案是 ${String.fromCharCode(65 + q.correctIndex)}：${q.options[q.correctIndex]}。${q.explanation}`;
    speakXiaozhi(text, {
      onEnd: () => setXiaozhiExplainingId(null),
      onError: () => setXiaozhiExplainingId(null),
    });
  };

  // ─── Exit handler ──────────────────────────────────────
  const handleExit = () => {
    stopXiaozhiSpeech();
    onExit();
  };

  const handleRestart = () => {
    stopXiaozhiSpeech();
    setVoiceError('');
    setSession(createQuizSession(5, subjectFilter));
    setPhase('intro');
    setCountdown(3);
  };

  // ─── Subject emoji helper ─────────────────────────────
  const subjectEmoji = (subject: string) => {
    switch (subject) {
      case '心脏模型': return '🫀';
      case 'HIV 病毒模型': return '🦠';
      case '金刚石模型': return '💎';
      case '金刚石晶胞': return '🧊';
      case '1,4-二氯甲基苯': return '⚗️';
      case 'NaCl 离子晶体': return '🧂';
      case 'SiO₂ 二氧化硅': return '🪨';
      case '硝基苯': return '🧪';
      case '地球内部结构': return '🌍';
      case '地形地貌': return '⛰️';
      default: return '📚';
    }
  };

  // ─── Render ────────────────────────────────────────────
  return (
    <div className="quiz-overlay">
      {/* Virtual Hand Pointer */}
      {cameraActive && (
        <div
          ref={pointerRef}
          className="fixed top-0 left-0 w-8 h-8 pointer-events-none z-[9999] opacity-0 transition-opacity duration-200 ease-out"
          style={{ willChange: 'transform', transform: 'translate(-100px, -100px)' }}
        >
          <div className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
            <div className="w-4 h-4 bg-cyan-400 rounded-full shadow-[0_0_15px_rgba(34,211,238,0.8)] animate-pulse" />
            <div className="absolute w-8 h-8 rounded-full border-2 border-cyan/50 animate-ping" />
          </div>
        </div>
      )}

      {isHandPointerDebugEnabled() && (
        <HandPointerDebug controlRef={controlRef} />
      )}

      {/* 手势指针两点校准（调试面板按钮或 ?handcal=1 唤起） */}
      <HandPointerCalibration controlRef={controlRef} />

      {/* Exit button */}
      <button
        className="quiz-exit-btn"
        onClick={handleExit}
        title="退出答题模式"
      >
        <X size={20} />
      </button>

      {voiceError && (
        <div
          role="status"
          className="fixed left-1/2 top-5 z-[9998] -translate-x-1/2 rounded-xl border border-amber-400/40 bg-slate-950/90 px-4 py-2 text-sm font-medium text-amber-200 shadow-lg backdrop-blur"
        >
          {voiceError}
        </div>
      )}

      {/* ─── INTRO PHASE ─── */}
      {phase === 'intro' && (
        <div className="quiz-center-container quiz-fade-in">
          <div className="quiz-intro-card">
            <div className="quiz-intro-icon">
              <Zap size={48} className="text-yellow-400" />
            </div>
            <h1 className="quiz-intro-title">答题挑战</h1>
            <p className="quiz-intro-subtitle">共 {session.questions.length} 题 · 手势选择答案</p>
            <div className="quiz-countdown-ring">
              <span className="quiz-countdown-number">{countdown}</span>
            </div>
          </div>
        </div>
      )}

      {/* ─── READING / ANSWERING / RESULT ─── */}
      {(phase === 'reading' || phase === 'answering' || phase === 'result') && currentQuestion && (
        <div
          className="quiz-game-container quiz-fade-in"
          onClick={phase === 'result' ? skipResult : undefined}
          title={phase === 'result' ? '点击屏幕任意处跳过播报' : undefined}
        >
          {/* Progress bar */}
          <div className="quiz-progress-bar">
            {session.questions.map((_, i) => (
              <div
                key={i}
                className={`quiz-progress-dot ${
                  i < session.currentIndex ? 'is-done' :
                  i === session.currentIndex ? 'is-current' : ''
                } ${
                  session.answers[i] !== null
                    ? session.answers[i] === session.questions[i].correctIndex ? 'is-correct' : 'is-wrong'
                    : ''
                }`}
              />
            ))}
          </div>

          {/* Subject badge + question number */}
          <div className="quiz-question-header">
            <span className="quiz-subject-badge">
              {subjectEmoji(currentQuestion.subject)} {currentQuestion.subject}
            </span>
            <span className="quiz-question-number">
              {session.currentIndex + 1} / {session.questions.length}
            </span>
          </div>

          {/* Question card */}
          <div className="quiz-question-card">
            <p className="quiz-question-text">
              {currentQuestion.question}
            </p>
          </div>

          {/* Options (always rendered to reserve exact layout space) */}
          <div 
            className={currentQuestion.options.length === 4 ? 'quiz-options-grid' : 'quiz-options-row'} 
          >
              {currentQuestion.options.map((option, idx) => {
                const optIdx = idx;
                const isHovered = hoveredOption === optIdx && phase === 'answering';
                const isSelected = selectedAnswer === optIdx;
                const isCorrectOption = currentQuestion.correctIndex === optIdx;
                const showCorrectMark = phase === 'result' && isCorrectOption;
                const showWrongMark = phase === 'result' && isSelected && !isCorrectOption;

                return (
                  <div
                    key={idx}
                    ref={(el) => { optionRefs.current[idx] = el; }}
                    {...{ [HAND_OPTION_INDEX_ATTR]: idx }}
                    className={`quiz-option-card ${
                      phase === 'answering' ? 'quiz-card-enter' : ''
                    } ${isHovered ? 'is-hovered' : ''} ${
                      showCorrectMark ? 'is-correct' : ''
                    } ${showWrongMark ? 'is-wrong' : ''}`}
                    onClick={() => handleOptionClick(optIdx)}
                  >
                    {/* Hover ring progress */}
                    {isHovered && (
                      <svg className="quiz-hover-ring" viewBox="0 0 100 100">
                        <circle
                          cx="50" cy="50" r="45"
                          className="quiz-hover-ring-track"
                        />
                        <circle
                          cx="50" cy="50" r="45"
                          className="quiz-hover-ring-fill"
                          strokeDasharray="283"
                          strokeDashoffset={283 - hoverProgress * 283}
                        />
                      </svg>
                    )}

                    <div className="quiz-option-label">{String.fromCharCode(65 + idx)}</div>
                    <div className="quiz-option-text">{option}</div>
                  </div>
                );
              })}
            </div>

          {/* Explanation */}
          {phase === 'result' && showExplanation && currentQuestion.explanation && (
            <div className="quiz-explanation quiz-fade-in">
              <p>{currentQuestion.explanation}</p>
            </div>
          )}

          {/* Skip / next button */}
          {phase === 'result' && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); skipResult(); }}
              className="quiz-skip-advance-btn"
              title="跳过播报，进入下一题"
            >
              <SkipForward size={15} />
              <span>跳过 · 下一题</span>
            </button>
          )}

          {/* Next-question gesture progress (result page) */}
          {phase === 'result' && cameraActive && (
            <div className="quiz-next-gesture quiz-fade-in">
              <div className="quiz-next-gesture-bar">
                <div ref={nextGestureBarRef} className="quiz-next-gesture-fill" />
              </div>
              <span>✋ 张开手掌停住 0.8 秒 → 直接进入下一题</span>
            </div>
          )}

          {/* Gesture hint */}
          {phase === 'answering' && cameraActive && (
            <div className="quiz-gesture-hint quiz-fade-in">
              <span>☝ 用食指指向答案，稳定悬停 1.2 秒确认选择</span>
            </div>
          )}
          {phase === 'answering' && !cameraActive && (
            <div className="quiz-gesture-hint quiz-fade-in">
              <span>💡 请开启摄像头使用手势答题，或直接点击选项</span>
            </div>
          )}

          {/* 摄像头小窗不再放在这里：.quiz-game-container 上的 quiz-fade-in 动画
              （关键帧带 transform、fill-mode: both）会让 transform: translateY(0)
              永久保留，使祖先成为 position:fixed 的包含块 —— 小窗会被锚到"题目容器"
              右下角而非屏幕右下角，既压选项、容器超出屏幕时还会被顶到屏幕外。
              现改用 portal 挂到 document.body（见下方），彻底摆脱祖先 transform。 */}
        </div>
      )}

      {/* 答题区摄像头小窗：用 portal 挂到 document.body，绕开所有祖先 transform
          （.quiz-game-container 的 quiz-fade-in 会让 transform 永久生效，
          把 position:fixed 的包含块从视口变成该容器）。这样小窗才真正固定在
          屏幕右下角，既不压选项，也不会因容器超高被顶出屏幕。 */}
      {cameraActive &&
        (phase === 'answering' || phase === 'result') &&
        createPortal(
          <video ref={smallCamRef} autoPlay playsInline muted className="quiz-camera-pip" />,
          document.body,
        )}

      {/* ─── SUMMARY PHASE ─── */}
      {phase === 'summary' && quizResult && (
        <div className="quiz-center-container quiz-fade-in">
          <div className="quiz-summary-card">
            <div className="quiz-summary-trophy">
              <Trophy size={56} className="text-yellow-400" />
            </div>
            <h2 className="quiz-summary-title">答题结束</h2>
            <div className="quiz-summary-stars">
              {[0, 1, 2].map(i => (
                <Star
                  key={i}
                  size={32}
                  className={i < quizResult.stars ? 'text-yellow-400 fill-yellow-400' : 'text-slate-600'}
                />
              ))}
            </div>
            <div className="quiz-summary-stats">
              <div className="quiz-stat">
                <CheckCircle2 size={20} className="text-emerald-400" />
                <span>{quizResult.correctCount} / {quizResult.totalQuestions} 正确</span>
              </div>
              <div className="quiz-stat">
                <Zap size={20} className="text-cyan" />
                <span>正确率 {quizResult.accuracy}%</span>
              </div>
              <div className="quiz-stat">
                <Clock size={20} className="text-purple-400" />
                <span>用时 {quizResult.totalTime} 秒</span>
              </div>
            </div>

            {/* Wrong questions summary — 错题小结 */}
            {(() => {
              const wrongList = session.questions
                .map((q, i) => ({ q, i, userAns: session.answers[i] }))
                .filter(({ q, userAns }) => userAns !== q.correctIndex);
              if (wrongList.length === 0) return null;
              return (
                <div className="mt-4 border-t border-slate-700/50 pt-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-300">
                    <XCircle size={16} /> 错题小结（{wrongList.length} 题）
                  </div>
                  <div className="quiz-wrong-list">
                    {wrongList.map(({ q, i, userAns }) => {
                      const isExpanded = expandedWrongId === q.id;
                      const isExplaining = xiaozhiExplainingId === q.id;
                      return (
                        <div key={q.id} className="quiz-wrong-item">
                          <div
                            className="quiz-wrong-header"
                            onClick={() => setExpandedWrongId(isExpanded ? null : q.id)}
                          >
                            <span className="quiz-wrong-idx">{i + 1}</span>
                            <span className="quiz-wrong-q truncate">{q.question}</span>
                            <span className="ml-auto text-xs text-slate-400">{isExpanded ? '▲' : '▼'}</span>
                          </div>
                          {isExpanded && (
                            <div className="quiz-wrong-body">
                              <div className="mb-2 text-xs text-slate-300">
                                <div><span className="text-rose-400 font-semibold">你的答案：</span>
                                  {userAns !== null && userAns !== undefined
                                    ? `${String.fromCharCode(65 + userAns)}. ${q.options[userAns]}`
                                    : '未作答'}
                                </div>
                                <div><span className="text-emerald-400 font-semibold">正确答案：</span>
                                  {String.fromCharCode(65 + q.correctIndex)}. {q.options[q.correctIndex]}
                                </div>
                              </div>
                              <div className="mb-3 rounded-lg border border-slate-700/40 bg-slate-800/60 p-2 text-xs text-slate-200 leading-relaxed">
                                {q.explanation}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleXiaozhiExplain(q); }}
                                  className={`quiz-xiaozhi-explain-btn ${isExplaining ? 'is-loading' : ''}`}
                                  title={isExplaining ? '再点一次停止播报' : '让小智讲解'}
                                >
                                  {isExplaining ? (
                                    <><Loader2 size={14} className="animate-spin" /><span>小智讲解中…</span></>
                                  ) : (
                                    <><Sparkles size={14} /><span>让小智讲解</span></>
                                  )}
                                </button>
                                {isExplaining && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); stopXiaozhiSpeech(); setXiaozhiExplainingId(null); }}
                                    className="quiz-xiaozhi-skip-btn"
                                    title="跳过播报"
                                  >
                                    <SkipForward size={14} /><span>跳过</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Answer detail list */}
            <div className="quiz-summary-detail">
              {session.questions.map((q, i) => {
                const userAns = session.answers[i];
                const correct = userAns === q.correctIndex;
                return (
                  <div key={q.id} className={`quiz-detail-row ${correct ? 'is-correct' : 'is-wrong'}`}>
                    <span className="quiz-detail-idx">{i + 1}</span>
                    <span className="quiz-detail-q">{q.question.length > 20 ? q.question.slice(0, 20) + '…' : q.question}</span>
                    <span className="quiz-detail-icon">
                      {correct
                        ? <CheckCircle2 size={16} className="text-emerald-400" />
                        : <XCircle size={16} className="text-red-400" />
                      }
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="quiz-summary-actions">
              <button 
                ref={restartBtnRef}
                className="quiz-btn-restart relative overflow-hidden" 
                onClick={handleRestart}
              >
                <div 
                  ref={restartProgressRef}
                  className="absolute left-0 top-0 bottom-0 bg-white/20"
                  style={{ width: '0%' }}
                />
                <span className="relative z-10">再来一轮</span>
              </button>
              <button 
                ref={exitBtnRef}
                className="quiz-btn-exit relative overflow-hidden" 
                onClick={handleExit}
              >
                <div 
                  ref={exitProgressRef}
                  className="absolute left-0 top-0 bottom-0 bg-white/20"
                  style={{ width: '0%' }}
                />
                <span className="relative z-10">退出答题</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuizOverlay;
