/**
 * cameraManager.js
 * ---------------------------------------------------------------------------
 * Webcam enumeration, preference scoring, permission acquisition, and device switching.
 * Prioritizes integrated laptop webcams over connected phones or virtual devices.
 * ---------------------------------------------------------------------------
 */

export class CameraManager {
  constructor(videoElement, cameraSelectElement, options = {}) {
    this.video = videoElement;
    this.cameraSelect = cameraSelectElement;
    this.selectedCameraId = options.selectedCameraId || '';
    this.stream = null;
    this.onStreamChange = options.onStreamChange || null;
    this.onError = options.onError || null;
  }

  scoreCameraDevice(device) {
    const label = (device.label || '').toLowerCase();
    // Phone or external/virtual links (Windows Phone Link, CrossDevice, OnePlus, DroidCam, etc.)
    if (/oneplus|phone|crossdevice|droid|iriun|epoc|camo|virtual|obs|link/i.test(label)) {
      return -10;
    }
    // Laptop internal / integrated webcams
    if (/integrated|internal|built-in|facetime|front|hd camera|webcam|camera/i.test(label)) {
      return 10;
    }
    return 0;
  }

  async populateCameraDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      if (videoDevices.length === 0) return [];

      // Prioritize internal laptop webcams over phone/virtual links
      videoDevices.sort((a, b) => this.scoreCameraDevice(b) - this.scoreCameraDevice(a));

      if (this.cameraSelect) {
        this.cameraSelect.innerHTML = '';
        videoDevices.forEach((dev, idx) => {
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          const score = this.scoreCameraDevice(dev);
          let suffix = '';
          if (score > 0) suffix = ' [Laptop Webcam]';
          else if (score < 0) suffix = ' [Phone / Link]';

          opt.textContent = (dev.label || `Camera ${idx + 1}`) + suffix;
          this.cameraSelect.appendChild(opt);
        });

        if (!this.selectedCameraId || !videoDevices.some((d) => d.deviceId === this.selectedCameraId)) {
          this.selectedCameraId = videoDevices[0].deviceId;
        }
        this.cameraSelect.value = this.selectedCameraId;
      }

      return videoDevices;
    } catch (err) {
      console.warn('Failed to enumerate camera devices:', err);
      return [];
    }
  }

  async startStream() {
    const constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        ...(this.selectedCameraId ? { deviceId: { exact: this.selectedCameraId } } : { facingMode: 'user' }),
      },
      audio: false,
    };

    let streamObtained = null;
    try {
      streamObtained = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (this.selectedCameraId) {
        console.warn('Selected camera unavailable, falling back to default camera:', err);
        streamObtained = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
      } else {
        throw err;
      }
    }

    this.stream = streamObtained;
    this.video.srcObject = this.stream;
    await this.video.play();

    // Populate camera select now that permission is granted
    await this.populateCameraDevices();

    // Auto-switch to laptop webcam if Windows routed initial stream to a connected phone
    const activeTrack = this.stream.getVideoTracks()[0];
    const activeDeviceId = activeTrack?.getSettings()?.deviceId;
    if (activeDeviceId && this.cameraSelect) {
      const currentOption = Array.from(this.cameraSelect.options).find((o) => o.value === activeDeviceId);
      const isPhoneActive = currentOption && currentOption.textContent.includes('[Phone / Link]');
      const laptopOption = Array.from(this.cameraSelect.options).find((o) => o.textContent.includes('[Laptop Webcam]'));

      if (isPhoneActive && laptopOption && laptopOption.value !== activeDeviceId) {
        console.log('Auto-switching from phone camera to laptop webcam:', laptopOption.textContent);
        await this.switchCamera(laptopOption.value);
        this.cameraSelect.value = laptopOption.value;
        this.selectedCameraId = laptopOption.value;
      } else {
        this.selectedCameraId = activeDeviceId;
        this.cameraSelect.value = activeDeviceId;
      }
    }

    // Wait until video metadata and non-zero dimensions are ready
    if (!this.video.videoWidth || !this.video.videoHeight) {
      await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (!resolved && this.video.videoWidth > 0 && this.video.videoHeight > 0) {
            resolved = true;
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          this.video.removeEventListener('loadedmetadata', done);
          this.video.removeEventListener('canplay', done);
          this.video.removeEventListener('playing', done);
        };
        this.video.addEventListener('loadedmetadata', done);
        this.video.addEventListener('canplay', done);
        this.video.addEventListener('playing', done);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }, 1500);
      });
    }

    if (this.onStreamChange) {
      this.onStreamChange(this.stream, this.video.videoWidth || 1280, this.video.videoHeight || 720);
    }

    return this.stream;
  }

  async switchCamera(deviceId) {
    this.selectedCameraId = deviceId;
    if (!this.stream) return;

    this.stopStream();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        ...(this.selectedCameraId ? { deviceId: { exact: this.selectedCameraId } } : { facingMode: 'user' }),
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    if (this.onStreamChange) {
      this.onStreamChange(this.stream, w, h);
    }
  }

  stopStream() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}
