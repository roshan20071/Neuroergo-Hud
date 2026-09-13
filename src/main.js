/**
 * main.js
 * ---------------------------------------------------------------------------
 * Application entry point. Wires together:
 *   camera stream -> MediaPipe FaceMesh (WASM inference in main window)
 *                 -> MediaPipe Hands (isolated in hidden iframe to eliminate Emscripten collisions)
 *                 -> LandmarkSmoother (EMA / double-exponential filtering)
 *                 -> ErgonomicsEngine + GestureEngine (pure state/logic)
 *                 -> WellnessEngine + AACEngine + ROMEngine (clinical & wellness modules)
 *                 -> HUDRenderer (Three.js overlay) + DOM stat panels + Web Audio
 *                 -> TelemetryRecorder + MediaRecorder (live session recording)
 * ---------------------------------------------------------------------------
 */

import { FaceMesh } from '@mediapipe/face_mesh';
import { computeHeadPose } from './math/vectorUtils.js';
import { LandmarkSmoother } from './filters/smoothing.js';
import { ErgonomicsEngine, FACE_LANDMARKS } from './engine/ergonomicsEngine.js';
import { GestureEngine, HAND_LANDMARKS } from './engine/gestureEngine.js';
import { HUDRenderer, patchWebGLPrecision } from './ui/hudRenderer.js';
import { TelemetryRecorder } from './engine/telemetryRecorder.js';
import { BreakTimer } from './engine/breakTimer.js';
import { SparklineRenderer } from './ui/sparkline.js';
import { WellnessEngine } from './engine/wellnessEngine.js';
import { AACEngine } from './engine/aacEngine.js';
import { ROMEngine } from './engine/romEngine.js';

// Extracted I/O & Controller modules
import { CameraManager } from './io/cameraManager.js';
import { AudioSynthesizer, ALERT_TONES } from './audio/audioSynthesizer.js';
import { CursorController } from './ui/cursorController.js';
import { ModalController } from './ui/modalController.js';

// Apply defensive WebGL precision shim immediately
patchWebGLPrecision();

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const video = document.getElementById('camera-feed');
const overlayCanvas = document.getElementById('hud-canvas');
const startBtn = document.getElementById('btn-start');
const stopBtn = document.getElementById('btn-stop');
const recordBtn = document.getElementById('btn-record');
const calibrateBtn = document.getElementById('btn-calibrate');
const privacyBtn = document.getElementById('btn-privacy');
const muteBtn = document.getElementById('btn-mute');
const cameraSelect = document.getElementById('camera-select');
const statusEl = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const videoPlaceholder = document.getElementById('video-placeholder');
const alertBanner = document.getElementById('alert-banner');
const handWorkerFrame = document.getElementById('hand-worker-frame');

// Stability & Sparklines
const statStability = document.getElementById('stat-stability');
const earSparkline = document.getElementById('ear-sparkline');
const distSparkline = document.getElementById('dist-sparkline');

// Live HUD overlay elements
const recordingBadge = document.getElementById('recording-badge');
const recStatusText = document.getElementById('rec-status-text');
const recSampleCount = document.getElementById('rec-sample-count');
const livePill = document.getElementById('live-pill');
const liveFps = document.getElementById('live-fps');
const stageTelemetryBar = document.getElementById('stage-telemetry-bar');
const telemetryLiveDot = document.getElementById('telemetry-live-dot');

const hudEar = document.getElementById('hud-ear');
const hudBlink = document.getElementById('hud-blink');
const hudDistance = document.getElementById('hud-distance');
const hudPose = document.getElementById('hud-pose');
const hudGesture = document.getElementById('hud-gesture');

// Sidebar telemetry elements
const statEar = document.getElementById('stat-ear');
const statBlinkCount = document.getElementById('stat-blink-count');
const statBlink = document.getElementById('stat-blink');
const statDistance = document.getElementById('stat-distance');
const statPose = document.getElementById('stat-pose');
const statGesture = document.getElementById('stat-gesture');

// Session summary & export elements
const sessionSummaryCard = document.getElementById('session-summary-card');
const recSumDuration = document.getElementById('rec-sum-duration');
const recSumSamples = document.getElementById('rec-sum-samples');
const recSumBlinks = document.getElementById('rec-sum-blinks');
const recSumEar = document.getElementById('rec-sum-ear');
const recSumDist = document.getElementById('rec-sum-dist');
const btnDownloadCsv = document.getElementById('btn-download-csv');
const btnDownloadJson = document.getElementById('btn-download-json');

// Clinical, Accessibility & Wellness Elements
const modeTabs = document.querySelectorAll('.mode-tab');
const panelProHud = document.getElementById('panel-pro-hud');
const panelSimpleWellness = document.getElementById('panel-simple-wellness');
const panelBedsideAac = document.getElementById('panel-bedside-aac');
const panelPhysicalTherapy = document.getElementById('panel-physical-therapy');

// Simple Wellness elements
const wellnessStatusHeadline = document.getElementById('wellness-status-headline');
const wellnessGradeBadge = document.getElementById('wellness-grade-badge');
const wellnessScoreNum = document.getElementById('wellness-score-num');
const wellnessTimeNum = document.getElementById('wellness-time-num');
const wellnessPosturePct = document.getElementById('wellness-posture-pct');
const wellnessPostureTitle = document.getElementById('wellness-posture-title');
const wellnessPostureTip = document.getElementById('wellness-posture-tip');
const wellnessPostureIcon = document.getElementById('wellness-posture-icon');
const wellnessEyesTitle = document.getElementById('wellness-eyes-title');
const wellnessEyesTip = document.getElementById('wellness-eyes-tip');
const wellnessEyesIcon = document.getElementById('wellness-eyes-icon');
const wellnessDistanceTitle = document.getElementById('wellness-distance-title');
const wellnessDistanceTip = document.getElementById('wellness-distance-tip');
const wellnessDistanceIcon = document.getElementById('wellness-distance-icon');
const btnDownloadWellnessReport = document.getElementById('btn-download-wellness-report');
const btnDownloadWellnessJson = document.getElementById('btn-download-wellness-json');
const btnPrintWellnessReport = document.getElementById('btn-print-wellness-report');

