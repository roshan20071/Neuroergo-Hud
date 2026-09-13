/**
 * romEngine.js
 * ---------------------------------------------------------------------------
 * Clinical Cervical Spine Range of Motion (ROM) assessment protocol.
 * For orthopedic clinics, physical therapy rehabilitation, and stroke recovery.
 *
 * Measures:
 * - Cervical Rotation (Yaw, Left / Right) — Normal: 70°–90°
 * - Cervical Flexion & Extension (Pitch Down / Up) — Normal: 45°–60° / 50°–70°
 * - Lateral Flexion / Side Bending (Roll, Left / Right) — Normal: 40°–45°
 * - Bilateral Rotation & Lateral Symmetry percentages and clinical deficit classification.
 * ---------------------------------------------------------------------------
 */

export const ROM_STEPS = [
  {
    id: 'READY',
    title: 'Baseline Calibration',
    instruction: 'Sit comfortably upright, looking directly at the camera at eye level.',
    actionText: 'Tare Neutral Baseline',
    actionLabel: 'Tare Neutral Baseline',
  },
  {
    id: 'LEFT_ROTATION',
    title: 'Left Cervical Rotation',
    instruction: 'Slowly turn your head to the LEFT as far as pain-free and comfortable.',
    actionText: 'Capture Left Rotation',
    actionLabel: 'Capture Left Rotation',
  },
  {
    id: 'RIGHT_ROTATION',
    title: 'Right Cervical Rotation',
    instruction: 'Slowly turn your head to the RIGHT as far as pain-free and comfortable.',
    actionText: 'Capture Right Rotation',
    actionLabel: 'Capture Right Rotation',
  },
  {
    id: 'LATERAL_FLEXION',
    title: 'Lateral Flexion (Side Bend)',
    instruction: 'Gently tilt your LEFT ear toward your left shoulder, then your RIGHT ear toward your right shoulder.',
    actionText: 'Capture Lateral Flexion',
    actionLabel: 'Capture Lateral Flexion',
  },
  {
    id: 'FLEXION_EXTENSION',
    title: 'Flexion & Extension',
    instruction: 'Gently tilt your chin DOWN toward your chest, then tilt UP toward ceiling.',
    actionText: 'Complete Assessment',
    actionLabel: 'Complete Assessment',
  },
  {
    id: 'COMPLETE',
    title: 'Assessment Complete',
    instruction: 'Range of Motion assessment finished. Review clinical metrics below.',
    actionText: 'Restart Test',
    actionLabel: 'Restart Test',
  },
];

