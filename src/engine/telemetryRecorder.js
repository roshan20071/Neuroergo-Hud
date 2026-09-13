/**
 * telemetryRecorder.js
 * ---------------------------------------------------------------------------
 * Pure logic module for recording, summarizing, and exporting time-series
 * ergonomic and gesture telemetry samples.
 *
 * Fully decoupled from DOM / MediaPipe / WebGL, making it 100% unit testable.
 * ---------------------------------------------------------------------------
 */

export class TelemetryRecorder {
  /**
   * @param {{ maxSamples?: number }} [options]
   */
  constructor(options = {}) {
    this.maxSamples = options.maxSamples ?? 100000;
    this.isRecording = false;
    this.startTimeMs = null;
    this.stopTimeMs = null;
    /** @type {Array<object>} */
    this.samples = [];
  }

  /**
   * Starts a new recording session.
   * @param {number} [timestampMs]
   */
  start(timestampMs = performance.now()) {
    this.isRecording = true;
    this.startTimeMs = timestampMs;
    this.stopTimeMs = null;
    this.samples = [];
  }

  /**
   * Records a single telemetry frame.
   * @param {object} telemetry output of ErgonomicsEngine.update()
   * @param {string} [gestureState] current gesture state
   * @param {number} [timestampMs] current frame timestamp
   */
  recordFrame(telemetry = {}, gestureState = 'IDLE', timestampMs = performance.now()) {
    if (!this.isRecording || this.startTimeMs === null) return null;
    if (this.samples.length >= this.maxSamples) return null;

    const t = telemetry || {};
    const elapsedMs = Math.max(0, timestampMs - this.startTimeMs);
    const elapsedSec = elapsedMs / 1000;

    const sample = {
      elapsedSec: Number(elapsedSec.toFixed(3)),
      ear: Number((t.ear ?? 0).toFixed(3)),
      blinkCount: Number(t.blinkCount ?? 0),
      blinkRatePerMin: Number((t.blinkRatePerMin ?? 0).toFixed(1)),
      distanceCm: Number((t.distanceCm ?? 0).toFixed(1)),
      pitch: Number((t.headPose?.pitch ?? 0).toFixed(1)),
      yaw: Number((t.headPose?.yaw ?? 0).toFixed(1)),
      roll: Number((t.headPose?.roll ?? 0).toFixed(1)),
      gesture: gestureState || 'IDLE',
      alerts: (t.alerts || []).map((a) => a.type).join(';') || 'NONE',
    };

    this.samples.push(sample);
    return sample;
  }

  /**
   * Stops the recording session and returns session summary.
   * @param {number} [timestampMs]
   * @returns {object} session summary
   */
  stop(timestampMs = performance.now()) {
    if (!this.isRecording) return this.getSummary();
    this.isRecording = false;
    this.stopTimeMs = timestampMs;
    return this.getSummary();
  }

  /**
   * Computes statistics and summaries across all recorded samples.
   * @returns {object}
   */
  getSummary() {
    const count = this.samples.length;
    const durationSec = this.startTimeMs !== null
      ? Math.max(0, ((this.stopTimeMs ?? performance.now()) - this.startTimeMs) / 1000)
      : 0;

    if (count === 0) {
      return {
        durationSec: Number(durationSec.toFixed(1)),
        sampleCount: 0,
        avgFps: 0,
        avgEar: 0,
        avgDistanceCm: 0,
        alertCounts: {},
      };
    }

    let sumEar = 0;
    let sumDist = 0;
    const alertCounts = {};

    for (const s of this.samples) {
      sumEar += s.ear;
      sumDist += s.distanceCm;
      if (s.alerts && s.alerts !== 'NONE') {
        const types = s.alerts.split(';');
        for (const t of types) {
          alertCounts[t] = (alertCounts[t] || 0) + 1;
        }
      }
    }

    const avgFps = durationSec > 0 ? Number((count / durationSec).toFixed(1)) : 0;

    const totalBlinks = count > 0 ? (this.samples[count - 1].blinkCount ?? 0) : 0;

    return {
      durationSec: Number(durationSec.toFixed(1)),
      sampleCount: count,
      avgFps,
      totalBlinks,
      avgEar: Number((sumEar / count).toFixed(3)),
      avgDistanceCm: Number((sumDist / count).toFixed(1)),
      alertCounts,
    };
  }

  /**
   * Formats recorded telemetry into CSV format.
   * @returns {string} CSV text
   */
  toCSV() {
    const headers = [
      'elapsed_sec',
      'eye_aspect_ratio',
      'blink_count',
      'blink_rate_per_min',
      'screen_distance_cm',
      'pitch_deg',
      'yaw_deg',
      'roll_deg',
      'gesture_state',
      'alerts',
    ];

    const rows = this.samples.map((s) => [
      s.elapsedSec,
      s.ear,
      s.blinkCount ?? 0,
      s.blinkRatePerMin,
      s.distanceCm,
      s.pitch,
      s.yaw,
      s.roll,
      `"${s.gesture}"`,
      `"${s.alerts}"`,
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Formats recorded telemetry into JSON format with metadata.
   * @returns {string} JSON string
   */
  toJSON() {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        summary: this.getSummary(),
        samples: this.samples,
      },
      null,
      2
    );
  }
}
