import React, { useEffect, useRef, useState } from 'react';
import { HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import { ControlRefs, GestureType, HandLandmarkPoint, HandLandmarks, InteractionMode, MoveDirection } from '../types';
import {
  describeHandCandidate,
  HandTargetTracker,
  HandTrackingPhase,
  TrackedHandSide,
} from '../services/handTargetTracker';
import {
  advanceRotationContinuity,
  applyRateDeadzone,
  createRotationContinuityState,
  clampRate,
  decayRate,
  exponentialSmoothingAlpha,
  hysteresisBelow,
  normalizeRatePerSecond,
  RotationContinuityState,
  smoothRateTowardsTarget,
} from '../services/handGestureMath';
import {
  notePublishedHandInput,
  performanceTelemetry,
} from '../services/performanceTelemetry';
import { calibrateHandPoint } from '../services/handPointerMapping';

export interface HandTrackingPerformanceSample {
  sequence: number;
  capturedAt: number;
  processedAt: number;
  inferenceMs: number;
  resultAgeMs: number;
  skippedFrames: number;
}

interface HandControllerProps {
  controlRef: React.MutableRefObject<ControlRefs>;
  onStateChange: (gesture: GestureType, direction: MoveDirection, isDragging: boolean) => void;
  onPerformanceSample?: (sample: HandTrackingPerformanceSample) => void;
  interactionMode: InteractionMode;
  quizMode?: boolean;  // 新增：是否处于答题模式
}

// Simple Low-Pass Filter for smoothing coordinates
const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor;
// Keep these exports for callers that previously imported the pure helpers
// from HandController while the implementation lives in a testable service.
export { exponentialSmoothingAlpha, normalizeRatePerSecond } from '../services/handGestureMath';
const toPointList = (landmarks: any[] | null | undefined): HandLandmarkPoint[] =>
  (landmarks ?? []).map((landmark: any) => ({
    x: landmark.x,
    y: landmark.y,
    z: landmark.z || 0,
  }));

const toUserFacingHandedness = (categoryName: string) => (
  categoryName === 'Left' ? 'Right' : 'Left'
);

const LOCAL_VISION_WASM_PATH = '/mediapipe/wasm';
const LOCAL_HAND_MODEL_PATH = '/mediapipe/hand_landmarker.task';

interface SerializedHandCategory {
  categoryName?: string;
  score?: number;
  index?: number;
  displayName?: string;
}

interface HandDetectionResult {
  type: 'result';
  sequence: number;
  capturedAt: number;
  processedAt: number;
  inferenceMs: number;
  landmarks: Array<Array<{ x: number; y: number; z?: number }>>;
  handedness: Array<SerializedHandCategory[]>;
}

interface HandWorkerReady {
  type: 'ready';
  numHands: number;
  delegate: 'GPU' | 'CPU';
}

interface HandWorkerError {
  type: 'error';
  sequence?: number;
  capturedAt?: number;
  message: string;
}

type HandWorkerMessage = HandDetectionResult | HandWorkerReady | HandWorkerError;

const HandController: React.FC<HandControllerProps> = ({
  controlRef,
  onStateChange,
  onPerformanceSample,
  interactionMode,
  quizMode = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const handWorkerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerInitFailedRef = useRef(false);
  const workerInFlightRef = useRef(false);
  const workerSequenceRef = useRef(0);
  const skippedFramesRef = useRef(0);
  const schedulerStartedRef = useRef(false);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const requestRef = useRef<number>(0);
  const lastVideoTimeRef = useRef(-1);
  const lastFrameTimestampRef = useRef(0);
  const lastResultTimestampRef = useRef(0);
  const lastResultReceivedAtRef = useRef(0);
  const resultWatchdogTimerRef = useRef<number | null>(null);
  const lastControlSampleAtRef = useRef(0);
  const drawingUtilsRef = useRef<DrawingUtils | null>(null);
  const targetTrackerRef = useRef(new HandTargetTracker());
  const trackingPhaseRef = useRef<HandTrackingPhase>('searching');
  const [trackingStatus, setTrackingStatus] = useState({
    phase: 'searching' as HandTrackingPhase,
    text: '请将双手置于画面中',
  });

  // Keep latest callback to avoid stale closures in RAF loop
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  const onPerformanceSampleRef = useRef(onPerformanceSample);
  useEffect(() => {
    onPerformanceSampleRef.current = onPerformanceSample;
  }, [onPerformanceSample]);
  const interactionModeRef = useRef(interactionMode);
  const quizModeRef = useRef(quizMode);
  useEffect(() => {
    interactionModeRef.current = interactionMode;
    const trackerMode = quizModeRef.current || interactionMode === 'single' ? 'single' : 'dual';
    disarmResultWatchdog();
    // Do not let a result captured before the mode switch mutate the newly
    // reset tracker when it returns from the worker.
    lastResultTimestampRef.current = performance.now();
    targetTrackerRef.current.reset(trackerMode);
    trackingPhaseRef.current = 'searching';
    setTrackingStatus({
      phase: 'searching',
      text: trackerMode === 'dual' ? '请将双手置于画面中' : '请将手置于画面中',
    });
    prevRotatePosRef.current = null;
    prevRotateSampleAtRef.current = 0;
    rotationContinuityRef.current = createRotationContinuityState();
    lastValidRotVelRef.current = { x: 0, y: 0 };
    pinchGestureActiveRef.current = false;
    otherPinchActiveRef.current = false;
    smoothRotVelRef.current = { x: 0, y: 0 };
    smoothZoomRef.current = 0;
    pinchZoomMotionRef.current = null;
    wasContactingRef.current = false;
    openStopStartRef.current = 0;
    openStopActiveRef.current = false;
    controlRef.current.rotationVelocity = { x: 0, y: 0 };
    controlRef.current.rotationGestureActive = false;
    controlRef.current.zoomSpeed = 0;
    controlRef.current.isDragging = false;
    controlRef.current.panPosition = { x: 0, y: 0 };
    controlRef.current.handNDCPosition = null;
    controlRef.current.handLandmarks.left = null;
    controlRef.current.handLandmarks.right = null;
    controlRef.current.interactionHandLandmarks = null;
    controlRef.current.handPointer = null;
    controlRef.current.handRawFingertip = null;
    const worker = handWorkerRef.current;
    if (worker) {
      stopFrameScheduler();
      workerReadyRef.current = false;
      worker.postMessage({
        type: 'init',
        wasmPath: LOCAL_VISION_WASM_PATH,
        modelAssetPath: LOCAL_HAND_MODEL_PATH,
        numHands: trackerMode === 'single' ? 1 : 2,
      });
    }
  }, [controlRef, interactionMode]);

  // Keep latest quizMode to avoid stale closures in RAF loop
  useEffect(() => {
    quizModeRef.current = quizMode;
    const trackerMode = quizMode || interactionModeRef.current === 'single' ? 'single' : 'dual';
    disarmResultWatchdog();
    // Drop any in-flight result belonging to the previous gesture mode.
    lastResultTimestampRef.current = performance.now();
    targetTrackerRef.current.reset(trackerMode);
    trackingPhaseRef.current = 'searching';
    setTrackingStatus({
      phase: 'searching',
      text: trackerMode === 'dual' ? '请将双手置于画面中' : '请将手置于画面中',
    });
    prevRotatePosRef.current = null;
    prevRotateSampleAtRef.current = 0;
    rotationContinuityRef.current = createRotationContinuityState();
    lastValidRotVelRef.current = { x: 0, y: 0 };
    pinchGestureActiveRef.current = false;
    otherPinchActiveRef.current = false;
    smoothRotVelRef.current = { x: 0, y: 0 };
    smoothZoomRef.current = 0;
    pinchZoomMotionRef.current = null;
    wasContactingRef.current = false;
    openStopStartRef.current = 0;
    openStopActiveRef.current = false;
    controlRef.current.rotationVelocity = { x: 0, y: 0 };
    controlRef.current.rotationGestureActive = false;
    controlRef.current.zoomSpeed = 0;
    controlRef.current.isDragging = false;
    controlRef.current.panPosition = { x: 0, y: 0 };
    controlRef.current.handNDCPosition = null;
    controlRef.current.handLandmarks.left = null;
    controlRef.current.handLandmarks.right = null;
    controlRef.current.interactionHandLandmarks = null;
    controlRef.current.handPointer = null;
    controlRef.current.handRawFingertip = null;
    const worker = handWorkerRef.current;
    if (worker) {
      stopFrameScheduler();
      workerReadyRef.current = false;
      worker.postMessage({
        type: 'init',
        wasmPath: LOCAL_VISION_WASM_PATH,
        modelAssetPath: LOCAL_HAND_MODEL_PATH,
        numHands: trackerMode === 'single' ? 1 : 2,
      });
    }
  }, [quizMode]);

  // Smoothing refs
  const smoothDragPinchRef = useRef({ x: 0.5, y: 0.5 });
  const smoothRotateFingerCenterRef = useRef({ x: 0.5, y: 0.5 });

  // Previous contact state for hysteresis
  const wasContactingRef = useRef(false);
  const openStopStartRef = useRef(0);
  const openStopActiveRef = useRef(false);

  // Store previous position for Delta calculation (Rotation)
  const prevRotatePosRef = useRef<{ x: number, y: number } | null>(null);
  const prevRotateSampleAtRef = useRef(0);
  const rotationContinuityRef = useRef<RotationContinuityState>(createRotationContinuityState());
  const lastValidRotVelRef = useRef({ x: 0, y: 0 });
  const pinchGestureActiveRef = useRef(false);
  // Independent pinch state for the other hand so both hands can pinch
  // simultaneously in dual-hand mode (either hand can trigger drag/disassemble).
  const otherPinchActiveRef = useRef(false);
  const otherSmoothDragPinchRef = useRef({ x: 0.5, y: 0.5 });
  const pinchZoomMotionRef = useRef<{
    ratio: number;
    atMs: number;
    filteredRate: number;
    active: boolean;
  } | null>(null);

  // The worker produces sparse samples. These refs hold one time-aware filter
  // state; the renderer consumes the resulting per-second rates every frame.
  const smoothRotVelRef = useRef({ x: 0, y: 0 });
  const smoothZoomRef = useRef(0);
  const lastPublishedStateRef = useRef<{
    gesture: GestureType | null;
    direction: MoveDirection | null;
    isDragging: boolean | null;
  }>({ gesture: null, direction: null, isDragging: null });

  // Constants
  const PINCH_ENTER_RATIO = 0.42;
  const PINCH_EXIT_RATIO = 0.62;
  const ZOOM_PINCH_RATE_START = 0.14;
  const ZOOM_PINCH_RATE_STOP = 0.07;
  const ZOOM_PINCH_RATE_FILTER_MS = 65;
  const ZOOM_PINCH_RATE_GAIN = 18;
  const FINGER_CONTACT_ENTER_RATIO = 0.38;
  const FINGER_CONTACT_EXIT_RATIO = 0.54;
  const CONTACT_THRESHOLD = 0.12;
  const OPEN_STOP_HOLD_MS = 700;
  const TRACKING_CONTINUITY_MS = 300;
  // A result can legitimately be delayed by a busy CPU/GPU, but once this
  // window expires an old gesture must not keep driving the scene forever.
  // This watchdog is independent from the tracker because it also covers a
  // worker that stops responding altogether (where no empty result arrives).
  const RESULT_STALE_TIMEOUT_MS = 400;

  // ControlRefs now carries rates in units per second. The 0.35 legacy
  // per-render value is converted to an equivalent rate for existing feel;
  // ModelViewer/other consumers must multiply these values by `delta` once.
  const ZOOM_SPEED_PER_SECOND = 0.35 * 60;

  // Adjusted for better range of motion
  const DRAG_SCALE_X = 7.0;
  const DRAG_SCALE_Y = 5.5;
  const ROTATION_SENSITIVITY = 6.4;

  const POSITION_FILTER_TIME_CONSTANT_MS = 20;
  const ZOOM_FILTER_TIME_CONSTANT_MS = 35;
  const ROTATION_RATE_DEADZONE = 0.0007 * 1000 / 33;
  const ROTATION_MAX_RATE = 9;
  const ROTATION_MAX_ACCELERATION = 65;
  const ROTATION_OUTPUT_FILTER_TIME_CONSTANT_MS = 16;
  const ROTATION_RELEASE_GRACE_MS = 80;
  const ROTATION_RELEASE_AFTER_MISSES = 2;
  const ROTATION_GRACE_DECAY_TIME_CONSTANT_MS = 45;

  /**
   * Publish the filtered pinch center in the coordinate space consumed by
   * ModelViewer's raycaster.  `panPosition` is kept for legacy consumers,
   * while `handNDCPosition` is the canonical drag pointer; both values come
   * from the same time-aware filter state so the model never has to rebuild
   * an unfiltered pointer from the raw landmarks.
   */
  const publishFilteredDragPosition = (x: number, y: number) => {
    const targetNdcX = (0.5 - x) * 2;
    const targetNdcY = -(y - 0.5) * 2;
    const currentNdc = controlRef.current.handNDCPosition;
    if (currentNdc) {
      currentNdc.x = targetNdcX;
      currentNdc.y = targetNdcY;
    } else {
      controlRef.current.handNDCPosition = { x: targetNdcX, y: targetNdcY };
    }

    // Preserve the historical model-space target for any external consumer
    // that still reads panPosition.  Mutate the existing object when possible
    // to avoid allocating on every camera sample.
    const pan = controlRef.current.panPosition;
    if (pan) {
      pan.x = (0.5 - x) * DRAG_SCALE_X;
      pan.y = (0.5 - y) * DRAG_SCALE_Y;
    } else {
      controlRef.current.panPosition = {
        x: (0.5 - x) * DRAG_SCALE_X,
        y: (0.5 - y) * DRAG_SCALE_Y,
      };
    }
  };

  const clearStalePublishedControls = () => {
    const controls = controlRef.current;
    // Voice rotation owns this field while active. A stalled camera worker
    // must not interrupt an unrelated voice command.
    if (!controls.voiceRotationActive) {
      controls.rotationVelocity.x = 0;
      controls.rotationVelocity.y = 0;
    }
    controls.rotationGestureActive = false;
    controls.zoomSpeed = 0;
    controls.isDragging = false;
    controls.interactionHandLandmarks = null;
    controls.handPointer = null;
    controls.handRawFingertip = null;
    controls.handLandmarks.left = null;
    controls.handLandmarks.right = null;
    controls.handNDCPosition = null;
    controls.panPosition.x = 0;
    controls.panPosition.y = 0;

    smoothRotVelRef.current = { x: 0, y: 0 };
    smoothZoomRef.current = 0;
    prevRotatePosRef.current = null;
    prevRotateSampleAtRef.current = 0;
    rotationContinuityRef.current = createRotationContinuityState();
    lastValidRotVelRef.current = { x: 0, y: 0 };
    pinchGestureActiveRef.current = false;
    otherPinchActiveRef.current = false;
    wasContactingRef.current = false;
    openStopStartRef.current = 0;
    openStopActiveRef.current = false;
    lastControlSampleAtRef.current = 0;

    const lastPublishedState = lastPublishedStateRef.current;
    if (
      lastPublishedState.gesture !== GestureType.NONE
      || lastPublishedState.direction !== MoveDirection.CENTER
      || lastPublishedState.isDragging !== false
    ) {
      lastPublishedStateRef.current = {
        gesture: GestureType.NONE,
        direction: MoveDirection.CENTER,
        isDragging: false,
      };
      onStateChangeRef.current?.(GestureType.NONE, MoveDirection.CENTER, false);
    }
  };

  const armResultWatchdog = (receivedAt: number) => {
    if (resultWatchdogTimerRef.current !== null) {
      window.clearTimeout(resultWatchdogTimerRef.current);
    }
    lastResultReceivedAtRef.current = receivedAt;
    resultWatchdogTimerRef.current = window.setTimeout(() => {
      resultWatchdogTimerRef.current = null;
      const now = performance.now();
      const age = now - lastResultReceivedAtRef.current;
      if (age >= RESULT_STALE_TIMEOUT_MS) {
        // Advance the accepted timestamp so a delayed in-flight frame from
        // before the timeout is discarded instead of resurrecting stale input.
        lastResultTimestampRef.current = Math.max(lastResultTimestampRef.current, now);
        clearStalePublishedControls();
        return;
      }
      armResultWatchdog(lastResultReceivedAtRef.current);
    }, RESULT_STALE_TIMEOUT_MS);
  };

  const disarmResultWatchdog = () => {
    if (resultWatchdogTimerRef.current !== null) {
      window.clearTimeout(resultWatchdogTimerRef.current);
      resultWatchdogTimerRef.current = null;
    }
    lastResultReceivedAtRef.current = 0;
  };

  /**
   * Submit at most one camera frame to the vision worker at a time.  MediaPipe
   * inference is the expensive part of this pipeline; keeping it single
   * in-flight prevents a backlog from turning into visible control latency.
   * The video callback continues to run at camera cadence, but frames arriving
   * while inference is busy are intentionally discarded (the next frame is
   * always newer and therefore more useful for direct manipulation).
   */
  const dispatchVideoFrame = (capturedAt: number) => {
    const video = videoRef.current;
    const worker = handWorkerRef.current;
    if (!video || !worker || !workerReadyRef.current || workerInitFailedRef.current) return;
    if (workerInFlightRef.current) {
      skippedFramesRef.current += 1;
      return;
    }
    // requestVideoFrameCallback may still fire at display cadence when a
    // camera track is duplicated (for example 60Hz display + 30Hz camera).
    // Keep inference bounded independently of the source callback rate.
    if (
      lastFrameTimestampRef.current > 0
      && capturedAt - lastFrameTimestampRef.current < (1000 / 30)
    ) {
      skippedFramesRef.current += 1;
      return;
    }

    // Mark the slot busy before awaiting createImageBitmap.  Otherwise two
    // adjacent video callbacks can both start an asynchronous bitmap copy and
    // defeat the single-in-flight guarantee.
    workerInFlightRef.current = true;
    // Start the response watchdog at dispatch time as well as on publish. If
    // the very first inference hangs, there may be no result callback from
    // which to arm a timeout.
    armResultWatchdog(performance.now());
    const sequence = workerSequenceRef.current + 1;
    workerSequenceRef.current = sequence;
    const timestamp = Math.max(capturedAt, lastFrameTimestampRef.current + 0.001);
    lastFrameTimestampRef.current = timestamp;
    performanceTelemetry.recordCapture(sequence, timestamp, {
      source: 'camera',
      width: video.videoWidth || 320,
      height: video.videoHeight || 240,
    });

    void (async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(video);
        // The scheduler may have been stopped while the bitmap was being
        // copied (for example during component unmount or camera restart).
        if (!schedulerStartedRef.current || handWorkerRef.current !== worker || !workerReadyRef.current) {
          bitmap.close();
          workerInFlightRef.current = false;
          return;
        }
        worker.postMessage(
          {
            type: 'frame',
            sequence,
            capturedAt: timestamp,
            bitmap,
          },
          [bitmap],
        );
        // Ownership has moved to the worker.  Do not close the transferred
        // bitmap here; handLandmarker.worker closes it after inference.
        bitmap = null;
      } catch (frameError) {
        bitmap?.close();
        workerInFlightRef.current = false;
        // A transient copy failure should not tear down the entire camera
        // session.  It is safe to continue with the next video frame.
        if (!workerInitFailedRef.current) {
          console.warn('Unable to copy webcam frame for hand tracking:', frameError);
        }
      }
    })();
  };

  /** Schedule camera-frame sampling using the browser's video-aware callback. */
  function startFrameScheduler() {
    if (schedulerStartedRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    schedulerStartedRef.current = true;
    lastVideoTimeRef.current = -1;

    const videoWithFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    if (typeof videoWithFrameCallback.requestVideoFrameCallback === 'function') {
      const scheduleNext = () => {
        if (!schedulerStartedRef.current) return;
        videoFrameCallbackRef.current = videoWithFrameCallback.requestVideoFrameCallback((now, metadata) => {
          videoFrameCallbackRef.current = null;
          if (!schedulerStartedRef.current) return;

          // requestVideoFrameCallback is already video-cadenced.  The media
          // time guard is useful on browsers that occasionally repeat a frame
          // while a camera track is being renegotiated.
          const mediaTime = metadata?.mediaTime;
          // Some MediaStream implementations expose a constant mediaTime
          // (usually 0) for camera frames.  Only use the duplicate guard when
          // the timeline is actually advancing; otherwise it would process
          // the first frame and silently stop tracking forever.
          if (typeof mediaTime === 'number' && mediaTime > 0 && mediaTime === lastVideoTimeRef.current) {
            scheduleNext();
            return;
          }
          if (typeof mediaTime === 'number' && mediaTime > 0) lastVideoTimeRef.current = mediaTime;
          dispatchVideoFrame(now);
          scheduleNext();
        });
      };
      scheduleNext();
      return;
    }

    // Firefox/Safari versions without requestVideoFrameCallback still get a
    // bounded fallback.  RAF drives sampling, while currentTime filtering
    // avoids submitting the same camera frame more than once.
    const tick = (now: number) => {
      requestRef.current = 0;
      if (!schedulerStartedRef.current) return;
      const currentTime = video.currentTime;
      // MediaStream-backed videos often report currentTime === 0 for their
      // entire lifetime.  Use a monotonic cadence guard in that case so the
      // RAF fallback still samples at the requested ~30fps instead of
      // repeatedly copying the same frame at display refresh rate.
      const cadenceReady = now - lastFrameTimestampRef.current >= (1000 / 30);
      if (video.readyState >= video.HAVE_CURRENT_DATA
        && cadenceReady
        && (currentTime <= 0 || currentTime !== lastVideoTimeRef.current)) {
        if (currentTime > 0) lastVideoTimeRef.current = currentTime;
        dispatchVideoFrame(now);
      }
      requestRef.current = requestAnimationFrame(tick);
    };
    requestRef.current = requestAnimationFrame(tick);
  }

  function stopFrameScheduler() {
    schedulerStartedRef.current = false;
    const video = videoRef.current as (HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    }) | null;
    if (video && videoFrameCallbackRef.current !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
    }
    videoFrameCallbackRef.current = null;
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    requestRef.current = 0;
    lastVideoTimeRef.current = -1;
  }

  function handleVideoLoaded() {
    // loadeddata can fire more than once as a MediaStream track changes.  The
    // scheduler guard makes this idempotent and avoids duplicate callbacks.
    if (workerReadyRef.current) startFrameScheduler();
  }

  useEffect(() => {
    let mounted = true;
    let mediaStream: MediaStream | null = null;

    const stopMediaStream = () => {
      mediaStream?.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
      controlRef.current.webcamStream = null;
    };

    const stopHandWorker = () => {
      handWorkerRef.current?.terminate();
      handWorkerRef.current = null;
      workerReadyRef.current = false;
      workerInFlightRef.current = false;
    };

    const startWorker = () => {
      try {
        const worker = new Worker(
          new URL('../services/handLandmarker.worker.ts', import.meta.url),
          { type: 'module' },
        );
        handWorkerRef.current = worker;
        workerReadyRef.current = false;
        workerInitFailedRef.current = false;
        worker.onmessage = (event: MessageEvent<HandWorkerMessage>) => {
          if (!mounted) return;
          const message = event.data;
          if (message.type === 'ready') {
            workerReadyRef.current = true;
            if (videoRef.current?.readyState && videoRef.current.readyState >= videoRef.current.HAVE_CURRENT_DATA) {
              startFrameScheduler();
            }
            return;
          }
          if (message.type === 'result') {
            workerInFlightRef.current = false;
            if (message.capturedAt <= lastResultTimestampRef.current) return;
            const receivedAt = performance.now();
            performanceTelemetry.recordInference(
              receivedAt - Math.max(0, message.inferenceMs),
              receivedAt,
              message.sequence,
              { resultAgeMs: Math.max(0, receivedAt - message.capturedAt) },
            );
            // Keep the previous sample timestamp available while processing
            // this result.  The drag filter uses that interval to remain
            // time-aware; advancing it before processDetectionResult would
            // collapse every sample to a ~1ms interval and add lag.
            processDetectionResult(message, message.capturedAt);
            lastResultTimestampRef.current = message.capturedAt;
            armResultWatchdog(receivedAt);
            performanceTelemetry.recordPublish(
              message.sequence,
              receivedAt,
              message.sequence,
              { resultAgeMs: Math.max(0, receivedAt - message.capturedAt) },
            );
            notePublishedHandInput(controlRef.current, {
              sequence: message.sequence,
              capturedAt: message.capturedAt,
              processedAt: message.processedAt,
              inferenceMs: message.inferenceMs,
            }, receivedAt);
            onPerformanceSampleRef.current?.({
              sequence: message.sequence,
              capturedAt: message.capturedAt,
              processedAt: message.processedAt,
              inferenceMs: message.inferenceMs,
              resultAgeMs: Math.max(0, receivedAt - message.capturedAt),
              skippedFrames: skippedFramesRef.current,
            });
            skippedFramesRef.current = 0;
            return;
          }
          workerInFlightRef.current = false;
          // Detection failures are isolated to one frame. Keep the worker and
          // camera alive so a transient bitmap/timestamp issue cannot disable
          // the whole gesture session; the watchdog will clear any stale
          // published controls if recovery takes too long.
          if (message.sequence !== undefined) {
            if (!/尚未准备完成|not ready|not initialized/i.test(message.message)) {
              console.warn('MediaPipe frame was dropped:', message.message);
            }
            return;
          }
          // A frame can arrive while the worker is asynchronously rebuilding
          // its landmarker after a mode change.  That is a recoverable drop,
          // not an initialization failure; the next `ready` message will
          // resume the scheduler.
          if (!workerInitFailedRef.current) {
            workerInitFailedRef.current = true;
            stopFrameScheduler();
            stopMediaStream();
            stopHandWorker();
            console.error('MediaPipe worker error:', message.message);
            setError('手势识别初始化失败，请刷新页面后重试');
            setLoading(false);
          }
        };
        worker.onerror = (event) => {
          if (!mounted) return;
          workerInFlightRef.current = false;
          workerInitFailedRef.current = true;
          stopFrameScheduler();
          stopMediaStream();
          stopHandWorker();
          console.error('MediaPipe worker crashed:', event.message);
          setError('手势识别线程异常，请刷新页面后重试');
          setLoading(false);
        };
        const numHands = quizModeRef.current || interactionModeRef.current === 'single' ? 1 : 2;
        worker.postMessage({
          type: 'init',
          wasmPath: LOCAL_VISION_WASM_PATH,
          modelAssetPath: LOCAL_HAND_MODEL_PATH,
          numHands,
        });
      } catch (workerError) {
        console.error('Unable to start MediaPipe worker:', workerError);
        workerInitFailedRef.current = true;
        stopFrameScheduler();
        stopMediaStream();
        stopHandWorker();
        setError('当前浏览器不支持手势识别线程');
        setLoading(false);
      }
    };

    // Keep camera capture bounded: inference is intentionally decoupled from
    // the display refresh rate and never requests more than 30 source frames/s.
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 320, max: 320 },
            height: { ideal: 240, max: 240 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user',
          },
        });
        if (!mounted || workerInitFailedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStream = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.addEventListener('loadeddata', handleVideoLoaded);
        }
        controlRef.current.webcamStream = stream;
        setLoading(false);
      } catch (err) {
        console.error('Webcam error:', err);
        if (!mounted) return;
        workerInitFailedRef.current = true;
        stopFrameScheduler();
        stopMediaStream();
        stopHandWorker();
        setError('无法访问摄像头，请检查摄像头权限（需 HTTPS/localhost）');
        setLoading(false);
      }
    };

    startWorker();
    startCamera();

    return () => {
      mounted = false;
      disarmResultWatchdog();
      stopFrameScheduler();
      const video = videoRef.current;
      video?.removeEventListener('loadeddata', handleVideoLoaded);
      stopMediaStream();
      stopHandWorker();
      workerInitFailedRef.current = false;
      workerSequenceRef.current = 0;
      skippedFramesRef.current = 0;
      lastVideoTimeRef.current = -1;
      lastFrameTimestampRef.current = 0;
      lastResultTimestampRef.current = 0;
      lastResultReceivedAtRef.current = 0;
      lastControlSampleAtRef.current = 0;
      targetTrackerRef.current.reset();
      trackingPhaseRef.current = 'searching';
      prevRotatePosRef.current = null;
      prevRotateSampleAtRef.current = 0;
      rotationContinuityRef.current = createRotationContinuityState();
      lastValidRotVelRef.current = { x: 0, y: 0 };
      smoothRotVelRef.current = { x: 0, y: 0 };

      if (controlRef.current) {
        controlRef.current.handLandmarks = { left: null, right: null };
        controlRef.current.interactionHandLandmarks = null;
    controlRef.current.handPointer = null;
    controlRef.current.handRawFingertip = null;
        controlRef.current.rotationVelocity = { x: 0, y: 0 };
        controlRef.current.rotationGestureActive = false;
        controlRef.current.zoomSpeed = 0;
        controlRef.current.isDragging = false;
        controlRef.current.panPosition = { x: 0, y: 0 };
        controlRef.current.handNDCPosition = null;
      }
      if (onStateChangeRef.current) {
        onStateChangeRef.current(GestureType.NONE, MoveDirection.CENTER, false);
      }
    };
  }, []);

  const isFingerExtended = (landmarks: any[], tipIdx: number, pipIdx: number) => {
    return Boolean(landmarks[tipIdx] && landmarks[pipIdx])
      && landmarks[tipIdx].y < landmarks[pipIdx].y;
  };

  const getDistance = (p1: any, p2: any) => {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
  };

  const getPalmWidth = (landmarks: any[]) => Math.max(
    0.02,
    getDistance(landmarks[5], landmarks[17]),
  );

  // Judge the rotation pose by finger reach from the wrist, so tilting the
  // hand while sliding does not make the two-finger gesture drop out.
  const isRotationFingerExtended = (landmarks: any[], tipIdx: number, pipIdx: number) => {
    const wrist = landmarks[0];
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    return Boolean(wrist && tip && pip)
      && getDistance(wrist, tip) > getDistance(wrist, pip) * 1.08;
  };

  const getPinchDistance = (landmarks: any[]) => {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    return getDistance(thumbTip, indexTip);
  };

  const isTwoFingerRotationGesture = (landmarks: any[] | null) => {
    if (!landmarks || landmarks.length < 21) return false;
    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const fingersDist = getDistance(indexTip, middleTip) / getPalmWidth(landmarks);
    const threshold = rotationContinuityRef.current.active
      ? FINGER_CONTACT_EXIT_RATIO
      : FINGER_CONTACT_ENTER_RATIO;
    const isIndexUp = isRotationFingerExtended(landmarks, 8, 6);
    const isMiddleUp = isRotationFingerExtended(landmarks, 12, 10);
    return isIndexUp && isMiddleUp && fingersDist < threshold;
  };

  /**
   * 用**相对（空中鼠标）**方式把食指尖算出视口归一化指针。
   * 只把指尖位移按比例加到光标上，不猜"画面坐标对应屏幕哪一点"，
   * 因此没有绝对映射那种系统性偏移——详见 services/handPointerMapping。
   */
  const computeHandPointer = (landmarks: HandLandmarks): { x: number; y: number } | null => {
    if (!landmarks || landmarks.length < 9) return null;
    const tip = landmarks[8];
    if (!tip) return null;
    // 绝对映射：指尖原始（未镜像）归一化坐标 → 视口归一化坐标。
    // 配合 services/handPointerMapping 的自动标定，做到"手指指到哪个框就选哪个框"。
    return calibrateHandPoint(tip.x, tip.y);
  };

  /** 调试/自动标定用：原始（未镜像）指尖归一化坐标。 */
  const readRawFingertip = (landmarks: HandLandmarks): { x: number; y: number } | null => {
    if (!landmarks || landmarks.length < 9) return null;
    const tip = landmarks[8];
    return tip ? { x: tip.x, y: tip.y } : null;
  };

  const processDetectionResult = (result: HandDetectionResult, startTimeMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-canvas.width, 0);
    }

      // Default States
      let rotVelX = 0;
      let rotVelY = 0;
      let newZoomSpeed = 0;
      let newDirection = MoveDirection.CENTER;
      let newGesture = GestureType.NONE;
      let isDragging = false;
      let rotationGraceActive = false;

      // 手部landmarks声明在外部，以便传递到3D场景
      let leftHandLandmarks: any[] | null = null;
      let rightHandLandmarks: any[] | null = null;
      const candidates = (result.landmarks ?? []).flatMap((landmarks, index) => {
        const category = result.handedness?.[index]?.[0];
        if (!category?.categoryName) return [];
        const side = toUserFacingHandedness(category.categoryName) as TrackedHandSide;
        const candidate = describeHandCandidate(landmarks, side, category.score ?? 1);
        return candidate ? [candidate] : [];
      });
      const trackerMode = quizModeRef.current || interactionModeRef.current === 'single' ? 'single' : 'dual';
      const trackedHands = targetTrackerRef.current.update(candidates, startTimeMs, trackerMode);
      const leftHandCandidate = trackedHands.active.left;
      const rightHandCandidate = trackedHands.active.right;
      const leftHandStale = Boolean(leftHandCandidate?.stale);
      const rightHandStale = Boolean(rightHandCandidate?.stale);
      const activeHandAgeMs = Math.max(
        leftHandCandidate?.ageMs ?? 0,
        rightHandCandidate?.ageMs ?? 0,
      );
      // Exponential decay instead of linear ramp — smoother continuity across
      // dropped MediaPipe frames without a sudden cut-off.
      const staleAttenuation = activeHandAgeMs > 0
        ? decayRate(1, activeHandAgeMs, TRACKING_CONTINUITY_MS / 3)
        : 1;

      if (trackingPhaseRef.current !== trackedHands.phase) {
        trackingPhaseRef.current = trackedHands.phase;
        setTrackingStatus({ phase: trackedHands.phase, text: trackedHands.statusText });
      }

      if (ctx) {
        const drawingUtils = drawingUtilsRef.current ?? new DrawingUtils(ctx);
        drawingUtilsRef.current = drawingUtils;
        [trackedHands.display.left, trackedHands.display.right].forEach((hand) => {
          if (!hand) return;
          const isLocked = trackedHands.phase === 'locked';
          const isWaiting = trackedHands.phase === 'partial_lost' || trackedHands.phase === 'lost';
          drawingUtils.drawConnectors(hand.landmarks as any, HandLandmarker.HAND_CONNECTIONS, {
            color: isWaiting ? '#fbbf24' : isLocked ? '#22d3ee' : '#a78bfa',
            lineWidth: 3,
          });
          drawingUtils.drawLandmarks(hand.landmarks as any, {
            color: '#ffffff', lineWidth: 1, radius: 2,
          });
        });
      }

      leftHandLandmarks = leftHandCandidate?.landmarks ?? null;
      rightHandLandmarks = rightHandCandidate?.landmarks ?? null;

      if (trackedHands.controlEnabled) {
        // Keep semantic aliases available for single-hand fallback logic.
        const realLeftHandLandmarks = rightHandLandmarks;
        const realRightHandLandmarks = leftHandLandmarks;
        // Dual-hand behavior is mirrored in the current camera view.
        const dualZoomHandLandmarks = rightHandLandmarks;
        const dualManipulationHandLandmarks = leftHandLandmarks;
        const activeSingleHandLandmarks = realLeftHandLandmarks || realRightHandLandmarks;

        const applySingleHandRotation = (landmarks: any[] | null) => {
          const continuity = advanceRotationContinuity(
            rotationContinuityRef.current,
            isTwoFingerRotationGesture(landmarks),
            startTimeMs,
            ROTATION_RELEASE_GRACE_MS,
            ROTATION_RELEASE_AFTER_MISSES,
          );
          rotationContinuityRef.current = continuity.state;

          if (continuity.phase === 'inactive' || continuity.phase === 'released') {
            prevRotatePosRef.current = null;
            prevRotateSampleAtRef.current = 0;
            lastValidRotVelRef.current = { x: 0, y: 0 };
            return false;
          }

          newGesture = GestureType.RIGHT_TWO_FINGER_ROTATE;

          if (continuity.phase === 'grace') {
            const elapsedSinceValidMs = Math.max(
              0,
              startTimeMs - continuity.state.lastValidAtMs,
            );
            rotVelX = decayRate(
              lastValidRotVelRef.current.x,
              elapsedSinceValidMs,
              ROTATION_GRACE_DECAY_TIME_CONSTANT_MS,
            );
            rotVelY = decayRate(
              lastValidRotVelRef.current.y,
              elapsedSinceValidMs,
              ROTATION_GRACE_DECAY_TIME_CONSTANT_MS,
            );
            rotationGraceActive = true;
            return true;
          }

          const indexTip = landmarks![8];
          const middleTip = landmarks![12];
          const rawFingerCenterX = (indexTip.x + middleTip.x) / 2;
          const rawFingerCenterY = (indexTip.y + middleTip.y) / 2;
          const sampleDeltaMs = prevRotateSampleAtRef.current > 0
            ? Math.max(1, startTimeMs - prevRotateSampleAtRef.current)
            : 1;
          const positionAlpha = exponentialSmoothingAlpha(
            sampleDeltaMs,
            POSITION_FILTER_TIME_CONSTANT_MS,
          );

          if (prevRotatePosRef.current) {
            smoothRotateFingerCenterRef.current.x = lerp(
              smoothRotateFingerCenterRef.current.x,
              rawFingerCenterX,
              positionAlpha,
            );
            smoothRotateFingerCenterRef.current.y = lerp(
              smoothRotateFingerCenterRef.current.y,
              rawFingerCenterY,
              positionAlpha,
            );
          } else {
            smoothRotateFingerCenterRef.current.x = rawFingerCenterX;
            smoothRotateFingerCenterRef.current.y = rawFingerCenterY;
          }

          if (prevRotatePosRef.current) {
            const deltaX = smoothRotateFingerCenterRef.current.x - prevRotatePosRef.current.x;
            const deltaY = smoothRotateFingerCenterRef.current.y - prevRotatePosRef.current.y;
            const rateX = applyRateDeadzone(
              normalizeRatePerSecond(deltaX, sampleDeltaMs),
              ROTATION_RATE_DEADZONE,
            );
            const rateY = applyRateDeadzone(
              normalizeRatePerSecond(deltaY, sampleDeltaMs),
              ROTATION_RATE_DEADZONE,
            );
            // ModelViewer integrates these time-normalized rates once per frame.
            rotVelY = -rateX * ROTATION_SENSITIVITY;
            rotVelX = rateY * ROTATION_SENSITIVITY;
          }
          prevRotatePosRef.current = { ...smoothRotateFingerCenterRef.current };
          prevRotateSampleAtRef.current = startTimeMs;
          lastValidRotVelRef.current = {
            x: clampRate(rotVelX, ROTATION_MAX_RATE),
            y: clampRate(rotVelY, ROTATION_MAX_RATE),
          };
          return true;
        };

        const applySingleHandZoom = (landmarks: any[]) => {
          const isMiddleUp = isFingerExtended(landmarks, 12, 10);
          const isRingUp = isFingerExtended(landmarks, 16, 14);
          const isPinkyUp = isFingerExtended(landmarks, 20, 18);
          if (isMiddleUp || isRingUp || isPinkyUp) {
            pinchZoomMotionRef.current = null;
            return false;
          }

          const thumbIndexRatio = getPinchDistance(landmarks) / getPalmWidth(landmarks);
          const previousMotion = pinchZoomMotionRef.current;
          let filteredRate = 0;
          let active = false;
          if (previousMotion) {
            const sampleDeltaMs = Math.max(1, startTimeMs - previousMotion.atMs);
            const rawRate = sampleDeltaMs <= TRACKING_CONTINUITY_MS
              ? (thumbIndexRatio - previousMotion.ratio) * 1000 / sampleDeltaMs
              : 0;
            const rateAlpha = exponentialSmoothingAlpha(sampleDeltaMs, ZOOM_PINCH_RATE_FILTER_MS);
            filteredRate = previousMotion.filteredRate
              + (rawRate - previousMotion.filteredRate) * rateAlpha;
            active = previousMotion.active
              ? Math.abs(filteredRate) >= ZOOM_PINCH_RATE_STOP
              : Math.abs(filteredRate) >= ZOOM_PINCH_RATE_START;
          }
          pinchZoomMotionRef.current = {
            ratio: thumbIndexRatio,
            atMs: startTimeMs,
            filteredRate,
            active,
          };

          if (!active) return false;

          const zoomSpeed = clampRate(filteredRate * ZOOM_PINCH_RATE_GAIN, ZOOM_SPEED_PER_SECOND);
          if (zoomSpeed < 0) {
            newGesture = GestureType.ZOOM_OUT_FIST;
            newZoomSpeed = zoomSpeed;
            return true;
          }

          if (zoomSpeed > 0) {
            newGesture = GestureType.ZOOM_IN_PALM;
            newZoomSpeed = zoomSpeed;
            return true;
          }

          return false;
        };

        const applyPinchDrag = (landmarks: any[], suppressZoom = true) => {
          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const pinchRatio = getPinchDistance(landmarks) / getPalmWidth(landmarks);
          // 拆解条件：中指+无名指+小指必须伸直（拇食弯曲捏合）
          // 这样跟握拳（全弯）、全张开（全伸直）都明确区分
          const isMiddleUp = isFingerExtended(landmarks, 12, 10);
          const isRingUp = isFingerExtended(landmarks, 16, 14);
          const isPinkyUp = isFingerExtended(landmarks, 20, 18);
          const threeUp = isMiddleUp && isRingUp && isPinkyUp;
          const isPinching = threeUp && hysteresisBelow(
            pinchRatio,
            pinchGestureActiveRef.current,
            PINCH_ENTER_RATIO,
            PINCH_EXIT_RATIO,
          );
          pinchGestureActiveRef.current = isPinching;

          if (isPinching) {
            isDragging = true;
            newGesture = GestureType.RIGHT_PINCH_DRAG;
            if (suppressZoom) {
              newZoomSpeed = 0;
            }

            const rawX = (thumbTip.x + indexTip.x) / 2;
            const rawY = (thumbTip.y + indexTip.y) / 2;

            const dx = rawX - smoothDragPinchRef.current.x;
            const dy = rawY - smoothDragPinchRef.current.y;
            const movementDelta = Math.hypot(dx, dy);
            // A single time-aware position filter keeps drag responsive while
            // avoiding the old movement-dependent double smoothing.
            const adaptiveFactor = Math.min(0.9, Math.max(
              0.18,
              exponentialSmoothingAlpha(
                Math.max(1, startTimeMs - (lastResultTimestampRef.current || startTimeMs) + 1),
                POSITION_FILTER_TIME_CONSTANT_MS,
              ) + movementDelta * 0.35,
            ));

            smoothDragPinchRef.current.x = lerp(smoothDragPinchRef.current.x, rawX, adaptiveFactor);
            smoothDragPinchRef.current.y = lerp(smoothDragPinchRef.current.y, rawY, adaptiveFactor);

            publishFilteredDragPosition(
              smoothDragPinchRef.current.x,
              smoothDragPinchRef.current.y,
            );
            return true;
          }

          // Rebase on the next pinch without jumping to the wrist location.
          smoothDragPinchRef.current = {
            x: (thumbTip.x + indexTip.x) / 2,
            y: (thumbTip.y + indexTip.y) / 2,
          };
          return false;
        };

        if (interactionModeRef.current === 'single') {
          wasContactingRef.current = false;
          const activeHandLandmarks = activeSingleHandLandmarks;

          const isRotating = applySingleHandRotation(activeHandLandmarks);
          if (!isRotating && activeHandLandmarks) {
            const isDraggingPart = applyPinchDrag(activeHandLandmarks);
            if (!isDraggingPart) {
              applySingleHandZoom(activeHandLandmarks);
            }
          }
        } else {

        // 2. DUAL HAND LOGIC.
        //    Both hands can pinch independently — either or both at the same time.
        //    Whichever hand(s) pinches will publish its (or their averaged) position.
          const fullScreenRotationActive = applySingleHandRotation(dualManipulationHandLandmarks);
          if (fullScreenRotationActive) {
            isDragging = false;
            wasContactingRef.current = false;
          }

          // --- Right hand pinch (uses primary refs) ---
          const rightLandmarks = dualManipulationHandLandmarks;
          let isRightPinching = false;
          let rightPinchX = 0, rightPinchY = 0;
          if (!fullScreenRotationActive && rightLandmarks) {
            const thumbTip = rightLandmarks[4];
            const indexTip = rightLandmarks[8];
            const pinchRatio = getPinchDistance(rightLandmarks) / getPalmWidth(rightLandmarks);
            // 拆解条件：中指+无名指+小指必须伸直（拇食弯曲捏合）
            const rMiddleUp = isFingerExtended(rightLandmarks, 12, 10);
            const rRingUp = isFingerExtended(rightLandmarks, 16, 14);
            const rPinkyUp = isFingerExtended(rightLandmarks, 20, 18);
            const rThreeUp = rMiddleUp && rRingUp && rPinkyUp;
            rightPinchX = (thumbTip.x + indexTip.x) / 2;
            rightPinchY = (thumbTip.y + indexTip.y) / 2;
            isRightPinching = rThreeUp && hysteresisBelow(
              pinchRatio, pinchGestureActiveRef.current,
              PINCH_ENTER_RATIO, PINCH_EXIT_RATIO,
            );
            pinchGestureActiveRef.current = isRightPinching;
          } else {
            pinchGestureActiveRef.current = false;
    otherPinchActiveRef.current = false;
          }

          // --- Left hand pinch (uses *independent* refs) ---
          const leftLandmarks = dualZoomHandLandmarks;
          let isLeftPinching = false;
          let leftPinchX = 0, leftPinchY = 0;
          if (!fullScreenRotationActive && leftLandmarks) {
            const thumbTip = leftLandmarks[4];
            const indexTip = leftLandmarks[8];
            const pinchRatio = getPinchDistance(leftLandmarks) / getPalmWidth(leftLandmarks);
            // 拆解条件：中指+无名指+小指必须伸直（拇食弯曲捏合）
            const lMiddleUp = isFingerExtended(leftLandmarks, 12, 10);
            const lRingUp = isFingerExtended(leftLandmarks, 16, 14);
            const lPinkyUp = isFingerExtended(leftLandmarks, 20, 18);
            const lThreeUp = lMiddleUp && lRingUp && lPinkyUp;
            leftPinchX = (thumbTip.x + indexTip.x) / 2;
            leftPinchY = (thumbTip.y + indexTip.y) / 2;
            isLeftPinching = lThreeUp && hysteresisBelow(
              pinchRatio, otherPinchActiveRef.current,
              PINCH_ENTER_RATIO, PINCH_EXIT_RATIO,
            );
            otherPinchActiveRef.current = isLeftPinching;
          } else {
            otherPinchActiveRef.current = false;
          }

          // --- Publish pinch position(s) ---
          const activePinches: { x: number; y: number; smoothRef: { current: { x: number; y: number } } }[] = [];
          if (isRightPinching) activePinches.push({ x: rightPinchX, y: rightPinchY, smoothRef: smoothDragPinchRef });
          if (isLeftPinching) activePinches.push({ x: leftPinchX, y: leftPinchY, smoothRef: otherSmoothDragPinchRef });

          if (activePinches.length > 0) {
            isDragging = true;
            newGesture = isRightPinching && isLeftPinching
              ? GestureType.RIGHT_PINCH_DRAG   // simultaneous → treat as right (disassembly toggles once)
              : isRightPinching ? GestureType.RIGHT_PINCH_DRAG : GestureType.LEFT_PINCH_DRAG;

            // Average raw positions when both hands pinch together
            const avgRawX = activePinches.reduce((s, p) => s + p.x, 0) / activePinches.length;
            const avgRawY = activePinches.reduce((s, p) => s + p.y, 0) / activePinches.length;

            // Smooth with right-hand filter (primary path) — consistent with viewer expectations
            const dx = avgRawX - smoothDragPinchRef.current.x;
            const dy = avgRawY - smoothDragPinchRef.current.y;
            const movementDelta = Math.hypot(dx, dy);
            const adaptiveFactor = Math.min(0.9, Math.max(
              0.18,
              exponentialSmoothingAlpha(
                Math.max(1, startTimeMs - (lastResultTimestampRef.current || startTimeMs) + 1),
                POSITION_FILTER_TIME_CONSTANT_MS,
              ) + movementDelta * 0.35,
            ));
            smoothDragPinchRef.current.x = lerp(smoothDragPinchRef.current.x, avgRawX, adaptiveFactor);
            smoothDragPinchRef.current.y = lerp(smoothDragPinchRef.current.y, avgRawY, adaptiveFactor);
            // Rebase left-hand filter too (keeps both in sync)
            otherSmoothDragPinchRef.current = { x: avgRawX, y: avgRawY };
            publishFilteredDragPosition(smoothDragPinchRef.current.x, smoothDragPinchRef.current.y);
          } else {
            // No pinching — rebase both smooth refs independently
            if (rightLandmarks) {
              smoothDragPinchRef.current = {
                x: (rightLandmarks[4].x + rightLandmarks[8].x) / 2,
                y: (rightLandmarks[4].y + rightLandmarks[8].y) / 2,
              };
            }
            if (leftLandmarks) {
              otherSmoothDragPinchRef.current = {
                x: (leftLandmarks[4].x + leftLandmarks[8].x) / 2,
                y: (leftLandmarks[4].y + leftLandmarks[8].y) / 2,
              };
            }
          }

          // --- Zoom: only when *neither* hand is pinching ---
          const isLeftZooming = !rotationGraceActive && !isRightPinching && !isLeftPinching && dualZoomHandLandmarks
            ? applySingleHandZoom(dualZoomHandLandmarks)
            : false;

          const isOpenPalm = (landmarks: any[] | null) => Boolean(landmarks)
            && [8, 12, 16, 20].every((tip) => isFingerExtended(landmarks as any[], tip, tip - 2));
          const bothHandsOpen = isOpenPalm(leftHandLandmarks) && isOpenPalm(rightHandLandmarks);
          if (bothHandsOpen) {
            const now = performance.now();
            if (!openStopStartRef.current) openStopStartRef.current = now;
            if (now - openStopStartRef.current >= OPEN_STOP_HOLD_MS) {
              openStopActiveRef.current = true;
              rotVelX = 0;
              rotVelY = 0;
              newZoomSpeed = 0;
              isDragging = false;
              newGesture = GestureType.DUAL_HAND_OPEN_STOP;
            }
          } else {
            openStopStartRef.current = 0;
            openStopActiveRef.current = false;
          }

          if (openStopActiveRef.current) {
            newGesture = GestureType.DUAL_HAND_OPEN_STOP;
          } else if (isRightPinching && isLeftPinching) {
            newGesture = GestureType.RIGHT_PINCH_DRAG;  // simultaneous
          } else if (isRightPinching) {
            newGesture = GestureType.RIGHT_PINCH_DRAG;
          } else if (isLeftPinching) {
            newGesture = GestureType.LEFT_PINCH_DRAG;
          } else if (fullScreenRotationActive) {
            newGesture = GestureType.RIGHT_TWO_FINGER_ROTATE;
          }

          // Contact fallback — only when neither hand pinches, neither hand rotates, and neither hand zooms.
          let isContacting = false;
          if (!fullScreenRotationActive && !isRightPinching && !isLeftPinching && !isLeftZooming && leftHandLandmarks && rightHandLandmarks) {
            const leftWrist = leftHandLandmarks[0];
            const rightWrist = rightHandLandmarks[0];
            const dist = getDistance(leftWrist, rightWrist);

            // Hysteresis: require larger distance to exit contact state than to enter it.
            const threshold = wasContactingRef.current ? CONTACT_THRESHOLD * 1.3 : CONTACT_THRESHOLD;

            if (dist < threshold) {
              newGesture = GestureType.DUAL_HAND_CONTACT;
              isContacting = true;
            }
          }
          wasContactingRef.current = isContacting;
        }
      }

      // A predicted candidate is only a short continuity bridge. Attenuate its
      // motion as it ages, then let the tracker hard-stop after the grace.
      if (leftHandStale || rightHandStale) {
        rotVelX *= staleAttenuation;
        rotVelY *= staleAttenuation;
        newZoomSpeed *= staleAttenuation;
      }

      // Locked confirmation or an expired tracking grace stops stale input.
      if (!trackedHands.controlEnabled) {
        smoothRotVelRef.current = { x: 0, y: 0 };
        smoothZoomRef.current = 0;
        pinchZoomMotionRef.current = null;
        prevRotatePosRef.current = null;
        prevRotateSampleAtRef.current = 0;
        rotationContinuityRef.current = createRotationContinuityState();
        lastValidRotVelRef.current = { x: 0, y: 0 };
        pinchGestureActiveRef.current = false;
    otherPinchActiveRef.current = false;
        wasContactingRef.current = false;
        isDragging = false;
      } else {
        // The position filter removes landmark noise; this second, explicitly
        // time-aware stage limits angular speed and acceleration so a sparse
        // fast hand sample cannot turn into a visible camera snap.
        const rotationSampleDeltaMs = Math.max(
          1,
          startTimeMs - (lastControlSampleAtRef.current || startTimeMs),
        );
        smoothRotVelRef.current.x = smoothRateTowardsTarget(
          smoothRotVelRef.current.x,
          rotVelX,
          rotationSampleDeltaMs,
          ROTATION_MAX_RATE,
          ROTATION_MAX_ACCELERATION,
          ROTATION_OUTPUT_FILTER_TIME_CONSTANT_MS,
        );
        smoothRotVelRef.current.y = smoothRateTowardsTarget(
          smoothRotVelRef.current.y,
          rotVelY,
          rotationSampleDeltaMs,
          ROTATION_MAX_RATE,
          ROTATION_MAX_ACCELERATION,
          ROTATION_OUTPUT_FILTER_TIME_CONSTANT_MS,
        );
        const zoomSampleDeltaMs = Math.max(
          1,
          startTimeMs - (lastControlSampleAtRef.current || startTimeMs),
        );
        const zoomAlpha = exponentialSmoothingAlpha(
          zoomSampleDeltaMs,
          ZOOM_FILTER_TIME_CONSTANT_MS,
        );
        smoothZoomRef.current = lerp(smoothZoomRef.current, newZoomSpeed, zoomAlpha);
        if (openStopActiveRef.current) {
          prevRotatePosRef.current = null;
          prevRotateSampleAtRef.current = 0;
          rotationContinuityRef.current = createRotationContinuityState();
          lastValidRotVelRef.current = { x: 0, y: 0 };
          smoothZoomRef.current = 0;
        }
      }

      // Apply deadzone on smoothed output
      const isRotationLocked = controlRef.current.rotationLocked;
      if (isRotationLocked) {
        smoothRotVelRef.current = { x: 0, y: 0 };
        prevRotatePosRef.current = null;
        prevRotateSampleAtRef.current = 0;
        rotationContinuityRef.current = createRotationContinuityState();
        lastValidRotVelRef.current = { x: 0, y: 0 };
      }
      const finalRotX = !isRotationLocked && Math.abs(smoothRotVelRef.current.x) > 0.001 ? smoothRotVelRef.current.x : 0;
      const finalRotY = !isRotationLocked && Math.abs(smoothRotVelRef.current.y) > 0.001 ? smoothRotVelRef.current.y : 0;
      const finalZoomSpeed = Math.abs(smoothZoomRef.current) > 0.01 ? smoothZoomRef.current : 0;
      const rotationGestureActive = !quizModeRef.current
        && !controlRef.current.voiceRotationActive
        && !isRotationLocked
        && trackedHands.controlEnabled
        && newGesture === GestureType.RIGHT_TWO_FINGER_ROTATE;
      controlRef.current.rotationGestureActive = rotationGestureActive;

      // 答题模式下：冻结模型控制，但保留手势位置数据
      if (quizModeRef.current) {
        controlRef.current.rotationVelocity = { x: 0, y: 0 };
        controlRef.current.zoomSpeed = 0;
        controlRef.current.isDragging = false;
        controlRef.current.panPosition = { x: 0, y: 0 };
      } else if (controlRef.current.voiceRotationActive) {
        // 语音持续旋转中：HandController 不要覆盖 rotationVelocity（保留 VoiceController 的 0.035）
        controlRef.current.zoomSpeed = finalZoomSpeed;
        controlRef.current.isDragging = isDragging;
      } else {
        // 正常模式：按手势更新
        controlRef.current.rotationVelocity = { x: finalRotX, y: finalRotY };
        controlRef.current.zoomSpeed = finalZoomSpeed;
        controlRef.current.isDragging = isDragging;
        // panPosition 已在 applyPinchDrag 内部更新，这里不需要重复设置
      }

      // 传递手部关节数据到3D场景
      const isSingleMode = quizModeRef.current || interactionModeRef.current === 'single';
      const realLeftHandLandmarks = rightHandLandmarks;
      const realRightHandLandmarks = leftHandLandmarks;
      const dualManipulationHandLandmarks = leftHandLandmarks;
      const activeSingleHandLandmarks = isSingleMode ? (realLeftHandLandmarks || realRightHandLandmarks) : null;
      const visibleLeftHandLandmarks = isSingleMode
        ? (activeSingleHandLandmarks === leftHandLandmarks ? leftHandLandmarks : null)
        : leftHandLandmarks;
      const visibleRightHandLandmarks = isSingleMode
        ? (activeSingleHandLandmarks === rightHandLandmarks ? rightHandLandmarks : null)
        : rightHandLandmarks;
      const interactionHandLandmarks = isSingleMode
        ? activeSingleHandLandmarks
        : dualManipulationHandLandmarks;

      // 手势位置数据始终更新（答题和非答题都需要）
      const mappedInteractionLandmarks = interactionHandLandmarks
        ? toPointList(interactionHandLandmarks)
        : null;
      controlRef.current.handLandmarks = {
        left: visibleLeftHandLandmarks ? toPointList(visibleLeftHandLandmarks) : null,
        right: visibleRightHandLandmarks ? toPointList(visibleRightHandLandmarks) : null
      };
      controlRef.current.interactionHandLandmarks = mappedInteractionLandmarks;
      // 每帧由 HandController 统一推进相对指针，作为答题光标唯一来源。
      controlRef.current.handPointer = computeHandPointer(mappedInteractionLandmarks);
      controlRef.current.handRawFingertip = readRawFingertip(mappedInteractionLandmarks);
      lastControlSampleAtRef.current = startTimeMs;

      // Use ref to call the latest callback, only on state changes
      const lastPublishedState = lastPublishedStateRef.current;
      const shouldPublishState =
        lastPublishedState.gesture !== newGesture ||
        lastPublishedState.direction !== newDirection ||
        lastPublishedState.isDragging !== isDragging;

      if (shouldPublishState && onStateChangeRef.current) {
        lastPublishedStateRef.current = {
          gesture: newGesture,
          direction: newDirection,
          isDragging,
        };
        onStateChangeRef.current(newGesture, newDirection, isDragging);
      }

    if (ctx) ctx.restore();
  };

  if (error) return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-50 text-red-400 p-4 text-center">
      <svg className="w-8 h-8 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      <span className="text-xs font-black leading-tight">{error}</span>
    </div>
  );

  return (
    <div className="w-full h-full relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-30 bg-gray-900 text-ink text-[10px] font-bold uppercase tracking-widest">
          AI Vision Init...
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover transform -scale-x-100"
      />
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        width={320}
        height={240}
      />
      {!loading && (
        <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2 pointer-events-none">
          <div className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[9px] font-black tracking-wide shadow-lg backdrop-blur-md ${
            trackingStatus.phase === 'locked'
              ? 'border-cyan/50 bg-cyan-950/75 text-cyan'
              : trackingStatus.phase === 'partial_lost' || trackingStatus.phase === 'lost'
                ? 'border-amber-300/50 bg-amber-950/75 text-amber-100'
                : trackingStatus.phase === 'confirming'
                  ? 'border-violet-300/50 bg-violet-950/75 text-violet-100'
                  : 'border-line/20 bg-slate-950/70 text-ink-soft'
          }`}>
            {trackingStatus.text}
          </div>
        </div>
      )}
    </div>
  );
};

export default HandController;

