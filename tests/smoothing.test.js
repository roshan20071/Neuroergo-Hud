import { describe, it, expect } from 'vitest';
import { EMAFilter, DoubleExponentialFilter, LandmarkSmoother } from '../src/filters/smoothing.js';

describe('EMAFilter', () => {
  it('initializes to the first sample exactly (no artificial startup lag)', () => {
    const f = new EMAFilter(0.5);
    expect(f.update(10)).toBe(10);
  });

  it('converges toward a new constant input asymptotically', () => {
    const f = new EMAFilter(0.5);
    f.update(0);
    let value;
    for (let i = 0; i < 25; i += 1) value = f.update(10);
    expect(value).toBeCloseTo(10, 5);
  });

  it('attenuates a single-frame jitter spike relative to the raw signal', () => {
    const f = new EMAFilter(0.3);
    for (let i = 0; i < 10; i += 1) f.update(5);
    const smoothedDuringSpike = f.update(50); // one jittery outlier frame
    // The filter should move toward the spike but land well short of it.
    expect(smoothedDuringSpike).toBeGreaterThan(5);
    expect(smoothedDuringSpike).toBeLessThan(50);
  });

  it('reset() clears prior history so the next sample re-initializes the filter', () => {
    const f = new EMAFilter(0.5);
    f.update(100);
    f.reset();
    expect(f.update(3)).toBe(3);
  });

  it('rejects an out-of-range alpha', () => {
    expect(() => new EMAFilter(0)).toThrow();
    expect(() => new EMAFilter(1.5)).toThrow();
  });
});

describe('DoubleExponentialFilter', () => {
  it('asymptotically tracks a noiseless linear ramp with zero steady-state lag', () => {
    // For x_t = a + b*t with no noise, Holt's linear method converges its
    // trend estimate to b and its level estimate to exactly a + b*t once
    // warmed up (see smoothing.js module docs for the derivation).
    const a = 5;
    const b = 2;
    const f = new DoubleExponentialFilter(0.5, 0.3);
    let level;
    for (let t = 0; t <= 60; t += 1) {
      level = f.update(a + b * t);
    }
    expect(level).toBeCloseTo(a + b * 60, 2);
    expect(f.trend).toBeCloseTo(b, 2);
  });

  it('predict(k) extrapolates forward using the learned trend', () => {
    const f = new DoubleExponentialFilter(0.5, 0.3);
    for (let t = 0; t <= 60; t += 1) f.update(5 + 2 * t);
    const forecast = f.predict(3);
    expect(forecast).toBeCloseTo(f.level + 3 * f.trend, 10);
    expect(forecast).toBeCloseTo(5 + 2 * 63, 1);
  });

  it('tracks a moving landmark coordinate more responsively than a plain EMA under sustained motion', () => {
    // Because it carries a trend term, double exponential smoothing should
    // trail a steadily moving signal by less than a plain EMA configured
    // with a comparable alpha.
    const ema = new EMAFilter(0.5);
    const des = new DoubleExponentialFilter(0.5, 0.3);
    let trueValue = 0;
    let emaVal;
    let desVal;
    for (let t = 0; t < 40; t += 1) {
      trueValue += 1; // constant-velocity motion
      emaVal = ema.update(trueValue);
      desVal = des.update(trueValue);
    }
    const emaLag = Math.abs(trueValue - emaVal);
    const desLag = Math.abs(trueValue - desVal);
    expect(desLag).toBeLessThan(emaLag);
  });

  it('rejects out-of-range alpha/beta', () => {
    expect(() => new DoubleExponentialFilter(0, 0.3)).toThrow();
    expect(() => new DoubleExponentialFilter(0.5, 0)).toThrow();
  });
});

describe('LandmarkSmoother', () => {
  it('tracks each landmark index independently without cross-contamination', () => {
    const smoother = new LandmarkSmoother({ kind: 'ema', alpha: 0.5 });
    for (let i = 0; i < 10; i += 1) {
      smoother.smoothAll([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    }
    const [a, b] = smoother.smoothAll([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    expect(a.x).toBeCloseTo(0, 5);
    expect(b.x).toBeCloseTo(100, 5);
  });

  it('reduces frame-to-frame jitter variance relative to the raw landmark stream', () => {
    const smoother = new LandmarkSmoother({ kind: 'double', alpha: 0.4, beta: 0.2 });
    const raw = [];
    const smoothed = [];
    let base = 0.5;
    for (let i = 0; i < 50; i += 1) {
      // Deterministic pseudo-jitter: oscillates around a slowly drifting base.
      const jitter = ((i * 37) % 7) / 700 - 0.005;
      const point = { x: base + jitter, y: 0.5 };
      raw.push(point.x);
      const [s] = smoother.smoothAll([point]);
      smoothed.push(s.x);
      base += 0.001;
    }
    const variance = (arr) => {
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    };
    // Compare variance of the frame-to-frame deltas (jitter), not of the
    // absolute series (which both trend upward with `base`).
    const deltas = (arr) => arr.slice(1).map((v, i) => v - arr[i]);
    expect(variance(deltas(smoothed))).toBeLessThan(variance(deltas(raw)));
  });
});
