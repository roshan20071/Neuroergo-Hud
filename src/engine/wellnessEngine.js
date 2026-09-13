/**
 * wellnessEngine.js
 * ---------------------------------------------------------------------------
 * Transforms complex biometric telemetry (EAR, head pose, IPD distance) into
 * intuitive, friendly wellness indicators and a daily Ergonomic Health Score.
 * Designed for everyday users, remote workers, students, and seniors.
 * ---------------------------------------------------------------------------
 */

export class WellnessEngine {
  constructor() {
    this.sessionStartTime = null;
    this.totalActiveSec = 0;
    this.goodPostureSec = 0;
    this.slouchSec = 0;
    this.goodDistanceSec = 0;
    this.totalBlinks = 0;
    this.lastTimestampMs = null;

    this.currentScore = 100;
    this.currentGrade = 'A+';
  }

  get score() {
    return this.currentScore;
  }

  get grade() {
    return this.currentGrade;
  }

  get sessionDurationSec() {
    return Math.round(this.totalActiveSec);
  }

  getGrade() {
    return this.currentGrade;
  }

  getUprightPercentage() {
    return this.totalActiveSec > 0
      ? Math.round((this.goodPostureSec / this.totalActiveSec) * 100)
      : 100;
  }

  reset() {
    this.sessionStartTime = null;
    this.totalActiveSec = 0;
    this.goodPostureSec = 0;
    this.slouchSec = 0;
    this.goodDistanceSec = 0;
    this.totalBlinks = 0;
    this.lastTimestampMs = null;
    this.currentScore = 100;
    this.currentGrade = 'A+';
  }

  /**
   * Serializes and saves current wellness metrics to localStorage.
   * @param {string} [storageKey='neuroergo_wellness_state']
   * @returns {boolean} true if saved successfully
   */
  saveSnapshot(storageKey = 'neuroergo_wellness_state') {
    if (typeof localStorage === 'undefined') return false;
    try {
      const payload = {
        totalActiveSec: this.totalActiveSec,
        goodPostureSec: this.goodPostureSec,
        slouchSec: this.slouchSec,
        goodDistanceSec: this.goodDistanceSec,
        totalBlinks: this.totalBlinks,
        currentScore: this.currentScore,
        currentGrade: this.currentGrade,
        savedAt: Date.now(),
      };
      localStorage.setItem(storageKey, JSON.stringify(payload));
      return true;
    } catch (e) {
      console.warn('[WellnessEngine] Failed to save snapshot:', e);
      return false;
    }
  }

  /**
   * Rehydrates cumulative session metrics from localStorage.
   * @param {string} [storageKey='neuroergo_wellness_state']
   * @returns {boolean} true if state was loaded
   */
  loadSnapshot(storageKey = 'neuroergo_wellness_state') {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (typeof data.totalActiveSec === 'number') {
        this.totalActiveSec = data.totalActiveSec;
        this.goodPostureSec = data.goodPostureSec ?? 0;
        this.slouchSec = data.slouchSec ?? 0;
        this.goodDistanceSec = data.goodDistanceSec ?? 0;
        this.totalBlinks = data.totalBlinks ?? 0;
        this.currentScore = data.currentScore ?? 100;
        this.currentGrade = data.currentGrade ?? 'A+';
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[WellnessEngine] Failed to load snapshot:', e);
      return false;
    }
  }

  /**
   * Updates ergonomic session metrics from a telemetry frame.
   * @param {object} telemetry
   * @param {number} timestampMs
   * @returns {object} friendly wellness snapshot
   */
  update(telemetry, timestampMs) {
    if (!telemetry) return this.getSnapshot();

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      this.sessionStartTime = timestampMs;
      return this.getSnapshot(telemetry);
    }

    const deltaSec = Math.max(0, (timestampMs - this.lastTimestampMs) / 1000);
    this.lastTimestampMs = timestampMs;
    this.totalActiveSec += deltaSec;
    this.totalBlinks = telemetry.blinkCount ?? this.totalBlinks;

