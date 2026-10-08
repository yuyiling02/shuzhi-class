export type BrowserSpeechRecognitionErrorCode =
  | 'unsupported'
  | 'insecure_context'
  | 'microphone_denied'
  | 'microphone_unavailable'
  | 'network'
  | 'service_unavailable'
  | 'start_failed';

export interface BrowserSpeechRecognitionCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: BrowserSpeechRecognitionError) => void;
}

type RecognitionState = 'idle' | 'connecting' | 'active' | 'stopped';

type RecognitionWindow = Pick<Window, 'SpeechRecognition' | 'webkitSpeechRecognition'>;

export interface BrowserSpeechRecognitionRuntime {
  getConstructor: () => SpeechRecognitionConstructor | undefined;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  restartDelayMs: number;
  startTimeoutMs: number;
  isSecureContext: () => boolean;
}

const getWindowRecognitionConstructor = () => {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
};

const defaultRuntime = (): BrowserSpeechRecognitionRuntime => ({
  getConstructor: getWindowRecognitionConstructor,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  restartDelayMs: 250,
  startTimeoutMs: 15000,
  isSecureContext: () => typeof window === 'undefined' || window.isSecureContext !== false,
});

export const isBrowserSpeechRecognitionSupported = (
  target: Partial<RecognitionWindow> | undefined = typeof window === 'undefined' ? undefined : window,
) => Boolean(target?.SpeechRecognition || target?.webkitSpeechRecognition);

export class BrowserSpeechRecognitionError extends Error {
  public readonly code: BrowserSpeechRecognitionErrorCode;

  constructor(code: BrowserSpeechRecognitionErrorCode, message: string) {
    super(message);
    this.name = 'BrowserSpeechRecognitionError';
    this.code = code;
  }
}

export const describeBrowserSpeechRecognitionError = (error: BrowserSpeechRecognitionError) => {
  const messages: Record<BrowserSpeechRecognitionErrorCode, string> = {
    unsupported: '当前浏览器不支持语音识别，请使用最新版 Chrome 或 Edge。',
    insecure_context: '语音识别需要安全连接，请使用 HTTPS 或 localhost 打开课堂。',
    microphone_denied: '麦克风访问被拒绝，请在浏览器地址栏中允许麦克风权限。',
    microphone_unavailable: '没有检测到可用麦克风，请检查设备连接。',
    network: '浏览器在线语音识别服务连接失败。Chrome 需要连接 Google 识别服务，请检查该服务的网络连通性，或尝试 Edge。',
    service_unavailable: '浏览器语音识别服务暂不可用，请稍后重试。',
    start_failed: '浏览器语音识别启动失败，请关闭语音后重试。',
  };
  return messages[error.code] || error.message;
};

const normalizeRecognitionError = (
  error: SpeechRecognitionErrorCode | unknown,
  message = '',
): BrowserSpeechRecognitionError => {
  if (error instanceof BrowserSpeechRecognitionError) return error;
  if (error === 'not-allowed') return new BrowserSpeechRecognitionError('microphone_denied', message);
  if (error === 'audio-capture') return new BrowserSpeechRecognitionError('microphone_unavailable', message);
  if (error === 'network') return new BrowserSpeechRecognitionError('network', message);
  if (error === 'service-not-allowed' || error === 'language-not-supported' || error === 'bad-grammar') {
    return new BrowserSpeechRecognitionError('service_unavailable', message);
  }
  return new BrowserSpeechRecognitionError(
    'start_failed',
    error instanceof Error ? error.message : message || String(error || 'unknown error'),
  );
};

export class BrowserSpeechRecognition {
  private state: RecognitionState = 'idle';
  private recognition: SpeechRecognition | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private pendingStartResolve: (() => void) | null = null;
  private pendingStartReject: ((error: BrowserSpeechRecognitionError) => void) | null = null;
  private readonly callbacks: BrowserSpeechRecognitionCallbacks;
  private readonly runtime: BrowserSpeechRecognitionRuntime;
  private readonly canContinue: () => boolean;

  constructor(
    callbacks: BrowserSpeechRecognitionCallbacks,
    runtime?: Partial<BrowserSpeechRecognitionRuntime>,
    canContinue: () => boolean = () => true,
  ) {
    this.callbacks = callbacks;
    this.runtime = { ...defaultRuntime(), ...runtime };
    this.canContinue = canContinue;
  }

  get currentState() {
    return this.state;
  }

