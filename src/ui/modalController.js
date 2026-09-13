/**
 * modalController.js
 * ---------------------------------------------------------------------------
 * Coordinates Distance Calibration Modal, 20-20-20 Break Rest Modal,
 * and Posture Baseline Tare/Reset Controls with immediate localStorage persistence.
 * ---------------------------------------------------------------------------
 */

import { focalLengthFromFov } from '../math/vectorUtils.js';

export const STORAGE_CALIBRATION_KEY = 'neuroergo_calibration';
export const STORAGE_POSTURE_KEY = 'neuroergo_posture_baseline';

export class ModalController {
  constructor(options = {}) {
    this.ergonomicsEngine = options.ergonomicsEngine || null;
    this.breakTimer = options.breakTimer || null;
    this.onFeedbackSound = options.onFeedbackSound || null;
    this.onStatusMessage = options.onStatusMessage || null;

    // DOM References - Calibration
    this.calibrationModal = document.getElementById('calibration-modal');
    this.calibrateBtn = document.getElementById('btn-calibrate');
    this.calModalClose = document.getElementById('cal-modal-close');
    this.calBtnCancel = document.getElementById('cal-btn-cancel');
    this.calBtnApply = document.getElementById('cal-btn-apply');
    this.calBtnReset = document.getElementById('cal-btn-reset');
    this.calLiveIpd = document.getElementById('cal-live-ipd');
    this.calPresetBtns = document.querySelectorAll('.cal-preset-btn');
    this.calCustomCm = document.getElementById('cal-custom-cm');

    // DOM References - Posture Baseline
    this.statBaselineTag = document.getElementById('stat-baseline-tag');
    this.btnTarePosture = document.getElementById('btn-tare-posture');
    this.btnResetPosture = document.getElementById('btn-reset-posture');

    // DOM References - Break Modal
    this.breakModal = document.getElementById('break-modal');
    this.breakCountdownNumber = document.getElementById('break-countdown-number');
    this.breakCountdownCircle = document.getElementById('break-countdown-circle');
    this.breakBtnSkip = document.getElementById('break-btn-skip');
    this.breakBtnComplete = document.getElementById('break-btn-complete');
    this.breakTimerBadge = document.getElementById('break-timer-badge');
    this.breakTimerText = document.getElementById('break-timer-text');
    this.breakDemoTag = document.getElementById('break-demo-tag');

    this.selectedDistanceCm = 55;
    this.currentIpdPx = null;
    this.isTracking = false;

    this.init();
  }

  init() {
    this.bindEvents();
    this.rehydrateSavedState();
  }

  setErgonomicsEngine(engine) {
    this.ergonomicsEngine = engine;
    this.rehydrateSavedState();
  }

  setTrackingState(isTracking) {
    this.isTracking = isTracking;
    this.updateCalLiveIpdDisplay();
  }

  updateLiveIpd(ipdPx) {
    this.currentIpdPx = ipdPx;
    this.updateCalLiveIpdDisplay();
  }

  rehydrateSavedState() {
    // 1. Distance calibration rehydration
    try {
      const savedCal = JSON.parse(localStorage.getItem(STORAGE_CALIBRATION_KEY) || 'null');
      if (savedCal?.focalLengthPx) {
        if (this.ergonomicsEngine) {
          this.ergonomicsEngine.setCalibratedFocalLength(savedCal.focalLengthPx);
        }
        if (this.calibrateBtn) {
          this.calibrateBtn.textContent = `Calibrated (${savedCal.distanceCm ?? 50}cm)`;
          this.calibrateBtn.classList.add('hud-button-active');
        }
      }
    } catch (_) {}

    // 2. Posture baseline rehydration
    try {
      const savedPosture = JSON.parse(localStorage.getItem(STORAGE_POSTURE_KEY) || 'null');
      if (savedPosture && (savedPosture.pitch || savedPosture.yaw || savedPosture.roll)) {
        if (this.ergonomicsEngine) {
          this.ergonomicsEngine.setPostureBaseline(savedPosture);
        }
        this.updatePostureBaselineUI(savedPosture);
      }
    } catch (_) {}
  }