// Hospital Bedside AAC elements
const aacAnnouncementBanner = document.getElementById('aac-announcement-banner');
const aacAnnouncementText = document.getElementById('aac-announcement-text');
const aacTiles = document.querySelectorAll('.aac-tile');
const btnAacEmergencyNurse = document.getElementById('btn-aac-emergency-nurse');
const btnAacTestSpeech = document.getElementById('btn-aac-test-speech');

// Physical Therapy ROM elements
const romStepBadge = document.getElementById('rom-step-badge');
const romStepTitle = document.getElementById('rom-step-title');
const romStepInstruction = document.getElementById('rom-step-instruction');
const romLiveYaw = document.getElementById('rom-live-yaw');
const romLivePitch = document.getElementById('rom-live-pitch');
const romLiveRoll = document.getElementById('rom-live-roll');
const romPeakLeftYaw = document.getElementById('rom-peak-left-yaw');
const romPeakRightYaw = document.getElementById('rom-peak-right-yaw');
const romPeakLeftRoll = document.getElementById('rom-peak-left-roll');
const romPeakRightRoll = document.getElementById('rom-peak-right-roll');
const romPeakFlexion = document.getElementById('rom-peak-flexion');
const romPeakExtension = document.getElementById('rom-peak-extension');
const romSymmetryScore = document.getElementById('rom-symmetry-score');
const romLateralSymmetryScore = document.getElementById('rom-lateral-symmetry-score');
const btnRomAction = document.getElementById('btn-rom-action');
const btnRomReset = document.getElementById('btn-rom-reset');
const btnRomDownloadReport = document.getElementById('btn-rom-download-report');

// ---------------------------------------------------------------------------
// Controller & Engine instances
// ---------------------------------------------------------------------------
const audioSynth = new AudioSynthesizer();
const breakTimer = new BreakTimer();
const wellnessEngine = new WellnessEngine();
wellnessEngine.loadSnapshot(); // Rehydrate cumulative wellness metrics

const aacEngine = new AACEngine();
const romEngine = new ROMEngine();
const telemetryRecorder = new TelemetryRecorder();

let sparklineRenderer = null;
if (earSparkline && distSparkline) {
  sparklineRenderer = new SparklineRenderer(earSparkline, distSparkline);
}

const cursorController = new CursorController({
  onDwellClick: () => audioSynth.playAlertTone(1320, 90),
});

const modalController = new ModalController({
  breakTimer,
  onFeedbackSound: (freq, dur) => audioSynth.playAlertTone(freq, dur),
  onStatusMessage: (msg) => {
    if (statusEl) statusEl.textContent = msg;
  },
});

const cameraManager = new CameraManager(video, cameraSelect, {
  onStreamChange: (stream, w, h) => {
    const currentOverlay = document.getElementById('hud-canvas') || overlayCanvas;
    currentOverlay.width = w;
    currentOverlay.height = h;
    if (ergonomicsEngine) ergonomicsEngine.frameWidthPx = w;
    if (hudRenderer) hudRenderer.resize(w, h);
    if (statusEl) statusEl.textContent = 'Tracking active';
  },
});

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------
let faceMesh = null;
let hudRenderer = null;
let ergonomicsEngine = null;
let gestureEngine = null;
let faceSmoother = null;
let handSmoother = null;
let rafHandle = null;
let running = false;

let latestFaceLandmarks = null;
let latestHandLandmarks = null;
let lastTelemetry = null;
let currentGestureState = 'IDLE';
let activeMode = 'PRO_HUD'; // 'PRO_HUD' | 'SIMPLE_WELLNESS' | 'HOSPITAL_AAC' | 'PHYSICAL_THERAPY'

let isFaceProcessing = false;
let isHandProcessing = false;
let frameCount = 0;
let lastFpsTime = performance.now();

let mediaRecorder = null;
let recordedChunks = [];
let recordTimerInterval = null;
let recordStartTime = 0;
let compositeCanvas = null;
let compositeCtx = null;

let isPrivacyMode = false;
let isTabVisible = !document.hidden;
let lastBackgroundInferenceTime = 0;
let lastSparklineRenderTime = 0;

// ---------------------------------------------------------------------------
// Isolated Hands worker bridge
// ---------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  if (event.data?.type === 'HAND_READY') {
    console.log('[Main] Isolated Hands worker is ready');
  }
  if (event.data?.type === 'HAND_RESULTS') {
    latestHandLandmarks = event.data.landmarks;
    handleHandFrame(performance.now());
    isHandProcessing = false;
  }
});

// ---------------------------------------------------------------------------
// MediaPipe setup
// ---------------------------------------------------------------------------
function createFaceMesh() {
  const fm = new FaceMesh({
    locateFile: (file) => {
      if (file.includes('hand')) return `/mediapipe/hands/${file}`;
      return `/mediapipe/face_mesh/${file}`;
    },
  });
  fm.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true, // enables iris/pupil landmarks
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  fm.onResults((results) => {
    latestFaceLandmarks = results.multiFaceLandmarks?.[0] ?? null;
  });
  return fm;
}

