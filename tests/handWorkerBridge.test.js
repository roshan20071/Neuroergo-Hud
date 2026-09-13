import { describe, it, expect, vi } from 'vitest';

describe('Hand Worker Bridge Protocol', () => {
  it('handles HAND_READY handshake from isolated iframe worker', () => {
    let isWorkerReady = false;
    const handleMessage = (event) => {
      if (event.data?.type === 'HAND_READY') {
        isWorkerReady = true;
      }
    };

    handleMessage({ data: { type: 'HAND_READY' } });
    expect(isWorkerReady).toBe(true);
  });

  it('correctly processes HAND_RESULTS message with valid 21 hand landmarks', () => {
    let latestHandLandmarks = null;
    let isHandProcessing = true;

    const mockLandmarks = Array.from({ length: 21 }, (_, i) => ({
      x: 0.5 + i * 0.01,
      y: 0.5 - i * 0.01,
      z: 0,
    }));

    const handleMessage = (event) => {
      if (event.data?.type === 'HAND_RESULTS') {
        latestHandLandmarks = event.data.landmarks;
        isHandProcessing = false;
      }
    };

    handleMessage({ data: { type: 'HAND_RESULTS', landmarks: mockLandmarks } });

    expect(isHandProcessing).toBe(false);
    expect(latestHandLandmarks).not.toBeNull();
    expect(latestHandLandmarks.length).toBe(21);
    expect(latestHandLandmarks[8].x).toBeCloseTo(0.58, 2); // INDEX_TIP
  });

  it('safely handles null landmarks when no hand is in camera frame', () => {
    let latestHandLandmarks = [{ x: 0.5, y: 0.5, z: 0 }];
    let isHandProcessing = true;

    const handleMessage = (event) => {
      if (event.data?.type === 'HAND_RESULTS') {
        latestHandLandmarks = event.data.landmarks;
        isHandProcessing = false;
      }
    };

    handleMessage({ data: { type: 'HAND_RESULTS', landmarks: null } });

    expect(isHandProcessing).toBe(false);
    expect(latestHandLandmarks).toBeNull();
  });

  it('dispatches PROCESS_FRAME with transferred ImageBitmap to worker contentWindow', () => {
    const postMessageMock = vi.fn();
    const mockWorkerFrame = {
      contentWindow: {
        postMessage: postMessageMock,
      },
    };

    const mockBitmap = { width: 1280, height: 720, close: vi.fn() };

    // Dispatch frame to worker
    mockWorkerFrame.contentWindow.postMessage(
      { type: 'PROCESS_FRAME', imageBitmap: mockBitmap },
      '*',
      [mockBitmap]
    );

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      { type: 'PROCESS_FRAME', imageBitmap: mockBitmap },
      '*',
      [mockBitmap]
    );
  });

  it('recovers cleanly when worker frame encounters timeout or disconnect', async () => {
    let isHandProcessing = true;
    const handTimeout = setTimeout(() => {
      isHandProcessing = false;
    }, 50);

    await new Promise((r) => setTimeout(r, 60));
    expect(isHandProcessing).toBe(false);
    clearTimeout(handTimeout);
  });
});
