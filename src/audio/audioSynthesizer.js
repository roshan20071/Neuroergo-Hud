/**
 * audioSynthesizer.js
 * ---------------------------------------------------------------------------
 * Synthesized biometric audio alerts and chime feedback via Web Audio API.
 * ---------------------------------------------------------------------------
 */

export const ALERT_TONES = {
  MICROSLEEP: 440,
  FORWARD_HEAD_TILT: 660,
  LATERAL_HEAD_TILT: 700,
  SCREEN_TOO_CLOSE: 880,
  SCREEN_TOO_FAR: 550,
};

export class AudioSynthesizer {
  constructor() {
    this.audioCtx = null;
    this.mediaAudioDest = null;
    this.lastAlertToneAt = new Map();
    this.repeatIntervalMs = 4000;
  }

  ensureContext() {
    if (!this.audioCtx && typeof window !== 'undefined') {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
        try {
          this.mediaAudioDest = this.audioCtx.createMediaStreamDestination();
        } catch (_) {}
      }
    }
    if (this.audioCtx?.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  getMediaStreamDestination() {
    this.ensureContext();
    return this.mediaAudioDest;
  }

  playAlertTone(frequency = 880, durationMs = 180, isMuted = false) {
    if (isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

      osc.connect(gain);
      gain.connect(ctx.destination);
      if (this.mediaAudioDest) {
        try {
          gain.connect(this.mediaAudioDest);
        } catch (_) {}
      }

      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.02);
    } catch (e) {
      console.warn('Audio tone synthesis error:', e);
    }
  }

  playBreakChime(isMuted = false) {
    if (isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      [523.25, 659.25].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + idx * 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);

        osc.connect(gain);
        gain.connect(ctx.destination);
        if (this.mediaAudioDest) {
          try {
            gain.connect(this.mediaAudioDest);
          } catch (_) {}
        }
        osc.start(start);
        osc.stop(start + 0.56);
      });
    } catch (e) {
      console.warn('Break chime synthesis error:', e);
    }
  }

  checkAndPlayAlert(alertType, timestampMs, isMuted = false) {
    if (isMuted || !ALERT_TONES[alertType]) return;
    const lastAt = this.lastAlertToneAt.get(alertType) ?? -Infinity;
    if (timestampMs - lastAt > this.repeatIntervalMs) {
      this.playAlertTone(ALERT_TONES[alertType], 180, isMuted);
      this.lastAlertToneAt.set(alertType, timestampMs);
    }
  }

  clearAlertHistory() {
    this.lastAlertToneAt.clear();
  }
}