function setupReticles() {
  if (!hudRenderer) return;
  hudRenderer.addReticle('face-nose', { type: 'dot', color: 0x39f0c0, size: 10 });
  hudRenderer.addReticle('face-anchor-l', { type: 'ring', color: 0x2a8bff, size: 12 });
  hudRenderer.addReticle('face-anchor-r', { type: 'ring', color: 0x2a8bff, size: 12 });
  hudRenderer.addReticle('hand-thumb', { type: 'ring', color: 0xffb020, size: 16 });
  hudRenderer.addReticle('hand-index', { type: 'ring', color: 0xff4d6d, size: 16 });
}

// ---------------------------------------------------------------------------
// Inference & Frame processing
// ---------------------------------------------------------------------------
function handleFaceFrame(timestampMs) {
  if (!latestFaceLandmarks) {
    hudRenderer?.hideReticle('face-nose');
    hudRenderer?.hideReticle('face-anchor-l');
    hudRenderer?.hideReticle('face-anchor-r');
    if (running) {
      statusEl.textContent = 'Looking for face…';
    }
    telemetryLiveDot?.classList.remove('bg-accent');
    telemetryLiveDot?.classList.add('bg-warn');

    if (telemetryRecorder.isRecording) {
      telemetryRecorder.recordFrame(
        lastTelemetry ? { ...lastTelemetry, alerts: [{ type: 'FACE_SEARCHING' }] } : { alerts: [{ type: 'NO_FACE' }] },
        currentGestureState,
        timestampMs
      );
      if (recSampleCount) {
        recSampleCount.textContent = `· ${telemetryRecorder.samples.length} samples`;
      }
    }
    breakTimer.update(timestampMs, false);
    return;
  }

  statusEl.textContent = 'Tracking active';
  telemetryLiveDot?.classList.remove('bg-warn');
  telemetryLiveDot?.classList.add('bg-accent');

  const smoothed = faceSmoother.smoothAll(latestFaceLandmarks);

  const anchors = {
    noseTip: smoothed[FACE_LANDMARKS.NOSE_TIP],
    chin: smoothed[FACE_LANDMARKS.CHIN],
    leftTragus: smoothed[FACE_LANDMARKS.LEFT_EAR_TRAGUS],
    rightTragus: smoothed[FACE_LANDMARKS.RIGHT_EAR_TRAGUS],
    glabella: smoothed[FACE_LANDMARKS.GLABELLA],
  };
  const headPose = computeHeadPose(anchors);

  const feedWidth = video.videoWidth || 1280;
  const feedHeight = video.videoHeight || 720;
  const toPixel = (pt) => (pt ? { x: pt.x * feedWidth, y: pt.y * feedHeight } : { x: 0, y: 0 });
  const leftEyePoints = FACE_LANDMARKS.LEFT_EYE.map((i) => toPixel(latestFaceLandmarks[i]));
  const rightEyePoints = FACE_LANDMARKS.RIGHT_EYE.map((i) => toPixel(latestFaceLandmarks[i]));
  const leftPupil = smoothed[FACE_LANDMARKS.LEFT_PUPIL] ?? smoothed[FACE_LANDMARKS.LEFT_EYE_OUTER];
  const rightPupil = smoothed[FACE_LANDMARKS.RIGHT_PUPIL] ?? smoothed[FACE_LANDMARKS.RIGHT_EYE_OUTER];

  // Screen distance & IPD
  const ipdPx = Math.hypot(leftPupil.x - rightPupil.x, leftPupil.y - rightPupil.y) * feedWidth;
  modalController.updateLiveIpd(ipdPx);
  breakTimer.update(timestampMs, true);

  const telemetry = ergonomicsEngine.update({
    leftEyePoints,
    rightEyePoints,
    leftPupil,
    rightPupil,
    headPose,
    timestampMs,
  });

  lastTelemetry = telemetry;
  renderTelemetry(telemetry);

  // Feed telemetry to clinical, accessibility & wellness engines
  wellnessEngine.update(telemetry, timestampMs);

  if (activeMode === 'SIMPLE_WELLNESS') {
    updateWellnessUI(telemetry);
  } else if (activeMode === 'HOSPITAL_AAC') {
    const aacEvent = aacEngine.update(telemetry, timestampMs);
    updateAACUI(aacEvent);
  } else if (activeMode === 'PHYSICAL_THERAPY') {
    romEngine.update(telemetry.headPose);
    updateROMUI();
  }

  // Live telemetry recording
  if (telemetryRecorder.isRecording) {
    telemetryRecorder.recordFrame(telemetry, currentGestureState, timestampMs);
    if (recSampleCount) {
      recSampleCount.textContent = `· ${telemetryRecorder.samples.length} samples`;
    }
  }

  hudRenderer?.updateReticle('face-nose', anchors.noseTip);
  hudRenderer?.updateReticle('face-anchor-l', anchors.leftTragus);
  hudRenderer?.updateReticle('face-anchor-r', anchors.rightTragus);

  for (const alert of telemetry.alerts) {
    audioSynth.checkAndPlayAlert(alert.type, timestampMs, gestureEngine?.isMuted);
  }
}

function handleHandFrame(timestampMs) {
  const smoothed = latestHandLandmarks ? handSmoother.smoothAll(latestHandLandmarks) : null;
  const state = gestureEngine ? gestureEngine.update(smoothed, timestampMs) : 'IDLE';
  currentGestureState = state;

  const displayState = `${state}${gestureEngine?.isMuted ? ' (muted)' : ''}`;
  statGesture.textContent = displayState;
  if (hudGesture) hudGesture.textContent = displayState;

  if (smoothed) {
    hudRenderer?.updateReticle('hand-thumb', smoothed[HAND_LANDMARKS.THUMB_TIP]);
    hudRenderer?.updateReticle('hand-index', smoothed[HAND_LANDMARKS.INDEX_TIP]);
    cursorController.update(smoothed, state, timestampMs);
  } else {
    hudRenderer?.hideReticle('hand-thumb');
    hudRenderer?.hideReticle('hand-index');
    cursorController.hide();
  }
}

