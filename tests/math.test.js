import { describe, it, expect } from 'vitest';
import {
  calculateEAR,
  computeHeadPose,
  distance,
  cross,
  dot,
  normalize,
  estimateDistanceCm,
  calibrateFocalLength,
  focalLengthFromFov,
} from '../src/math/vectorUtils.js';

describe('vector algebra primitives', () => {
  it('computes Euclidean distance in 2D', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
  });

  it('computes Euclidean distance in 3D', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 })).toBeCloseTo(3, 10);
  });

  it('normalizes a vector to unit length', () => {
    const n = normalize({ x: 3, y: 4 });
    expect(distance(n, { x: 0, y: 0 })).toBeCloseTo(1, 10);
  });

  it('returns a zero vector when normalizing a near-zero vector, rather than NaN', () => {
    const n = normalize({ x: 0, y: 0 });
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
    expect(Number.isNaN(n.x)).toBe(false);
  });

  it('computes the dot product', () => {
    expect(dot({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    expect(dot({ x: 2, y: 3, z: 4 }, { x: 5, y: 6, z: 7 })).toBe(2 * 5 + 3 * 6 + 4 * 7);
  });

  it('computes the cross product with correct orientation (right-hand rule)', () => {
    const result = cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(result.x).toBeCloseTo(0, 10);
    expect(result.y).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(1, 10);
  });
});

describe('calculateEAR', () => {
  it('matches a hand-computed value for a plausible open eye', () => {
    // p1 (outer corner) --- p4 (inner corner) horizontal distance = 0.3
    // p2/p3 upper lid and p5/p6 lower lid each 0.1 apart vertically.
    const eye = [
      { x: 0, y: 0 }, // p1
      { x: 0.08, y: -0.05 }, // p2
      { x: 0.2, y: -0.05 }, // p3
      { x: 0.3, y: 0 }, // p4
      { x: 0.2, y: 0.05 }, // p5
      { x: 0.08, y: 0.05 }, // p6
    ];
    // EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|) = (0.1 + 0.1) / (2 * 0.3)
    expect(calculateEAR(eye)).toBeCloseTo(0.2 / 0.6, 10);
  });

  it('approaches zero as the eyelids close (upper and lower lid points converge)', () => {
    const closedEye = [
      { x: 0, y: 0 },
      { x: 0.08, y: 0 },
      { x: 0.2, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.2, y: 0 },
      { x: 0.08, y: 0 },
    ];
    expect(calculateEAR(closedEye)).toBe(0);
  });

  it('throws when given the wrong number of points', () => {
    expect(() => calculateEAR([{ x: 0, y: 0 }])).toThrow();
  });
});

describe('computeHeadPose Euler angle extraction', () => {
  const center = { x: 0.5, y: 0.45, z: 0 };

  function buildAnchors({ right, down }) {
    const rightTragus = {
      x: center.x + right.x * 0.15,
      y: center.y + right.y * 0.15,
      z: center.z + right.z * 0.15,
    };
    const leftTragus = {
      x: center.x - right.x * 0.15,
      y: center.y - right.y * 0.15,
      z: center.z - right.z * 0.15,
    };
    const chin = {
      x: center.x + down.x * 0.15,
      y: center.y + down.y * 0.15,
      z: center.z + down.z * 0.15,
    };
    const glabella = {
      x: center.x - down.x * 0.15,
      y: center.y - down.y * 0.15,
      z: center.z - down.z * 0.15,
    };
    return { noseTip: center, chin, glabella, leftTragus, rightTragus };
  }

  it('reports zero pitch/yaw/roll for a perfectly frontal, upright head', () => {
    const anchors = buildAnchors({ right: { x: 1, y: 0, z: 0 }, down: { x: 0, y: 1, z: 0 } });
    const pose = computeHeadPose(anchors);
    expect(pose.pitch).toBeCloseTo(0, 6);
    expect(pose.yaw).toBeCloseTo(0, 6);
    expect(pose.roll).toBeCloseTo(0, 6);
  });

  it('recovers a pure yaw rotation (rotation about the vertical/down axis)', () => {
    // right vector rotated by theta about the down axis; down axis itself
    // is unaffected by a rotation around itself.
    const thetaDeg = 30;
    const theta = (thetaDeg * Math.PI) / 180;
    const right = { x: Math.cos(theta), y: 0, z: Math.sin(theta) };
    const down = { x: 0, y: 1, z: 0 };
    const anchors = buildAnchors({ right, down });
    const pose = computeHeadPose(anchors);
    // Derivation (see math/vectorUtils.js header comment for the formulas):
    // forward = cross(right, down) = (-sin(theta), 0, cos(theta))
    // yaw = atan2(forward.x, forward.z) = atan2(-sin(theta), cos(theta)) = -theta
    expect(pose.yaw).toBeCloseTo(-thetaDeg, 4);
    expect(pose.pitch).toBeCloseTo(0, 4);
    expect(pose.roll).toBeCloseTo(0, 4);
  });

  it('recovers a pure pitch rotation (nodding about the ear-to-ear axis)', () => {
    const phiDeg = 25;
    const phi = (phiDeg * Math.PI) / 180;
    const right = { x: 1, y: 0, z: 0 };
    const down = { x: 0, y: Math.cos(phi), z: Math.sin(phi) };
    const anchors = buildAnchors({ right, down });
    const pose = computeHeadPose(anchors);
    // forward = cross(right, down) = (0, -sin(phi), cos(phi))
    // pitch = atan2(-forward.y, sqrt(forward.x^2+forward.z^2)) = atan2(sin(phi), cos(phi)) = phi
    expect(pose.pitch).toBeCloseTo(phiDeg, 4);
    expect(pose.yaw).toBeCloseTo(0, 4);
    expect(pose.roll).toBeCloseTo(0, 4);
  });

  it('recovers a pure roll rotation (lateral head tilt about the forward/view axis)', () => {
    const psiDeg = 15;
    const psi = (psiDeg * Math.PI) / 180;
    const right = { x: Math.cos(psi), y: Math.sin(psi), z: 0 };
    const down = { x: -Math.sin(psi), y: Math.cos(psi), z: 0 };
    const anchors = buildAnchors({ right, down });
    const pose = computeHeadPose(anchors);
    // roll = atan2(right.y, right.x) = atan2(sin(psi), cos(psi)) = psi
    expect(pose.roll).toBeCloseTo(psiDeg, 4);
    expect(pose.pitch).toBeCloseTo(0, 4);
    expect(pose.yaw).toBeCloseTo(0, 4);
  });
});

describe('IPD-based screen distance estimation', () => {
  it('round-trips: calibrating at a known distance then re-estimating at the same IPD returns that distance', () => {
    const ipdPx = 62;
    const knownDistanceCm = 55;
    const focalLengthPx = calibrateFocalLength(ipdPx, knownDistanceCm);
    const estimated = estimateDistanceCm(ipdPx, focalLengthPx);
    expect(estimated).toBeCloseTo(knownDistanceCm, 6);
  });

  it('reports a larger distance when the measured IPD shrinks (subject moves away)', () => {
    const focalLengthPx = focalLengthFromFov(1280, 60);
    const near = estimateDistanceCm(70, focalLengthPx);
    const far = estimateDistanceCm(35, focalLengthPx);
    expect(far).toBeGreaterThan(near);
  });
});
