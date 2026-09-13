import { describe, expect, it } from 'vitest';
import { TelemetryRecorder } from '../src/engine/telemetryRecorder.js';

describe('TelemetryRecorder', () => {
  it('initializes in an idle non-recording state', () => {
    const recorder = new TelemetryRecorder();
    expect(recorder.isRecording).toBe(false);
    expect(recorder.samples).toHaveLength(0);
    const summary = recorder.getSummary();
    expect(summary.sampleCount).toBe(0);
    expect(summary.avgFps).toBe(0);
  });

  it('records frames when active and computes elapsed times accurately', () => {
    const recorder = new TelemetryRecorder();
    recorder.start(1000);
    expect(recorder.isRecording).toBe(true);

    const mockTelemetry1 = {
      ear: 0.2854,
      blinkRatePerMin: 15.2,
      distanceCm: 52.4,
      headPose: { pitch: 5.2, yaw: -1.1, roll: 0.4 },
      alerts: [],
    };
    const s1 = recorder.recordFrame(mockTelemetry1, 'ENGAGED', 1000);
    expect(s1.elapsedSec).toBe(0);
    expect(s1.ear).toBe(0.285);
    expect(s1.distanceCm).toBe(52.4);
    expect(s1.gesture).toBe('ENGAGED');
    expect(s1.alerts).toBe('NONE');

    const mockTelemetry2 = {
      ear: 0.15,
      blinkRatePerMin: 18.0,
      distanceCm: 35.0,
      headPose: { pitch: 24.1, yaw: 0.0, roll: -16.2 },
      alerts: [{ type: 'FORWARD_HEAD_TILT' }, { type: 'LATERAL_HEAD_TILT' }],
    };
    const s2 = recorder.recordFrame(mockTelemetry2, 'TARGETING', 2500);
    expect(s2.elapsedSec).toBe(1.5);
    expect(s2.alerts).toBe('FORWARD_HEAD_TILT;LATERAL_HEAD_TILT');
    expect(recorder.samples).toHaveLength(2);
  });

  it('handles null or undefined telemetry without throwing', () => {
    const recorder = new TelemetryRecorder();
    recorder.start(1000);
    const sample = recorder.recordFrame(null, 'IDLE', 1500);
    expect(sample).toBeDefined();
    expect(sample.ear).toBe(0);
    expect(sample.distanceCm).toBe(0);
    expect(sample.alerts).toBe('NONE');
    expect(recorder.samples).toHaveLength(1);
  });

  it('ignores recordFrame calls when not recording', () => {
    const recorder = new TelemetryRecorder();
    const s = recorder.recordFrame({ ear: 0.3 }, 'IDLE', 1000);
    expect(s).toBeNull();
    expect(recorder.samples).toHaveLength(0);
  });

  it('respects maxSamples boundary', () => {
    const recorder = new TelemetryRecorder({ maxSamples: 2 });
    recorder.start(0);
    recorder.recordFrame({ ear: 0.3 }, 'IDLE', 100);
    recorder.recordFrame({ ear: 0.3 }, 'IDLE', 200);
    const rejected = recorder.recordFrame({ ear: 0.3 }, 'IDLE', 300);
    expect(rejected).toBeNull();
    expect(recorder.samples).toHaveLength(2);
  });

  it('generates standard CSV with correct header and formatted rows', () => {
    const recorder = new TelemetryRecorder();
    recorder.start(0);
    recorder.recordFrame(
      {
        ear: 0.28,
        blinkRatePerMin: 12.0,
        distanceCm: 50.0,
        headPose: { pitch: 2.0, yaw: 1.0, roll: -1.0 },
        alerts: [{ type: 'SCREEN_TOO_CLOSE' }],
      },
      'PINCH_CONFIRMED',
      1000
    );

    const csv = recorder.toCSV();
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'elapsed_sec,eye_aspect_ratio,blink_count,blink_rate_per_min,screen_distance_cm,pitch_deg,yaw_deg,roll_deg,gesture_state,alerts'
    );
    expect(lines[1]).toContain('1,0.28,0,12,50,2,1,-1,"PINCH_CONFIRMED","SCREEN_TOO_CLOSE"');
  });

  it('generates valid JSON with summary metadata and samples', () => {
    const recorder = new TelemetryRecorder();
    recorder.start(0);
    recorder.recordFrame({ ear: 0.25, distanceCm: 45, headPose: { pitch: 0, yaw: 0, roll: 0 } }, 'IDLE', 500);
    recorder.stop(1000);

    const jsonStr = recorder.toJSON();
    const parsed = JSON.parse(jsonStr);
    expect(parsed.exportedAt).toBeDefined();
    expect(parsed.summary.sampleCount).toBe(1);
    expect(parsed.summary.durationSec).toBe(1);
    expect(parsed.samples).toHaveLength(1);
  });

  it('computes summary statistics and alert frequency tallies correctly', () => {
    const recorder = new TelemetryRecorder();
    recorder.start(1000);
    recorder.recordFrame({ ear: 0.2, distanceCm: 40, blinkCount: 1 }, 'IDLE', 1000);
    recorder.recordFrame({ ear: 0.4, distanceCm: 60, blinkCount: 3, alerts: [{ type: 'MICROSLEEP' }] }, 'ENGAGED', 2000);
    const summary = recorder.stop(3000);

    expect(summary.durationSec).toBe(2);
    expect(summary.sampleCount).toBe(2);
    expect(summary.avgFps).toBe(1);
    expect(summary.totalBlinks).toBe(3);
    expect(summary.avgEar).toBe(0.3);
    expect(summary.avgDistanceCm).toBe(50);
    expect(summary.alertCounts.MICROSLEEP).toBe(1);
  });
});
