/**
 * smoothing.js
 * ---------------------------------------------------------------------------
 * Signal-processing layer that stabilizes raw MediaPipe landmark jitter
 * before it reaches the ergonomics/gesture engines or the renderer.
 *
 * Two filter families are provided:
 *
 *  - EMAFilter: a first-order exponential moving average. Cheap, O(1) per
 *    sample, but inherently lags a moving signal by an amount proportional
 *    to (1 - alpha).
 *
 *  - DoubleExponentialFilter: Holt's linear trend method ("double
 *    exponential smoothing"). It tracks both a level and a trend estimate,
 *    which lets it extrapolate one step ahead (`predict()`) to cancel out
 *    most of the lag an EMA would otherwise introduce -- this is what the
 *    project brief means by smoothing "without adding latency": the filter
 *    still has a single-pole response to noise, but its *reported* value is
 *    forecast forward by the current trend rather than always trailing the
 *    raw signal.
 *
 * Both filters are scalar; LandmarkSmoother composes three (x, y, z) of
 * whichever scalar filter is selected to smooth full landmark points, and
 * manages one filter-triplet per landmark index across frames.
 * ---------------------------------------------------------------------------
 */

/**
 * First-order exponential moving average.
 *
 *   S_t = alpha * x_t + (1 - alpha) * S_{t-1}
 *
 * Higher alpha tracks the raw signal more closely (less smoothing, less
 * lag); lower alpha smooths more aggressively at the cost of lag.
 */
export class EMAFilter {
  /** @param {number} alpha smoothing factor in (0, 1] */
  constructor(alpha = 0.5) {
    if (alpha <= 0 || alpha > 1) throw new Error('EMAFilter alpha must be in (0, 1]');
    this.alpha = alpha;
    this.value = null;
  }

  /**
   * Feeds one new raw sample and returns the updated smoothed value.
   * @param {number} x
   * @returns {number}
   */
  update(x) {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }

  /** Predicts the value `steps` frames ahead. A plain EMA has no trend
   * model, so its best estimate of the future is simply its current level.
   * @param {number} [steps]
   * @returns {number}
   */
  predict(steps = 1) {
    return this.value ?? 0;
  }

  reset() {
    this.value = null;
  }
}

/**
 * Holt's double exponential smoothing: tracks a level and a trend so that
 * the filter can extrapolate forward and counteract the lag a single-pole
 * EMA would introduce on a moving landmark.
 *
 *   S_t = alpha * x_t + (1 - alpha) * (S_{t-1} + b_{t-1})
 *   b_t = beta  * (S_t - S_{t-1})   + (1 - beta)  * b_{t-1}
 *
 * `update()` returns S_t (the de-noised current estimate). `predict(k)`
 * returns S_t + k * b_t, an extrapolated estimate k frames into the future,
 * which is what a caller should render if it wants to hide filter latency
 * entirely rather than just reduce it.
 */
export class DoubleExponentialFilter {
  /**
   * @param {number} alpha level smoothing factor in (0, 1]
   * @param {number} beta trend smoothing factor in (0, 1]
   */
  constructor(alpha = 0.5, beta = 0.3) {
    if (alpha <= 0 || alpha > 1) throw new Error('alpha must be in (0, 1]');
    if (beta <= 0 || beta > 1) throw new Error('beta must be in (0, 1]');
    this.alpha = alpha;
    this.beta = beta;
    this.level = null;
    this.trend = 0;
  }

  /**
   * @param {number} x raw sample
   * @returns {number} smoothed level estimate
   */
  update(x) {
    if (this.level === null) {
      this.level = x;
      this.trend = 0;
      return this.level;
    }
    const prevLevel = this.level;
    this.level = this.alpha * x + (1 - this.alpha) * (this.level + this.trend);
    this.trend = this.beta * (this.level - prevLevel) + (1 - this.beta) * this.trend;
    return this.level;
  }

  /**
   * @param {number} [steps]
   * @returns {number} level + steps * trend
   */
  predict(steps = 1) {
    if (this.level === null) return 0;
    return this.level + steps * this.trend;
  }

  reset() {
    this.level = null;
    this.trend = 0;
  }
}

/**
 * Smooths a single {x, y, z?} point by running one scalar filter per axis.
 * @private
 */
class VectorSmoother {
  /**
   * @param {'ema' | 'double'} kind
   * @param {number} alpha
   * @param {number} beta only used when kind === 'double'
   */
  constructor(kind, alpha, beta) {
    const make = () => (kind === 'double' ? new DoubleExponentialFilter(alpha, beta) : new EMAFilter(alpha));
    this.x = make();
    this.y = make();
    this.z = make();
    this.hasZ = false;
  }

  /** @param {import('../math/vectorUtils.js').Point} point @returns {import('../math/vectorUtils.js').Point} */
  update(point) {
    const out = { x: this.x.update(point.x), y: this.y.update(point.y) };
    if (point.z !== undefined) {
      this.hasZ = true;
      out.z = this.z.update(point.z);
    }
    return out;
  }

  /** @param {number} [steps] */
  predict(steps = 1) {
    const out = { x: this.x.predict(steps), y: this.y.predict(steps) };
    if (this.hasZ) out.z = this.z.predict(steps);
    return out;
  }
}

/**
 * Manages a lazily-allocated bank of VectorSmoothers, one per landmark
 * index, so a full 468-point face mesh or 21-point hand skeleton can be
 * smoothed frame-to-frame with a single call. Filters are created on first
 * use and persist for the lifetime of the LandmarkSmoother instance,
 * matching each landmark index to its own temporal history.
 */
export class LandmarkSmoother {
  /**
   * @param {{kind?: 'ema' | 'double', alpha?: number, beta?: number}} [options]
   */
  constructor({ kind = 'double', alpha = 0.5, beta = 0.3 } = {}) {
    this.kind = kind;
    this.alpha = alpha;
    this.beta = beta;
    /** @type {Map<number, VectorSmoother>} */
    this._smoothers = new Map();
  }

  /** @private */
  _get(index) {
    let s = this._smoothers.get(index);
    if (!s) {
      s = new VectorSmoother(this.kind, this.alpha, this.beta);
      this._smoothers.set(index, s);
    }
    return s;
  }

  /**
   * Smooths an ordered array of landmark points, returning a same-length
   * array of smoothed points. Landmark identity is assumed to be encoded by
   * array position (true for MediaPipe's fixed-topology outputs).
   * @param {import('../math/vectorUtils.js').Point[]} points
   * @returns {import('../math/vectorUtils.js').Point[]}
   */
  smoothAll(points) {
    return points.map((p, i) => this._get(i).update(p));
  }

  /**
   * Returns a one-step-ahead (or `steps`-ahead) forecast for every tracked
   * landmark without consuming a new sample -- useful for a render tick
   * that runs slightly out of phase with the inference tick.
   * @param {number} [steps]
   * @returns {import('../math/vectorUtils.js').Point[]}
   */
  predictAll(steps = 1) {
    return Array.from(this._smoothers.values()).map((s) => s.predict(steps));
  }

  /** Clears all per-landmark history, e.g. when a face/hand re-enters the frame after being lost. */
  reset() {
    this._smoothers.clear();
  }
}
