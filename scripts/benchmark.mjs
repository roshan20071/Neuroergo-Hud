/**
 * scripts/benchmark.mjs
 * ---------------------------------------------------------------------------
 * Measures the actual CPU cost of the per-frame math this project performs
 * on every video frame: head-pose extraction, EAR calculation for both
 * eyes, and landmark smoothing across a full 468-point face mesh plus a
 * 21-point hand skeleton.
 *
 * This does NOT measure MediaPipe's own WASM inference time (that runs in
 * a separate, closed-source graph and is outside this codebase's control)
 * -- it measures the cost of the mathematical/logic layer this repository
 * is actually responsible for, which is the part relevant to judging this
 * project's own algorithmic efficiency. Run with `npm run bench`.
 * ---------------------------------------------------------------------------
 */

import { computeHeadPose, calculateEAR } from '../src/math/vectorUtils.js';
import { LandmarkSmoother } from '../src/filters/smoothing.js';
import { ErgonomicsEngine } from '../src/engine/ergonomicsEngine.js';
import { GestureEngine } from '../src/engine/gestureEngine.js';

const ITERATIONS = 20000;

function randPoint(z = true) {
  const p = { x: Math.random(), y: Math.random() };
  if (z) p.z = Math.random() * 0.1;
  return p;
}

function makeFaceMesh() {
  return Array.from({ length: 468 }, () => randPoint());
}

function makeHand() {
  return Array.from({ length: 21 }, () => randPoint(false));
}

function bench(label, fn, iterations = ITERATIONS) {
  // Warm up the JIT before timing, so the measurement reflects steady-state
  // performance rather than initial de-optimized execution.
  for (let i = 0; i < Math.min(1000, iterations); i += 1) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const totalMs = performance.now() - start;
  const perCallUs = (totalMs / iterations) * 1000;
  console.log(`${label.padEnd(42)} ${perCallUs.toFixed(2).padStart(8)} µs/call   (${iterations} iterations, ${totalMs.toFixed(1)}ms total)`);
  return perCallUs;
}

console.log(`Node ${process.version} — NeuroErgo HUD math/filter micro-benchmark\n`);

const anchors = {
  noseTip: randPoint(),
  chin: randPoint(),
  leftTragus: randPoint(),
  rightTragus: randPoint(),
  glabella: randPoint(),
};
const headPoseUs = bench('computeHeadPose()', () => computeHeadPose(anchors));

const eye = [randPoint(false), randPoint(false), randPoint(false), randPoint(false), randPoint(false), randPoint(false)];
const earUs = bench('calculateEAR() (single eye)', () => calculateEAR(eye));

const faceSmoother = new LandmarkSmoother({ kind: 'double' });
const faceFrame = makeFaceMesh();
const faceSmoothUs = bench('LandmarkSmoother.smoothAll() (468 pts)', () => faceSmoother.smoothAll(faceFrame));

const handSmoother = new LandmarkSmoother({ kind: 'double' });
const handFrame = makeHand();
const handSmoothUs = bench('LandmarkSmoother.smoothAll() (21 pts)', () => handSmoother.smoothAll(handFrame));

const ergo = new ErgonomicsEngine({ frameWidthPx: 1280 });
let t = 0;
const ergoUs = bench('ErgonomicsEngine.update()', () => {
  t += 16;
  ergo.update({
    leftEyePoints: eye,
    rightEyePoints: eye,
    leftPupil: { x: 0.4, y: 0.45 },
    rightPupil: { x: 0.46, y: 0.45 },
    headPose: { pitch: 0, yaw: 0, roll: 0 },
    timestampMs: t,
  });
});

const gesture = new GestureEngine();
const handLandmarks = makeHand();
let gt = 0;
const gestureUs = bench('GestureEngine.update()', () => {
  gt += 16;
  gesture.update(handLandmarks, gt);
});

const perFrameTotalUs = headPoseUs + earUs * 2 + faceSmoothUs + handSmoothUs + ergoUs + gestureUs;
console.log('\n--- Estimated full per-frame math/filter budget ---');
console.log(`Sum of the above (head pose + 2x EAR + face/hand smoothing + both engines):`);
console.log(`  ${perFrameTotalUs.toFixed(2)} µs/frame  =>  ${(perFrameTotalUs / 1000).toFixed(3)} ms/frame`);
console.log(`  Headroom against a 60fps (16.67ms) frame budget: ${(100 - (perFrameTotalUs / 1000 / 16.67) * 100).toFixed(2)}%`);
console.log('\nNote: this excludes MediaPipe WASM inference and WebGL rendering, which run');
console.log('separately and dominate total frame time; see README for the full breakdown.');
