/**
 * ergonomicsEngine.js
 * ---------------------------------------------------------------------------
 * Turns per-frame geometric measurements (head pose, eye landmarks, IPD)
 * into stable, human-meaningful ergonomic state: posture alerts, blink
 * rate, micro-sleep detection, and screen-distance tracking.
 *
 * This module is pure logic -- it takes plain landmark objects and
 * timestamps in, and returns plain telemetry objects out. It has no
 * knowledge of MediaPipe, Three.js, or the DOM, which keeps it deterministic
 * and unit-testable (see tests/ergonomics.test.js).
 * ---------------------------------------------------------------------------
 */

import { calculateEAR, calibrateFocalLength, estimateDistanceCm, focalLengthFromFov } from '../math/vectorUtils.js';

/** @typedef {'NORMAL' | 'PENDING' | 'ALERT'} DebounceState */

/**
 * Generic persistence-based debouncer / state machine.
 *
 * Many ergonomic signals (bad posture, closed eyes) are noisy frame to
 * frame and should not fire an alert on a single bad sample -- a person
 * glancing down at their keyboard for a fraction of a second is not "bad
 * posture". This class requires a boolean condition to hold continuously
 * for `thresholdMs` before promoting to ALERT, and drops back to NORMAL the
 * instant the condition clears (no alert hysteresis on the way down, since
 * under-triggering resolution is safe while over-triggering it is not).
 *
 * States: NORMAL (condition false) -> PENDING (condition true, timer
 * running) -> ALERT (condition true for >= thresholdMs).
 */
export class PersistenceDebouncer {
  /** @param {number} thresholdMs how long the condition must persist before ALERT */
  constructor(thresholdMs) {
    this.thresholdMs = thresholdMs;
    /** @type {number | null} */
    this._conditionStartMs = null;
    /** @type {DebounceState} */
    this.state = 'NORMAL';
  }

  /**
   * @param {boolean} conditionActive
   * @param {number} timestampMs monotonically increasing, e.g. performance.now()
   * @returns {{state: DebounceState, activeDurationMs: number, justTriggered: boolean}}
   */
  update(conditionActive, timestampMs) {
    const wasAlert = this.state === 'ALERT';
    if (!conditionActive) {
      this._conditionStartMs = null;
      this.state = 'NORMAL';
      return { state: this.state, activeDurationMs: 0, justTriggered: false };
    }
    if (this._conditionStartMs === null) {
      this._conditionStartMs = timestampMs;
    }
    const activeDurationMs = timestampMs - this._conditionStartMs;
    this.state = activeDurationMs >= this.thresholdMs ? 'ALERT' : 'PENDING';
    return { state: this.state, activeDurationMs, justTriggered: this.state === 'ALERT' && !wasAlert };
  }

  reset() {
    this._conditionStartMs = null;
    this.state = 'NORMAL';
  }
}

// Well-known MediaPipe Face Mesh landmark indices (468-point topology) used
// throughout this engine and in main.js. Centralized here so index changes
// only need to happen in one place.
export const FACE_LANDMARKS = {
  NOSE_TIP: 1,
  CHIN: 152,
  LEFT_EAR_TRAGUS: 234,
  RIGHT_EAR_TRAGUS: 454,
  GLABELLA: 168,
  // Six-point EAR loops, ordered [p1..p6] to match calculateEAR().
  LEFT_EYE: [362, 385, 387, 263, 373, 380],
  RIGHT_EYE: [33, 160, 158, 133, 153, 144],
  LEFT_PUPIL: 468, // present only when refineLandmarks / iris model is enabled
  RIGHT_PUPIL: 473,
  LEFT_EYE_OUTER: 263,
  RIGHT_EYE_OUTER: 33,
};

const DEFAULT_OPTIONS = {
  earClosedThreshold: null, // when null, dynamically adapts from user's open-eye baseline (72%)
  blinkMaxDurationMs: 650, // closures shorter than this count as a "blink" rather than a sustained closure
  microsleepThresholdMs: 1500, // sustained closure beyond this is flagged as a micro-sleep event
  postureThresholdMs: 3000, // posture violation must persist this long before alerting (per spec)
  pitchDownLimitDeg: 20, // sustained forward head tilt beyond this is treated as "text neck"
  rollLimitDeg: 15, // sustained lateral head tilt beyond this is flagged
  minHealthyDistanceCm: 40, // screens closer than this sustained trigger a "too close" alert
  maxHealthyDistanceCm: 90, // screens farther than this may indicate slouching back / squinting
  blinkWindowMs: 60000, // window over which blink-rate (blinks/min) is computed
  defaultHFovDegrees: 60, // typical laptop webcam horizontal field of view, used until calibrated
};

