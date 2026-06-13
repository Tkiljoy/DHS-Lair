// nox-eye.js — vanilla port of DHS-Creator's NOX.tsx + EvilEye.tsx.
// GLSL shaders + noise generator copied verbatim. React state machine
// rewritten as a small class. framer-motion body bob → CSS keyframes
// applied via class swap. ogl served from /vendor/ogl/.

import { Renderer, Program, Mesh, Triangle, Texture } from '/vendor/ogl/index.js';

// ─── Shaders (verbatim from EvilEye.tsx) ────────────────────────────
const vertexShader = /* glsl */ `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform sampler2D uNoiseTexture;
uniform float uPupilSize;
uniform float uIrisWidth;
uniform float uGlowIntensity;
uniform float uIntensity;
uniform float uScale;
uniform float uNoiseScale;
uniform vec2 uMouse;
uniform float uPupilFollow;
uniform float uFlameSpeed;
uniform vec3 uEyeColor;
uniform vec3 uBgColor;

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution.xy) / uResolution.y;
  uv /= uScale;
  float ft = uTime * uFlameSpeed;

  float polarRadius = length(uv) * 2.0;
  float polarAngle = (2.0 * atan(uv.x, uv.y)) / 6.28 * 0.3;
  vec2 polarUv = vec2(polarRadius, polarAngle);

  vec4 noiseA = texture2D(uNoiseTexture, polarUv * vec2(0.2, 7.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));
  vec4 noiseB = texture2D(uNoiseTexture, polarUv * vec2(0.3, 4.0) * uNoiseScale + vec2(-ft * 0.2, 0.0));
  vec4 noiseC = texture2D(uNoiseTexture, polarUv * vec2(0.1, 5.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));

  float distanceMask = 1.0 - length(uv);

  float innerRing = clamp(-1.0 * ((distanceMask - 0.7) / uIrisWidth), 0.0, 1.0);
  innerRing = (innerRing * distanceMask - 0.2) / 0.28;
  innerRing += noiseA.r - 0.5;
  innerRing *= 1.3;
  innerRing = clamp(innerRing, 0.0, 1.0);

  float outerRing = clamp(-1.0 * ((distanceMask - 0.5) / 0.2), 0.0, 1.0);
  outerRing = (outerRing * distanceMask - 0.1) / 0.38;
  outerRing += noiseC.r - 0.5;
  outerRing *= 1.3;
  outerRing = clamp(outerRing, 0.0, 1.0);

  innerRing += outerRing;

  float innerEye = distanceMask - 0.1 * 2.0;
  innerEye *= noiseB.r * 2.0;

  vec2 pupilOffset = uMouse * uPupilFollow * 0.12;
  vec2 pupilUv = uv - pupilOffset;
  float pupil = 1.0 - length(pupilUv * vec2(9.0, 2.3));
  pupil *= uPupilSize;
  pupil = clamp(pupil, 0.0, 1.0);
  pupil /= 0.35;

  float outerEyeGlow = 1.0 - length(uv * vec2(0.5, 1.5));
  outerEyeGlow = clamp(outerEyeGlow + 0.5, 0.0, 1.0);
  outerEyeGlow += noiseC.r - 0.5;
  float outerBgGlow = outerEyeGlow;
  outerEyeGlow = pow(outerEyeGlow, 2.0);
  outerEyeGlow += distanceMask;
  outerEyeGlow *= uGlowIntensity;
  outerEyeGlow = clamp(outerEyeGlow, 0.0, 1.0);
  outerEyeGlow *= pow(1.0 - distanceMask, 2.0) * 2.5;

  outerBgGlow += distanceMask;
  outerBgGlow = pow(outerBgGlow, 0.5);
  outerBgGlow *= 0.15;

  float coverage = max(innerRing + innerEye, outerEyeGlow + outerBgGlow);
  vec3 color = uEyeColor * uIntensity * clamp(coverage - pupil, 0.0, 3.0);
  color += uBgColor;
  float a = smoothstep(0.02, 0.18, coverage);
  gl_FragColor = vec4(color, a);
}
`;

