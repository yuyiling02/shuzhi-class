import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

interface InitRequest {
  type: 'init';
  wasmPath: string;
  modelAssetPath: string;
  numHands: number;
}

interface FrameRequest {
  type: 'frame';
  sequence: number;
  capturedAt: number;
  bitmap: ImageBitmap;
}

type WorkerRequest = InitRequest | FrameRequest;

interface SerializedCategory {
  categoryName?: string;
  score?: number;
  index?: number;
  displayName?: string;
}

interface DetectionResponse {
  type: 'result';
  sequence: number;
  capturedAt: number;
  processedAt: number;
  inferenceMs: number;
  landmarks: Array<Array<{ x: number; y: number; z: number }>>;
  handedness: Array<SerializedCategory[]>;
}

interface WorkerErrorResponse {
  type: 'error';
  sequence?: number;
  capturedAt?: number;
  message: string;
}

interface WorkerReadyResponse {
  type: 'ready';
  numHands: number;
  delegate: 'GPU' | 'CPU';
}

type WorkerResponse = DetectionResponse | WorkerErrorResponse | WorkerReadyResponse;

// Keep the worker surface structural so this file does not require the WebWorker
// lib in the application's main tsconfig.
const workerScope = self as unknown as {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  import?: (url: string) => Promise<unknown>;
  ModuleFactory?: unknown;
  custom_dbg?: (...values: unknown[]) => void;
  location: Location;
};

workerScope.custom_dbg = (...values: unknown[]) => console.warn(...values);

// tasks-vision loads an Emscripten classic script with importScripts(). Module
// workers reject that API and the library calls a host-provided self.import()
// fallback. Convert only our fixed, same-origin MediaPipe loader into a small
// ESM blob that explicitly exposes the generated ModuleFactory global.
workerScope.import = async (rawUrl: string) => {
  const loaderUrl = new URL(rawUrl, workerScope.location.href);
  if (
    loaderUrl.origin !== workerScope.location.origin
    || !loaderUrl.pathname.startsWith('/mediapipe/wasm/')
    || !/^vision_wasm_(?:nosimd_)?internal\.js$/u.test(loaderUrl.pathname.split('/').pop() ?? '')
  ) {
    throw new Error(`Refusing unexpected MediaPipe loader URL: ${loaderUrl.href}`);
  }
  loaderUrl.search = '';
  loaderUrl.hash = '';
  const response = await fetch(loaderUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Unable to load MediaPipe runtime: HTTP ${response.status}`);
  }
  const source = await response.text();
  const moduleUrl = URL.createObjectURL(new Blob([
    source,
    '\nexport { ModuleFactory };\n',
  ], { type: 'text/javascript' }));
  try {
    const loaded = await import(/* @vite-ignore */ moduleUrl) as { ModuleFactory?: unknown };
    if (typeof loaded.ModuleFactory !== 'function') {
      throw new Error('MediaPipe runtime did not export ModuleFactory');
    }
    workerScope.ModuleFactory = loaded.ModuleFactory;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
};

let handLandmarker: HandLandmarker | null = null;
let initToken = 0;

const createHandLandmarker = async (
  wasmPath: string,
  modelAssetPath: string,
  numHands: number,
  delegate: 'GPU' | 'CPU',
) => {
  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
      delegate,
    },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.45,
  });
};

const serializeResult = (result: {
  landmarks?: Array<Array<{ x: number; y: number; z?: number }>>;
  handedness?: Array<SerializedCategory[]>;
}) => ({
  landmarks: (result.landmarks ?? []).map((hand) => hand.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z ?? 0,
  }))),
  handedness: (result.handedness ?? []).map((categories) => categories.map((category) => ({
    categoryName: category.categoryName,
    score: category.score,
    index: category.index,
    displayName: category.displayName,
  }))),
});

const initialize = async (request: InitRequest) => {
  const token = ++initToken;
  handLandmarker?.close();
  handLandmarker = null;

  let delegate: 'GPU' | 'CPU' = 'GPU';
  let nextLandmarker: HandLandmarker;
  try {
    nextLandmarker = await createHandLandmarker(
      request.wasmPath,
      request.modelAssetPath,
      request.numHands,
      delegate,
    );
  } catch (gpuError) {
    // A worker keeps a CPU fallback off the UI thread when WebGL/GPU delegate
    // initialization fails (common on older/integrated graphics devices).
    delegate = 'CPU';
    try {
      nextLandmarker = await createHandLandmarker(
        request.wasmPath,
        request.modelAssetPath,
        request.numHands,
        delegate,
      );
    } catch (cpuError) {
      // A newer mode switch may already be initializing another landmarker.
      // Never let an obsolete initialization failure tear down that session.
      if (token !== initToken) return;
      const gpuMessage = gpuError instanceof Error ? gpuError.message : String(gpuError);
      const cpuMessage = cpuError instanceof Error ? cpuError.message : String(cpuError);
      workerScope.postMessage({
        type: 'error',
        message: `MediaPipe 初始化失败（GPU: ${gpuMessage}; CPU: ${cpuMessage}）`,
      });
      return;
    }
  }

  if (token !== initToken) {
    nextLandmarker.close();
    return;
  }
  handLandmarker = nextLandmarker;
  workerScope.postMessage({ type: 'ready', numHands: request.numHands, delegate });
};

const processFrame = (request: FrameRequest) => {
  const bitmap = request.bitmap;
  try {
    if (!handLandmarker) {
      workerScope.postMessage({
        type: 'error',
        sequence: request.sequence,
        capturedAt: request.capturedAt,
        message: 'MediaPipe 尚未准备完成',
      });
      return;
    }
    const inferenceStartedAt = performance.now();
    const result = handLandmarker.detectForVideo(bitmap, request.capturedAt);
    const processedAt = performance.now();
    const serialized = serializeResult(result);
    workerScope.postMessage({
      type: 'result',
      sequence: request.sequence,
      capturedAt: request.capturedAt,
      processedAt,
      inferenceMs: processedAt - inferenceStartedAt,
      ...serialized,
    });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      sequence: request.sequence,
      capturedAt: request.capturedAt,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap.close();
  }
};

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'init') {
    void initialize(request);
    return;
  }
  if (request.type === 'frame') {
    processFrame(request);
  }
};
