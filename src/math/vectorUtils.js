/**
 * vectorUtils.js
 * ---------------------------------------------------------------------------
 * Core mathematical primitives for NeuroErgo HUD.
 *
 * This module is intentionally framework-agnostic: it has no dependency on
 * MediaPipe, Three.js, or the DOM. Every function operates on plain
 * `{x, y, z?}` point objects or plain arrays, which keeps it trivially unit
 * testable in Node (see tests/math.test.js) and reusable from a Worker
 * thread if the inference loop is ever moved off the main thread.
 *
 * Coordinate convention: unless otherwise stated, points are expected in the
 * normalized image space MediaPipe emits (x, y in [0, 1] relative to frame
 * width/height, z roughly proportional to distance from the camera plane,
 * scaled similarly to x). Functions that need pixel units take an explicit
 * frame width/height parameter rather than assuming one.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Basic vector algebra
// ---------------------------------------------------------------------------

/** @typedef {{x: number, y: number, z?: number}} Point */

/**
 * Component-wise subtraction: a - b. Preserves z only if both inputs have it.
 * @param {Point} a
 * @param {Point} b
 * @returns {Point}
 */
export function subtract(a, b) {
  const out = { x: a.x - b.x, y: a.y - b.y };
  if (a.z !== undefined && b.z !== undefined) out.z = a.z - b.z;
  return out;
}

/** @param {Point} a @param {Point} b @returns {Point} */
export function add(a, b) {
  const out = { x: a.x + b.x, y: a.y + b.y };
  if (a.z !== undefined && b.z !== undefined) out.z = a.z + b.z;
  return out;
}

/** @param {Point} a @param {number} s @returns {Point} */
export function scale(a, s) {
  const out = { x: a.x * s, y: a.y * s };
  if (a.z !== undefined) out.z = a.z * s;
  return out;
}

/**
 * Euclidean distance between two points. Works for 2D or 3D points
 * transparently -- if either point lacks a z component, the comparison
 * degrades gracefully to 2D.
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z !== undefined && b.z !== undefined ? a.z - b.z : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** @param {Point} v @returns {number} */
export function magnitude(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + (v.z ?? 0) * (v.z ?? 0));
}

/**
 * Returns a unit-length copy of v. If v is (near) the zero vector, returns
 * a zero vector rather than dividing by zero / producing NaNs, since a
 * degenerate frame (e.g. a dropped landmark) should not poison downstream
 * state.
 * @param {Point} v
 * @returns {Point}
 */
export function normalize(v) {
  const m = magnitude(v);
  if (m < 1e-9) {
    return v.z !== undefined ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0 };
  }
  const out = { x: v.x / m, y: v.y / m };
  if (v.z !== undefined) out.z = v.z / m;
  return out;
}

/** @param {Point} a @param {Point} b @returns {number} */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

/**
 * 3D cross product. Missing z components are treated as 0, so this also
 * works as the "2D cross product" (returning a vector whose z is the scalar
 * 2D cross) when called with planar points.
 * @param {Point} a
 * @param {Point} b
 * @returns {Point}
 */
