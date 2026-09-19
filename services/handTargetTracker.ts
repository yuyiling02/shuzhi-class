export type TrackedHandSide = 'Left' | 'Right';
export type HandTrackingMode = 'single' | 'dual';
export type HandTrackingPhase = 'searching' | 'confirming' | 'locked' | 'partial_lost' | 'lost' | 'cooldown';

export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
}

export interface HandCandidate {
  landmarks: LandmarkLike[];
  side: TrackedHandSide;
  confidence: number;
  center: { x: number; y: number };
  area: number;
  palmWidth: number;
  shape: number[];
  /** True when this candidate is a short-lived prediction during a missed frame. */
  stale?: boolean;
  ageMs?: number;
}

interface HandTrack extends HandCandidate {
  velocity: { x: number; y: number };
  lastSeenAt: number;
}

interface HandSlots<T> {
  left: T | null;
  right: T | null;
}

export interface HandTrackingResult {
  phase: HandTrackingPhase;
  statusText: string;
  display: HandSlots<HandCandidate>;
  active: HandSlots<HandCandidate>;
  controlEnabled: boolean;
}

export interface HandTargetTrackerOptions {
  confirmationMs?: number;
  releaseMs?: number;
  cooldownMs?: number;
}

const DEFAULT_CONFIRMATION_MS = 600;
// Keep a missed camera/inference frame continuous without allowing stale input
// to drive the model indefinitely. This is separate from the UI lock phase.
const DEFAULT_RELEASE_MS = 300;
const DEFAULT_COOLDOWN_MS = 300;
const MAX_PREDICTION_MS = 300;
const MAX_CENTER_SPEED_PER_MS = 0.006;
const HANDEDNESS_MISMATCH_PENALTY = 0.5;
const PALM_POINTS = [0, 5, 9, 13, 17];
const SHAPE_POINTS = [0, 4, 5, 8, 9, 12, 13, 16, 17, 20];

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const emptySlots = <T>(): HandSlots<T> => ({ left: null, right: null });

export function describeHandCandidate(
  landmarks: LandmarkLike[],
  side: TrackedHandSide,
  confidence = 1,
): HandCandidate | null {
  if (!landmarks || landmarks.length < 21) return null;

  const xs = landmarks.map((point) => point.x);
  const ys = landmarks.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const area = Math.max(0.0001, width * height);

  const center = PALM_POINTS.reduce(
    (sum, index) => ({ x: sum.x + landmarks[index].x, y: sum.y + landmarks[index].y }),
    { x: 0, y: 0 },
  );
  center.x /= PALM_POINTS.length;
  center.y /= PALM_POINTS.length;

  const palmWidth = Math.max(0.02, distance(landmarks[5], landmarks[17]));
  const shape = SHAPE_POINTS.flatMap((index) => [
    (landmarks[index].x - center.x) / palmWidth,
    (landmarks[index].y - center.y) / palmWidth,
  ]);

  return { landmarks, side, confidence, center, area, palmWidth, shape };
}

function shapeDistance(a: number[], b: number[]) {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = a[index] - b[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum / a.length);
}

