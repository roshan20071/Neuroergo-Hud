/**
 * breakTimer.js
 * ---------------------------------------------------------------------------
 * Implements the clinical 20-20-20 ergonomic rule:
 * Every 20 minutes of continuous screen work, prompt the user to look 20 feet
 * (6 meters) away for 20 seconds to prevent digital eye strain, dry eyes,
 * and ciliary muscle spasm.
 *
 * Only accumulates screen time when the user is actively present and tracked,
 * preventing false alerts if the user leaves their desk.
 * ---------------------------------------------------------------------------
 */

export class BreakTimer {
  /**
   * @param {object} [options]
   * @param {number} [options.workDurationSec=1200] 20 minutes work interval (seconds)
   * @param {number} [options.breakDurationSec=20] 20 seconds rest interval (seconds)
   */
  constructor(options = {}) {
    this.standardWorkSec = options.workDurationSec ?? 1200; // 20 min
    this.standardBreakSec = options.breakDurationSec ?? 20; // 20 sec

    this.workDurationSec = this.standardWorkSec;
    this.breakDurationSec = this.standardBreakSec;

    this.isDemoMode = false;
    this.state = 'WORKING'; // 'WORKING' | 'BREAK_DUE' | 'ON_BREAK'

    this.accumulatedActiveMs = 0;
    this.breakElapsedMs = 0;
    this.lastTimestampMs = null;
    this.breakStartedAtMs = null;

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try {
          cb(data);
        } catch (err) {
          console.error(`BreakTimer listener error [${event}]:`, err);
        }
      }
    }
  }

  setDemoMode(enabled) {
    this.isDemoMode = Boolean(enabled);
    this.workDurationSec = this.isDemoMode ? 20 : this.standardWorkSec;
    this.breakDurationSec = this.isDemoMode ? 10 : this.standardBreakSec;
    this.reset();
  }

  toggleDemoMode() {
    this.setDemoMode(!this.isDemoMode);
    return this.isDemoMode;
  }

  /**
   * Advances the timer with the current frame timestamp and tracking presence.
   * @param {number} timestampMs
   * @param {boolean} isFaceTracked
   */
  update(timestampMs, isFaceTracked = true) {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      return this.getStatus();
    }

    const deltaMs = Math.max(0, timestampMs - this.lastTimestampMs);
    this.lastTimestampMs = timestampMs;

    if (this.state === 'WORKING') {
      if (isFaceTracked) {
        this.accumulatedActiveMs += deltaMs;
        const workTargetMs = this.workDurationSec * 1000;
        if (this.accumulatedActiveMs >= workTargetMs) {
          this.state = 'BREAK_DUE';
          this.emit('breakDue', {
            accumulatedSec: Math.round(this.accumulatedActiveMs / 1000),
            breakDurationSec: this.breakDurationSec,
          });
        }
      }
    } else if (this.state === 'ON_BREAK') {
      this.breakElapsedMs += deltaMs;
      const breakTargetMs = this.breakDurationSec * 1000;
      if (this.breakElapsedMs >= breakTargetMs) {
        this.completeBreak();
      }
    }

    const status = this.getStatus();
    this.emit('tick', status);
    return status;
  }

  startBreak() {
    this.state = 'ON_BREAK';
    this.breakElapsedMs = 0;
    this.emit('breakStarted', { breakDurationSec: this.breakDurationSec });
  }

  completeBreak() {
    this.state = 'WORKING';
    this.accumulatedActiveMs = 0;
    this.breakElapsedMs = 0;
    this.emit('breakComplete', { isDemoMode: this.isDemoMode });
  }

  skipBreak() {
    this.state = 'WORKING';
    // When skipped, give a 5-minute snooze in standard mode or 10s in demo
    const snoozeSec = this.isDemoMode ? 10 : 300;
    const workTargetMs = this.workDurationSec * 1000;
    this.accumulatedActiveMs = Math.max(0, workTargetMs - snoozeSec * 1000);
    this.breakElapsedMs = 0;
    this.emit('breakSkipped', { snoozeSec });
  }

  reset() {
    this.state = 'WORKING';
    this.accumulatedActiveMs = 0;
    this.breakElapsedMs = 0;
    this.emit('reset', this.getStatus());
  }

  getStatus() {
    const workTargetSec = this.workDurationSec;
    const accumulatedSec = Math.floor(this.accumulatedActiveMs / 1000);
    const remainingWorkSec = Math.max(0, workTargetSec - accumulatedSec);

    const breakTargetSec = this.breakDurationSec;
    const breakElapsedSec = Math.floor(this.breakElapsedMs / 1000);
    const remainingBreakSec = Math.max(0, breakTargetSec - breakElapsedSec);

    const progressPercent = Math.min(100, Math.round((accumulatedSec / workTargetSec) * 100));

    return {
      state: this.state,
      isDemoMode: this.isDemoMode,
      accumulatedSec,
      remainingWorkSec,
      breakTargetSec,
      remainingBreakSec,
      progressPercent,
    };
  }
}
