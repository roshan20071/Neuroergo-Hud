/**
 * gestureEngine.js
 * ---------------------------------------------------------------------------
 * Touchless navigation controller driven by a single hand's 21 MediaPipe
 * Hands landmarks. Implements the explicit state machine called for in the
 * project brief:
 *
 *   IDLE -> TARGETING -> ENGAGED -> PINCH_CONFIRMED -> SWIPE_TRACKING
 *
 * with transitions driven by two independent geometric signals:
 *   - pinch distance: Euclidean distance between THUMB_TIP (#4) and
 *     INDEX_TIP (#8), gated by a velocity check so a hand merely passing
 *     through a small separation mid-swipe doesn't register as a pinch.
 *   - swipe trajectory: angle + velocity of the hand centroid across a
 *     sliding 5-frame window.
 *
 * This module is pure logic (no DOM, no MediaPipe types beyond plain
 * {x,y,z} point arrays), which keeps the state machine's transition table
 * exhaustively unit-testable (tests/gesture.test.js) independent of camera
 * or model behavior.
 * ---------------------------------------------------------------------------
 */

import { distance, magnitude, subtract } from '../math/vectorUtils.js';

/** MediaPipe Hands landmark indices used by this engine. */
export const HAND_LANDMARKS = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
};

/** @typedef {'IDLE'|'TARGETING'|'ENGAGED'|'PINCH_CONFIRMED'|'SWIPE_TRACKING'} GestureState */

const DEFAULT_OPTIONS = {
  pinchDistanceThreshold: 0.06, // normalized-coordinate distance below which thumb+index count as pinching
  pinchMaxVelocity: 0.9, // pinch must be a deliberate hold, not a fast pass-through (units/sec)
  steadyVelocityThreshold: 0.35, // below this centroid velocity, the hand counts as "steady" (units/sec)
  swipeVelocityThreshold: 1.1, // above this centroid velocity, a swipe gesture begins (units/sec)
  swipeReleaseVelocity: 0.4, // swipe is considered finished once velocity drops back below this
  muteHoldMs: 900, // open palm must be held this long to toggle mute, to avoid accidental triggers
  historySize: 5, // sliding window size for trajectory/velocity estimation, per spec
};

/**
 * Minimal typed event emitter so callers can do
 * `gestureEngine.on('pinch', handler)` without pulling in Node's EventEmitter
 * (which is not guaranteed in a browser bundle).
 */
class SimpleEmitter {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
  }
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
    return this;
  }
  off(event, handler) {
    const list = this._listeners.get(event);
    if (!list) return this;
    this._listeners.set(event, list.filter((h) => h !== handler));
    return this;
  }
  emit(event, payload) {
    for (const handler of this._listeners.get(event) ?? []) handler(payload);
  }
}

