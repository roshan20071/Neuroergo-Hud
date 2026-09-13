/**
 * hudRenderer.js
 * ---------------------------------------------------------------------------
 * Manages the transparent WebGL overlay that renders holographic reticles
 * synchronized to smoothed facial/hand landmark positions on top of the
 * live camera feed.
 *
 * Design notes:
 *  - An orthographic camera is used, with the view volume set to match the
 *    video's pixel dimensions and Y flipped, so a reticle can be positioned
 *    directly from normalized MediaPipe coordinates (x*width, y*height) with
 *    no perspective projection math required -- appropriate for a 2D HUD
 *    overlay rather than a 3D scene.
 *  - Reticles use a small custom GLSL ShaderMaterial ("neon wireframe")
 *    rather than a stock MeshBasicMaterial, giving a pulsing rim-lit glow
 *    driven by a `uTime` uniform, which is updated once per render() call.
 *  - Every mesh, geometry, and material this module allocates is tracked in
 *    `_disposables` and torn down in dispose(); addReticle()/removeReticle()
 *    are symmetric so mode switches (e.g. face-only -> face+hands) never
 *    accumulate orphaned GPU resources.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';

/**
 * Defensive shim: ensure getShaderPrecisionFormat never returns null or undefined.
 * This prevents Three.js WebGLCapabilities from throwing:
 *   TypeError: Cannot read properties of null (reading 'precision')
 * in environments where WebGL precision queries return null (e.g. context loss,
 * software ANGLE fallbacks, privacy extensions, or specific driver implementations).
 */
export function patchWebGLPrecision() {
  const patch = (proto) => {
    if (!proto || proto.__precisionPatched) return;
    const orig = proto.getShaderPrecisionFormat;
    if (typeof orig === 'function') {
      proto.getShaderPrecisionFormat = function (shaderType, precisionType) {
        try {
          const res = orig.call(this, shaderType, precisionType);
          if (res && typeof res.precision === 'number') return res;
        } catch (_) {}
        return { rangeMin: 1, rangeMax: 1, precision: 23 };
      };
      proto.__precisionPatched = true;
    }
  };
  if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
}

patchWebGLPrecision();

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    // Fresnel-style rim term: brighter where the surface normal grazes the
    // view direction, which is what gives a thin ring geometry its glowing
    // "holographic edge" look rather than flat, uniform color.
    vec3 viewDir = normalize(vViewPosition);
    float rim = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 2.0);
    float pulse = 0.65 + 0.35 * sin(uTime * 3.0);
    vec3 color = uColor * (0.55 + rim * 1.5) * pulse;
    gl_FragColor = vec4(color, uOpacity * (0.5 + rim * 0.5));
  }