    // Check posture
    const hasPostureAlert = telemetry.alerts?.some(
      (a) => a.type === 'FORWARD_HEAD_TILT' || a.type === 'LATERAL_HEAD_TILT'
    );
    if (!hasPostureAlert) {
      this.goodPostureSec += deltaSec;
    } else {
      this.slouchSec += deltaSec;
    }

    // Check distance (healthy corridor 45cm to 75cm, tolerating sensor jitter 42..78)
    const dist = telemetry.distanceCm;
    if (typeof dist === 'number' && dist >= 42 && dist <= 78) {
      this.goodDistanceSec += deltaSec;
    }

    this._calculateScore(telemetry);
    return this.getSnapshot(telemetry);
  }

  _calculateScore(telemetry) {
    if (this.totalActiveSec < 2) {
      this.currentScore = 100;
      this.currentGrade = 'A+';
      return;
    }

    // Posture score (40% weight)
    const postureRatio = this.goodPostureSec / this.totalActiveSec;
    const postureScore = Math.min(100, Math.max(0, postureRatio * 100));

    // Distance score (30% weight)
    const distanceRatio = this.goodDistanceSec / this.totalActiveSec;
    const distanceScore = Math.min(100, Math.max(0, distanceRatio * 100));

    // Blink score (30% weight)
    // Normal healthy blink rate is ~14 to 24 blinks/min
    const blinkRate = telemetry?.blinkRatePerMin ?? 18;
    let blinkScore = 100;
    if (blinkRate < 10) {
      blinkScore = Math.max(40, 100 - (10 - blinkRate) * 7);
    } else if (blinkRate > 32) {
      blinkScore = Math.max(50, 100 - (blinkRate - 32) * 4);
    }

    const weightedScore = Math.round(
      postureScore * 0.4 + distanceScore * 0.3 + blinkScore * 0.3
    );
    this.currentScore = Math.min(100, Math.max(0, weightedScore));

    if (this.currentScore >= 95) this.currentGrade = 'A+';
    else if (this.currentScore >= 88) this.currentGrade = 'A';
    else if (this.currentScore >= 80) this.currentGrade = 'B';
    else if (this.currentScore >= 70) this.currentGrade = 'C';
    else if (this.currentScore >= 60) this.currentGrade = 'D';
    else this.currentGrade = 'F';
  }

  getFriendlyAdvice(telemetry) {
    if (!telemetry) {
      return {
        headline: 'Detecting posture…',
        posture: { title: 'Detecting posture…', tip: 'Sit upright and align face in camera view.', text: 'Detecting posture…', status: 'neutral', icon: '👤' },
        eyes: { title: 'Monitoring blink rate…', tip: 'Eye blinks help maintain tear film hydration.', text: 'Monitoring blink rate…', status: 'neutral', icon: '👁️' },
        distance: { title: 'Measuring screen distance…', tip: 'Recommended distance is 50–70cm.', text: 'Measuring screen distance…', status: 'neutral', icon: '📏' },
      };
    }

    // 1. Posture Advice
    const hasForward = telemetry.alerts?.some((a) => a.type === 'FORWARD_HEAD_TILT');
    const hasLateral = telemetry.alerts?.some((a) => a.type === 'LATERAL_HEAD_TILT');
    let posture = {
      title: 'Upright & Balanced',
      tip: 'Your cervical spine and head are nicely centered.',
      text: 'Upright & Balanced',
      status: 'good',
      icon: '✨',
    };

    if (hasForward) {
      posture = {
        title: 'Forward Head Tilt',
        tip: 'Chin down — raise your monitor or glance slightly higher.',
        text: 'Chin down — raise your gaze slightly',
        status: 'warn',
        icon: '⚠️',
      };
    } else if (hasLateral) {
      posture = {
        title: 'Lateral Head Tilt',
        tip: 'Head tilted sideways — center your neck over your shoulders.',
        text: 'Head tilted sideways — center your neck',
        status: 'warn',
        icon: '⚠️',
      };
    }

    // 2. Eyes Advice
    const hasMicrosleep = telemetry.alerts?.some((a) => a.type === 'MICROSLEEP');
    const blinkRate = telemetry.blinkRatePerMin ?? 18;
    let eyes = {
      title: 'Eye Comfort Normal',
      tip: `Comfortable hydration rate (${blinkRate.toFixed(0)} blinks/min).`,
      text: `Comfortable (${blinkRate.toFixed(0)} blinks/min)`,
      status: 'good',
      icon: '💧',
    };

    if (hasMicrosleep) {
      eyes = {
        title: 'Drowsiness Detected',
        tip: 'Micro-sleep or prolonged closure. Take a restorative break now!',
        text: 'Drowsiness detected — take a quick rest!',
        status: 'danger',
        icon: '😴',
      };
    } else if (blinkRate < 10) {
      eyes = {
        title: 'Low Blink Rate',
        tip: 'Blink deliberately to prevent digital eye strain and dry eyes.',
        text: 'Low blink rate — remember to blink to prevent dry eyes',
        status: 'warn',
        icon: '👁️',
      };
    }

    // 3. Distance Advice
    const dist = Math.round(telemetry.distanceCm ?? 55);
    const hasTooClose = telemetry.alerts?.some((a) => a.type === 'SCREEN_TOO_CLOSE');
    const hasTooFar = telemetry.alerts?.some((a) => a.type === 'SCREEN_TOO_FAR');
    let distance = {
      title: 'Optimal Screen Distance',
      tip: `${dist} cm — In the healthy 45–75cm ergonomic corridor.`,
      text: `${dist} cm — Comfortable working distance`,
      status: 'good',
      icon: '📏',
    };

    if (hasTooClose) {
      distance = {
        title: 'Screen Too Close',
        tip: `${dist} cm — Leaning too forward. Sit back against your chair.`,
        text: `${dist} cm — Leaning too close, sit back`,
        status: 'warn',
        icon: '⬅️',
      };
    } else if (hasTooFar) {
      distance = {
        title: 'Screen Too Far',
        tip: `${dist} cm — Slouching backward. Position closer to prevent squinting.`,
        text: `${dist} cm — Slouching back, adjust closer`,
        status: 'warn',
        icon: '➡️',
      };
    }

    let headline = 'Upright & Balanced';
    if (hasMicrosleep) headline = 'Drowsiness Alert';
    else if (hasForward || hasLateral) headline = 'Adjust Posture';
    else if (hasTooClose || hasTooFar) headline = 'Adjust Distance';

    return { headline, posture, eyes, distance };
  }

  getSnapshot(telemetry = null) {
    const advice = this.getFriendlyAdvice(telemetry);
    const posturePct = this.getUprightPercentage();
    const distancePct = this.totalActiveSec > 0
      ? Math.round((this.goodDistanceSec / this.totalActiveSec) * 100)
      : 100;

    return {
      score: this.currentScore,
      grade: this.currentGrade,
      totalActiveSec: Math.round(this.totalActiveSec),
      goodPosturePct: posturePct,
      goodDistancePct: distancePct,
      totalBlinks: this.totalBlinks,
      advice,
    };
  }

  /**
   * Generates a report formatted as plain text, JSON, or printable HTML.
   * @param {'text' | 'json' | 'html'} [format='text']
   * @returns {string} formatted report
   */
  generateReport(format = 'text') {
    const min = Math.floor(this.totalActiveSec / 60);
    const sec = Math.floor(this.totalActiveSec % 60);
    const posturePct = this.getUprightPercentage();
    const distancePct = this.totalActiveSec > 0
      ? Math.round((this.goodDistanceSec / this.totalActiveSec) * 100)
      : 100;
    const avgBlinkRate = min > 0 ? Math.round(this.totalBlinks / min) : this.totalBlinks;
    const dateStr = new Date().toLocaleDateString();

    if (format === 'json') {
      return JSON.stringify(
        {
          title: 'NEUROERGO HUD — DAILY WELLNESS REPORT',
          date: dateStr,
          timestamp: Date.now(),
          duration: {
            minutes: min,
            seconds: sec,
            totalSeconds: Math.round(this.totalActiveSec),
          },
          score: this.currentScore,
          grade: this.currentGrade,
          metrics: {
            goodPosturePct: posturePct,
            healthyDistancePct: distancePct,
            totalBlinks: this.totalBlinks,
            averageBlinkRatePerMin: avgBlinkRate,
          },
          takeaways: [
            posturePct >= 80
              ? 'Excellent neck and spinal posture maintained.'
              : 'Frequent forward head tilt detected. Adjust monitor height.',
            avgBlinkRate >= 12
              ? 'Eye hydration and blink reflexes healthy.'
              : 'Low blink frequency noted during focused work. Practice 20-20-20 breaks.',
          ],
        },
        null,
        2
      );
    }

    if (format === 'html') {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>NeuroErgo HUD — Ergonomic Wellness Report</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; line-height: 1.5; }
    .card { background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; max-width: 680px; margin: 0 auto; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px; }
    .title { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0; }
    .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
    .grade-badge { font-size: 28px; font-weight: 800; background: #ecfdf5; color: #059669; padding: 8px 18px; border-radius: 12px; border: 1px solid #a7f3d0; }
    .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-box { background: #f1f5f9; padding: 14px; border-radius: 8px; }
    .stat-label { font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; }
    .stat-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
    .takeaways { background: #eff6ff; border-left: 4px solid #3b82f6; padding: 14px; border-radius: 6px; margin-top: 20px; font-size: 13px; }
    .footer { font-size: 11px; color: #94a3b8; text-align: center; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
    @media print {
      body { background: #fff; padding: 0; }
      .card { border: none; box-shadow: none; padding: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <h1 class="title">NeuroErgo HUD — Wellness Summary</h1>
        <div class="subtitle">Generated on ${dateStr} · Active Session: ${min}m ${sec}s</div>
      </div>
      <div class="grade-badge">${this.currentGrade} (${this.currentScore})</div>
    </div>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-label">Spine &amp; Posture Alignment</div>
        <div class="stat-val">${posturePct}% Upright</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Optimal Distance (45–75cm)</div>
        <div class="stat-val">${distancePct}% Adherence</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Eye Blinks</div>
        <div class="stat-val">${this.totalBlinks} Blinks</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Blink Frequency</div>
        <div class="stat-val">${avgBlinkRate} blinks/min</div>
      </div>
    </div>
    <div class="takeaways">
      <strong>Clinical &amp; Wellness Insights:</strong>
      <ul style="margin: 8px 0 0 0; padding-left: 18px;">
        <li>${posturePct >= 80 ? '✓ Excellent neck and spinal posture maintained.' : '⚠️ Frequent forward head tilt detected. Adjust monitor height.'}</li>
        <li>${avgBlinkRate >= 12 ? '✓ Eye hydration and blink reflexes healthy.' : '💧 Low blink frequency noted during focused work. Practice 20-20-20 breaks.'}</li>
      </ul>
    </div>
    <div class="footer">Processed 100% on-device via WebAssembly · Zero Cloud Uploads · NeuroErgo HUD</div>
  </div>
</body>
</html>`;
    }

    return `
========================================
    NEUROERGO HUD — DAILY WELLNESS REPORT
========================================
Date: ${dateStr}
Session Duration: ${min}m ${sec}s
Ergonomic Health Grade: ${this.currentGrade} (${this.currentScore}/100)

Detailed Metrics:
----------------------------------------
- Good Posture Ratio: ${posturePct}%
- Healthy Distance Adherence: ${distancePct}%
- Total Eye Blinks Logged: ${this.totalBlinks}
- Average Blink Frequency: ${avgBlinkRate} blinks/min

Key Wellness Takeaways:
----------------------------------------
${posturePct >= 80 ? '✓ Excellent neck and spinal posture maintained.' : '⚠️ Frequent forward head tilt detected. Adjust monitor height.'}
${avgBlinkRate >= 12 ? '✓ Eye hydration and blink reflexes healthy.' : '💧 Low blink frequency noted during focused work. Practice 20-20-20 breaks.'}
========================================
Generated on-device by NeuroErgo HUD.
`.trim();
  }
}