function renderTelemetry(t) {
  // Sidebar stats
  statEar.textContent = t.ear.toFixed(3);
  if (statBlinkCount) statBlinkCount.textContent = `${t.blinkCount ?? 0}`;
  statBlink.textContent = `${t.blinkRatePerMin.toFixed(1)} / min`;
  statDistance.textContent = `${t.distanceCm.toFixed(0)} cm${t.distanceCalibrated ? '' : ' (uncalibrated)'}`;

  // Head pose: show relative if baseline is active
  if (t.hasPostureBaseline && typeof t.headPose.relPitch === 'number') {
    statPose.textContent = `P ${t.headPose.relPitch.toFixed(1)}° / Y ${t.headPose.relYaw.toFixed(1)}° / R ${t.headPose.relRoll.toFixed(1)}° (Rel)`;
  } else {
    statPose.textContent = `P ${t.headPose.pitch.toFixed(1)}° / Y ${t.headPose.yaw.toFixed(1)}° / R ${t.headPose.roll.toFixed(1)}°`;
  }

  // Push telemetry sample to sparkline renderer & update stability score
  if (sparklineRenderer) {
    sparklineRenderer.pushSample(t);
    if (statStability) {
      statStability.textContent = `${sparklineRenderer.getStabilityScore()}%`;
    }
  }

  // On-stage live HUD bar
  if (hudEar) hudEar.textContent = t.ear.toFixed(3);
  if (hudBlink) hudBlink.textContent = `${t.blinkCount ?? 0} (${t.blinkRatePerMin.toFixed(0)}/m)`;
  if (hudDistance) hudDistance.textContent = `${t.distanceCm.toFixed(0)}cm`;
  if (hudPose) {
    const p = t.hasPostureBaseline ? t.headPose.relPitch : t.headPose.pitch;
    const y = t.hasPostureBaseline ? t.headPose.relYaw : t.headPose.yaw;
    hudPose.textContent = `P ${p.toFixed(0)}° Y ${y.toFixed(0)}°`;
  }

  if (t.alerts.length > 0) {
    alertBanner.textContent = t.alerts.map((a) => a.type.replace(/_/g, ' ')).join('  ·  ');
    alertBanner.classList.remove('hidden');
    statusDot.classList.remove('bg-accent', 'bg-muted');
    statusDot.classList.add('bg-danger');
  } else {
    alertBanner.classList.add('hidden');
    statusDot.classList.remove('bg-danger', 'bg-muted');
    statusDot.classList.add('bg-accent');
  }
}

// ---------------------------------------------------------------------------
// Clinical, Wellness & Mode UI Renderers
// ---------------------------------------------------------------------------
function updateWellnessUI(t) {
  if (wellnessScoreNum) wellnessScoreNum.textContent = wellnessEngine.score;
  const grade = wellnessEngine.grade;
  if (wellnessGradeBadge) {
    wellnessGradeBadge.textContent = grade;
    if (grade === 'A+' || grade === 'A') {
      wellnessGradeBadge.className = 'flex h-12 w-12 items-center justify-center rounded-xl border border-accent/60 bg-accent/15 text-2xl font-black font-mono text-accent shadow-[0_0_15px_rgba(57,240,192,0.3)]';
    } else if (grade === 'B') {
      wellnessGradeBadge.className = 'flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-400/60 bg-emerald-400/15 text-2xl font-black font-mono text-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.3)]';
    } else if (grade === 'C') {
      wellnessGradeBadge.className = 'flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/60 bg-amber-400/15 text-2xl font-black font-mono text-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.3)]';
    } else {
      wellnessGradeBadge.className = 'flex h-12 w-12 items-center justify-center rounded-xl border border-danger/60 bg-danger/15 text-2xl font-black font-mono text-danger shadow-[0_0_15px_rgba(255,77,109,0.3)]';
    }
  }

  const mins = Math.floor(wellnessEngine.sessionDurationSec / 60);
  if (wellnessTimeNum) wellnessTimeNum.textContent = `${mins}m`;
  if (wellnessPosturePct) wellnessPosturePct.textContent = `${wellnessEngine.getUprightPercentage().toFixed(0)}%`;

  const advice = wellnessEngine.getFriendlyAdvice(t || lastTelemetry);
  if (wellnessStatusHeadline) wellnessStatusHeadline.textContent = advice.headline;
  if (wellnessPostureTitle) wellnessPostureTitle.textContent = advice.posture.title;
  if (wellnessPostureTip) wellnessPostureTip.textContent = advice.posture.tip;
  if (wellnessPostureIcon) wellnessPostureIcon.textContent = advice.posture.icon;

  if (wellnessEyesTitle) wellnessEyesTitle.textContent = advice.eyes.title;
  if (wellnessEyesTip) wellnessEyesTip.textContent = advice.eyes.tip;
  if (wellnessEyesIcon) wellnessEyesIcon.textContent = advice.eyes.icon;

  if (wellnessDistanceTitle) wellnessDistanceTitle.textContent = advice.distance.title;
  if (wellnessDistanceTip) wellnessDistanceTip.textContent = advice.distance.tip;
  if (wellnessDistanceIcon) wellnessDistanceIcon.textContent = advice.distance.icon;
}

