/**
 * aacEngine.js
 * ---------------------------------------------------------------------------
 * Assistive Augmentative Communication (AAC) board for ICU, post-stroke,
 * ventilator, and motor-impaired hospital patients.
 *
 * Allows touchless, non-verbal communication via:
 * 1. Gentle head-tilt navigation (Yaw / Pitch) across a 3x3 pictogram grid.
 * 2. Dwell selection (holding gaze for 1.4s) or deliberate long blink (1.0s).
 * 3. Voice output using Web Speech API (speechSynthesis).
 * ---------------------------------------------------------------------------
 */

export const AAC_CARDS = [
  { id: 'water', label: 'Water', icon: '💧', spokenPhrase: 'Nurse, I need some water, please.', phrase: 'Nurse, I need some water, please.' },
  { id: 'pain', label: 'Pain', icon: '💊', spokenPhrase: 'I am experiencing pain. Please help.', phrase: 'I am experiencing pain. Please help.' },
  { id: 'nurse', label: 'Call Nurse', icon: '🛎️', spokenPhrase: 'Please call the nurse immediately.', phrase: 'Please call the nurse immediately.' },
  { id: 'bed', label: 'Adjust Bed', icon: '🛏️', spokenPhrase: 'Can you please adjust my bed position?', phrase: 'Can you please adjust my bed position?' },
  { id: 'cold', label: 'Cold / Blanket', icon: '❄️', spokenPhrase: 'I am cold. Please bring me a blanket.', phrase: 'I am cold. Please bring me a blanket.' },
  { id: 'warm', label: 'Too Warm', icon: '🌡️', spokenPhrase: 'I am feeling too warm.', phrase: 'I am feeling too warm.' },
  { id: 'restroom', label: 'Restroom', icon: '🚻', spokenPhrase: 'I need assistance to the restroom.', phrase: 'I need assistance to the restroom.' },
  { id: 'yes', label: 'Yes', icon: '✅', spokenPhrase: 'Yes.', phrase: 'Yes.' },
  { id: 'no', label: 'No', icon: '❌', spokenPhrase: 'No.', phrase: 'No.' },
];

