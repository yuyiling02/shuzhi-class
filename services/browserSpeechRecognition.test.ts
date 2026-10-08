import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserSpeechRecognition,
  BrowserSpeechRecognitionError,
  describeBrowserSpeechRecognitionError,
  isBrowserSpeechRecognitionSupported,
} from './browserSpeechRecognition.ts';

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 0;
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  startCalls = 0;
  abortCalls = 0;

  start() {
    this.startCalls += 1;
  }

  stop() {}

  abort() {
    this.abortCalls += 1;
  }

  emitStart() {
    this.onstart?.(new Event('start'));
  }

  emitResult(results: Array<{ text: string; isFinal: boolean }>) {
    const list = results.map(({ text, isFinal }) => ({
      0: { transcript: text, confidence: 1 },
      isFinal,
      length: 1,
      item(index: number) { return this[index as 0]; },
    }));
    this.onresult?.({ resultIndex: 0, results: list } as unknown as SpeechRecognitionEvent);
  }

  emitError(error: SpeechRecognitionErrorCode, message = '') {
    this.onerror?.({ error, message } as SpeechRecognitionErrorEvent);
  }

  emitEnd() {
    this.onend?.(new Event('end'));
  }
}

const createHarness = (canContinue: () => boolean = () => true) => {
  const instances: FakeRecognition[] = [];
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: BrowserSpeechRecognitionError[] = [];
  const Recognition = class extends FakeRecognition {
    constructor() {
      super();
      instances.push(this);
    }
  };
  const recognition = new BrowserSpeechRecognition({
    onPartial: (text) => partials.push(text),
    onFinal: (text) => finals.push(text),
    onError: (error) => errors.push(error),
  }, {
    getConstructor: () => Recognition as unknown as SpeechRecognitionConstructor,
    restartDelayMs: 0,
  }, canContinue);
  return { recognition, instances, partials, finals, errors };
};

const waitForTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

test('rejects insecure origins before accessing the microphone', async () => {
  const recognition = new BrowserSpeechRecognition({ onPartial() {}, onFinal() {}, onError() {} }, {
    isSecureContext: () => false,
    getConstructor: () => { throw new Error('must not access microphone'); },
  });
  await assert.rejects(recognition.start(), (error: BrowserSpeechRecognitionError) => error.code === 'insecure_context');
});

test('aborts and releases a browser that never reports startup', async () => {
  const native = new FakeRecognition();
  const recognition = new BrowserSpeechRecognition({ onPartial() {}, onFinal() {}, onError() {} }, {
    getConstructor: () => (function () { return native; }) as unknown as SpeechRecognitionConstructor,
    startTimeoutMs: 5,
  });
  await assert.rejects(recognition.start(), (error: BrowserSpeechRecognitionError) => error.code === 'start_failed');
  assert.equal(native.abortCalls, 1);
  assert.equal(recognition.currentState, 'stopped');
});

test('detects standard and prefixed Web Speech API implementations', () => {
  const Recognition = class {} as unknown as SpeechRecognitionConstructor;
  assert.equal(isBrowserSpeechRecognitionSupported({ SpeechRecognition: Recognition }), true);
  assert.equal(isBrowserSpeechRecognitionSupported({ webkitSpeechRecognition: Recognition }), true);
  assert.equal(isBrowserSpeechRecognitionSupported({}), false);
});

test('configures zh-CN recognition and emits interim and final transcripts', async () => {
  const harness = createHarness();
  const started = harness.recognition.start();
  assert.equal(harness.instances.length, 1);
  const native = harness.instances[0];
  assert.equal(native.continuous, true);
  assert.equal(native.interimResults, true);
  assert.equal(native.lang, 'zh-CN');
  assert.equal(native.maxAlternatives, 1);

  native.emitStart();
  await started;
  native.emitResult([
    { text: '放大', isFinal: false },
    { text: '停止旋转', isFinal: true },
  ]);
  assert.deepEqual(harness.partials, ['放大']);
  assert.deepEqual(harness.finals, ['停止旋转']);
  assert.equal(harness.recognition.currentState, 'active');
});

test('aborts explicitly and does not restart', async () => {
  const harness = createHarness();
  const started = harness.recognition.start();
  const native = harness.instances[0];
  native.emitStart();
  await started;

  harness.recognition.stop();
  await waitForTurn();
  assert.equal(native.abortCalls, 1);
  assert.equal(harness.instances.length, 1);
  assert.equal(harness.recognition.currentState, 'stopped');
});

test('restarts after a natural browser end while listening remains allowed', async () => {
  const harness = createHarness();
  const started = harness.recognition.start();
  harness.instances[0].emitStart();
  await started;
  harness.instances[0].emitError('no-speech');
  harness.instances[0].emitEnd();
  await waitForTurn();

  assert.equal(harness.instances.length, 2);
  harness.instances[1].emitStart();
  assert.equal(harness.recognition.currentState, 'active');
  assert.deepEqual(harness.errors, []);
});

test('does not restart when the listening guard becomes false', async () => {
  let allowed = true;
  const harness = createHarness(() => allowed);
  const started = harness.recognition.start();
  harness.instances[0].emitStart();
  await started;
  allowed = false;
  harness.instances[0].emitEnd();
  await waitForTurn();

  assert.equal(harness.instances.length, 1);
  assert.equal(harness.recognition.currentState, 'stopped');
});

test('maps permission, microphone, network, and service errors', async () => {
  const cases: Array<[SpeechRecognitionErrorCode, string]> = [
    ['not-allowed', 'microphone_denied'],
    ['audio-capture', 'microphone_unavailable'],
    ['network', 'network'],
    ['service-not-allowed', 'service_unavailable'],
  ];
  for (const [nativeError, expectedCode] of cases) {
    const harness = createHarness();
    const started = harness.recognition.start();
    harness.instances[0].emitError(nativeError);
    await assert.rejects(started, (error: BrowserSpeechRecognitionError) => error.code === expectedCode);
  }
  assert.match(
    describeBrowserSpeechRecognitionError(new BrowserSpeechRecognitionError('unsupported', 'unsupported')),
    /Chrome.*Edge/,
  );
});

test('reports a fatal runtime error after recognition has started', async () => {
  const harness = createHarness();
  const started = harness.recognition.start();
  harness.instances[0].emitStart();
  await started;
  harness.instances[0].emitError('network');

  assert.equal(harness.errors[0]?.code, 'network');
  assert.equal(harness.recognition.currentState, 'stopped');
});