function updateAACUI(aacEvent) {
  aacTiles.forEach((tile) => {
    const idx = Number(tile.dataset.index);
    const isSelected = idx === aacEngine.selectedIndex;
    tile.classList.toggle('aac-tile-active', isSelected);
  });

  if (aacEvent?.type === 'SELECTION') {
    if (aacAnnouncementText) {
      aacAnnouncementText.textContent = `📢 "${aacEvent.item.phrase}"`;
    }
    if (aacAnnouncementBanner) {
      aacAnnouncementBanner.classList.add('ring-2', 'ring-accent', 'scale-[1.02]');
      setTimeout(() => aacAnnouncementBanner?.classList.remove('ring-2', 'ring-accent', 'scale-[1.02]'), 900);
    }
    audioSynth.playAlertTone(1100, 100);
  } else if (aacEngine.dwellProgress > 0 && aacEngine.dwellProgress < 1) {
    const item = aacEngine.grid[aacEngine.selectedIndex];
    if (aacAnnouncementText && item) {
      const pct = (aacEngine.dwellProgress * 100).toFixed(0);
      aacAnnouncementText.textContent = `Focusing: ${item.label} (${pct}%)`;
    }
  } else if (aacAnnouncementText && !aacAnnouncementText.textContent.startsWith('📢')) {
    const item = aacEngine.grid[aacEngine.selectedIndex];
    aacAnnouncementText.textContent = item ? `Highlighted: ${item.label} · Dwell 1.4s or long-blink 1s` : 'Tilt head to highlight';
  }
}

function updateROMUI() {
  const angles = romEngine.liveAngles;
  const m = romEngine.measurements;

  if (romLiveYaw) romLiveYaw.textContent = `${Math.round(angles.yaw)}°`;
  if (romLivePitch) romLivePitch.textContent = `${Math.round(angles.pitch)}°`;
  if (romLiveRoll) romLiveRoll.textContent = `${Math.round(angles.roll)}°`;

  if (romPeakLeftYaw) {
    romPeakLeftYaw.innerHTML = `${m.peakLeftYaw}° <span class="text-[10px] text-muted">(Norm: 70–90°)</span>`;
  }
  if (romPeakRightYaw) {
    romPeakRightYaw.innerHTML = `${m.peakRightYaw}° <span class="text-[10px] text-muted">(Norm: 70–90°)</span>`;
  }
  if (romPeakLeftRoll) {
    romPeakLeftRoll.innerHTML = `${m.peakLeftRoll}° <span class="text-[10px] text-muted">(Norm: 40–45°)</span>`;
  }
  if (romPeakRightRoll) {
    romPeakRightRoll.innerHTML = `${m.peakRightRoll}° <span class="text-[10px] text-muted">(Norm: 40–45°)</span>`;
  }
  if (romPeakFlexion) {
    romPeakFlexion.innerHTML = `${m.peakFlexion}° <span class="text-[10px] text-muted">(Norm: 45–60°)</span>`;
  }
  if (romPeakExtension) {
    romPeakExtension.innerHTML = `${m.peakExtension}° <span class="text-[10px] text-muted">(Norm: 50–70°)</span>`;
  }
  if (romSymmetryScore) {
    romSymmetryScore.textContent = `${m.bilateralSymmetry}%`;
  }
  if (romLateralSymmetryScore) {
    romLateralSymmetryScore.textContent = `${m.lateralSymmetry}%`;
  }

  const step = romEngine.getCurrentStep();
  if (step) {
    if (romStepBadge) romStepBadge.textContent = `Step ${romEngine.currentStepIndex + 1} of ${romEngine.steps.length} · ${step.title}`;
    if (romStepTitle) romStepTitle.textContent = step.title;
    if (romStepInstruction) romStepInstruction.textContent = step.instruction;
    if (btnRomAction) btnRomAction.textContent = step.actionLabel || step.actionText;
  }
}

function switchMode(newMode) {
  activeMode = newMode;
  modeTabs.forEach((tab) => {
    const isSelected = tab.dataset.mode === newMode;
    tab.classList.toggle('mode-tab-active', isSelected);
    tab.setAttribute('aria-selected', String(isSelected));
  });

  if (panelProHud) panelProHud.classList.toggle('hidden', newMode !== 'PRO_HUD');
  if (panelSimpleWellness) panelSimpleWellness.classList.toggle('hidden', newMode !== 'SIMPLE_WELLNESS');
  if (panelBedsideAac) panelBedsideAac.classList.toggle('hidden', newMode !== 'HOSPITAL_AAC');
  if (panelPhysicalTherapy) panelPhysicalTherapy.classList.toggle('hidden', newMode !== 'PHYSICAL_THERAPY');

  if (newMode === 'SIMPLE_WELLNESS') {
    updateWellnessUI(lastTelemetry);
    if (statusEl && running) statusEl.textContent = 'Wellness Mode: Daily score & ergonomic posture tracking';
  } else if (newMode === 'HOSPITAL_AAC') {
    updateAACUI(null);
    if (statusEl && running) statusEl.textContent = 'Bedside AAC: Head tilt navigation & blink-to-speak active';
  } else if (newMode === 'PHYSICAL_THERAPY') {
    updateROMUI();
    if (statusEl && running) statusEl.textContent = 'Physical Therapy: Cervical spine range-of-motion protocol';
  } else {
    if (statusEl && running) statusEl.textContent = 'Tracking active';
  }
}

