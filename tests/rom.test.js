import { describe, it, expect, beforeEach } from 'vitest';
import { ROMEngine, ROM_STEPS } from '../src/engine/romEngine.js';

describe('ROMEngine', () => {
  let rom;

  beforeEach(() => {
    rom = new ROMEngine();
  });

  it('starts at READY step with 0 angles', () => {
    const step = rom.getCurrentStep();
    expect(step.id).toBe('READY');
    expect(rom.results.maxLeftYaw).toBe(0);
    expect(rom.results.maxRightYaw).toBe(0);
    expect(rom.results.maxLeftRoll).toBe(0);
    expect(rom.results.maxRightRoll).toBe(0);
    expect(rom.steps.length).toBe(6);
  });

  it('tares neutral baseline and advances to LEFT_ROTATION', () => {
    rom.tare({ pitch: 10, yaw: 5, roll: 0 });
    expect(rom.isTareComplete).toBe(true);
    expect(rom.getCurrentStep().id).toBe('LEFT_ROTATION');
  });

  it('captures peak left and right yaw rotations correctly relative to baseline', () => {
    rom.tare({ pitch: 0, yaw: 0, roll: 0 });

    // Step: LEFT_ROTATION
    rom.update({ pitch: 0, yaw: -45, roll: 0 });
    rom.update({ pitch: 0, yaw: -72, roll: 0 });
    rom.update({ pitch: 0, yaw: -30, roll: 0 });
    expect(rom.results.maxLeftYaw).toBe(72);

    // Advance to RIGHT_ROTATION
    rom.nextStep();
    expect(rom.getCurrentStep().id).toBe('RIGHT_ROTATION');

    rom.update({ pitch: 0, yaw: 50, roll: 0 });
    rom.update({ pitch: 0, yaw: 68, roll: 0 });
    expect(rom.results.maxRightYaw).toBe(68);
  });

  it('captures lateral flexion side bend peaks and calculates lateral symmetry', () => {
    rom.tare({ pitch: 0, yaw: 0, roll: 0 });
    rom.nextStep(); // to RIGHT_ROTATION
    rom.nextStep(); // to LATERAL_FLEXION
    expect(rom.getCurrentStep().id).toBe('LATERAL_FLEXION');

    // Left roll: negative roll
    rom.update({ pitch: 0, yaw: 0, roll: -38 });
    rom.update({ pitch: 0, yaw: 0, roll: -42 });
    // Right roll: positive roll
    rom.update({ pitch: 0, yaw: 0, roll: 35 });
    rom.update({ pitch: 0, yaw: 0, roll: 40 });

    expect(rom.results.maxLeftRoll).toBe(42);
    expect(rom.results.maxRightRoll).toBe(40);

    rom.nextStep(); // to FLEXION_EXTENSION
    rom.nextStep(); // to COMPLETE
    expect(rom.getCurrentStep().id).toBe('COMPLETE');

    // 40 / 42 * 100 = 95%
    expect(rom.results.lateralSymmetryPct).toBe(95);
  });

  it('calculates bilateral rotation and lateral symmetry correctly upon completion', () => {
    rom.tare({ pitch: 0, yaw: 0, roll: 0 });

    // Left rotation = 80
    rom.update({ pitch: 0, yaw: -80, roll: 0 });
    rom.nextStep(); // to RIGHT_ROTATION

    // Right rotation = 60
    rom.update({ pitch: 0, yaw: 60, roll: 0 });
    rom.nextStep(); // to LATERAL_FLEXION

    // Lateral flexion: Left = 40, Right = 36
    rom.update({ pitch: 0, yaw: 0, roll: -40 });
    rom.update({ pitch: 0, yaw: 0, roll: 36 });
    rom.nextStep(); // to FLEXION_EXTENSION

    // Flexion = 45, Extension = 50
    rom.update({ pitch: 45, yaw: 0, roll: 0 });
    rom.update({ pitch: -50, yaw: 0, roll: 0 });
    const isDone = rom.nextStep(); // to COMPLETE

    expect(isDone).toBe(true);
    expect(rom.getCurrentStep().id).toBe('COMPLETE');
    // Rotation Symmetry: 60 / 80 * 100 = 75%
    expect(rom.results.rotationSymmetryPct).toBe(75);
    // Lateral Symmetry: 36 / 40 * 100 = 90%
    expect(rom.results.lateralSymmetryPct).toBe(90);

    const report = rom.generateClinicalReport();
    expect(report).toContain('CERVICAL SPINE RANGE OF MOTION (ROM) REPORT');
    expect(report).toContain('Left Cervical Rotation:   80°');
    expect(report).toContain('Right Cervical Rotation:  60°');
    expect(report).toContain('Left Lateral Flexion:     40°');
    expect(report).toContain('Right Lateral Flexion:    36°');
    expect(report).toContain('Bilateral Rotation Symmetry: 75%');
    expect(report).toContain('Bilateral Lateral Flexion Symmetry: 90%');
  });
});
