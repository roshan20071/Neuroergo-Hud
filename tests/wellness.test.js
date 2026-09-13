import { describe, it, expect, beforeEach } from 'vitest';
import { WellnessEngine } from '../src/engine/wellnessEngine.js';

describe('WellnessEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new WellnessEngine();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('initializes with default score of 100 and grade A+', () => {
    const snapshot = engine.getSnapshot();
    expect(snapshot.score).toBe(100);
    expect(snapshot.grade).toBe('A+');
    expect(snapshot.totalActiveSec).toBe(0);
    expect(engine.score).toBe(100);
    expect(engine.grade).toBe('A+');
    expect(engine.sessionDurationSec).toBe(0);
    expect(engine.getUprightPercentage()).toBe(100);
  });

  it('accumulates good posture and healthy distance time correctly', () => {
    const goodTelemetry = {
      alerts: [],
      distanceCm: 55,
      blinkRatePerMin: 18,
      blinkCount: 5,
    };

    engine.update(goodTelemetry, 0);
    const snapshot = engine.update(goodTelemetry, 5000);

    expect(snapshot.totalActiveSec).toBe(5);
    expect(snapshot.goodPosturePct).toBe(100);
    expect(snapshot.goodDistancePct).toBe(100);
    expect(snapshot.score).toBeGreaterThanOrEqual(95);
    expect(snapshot.grade).toBe('A+');
    expect(engine.getUprightPercentage()).toBe(100);
  });

  it('evaluates grade boundaries accurately based on weighted components', () => {
    // 1. A+ boundary (>= 95)
    engine.reset();
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18 }, 0);
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18 }, 10000);
    expect(engine.score).toBeGreaterThanOrEqual(95);
    expect(engine.grade).toBe('A+');

    // 2. Severe slouching drops to D or F (< 70 / < 60)
    engine.reset();
    engine.update({ alerts: [{ type: 'FORWARD_HEAD_TILT' }], distanceCm: 25, blinkRatePerMin: 2 }, 0);
    engine.update({ alerts: [{ type: 'FORWARD_HEAD_TILT' }], distanceCm: 25, blinkRatePerMin: 2 }, 10000);
    expect(engine.score).toBeLessThanOrEqual(60);
    expect(['D', 'F']).toContain(engine.grade);
  });

  it('handles low and high blink rate penalties correctly', () => {
    // Normal blink rate 18: full blinkScore 100
    engine.reset();
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18 }, 0);
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18 }, 5000);
    const normalScore = engine.score;

    // Low blink rate (4 blinks/min): penalty
    engine.reset();
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 4 }, 0);
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 4 }, 5000);
    const lowBlinkScore = engine.score;
    expect(lowBlinkScore).toBeLessThan(normalScore);

    // High blink rate (> 32, e.g. 45 blinks/min): penalty
    engine.reset();
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 45 }, 0);
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 45 }, 5000);
    const highBlinkScore = engine.score;
    expect(highBlinkScore).toBeLessThan(normalScore);
  });

  it('saves and rehydrates session snapshots via localStorage', () => {
    // Mock localStorage in Node/Vitest environment if not present
    const storageMap = new Map();
    const mockStorage = {
      getItem: (key) => storageMap.get(key) || null,
      setItem: (key, val) => storageMap.set(key, String(val)),
      removeItem: (key) => storageMap.delete(key),
      clear: () => storageMap.clear(),
    };
    const origStorage = globalThis.localStorage;
    globalThis.localStorage = mockStorage;

    try {
      engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18, blinkCount: 15 }, 0);
      engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18, blinkCount: 15 }, 60000);

      const saved = engine.saveSnapshot('test_wellness_key');
      expect(saved).toBe(true);

      const newEngine = new WellnessEngine();
      expect(newEngine.sessionDurationSec).toBe(0);

      const loaded = newEngine.loadSnapshot('test_wellness_key');
      expect(loaded).toBe(true);
      expect(newEngine.sessionDurationSec).toBe(60);
      expect(newEngine.totalBlinks).toBe(15);
      expect(newEngine.score).toBe(engine.score);
      expect(newEngine.grade).toBe(engine.grade);
    } finally {
      globalThis.localStorage = origStorage;
    }
  });

  it('generates friendly advice corresponding to alert states', () => {
    const alertTelemetry = {
      alerts: [{ type: 'FORWARD_HEAD_TILT' }, { type: 'SCREEN_TOO_CLOSE' }],
      distanceCm: 35,
      blinkRatePerMin: 8,
    };

    const advice = engine.getFriendlyAdvice(alertTelemetry);
    expect(advice.headline).toBe('Adjust Posture');
    expect(advice.posture.status).toBe('warn');
    expect(advice.distance.status).toBe('warn');
    expect(advice.eyes.status).toBe('warn');
  });

  it('generates reports in text, json, and html formats', () => {
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18, blinkCount: 12 }, 0);
    engine.update({ alerts: [], distanceCm: 55, blinkRatePerMin: 18, blinkCount: 12 }, 30000);

    // 1. Text format
    const textReport = engine.generateReport('text');
    expect(textReport).toContain('DAILY WELLNESS REPORT');
    expect(textReport).toContain('Ergonomic Health Grade');
    expect(textReport).toContain('Total Eye Blinks Logged');

    // 2. JSON format
    const jsonReport = engine.generateReport('json');
    const parsed = JSON.parse(jsonReport);
    expect(parsed.title).toContain('DAILY WELLNESS REPORT');
    expect(parsed.score).toBe(engine.score);
    expect(parsed.metrics.totalBlinks).toBe(12);

    // 3. HTML printable format
    const htmlReport = engine.generateReport('html');
    expect(htmlReport).toContain('<!DOCTYPE html>');
    expect(htmlReport).toContain('NeuroErgo HUD — Wellness Summary');
    expect(htmlReport).toContain('@media print');
  });
});
