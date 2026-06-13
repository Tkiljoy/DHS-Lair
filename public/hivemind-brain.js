// 3D hive-mind "brain" view. ogl-based neural cluster.
// 5 sphere-billboard nodes (one per agent) at fixed positions in 3D.
// 4 edges (specialists -> NØX). Camera slowly orbits.
// On hive_mind_log activity, the firing node pulses bright and a particle
// travels along its edge.

import { Renderer, Camera, Transform, Geometry, Program, Mesh, Triangle } from '/vendor/ogl/index.js';

const POLL_MS = 3000;
const PULSE_MS = 1400;

// Agent positions in world space (NØX at origin, others in a vertical ring around it)
// Colors in linear-ish RGB (close enough for emissive)
const AGENTS = [
  { id: 'nox',    label: 'NØX',    pos: [0,    0,    0],    color: [0.66, 0.55, 0.98] }, // purple
  { id: 'dev',    label: 'DEV',    pos: [-1.6, 0.7,  0.4],  color: [0.38, 0.65, 0.98] }, // blue
  { id: 'review', label: 'REVIEW', pos: [ 1.6, 0.7, -0.4],  color: [0.96, 0.62, 0.04] }, // amber
  { id: 'ideas',  label: 'IDEAS',  pos: [-1.4, -0.8, -0.4], color: [0.29, 0.87, 0.94] }, // cyan
  { id: 'ops',    label: 'OPS',    pos: [ 1.4, -0.8, 0.4],  color: [0.29, 0.87, 0.50] }, // green
];

/** Project a world-space point to CSS pixel coords inside the renderer's container.
 *  Returns [x, y, visible] where visible=false if the point is behind the camera. */
function projectToScreen(world, view, proj, cssW, cssH) {
  const x = world[0], y = world[1], z = world[2];
  // view * world (column-major: matrix[col][row], so view[0..3] is column 0)
  const vx = view[0]*x + view[4]*y + view[8]*z  + view[12];
  const vy = view[1]*x + view[5]*y + view[9]*z  + view[13];
  const vz = view[2]*x + view[6]*y + view[10]*z + view[14];
  const vw = view[3]*x + view[7]*y + view[11]*z + view[15];
  // proj * (view * world)
  const cx = proj[0]*vx + proj[4]*vy + proj[8]*vz  + proj[12]*vw;
  const cy = proj[1]*vx + proj[5]*vy + proj[9]*vz  + proj[13]*vw;
  const cw = proj[3]*vx + proj[7]*vy + proj[11]*vz + proj[15]*vw;
  if (cw <= 0.001) return [0, 0, false]; // behind camera
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return [
    (ndcX + 1) * 0.5 * cssW,
    (1 - ndcY) * 0.5 * cssH,
    true,
  ];
}

const EDGES = [
  ['dev',    'nox'],
  ['review', 'nox'],
  ['ideas',  'nox'],
  ['ops',    'nox'],
];

// ── Shaders ─────────────────────────────────────────────────

// Billboard glowing sphere — Triangle quad, frag shader draws a soft disc.
const NODE_VS = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  uniform mat4 uView;
  uniform mat4 uProj;
  uniform float uSize;
  uniform vec3 uCenter;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 worldPos = uCenter + uCamRight * position.x * uSize + uCamUp * position.y * uSize;
    gl_Position = uProj * uView * vec4(worldPos, 1.0);
  }
`;
const NODE_FS = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float r = length(c);
    // Inner solid core
    float core = smoothstep(0.45, 0.18, r);
    // Outer halo — tighter & dimmer so idle nodes don't drown the active one.
    float halo = exp(-r * 4.5) * 0.35;
    // Halo also fades at idle, so active nodes get a visible glow ring.
    float haloFactor = 0.35 + uIntensity * 0.9;
    float a = clamp(core + halo * haloFactor, 0.0, 1.0);
    // Larger idle/active emission gap: idle ~0.30x, active ~1.65x of base color.
    float emit = 0.30 + uIntensity * 1.35;
    vec3 col = uColor * emit * (core * 1.4 + halo * haloFactor * 0.9);
    gl_FragColor = vec4(col, a);
  }
`;