  bindEvents() {
    // Calibration modal open/close
    this.calibrateBtn?.addEventListener('click', () => {
      if (!this.isTracking) {
        if (this.onStatusMessage) this.onStatusMessage('Please start tracking before calibrating');
        return;
      }
      this.openCalibrationModal();
    });

    this.calModalClose?.addEventListener('click', () => this.closeCalibrationModal());
    this.calBtnCancel?.addEventListener('click', () => this.closeCalibrationModal());

    this.calPresetBtns?.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.calPresetBtns.forEach((b) => b.classList.remove('cal-preset-active'));
        btn.classList.add('cal-preset-active');
        const cm = Number(btn.dataset.cm) || 55;
        this.selectedDistanceCm = cm;
        if (this.calCustomCm) this.calCustomCm.value = cm;
      });
    });

    this.calCustomCm?.addEventListener('input', (e) => {
      const cm = Number(e.target.value);
      if (cm >= 20 && cm <= 150) {
        this.selectedDistanceCm = cm;
        this.calPresetBtns?.forEach((b) => {
          b.classList.toggle('cal-preset-active', Number(b.dataset.cm) === cm);
        });
      }
    });

    this.calBtnApply?.addEventListener('click', () => {
      this.applyCalibration(this.selectedDistanceCm);
    });

    this.calBtnReset?.addEventListener('click', () => {
      this.resetCalibration();
    });

    // Posture baseline tare
    this.btnTarePosture?.addEventListener('click', () => {
      if (!this.isTracking || !this.ergonomicsEngine?.lastPose) {
        if (this.onStatusMessage) this.onStatusMessage('Please start tracking with face in frame first');
        return;
      }
      const raw = this.ergonomicsEngine.lastPose;
      const currentPose = {
        pitch: raw.pitch ?? 0,
        yaw: raw.yaw ?? 0,
        roll: raw.roll ?? 0,
      };
      this.ergonomicsEngine.setPostureBaseline(currentPose);
      try {
        localStorage.setItem(STORAGE_POSTURE_KEY, JSON.stringify(currentPose));
      } catch (_) {}
      this.updatePostureBaselineUI(currentPose);
      if (this.onFeedbackSound) this.onFeedbackSound(1050, 60);
      if (this.onStatusMessage) this.onStatusMessage('Posture baseline zeroed to current position');
    });

    this.btnResetPosture?.addEventListener('click', () => {
      this.ergonomicsEngine?.resetPostureBaseline();
      try {
        localStorage.removeItem(STORAGE_POSTURE_KEY);
      } catch (_) {}
      this.updatePostureBaselineUI(null);
      if (this.onFeedbackSound) this.onFeedbackSound(550, 60);
      if (this.onStatusMessage) this.onStatusMessage('Posture baseline reset to camera axis');
    });

    // 20-20-20 Break Timer
    this.breakTimerBadge?.addEventListener('click', () => {
      if (!this.breakTimer) return;
      const isDemo = this.breakTimer.toggleDemoMode();
      this.breakDemoTag?.classList.toggle('hidden', !isDemo);
      if (this.onStatusMessage) {
        this.onStatusMessage(isDemo ? 'Break timer in 20s test mode' : 'Break timer in 20m standard mode');
      }
    });

    this.breakBtnSkip?.addEventListener('click', () => {
      this.breakTimer?.skipBreak();
      this.breakModal?.classList.add('hidden');
    });

    this.breakBtnComplete?.addEventListener('click', () => {
      this.breakTimer?.completeBreak();
      this.breakModal?.classList.add('hidden');
      if (this.onFeedbackSound) this.onFeedbackSound(880, 120);
    });

    if (this.breakTimer) {
      this.breakTimer.on('tick', (status) => {
        if (!this.breakTimerText) return;
        if (status.state === 'WORKING') {
          const m = Math.floor(status.remainingWorkSec / 60);
          const s = (status.remainingWorkSec % 60).toString().padStart(2, '0');
          this.breakTimerText.textContent = `Break in ${m}:${s}`;
        } else if (status.state === 'BREAK_DUE' || status.state === 'ON_BREAK') {
          this.breakTimerText.textContent = `Resting: ${status.remainingBreakSec}s`;
          if (this.breakCountdownNumber) this.breakCountdownNumber.textContent = `${status.remainingBreakSec}s`;
          if (this.breakCountdownCircle) {
            const total = status.breakTargetSec || 20;
            const progress = (total - status.remainingBreakSec) / total;
            const offset = 264 * (1 - progress);
            this.breakCountdownCircle.style.strokeDashoffset = `${offset}`;
          }
        }
      });

      this.breakTimer.on('breakDue', () => {
        this.breakModal?.classList.remove('hidden');
        this.breakTimer.startBreak();
      });

      this.breakTimer.on('breakComplete', () => {
        this.breakModal?.classList.add('hidden');
        if (this.onFeedbackSound) this.onFeedbackSound(880, 120);
      });

      this.breakTimer.on('breakSkipped', () => {
        this.breakModal?.classList.add('hidden');
      });
    }
  }

  openCalibrationModal() {
    if (!this.calibrationModal) return;
    this.calibrationModal.classList.remove('hidden');
    this.updateCalLiveIpdDisplay();
  }

  closeCalibrationModal() {
    if (!this.calibrationModal) return;
    this.calibrationModal.classList.add('hidden');
  }

  updateCalLiveIpdDisplay() {
    if (!this.calLiveIpd) return;
    if (this.currentIpdPx && this.currentIpdPx > 10) {
      this.calLiveIpd.textContent = `${this.currentIpdPx.toFixed(1)} px (Face aligned)`;
      this.calLiveIpd.className = 'font-semibold text-accent';
    } else {
      this.calLiveIpd.textContent = this.isTracking ? 'Align face in camera…' : 'Start tracking first…';
      this.calLiveIpd.className = 'font-semibold text-warn';
    }
  }

  applyCalibration(distanceCm) {
    if (!this.ergonomicsEngine || !this.currentIpdPx || this.currentIpdPx <= 10) {
      alert('Please start tracking and align your face in frame before calibrating.');
      return;
    }
    const focalLengthPx = this.ergonomicsEngine.calibrateDistance(this.currentIpdPx, distanceCm);
    try {
      localStorage.setItem(
        STORAGE_CALIBRATION_KEY,
        JSON.stringify({
          focalLengthPx,
          distanceCm,
          ipdPx: this.currentIpdPx,
          timestamp: Date.now(),
        })
      );
    } catch (_) {}

    if (this.calibrateBtn) {
      this.calibrateBtn.textContent = `Calibrated (${distanceCm}cm)`;
      this.calibrateBtn.classList.add('hud-button-active');
    }
    this.closeCalibrationModal();
    if (this.onStatusMessage) this.onStatusMessage(`Distance calibrated at ${distanceCm}cm`);
    if (this.onFeedbackSound) this.onFeedbackSound(1100, 80);
  }

  resetCalibration() {
    try {
      localStorage.removeItem(STORAGE_CALIBRATION_KEY);
    } catch (_) {}

    if (this.ergonomicsEngine) {
      const feedWidth = this.ergonomicsEngine.frameWidthPx || 1280;
      this.ergonomicsEngine._focalLengthPx = focalLengthFromFov(feedWidth, 60);
      this.ergonomicsEngine._calibrated = false;
    }
    if (this.calibrateBtn) {
      this.calibrateBtn.textContent = 'Calibrate distance';
      this.calibrateBtn.classList.remove('hud-button-active');
    }
    this.closeCalibrationModal();
    if (this.onStatusMessage) this.onStatusMessage('Distance calibration reset to default');
    if (this.onFeedbackSound) this.onFeedbackSound(550, 80);
  }

  updatePostureBaselineUI(baseline) {
    if (!this.statBaselineTag) return;
    if (baseline && (baseline.pitch || baseline.yaw || baseline.roll)) {
      const pSign = baseline.pitch >= 0 ? '+' : '';
      const rSign = baseline.roll >= 0 ? '+' : '';
      this.statBaselineTag.textContent = `P ${pSign}${baseline.pitch.toFixed(0)}° / R ${rSign}${baseline.roll.toFixed(0)}°`;
      this.btnResetPosture?.classList.remove('hidden');
      this.btnTarePosture?.classList.add('hud-button-active');
    } else {
      this.statBaselineTag.textContent = '0° (Camera Axis)';
      this.btnResetPosture?.classList.add('hidden');
      this.btnTarePosture?.classList.remove('hud-button-active');
    }
  }
}