export function cross(a, b) {
  const az = a.z ?? 0;
  const bz = b.z ?? 0;
  return {
    x: a.y * bz - az * b.y,
    y: az * b.x - a.x * bz,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Clamp a value into [min, max]. @param {number} v @param {number} min @param {number} max */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const RAD2DEG = 180 / Math.PI;

/**
 * Orthogonalize vector `v` against unit vector `ref` via a single
 * Gram-Schmidt projection step, then re-normalize. Used to keep the head's
 * local basis vectors mutually perpendicular even though the raw anchor
 * vectors measured from landmarks are only approximately so.
 * @param {Point} v
 * @param {Point} ref unit vector
 * @returns {Point} unit vector orthogonal to ref
 */
export function orthogonalize(v, ref) {
  const proj = dot(v, ref);
  const rejected = subtract(v, scale(ref, proj));
  return normalize(rejected);
}

// ---------------------------------------------------------------------------
// Eye Aspect Ratio (EAR)
// ---------------------------------------------------------------------------

/**
 * Computes the Eye Aspect Ratio for a single eye given its six landmark
 * points, ordered as in the classic Soukupová & Čech formulation:
 *
 *   p1 -- outer corner
 *   p2, p3 -- upper lid
 *   p4 -- inner corner
 *   p5, p6 -- lower lid
 *
 *            ||p2 - p6|| + ||p3 - p5||
 *   EAR  =  ---------------------------
 *                 2 * ||p1 - p4||
 *
 * EAR stays roughly constant while the eye is open and collapses toward
 * zero as the lids close, which makes it a robust scalar signal for blink
 * and micro-sleep detection without needing a trained classifier.
 *
 * @param {[Point, Point, Point, Point, Point, Point]} eyePoints exactly six points [p1..p6]
 * @returns {number} the eye aspect ratio (dimensionless)
 */
export function calculateEAR(eyePoints) {
  if (!eyePoints || eyePoints.length !== 6) {
    throw new Error('calculateEAR requires exactly 6 landmark points [p1..p6]');
  }
  const [p1, p2, p3, p4, p5, p6] = eyePoints;
  // EAR is mathematically defined in 2D image plane coordinates (Soukupová & Čech, 2016).
  // Monocular depth (z) introduces relative eyelid depth-offset noise that prevents
  // the ratio from dropping during eye closures.
  const vertical1 = Math.hypot(p2.x - p6.x, p2.y - p6.y);
  const vertical2 = Math.hypot(p3.x - p5.x, p3.y - p5.y);
  const horizontal = Math.hypot(p1.x - p4.x, p1.y - p4.y);
  if (horizontal < 1e-9) return 0; // degenerate frame guard
  return (vertical1 + vertical2) / (2 * horizontal);
}

// ---------------------------------------------------------------------------
// Head pose estimation
// ---------------------------------------------------------------------------

/**
 * Estimates head orientation (pitch, yaw, roll) from five facial anchor
 * points using pure vector geometry rather than an iterative PnP solve.
 *
 * Rationale: a textbook solvePnP requires a calibrated camera intrinsic
 * matrix (focal length in pixels, principal point, lens distortion), which
 * is rarely available for an arbitrary consumer webcam without an explicit
 * calibration step. Instead we build an orthonormal basis directly from
 * anatomical anchor vectors, which is calibration-free and numerically
 * stable for the near-frontal ranges relevant to desk ergonomics
 * (roughly +/-45 degrees), at the cost of accuracy for extreme profile
 * views. This is a deliberate, documented trade-off -- see README
 * "Assumptions & Limitations".
 *
 * Basis construction:
 *   1. right  = normalize(rightTragus - leftTragus)              -- the ear-to-ear axis
 *   2. down   = orthogonalize(chin - glabella, right)             -- vertical axis, Gram-Schmidt
 *              corrected to be perpendicular to `right`
 *   3. forward = normalize(cross(right, down))                    -- completes a right-handed,
 *              orthonormal basis; points out of the face toward the camera
 *
 * Euler angle extraction (yaw/pitch from the forward "face normal", roll
 * from the in-plane tilt of the ear-to-ear axis):
 *   yaw   = atan2(forward.x, forward.z)
 *   pitch = atan2(-forward.y, sqrt(forward.x^2 + forward.z^2))
 *   roll  = atan2(right.y, right.x)
 *
 * @param {{noseTip: Point, chin: Point, leftTragus: Point, rightTragus: Point, glabella: Point}} anchors
 * @returns {{pitch: number, yaw: number, roll: number, basis: {right: Point, down: Point, forward: Point}}}
 *          angles in degrees. pitch > 0 = looking down, yaw > 0 = turned to
 *          the viewer's left (subject's right), roll > 0 = head tilted
 *          clockwise from the viewer's perspective.
 */
export function computeHeadPose({ noseTip, chin, leftTragus, rightTragus, glabella }) {
  const right = normalize(subtract(rightTragus, leftTragus));
  const downRaw = subtract(chin, glabella);
  const down = orthogonalize(downRaw, right);
  const forward = normalize(cross(right, down));

  const yaw = Math.atan2(forward.x, forward.z || 1e-9) * RAD2DEG;
  const pitch =
    Math.atan2(-forward.y, Math.sqrt(forward.x * forward.x + forward.z * forward.z) || 1e-9) *
    RAD2DEG;
  const roll = Math.atan2(right.y, right.x) * RAD2DEG;

  // noseTip is currently unused by the angle formulas themselves but is kept
  // in the signature (and returned) because it is the natural attachment
  // point for rendering the pose's forward-vector gizmo in the HUD, and
  // because a richer PnP-style solve is the natural next iteration of this
  // module -- see README "Future Work".
  return { pitch, yaw, roll, basis: { right, down, forward }, noseTip };
}

// ---------------------------------------------------------------------------
// Interpupillary-distance based screen-distance estimation
// ---------------------------------------------------------------------------

/** Average adult interpupillary distance, in centimeters. Source: anthropometric surveys report a population mean near this value; used as a default until the user runs the one-time calibration flow. */
export const DEFAULT_IPD_CM = 6.3;

/**
 * Converts a horizontal field-of-view (degrees) and pixel frame width into
 * an equivalent pinhole-camera focal length in pixels:
 *
 *   f_px = (frameWidthPx / 2) / tan(hFovDegrees / 2)
 *
 * @param {number} frameWidthPx
 * @param {number} hFovDegrees
 * @returns {number} focal length in pixels
 */
export function focalLengthFromFov(frameWidthPx, hFovDegrees) {
  return frameWidthPx / 2 / Math.tan((hFovDegrees / 2) * (Math.PI / 180));
}

/**
 * Derives an empirical focal length from a one-time user calibration: the
 * user sits at a known distance from the screen while we measure their
 * pixel IPD. Rearranging the pinhole projection ipd_px = f_px * IPD_cm / D_cm:
 *
 *   f_px = ipd_px * D_cm / IPD_cm
 *
 * @param {number} ipdPx measured pixel distance between pupils at calibration time
 * @param {number} knownDistanceCm distance from eyes to screen at calibration time
 * @param {number} [ipdCm]
 * @returns {number} focal length in pixels
 */
export function calibrateFocalLength(ipdPx, knownDistanceCm, ipdCm = DEFAULT_IPD_CM) {
  if (ipdPx <= 0 || knownDistanceCm <= 0) {
    throw new Error('calibrateFocalLength requires positive ipdPx and knownDistanceCm');
  }
  return (ipdPx * knownDistanceCm) / ipdCm;
}

/**
 * Estimates metric distance from the camera to the user's eyes via the
 * inverse pinhole relationship:
 *
 *   D_cm = (IPD_cm * f_px) / ipd_px
 *
 * @param {number} ipdPx measured pixel distance between the two pupils this frame
 * @param {number} focalLengthPx from calibrateFocalLength() or focalLengthFromFov()
 * @param {number} [ipdCm]
 * @returns {number} estimated distance in centimeters
 */
export function estimateDistanceCm(ipdPx, focalLengthPx, ipdCm = DEFAULT_IPD_CM) {
  if (ipdPx < 1e-6) return Infinity;
  return (ipdCm * focalLengthPx) / ipdPx;
}
