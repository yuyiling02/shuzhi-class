import { extractSpeechSegments } from './speechTextProcessing.ts';

export type SpeechProgress = {
  /** Character offset in the text supplied to this speech session. */
  charIndex: number;
  source: 'boundary' | 'estimated';
};

export type SpeakOptions = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  onProgress?: (progress: SpeechProgress) => void;
};
export type VoiceMode = 'system' | 'volcengine';
export type VoicePreference = { mode: VoiceMode; systemVoiceUri: string; providerVoiceId: string; };
export type XiaozhiSpeechSession = { push: (text: string) => void; flush: () => void; stop: () => void; done: Promise<void>; };

const PLAYBACK_LEAD_SECONDS = 0.25;
const PLAYBACK_TAIL_MS = 300;
const PROVIDER_DONE_QUIET_MS = 120;
const BROWSER_BOUNDARY_FALLBACK_DELAY_MS = 450;
const ESTIMATED_CHAR_DURATION_SECONDS = 0.24;
let activeSession: XiaozhiSpeechSession | null = null;
let audioContext: AudioContext | null = null;
let voicePreference: VoicePreference = { mode: 'system', systemVoiceUri: '', providerVoiceId: '' };
let speechActive = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const activityListeners = new Set<(active: boolean) => void>();

const publishSpeechActivity = (active: boolean) => {
  if (speechActive === active) return;
  speechActive = active;
  activityListeners.forEach((listener) => listener(active));
};

const markSessionActive = () => {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  publishSpeechActivity(true);
};

const releaseActiveSession = (session: XiaozhiSpeechSession) => {
  if (activeSession !== session) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeSession !== session) return;
    activeSession = null;
    idleTimer = null;
    publishSpeechActivity(false);
  }, PLAYBACK_TAIL_MS);
};

export const isXiaozhiSpeechActive = () => speechActive;
export const subscribeXiaozhiSpeechActivity = (listener: (active: boolean) => void) => {
  activityListeners.add(listener);
  listener(speechActive);
  return () => { activityListeners.delete(listener); };
};

export const setXiaozhiVoicePreference = (preference: Partial<VoicePreference>) => {
  voicePreference = { ...voicePreference, ...preference, mode: preference.mode === 'volcengine' ? 'volcengine' : 'system' };
};
export const getXiaozhiVoicePreference = () => ({ ...voicePreference });