export class ErgonomicsEngine {
  /** @param {Partial<typeof DEFAULT_OPTIONS> & {frameWidthPx?: number}} [options] */
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.frameWidthPx = options.frameWidthPx ?? 1280;

    this._focalLengthPx = focalLengthFromFov(this.frameWidthPx, this.options.defaultHFovDegrees);
    this._calibrated = false;

    this.postureBaseline = { pitch: 0, yaw: 0, roll: 0 };
    this.hasPostureBaseline = false;

    this._eyeClosedDebouncer = new PersistenceDebouncer(this.options.microsleepThresholdMs);
    this._postureDownDebouncer = new PersistenceDebouncer(this.options.postureThresholdMs);
    this._postureTiltDebouncer = new PersistenceDebouncer(this.options.postureThresholdMs);
    this._distanceCloseDebouncer = new PersistenceDebouncer(this.options.postureThresholdMs);
    this._distanceFarDebouncer = new PersistenceDebouncer(this.options.postureThresholdMs);

    /** @type {number[]} timestamps (ms) of detected blinks, pruned to blinkWindowMs */
    this._blinkTimestamps = [];
    this.totalBlinks = 0;
    this._baselineEar = 0.28;
    this._eyeWasClosed = false;
    this._eyeClosedSinceMs = null;
  }

  /**
   * Sets the user's natural seated posture as the (0, 0, 0) baseline reference.
   * Evaluates future forward/lateral tilts relative to this angle, preventing false alerts
   * when a webcam is angled above or below eye level.
   * @param {{pitch?: number, yaw?: number, roll?: number}} baseline
   */
  setPostureBaseline(baseline = {}) {
    this.postureBaseline = {
      pitch: baseline.pitch ?? 0,
      yaw: baseline.yaw ?? 0,
      roll: baseline.roll ?? 0,
    };
    this.hasPostureBaseline = true;
    this._postureDownDebouncer.reset();
    this._postureTiltDebouncer.reset();
  }

  /**
   * Clears posture baseline offset, returning to absolute camera-axis angles.
   */
  resetPostureBaseline() {
    this.postureBaseline = { pitch: 0, yaw: 0, roll: 0 };
    this.hasPostureBaseline = false;
    this._postureDownDebouncer.reset();
    this._postureTiltDebouncer.reset();
  }

  /**
   * Runs a one-time distance calibration: call while the user is seated at
   * a known, comfortable distance from the screen (e.g. arm's length,
   * ~50cm) to convert the current pixel IPD into a personal focal-length
   * estimate that is far more accurate than the default FOV-based guess.
   * @param {number} ipdPx pixel distance between pupils right now
   * @param {number} knownDistanceCm actual distance from eyes to screen right now
   */
  calibrateDistance(ipdPx, knownDistanceCm) {
    this._focalLengthPx = calibrateFocalLength(ipdPx, knownDistanceCm);
    this._calibrated = true;
    return this._focalLengthPx;
  }

  /**
   * Rehydrates a calibrated focal length (e.g. loaded from localStorage).
   * @param {number} focalLengthPx
   */
  setCalibratedFocalLength(focalLengthPx) {
    if (typeof focalLengthPx === 'number' && focalLengthPx > 0) {
      this._focalLengthPx = focalLengthPx;
      this._calibrated = true;
    }
  }

  get focalLengthPx() {
    return this._focalLengthPx;
  }

  get isCalibrated() {
    return this._calibrated;
  }

  /**
   * @private
   * @param {number} nowMs
   */
  _pruneBlinkWindow(nowMs) {
    const cutoff = nowMs - this.options.blinkWindowMs;
    while (this._blinkTimestamps.length && this._blinkTimestamps[0] < cutoff) {
      this._blinkTimestamps.shift();
    }
  }

  /**
   * Processes one frame of already-smoothed landmark data.
   *
   * @param {object} frame
   * @param {[import('../math/vectorUtils.js').Point,...]} frame.leftEyePoints 6 points, order [p1..p6]
   * @param {[import('../math/vectorUtils.js').Point,...]} frame.rightEyePoints 6 points, order [p1..p6]
   * @param {import('../math/vectorUtils.js').Point} frame.leftPupil
   * @param {import('../math/vectorUtils.js').Point} frame.rightPupil
   * @param {{pitch:number, yaw:number, roll:number}} frame.headPose degrees
   * @param {number} frame.timestampMs
   * @returns {object} telemetry snapshot, see inline fields
   */
  update({ leftEyePoints, rightEyePoints, leftPupil, rightPupil, headPose, timestampMs }) {
    this.lastPose = headPose;
    // --- Eye Aspect Ratio & blink / microsleep tracking -------------------
    const leftEAR = calculateEAR(leftEyePoints);
    const rightEAR = calculateEAR(rightEyePoints);
    const ear = (leftEAR + rightEAR) / 2;

    // Dynamic threshold: 72% of open-eye baseline, safely clamped between 0.14 and 0.28
    const dynamicThreshold = Math.max(0.14, Math.min(0.28, this._baselineEar * 0.72));
    const effectiveThreshold = this.options.earClosedThreshold ?? dynamicThreshold;

    // Adaptively track baseline open-eye EAR only when eyes are clearly open
    if (ear >= effectiveThreshold && ear > 0.15 && ear < 0.60) {
      this._baselineEar = this._baselineEar * 0.96 + ear * 0.04;
    }

    const eyeClosed = ear < effectiveThreshold;
    const microsleep = this._eyeClosedDebouncer.update(eyeClosed, timestampMs);

    if (eyeClosed && !this._eyeWasClosed) {
      this._eyeClosedSinceMs = timestampMs;
    }
    if (!eyeClosed && this._eyeWasClosed) {
      const closureDurationMs = timestampMs - (this._eyeClosedSinceMs ?? timestampMs);
      if (closureDurationMs >= 0 && closureDurationMs <= this.options.blinkMaxDurationMs) {
        this._blinkTimestamps.push(timestampMs);
        this.totalBlinks++;
      }
      this._eyeClosedSinceMs = null;
    }
    this._eyeWasClosed = eyeClosed;
    this._pruneBlinkWindow(timestampMs);
    const blinkRatePerMin = (this._blinkTimestamps.length / this.options.blinkWindowMs) * 60000;

    // --- Screen distance via IPD ------------------------------------------
    const ipdPx = Math.hypot(leftPupil.x - rightPupil.x, leftPupil.y - rightPupil.y) * this.frameWidthPx;
    const distanceCm = estimateDistanceCm(ipdPx, this._focalLengthPx);
    const distanceTooClose = this._distanceCloseDebouncer.update(
      distanceCm < this.options.minHealthyDistanceCm,
      timestampMs
    );
    const distanceTooFar = this._distanceFarDebouncer.update(
      distanceCm > this.options.maxHealthyDistanceCm,
      timestampMs
    );

    // --- Posture via head pose ----------------------------------------------
    const relPitch = headPose.pitch - this.postureBaseline.pitch;
    const relRoll = headPose.roll - this.postureBaseline.roll;
    const relYaw = headPose.yaw - this.postureBaseline.yaw;
    const isForwardTilt = relPitch > this.options.pitchDownLimitDeg;
    const isLateralTilt = Math.abs(relRoll) > this.options.rollLimitDeg;
    const postureDown = this._postureDownDebouncer.update(isForwardTilt, timestampMs);
    const postureTilt = this._postureTiltDebouncer.update(isLateralTilt, timestampMs);

    const alerts = [];
    if (microsleep.state === 'ALERT') alerts.push({ type: 'MICROSLEEP', durationMs: microsleep.activeDurationMs });
    if (postureDown.state === 'ALERT') alerts.push({ type: 'FORWARD_HEAD_TILT', durationMs: postureDown.activeDurationMs, pitch: relPitch, rawPitch: headPose.pitch });
    if (postureTilt.state === 'ALERT') alerts.push({ type: 'LATERAL_HEAD_TILT', durationMs: postureTilt.activeDurationMs, roll: relRoll, rawRoll: headPose.roll });
    if (distanceTooClose.state === 'ALERT') alerts.push({ type: 'SCREEN_TOO_CLOSE', durationMs: distanceTooClose.activeDurationMs, distanceCm });
    if (distanceTooFar.state === 'ALERT') alerts.push({ type: 'SCREEN_TOO_FAR', durationMs: distanceTooFar.activeDurationMs, distanceCm });

    return {
      timestampMs,
      ear,
      leftEAR,
      rightEAR,
      eyeClosed,
      microsleepState: microsleep.state,
      blinkCount: this.totalBlinks,
      blinkRatePerMin,
      distanceCm,
      distanceCalibrated: this._calibrated,
      headPose: {
        ...headPose,
        relPitch,
        relRoll,
        relYaw,
      },
      hasPostureBaseline: this.hasPostureBaseline,
      postureBaseline: { ...this.postureBaseline },
      postureDownState: postureDown.state,
      postureTiltState: postureTilt.state,
      alerts,
    };
  }

  reset() {
    this._blinkTimestamps = [];
    this.totalBlinks = 0;
    this._baselineEar = 0.28;
    this._eyeWasClosed = false;
    this._eyeClosedSinceMs = null;
    this._eyeClosedDebouncer.reset();
    this._postureDownDebouncer.reset();
    this._postureTiltDebouncer.reset();
    this._distanceCloseDebouncer.reset();
    this._distanceFarDebouncer.reset();
  }
}
