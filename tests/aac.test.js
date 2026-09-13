import { describe, it, expect, beforeEach } from 'vitest';
import { AACEngine, AAC_CARDS } from '../src/engine/aacEngine.js';

describe('AACEngine', () => {
  let aac;

  beforeEach(() => {
    aac = new AACEngine({ dwellMs: 1000, blinkSelectMs: 800 });
  });

  it('maps neutral head pose to center card (index 4)', () => {
    const neutralPose = { pitch: 0, yaw: 0, roll: 0 };
    const idx = aac.mapPoseToIndex(neutralPose);
    expect(idx).toBe(4);
    expect(aac.grid[idx].id).toBe('cold');
    expect(aac.selectedIndex).toBe(4);
  });

  it('allows custom defaultIndex and custom cards deck', () => {
    const customCards = [
      { id: '1', label: 'One', phrase: 'Option One' },
      { id: '2', label: 'Two', phrase: 'Option Two' },
      { id: '3', label: 'Three', phrase: 'Option Three' },
    ];
    const customEngine = new AACEngine({
      cards: customCards,
      defaultIndex: 1,
      dwellMs: 1200,
    });

    expect(customEngine.grid.length).toBe(3);
    expect(customEngine.selectedIndex).toBe(1);
    expect(customEngine.grid[1].label).toBe('Two');

    // Test runtime deck updates
    customEngine.setCards([
      { id: 'a', label: 'A', spokenPhrase: 'Alpha' },
      { id: 'b', label: 'B', spokenPhrase: 'Bravo' },
    ]);
    expect(customEngine.grid.length).toBe(2);
    expect(customEngine.grid[0].phrase).toBe('Alpha');
  });

  it('triggers nurse call directly via triggerNurseCall()', () => {
    let selectEvent = null;
    aac.on('select', (data) => {
      selectEvent = data;
    });

    aac.triggerNurseCall();
    expect(selectEvent).not.toBeNull();
    expect(selectEvent.item.id).toBe('nurse');
    expect(selectEvent.trigger).toBe('emergency_button');
  });

  it('maps head tilt left/right and up/down to correct grid cells', () => {
    // Top-Left (Water): look up (pitch < -5.5), look left (yaw < -6.5)
    expect(aac.mapPoseToIndex({ pitch: -10, yaw: -12, roll: 0 })).toBe(0);

    // Top-Right (Call Nurse): look up (pitch < -5.5), look right (yaw > +6.5)
    expect(aac.mapPoseToIndex({ pitch: -10, yaw: 12, roll: 0 })).toBe(2);

    // Bottom-Center (Yes): look down (pitch > +6.5), center yaw
    expect(aac.mapPoseToIndex({ pitch: 12, yaw: 0, roll: 0 })).toBe(7);

    // Bottom-Right (No): look down (pitch > +6.5), look right (yaw > +6.5)
    expect(aac.mapPoseToIndex({ pitch: 12, yaw: 12, roll: 0 })).toBe(8);
  });

  it('progresses dwell progress when holding gaze and triggers selection on dwell completion', () => {
    let selectEvent = null;
    aac.on('select', (data) => {
      selectEvent = data;
    });

    const pose = { pitch: -10, yaw: -12, roll: 0 }; // Water (0)

    aac.update({ headPose: pose, ear: 0.28 }, 0);
    const mid = aac.update({ headPose: pose, ear: 0.28 }, 500);
    expect(mid.currentIndex).toBe(0);
    expect(mid.dwellProgress).toBeCloseTo(0.5, 1);
    expect(selectEvent).toBeNull();

    // Reaching dwellMs (1000ms)
    aac.update({ headPose: pose, ear: 0.28 }, 1100);
    expect(selectEvent).not.toBeNull();
    expect(selectEvent.index).toBe(0);
    expect(selectEvent.item.id).toBe('water');
    expect(selectEvent.trigger).toBe('dwell');
  });

  it('triggers selection on intentional long blink', () => {
    let selectEvent = null;
    aac.on('select', (data) => {
      selectEvent = data;
    });

    const pose = { pitch: 0, yaw: 0, roll: 0 }; // Center (4)
    aac.update({ headPose: pose, ear: 0.28, eyeClosed: false }, 0);

    // Close eyes for 900ms (above 800ms threshold)
    aac.update({ headPose: pose, ear: 0.1, eyeClosed: true }, 100);
    aac.update({ headPose: pose, ear: 0.1, eyeClosed: true }, 500);
    expect(selectEvent).toBeNull();

    // Re-open eyes at 1050ms (950ms closed)
    aac.update({ headPose: pose, ear: 0.28, eyeClosed: false }, 1050);
    expect(selectEvent).not.toBeNull();
    expect(selectEvent.item.id).toBe('cold');
    expect(selectEvent.trigger).toBe('blink');
  });
});