const getSynthesis = () => typeof window === 'undefined' ? null : window.speechSynthesis;
const getAudioContext = () => {
  const Api = window.AudioContext || (window as any).webkitAudioContext;
  if (!Api) return null;
  if (!audioContext || audioContext.state === 'closed') audioContext = new Api();
  return audioContext;
};
const socketUrl = () => {
  const env = (import.meta as any).env || {};
  if (env.VITE_VOLC_TTS_WS_ENDPOINT) return env.VITE_VOLC_TTS_WS_ENDPOINT;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/tts`;
};
const browserVoice = () => {
  const synthesis = getSynthesis();
  if (!synthesis?.getVoices) return null;
  const voices = synthesis.getVoices();
  const uri = voicePreference.systemVoiceUri;
  if (uri) {
    const matched = voices.find((voice) => voice.voiceURI === uri);
    if (matched) return matched;
  }
  const zhVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith('zh-cn'));
  if (zhVoices.length === 0) return null;
  const natural = zhVoices.find((voice) => /natural|online|huiyu|xiaoxiao|yunxi/i.test(voice.name));
  if (natural) return natural;
  const female = zhVoices.find((voice) => /female|女|hui|xiao|ya|ting/i.test(voice.name));
  return female || zhVoices[0] || null;
};

/** Convert elapsed (played) audio time into a safe character offset for TTS providers without word marks. */
export const estimateNarrationCharIndex = (elapsedSeconds: number, totalSeconds: number, textLength: number) => {
  if (textLength <= 0 || totalSeconds <= 0 || elapsedSeconds <= 0) return 0;
  return Math.min(textLength - 1, Math.max(0, Math.floor((elapsedSeconds / totalSeconds) * textLength)));
};

const estimateNarrationDuration = (text: string) => Math.max(
  0.8,
  [...text].filter((character) => !/\s/.test(character)).length * ESTIMATED_CHAR_DURATION_SECONDS,
);

type NarrationSegment = { text: string; start: number };

class BrowserSpeechSession implements XiaozhiSpeechSession {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private buffer = '';
  private fullText = '';
  private nextSegmentSearchIndex = 0;
  private queue: NarrationSegment[] = [];
  private speaking = false;
  private stopped = false;
  private flushed = false;
  private started = false;
  private finished = false;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private clearCurrentProgressTimers: () => void = () => undefined;
  private options: SpeakOptions;
  constructor(options: SpeakOptions) { this.options = options; this.done = new Promise((resolve) => { this.resolveDone = resolve; }); }
  push = (text: string) => {
    if (this.stopped || this.flushed) return;
    const value = String(text || '');
    this.fullText += value;
    this.buffer += value;
    const segments = extractSpeechSegments(this.buffer);
    this.buffer = segments.remainder;
    this.queue.push(...segments.segments.map((segment) => this.createSegment(segment)));
    this.pump();
  };
  flush = () => {
    if (this.stopped || this.flushed) return;
    this.flushed = true;
    this.queue.push(...extractSpeechSegments(this.buffer, true).segments.map((segment) => this.createSegment(segment)));
    this.buffer = '';
    this.pump();
    this.maybeDone();
  };
  private createSegment = (text: string): NarrationSegment => {
    const foundAt = this.fullText.indexOf(text, this.nextSegmentSearchIndex);
    const start = foundAt >= 0 ? foundAt : this.nextSegmentSearchIndex;
    this.nextSegmentSearchIndex = start + text.length;
    return { text, start };
  };
  private emitProgress = (charIndex: number, source: SpeechProgress['source']) => {
    if (this.stopped || this.finished) return;
    this.options.onProgress?.({ charIndex: Math.max(0, charIndex), source });
  };
  stop = () => { if (!this.stopped) { this.stopped = true; this.clearCurrentProgressTimers(); this.currentUtterance = null; if (this.completionTimer) clearTimeout(this.completionTimer); getSynthesis()?.cancel(); this.finish(); } };
  private markStarted = () => { if (!this.started && !this.stopped) { this.started = true; this.options.onStart?.(); } };
  private finish = () => { if (!this.finished) { this.finished = true; if (!this.stopped) this.options.onEnd?.(); this.resolveDone(); releaseActiveSession(this); } };
  private maybeDone = () => {
    if (!this.flushed || this.speaking || this.queue.length > 0 || this.stopped || this.finished) return;
    const synthesis = getSynthesis();
    if (synthesis?.speaking || synthesis?.pending) {
      if (this.completionTimer) clearTimeout(this.completionTimer);
      this.completionTimer = setTimeout(this.maybeDone, 50);
      return;
    }
    this.finish();
  };
  private pump = () => {
    if (this.speaking || this.stopped || this.finished) return;
    const segment = this.queue.shift();
    if (!segment) return this.maybeDone();
    const synthesis = getSynthesis();
    if (!synthesis || !window.SpeechSynthesisUtterance) { this.options.onError?.(new Error('当前浏览器不支持语音播报')); return this.finish(); }
    const utterance = new window.SpeechSynthesisUtterance(segment.text);
    // Retain the utterance until completion, including Chrome's asynchronous callbacks.
    this.currentUtterance = utterance;
    utterance.lang = 'zh-CN'; utterance.rate = 1.1; utterance.pitch = 1.15; utterance.volume = 1;
    const selectedVoice = browserVoice(); if (selectedVoice) utterance.voice = selectedVoice;
    this.speaking = true;
    let boundaryReceived = false;
    let fallbackDelayTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackProgressTimer: ReturnType<typeof setInterval> | null = null;
    let stuckTimer: ReturnType<typeof setTimeout> | null = null;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const clearProgressTimers = () => {
      if (fallbackDelayTimer) clearTimeout(fallbackDelayTimer);
      if (fallbackProgressTimer) clearInterval(fallbackProgressTimer);
      if (stuckTimer) clearTimeout(stuckTimer);
      if (startTimer) clearTimeout(startTimer);
      fallbackDelayTimer = null;
      fallbackProgressTimer = null;
      stuckTimer = null;
      startTimer = null;
    };
    this.clearCurrentProgressTimers = clearProgressTimers;
    const startFallbackProgress = () => {
      if (boundaryReceived || this.stopped || !this.speaking || fallbackProgressTimer) return;
      const startedAt = Date.now();
      const durationMs = estimateNarrationDuration(segment.text) * 1000;
      const emitEstimate = () => {
        const localIndex = estimateNarrationCharIndex((Date.now() - startedAt) / 1000, durationMs / 1000, segment.text.length);
        this.emitProgress(segment.start + localIndex, 'estimated');
      };
      emitEstimate();
      fallbackProgressTimer = setInterval(emitEstimate, 100);
    };
    utterance.onstart = () => {
      if (this.currentUtterance !== utterance || this.stopped) return;
      if (startTimer) clearTimeout(startTimer);
      startTimer = null;
      this.markStarted();
      this.emitProgress(segment.start, 'estimated');
      fallbackDelayTimer = setTimeout(startFallbackProgress, BROWSER_BOUNDARY_FALLBACK_DELAY_MS);
      const estimatedMs = estimateNarrationDuration(segment.text) * 1000;
      stuckTimer = setTimeout(() => {
        if (!this.speaking || this.stopped) return;
        clearProgressTimers();
        this.currentUtterance = null;
        utterance.onend = null;
        utterance.onerror = null;
        try { getSynthesis()?.cancel(); } catch { /* synthesis may already be gone */ }
        this.speaking = false;
        this.pump();
      }, estimatedMs * 2 + 3000);
    };
    utterance.onboundary = (event) => {
      if (this.stopped || this.currentUtterance !== utterance) return;
      boundaryReceived = true;
      if (fallbackDelayTimer) clearTimeout(fallbackDelayTimer);
      if (fallbackProgressTimer) clearInterval(fallbackProgressTimer);
      fallbackDelayTimer = null;
      fallbackProgressTimer = null;
      this.emitProgress(segment.start + Math.min(segment.text.length - 1, Math.max(0, event.charIndex)), 'boundary');
    };
    utterance.onend = () => {
      if (this.currentUtterance !== utterance || this.stopped) return;
      this.currentUtterance = null;
      clearProgressTimers();
      this.clearCurrentProgressTimers = () => undefined;
      this.emitProgress(segment.start + Math.max(0, segment.text.length - 1), boundaryReceived ? 'boundary' : 'estimated');
      this.speaking = false;
      this.pump();
    };
    const failPlayback = (message: string) => {
      if (this.currentUtterance !== utterance || this.stopped) return;
      this.currentUtterance = null;
      clearProgressTimers();
      this.clearCurrentProgressTimers = () => undefined;
      this.speaking = false;
      this.queue = [];
      try { synthesis.cancel(); } catch { /* browser already released playback */ }
      this.options.onError?.(new Error(message));
      this.finish();
    };
    utterance.onerror = (event) => failPlayback(event.error === 'not-allowed'
      ? '浏览器阻止了语音播放，请点击页面中的语音按钮后重试'
      : '浏览器语音播报失败，请检查系统中文语音或更换音色');
    startTimer = setTimeout(() => failPlayback('语音播放启动超时，请检查浏览器声音权限和中文音色'), 10000);
    try {
      if (synthesis.paused) synthesis.resume();
      synthesis.speak(utterance);
    } catch (error) {
      failPlayback(error instanceof Error ? error.message : '浏览器语音播报启动失败');
    }
  };
}

class VolcSpeechSession implements XiaozhiSpeechSession {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private socket: WebSocket | null = null;
  private queued: string[] = [];
  private textBuffer = '';
  private fullText = '';
  private providerReady = false;
  private flushed = false;
  private stopped = false;
  private started = false;
  private finished = false;
  private providerDone = false;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private audioSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackTime = 0;
  private playbackStartTime = 0;
  private playbackProgressTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressCharIndex = -1;
  private sampleRate = 24000;
  private pendingPcmByte: number | null = null;
  private fallback: BrowserSpeechSession | null = null;
  private options: SpeakOptions;
  constructor(options: SpeakOptions) {
    this.options = options;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.connect();
  }
  push = (text: string) => {
    if (this.stopped || this.flushed) return;
    const value = String(text || ''); if (!value) return;
    this.fullText += value;
    this.textBuffer += value;
    const segments = extractSpeechSegments(this.textBuffer);
    this.textBuffer = segments.remainder;
    segments.segments.forEach(this.enqueueText);
  };
  flush = () => {
    if (this.stopped || this.flushed) return;
    this.flushed = true;
    const segments = extractSpeechSegments(this.textBuffer, true);
    this.textBuffer = '';
    segments.segments.forEach(this.enqueueText);
    this.sendFinish();
  };
  stop = () => {
    if (this.stopped) return;
    this.stopped = true;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.stopPlaybackProgress();
    this.pendingPcmByte = null;
    try { this.socket?.send(JSON.stringify({ type: 'cancel' })); } catch { /* socket closed */ }
    this.socket?.close();
    this.audioSources.forEach((source) => { try { source.stop(); } catch { /* already stopped */ } });
    this.audioSources.clear(); this.fallback?.stop(); this.finish();
  };
  private connect() {
    try {
      const socket = new WebSocket(socketUrl()); this.socket = socket; socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(JSON.stringify({ type: 'start', speaker: voicePreference.providerVoiceId }));
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => this.fail(new Error('豆包真人音色连接失败'));
      socket.onclose = () => {
        // The proxy closes the browser socket after sending `done`, while PCM
        // buffers may still be playing. That is a successful provider finish,
        // not a transport failure and must not trigger fallback/error handling.
        if (!this.finished && !this.stopped && this.flushed && !this.providerDone) {
          this.fail(new Error('豆包真人音色连接已关闭'));
        }
      };
    } catch (error) { this.fail(error instanceof Error ? error : new Error('无法创建豆包语音连接')); }
  }
  private handleMessage(data: unknown) {
    if (typeof data === 'string') {
      let message: any; try { message = JSON.parse(data); } catch { return this.fail(new Error('豆包语音响应无效')); }
      if (message.type === 'ready') {
        this.providerReady = true;
        this.sampleRate = Number(message.sampleRate) || 24000;
        this.queued.splice(0).forEach(this.sendText);
        this.sendFinish();
      } else if (message.type === 'done') {
        this.providerDone = true;
        this.emitPlaybackProgress();
        this.scheduleCompletionCheck();
      }
      else if (message.type === 'error') this.fail(new Error(message.message || '豆包语音合成失败'));
      return;
    }
    if (data instanceof ArrayBuffer) this.schedulePcm(new Uint8Array(data));
  }
  private enqueueText = (text: string) => {
    const value = text.trim();
    if (!value) return;
    if (this.providerReady) this.sendText(value);
    else this.queued.push(value);
  };
  private sendText = (text: string) => {
    if (!this.providerReady || this.socket?.readyState !== WebSocket.OPEN) {
      this.queued.push(text);
      return;
    }
    this.socket.send(JSON.stringify({ type: 'text', text }));
  };
  private sendFinish = () => {
    if (this.flushed && this.providerReady && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'finish' }));
    }
  };
  private schedulePcm(bytes: Uint8Array) {
    const context = getAudioContext();
    if (!context || bytes.length === 0 || this.stopped || this.finished) return this.fail(new Error('当前浏览器无法播放真人音色'));
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null; }
    let pcm = bytes;
    if (this.pendingPcmByte !== null) {
      pcm = new Uint8Array(bytes.length + 1);
      pcm[0] = this.pendingPcmByte;
      pcm.set(bytes, 1);
      this.pendingPcmByte = null;
    }
    if (pcm.length % 2 !== 0) {
      this.pendingPcmByte = pcm[pcm.length - 1];
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length === 0) return;
    const frameCount = pcm.length / 2; const buffer = context.createBuffer(1, frameCount, this.sampleRate);
    const samples = buffer.getChannelData(0); const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < frameCount; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    void context.resume(); const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    const startAt = Math.max(this.nextPlaybackTime, context.currentTime + PLAYBACK_LEAD_SECONDS);
    if (!this.playbackStartTime) this.playbackStartTime = startAt;
    this.nextPlaybackTime = startAt + buffer.duration;
    this.audioSources.add(source); source.onended = () => { this.audioSources.delete(source); this.scheduleCompletionCheck(); }; source.start(startAt);
    if (!this.started) { this.started = true; this.options.onStart?.(); }
    this.startPlaybackProgress();
  }
  private emitPlaybackProgress = () => {
    const context = getAudioContext();
    if (!context || !this.playbackStartTime || !this.fullText || this.stopped || this.finished) return;
    const elapsed = Math.max(0, Math.min(context.currentTime - this.playbackStartTime, this.nextPlaybackTime - this.playbackStartTime));
    const actualDuration = Math.max(0, this.nextPlaybackTime - this.playbackStartTime);
    const totalDuration = this.providerDone
      ? actualDuration
      : Math.max(actualDuration, estimateNarrationDuration(this.fullText));
    const charIndex = estimateNarrationCharIndex(elapsed, totalDuration, this.fullText.length);
    if (charIndex <= this.lastProgressCharIndex) return;
    this.lastProgressCharIndex = charIndex;
    this.options.onProgress?.({ charIndex, source: 'estimated' });
  };
  private startPlaybackProgress = () => {
    this.emitPlaybackProgress();
    if (this.playbackProgressTimer) return;
    this.playbackProgressTimer = setInterval(this.emitPlaybackProgress, 100);
  };
  private stopPlaybackProgress = () => {
    if (this.playbackProgressTimer) clearInterval(this.playbackProgressTimer);
    this.playbackProgressTimer = null;
  };
  private fail(error: Error) {
    if (this.stopped || this.finished || this.fallback) return;
    if (!this.started && this.fullText) {
      this.socket?.close(); this.fallback = new BrowserSpeechSession(this.options); this.fullText && this.fallback.push(this.fullText); if (this.flushed) this.fallback.flush(); this.fallback.done.finally(() => this.finish()); return;
    }
    this.options.onError?.(error);
    // No more provider audio will arrive, but buffers already scheduled on the
    // AudioContext may still be audible. Keep the global speech lock until all
    // of those sources have actually ended.
    this.providerDone = true;
    this.flushed = true;
    this.scheduleCompletionCheck();
  }
  private scheduleCompletionCheck = () => {
    if (!this.providerDone || !this.flushed || this.audioSources.size > 0 || this.stopped || this.finished) return;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.providerDone && this.audioSources.size === 0) this.finish();
    }, PROVIDER_DONE_QUIET_MS);
  };
  private finish = () => { if (!this.finished) { this.finished = true; if (this.completionTimer) clearTimeout(this.completionTimer); this.stopPlaybackProgress(); if (!this.stopped && !this.fallback) this.options.onEnd?.(); this.resolveDone(); releaseActiveSession(this); } };
}

export const createXiaozhiSpeechSession = (options: SpeakOptions = {}): XiaozhiSpeechSession => {
  const session = voicePreference.mode === 'volcengine' && voicePreference.providerVoiceId ? new VolcSpeechSession(options) : new BrowserSpeechSession(options);
  const previousSession = activeSession;
  activeSession = session;
  markSessionActive();
  previousSession?.stop();
  return session;
};
export const stopXiaozhiSpeech = () => {
  activeSession?.stop();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  activeSession = null;
  publishSpeechActivity(false);
};
export const prepareXiaozhiSpeech = () => { const context = getAudioContext(); if (context?.state === 'suspended') void context.resume(); };
export const speakXiaozhi = (text: string, options: SpeakOptions = {}) => { const session = createXiaozhiSpeechSession(options); session.push(String(text || '').trim()); session.flush(); return session.done; };