export class ROMEngine {
  constructor() {
    this.currentStepIndex = 0;
    this.neutralBaseline = { pitch: 0, yaw: 0, roll: 0 };
    this.isTareComplete = false;

    this._liveAngles = { yaw: 0, pitch: 0, roll: 0 };

    // Peak recorded angles in degrees
    this.results = {
      maxLeftYaw: 0,
      maxRightYaw: 0,
      maxFlexionPitch: 0,
      maxExtensionPitch: 0,
      maxLeftRoll: 0,
      maxRightRoll: 0,
      rotationSymmetryPct: 100,
      lateralSymmetryPct: 100,
    };

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  get steps() {
    return ROM_STEPS;
  }

  get liveAngles() {
    return this._liveAngles;
  }

  get measurements() {
    return {
      peakLeftYaw: this.results.maxLeftYaw,
      peakRightYaw: this.results.maxRightYaw,
      peakFlexion: this.results.maxFlexionPitch,
      peakExtension: this.results.maxExtensionPitch,
      peakLeftRoll: this.results.maxLeftRoll,
      peakRightRoll: this.results.maxRightRoll,
      bilateralSymmetry: this.results.rotationSymmetryPct,
      lateralSymmetry: this.results.lateralSymmetryPct,
    };
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  getCurrentStep() {
    return ROM_STEPS[this.currentStepIndex];
  }

  tare(headPose) {
    if (headPose) {
      this.neutralBaseline = {
        pitch: headPose.pitch ?? 0,
        yaw: headPose.yaw ?? 0,
        roll: headPose.roll ?? 0,
      };
    }
    this.isTareComplete = true;
    this.currentStepIndex = 1; // Move to Left Rotation
    this.emit('stepChange', this.getCurrentStep());
  }

  /**
   * Advances to next assessment step or resets if at completion.
   * @returns {boolean} true if assessment just completed
   */
  nextStep() {
    if (this.currentStepIndex < ROM_STEPS.length - 1) {
      this.currentStepIndex++;
      const isComplete = this.currentStepIndex === ROM_STEPS.length - 1;
      if (isComplete) {
        this._finalizeMetrics();
      }
      this.emit('stepChange', this.getCurrentStep());
      return isComplete;
    } else {
      this.reset();
      return false;
    }
  }

  reset() {
    this.currentStepIndex = 0;
    this.isTareComplete = false;
    this.neutralBaseline = { pitch: 0, yaw: 0, roll: 0 };
    this._liveAngles = { yaw: 0, pitch: 0, roll: 0 };
    this.results = {
      maxLeftYaw: 0,
      maxRightYaw: 0,
      maxFlexionPitch: 0,
      maxExtensionPitch: 0,
      maxLeftRoll: 0,
      maxRightRoll: 0,
      rotationSymmetryPct: 100,
      lateralSymmetryPct: 100,
    };
    this.emit('stepChange', this.getCurrentStep());
  }

  /**
   * Evaluates relative angle from baseline and updates peak tracking.
   * @param {{pitch: number, yaw: number, roll: number}} rawPose
   */
  update(rawPose) {
    if (!rawPose) return this.results;

    const relYaw = (rawPose.yaw ?? 0) - this.neutralBaseline.yaw;
    const relPitch = (rawPose.pitch ?? 0) - this.neutralBaseline.pitch;
    const relRoll = (rawPose.roll ?? 0) - this.neutralBaseline.roll;

    this._liveAngles = {
      yaw: relYaw,
      pitch: relPitch,
      roll: relRoll,
    };

    const step = this.getCurrentStep();

    if (step.id === 'LEFT_ROTATION') {
      // In mirrored selfie camera, turning head left gives negative yaw
      const leftDeg = Math.max(0, -relYaw);
      if (leftDeg > this.results.maxLeftYaw) {
        this.results.maxLeftYaw = Math.round(leftDeg);
      }
    } else if (step.id === 'RIGHT_ROTATION') {
      const rightDeg = Math.max(0, relYaw);
      if (rightDeg > this.results.maxRightYaw) {
        this.results.maxRightYaw = Math.round(rightDeg);
      }
    } else if (step.id === 'LATERAL_FLEXION') {
      const leftRollDeg = Math.max(0, -relRoll);
      const rightRollDeg = Math.max(0, relRoll);
      if (leftRollDeg > this.results.maxLeftRoll) {
        this.results.maxLeftRoll = Math.round(leftRollDeg);
      }
      if (rightRollDeg > this.results.maxRightRoll) {
        this.results.maxRightRoll = Math.round(rightRollDeg);
      }
    } else if (step.id === 'FLEXION_EXTENSION') {
      const flexionDeg = Math.max(0, relPitch); // Chin down
      const extensionDeg = Math.max(0, -relPitch); // Chin up
      if (flexionDeg > this.results.maxFlexionPitch) {
        this.results.maxFlexionPitch = Math.round(flexionDeg);
      }
      if (extensionDeg > this.results.maxExtensionPitch) {
        this.results.maxExtensionPitch = Math.round(extensionDeg);
      }
    }

    return {
      currentRelAngles: {
        yaw: Math.round(relYaw),
        pitch: Math.round(relPitch),
        roll: Math.round(relRoll),
      },
      results: this.results,
    };
  }

  _finalizeMetrics() {
    const left = this.results.maxLeftYaw;
    const right = this.results.maxRightYaw;
    if (left > 0 || right > 0) {
      const maxVal = Math.max(left, right);
      const minVal = Math.min(left, right);
      this.results.rotationSymmetryPct = Math.round((minVal / maxVal) * 100);
    } else {
      this.results.rotationSymmetryPct = 100;
    }

    const leftRoll = this.results.maxLeftRoll;
    const rightRoll = this.results.maxRightRoll;
    if (leftRoll > 0 || rightRoll > 0) {
      const maxRoll = Math.max(leftRoll, rightRoll);
      const minRoll = Math.min(leftRoll, rightRoll);
      this.results.lateralSymmetryPct = Math.round((minRoll / maxRoll) * 100);
    } else {
      this.results.lateralSymmetryPct = 100;
    }
  }

  generateReport() {
    return this.generateClinicalReport();
  }

  generateClinicalReport() {
    const r = this.results;
    const normRotation = '70°–90°';
    const normLateral = '40°–45°';
    const normFlexion = '45°–60°';
    const normExtension = '50°–70°';

    const getStatus = (val, minTarget) => (val >= minTarget ? 'Within Normal Limits (WNL)' : 'Restricted Motion');

    return `
=====================================================
    CERVICAL SPINE RANGE OF MOTION (ROM) REPORT
=====================================================
Evaluation Date: ${new Date().toLocaleDateString()}
Device / Engine: NeuroErgo Biometric Telemetry (WASM)

Active Motion Measurements:
-----------------------------------------------------
1. Left Cervical Rotation:   ${r.maxLeftYaw}°   (Norm: ${normRotation}) -> ${getStatus(r.maxLeftYaw, 65)}
2. Right Cervical Rotation:  ${r.maxRightYaw}°  (Norm: ${normRotation}) -> ${getStatus(r.maxRightYaw, 65)}
3. Left Lateral Flexion:     ${r.maxLeftRoll}°  (Norm: ${normLateral})  -> ${getStatus(r.maxLeftRoll, 35)}
4. Right Lateral Flexion:    ${r.maxRightRoll}° (Norm: ${normLateral})  -> ${getStatus(r.maxRightRoll, 35)}
5. Cervical Flexion (Down):  ${r.maxFlexionPitch}°  (Norm: ${normFlexion})  -> ${getStatus(r.maxFlexionPitch, 40)}
6. Cervical Extension (Up):  ${r.maxExtensionPitch}° (Norm: ${normExtension}) -> ${getStatus(r.maxExtensionPitch, 45)}

Symmetry Analysis:
-----------------------------------------------------
- Bilateral Rotation Symmetry: ${r.rotationSymmetryPct}%
${
  r.rotationSymmetryPct >= 85
    ? '✓ Symmetrical bilateral cervical rotation mobility observed.'
    : `⚠️ Noticeable bilateral rotation asymmetry (${100 - r.rotationSymmetryPct}% deficit).`
}
- Bilateral Lateral Flexion Symmetry: ${r.lateralSymmetryPct}%
${
  r.lateralSymmetryPct >= 85
    ? '✓ Symmetrical lateral flexion mobility observed.'
    : `⚠️ Noticeable lateral flexion asymmetry (${100 - r.lateralSymmetryPct}% deficit).`
}
=====================================================
Report generated on-device via NeuroErgo HUD.
`.trim();
  }
}
