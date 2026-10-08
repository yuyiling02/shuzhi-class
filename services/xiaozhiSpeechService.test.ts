import test from 'node:test';
import assert from 'node:assert/strict';
import { createXiaozhiSpeechSession, estimateNarrationCharIndex, isXiaozhiSpeechActive, setXiaozhiVoicePreference, speakXiaozhi, stopXiaozhiSpeech, subscribeXiaozhiSpeechActivity } from './xiaozhiSpeechService.ts';

test('releases the speech lock when Chrome never starts playback', async (t) => {
  const originalWindow = (globalThis as any).window;
  const errors: Error[] = [];
  let ended = 0;
  let utterance: any;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  (globalThis as any).window = {
    SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], cancel() {}, speak(value: any) { utterance = value; } },
  };
  setXiaozhiVoicePreference({ mode: 'system' });
  try {
    const session = createXiaozhiSpeechSession({ onError: (error) => errors.push(error), onEnd: () => ended++ });
    session.push('这是一段用于检查浏览器语音启动超时的文本。');
    session.flush();
    t.mock.timers.tick(10000);
    await session.done;
    t.mock.timers.tick(300);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /启动超时/);
    assert.equal(isXiaozhiSpeechActive(), false);
    utterance.onstart?.();
    utterance.onend?.();
    assert.equal(ended, 1);
  } finally {
    stopXiaozhiSpeech();
    t.mock.timers.reset();
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('starts the first natural segment before the stream is flushed', async () => {
  const originalWindow = (globalThis as any).window;
  const utterances: any[] = [];
  const progress: number[] = [];

  class MockUtterance {
    text: string;
    lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
    onstart: (() => void) | null = null;
    onboundary: ((event: { charIndex: number }) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).window = {
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: (utterance: MockUtterance) => utterances.push(utterance) },
  };
  setXiaozhiVoicePreference({ mode: 'system', systemVoiceUri: '' });

  try {
    const session = createXiaozhiSpeechSession({ onProgress: ({ charIndex }) => progress.push(charIndex) });
    const firstText = '这是第一段完整的心脏模型结构讲解。';
    session.push(firstText);

    assert.equal(utterances.length, 1, 'a complete first sentence should start before flush');
    utterances[0].onstart?.();
    utterances[0].onboundary?.({ charIndex: 4 });
    session.push('这是第二段继续说明模型结构和功能。');
    assert.equal(utterances.length, 1, 'the next segment should wait in the same queue while the first speaks');

    utterances[0].onend?.();
    assert.equal(utterances.length, 2);
    utterances[1].onstart?.();
    utterances[1].onboundary?.({ charIndex: 3 });
    session.flush();
    utterances[1].onend?.();
    await session.done;
    assert.equal(progress.every((offset, index) => index === 0 || offset >= progress[index - 1]), true);
    assert.equal((progress.at(-1) || 0) < firstText.length + '这是第二段继续说明模型结构和功能。'.length, true);
  } finally {
    stopXiaozhiSpeech();
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('maps browser boundary offsets from queued segments to the full narration', async () => {
  const originalWindow = (globalThis as any).window;
  const utterances: any[] = [];
  const progress: number[] = [];

  class MockUtterance {
    text: string;
    lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
    onstart: (() => void) | null = null;
    onboundary: ((event: { charIndex: number }) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).window = {
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: (utterance: MockUtterance) => utterances.push(utterance) },
  };
  setXiaozhiVoicePreference({ mode: 'system', systemVoiceUri: '' });

  try {
    const text = '第一段介绍心脏如何持续泵血并输送氧气。第二段介绍心房和心室怎样协调收缩。';
    const session = createXiaozhiSpeechSession({ onProgress: ({ charIndex }) => progress.push(charIndex) });
    session.push(text);
    session.flush();

    utterances[0].onstart?.();
    utterances[0].onboundary?.({ charIndex: 4 });
    assert.equal(progress.at(-1), 4);
    const firstSegmentLength = utterances[0].text.length;
    utterances[0].onend?.();
    utterances[1].onstart?.();
    utterances[1].onboundary?.({ charIndex: 3 });
    assert.equal(progress.at(-1), firstSegmentLength + 3);
    utterances[1].onend?.();
    await session.done;
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    stopXiaozhiSpeech();
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('keeps estimated narration progress monotonic and within the text bounds', () => {
  const offsets = [0, 0.2, 1.5, 2.4, 8].map((elapsed) => estimateNarrationCharIndex(elapsed, 2.4, 12));
  assert.deepEqual(offsets, [0, 1, 7, 11, 11]);
  assert.equal(offsets.every((offset, index) => index === 0 || offset >= offsets[index - 1]), true);
});

test('does not report a replaced session’s late browser boundaries', async () => {
  const originalWindow = (globalThis as any).window;
  const utterances: any[] = [];
  const progress: number[] = [];

  class MockUtterance {
    text: string;
    lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
    onstart: (() => void) | null = null;
    onboundary: ((event: { charIndex: number }) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).window = {
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: (utterance: MockUtterance) => utterances.push(utterance) },
  };
  setXiaozhiVoicePreference({ mode: 'system', systemVoiceUri: '' });

  try {
    const first = createXiaozhiSpeechSession({ onProgress: ({ charIndex }) => progress.push(charIndex) });
    first.push('第一段讲解会在新会话开始后被取消。');
    first.flush();
    utterances[0].onstart?.();
    createXiaozhiSpeechSession();
    const progressBeforeLateEvent = progress.length;
    utterances[0].onboundary?.({ charIndex: 5 });
    assert.equal(progress.length, progressBeforeLateEvent);
  } finally {
    stopXiaozhiSpeech();
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('uses the browser speech synthesis as the default voice', async () => {
  const originalWindow = (globalThis as any).window;
  const originalFetch = globalThis.fetch;
  const spoken: string[] = [];
  const activity: boolean[] = [];

  class MockUtterance {
    text: string;
    lang = '';
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).window = {
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: {
      cancel: () => undefined,
      getVoices: () => [{ lang: 'zh-CN', voiceURI: 'zh', name: 'Chinese' }],
      speak: (utterance: MockUtterance) => {
        spoken.push(utterance.text);
        queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); });
      },
    },
  };
  setXiaozhiVoicePreference({ mode: 'system', systemVoiceUri: '' });
  const unsubscribe = subscribeXiaozhiSpeechActivity((active) => activity.push(active));

  try {
    await speakXiaozhi('请使用系统音色播报。');
    assert.deepEqual(spoken, ['请使用系统音色播报。']);
    assert.equal(isXiaozhiSpeechActive(), true, 'output tail keeps ASR locked after utterance onend');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(isXiaozhiSpeechActive(), false);
    assert.deepEqual(activity, [false, true, false]);
  } finally {
    unsubscribe();
    stopXiaozhiSpeech();
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('keeps global speech busy when a new session replaces an old session', async () => {
  const originalWindow = (globalThis as any).window;
  const utterances: any[] = [];
  const activity: boolean[] = [];

  class MockUtterance {
    text: string;
    lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).window = {
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: {
      speaking: false,
      pending: false,
      cancel: () => undefined,
      getVoices: () => [],
      speak: (utterance: MockUtterance) => utterances.push(utterance),
    },
  };
  setXiaozhiVoicePreference({ mode: 'system', systemVoiceUri: '' });
  const unsubscribe = subscribeXiaozhiSpeechActivity((active) => activity.push(active));

  try {
    const first = speakXiaozhi('第一段播报。');
    const second = speakXiaozhi('第二段播报。');
    assert.deepEqual(activity, [false, true]);
    utterances.at(-1)?.onstart?.();
    utterances.at(-1)?.onend?.();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(activity, [false, true, false]);
  } finally {
    unsubscribe();
    stopXiaozhiSpeech();
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('treats a provider close after done as a successful Volcengine session', async () => {
  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: MockSocket[] = [];
  const fallbackUtterances: string[] = [];
  const errors: Error[] = [];
  let ended = 0;

  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    binaryType: BinaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    sent: string[] = [];
    private closed = false;
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    open() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
    message(payload: object) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'done' }));
    }
  }

  class MockUtterance {
    text: string;
    lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  (globalThis as any).WebSocket = MockSocket;
  (globalThis as any).window = {
    location: { protocol: 'https:', host: 'class.example' },
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: {
      speaking: false,
      pending: false,
      cancel: () => undefined,
      getVoices: () => [],
      speak: (utterance: MockUtterance) => {
        fallbackUtterances.push(utterance.text);
        queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); });
      },
    },
  };
  setXiaozhiVoicePreference({ mode: 'volcengine', providerVoiceId: 'voice-1' });

  try {
    const session = createXiaozhiSpeechSession({
      onEnd: () => { ended += 1; },
      onError: (error) => errors.push(error),
    });
    session.push('正常完成的真人音色播报。');
    session.flush();

    sockets[0].open();
    sockets[0].message({ type: 'ready', sampleRate: 24000 });
    sockets[0].message({ type: 'done' });
    sockets[0].close();
    await session.done;

    assert.deepEqual(errors, []);
    assert.deepEqual(fallbackUtterances, []);
    assert.equal(ended, 1);
  } finally {
    stopXiaozhiSpeech();
    setXiaozhiVoicePreference({ mode: 'system', providerVoiceId: '' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (originalWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('buffers streamed Volcengine text into natural segments until the provider is ready', async () => {
  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: MockSocket[] = [];

  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    binaryType: BinaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    sent: string[] = [];
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    open() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
    message(payload: object) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() { this.readyState = 3; }
  }

  (globalThis as any).WebSocket = MockSocket;
  (globalThis as any).window = {
    location: { protocol: 'https:', host: 'class.example' },
  };
  setXiaozhiVoicePreference({ mode: 'volcengine', providerVoiceId: 'voice-1' });

  try {
    const text = '这是一段需要聚合后再发送给真人音色的完整讲解。';
    const session = createXiaozhiSpeechSession();
    sockets[0].open();
    [...text].forEach((token) => session.push(token));
    session.flush();

    assert.deepEqual(sockets[0].sent.map((item) => JSON.parse(item).type), ['start']);

    sockets[0].message({ type: 'ready', sampleRate: 24000 });
    const messages = sockets[0].sent.map((item) => JSON.parse(item));
    assert.deepEqual(messages.map((message) => message.type), ['start', 'text', 'finish']);
    assert.equal(messages[1].text, text);

    sockets[0].message({ type: 'done' });
    await session.done;
  } finally {
    stopXiaozhiSpeech();
    setXiaozhiVoicePreference({ mode: 'system', providerVoiceId: '' });
    if (originalWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('preserves a split PCM16 sample across Volcengine audio messages', () => {
  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: MockSocket[] = [];
  const scheduledSamples: number[][] = [];

  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    binaryType: BinaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor(_url: string) { sockets.push(this); }
    send(_data: string) {}
    open() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
    message(payload: object) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    binary(bytes: number[]) { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }); }
    close() { this.readyState = 3; }
  }

  class MockAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    createBuffer(_channels: number, frameCount: number, sampleRate: number) {
      const samples = new Float32Array(frameCount);
      return { duration: frameCount / sampleRate, getChannelData: () => samples, samples };
    }
    createBufferSource() {
      const source: any = {
        buffer: null,
        onended: null,
        connect: () => undefined,
        start: () => scheduledSamples.push(Array.from(source.buffer.samples)),
        stop: () => source.onended?.(),
      };
      return source;
    }
    resume() { return Promise.resolve(); }
  }

  (globalThis as any).WebSocket = MockSocket;
  (globalThis as any).window = {
    location: { protocol: 'https:', host: 'class.example' },
    AudioContext: MockAudioContext,
  };
  setXiaozhiVoicePreference({ mode: 'volcengine', providerVoiceId: 'voice-1' });

  try {
    createXiaozhiSpeechSession();
    sockets[0].open();
    sockets[0].message({ type: 'ready', sampleRate: 24000 });
    sockets[0].binary([0x00, 0x40, 0x00]);
    sockets[0].binary([0x20, 0x00, 0x10]);

    assert.deepEqual(scheduledSamples, [[0.5], [0.25, 0.125]]);
  } finally {
    stopXiaozhiSpeech();
    setXiaozhiVoicePreference({ mode: 'system', providerVoiceId: '' });
    if (originalWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});