function toTrack(candidate: HandCandidate, now: number, previous?: HandTrack): HandTrack {
  const elapsed = previous ? Math.max(1, now - previous.lastSeenAt) : 1;
  const rawVelocity = previous
    ? {
        x: Math.max(-MAX_CENTER_SPEED_PER_MS, Math.min(MAX_CENTER_SPEED_PER_MS, (candidate.center.x - previous.center.x) / elapsed)),
        y: Math.max(-MAX_CENTER_SPEED_PER_MS, Math.min(MAX_CENTER_SPEED_PER_MS, (candidate.center.y - previous.center.y) / elapsed)),
      }
    : { x: 0, y: 0 };

  return {
    ...candidate,
    // Once a slot is locked, a single MediaPipe handedness flip must not move
    // the track to the opposite semantic side.  Matching already uses
    // handedness as a soft cost, so preserve the slot's established side here
    // and let the next spatially consistent frame correct the classification.
    side: previous?.side ?? candidate.side,
    velocity: previous
      ? {
          x: previous.velocity.x * 0.55 + rawVelocity.x * 0.45,
          y: previous.velocity.y * 0.55 + rawVelocity.y * 0.45,
        }
      : rawVelocity,
    lastSeenAt: now,
  };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function predictTrack(track: HandTrack, now: number): HandCandidate | null {
  const ageMs = Math.max(0, now - track.lastSeenAt);
  if (ageMs > MAX_PREDICTION_MS) return null;

  const predictionMs = Math.min(ageMs, MAX_PREDICTION_MS);
  const dx = track.velocity.x * predictionMs;
  const dy = track.velocity.y * predictionMs;
  const landmarks = track.landmarks.map((point) => ({
    ...point,
    x: clamp01(point.x + dx),
    y: clamp01(point.y + dy),
  }));

  return {
    ...track,
    landmarks,
    center: {
      x: clamp01(track.center.x + dx),
      y: clamp01(track.center.y + dy),
    },
    stale: true,
    ageMs,
  };
}

function matchCost(track: HandTrack, candidate: HandCandidate, now: number, strict: boolean) {
  const predictionMs = Math.min(160, Math.max(0, now - track.lastSeenAt));
  const predicted = {
    x: track.center.x + track.velocity.x * predictionMs,
    y: track.center.y + track.velocity.y * predictionMs,
  };
  const centerDistance = distance(predicted, candidate.center);
  const handScale = Math.sqrt(Math.max(track.area, candidate.area));
  const positionGate = strict
    ? Math.min(0.22, Math.max(0.15, handScale * 1.25))
    : Math.min(0.3, Math.max(0.14, handScale * 1.5));
  if (centerDistance > positionGate) return Number.POSITIVE_INFINITY;

  const areaRatio = candidate.area / Math.max(track.area, 0.0001);
  const minRatio = strict ? 0.45 : 0.35;
  const maxRatio = strict ? 2.2 : 2.8;
  if (areaRatio < minRatio || areaRatio > maxRatio) return Number.POSITIVE_INFINITY;

  const handShapeDistance = shapeDistance(track.shape, candidate.shape);
  const shapeGate = strict ? 1.1 : 1.5;
  if (handShapeDistance > shapeGate) return Number.POSITIVE_INFINITY;

  return (
    centerDistance / positionGate +
    Math.abs(Math.log(areaRatio)) * 0.35 +
    handShapeDistance * 0.25 +
    (candidate.side === track.side ? 0 : HANDEDNESS_MISMATCH_PENALTY)
  );
}

function bestMatch(
  track: HandTrack,
  candidates: HandCandidate[],
  now: number,
  strict: boolean,
  excluded?: HandCandidate | null,
) {
  let match: HandCandidate | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === excluded) continue;
    const cost = matchCost(track, candidate, now, strict);
    if (cost < bestCost) {
      bestCost = cost;
      match = candidate;
    }
  }
  return match;
}

function selectNearestSingle(candidates: HandCandidate[]) {
  return candidates.reduce<HandCandidate | null>((best, candidate) => {
    if (!best) return candidate;
    const candidateScore = candidate.area * (0.85 + candidate.confidence * 0.15);
    const bestScore = best.area * (0.85 + best.confidence * 0.15);
    return candidateScore > bestScore ? candidate : best;
  }, null);
}

function selectNearestPair(candidates: HandCandidate[]) {
  const leftHands = candidates.filter((candidate) => candidate.side === 'Left');
  const rightHands = candidates.filter((candidate) => candidate.side === 'Right');
  let best: { left: HandCandidate; right: HandCandidate; score: number } | null = null;

  for (const left of leftHands) {
    for (const right of rightHands) {
      const areaRatio = Math.max(left.area, right.area) / Math.max(0.0001, Math.min(left.area, right.area));
      const verticalOffset = Math.abs(left.center.y - right.center.y);
      const handDistance = distance(left.center, right.center);
      if (areaRatio > 2 || verticalOffset > 0.3 || handDistance < 0.07 || handDistance > 0.78) continue;

      const proximity = (Math.sqrt(left.area) + Math.sqrt(right.area)) / 2;
      const confidence = (left.confidence + right.confidence) / 2;
      const score =
        proximity * 4.2 +
        confidence * 0.04 -
        Math.abs(Math.log(areaRatio)) * 0.24 -
        verticalOffset * 0.45 -
        Math.abs(handDistance - 0.34) * 0.08;

      if (!best || score > best.score) best = { left, right, score };
    }
  }

  return best;
}

function statusTextForPhase(phase: HandTrackingPhase, mode: HandTrackingMode) {
  if (phase === 'confirming') return '正在确认操作者';
  if (phase === 'locked') return mode === 'dual' ? '双手已锁定' : '操作者已锁定';
  if (phase === 'partial_lost' || phase === 'lost') return '等待锁定手返回';
  if (phase === 'cooldown') return '正在重新搜索';
  return mode === 'dual' ? '请将双手置于画面中' : '请将手置于画面中';
}

export class HandTargetTracker {
  private readonly confirmationMs: number;
  private readonly releaseMs: number;
  private readonly cooldownMs: number;
  private mode: HandTrackingMode = 'dual';
  private phase: HandTrackingPhase = 'searching';
  private tracks: HandSlots<HandTrack> = emptySlots();
  private confirmationStartedAt = 0;
  private bothMissingSince: number | null = null;
  private cooldownUntil = 0;