export class GestureEngine extends SimpleEmitter {
  /** @param {Partial<typeof DEFAULT_OPTIONS>} [options] */
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    /** @type {GestureState} */
    this.state = 'IDLE';
    /** @type {{point: import('../math/vectorUtils.js').Point, timestampMs: number}[]} */
    this._history = [];
    this._openPalmSinceMs = null;
    this._muted = false;
  }

  /** @private */
  _transition(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.emit('stateChange', { from: prev, to: next });
  }

  /** @private centroid of the 21-point hand skeleton */
  _centroid(landmarks) {
    let sx = 0;
    let sy = 0;
    for (const p of landmarks) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / landmarks.length, y: sy / landmarks.length };
  }

  /** @private pushes to the sliding window and evicts old entries */
  _pushHistory(point, timestampMs) {
    this._history.push({ point, timestampMs });
    while (this._history.length > this.options.historySize) this._history.shift();
  }

  /**
   * @private
   * @returns {{velocity: number, angleDeg: number | null}} velocity in
   * normalized-units/sec computed across the oldest and newest samples in
   * the sliding window; angle is the direction of travel in degrees
   * (0 = pointing right, 90 = pointing down, image convention).
   */
  _trajectory() {
    if (this._history.length < 2) return { velocity: 0, angleDeg: null };
    const first = this._history[0];
    const last = this._history[this._history.length - 1];
    const dtSec = (last.timestampMs - first.timestampMs) / 1000;
    if (dtSec <= 0) return { velocity: 0, angleDeg: null };
    const delta = subtract(last.point, first.point);
    const velocity = magnitude(delta) / dtSec;
    const angleDeg = (Math.atan2(delta.y, delta.x) * 180) / Math.PI;
    return { velocity, angleDeg };
  }

  /** @private index finger extended, other three fingers curled toward the palm */
  _isPointing(landmarks) {
    const wrist = landmarks[HAND_LANDMARKS.WRIST];
    const indexExtended = distance(landmarks[HAND_LANDMARKS.INDEX_TIP], wrist) >
      distance(landmarks[HAND_LANDMARKS.INDEX_MCP], wrist) * 1.4;
    const othersCurled =
      distance(landmarks[HAND_LANDMARKS.MIDDLE_TIP], wrist) < distance(landmarks[HAND_LANDMARKS.INDEX_MCP], wrist) * 1.6 &&
      distance(landmarks[HAND_LANDMARKS.RING_TIP], wrist) < distance(landmarks[HAND_LANDMARKS.INDEX_MCP], wrist) * 1.6;
    return indexExtended && othersCurled;
  }

  /** @private all five fingertips extended away from the wrist -- an open palm */
  _isOpenPalm(landmarks) {
    const wrist = landmarks[HAND_LANDMARKS.WRIST];
    const refDist = distance(landmarks[HAND_LANDMARKS.INDEX_MCP], wrist);
    const tips = [HAND_LANDMARKS.THUMB_TIP, HAND_LANDMARKS.INDEX_TIP, HAND_LANDMARKS.MIDDLE_TIP, HAND_LANDMARKS.RING_TIP, HAND_LANDMARKS.PINKY_TIP];
    return tips.every((idx) => distance(landmarks[idx], wrist) > refDist * 1.3);
  }

  /**
   * @param {'left'|'right'|'up'|'down'} direction
   * @private
   */
  static _directionFromAngle(angleDeg) {
    const a = ((angleDeg % 360) + 360) % 360;
    if (a >= 315 || a < 45) return 'right';
    if (a >= 45 && a < 135) return 'down';
    if (a >= 135 && a < 225) return 'left';
    return 'up';
  }

  get isMuted() {
    return this._muted;
  }

  /**
   * Manually toggles mute, mirroring what the open-palm hold gesture does
   * internally. Exposed so a UI button can offer the same action without
   * reaching into the engine's private state.
   * @returns {boolean} the new muted state
   */
  toggleMute() {
    this._muted = !this._muted;
    this.emit('mute', { muted: this._muted });
    return this._muted;
  }

  /**
   * Advances the state machine by one frame.
   * @param {import('../math/vectorUtils.js').Point[] | null} landmarks 21-point hand skeleton, or null/undefined if no hand is currently detected
   * @param {number} timestampMs
   * @returns {GestureState}
   */
  update(landmarks, timestampMs) {
    if (!landmarks || landmarks.length < 21) {
      this._history = [];
      this._openPalmSinceMs = null;
      this._transition('IDLE');
      return this.state;
    }

    const centroid = this._centroid(landmarks);
    this._pushHistory(centroid, timestampMs);
    const { velocity, angleDeg } = this._trajectory();
    const pinchDist = distance(landmarks[HAND_LANDMARKS.THUMB_TIP], landmarks[HAND_LANDMARKS.INDEX_TIP]);
    const isPinching = pinchDist < this.options.pinchDistanceThreshold;

    // Open-palm hold toggles mute regardless of the pinch/swipe state
    // machine below, since "mute" is a modal action rather than part of the
    // targeting/engagement flow.
    if (this._isOpenPalm(landmarks) && velocity < this.options.steadyVelocityThreshold) {
      if (this._openPalmSinceMs === null) this._openPalmSinceMs = timestampMs;
      if (timestampMs - this._openPalmSinceMs >= this.options.muteHoldMs) {
        this._muted = !this._muted;
        this.emit('mute', { muted: this._muted });
        this._openPalmSinceMs = null; // require releasing and re-holding to toggle again
      }
    } else {
      this._openPalmSinceMs = null;
    }

    switch (this.state) {
      case 'IDLE': {
        this._transition('TARGETING');
        break;
      }
      case 'TARGETING': {
        if (isPinching && velocity < this.options.pinchMaxVelocity) {
          // Emit at the moment of confirmation, not one frame later, so a
          // caller's 'pinch' handler fires on the same frame the gesture
          // completes rather than trailing it by a tick.
          this.emit('pinch', { at: centroid, timestampMs });
          this._transition('PINCH_CONFIRMED');
        } else if (this._isPointing(landmarks) && velocity < this.options.steadyVelocityThreshold) {
          this._transition('ENGAGED');
        }
        break;
      }
      case 'ENGAGED': {
        if (isPinching && velocity < this.options.pinchMaxVelocity) {
          this.emit('pinch', { at: centroid, timestampMs });
          this._transition('PINCH_CONFIRMED');
        } else if (velocity > this.options.swipeVelocityThreshold) {
          this._transition('SWIPE_TRACKING');
        } else if (!this._isPointing(landmarks)) {
          this._transition('TARGETING');
        }
        break;
      }
      case 'PINCH_CONFIRMED': {
        // Debounce: stay in PINCH_CONFIRMED until the fingers actually
        // separate again, so a single held pinch doesn't fire repeatedly.
        if (!isPinching) this._transition('ENGAGED');
        break;
      }
      case 'SWIPE_TRACKING': {
        if (velocity < this.options.swipeReleaseVelocity) {
          if (angleDeg !== null) {
            this.emit('swipe', { direction: GestureEngine._directionFromAngle(angleDeg), angleDeg, velocity, timestampMs });
          }
          this._transition('TARGETING');
        }
        break;
      }
      default:
        this._transition('IDLE');
    }

    return this.state;
  }

  reset() {
    this._history = [];
    this._openPalmSinceMs = null;
    this._transition('IDLE');
  }
}
