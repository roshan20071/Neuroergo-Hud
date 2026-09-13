/**
 * cursorController.js
 * ---------------------------------------------------------------------------
 * Touchless virtual cursor with tremor-dampened circular dwell countdown
 * for users with motor impairments, tremors, arthritis, or hands-free navigation.
 * ---------------------------------------------------------------------------
 */

import { HAND_LANDMARKS } from '../engine/gestureEngine.js';

export class CursorController {
  constructor(options = {}) {
    this.virtualCursor = document.getElementById('virtual-cursor');
    this.cursorRing = document.getElementById('cursor-ring');
    this.cursorBadge = document.getElementById('cursor-badge');
    this.cursorDwellSvg = document.getElementById('cursor-dwell-svg');
    this.cursorDwellCircle = this.cursorDwellSvg?.querySelector('circle');

    this.currentCursorX = typeof window !== 'undefined' ? window.innerWidth / 2 : 640;
    this.currentCursorY = typeof window !== 'undefined' ? window.innerHeight / 2 : 360;

    this.dwellTargetElement = null;
    this.dwellStartTime = 0;
    this.dwellDurationMs = options.dwellDurationMs ?? 1200;
    this.lastDwellClickTime = 0;

    this.onDwellClick = options.onDwellClick || null;
  }

  update(landmarks, state, timestampMs = performance.now()) {
    if (!this.virtualCursor) return;
    const indexTip = landmarks?.[HAND_LANDMARKS.INDEX_TIP];
    if (!indexTip) return;

    // Mirror X coordinate to match selfie camera view
    const targetX = (1 - indexTip.x) * window.innerWidth;
    const targetY = indexTip.y * window.innerHeight;

    this.currentCursorX += (targetX - this.currentCursorX) * 0.45;
    this.currentCursorY += (targetY - this.currentCursorY) * 0.45;

    this.virtualCursor.style.left = `${this.currentCursorX}px`;
    this.virtualCursor.style.top = `${this.currentCursorY}px`;
    this.virtualCursor.classList.remove('hidden');

    if (this.cursorBadge) {
      this.cursorBadge.textContent = state;
    }

    if (this.cursorRing) {
      if (state === 'ENGAGED') {
        this.cursorRing.className = 'h-10 w-10 rounded-full border-2 border-accent bg-accent/30 shadow-[0_0_15px_rgba(57,240,192,0.6)] transition-all duration-150 scale-110';
      } else if (state === 'PINCH_CONFIRMED') {
        this.cursorRing.className = 'h-6 w-6 rounded-full border-2 border-danger bg-danger/50 shadow-[0_0_20px_rgba(255,77,109,0.8)] transition-all duration-100 scale-90';
      } else if (state === 'SWIPE_TRACKING') {
        this.cursorRing.className = 'h-9 w-9 rounded-full border-2 border-warn bg-warn/30 shadow-[0_0_15px_rgba(255,176,32,0.6)] transition-all duration-150';
      } else {
        this.cursorRing.className = 'h-8 w-8 rounded-full border-2 border-accent/70 bg-accent/15 backdrop-blur-xs transition-all duration-150';
      }
    }

    // Tremor-dampened Dwell Clicking
    let target = null;
    try {
      target = document.elementFromPoint(this.currentCursorX, this.currentCursorY);
    } catch (_) {}

    const clickable = target ? target.closest('button, a, .aac-tile, input[type="button"], [role="button"]') : null;

    if (clickable && !clickable.hasAttribute('disabled') && (timestampMs - this.lastDwellClickTime > 800)) {
      if (this.dwellTargetElement === clickable) {
        const elapsed = timestampMs - this.dwellStartTime;
        const progress = Math.min(1, elapsed / this.dwellDurationMs);

        if (this.cursorDwellSvg && this.cursorDwellCircle) {
          this.cursorDwellSvg.classList.remove('hidden');
          const offset = 100 * (1 - progress);
          this.cursorDwellCircle.style.strokeDashoffset = `${offset}`;
        }

        if (this.cursorBadge) {
          this.cursorBadge.textContent = `DWELL ${(progress * 100).toFixed(0)}%`;
        }

        if (progress >= 1) {
          this.lastDwellClickTime = timestampMs;
          this.dwellTargetElement = null;
          this.dwellStartTime = 0;
          if (this.cursorDwellSvg) this.cursorDwellSvg.classList.add('hidden');

          if (this.cursorRing) {
            this.cursorRing.classList.add('scale-125', 'bg-accent/80');
            setTimeout(() => this.cursorRing?.classList.remove('scale-125', 'bg-accent/80'), 200);
          }

          clickable.click();
          clickable.focus?.();
          if (this.onDwellClick) this.onDwellClick(clickable);
        }
      } else {
        this.dwellTargetElement = clickable;
        this.dwellStartTime = timestampMs;
        if (this.cursorDwellSvg && this.cursorDwellCircle) {
          this.cursorDwellSvg.classList.remove('hidden');
          this.cursorDwellCircle.style.strokeDashoffset = '100';
        }
      }
    } else {
      this.dwellTargetElement = null;
      this.dwellStartTime = 0;
      if (this.cursorDwellSvg) this.cursorDwellSvg.classList.add('hidden');
    }
  }

  clickCurrentPosition() {
    try {
      const target = document.elementFromPoint(this.currentCursorX, this.currentCursorY);
      const clickable = target ? target.closest('button, a, .aac-tile, input[type="button"], [role="button"]') || target : null;
      if (clickable && !clickable.hasAttribute('disabled')) {
        clickable.click();
        clickable.focus?.();
        return clickable;
      }
    } catch (_) {}
    return null;
  }

  hide() {
    if (this.virtualCursor) this.virtualCursor.classList.add('hidden');
    this.dwellTargetElement = null;
    this.dwellStartTime = 0;
    if (this.cursorDwellSvg) this.cursorDwellSvg.classList.add('hidden');
  }
}