// Line edges — simple solid color with optional emissive boost
const LINE_VS = /* glsl */ `
  attribute vec3 position;
  uniform mat4 uView;
  uniform mat4 uProj;
  void main() {
    gl_Position = uProj * uView * vec4(position, 1.0);
  }
`;
const LINE_FS = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uActive;
  void main() {
    // Idle edges are very faint; active edges pop. Bigger contrast = easier
    // to see which connection actually fired.
    float a = mix(0.08, 0.85, uActive);
    gl_FragColor = vec4(uColor * (0.30 + uActive * 0.85), a);
  }
`;

// Background gradient — full-viewport triangle
const BG_VS = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;
const BG_FS = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p);
    // Soft purple/blue radial gradient pulsing very slowly
    float pulse = sin(uTime * 0.3) * 0.04 + 0.5;
    vec3 inner = vec3(0.18, 0.13, 0.36) * pulse;
    vec3 outer = vec3(0.04, 0.03, 0.10);
    vec3 col = mix(inner, outer, smoothstep(0.0, 0.7, r));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Brain class ─────────────────────────────────────────────

export class HivemindBrain {
  constructor(container) {
    this.container = container;
    this.disposed = false;
    this.lastTs = 0;
    this.particles = [];
    this.nodeStates = {};
    for (const a of AGENTS) this.nodeStates[a.id] = { intensity: 0, working: false };
    this.edgeStates = {};
    for (const e of EDGES) this.edgeStates[`${e[0]}->${e[1]}`] = { active: 0 };
    // Defer init by 2 frames so the parent .hm-pane.active flex layout has
    // actually computed offsetWidth/offsetHeight. Without this the canvas
    // is sized 0×0 and nothing renders.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.disposed) return;
      this._init();
      void this._poll();
      this._pollTimer = setInterval(() => void this._poll(), POLL_MS);
    }));
  }

  _init() {
    const renderer = new Renderer({ alpha: false, premultipliedAlpha: true, antialias: true });
    const gl = renderer.gl;
    gl.clearColor(0.04, 0.03, 0.10, 1.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.container.appendChild(gl.canvas);
    this.renderer = renderer;
    this.gl = gl;

    const camera = new Camera(gl, { fov: 45 });
    camera.position.set(0, 0.4, 5);
    camera.lookAt([0, 0, 0]);
    this.camera = camera;

    this.scene = new Transform();

    // Background quad (Triangle helper covers the whole viewport)
    const bgGeometry = new Triangle(gl);
    const bgProgram = new Program(gl, {
      vertex: BG_VS,
      fragment: BG_FS,
      uniforms: { uTime: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    this.bg = new Mesh(gl, { geometry: bgGeometry, program: bgProgram });

    // Nodes — one billboard quad per agent
    this.nodeMeshes = {};
    for (const a of AGENTS) {
      const geom = new Geometry(gl, {
        position: { size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) },
        uv:       { size: 2, data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) },
        index:    { data: new Uint16Array([0, 1, 2, 1, 3, 2]) },
      });
      const prog = new Program(gl, {
        vertex: NODE_VS,
        fragment: NODE_FS,
        uniforms: {
          uView: { value: new Float32Array(16) },
          uProj: { value: new Float32Array(16) },
          uSize:     { value: a.id === 'nox' ? 0.45 : 0.32 },
          uCenter:   { value: new Float32Array(a.pos) },
          uCamRight: { value: new Float32Array([1, 0, 0]) },
          uCamUp:    { value: new Float32Array([0, 1, 0]) },
          uColor:    { value: new Float32Array(a.color) },
          uIntensity:{ value: 0 },
        },
        transparent: true,
        depthTest: false,
      });
      const m = new Mesh(gl, { geometry: geom, program: prog });
      m.setParent(this.scene);
      this.nodeMeshes[a.id] = m;
    }

    // Edges — line geometries between specialists and NØX
    this.edgeMeshes = {};
    const noxPos = AGENTS.find(a => a.id === 'nox').pos;
    for (const [from, to] of EDGES) {
      const a = AGENTS.find(x => x.id === from).pos;
      const b = AGENTS.find(x => x.id === to).pos;
      const geom = new Geometry(gl, {
        position: { size: 3, data: new Float32Array([...a, ...b]) },
      });
      const prog = new Program(gl, {
        vertex: LINE_VS,
        fragment: LINE_FS,
        uniforms: {
          uView:   { value: new Float32Array(16) },
          uProj:   { value: new Float32Array(16) },
          uColor:  { value: new Float32Array([0.7, 0.6, 0.95]) },
          uActive: { value: 0 },
        },
        transparent: true,
        depthTest: false,
      });
      const m = new Mesh(gl, { geometry: geom, program: prog, mode: gl.LINES });
      m.setParent(this.scene);
      this.edgeMeshes[`${from}->${to}`] = m;
    }

    // Particles layer — billboards spawned dynamically; track here
    this.particleGeom = new Geometry(gl, {
      position: { size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) },
      uv:       { size: 2, data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) },
      index:    { data: new Uint16Array([0, 1, 2, 1, 3, 2]) },
    });

    // HTML label layer — projected each frame so labels track the orbiting nodes.
    this.labels = {};
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'hm-brain-labels';
    this.container.appendChild(this.labelLayer);
    for (const a of AGENTS) {
      const el = document.createElement('div');
      el.className = 'hm-brain-label';
      if (a.id === 'nox') el.classList.add('nox');
      el.textContent = a.label;
      this.labelLayer.appendChild(el);
      this.labels[a.id] = el;
    }

    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
    // ResizeObserver catches the case where the parent .hm-pane is shown
    // AFTER construction (e.g. via tab toggle) and the container goes from
    // 0×0 to its real size. Without this the WebGL canvas is permanently
    // tiny.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.container);
    }
    this.startMs = performance.now();
    const tick = () => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(tick);
      this._render();
    };
    this._raf = requestAnimationFrame(tick);
  }

  _resize() {
    const c = this.container;
    const w = Math.max(c.offsetWidth, 16);
    const h = Math.max(c.offsetHeight, 16);
    this.renderer.setSize(w, h);
    this.camera.perspective({ aspect: w / h });
  }

  _orbitCamera(t) {
    const radius = 5.2;
    const angle = t * 0.10; // slow orbit
    this.camera.position.set(
      Math.cos(angle) * radius,
      0.6 + Math.sin(t * 0.13) * 0.25,
      Math.sin(angle) * radius,
    );
    this.camera.lookAt([0, 0, 0]);
  }

  _render() {
    const elapsed = (performance.now() - this.startMs) / 1000;
    this.bg.program.uniforms.uTime.value = elapsed;
    this._orbitCamera(elapsed);

    // Render bg first (no depth)
    this.renderer.render({ scene: this.bg, camera: this.camera, clear: true });

    // Camera basis (right + up) for billboards. ogl Camera.worldMatrix is the
    // camera's transform in world space — column 0 = right, column 1 = up.
    const cw = this.camera.worldMatrix;
    const camRight = [cw[0], cw[1], cw[2]];
    const camUp    = [cw[4], cw[5], cw[6]];

    const view = this.camera.viewMatrix;
    const proj = this.camera.projectionMatrix;

    // Update node intensities (decay) and uniforms. While an agent is in a
    // sustained `working` state, hold a soft floor on intensity so the node
    // glows for the full spawn duration instead of fading after ~1.4s.
    const t = performance.now() * 0.001;
    for (const a of AGENTS) {
      const s = this.nodeStates[a.id];
      s.intensity *= 0.96;
      if (s.working) {
        // Slow breathing pulse, distinct from the sharp burst of a `firing` event.
        const floor = 0.32 + 0.12 * Math.sin(t * 2.2);
        if (s.intensity < floor) s.intensity = floor;
      }
      const m = this.nodeMeshes[a.id];
      m.program.uniforms.uIntensity.value = s.intensity;
      m.program.uniforms.uView.value = view;
      m.program.uniforms.uProj.value = proj;
      m.program.uniforms.uCamRight.value = new Float32Array(camRight);
      m.program.uniforms.uCamUp.value    = new Float32Array(camUp);
    }

    // Update edge intensities (decay)
    for (const k in this.edgeStates) {
      const s = this.edgeStates[k];
      s.active *= 0.95;
      const m = this.edgeMeshes[k];
      m.program.uniforms.uActive.value = s.active;
      m.program.uniforms.uView.value = view;
      m.program.uniforms.uProj.value = proj;
    }

    // Render edges + nodes (additive feel via SRC_ALPHA blend)
    this.renderer.render({ scene: this.scene, camera: this.camera, clear: false });

    // Particles — render each as a small node-style billboard
    this._renderParticles(view, proj, camRight, camUp);

    // HTML labels — project each node into screen coords and update CSS
    this._updateLabels(view, proj);
  }

  _updateLabels(view, proj) {
    const cssW = this.renderer.width;
    const cssH = this.renderer.height;
    for (const a of AGENTS) {
      const el = this.labels[a.id];
      if (!el) continue;
      const [sx, sy, visible] = projectToScreen(a.pos, view, proj, cssW, cssH);
      if (!visible) {
        el.style.opacity = '0';
        continue;
      }
      // Slightly larger vertical offset for NØX since his halo is bigger.
      const offsetY = a.id === 'nox' ? 60 : 44;
      el.style.transform = `translate(${sx}px, ${sy + offsetY}px) translateX(-50%)`;
      el.style.opacity = '1';
    }
  }

  _renderParticles(view, proj, camRight, camUp) {
    const now = performance.now();
    const surviving = [];
    for (const p of this.particles) {
      const tt = (now - p.birth) / p.duration;
      if (tt >= 1) continue;
      const x = p.from[0] + (p.to[0] - p.from[0]) * tt;
      const y = p.from[1] + (p.to[1] - p.from[1]) * tt;
      const z = p.from[2] + (p.to[2] - p.from[2]) * tt;
      p.mesh.program.uniforms.uCenter.value = new Float32Array([x, y, z]);
      p.mesh.program.uniforms.uView.value = view;
      p.mesh.program.uniforms.uProj.value = proj;
      p.mesh.program.uniforms.uCamRight.value = new Float32Array(camRight);
      p.mesh.program.uniforms.uCamUp.value = new Float32Array(camUp);
      p.mesh.program.uniforms.uIntensity.value = 1.0 - tt;
      this.renderer.render({ scene: p.mesh, camera: this.camera, clear: false });
      surviving.push(p);
    }
    this.particles = surviving;
  }

  _spawnParticle(fromId, toId) {
    const a = AGENTS.find(x => x.id === fromId)?.pos ?? [0,0,0];
    const b = AGENTS.find(x => x.id === toId)?.pos ?? [0,0,0];
    const color = AGENTS.find(x => x.id === fromId)?.color ?? [0.8, 0.7, 1];
    const prog = new Program(this.gl, {
      vertex: NODE_VS,
      fragment: NODE_FS,
      uniforms: {
        uView:     { value: new Float32Array(16) },
        uProj:     { value: new Float32Array(16) },
        uSize:     { value: 0.10 },
        uCenter:   { value: new Float32Array(a) },
        uCamRight: { value: new Float32Array([1, 0, 0]) },
        uCamUp:    { value: new Float32Array([0, 1, 0]) },
        uColor:    { value: new Float32Array(color) },
        uIntensity:{ value: 1.0 },
      },
      transparent: true,
      depthTest: false,
    });
    const mesh = new Mesh(this.gl, { geometry: this.particleGeom, program: prog });
    this.particles.push({
      mesh, from: a, to: b, birth: performance.now(), duration: 1100,
    });
  }

  async _poll() {
    if (this.disposed) return;
    try {
      const r = await fetch('/api/hive-mind').then(r => r.json());
      const entries = Array.isArray(r?.entries) ? r.entries : [];
      const fresh = entries.filter(e => e.ts > this.lastTs);
      for (const e of fresh.reverse()) this._fireEvent(e);
      if (entries.length > 0) this.lastTs = Math.max(this.lastTs, entries[0].ts);
    } catch {}
  }

  _fireEvent(e) {
    const s = this.nodeStates[e.agent_id];
    if (!s) return;
    // Sustained working state: clamp `working` while a spawn is in flight so
    // the per-frame decay can't pull intensity all the way down.
    if (e.event === 'spawn_started') {
      s.working = true;
      return;
    }
    if (e.event === 'spawn_finished') {
      s.working = false;
      return;
    }
    s.intensity = Math.min(1.0, s.intensity + 1.0);
    if (e.agent_id !== 'nox') {
      const k = `${e.agent_id}->nox`;
      if (this.edgeStates[k]) this.edgeStates[k].active = 1.0;
      this._spawnParticle(e.agent_id, 'nox');
    } else {
      // NØX fires; route to a random specialist
      const targets = ['dev', 'review', 'ideas', 'ops'];
      const target = targets[Math.floor(Math.random() * targets.length)];
      const k = `${target}->nox`;
      if (this.edgeStates[k]) this.edgeStates[k].active = 0.7;
      this._spawnParticle('nox', target);
    }
  }

  dispose() {
    this.disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._ro) this._ro.disconnect();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this.labelLayer?.parentNode === this.container) {
      this.container.removeChild(this.labelLayer);
    }
    if (this.gl?.canvas?.parentNode === this.container) {
      this.container.removeChild(this.gl.canvas);
    }
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