  constructor(options: HandTargetTrackerOptions = {}) {
    this.confirmationMs = options.confirmationMs ?? DEFAULT_CONFIRMATION_MS;
    this.releaseMs = options.releaseMs ?? DEFAULT_RELEASE_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  reset(mode: HandTrackingMode = this.mode) {
    this.mode = mode;
    this.phase = 'searching';
    this.tracks = emptySlots();
    this.confirmationStartedAt = 0;
    this.bothMissingSince = null;
    this.cooldownUntil = 0;
  }

  private beginConfirmation(candidates: HandCandidate[], now: number) {
    if (this.mode === 'single') {
      const selected = selectNearestSingle(candidates);
      if (!selected) return false;
      this.tracks = selected.side === 'Left'
        ? { left: toTrack(selected, now), right: null }
        : { left: null, right: toTrack(selected, now) };
    } else {
      const selected = selectNearestPair(candidates);
      if (!selected) return false;
      this.tracks = {
        left: toTrack(selected.left, now),
        right: toTrack(selected.right, now),
      };
    }
    this.phase = 'confirming';
    this.confirmationStartedAt = now;
    return true;
  }

  private updateConfirmation(candidates: HandCandidate[], now: number) {
    const leftMatch = this.tracks.left ? bestMatch(this.tracks.left, candidates, now, true) : null;
    const rightMatch = this.tracks.right ? bestMatch(this.tracks.right, candidates, now, true, leftMatch) : null;
    const hasRequiredHands = this.mode === 'dual'
      ? Boolean(leftMatch && rightMatch)
      : Boolean(leftMatch || rightMatch);

    if (!hasRequiredHands) {
      this.phase = 'searching';
      this.tracks = emptySlots();
      this.beginConfirmation(candidates, now);
      return;
    }

    if (leftMatch && this.tracks.left) this.tracks.left = toTrack(leftMatch, now, this.tracks.left);
    if (rightMatch && this.tracks.right) this.tracks.right = toTrack(rightMatch, now, this.tracks.right);
    if (now - this.confirmationStartedAt >= this.confirmationMs) this.phase = 'locked';
  }

  private updateLocked(candidates: HandCandidate[], now: number) {
    const leftMatch = this.tracks.left ? bestMatch(this.tracks.left, candidates, now, false) : null;
    const rightMatch = this.tracks.right ? bestMatch(this.tracks.right, candidates, now, false, leftMatch) : null;

    if (leftMatch && this.tracks.left) this.tracks.left = toTrack(leftMatch, now, this.tracks.left);
    if (rightMatch && this.tracks.right) this.tracks.right = toTrack(rightMatch, now, this.tracks.right);

    const visibleCount = Number(Boolean(leftMatch)) + Number(Boolean(rightMatch));
    const expectedCount = Number(Boolean(this.tracks.left)) + Number(Boolean(this.tracks.right));

    // Preserve the last known pose for a short gap. Returning these predicted
    // candidates keeps pinch/drag and camera motion continuous across an
    // occasional dropped inference frame; callers can inspect `stale` when
    // they need to attenuate movement while waiting for a fresh result.
    // Return the updated track rather than the raw detector candidate.  Apart
    // from carrying velocity metadata, this preserves the slot's established
    // handedness when a single frame is mislabeled by MediaPipe.
    const leftActive = leftMatch && this.tracks.left
      ? this.tracks.left
      : (this.tracks.left ? predictTrack(this.tracks.left, now) : null);
    const rightActive = rightMatch && this.tracks.right
      ? this.tracks.right
      : (this.tracks.right ? predictTrack(this.tracks.right, now) : null);

    if (visibleCount === expectedCount) {
      this.phase = 'locked';
      this.bothMissingSince = null;
      return { leftMatch: leftActive, rightMatch: rightActive };
    }

    if (visibleCount > 0) {
      this.phase = 'partial_lost';
      this.bothMissingSince = null;
      return { leftMatch: leftActive, rightMatch: rightActive };
    }

    this.phase = 'lost';
    this.bothMissingSince ??= now;
    if (!leftActive && !rightActive || now - this.bothMissingSince >= this.releaseMs) {
      this.phase = 'cooldown';
      this.cooldownUntil = now + this.cooldownMs;
      this.tracks = emptySlots();
      this.bothMissingSince = null;
      return { leftMatch: null, rightMatch: null };
    }
    return { leftMatch: leftActive, rightMatch: rightActive };
  }

  update(candidates: HandCandidate[], now: number, mode: HandTrackingMode): HandTrackingResult {
    if (mode !== this.mode) this.reset(mode);

    if (this.phase === 'cooldown') {
      if (now >= this.cooldownUntil) this.phase = 'searching';
    }

    if (this.phase === 'searching') this.beginConfirmation(candidates, now);
    else if (this.phase === 'confirming') this.updateConfirmation(candidates, now);

    let active = emptySlots<HandCandidate>();
    if (this.phase === 'locked' || this.phase === 'partial_lost' || this.phase === 'lost') {
      const matches = this.updateLocked(candidates, now);
      active = { left: matches.leftMatch, right: matches.rightMatch };
    }

    const display = this.phase === 'confirming'
      ? {
          left: this.tracks.left as HandCandidate | null,
          right: this.tracks.right as HandCandidate | null,
        }
      : active;

    return {
      phase: this.phase,
      statusText: statusTextForPhase(this.phase, this.mode),
      display,
      active,
      controlEnabled: Boolean(active.left || active.right),
    };
  }
}