// ---------------------------------------------------------------------------
// Video Recording
// ---------------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function drawCompositeRecordingFrame() {
  if (!compositeCtx || !compositeCanvas) return;
  const w = compositeCanvas.width;
  const h = compositeCanvas.height;

  try {
    compositeCtx.save();
    compositeCtx.translate(w, 0);
    compositeCtx.scale(-1, 1);
    compositeCtx.drawImage(video, 0, 0, w, h);
    if (overlayCanvas && overlayCanvas.width > 0 && overlayCanvas.height > 0) {
      compositeCtx.drawImage(overlayCanvas, 0, 0, w, h);
    }
    compositeCtx.restore();

    compositeCtx.fillStyle = 'rgba(16, 24, 32, 0.85)';
    compositeCtx.fillRect(16, h - 50, w - 32, 36);
    compositeCtx.strokeStyle = 'rgba(57, 240, 192, 0.45)';
    compositeCtx.lineWidth = 1;
    compositeCtx.strokeRect(16, h - 50, w - 32, 36);

    compositeCtx.fillStyle = '#39F0C0';
    compositeCtx.font = '13px "IBM Plex Mono", monospace';
    const earStr = lastTelemetry ? `EAR: ${lastTelemetry.ear.toFixed(3)}` : 'EAR: —';
    const blinkStr = lastTelemetry ? `BLINK: ${lastTelemetry.blinkCount ?? 0} (${lastTelemetry.blinkRatePerMin.toFixed(0)}/m)` : 'BLINK: 0';
    const distStr = lastTelemetry ? `DIST: ${lastTelemetry.distanceCm.toFixed(0)}cm` : 'DIST: —';
    const poseStr = lastTelemetry ? `P:${lastTelemetry.headPose.pitch.toFixed(1)}° Y:${lastTelemetry.headPose.yaw.toFixed(1)}°` : 'POSE: —';
    const gestStr = `GESTURE: ${currentGestureState}`;
    compositeCtx.fillText(`${earStr}   ${blinkStr}   ${distStr}   ${poseStr}   ${gestStr}`, 28, h - 27);

    if (lastTelemetry?.alerts?.length > 0) {
      compositeCtx.fillStyle = 'rgba(255, 77, 109, 0.85)';
      compositeCtx.fillRect(0, 0, w, 32);
      compositeCtx.fillStyle = '#ffffff';
      compositeCtx.font = 'bold 13px "IBM Plex Mono", monospace';
      compositeCtx.textAlign = 'center';
      compositeCtx.fillText(lastTelemetry.alerts.map((a) => a.type.replace(/_/g, ' ')).join('  ·  '), w / 2, 21);
      compositeCtx.textAlign = 'left';
    }

    const elapsedMs = Math.max(0, performance.now() - recordStartTime);
    const min = Math.floor(elapsedMs / 60000).toString().padStart(2, '0');
    const sec = Math.floor((elapsedMs % 60000) / 1000).toString().padStart(2, '0');
    compositeCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    compositeCtx.beginPath();
    compositeCtx.roundRect(16, 16, 120, 26, 13);
    compositeCtx.fill();
    compositeCtx.fillStyle = '#FF4D6D';
    compositeCtx.beginPath();
    compositeCtx.arc(30, 29, 5, 0, Math.PI * 2);
    compositeCtx.fill();
    compositeCtx.font = 'bold 12px "IBM Plex Mono", monospace';
    compositeCtx.fillText(`REC ${min}:${sec}`, 42, 33);
  } catch (err) {
    console.warn('Composite frame render error:', err);
  }
}

function startRecording() {
  if (!running) return;
  const feedWidth = video.videoWidth || 1280;
  const feedHeight = video.videoHeight || 720;

  if (!compositeCanvas) compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = feedWidth;
  compositeCanvas.height = feedHeight;
  compositeCtx = compositeCanvas.getContext('2d');

  recordedChunks = [];
  recordStartTime = performance.now();
  telemetryRecorder.start(recordStartTime);

  try {
    drawCompositeRecordingFrame();
  } catch (_) {}

  try {
    const canvasStream = compositeCanvas.captureStream(30);
    const mediaAudioDest = audioSynth.getMediaStreamDestination();
    let streamToRecord = canvasStream;
    if (mediaAudioDest && mediaAudioDest.stream.getAudioTracks().length > 0) {
      streamToRecord = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...mediaAudioDest.stream.getAudioTracks(),
      ]);
    }

    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t)
    ) || '';

    mediaRecorder = new MediaRecorder(streamToRecord, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = handleRecordingComplete;
    mediaRecorder.start(1000);
  } catch (err) {
    console.warn('MediaRecorder restricted; telemetry time-series logging continues live:', err);
    mediaRecorder = null;
  }

  recordBtn.textContent = 'Stop recording';
  recordBtn.className = 'hud-button-recording';
  recordingBadge?.classList.remove('hidden');
  if (recStatusText) recStatusText.textContent = 'REC 00:00';
  if (recSampleCount) recSampleCount.textContent = '· 0 samples';

  recordTimerInterval = setInterval(() => {
    const elapsedMs = Math.max(0, performance.now() - recordStartTime);
    const min = Math.floor(elapsedMs / 60000).toString().padStart(2, '0');
    const sec = Math.floor((elapsedMs % 60000) / 1000).toString().padStart(2, '0');
    if (recStatusText) recStatusText.textContent = `REC ${min}:${sec}`;
  }, 500);
}

function stopRecording() {
  if (!telemetryRecorder.isRecording) return;
  clearInterval(recordTimerInterval);
  recordTimerInterval = null;

  const summary = telemetryRecorder.stop(performance.now());

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    handleRecordingComplete();
  }

  recordBtn.textContent = 'Record session';
  recordBtn.className = 'hud-button-record';
  recordingBadge?.classList.add('hidden');

  if (sessionSummaryCard) {
    sessionSummaryCard.classList.remove('hidden');
    if (recSumDuration) recSumDuration.textContent = `${summary.durationSec}s`;
    if (recSumSamples) recSumSamples.textContent = `${summary.sampleCount} (${summary.avgFps} fps)`;
    if (recSumBlinks) recSumBlinks.textContent = `${summary.totalBlinks ?? 0}`;
    if (recSumEar) recSumEar.textContent = summary.avgEar ? summary.avgEar.toFixed(3) : '—';
    if (recSumDist) recSumDist.textContent = summary.avgDistanceCm ? `${summary.avgDistanceCm}cm` : '—';
  }
}

