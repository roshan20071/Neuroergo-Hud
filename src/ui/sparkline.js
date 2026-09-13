/**
 * sparkline.js
 * ---------------------------------------------------------------------------
 * High-performance, zero-dependency 2D canvas sparkline and stability renderer.
 * Renders real-time rolling telemetry buffers (EAR waveforms and screen distance
 * trends) at high refresh rates with cyber neon styling and gradient fills.
 * ---------------------------------------------------------------------------
 */

export class SparklineRenderer {
  /**
   * @param {HTMLCanvasElement} earCanvas
   * @param {HTMLCanvasElement} distCanvas
   * @param {object} [options]
   * @param {number} [options.maxSamples=120] ~15-20s at 6-8 updates/sec
   */
  constructor(earCanvas, distCanvas, options = {}) {
    this.earCanvas = earCanvas;
    this.distCanvas = distCanvas;
    this.earCtx = earCanvas ? earCanvas.getContext('2d') : null;
    this.distCtx = distCanvas ? distCanvas.getContext('2d') : null;

    this.maxSamples = options.maxSamples ?? 120;
    this.earHistory = [];
    this.distHistory = [];
    this.poseHistory = []; // { pitch, yaw, roll }

    // Stability score (0-100)
    this.stabilityScore = 100;
  }

  /**
   * Pushes a new telemetry point into the buffers.
   * @param {object} telemetry
   */
  pushSample(telemetry) {
    if (!telemetry) return;

    if (typeof telemetry.ear === 'number') {
      this.earHistory.push(telemetry.ear);
      if (this.earHistory.length > this.maxSamples) this.earHistory.shift();
    }

    if (typeof telemetry.distanceCm === 'number') {
      this.distHistory.push(telemetry.distanceCm);
      if (this.distHistory.length > this.maxSamples) this.distHistory.shift();
    }

    if (telemetry.headPose) {
      this.poseHistory.push({
        pitch: telemetry.headPose.relPitch ?? telemetry.headPose.pitch ?? 0,
        roll: telemetry.headPose.relRoll ?? telemetry.headPose.roll ?? 0,
        yaw: telemetry.headPose.relYaw ?? telemetry.headPose.yaw ?? 0,
      });
      if (this.poseHistory.length > this.maxSamples) this.poseHistory.shift();
      this._updateStabilityScore();
    }
  }

  _updateStabilityScore() {
    if (this.poseHistory.length < 10) {
      this.stabilityScore = 100;
      return;
    }

    // Calculate variance of head pose angles over recent window
    let sumPitch = 0;
    let sumRoll = 0;
    for (const p of this.poseHistory) {
      sumPitch += p.pitch;
      sumRoll += p.roll;
    }
    const meanPitch = sumPitch / this.poseHistory.length;
    const meanRoll = sumRoll / this.poseHistory.length;

    let varSum = 0;
    for (const p of this.poseHistory) {
      varSum += Math.pow(p.pitch - meanPitch, 2) + Math.pow(p.roll - meanRoll, 2);
    }
    const stdDev = Math.sqrt(varSum / this.poseHistory.length);

    // Map standard deviation: 0-2 deg -> 100%, 15+ deg -> 30%
    const score = Math.max(25, Math.min(100, Math.round(100 - (stdDev / 12) * 65)));
    this.stabilityScore = score;
  }

  getStabilityScore() {
    return this.stabilityScore;
  }

  render() {
    if (this.earCtx && this.earCanvas) {
      this._renderEar();
    }
    if (this.distCtx && this.distCanvas) {
      this._renderDistance();
    }
  }

  _renderEar() {
    const ctx = this.earCtx;
    const w = this.earCanvas.width;
    const h = this.earCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (this.earHistory.length < 2) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText('Awaiting EAR samples…', 8, h / 2 + 3);
      return;
    }

    // Draw reference threshold line (y ~ 0.21)
    const minEar = 0.08;
    const maxEar = 0.42;
    const thresholdEar = 0.21;
    const threshY = h - ((thresholdEar - minEar) / (maxEar - minEar)) * h;

    ctx.strokeStyle = 'rgba(255, 77, 109, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw EAR waveform
    const step = w / (this.maxSamples - 1);
    const startX = (this.maxSamples - this.earHistory.length) * step;

    ctx.beginPath();
    this.earHistory.forEach((ear, i) => {
      const clamped = Math.max(minEar, Math.min(maxEar, ear));
      const x = startX + i * step;
      const y = h - ((clamped - minEar) / (maxEar - minEar)) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    // Stroke line
    ctx.strokeStyle = '#39F0C0';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#39F0C0';
    ctx.shadowBlur = 5;
    ctx.stroke();

    // Fill gradient under curve
    const lastX = startX + (this.earHistory.length - 1) * step;
    ctx.lineTo(lastX, h);
    ctx.lineTo(startX, h);
    ctx.closePath();
    ctx.shadowBlur = 0;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(57, 240, 192, 0.25)');
    grad.addColorStop(1, 'rgba(57, 240, 192, 0.01)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  _renderDistance() {
    const ctx = this.distCtx;
    const w = this.distCanvas.width;
    const h = this.distCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (this.distHistory.length < 2) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText('Awaiting distance samples…', 8, h / 2 + 3);
      return;
    }

    const minCm = 25;
    const maxCm = 100;
    const toY = (cm) => h - ((Math.max(minCm, Math.min(maxCm, cm)) - minCm) / (maxCm - minCm)) * (h - 8) - 4;

    // Draw healthy corridor: 45cm to 75cm
    const yTop = toY(75);
    const yBottom = toY(45);
    ctx.fillStyle = 'rgba(42, 139, 255, 0.08)';
    ctx.fillRect(0, yTop, w, Math.max(2, yBottom - yTop));
    ctx.strokeStyle = 'rgba(42, 139, 255, 0.25)';
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1;
    ctx.strokeRect(0, yTop, w, Math.max(2, yBottom - yTop));
    ctx.setLineDash([]);

    // Draw distance curve
    const step = w / (this.maxSamples - 1);
    const startX = (this.maxSamples - this.distHistory.length) * step;

    ctx.beginPath();
    this.distHistory.forEach((cm, i) => {
      const x = startX + i * step;
      const y = toY(cm);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.strokeStyle = '#2A8BFF';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#2A8BFF';
    ctx.shadowBlur = 5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Gradient fill
    const lastX = startX + (this.distHistory.length - 1) * step;
    ctx.lineTo(lastX, h);
    ctx.lineTo(startX, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(42, 139, 255, 0.2)');
    grad.addColorStop(1, 'rgba(42, 139, 255, 0.01)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
}
