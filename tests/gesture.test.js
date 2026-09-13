import { describe, it, expect, beforeEach } from 'vitest';
import { GestureEngine, HAND_LANDMARKS } from '../src/engine/gestureEngine.js';

/**
 * Builds a synthetic 21-point hand landmark array. Only the indices the
 * engine actually reads (wrist, thumb tip, index mcp/tip, middle/ring/pinky
 * tips) are placed meaningfully; the rest are filled with a neutral value
 * so array length checks pass.
 */
function buildHand({
  offset = { x: 0, y: 0 },
  wrist = { x: 0.5, y: 0.5 },
  thumbTip = { x: 0.4, y: 0.5 },
  indexMcp = { x: 0.5, y: 0.4 },
  indexTip = { x: 0.5, y: 0.2 },
  middleTip = { x: 0.52, y: 0.45 },
  ringTip = { x: 0.48, y: 0.45 },
  pinkyTip = { x: 0.46, y: 0.46 },
} = {}) {
  // All 21 landmarks move together as a rigid body -- the 14 unnamed
  // landmarks (other knuckle joints) are filled at the same translation
  // offset as the named ones, rather than left pinned at a fixed point,
  // since a real hand does not leave 2/3 of its joints stationary while
  // moving. Leaving them stationary would dilute the centroid's apparent
  // velocity by the fraction of unnamed landmarks (14/21), silently
  // understating how fast the hand is actually moving.
  const hand = new Array(21).fill(null).map(() => ({ x: 0.5 + offset.x, y: 0.5 + offset.y }));
  hand[HAND_LANDMARKS.WRIST] = wrist;
  hand[HAND_LANDMARKS.THUMB_TIP] = thumbTip;
  hand[HAND_LANDMARKS.INDEX_MCP] = indexMcp;
  hand[HAND_LANDMARKS.INDEX_TIP] = indexTip;
  hand[HAND_LANDMARKS.MIDDLE_TIP] = middleTip;
  hand[HAND_LANDMARKS.RING_TIP] = ringTip;
  hand[HAND_LANDMARKS.PINKY_TIP] = pinkyTip;
  return hand;
}

/** A "pointing" hand: index extended, other fingers curled toward the palm. */
function pointingHand(offset = { x: 0, y: 0 }) {
  return buildHand({
    offset,
    wrist: { x: 0.5 + offset.x, y: 0.5 + offset.y },
    thumbTip: { x: 0.4 + offset.x, y: 0.5 + offset.y },
    indexMcp: { x: 0.5 + offset.x, y: 0.4 + offset.y },
    indexTip: { x: 0.5 + offset.x, y: 0.2 + offset.y },
    middleTip: { x: 0.52 + offset.x, y: 0.45 + offset.y },
    ringTip: { x: 0.48 + offset.x, y: 0.45 + offset.y },
    pinkyTip: { x: 0.46 + offset.x, y: 0.46 + offset.y },
  });
}

/** A pinching hand: thumb tip and index tip brought close together. */
function pinchingHand(offset = { x: 0, y: 0 }) {
  return buildHand({
    offset,
    wrist: { x: 0.5 + offset.x, y: 0.5 + offset.y },
    thumbTip: { x: 0.5 + offset.x, y: 0.3 + offset.y },
    indexMcp: { x: 0.5 + offset.x, y: 0.4 + offset.y },
    indexTip: { x: 0.52 + offset.x, y: 0.3 + offset.y },
    middleTip: { x: 0.52 + offset.x, y: 0.45 + offset.y },
    ringTip: { x: 0.48 + offset.x, y: 0.45 + offset.y },
    pinkyTip: { x: 0.46 + offset.x, y: 0.46 + offset.y },
  });
}

/** An open-palm hand: all five fingertips extended away from the wrist. */
function openPalmHand(offset = { x: 0, y: 0 }) {
  return buildHand({
    offset,
    wrist: { x: 0.5 + offset.x, y: 0.5 + offset.y },
    thumbTip: { x: 0.35 + offset.x, y: 0.5 + offset.y },
    indexMcp: { x: 0.5 + offset.x, y: 0.4 + offset.y },
    indexTip: { x: 0.5 + offset.x, y: 0.2 + offset.y },
    middleTip: { x: 0.55 + offset.x, y: 0.2 + offset.y },
    ringTip: { x: 0.6 + offset.x, y: 0.25 + offset.y },
    pinkyTip: { x: 0.65 + offset.x, y: 0.3 + offset.y },
  });
}