function handleRecordingComplete() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (recordedChunks.length > 0) {
    const videoBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
    downloadBlob(videoBlob, `neuroergo-session-${ts}.webm`);
    recordedChunks = [];
  }
  if (telemetryRecorder.samples.length > 0) {
    const csv = telemetryRecorder.toCSV();
    const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(csvBlob, `neuroergo-telemetry-${ts}.csv`);
  }
}

// ---------------------------------------------------------------------------
// Non-blocking Inference & Render Loop
// ---------------------------------------------------------------------------
function loop() {
  if (!running) return;
  const now = performance.now();

  // Tab visibility throttling
  if (!isTabVisible) {
    if (now - lastBackgroundInferenceTime < 125) {
      if (running) rafHandle = requestAnimationFrame(loop);
      return;
    }
    lastBackgroundInferenceTime = now;
  }

  // FPS calculation
  frameCount++;
  if (now - lastFpsTime >= 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    if (liveFps) liveFps.textContent = `LIVE · ${fps} FPS`;
    frameCount = 0;
    lastFpsTime = now;
  }

  if (video.readyState >= 2) {
    if (!isFaceProcessing && faceMesh) {
      isFaceProcessing = true;
      faceMesh
        .send({ image: video })
        .then(() => {
          handleFaceFrame(performance.now());
        })
        .catch((err) => {
          console.warn('FaceMesh inference error:', err);
        })
        .finally(() => {
          isFaceProcessing = false;
        });
    }

    if (!isHandProcessing && handWorkerFrame?.contentWindow && video.videoWidth > 0) {
      isHandProcessing = true;
      const handTimeout = setTimeout(() => {
        isHandProcessing = false;
      }, 500);

      createImageBitmap(video)
        .then((bitmap) => {
          handWorkerFrame.contentWindow.postMessage(
            { type: 'PROCESS_FRAME', imageBitmap: bitmap },
            '*',
            [bitmap]
          );
        })
        .catch(() => {
          clearTimeout(handTimeout);
          isHandProcessing = false;
        });
    }
  }

  hudRenderer?.render(now / 1000);

  if (sparklineRenderer && now - lastSparklineRenderTime >= 60) {
    sparklineRenderer.render();
    lastSparklineRenderTime = now;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording' && compositeCtx) {
    try {
      drawCompositeRecordingFrame();
    } catch (compErr) {
      console.warn('Composite recording error:', compErr);
    }
  }

  if (running) {
    rafHandle = requestAnimationFrame(loop);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: start / stop
// ---------------------------------------------------------------------------
async function start() {
  if (running) return;
  statusEl.textContent = 'Requesting camera…';

  await cameraManager.startStream();
  const feedWidth = video.videoWidth || 1280;
  const feedHeight = video.videoHeight || 720;

  const currentOverlay = document.getElementById('hud-canvas') || overlayCanvas;
  currentOverlay.width = feedWidth;
  currentOverlay.height = feedHeight;

  videoPlaceholder.classList.add('hidden');
  statusDot.classList.remove('bg-muted', 'bg-danger');
  statusDot.classList.add('bg-accent');
  livePill?.classList.remove('hidden');
  stageTelemetryBar?.classList.remove('hidden');
  telemetryLiveDot?.classList.remove('hidden');

  faceMesh = createFaceMesh();
  ergonomicsEngine = new ErgonomicsEngine({ frameWidthPx: feedWidth });
  modalController.setErgonomicsEngine(ergonomicsEngine);
  modalController.setTrackingState(true);

  gestureEngine = new GestureEngine();
  faceSmoother = new LandmarkSmoother({ kind: 'double', alpha: 0.5, beta: 0.3 });
  handSmoother = new LandmarkSmoother({ kind: 'double', alpha: 0.6, beta: 0.3 });

  if (!sparklineRenderer && earSparkline && distSparkline) {
    sparklineRenderer = new SparklineRenderer(earSparkline, distSparkline);
  }

  try {
    hudRenderer = new HUDRenderer(currentOverlay, { width: feedWidth, height: feedHeight });
    setupReticles();
  } catch (hudErr) {
    console.warn('HUD overlay warning:', hudErr);
  }

  gestureEngine.on('pinch', () => {
    audioSynth.playAlertTone(1200, 70);
    cursorController.clickCurrentPosition();
  });

  gestureEngine.on('swipe', ({ direction }) => {
    audioSynth.playAlertTone(650, 90);
    if (direction === 'down') {
      window.scrollBy({ top: 320, behavior: 'smooth' });
    } else if (direction === 'up') {
      window.scrollBy({ top: -320, behavior: 'smooth' });
    }
    statusEl.textContent = `Swipe ${direction.toUpperCase()} gesture triggered`;
  });

  gestureEngine.on('mute', ({ muted }) => {
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.textContent = muted ? 'Unmute alerts' : 'Mute alerts';
    statusEl.textContent = muted ? 'Alerts muted (palm gesture)' : 'Alerts unmuted';
    audioSynth.playAlertTone(muted ? 440 : 880, 100);
  });

  gestureEngine.on('stateChange', ({ to }) => {
    if (to === 'ENGAGED') {
      audioSynth.playAlertTone(950, 40);
    }
  });

  running = true;
  statusEl.textContent = 'Detecting face…';
  startBtn.disabled = true;
  stopBtn.disabled = false;
  recordBtn.disabled = false;
  calibrateBtn.disabled = false;
  rafHandle = requestAnimationFrame(loop);
}

function stop() {
  if (telemetryRecorder.isRecording) {
    stopRecording();
  }

  // Persist session wellness snapshot
  wellnessEngine.saveSnapshot();

  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;

  cameraManager.stopStream();
  modalController.setTrackingState(false);

  faceMesh?.close?.();
  hudRenderer?.dispose();
  faceMesh = null;
  hudRenderer = null;
  latestFaceLandmarks = null;
  latestHandLandmarks = null;
  cursorController.hide();
  statGesture.textContent = '—';
  if (hudGesture) hudGesture.textContent = 'IDLE';
  audioSynth.clearAlertHistory();
  isFaceProcessing = false;
  isHandProcessing = false;

  statusEl.textContent = 'Stopped';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordBtn.disabled = true;
  calibrateBtn.disabled = true;
  alertBanner.classList.add('hidden');
  videoPlaceholder.classList.remove('hidden');
  livePill?.classList.add('hidden');
  stageTelemetryBar?.classList.add('hidden');
  telemetryLiveDot?.classList.add('hidden');
  statusDot.classList.remove('bg-accent', 'bg-danger');
  statusDot.classList.add('bg-muted');
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
startBtn?.addEventListener('click', () =>
  start().catch((err) => {
    console.error('Tracking startup error:', err);
    statusEl.textContent = `Camera error: ${err.message}`;
    statusDot.classList.remove('bg-accent');
    statusDot.classList.add('bg-danger');
  })
);

stopBtn?.addEventListener('click', stop);

recordBtn?.addEventListener('click', async () => {
  if (!running) {
    statusEl.textContent = 'Starting camera & recording…';
    try {
      await start();
      startRecording();
    } catch (err) {
      console.error('Failed to start tracking for recording:', err);
      statusEl.textContent = `Camera error: ${err.message}`;
      statusDot.classList.remove('bg-accent');
      statusDot.classList.add('bg-danger');
    }
  } else if (!telemetryRecorder.isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
});

privacyBtn?.addEventListener('click', () => {
  isPrivacyMode = !isPrivacyMode;
  video?.classList.toggle('video-privacy', isPrivacyMode);
  privacyBtn.classList.toggle('hud-button-active', isPrivacyMode);
  privacyBtn.setAttribute('aria-pressed', String(isPrivacyMode));
  statusEl.textContent = isPrivacyMode ? 'Privacy mode: Silhouette active' : 'Privacy mode disabled';
});

muteBtn?.addEventListener('click', () => {
  gestureEngine?.toggleMute();
});

btnDownloadCsv?.addEventListener('click', () => {
  if (telemetryRecorder.samples.length === 0) return;
  const csv = telemetryRecorder.toCSV();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `neuroergo-telemetry-${ts}.csv`);
});

btnDownloadJson?.addEventListener('click', () => {
  if (telemetryRecorder.samples.length === 0) return;
  const json = telemetryRecorder.toJSON();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8;' }), `neuroergo-telemetry-${ts}.json`);
});

cameraSelect?.addEventListener('change', (e) => {
  cameraManager.switchCamera(e.target.value);
});

// Mode switcher
modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    switchMode(tab.dataset.mode);
  });
});

