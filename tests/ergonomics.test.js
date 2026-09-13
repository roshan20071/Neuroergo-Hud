import { describe, it, expect, beforeEach } from 'vitest';
import { PersistenceDebouncer, ErgonomicsEngine } from '../src/engine/ergonomicsEngine.js';

describe('PersistenceDebouncer', () => {
  let debouncer;
  beforeEach(() => {
    debouncer = new PersistenceDebouncer(3000);
  });

  it('stays NORMAL while the condition is false', () => {
    expect(debouncer.update(false, 0).state).toBe('NORMAL');
    expect(debouncer.update(false, 1000).state).toBe('NORMAL');
  });

  it('enters PENDING immediately when the condition becomes true, without alerting yet', () => {
    const result = debouncer.update(true, 0);
    expect(result.state).toBe('PENDING');
  });

  it('does not alert for a violation shorter than the threshold', () => {
    debouncer.update(true, 0);
    const result = debouncer.update(true, 2999);
    expect(result.state).toBe('PENDING');
  });

  it('transitions to ALERT once the condition has persisted for >= the threshold, per the spec (3s)', () => {
    debouncer.update(true, 0);
    const result = debouncer.update(true, 3000);
    expect(result.state).toBe('ALERT');
    expect(result.justTriggered).toBe(true);
  });

  it('only reports justTriggered on the single frame it crosses into ALERT', () => {
    debouncer.update(true, 0);
    debouncer.update(true, 3000);
    const again = debouncer.update(true, 3500);
    expect(again.state).toBe('ALERT');
    expect(again.justTriggered).toBe(false);
  });

  it('resets to NORMAL the instant the condition clears, even mid-PENDING', () => {
    debouncer.update(true, 0);
    debouncer.update(true, 1500);
    const cleared = debouncer.update(false, 1600);
    expect(cleared.state).toBe('NORMAL');
  });

  it('requires a fresh full threshold duration after a reset before alerting again', () => {
    debouncer.update(true, 0);
    debouncer.update(true, 3000); // ALERT
    debouncer.update(false, 3100); // cleared
    const result = debouncer.update(true, 3200); // condition returns
    expect(result.state).toBe('PENDING');
  });
});