export class AACEngine {
  /**
   * @param {object} [options]
   * @param {Array<object>} [options.cards=AAC_CARDS] custom 3x3 cards
   * @param {number} [options.defaultIndex=4] starting active grid index
   * @param {number} [options.dwellMs=1400] milliseconds to dwell before selection
   * @param {number} [options.blinkSelectMs=900] intentional long blink duration
   */
  constructor(options = {}) {
    this.cards = this._normalizeCards(options.cards ?? AAC_CARDS);
    this.dwellMs = options.dwellMs ?? 1400;
    this.blinkSelectMs = options.blinkSelectMs ?? 900;
    this.defaultIndex = typeof options.defaultIndex === 'number' ? options.defaultIndex : 4;

    this.currentIndex = Math.max(0, Math.min(this.cards.length - 1, this.defaultIndex));
    this.dwellStartTime = null;
    this.lastTimestamp = null;
    this.dwellProgress = 0;

    this.eyeClosedSince = null;
    this.lastSelectionTime = -Infinity;
    this.cooldownMs = 1800; // prevent rapid accidental double selections

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  get selectedIndex() {
    return this.currentIndex;
  }

  set selectedIndex(index) {
    if (typeof index === 'number' && index >= 0 && index < this.cards.length) {
      this.currentIndex = index;
    }
  }

  get grid() {
    return this.cards;
  }

  _normalizeCards(cards) {
    return cards.map((c) => ({
      ...c,
      phrase: c.phrase || c.spokenPhrase || c.label,
      spokenPhrase: c.spokenPhrase || c.phrase || c.label,
    }));
  }

  /**
   * Replaces current card deck with customized cards.
   * @param {Array<object>} cards
   */
  setCards(cards) {
    if (Array.isArray(cards) && cards.length > 0) {
      this.cards = this._normalizeCards(cards);
      this.currentIndex = Math.min(this.currentIndex, this.cards.length - 1);
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(data);
      } catch (e) {
        console.error(`AAC listener error [${event}]:`, e);
      }
    });
  }

  /**
   * Maps head pose Euler angles to grid coordinates (row 0..2, col 0..2).
   * @param {{pitch: number, yaw: number, roll: number}} headPose
   * @returns {number} card index (0..8)
   */
  mapPoseToIndex(headPose) {
    if (!headPose) return this.currentIndex;

    const yaw = headPose.relYaw ?? headPose.yaw ?? 0;
    const pitch = headPose.relPitch ?? headPose.pitch ?? 0;

    // Columns: 0 (Left), 1 (Center), 2 (Right)
    let col = 1;
    if (yaw < -6.5) col = 0; // mirror selfie view: tilt left
    else if (yaw > 6.5) col = 2;

    // Rows: 0 (Top), 1 (Center), 2 (Bottom)
    let row = 1;
    if (pitch < -5.5) row = 0; // look up
    else if (pitch > 6.5) row = 2; // look down

    return row * 3 + col;
  }

  /**
   * Processes a frame of head pose and eye closed telemetry.
   * @param {object} telemetry
   * @param {number} timestampMs
   */
  update(telemetry, timestampMs) {
    if (!telemetry) {
      return {
        type: 'STATUS',
        currentIndex: this.currentIndex,
        selectedIndex: this.currentIndex,
        item: this.cards[this.currentIndex],
        dwellProgress: 0,
      };
    }

    const targetIndex = this.mapPoseToIndex(telemetry.headPose);
    const isEyeClosed = Boolean(telemetry.eyeClosed || (typeof telemetry.ear === 'number' && telemetry.ear < 0.18));

    if (isEyeClosed) {
      // Pause/reset dwell timer while eyes are closed
      this.dwellStartTime = timestampMs;
      this.dwellProgress = 0;
      if (this.eyeClosedSince === null) this.eyeClosedSince = timestampMs;
    } else {
      // Check deliberate long-blink selection upon re-opening eyes
      if (this.eyeClosedSince !== null) {
        const closedDuration = timestampMs - this.eyeClosedSince;
        this.eyeClosedSince = null;
        if (closedDuration >= this.blinkSelectMs && closedDuration <= 2200) {
          if (timestampMs - this.lastSelectionTime > this.cooldownMs) {
            this.select(this.currentIndex, timestampMs, 'blink');
            return {
              type: 'SELECTION',
              currentIndex: this.currentIndex,
              selectedIndex: this.currentIndex,
              item: this.cards[this.currentIndex],
              dwellProgress: 0,
            };
          }
        }
      }

      // If target cell changed, reset dwell timer
      if (targetIndex !== this.currentIndex) {
        this.currentIndex = targetIndex;
        this.dwellStartTime = timestampMs;
        this.dwellProgress = 0;
        this.emit('highlight', {
          index: this.currentIndex,
          item: this.cards[this.currentIndex],
          dwellProgress: 0,
        });
      } else {
        if (this.dwellStartTime === null) this.dwellStartTime = timestampMs;
        const elapsed = timestampMs - this.dwellStartTime;
        this.dwellProgress = Math.min(1.0, elapsed / this.dwellMs);

        // Check dwell selection trigger
        if (this.dwellProgress >= 1.0 && timestampMs - this.lastSelectionTime > this.cooldownMs) {
          this.select(this.currentIndex, timestampMs, 'dwell');
          return {
            type: 'SELECTION',
            currentIndex: this.currentIndex,
            selectedIndex: this.currentIndex,
            item: this.cards[this.currentIndex],
            dwellProgress: 0,
          };
        } else {
          this.emit('highlight', {
            index: this.currentIndex,
            item: this.cards[this.currentIndex],
            dwellProgress: this.dwellProgress,
          });
        }
      }
    }

    return {
      type: 'HIGHLIGHT',
      currentIndex: this.currentIndex,
      selectedIndex: this.currentIndex,
      item: this.cards[this.currentIndex],
      dwellProgress: this.dwellProgress,
    };
  }

  select(index, timestampMs = performance.now(), trigger = 'manual') {
    const card = this.cards[index];
    if (!card) return;

    this.currentIndex = index;
    this.lastSelectionTime = timestampMs;
    this.dwellStartTime = timestampMs; // reset dwell
    this.dwellProgress = 0;

    // Speak aloud using Web Speech API
    this.speak(card.spokenPhrase || card.phrase);

    this.emit('select', {
      index,
      item: card,
      trigger,
      timestampMs,
    });
  }

  /**
   * Directly triggers emergency call nurse action.
   */
  triggerNurseCall() {
    const nurseIdx = this.cards.findIndex((c) => c.id === 'nurse');
    const targetIdx = nurseIdx >= 0 ? nurseIdx : 2;
    this.select(targetIdx, performance.now(), 'emergency_button');
  }

  speak(phrase) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel(); // Stop any pending speech
      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance.rate = 0.92;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('SpeechSynthesis error:', err);
    }
  }
}