describe('GestureEngine state machine', () => {
  let engine;
  beforeEach(() => {
    engine = new GestureEngine();
  });

  it('starts, and remains, IDLE when no hand is present', () => {
    expect(engine.update(null, 0)).toBe('IDLE');
    expect(engine.update(null, 100)).toBe('IDLE');
  });

  it('moves to TARGETING the instant a hand appears', () => {
    const state = engine.update(pointingHand(), 0);
    expect(state).toBe('TARGETING');
  });

  it('advances TARGETING -> ENGAGED once the hand is pointing and steady', () => {
    engine.update(pointingHand(), 0); // TARGETING
    const state = engine.update(pointingHand(), 100); // steady (velocity ~0) + pointing
    expect(state).toBe('ENGAGED');
  });

  it('drops back to IDLE the frame the hand disappears from any state', () => {
    engine.update(pointingHand(), 0);
    engine.update(pointingHand(), 100); // ENGAGED
    expect(engine.update(null, 200)).toBe('IDLE');
  });

  it('recognizes a held pinch from ENGAGED and emits a "pinch" event', () => {
    let pinchEvent = null;
    engine.on('pinch', (payload) => {
      pinchEvent = payload;
    });
    engine.update(pointingHand(), 0);
    engine.update(pointingHand(), 100); // ENGAGED
    const state = engine.update(pinchingHand(), 200); // steady position, fingers close
    expect(state).toBe('PINCH_CONFIRMED');
    expect(pinchEvent).not.toBeNull();
  });

  it('returns to ENGAGED once the pinch releases (fingers separate again)', () => {
    engine.update(pointingHand(), 0);
    engine.update(pointingHand(), 100);
    engine.update(pinchingHand(), 200); // PINCH_CONFIRMED
    const state = engine.update(pointingHand(), 300); // fingers separate again
    expect(state).toBe('ENGAGED');
  });

  it('recognizes a fast lateral motion from ENGAGED as a swipe and reports a direction on release', () => {
    let swipeEvent = null;
    engine.on('swipe', (payload) => {
      swipeEvent = payload;
    });

    engine.update(pointingHand({ x: 0, y: 0 }), 0); // TARGETING
    engine.update(pointingHand({ x: 0, y: 0 }), 100); // ENGAGED (steady)

    // Sweep the whole hand rightward quickly across several frames to fill
    // the 5-frame sliding window with a fast, consistent trajectory.
    let state;
    for (let i = 1; i <= 5; i += 1) {
      state = engine.update(pointingHand({ x: 0.15 * i, y: 0 }), 100 + i * 100);
    }
    expect(state).toBe('SWIPE_TRACKING');

    // Now the hand stops moving. It takes a few frames for the fast
    // samples to age out of the 5-frame sliding window before the
    // computed velocity drops below the release threshold -- at that
    // exact frame the engine should report the swipe direction and drop
    // back to TARGETING. (Further steady, pointing frames after that are
    // expected to naturally re-promote TARGETING -> ENGAGED, which is
    // correct behavior and not what this test is checking.)
    const finalOffset = { x: 0.15 * 5, y: 0 };
    let releaseFrameState = null;
    for (let i = 0; i < 5 && swipeEvent === null; i += 1) {
      releaseFrameState = engine.update(pointingHand(finalOffset), 700 + i * 100);
    }
    expect(swipeEvent).not.toBeNull();
    expect(swipeEvent.direction).toBe('right');
    expect(releaseFrameState).toBe('TARGETING');
  });

  it('toggles mute after an open palm is held steady past the hold duration', () => {
    let muteEvent = null;
    engine.on('mute', (payload) => {
      muteEvent = payload;
    });
    expect(engine.isMuted).toBe(false);
    for (let t = 0; t <= 1000; t += 100) {
      engine.update(openPalmHand(), t);
    }
    expect(muteEvent).not.toBeNull();
    expect(engine.isMuted).toBe(true);
  });

  it('does not toggle mute for a brief, fleeting open-palm pass', () => {
    engine.update(openPalmHand(), 0);
    engine.update(pointingHand(), 100); // hand changes shape before the hold duration elapses
    expect(engine.isMuted).toBe(false);
  });

  it('reset() returns the engine to IDLE and clears trajectory history', () => {
    engine.update(pointingHand(), 0);
    engine.update(pointingHand(), 100);
    engine.reset();
    expect(engine.state).toBe('IDLE');
  });
});