describe('ErgonomicsEngine', () => {
  const OPEN_EYE = [
    { x: 0, y: 0 },
    { x: 0.08, y: -0.05 },
    { x: 0.2, y: -0.05 },
    { x: 0.3, y: 0 },
    { x: 0.2, y: 0.05 },
    { x: 0.08, y: 0.05 },
  ];
  const CLOSED_EYE = [
    { x: 0, y: 0 },
    { x: 0.08, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0.3, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0.08, y: 0 },
  ];
  const NEUTRAL_HEAD_POSE = { pitch: 0, yaw: 0, roll: 0 };

  function frame({ eye = OPEN_EYE, headPose = NEUTRAL_HEAD_POSE, timestampMs = 0 } = {}) {
    return {
      leftEyePoints: eye,
      rightEyePoints: eye,
      leftPupil: { x: 0.4, y: 0.45 },
      rightPupil: { x: 0.46, y: 0.45 },
      headPose,
      timestampMs,
    };
  }

  it('reports no alerts for a neutral, open-eyed, well-postured frame', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    const telemetry = engine.update(frame({ timestampMs: 0 }));
    expect(telemetry.alerts).toHaveLength(0);
    expect(telemetry.eyeClosed).toBe(false);
    expect(telemetry.ear).toBeGreaterThan(0.2);
  });

  it('flags MICROSLEEP only after the eyes have been closed past the threshold duration', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    let telemetry;
    for (let t = 0; t <= 2000; t += 100) {
      telemetry = engine.update(frame({ eye: CLOSED_EYE, timestampMs: t }));
    }
    // 2000ms of continuous closure exceeds the default 1500ms microsleep threshold.
    expect(telemetry.alerts.some((a) => a.type === 'MICROSLEEP')).toBe(true);
  });

  it('does NOT flag MICROSLEEP for a brief blink well under the threshold', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    let telemetry = engine.update(frame({ eye: OPEN_EYE, timestampMs: 0 }));
    telemetry = engine.update(frame({ eye: CLOSED_EYE, timestampMs: 100 }));
    telemetry = engine.update(frame({ eye: CLOSED_EYE, timestampMs: 200 }));
    telemetry = engine.update(frame({ eye: OPEN_EYE, timestampMs: 300 }));
    expect(telemetry.alerts.some((a) => a.type === 'MICROSLEEP')).toBe(false);
  });

  it('counts a short eye closure as a blink and reflects it in blinkRatePerMin and blinkCount', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    engine.update(frame({ eye: OPEN_EYE, timestampMs: 0 }));
    engine.update(frame({ eye: CLOSED_EYE, timestampMs: 100 }));
    const telemetry = engine.update(frame({ eye: OPEN_EYE, timestampMs: 200 }));
    expect(telemetry.blinkRatePerMin).toBeGreaterThan(0);
    expect(telemetry.blinkCount).toBe(1);

    // Second blink
    engine.update(frame({ eye: CLOSED_EYE, timestampMs: 800 }));
    const t2 = engine.update(frame({ eye: OPEN_EYE, timestampMs: 950 }));
    expect(t2.blinkCount).toBe(2);
  });

  it('accurately detects blinks when landmarks have 3D z-depth offsets (MediaPipe Face Mesh simulation)', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    const OPEN_EYE_3D = OPEN_EYE.map((p, i) => ({ ...p, z: -0.01 + (i % 2) * 0.008 }));
    // When closed in real video, eyelids touch in 2D (y), but z has non-zero depth offset from corneal curvature
    const CLOSED_EYE_3D = CLOSED_EYE.map((p, i) => ({ ...p, z: -0.01 + (i % 2) * 0.012 }));

    engine.update(frame({ eye: OPEN_EYE_3D, timestampMs: 0 }));
    engine.update(frame({ eye: CLOSED_EYE_3D, timestampMs: 120 }));
    const telemetry = engine.update(frame({ eye: OPEN_EYE_3D, timestampMs: 240 }));

    expect(telemetry.blinkCount).toBe(1);
    expect(telemetry.eyeClosed).toBe(false);
  });

  it('flags FORWARD_HEAD_TILT ("text neck") only after it persists past the posture threshold', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    const slouchedPose = { pitch: 30, yaw: 0, roll: 0 };
    let telemetry = engine.update(frame({ headPose: slouchedPose, timestampMs: 0 }));
    expect(telemetry.alerts.some((a) => a.type === 'FORWARD_HEAD_TILT')).toBe(false);
    telemetry = engine.update(frame({ headPose: slouchedPose, timestampMs: 3000 }));
    expect(telemetry.alerts.some((a) => a.type === 'FORWARD_HEAD_TILT')).toBe(true);
  });

  it('flags LATERAL_HEAD_TILT when roll persists beyond the limit', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    const tiltedPose = { pitch: 0, yaw: 0, roll: 25 };
    engine.update(frame({ headPose: tiltedPose, timestampMs: 0 }));
    const telemetry = engine.update(frame({ headPose: tiltedPose, timestampMs: 3100 }));
    expect(telemetry.alerts.some((a) => a.type === 'LATERAL_HEAD_TILT')).toBe(true);
  });

  it('improves distance accuracy after calibrateDistance() is called', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    const before = engine.update(frame({ timestampMs: 0 }));
    expect(before.distanceCalibrated).toBe(false);

    // Calibrate as if the user is sitting at exactly 55cm right now with
    // this frame's IPD.
    const ipdPx = Math.hypot(0.4 - 0.46, 0.45 - 0.45) * 1280;
    engine.calibrateDistance(ipdPx, 55);

    const after = engine.update(frame({ timestampMs: 100 }));
    expect(after.distanceCalibrated).toBe(true);
    expect(after.distanceCm).toBeCloseTo(55, 3);
  });

  it('evaluates posture relative to posture baseline ("tare"), preventing false alerts from angled webcams', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    // Camera is mounted high, so neutral user looking at screen appears at pitch = 15°
    const cameraOffsetPose = { pitch: 15, yaw: 0, roll: 0 };

    // Set tare baseline to match user's seated position
    engine.setPostureBaseline(cameraOffsetPose);
    expect(engine.hasPostureBaseline).toBe(true);

    // Frame at cameraOffsetPose should now have relPitch = 0, no alert
    let telemetry = engine.update(frame({ headPose: cameraOffsetPose, timestampMs: 0 }));
    expect(telemetry.headPose.relPitch).toBeCloseTo(0, 4);
    expect(telemetry.alerts.some((a) => a.type === 'FORWARD_HEAD_TILT')).toBe(false);

    // Now slouch 25° forward from baseline (total pitch = 40°)
    const slouchedPose = { pitch: 40, yaw: 0, roll: 0 };
    engine.update(frame({ headPose: slouchedPose, timestampMs: 100 }));
    telemetry = engine.update(frame({ headPose: slouchedPose, timestampMs: 3200 }));
    expect(telemetry.headPose.relPitch).toBe(25);
    expect(telemetry.alerts.some((a) => a.type === 'FORWARD_HEAD_TILT')).toBe(true);

    // Resetting baseline clears offset
    engine.resetPostureBaseline();
    expect(engine.hasPostureBaseline).toBe(false);
  });

  it('allows rehydrating saved focal length via setCalibratedFocalLength()', () => {
    const engine = new ErgonomicsEngine({ frameWidthPx: 1280 });
    expect(engine.isCalibrated).toBe(false);

    engine.setCalibratedFocalLength(1120.5);
    expect(engine.isCalibrated).toBe(true);
    expect(engine.focalLengthPx).toBe(1120.5);
  });
});

