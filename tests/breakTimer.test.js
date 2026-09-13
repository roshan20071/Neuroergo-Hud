import { describe, it, expect, beforeEach } from 'vitest';
import { BreakTimer } from '../src/engine/breakTimer.js';

describe('BreakTimer', () => {
  let timer;

  beforeEach(() => {
    // 20s work, 5s rest for predictable test intervals
    timer = new BreakTimer({ workDurationSec: 20, breakDurationSec: 5 });
  });

  it('initializes in WORKING state with 0 accumulated time', () => {
    const status = timer.getStatus();
    expect(status.state).toBe('WORKING');
    expect(status.accumulatedSec).toBe(0);
    expect(status.remainingWorkSec).toBe(20);
    expect(status.progressPercent).toBe(0);
  });

  it('accumulates screen time when face is tracked', () => {
    timer.update(0, true);
    const status = timer.update(5000, true);
    expect(status.accumulatedSec).toBe(5);
    expect(status.remainingWorkSec).toBe(15);
    expect(status.progressPercent).toBe(25);
  });

  it('does NOT accumulate screen time when face is NOT tracked (away from desk)', () => {
    timer.update(0, false);
    const status = timer.update(5000, false);
    expect(status.accumulatedSec).toBe(0);
    expect(status.remainingWorkSec).toBe(20);
  });

  it('transitions to BREAK_DUE and fires breakDue event when work duration is reached', () => {
    let dueFired = false;
    timer.on('breakDue', () => {
      dueFired = true;
    });

    timer.update(0, true);
    timer.update(10000, true);
    expect(dueFired).toBe(false);

    const status = timer.update(20000, true);
    expect(dueFired).toBe(true);
    expect(status.state).toBe('BREAK_DUE');
  });

  it('progresses through ON_BREAK and completes after breakDurationSec', () => {
    let completed = false;
    timer.on('breakComplete', () => {
      completed = true;
    });

    timer.update(0, true);
    timer.update(20000, true); // hits break due
    timer.startBreak();

    expect(timer.getStatus().state).toBe('ON_BREAK');

    timer.update(21000, true);
    timer.update(23000, true);
    expect(completed).toBe(false);

    timer.update(26000, true); // 5+ seconds elapsed
    expect(completed).toBe(true);
    expect(timer.getStatus().state).toBe('WORKING');
    expect(timer.getStatus().accumulatedSec).toBe(0);
  });

  it('supports skipBreak with a snooze grace period', () => {
    timer.update(0, true);
    timer.update(20000, true); // hits break due
    expect(timer.getStatus().state).toBe('BREAK_DUE');

    timer.skipBreak();
    expect(timer.getStatus().state).toBe('WORKING');
    expect(timer.getStatus().remainingWorkSec).toBeGreaterThan(0);
  });

  it('toggles demo mode cleanly', () => {
    expect(timer.isDemoMode).toBe(false);
    timer.setDemoMode(true);
    expect(timer.isDemoMode).toBe(true);
    expect(timer.workDurationSec).toBe(20);
    expect(timer.breakDurationSec).toBe(10);
  });
});