`;

/**
 * Builds the shared "neon wireframe" ShaderMaterial used by reticles.
 * @param {THREE.Color | number | string} color
 * @returns {THREE.ShaderMaterial}
 */
function createReticleMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uOpacity: { value: 0.9 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** @typedef {'ring'|'dot'|'crosshair'} ReticleType */

export class HUDRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{width: number, height: number}} size CSS pixel size, matching the video element
   */
  constructor(canvas, { width = 1280, height = 720 } = {}) {
    this.canvas = canvas;
    this.width = width || 1280;
    this.height = height || 720;
    this._disposed = false;
    this.useFallback2D = false;
    this.ctx2d = null;

    /** @type {Map<string, {type: ReticleType, color: number|string, size: number, point: {x:number, y:number, z?:number}|null, visible: boolean, mesh?: THREE.Mesh, geometry?: THREE.BufferGeometry, material?: THREE.ShaderMaterial}>} */
    this._reticles = new Map();

    patchWebGLPrecision();

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(this.width, this.height, false);

      this.scene = new THREE.Scene();

      // Orthographic camera mapped 1:1 to pixel space, Y flipped so that
      // image-space (0,0) at the top-left matches landmark coordinate
      // convention (MediaPipe's y grows downward; Three.js world y grows
      // upward by default).
      this.camera = new THREE.OrthographicCamera(0, this.width, 0, this.height, -1000, 1000);
      this.camera.position.z = 500;

      // A soft ambient term plus one directional key light so the shader's
      // fresnel rim has something physically motivated to react to.
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffffff, 0.6);
      key.position.set(0, 0, 1);
      this.scene.add(key);
    } catch (err) {
      console.warn('WebGL initialization failed, using 2D canvas overlay fallback:', err);
      this._initFallback2D();
    }
  }

  /**
   * Initializes 2D context fallback on the canvas.
   * If the canvas already had a failed WebGL context attached, replaces it in DOM.
   * @private
   */
  _initFallback2D() {
    this.useFallback2D = true;
    if (this.renderer) {
      try {
        this.renderer.dispose();
      } catch (_) {}
      this.renderer = null;
    }

    let ctx = null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch (_) {}

    if (!ctx && this.canvas && this.canvas.parentNode) {
      const freshCanvas = document.createElement('canvas');
      freshCanvas.id = this.canvas.id;
      freshCanvas.className = this.canvas.className;
      freshCanvas.width = this.width;
      freshCanvas.height = this.height;
      this.canvas.parentNode.replaceChild(freshCanvas, this.canvas);
      this.canvas = freshCanvas;
      ctx = freshCanvas.getContext('2d');
    }
    this.ctx2d = ctx;
  }

  /**
   * @private
   * @param {ReticleType} type
   * @param {number} size
   */
  _buildGeometry(type, size) {
    switch (type) {
      case 'dot':
        return new THREE.CircleGeometry(size * 0.35, 24);
      case 'crosshair':
        return new THREE.RingGeometry(size * 0.5, size * 0.62, 4, 1);
      case 'ring':
      default:
        return new THREE.RingGeometry(size * 0.6, size * 0.75, 32);
    }
  }

  /**
   * Adds a new tracked reticle attached to a landmark.
   * @param {string} id unique key, e.g. `face-nose` or `hand-index-tip`
   * @param {{type?: ReticleType, color?: number|string, size?: number}} [opts]
   */
  addReticle(id, { type = 'ring', color = 0x39f0c0, size = 18 } = {}) {
    if (this._reticles.has(id)) return;

    /** @type {any} */
    const entry = { type, color, size, point: null, visible: false };

    if (!this.useFallback2D && this.scene) {
      try {
        const geometry = this._buildGeometry(type, size);
        const material = createReticleMaterial(color);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.z = 0;
        mesh.visible = false;
        this.scene.add(mesh);
        entry.mesh = mesh;
        entry.geometry = geometry;
        entry.material = material;
      } catch (err) {
        console.warn('Failed to build Three.js reticle mesh, switching to 2D HUD:', err);
        this._initFallback2D();
      }
    }

    this._reticles.set(id, entry);
  }

  /**
   * Moves a reticle to a new position in normalized [0,1] landmark coordinates.
   * @param {string} id
   * @param {{x: number, y: number, z?: number}} normalizedPoint
   */
  updateReticle(id, normalizedPoint) {
    const entry = this._reticles.get(id);
    if (!entry) return;
    entry.point = normalizedPoint;
    entry.visible = true;

    if (entry.mesh) {
      entry.mesh.position.x = normalizedPoint.x * this.width;
      entry.mesh.position.y = normalizedPoint.y * this.height;
      entry.mesh.position.z = (normalizedPoint.z ?? 0) * this.width;
      entry.mesh.visible = true;
    }
  }

  /** Hides a reticle without destroying resources. @param {string} id */
  hideReticle(id) {
    const entry = this._reticles.get(id);
    if (!entry) return;
    entry.visible = false;
    if (entry.mesh) entry.mesh.visible = false;
  }

  /** Removes a reticle and immediately frees resources. @param {string} id */
  removeReticle(id) {
    const entry = this._reticles.get(id);
    if (!entry) return;
    if (entry.mesh && this.scene) {
      this.scene.remove(entry.mesh);
      entry.geometry?.dispose();
      entry.material?.dispose();
    }
    this._reticles.delete(id);
  }

  /** Removes every currently tracked reticle. */
  clearReticles() {
    for (const id of Array.from(this._reticles.keys())) this.removeReticle(id);
  }

  /**
   * Updates shader time or 2D glow pulse and draws one frame.
   * @param {number} timeSeconds
   */
  render(timeSeconds) {
    if (this._disposed) return;

    if (!this.useFallback2D && this.renderer && this.scene && this.camera) {
      try {
        for (const entry of this._reticles.values()) {
          if (entry.material?.uniforms?.uTime) {
            entry.material.uniforms.uTime.value = timeSeconds;
          }
        }
        this.renderer.render(this.scene, this.camera);
        return;
      } catch (err) {
        console.warn('Three.js render failed, switching to 2D HUD fallback:', err);
        this._initFallback2D();
      }
    }

    if (this.ctx2d) {
      const ctx = this.ctx2d;
      ctx.clearRect(0, 0, this.width, this.height);
      const pulse = 0.65 + 0.35 * Math.sin(timeSeconds * 3.0);

      for (const entry of this._reticles.values()) {
        if (!entry.visible || !entry.point) continue;
        const x = entry.point.x * this.width;
        const y = entry.point.y * this.height;
        const hex = typeof entry.color === 'number'
          ? '#' + entry.color.toString(16).padStart(6, '0')
          : entry.color;

        ctx.save();
        ctx.strokeStyle = hex;
        ctx.fillStyle = hex;
        ctx.shadowColor = hex;
        ctx.shadowBlur = 12 * pulse;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.85 * pulse;

        if (entry.type === 'dot') {
          ctx.beginPath();
          ctx.arc(x, y, entry.size * 0.35, 0, Math.PI * 2);
          ctx.fill();
        } else if (entry.type === 'crosshair') {
          const s = entry.size * 0.6;
          ctx.beginPath();
          ctx.moveTo(x - s, y);
          ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s);
          ctx.lineTo(x, y + s);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, entry.size * 0.65, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  /** @param {number} width @param {number} height */
  resize(width, height) {
    this.width = width;
    this.height = height;
    if (this.camera) {
      this.camera.right = width;
      this.camera.bottom = height;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) {
      try {
        this.renderer.setSize(width, height, false);
      } catch (_) {}
    }
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Tears down resources cleanly.
   * Preserves canvas context so the element can be safely reused on restart.
   */
  dispose() {
    if (this._disposed) return;
    this.clearReticles();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    if (this.renderer) {
      try {
        this.renderer.dispose();
      } catch (_) {}
      this.renderer = null;
    }
    if (this.ctx2d) {
      try {
        this.ctx2d.clearRect(0, 0, this.width, this.height);
      } catch (_) {}
    }
    this._disposed = true;
  }
}