  start() {
    if (!this.runtime.isSecureContext()) {
      return Promise.reject(new BrowserSpeechRecognitionError('insecure_context', 'HTTPS is required'));
    }
    if (this.state === 'active') return Promise.resolve();
    if (this.state === 'connecting') {
      return Promise.reject(new BrowserSpeechRecognitionError('start_failed', '语音识别正在启动'));
    }
    if (!this.runtime.getConstructor()) {
      return Promise.reject(new BrowserSpeechRecognitionError('unsupported', 'SpeechRecognition is unavailable'));
    }
    if (!this.canContinue()) {
      this.state = 'stopped';
      return Promise.resolve();
    }

    this.shouldRun = true;
    this.state = 'connecting';
    return new Promise<void>((resolve, reject) => {
      this.pendingStartResolve = resolve;
      this.pendingStartReject = reject;
      this.launchRecognition();
    });
  }

  stop() {
    this.shouldRun = false;
    this.state = 'stopped';
    this.clearRestartTimer();
    this.clearStartTimer();
    this.settlePendingStart();

    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    this.detachRecognition(recognition);
    try { recognition.abort(); } catch { /* browser already ended recognition */ }
  }

  private launchRecognition() {
    if (!this.shouldRun || !this.canContinue()) {
      this.shouldRun = false;
      this.state = 'stopped';
      this.settlePendingStart();
      return;
    }

    const Recognition = this.runtime.getConstructor();
    if (!Recognition) {
      this.fail(new BrowserSpeechRecognitionError('unsupported', 'SpeechRecognition is unavailable'));
      return;
    }

    let recognition: SpeechRecognition;
    try {
      recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'zh-CN';
      recognition.maxAlternatives = 1;
    } catch (error) {
      this.fail(normalizeRecognitionError(error));
      return;
    }

    this.recognition = recognition;
    recognition.onstart = () => {
      if (this.recognition !== recognition) return;
      this.clearStartTimer();
      if (!this.shouldRun || !this.canContinue()) {
        this.stop();
        return;
      }
      this.state = 'active';
      this.settlePendingStart();
    };
    recognition.onresult = (event) => {
      if (this.recognition !== recognition || !this.shouldRun) return;
      const interim: string[] = [];
      const finals: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (!transcript) continue;
        if (result.isFinal) finals.push(transcript);
        else interim.push(transcript);
      }
      if (interim.length > 0) this.callbacks.onPartial(interim.join(' '));
      if (finals.length > 0) this.callbacks.onFinal(finals.join(' '));
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.fail(normalizeRecognitionError(event.error, event.message));
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.clearStartTimer();
      this.detachRecognition(recognition);
      this.recognition = null;

      if (!this.shouldRun || !this.canContinue()) {
        this.shouldRun = false;
        this.state = 'stopped';
        this.settlePendingStart();
        return;
      }
      if (this.pendingStartReject) {
        this.fail(new BrowserSpeechRecognitionError('start_failed', '语音识别在启动前结束'));
        return;
      }

      this.state = 'connecting';
      this.restartTimer = this.runtime.setTimeout(() => {
        this.restartTimer = null;
        this.launchRecognition();
      }, this.runtime.restartDelayMs);
    };

    try {
      this.startTimer = this.runtime.setTimeout(() => {
        this.startTimer = null;
        if (this.recognition === recognition) {
          this.fail(new BrowserSpeechRecognitionError('start_failed', '语音识别启动超时'));
        }
      }, this.runtime.startTimeoutMs);
      recognition.start();
    } catch (error) {
      this.detachRecognition(recognition);
      if (this.recognition === recognition) this.recognition = null;
      this.fail(normalizeRecognitionError(error));
    }
  }

  private fail(error: BrowserSpeechRecognitionError) {
    this.shouldRun = false;
    this.state = 'stopped';
    this.clearRestartTimer();
    this.clearStartTimer();
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      this.detachRecognition(recognition);
      try { recognition.abort(); } catch { /* browser already ended recognition */ }
    }
    const rejectedPendingStart = Boolean(this.pendingStartReject);
    if (this.pendingStartReject) this.pendingStartReject(error);
    this.pendingStartResolve = null;
    this.pendingStartReject = null;
    if (!rejectedPendingStart) this.callbacks.onError(error);
  }

  private settlePendingStart() {
    this.pendingStartResolve?.();
    this.pendingStartResolve = null;
    this.pendingStartReject = null;
  }

  private clearRestartTimer() {
    if (this.restartTimer === null) return;
    this.runtime.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearStartTimer() {
    if (this.startTimer === null) return;
    this.runtime.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private detachRecognition(recognition: SpeechRecognition) {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }
}