// Simple Wellness report downloads
btnDownloadWellnessReport?.addEventListener('click', () => {
  const report = wellnessEngine.generateReport('text');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob([report], { type: 'text/plain;charset=utf-8;' }), `neuroergo-wellness-summary-${ts}.txt`);
});

btnDownloadWellnessJson?.addEventListener('click', () => {
  const jsonReport = wellnessEngine.generateReport('json');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob([jsonReport], { type: 'application/json;charset=utf-8;' }), `neuroergo-wellness-dataset-${ts}.json`);
});

btnPrintWellnessReport?.addEventListener('click', () => {
  const htmlReport = wellnessEngine.generateReport('html');
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(htmlReport);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
  } else {
    // Fallback: download as HTML if pop-up blocker prevents window.open
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(new Blob([htmlReport], { type: 'text/html;charset=utf-8;' }), `neuroergo-wellness-report-${ts}.html`);
  }
});

// Hospital Bedside AAC
aacTiles.forEach((tile) => {
  tile.addEventListener('click', () => {
    const idx = Number(tile.dataset.index);
    aacEngine.select(idx, performance.now(), 'mouse_click');
    updateAACUI(null);
  });
});

btnAacEmergencyNurse?.addEventListener('click', () => {
  aacEngine.triggerNurseCall();
  if (aacAnnouncementText) aacAnnouncementText.textContent = '🚨 NURSE CALL ACTIVATED';
  if (aacAnnouncementBanner) {
    aacAnnouncementBanner.classList.add('ring-4', 'ring-danger', 'scale-[1.03]');
    setTimeout(() => aacAnnouncementBanner?.classList.remove('ring-4', 'ring-danger', 'scale-[1.03]'), 1500);
  }
  audioSynth.playAlertTone(880, 250);
});

btnAacTestSpeech?.addEventListener('click', () => {
  aacEngine.speak('NeuroErgo touchless bedside audio test.');
});

// Physical Therapy ROM wizard & report export
btnRomAction?.addEventListener('click', () => {
  if (romEngine.currentStepIndex === 0) {
    // Tare step
    romEngine.tare(lastTelemetry?.headPose || null);
  } else {
    romEngine.nextStep();
  }
  audioSynth.playAlertTone(750, 90);
  updateROMUI();
  if (statusEl) {
    statusEl.textContent = `ROM Step ${romEngine.currentStepIndex + 1} of ${romEngine.steps.length} active`;
  }
});

btnRomReset?.addEventListener('click', () => {
  romEngine.reset();
  audioSynth.playAlertTone(500, 80);
  updateROMUI();
  if (statusEl) statusEl.textContent = 'ROM Assessment restarted';
});

btnRomDownloadReport?.addEventListener('click', () => {
  const report = romEngine.generateClinicalReport();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob([report], { type: 'text/plain;charset=utf-8;' }), `neuroergo-cervical-rom-report-${ts}.txt`);
});

// Power-saving tab visibility throttling
document.addEventListener('visibilitychange', () => {
  isTabVisible = !document.hidden;
});

window.addEventListener('beforeunload', () => {
  wellnessEngine.saveSnapshot();
  stop();
});