// ─── Helpers (verbatim from EvilEye.tsx) ────────────────────────────
function hexToVec3(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function generateNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  function hash(x, y, s) {
    let n = x * 374761393 + y * 668265263 + s * 1274126177;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function noise(px, py, freq, seed) {
    const fx = (px / size) * freq;
    const fy = (py / size) * freq;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const w = freq | 0;
    const v00 = hash(((ix % w) + w) % w, ((iy % w) + w) % w, seed);
    const v10 = hash((((ix + 1) % w) + w) % w, ((iy % w) + w) % w, seed);
    const v01 = hash(((ix % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    const v11 = hash((((ix + 1) % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    return v00 * (1 - tx) * (1 - ty)
         + v10 * tx * (1 - ty)
         + v01 * (1 - tx) * ty
         + v11 * tx * ty;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.4;
      let totalAmp = 0;
      for (let o = 0; o < 8; o++) {
        const f = 32 * (1 << o);
        v += amp * noise(x, y, f, o * 31);
        totalAmp += amp;
        amp *= 0.65;
      }
      v /= totalAmp;
      v = (v - 0.5) * 2.2 + 0.5;
      v = Math.max(0, Math.min(1, v));
      const val = Math.round(v * 255);
      const i = (y * size + x) * 4;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
  }
  return data;
}

// ─── Emotion presets (verbatim from NOX.tsx) ────────────────────────
const EMOTION_PRESETS = {
  idle:     { pupilSize: 1.7, irisWidth: 0.45, glowIntensity: 0.55, intensity: 1.6,  pupilFollow: 2,   flameSpeed: 1,   scale: 0.28 },
  talking:  { pupilSize: 1.9, irisWidth: 0.5,  glowIntensity: 0.7,  intensity: 1.75, pupilFollow: 2.2, flameSpeed: 1.3, scale: 0.30 },
  excited:  { pupilSize: 2.1, irisWidth: 0.55, glowIntensity: 0.9,  intensity: 2.0,  pupilFollow: 2.5, flameSpeed: 1.6, scale: 0.32 },
  thinking: { pupilSize: 1.4, irisWidth: 0.5,  glowIntensity: 0.45, intensity: 1.55, pupilFollow: 0.8, flameSpeed: 0.7, scale: 0.26 },
  pointing: { pupilSize: 2.3, irisWidth: 0.5,  glowIntensity: 0.8,  intensity: 1.8,  pupilFollow: 2.6, flameSpeed: 1.2, scale: 0.30 },
};

// ─── NoxEye class ───────────────────────────────────────────────────
export class NoxEye {
  /**
   * @param {HTMLElement} container — DOM element the canvas mounts into.
   * @param {object} [opts]
   * @param {string} [opts.eyeColor] — initial iris color (hex).
   * @param {string} [opts.bodyEl] — optional element receiving emotion-class for body bob.
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.bodyEl = opts.bodyEl ?? container;
    this.emotion = 'idle';
    this.preset = EMOTION_PRESETS.idle;
    this.eyeColor = opts.eyeColor ?? '#a88bfa';
    this.lookAt = null;
    this.pupilTarget = null;
    this.audioLevel = 0;       // bound to TTS analyser when wired (deferred)
    this.blinking = false;
    this.disposed = false;

    // Animated mouse (lerped toward target)
    this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };

    this._initGL();
    this._startBlinkLoop();
    this._attachMouseListener();
    this._startRenderLoop();

    // Apply initial body class
    this.bodyEl.classList.add('nox-emotion-idle');
  }

  _initGL() {
    const renderer = new Renderer({ alpha: true, premultipliedAlpha: false });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);

    const noiseData = generateNoiseTexture(256);
    const noiseTexture = new Texture(gl, {
      image: noiseData, width: 256, height: 256,
      generateMipmaps: false, flipY: false,
    });
    noiseTexture.minFilter = gl.LINEAR;
    noiseTexture.magFilter = gl.LINEAR;
    noiseTexture.wrapS = gl.REPEAT;
    noiseTexture.wrapT = gl.REPEAT;

    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height] },
        uNoiseTexture: { value: noiseTexture },
        uPupilSize: { value: this.preset.pupilSize },
        uIrisWidth: { value: this.preset.irisWidth },
        uGlowIntensity: { value: this.preset.glowIntensity },
        uIntensity: { value: this.preset.intensity },
        uScale: { value: this.preset.scale },
        uNoiseScale: { value: 1 },
        uMouse: { value: [0, 0] },
        uPupilFollow: { value: this.preset.pupilFollow },
        uFlameSpeed: { value: this.preset.flameSpeed },
        uEyeColor: { value: hexToVec3(this.eyeColor) },
        uBgColor: { value: hexToVec3('#000000') },
      },
    });
    const geometry = new Triangle(gl);
    const mesh = new Mesh(gl, { geometry, program });
    this.container.appendChild(gl.canvas);

    this.renderer = renderer;
    this.gl = gl;
    this.program = program;
    this.mesh = mesh;

    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  _resize() {
    const c = this.container;
    this.renderer.setSize(c.offsetWidth, c.offsetHeight);
    const gl = this.gl;
    this.program.uniforms.uResolution.value = [
      gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height,
    ];
  }

  _attachMouseListener() {
    this._mouseHandler = (e) => {
      const rect = this.container.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r = Math.max(12, Math.min(rect.width, rect.height) / 2);
      this.mouse.tx = Math.max(-1.5, Math.min(1.5, (e.clientX - cx) / r));
      this.mouse.ty = Math.max(-1.5, Math.min(1.5, -((e.clientY - cy) / r)));
    };
    window.addEventListener('mousemove', this._mouseHandler);
  }

  _startBlinkLoop() {
    const loop = () => {
      if (this.disposed) return;
      const next = 4000 + Math.random() * 4000;
      this._blinkTimeout = setTimeout(() => {
        if (this.disposed) return;
        this.blinking = true;
        this._blinkResetTimeout = setTimeout(() => {
          if (this.disposed) return;
          this.blinking = false;
          loop();
        }, 140);
      }, next);
    };
    loop();
  }

  _startRenderLoop() {
    const tick = (t) => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(tick);

      // Smooth pupil tracking. pupilTarget override takes precedence.
      if (this.pupilTarget) {
        this.mouse.x += (this.pupilTarget.x - this.mouse.x) * 0.08;
        this.mouse.y += (this.pupilTarget.y - this.mouse.y) * 0.08;
      } else {
        this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.05;
        this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.05;
      }

      // Compose live uniform values: base preset + blink + audio-reactive boost.
      const pupilSize = this.blinking ? 0.4 : this.preset.pupilSize * (1 + this.audioLevel * 0.30);
      const intensity = this.preset.intensity * (1 + this.audioLevel * 0.25);
      const glow = this.preset.glowIntensity * (1 + this.audioLevel * 0.35);

      const u = this.program.uniforms;
      u.uMouse.value = [this.mouse.x, this.mouse.y];
      u.uTime.value = t * 0.001;
      u.uPupilSize.value = pupilSize;
      u.uIrisWidth.value = this.preset.irisWidth;
      u.uGlowIntensity.value = glow;
      u.uIntensity.value = intensity;
      u.uScale.value = this.preset.scale;
      u.uPupilFollow.value = this.preset.pupilFollow;
      u.uFlameSpeed.value = this.preset.flameSpeed;
      u.uEyeColor.value = hexToVec3(this.eyeColor);

      this.renderer.render({ scene: this.mesh });
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** Switch emotion. Updates shader presets + body bob class. */
  setEmotion(name) {
    if (!EMOTION_PRESETS[name]) return;
    if (this.emotion === name) return;
    // Swap CSS class for body motion
    this.bodyEl.classList.remove(`nox-emotion-${this.emotion}`);
    this.bodyEl.classList.add(`nox-emotion-${name}`);
    this.emotion = name;
    this.preset = EMOTION_PRESETS[name];
  }

  /** Update iris color (hex). Recomputes via hexToVec3 each frame, so just set the field. */
  setColor(hex) {
    if (!hex || !/^#?[0-9a-fA-F]{6}$/.test(hex.replace('#',''))) return;
    this.eyeColor = hex.startsWith('#') ? hex : '#' + hex;
  }

  /** Override cursor tracking with a fixed normalized direction (-1..1). null = follow cursor. */
  setLookAt(target) {
    this.pupilTarget = target;
  }

  /** Trigger a brief excited burst (~2s), then back to idle. */
  flashExcited(durationMs = 2000) {
    const prev = this.emotion;
    this.setEmotion('excited');
    if (this._exciteTimeout) clearTimeout(this._exciteTimeout);
    this._exciteTimeout = setTimeout(() => {
      // Only fall back if nothing else has overridden us
      if (this.emotion === 'excited') this.setEmotion(prev === 'excited' ? 'idle' : prev);
    }, durationMs);
  }

  dispose() {
    this.disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._blinkTimeout) clearTimeout(this._blinkTimeout);
    if (this._blinkResetTimeout) clearTimeout(this._blinkResetTimeout);
    if (this._exciteTimeout) clearTimeout(this._exciteTimeout);
    window.removeEventListener('resize', this._resizeHandler);
    window.removeEventListener('mousemove', this._mouseHandler);
    if (this.gl?.canvas?.parentNode === this.container) {
      this.container.removeChild(this.gl.canvas);
    }
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
