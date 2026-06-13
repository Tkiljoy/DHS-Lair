// 2D hive-mind graph view. Pure SVG, no deps.
// 5 nodes (NØX center, others around). Edges connect each specialist to NØX.
// Polls /api/hive-mind every 3s; when an event fires, the firing node pulses
// and a particle travels along its edge to NØX (or from NØX outward if NØX
// fired).

const AGENTS = [
  { id: 'nox',    label: 'NØX',    angle: null }, // center
  { id: 'dev',    label: 'DEV',    angle: -Math.PI / 2 - Math.PI / 5 * 2 },
  { id: 'review', label: 'REVIEW', angle: -Math.PI / 2 - Math.PI / 5 },
  { id: 'ops',    label: 'OPS',    angle: -Math.PI / 2 + Math.PI / 5 },
  { id: 'ideas',  label: 'IDEAS',  angle: -Math.PI / 2 + Math.PI / 5 * 2 },
];

const POLL_MS = 3000;
const PULSE_MS = 1400;

export class HivemindGraph {
  constructor(svgEl) {
    this.svg = svgEl;
    this.lastTs = 0;
    this.disposed = false;
    this.particles = []; // [{from, to, t, edge}]
    this._build();
    this._fitToSize();
    this._resizeHandler = () => this._fitToSize();
    window.addEventListener('resize', this._resizeHandler);
    // Bootstrap: poll immediately for any in-progress events
    void this._poll();
    this._pollTimer = setInterval(() => void this._poll(), POLL_MS);
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  _build() {
    const xmlns = 'http://www.w3.org/2000/svg';
    this.svg.innerHTML = '';
    this.svg.setAttribute('viewBox', '0 0 1000 700');

    // Edges (specialists -> NØX)
    this.edges = {};
    for (const a of AGENTS) {
      if (a.id === 'nox') continue;
      const path = document.createElementNS(xmlns, 'path');
      path.classList.add('hm-graph-edge');
      path.setAttribute('data-agent', a.id);
      this.svg.appendChild(path);
      this.edges[a.id] = path;
    }

    // Nodes
    this.nodes = {};
    for (const a of AGENTS) {
      const g = document.createElementNS(xmlns, 'g');
      g.classList.add('hm-graph-node');
      g.setAttribute('data-agent', a.id);
      const glow = document.createElementNS(xmlns, 'circle');
      glow.classList.add('hm-graph-node-glow');
      glow.setAttribute('r', a.id === 'nox' ? 70 : 48);
      const core = document.createElementNS(xmlns, 'circle');
      core.classList.add('hm-graph-node-core');
      core.setAttribute('r', a.id === 'nox' ? 26 : 18);
      const label = document.createElementNS(xmlns, 'text');
      label.classList.add('hm-graph-node-label');
      label.setAttribute('y', a.id === 'nox' ? 50 : 40);
      label.textContent = a.label;
      g.appendChild(glow);
      g.appendChild(core);
      g.appendChild(label);
      this.svg.appendChild(g);
      this.nodes[a.id] = g;
    }

    // Particles layer (added last so it draws on top)
    this.particleLayer = document.createElementNS(xmlns, 'g');
    this.svg.appendChild(this.particleLayer);
  }

  _fitToSize() {
    const cx = 500, cy = 350;
    const radius = 240;
    this.positions = {};
    for (const a of AGENTS) {
      if (a.id === 'nox') {
        this.positions.nox = { x: cx, y: cy };
        continue;
      }
      this.positions[a.id] = {
        x: cx + Math.cos(a.angle) * radius,
        y: cy + Math.sin(a.angle) * radius,
      };
    }
    for (const id in this.nodes) {
      const p = this.positions[id];
      this.nodes[id].setAttribute('transform', `translate(${p.x}, ${p.y})`);
    }
    for (const id in this.edges) {
      const a = this.positions[id];
      const b = this.positions.nox;
      const path = this.edges[id];
      // Slightly curved path (control point biased toward center for organic feel)
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cx = mx + (b.y - a.y) * 0.08;
      const cy = my - (b.x - a.x) * 0.08;
      path.setAttribute('d', `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`);
    }
  }

  async _poll() {
    if (this.disposed) return;
    try {
      const r = await fetch('/api/hive-mind').then(r => r.json());
      const entries = Array.isArray(r?.entries) ? r.entries : [];
      // Process newest-first first time, then incremental.
      const fresh = entries.filter(e => e.ts > this.lastTs);
      // entries come newest first, so reverse to play chronologically
      for (const e of fresh.reverse()) this._fireEvent(e);
      if (entries.length > 0) this.lastTs = Math.max(this.lastTs, entries[0].ts);
    } catch {}
  }

  _fireEvent(e) {
    const node = this.nodes[e.agent_id];
    if (!node) return;
    // Sustained "working" state: held for the full duration of a spawn so the
    // user can see a turn is in progress, not just a 1.4s burst.
    if (e.event === 'spawn_started') {
      node.classList.add('working');
      if (this.edges[e.agent_id]) this.edges[e.agent_id].classList.add('working');
      return;
    }
    if (e.event === 'spawn_finished') {
      node.classList.remove('working');
      if (this.edges[e.agent_id]) this.edges[e.agent_id].classList.remove('working');
      return;
    }
    node.classList.add('firing');
    setTimeout(() => node.classList.remove('firing'), PULSE_MS);
    if (e.agent_id !== 'nox' && this.edges[e.agent_id]) {
      this.edges[e.agent_id].classList.add('active');
      setTimeout(() => this.edges[e.agent_id].classList.remove('active'), PULSE_MS);
      // Particle travels from agent → NØX (incoming routing)
      this._spawnParticle(e.agent_id, 'nox');
    } else if (e.agent_id === 'nox') {
      // NØX fires: send a particle out to a random specialist
      const targets = ['dev', 'review', 'ops', 'ideas'];
      const target = targets[Math.floor(Math.random() * targets.length)];
      this._spawnParticle('nox', target);
    }
  }

  _spawnParticle(fromId, toId) {
    const xmlns = 'http://www.w3.org/2000/svg';
    const c = document.createElementNS(xmlns, 'circle');
    c.classList.add('hm-graph-particle');
    c.setAttribute('r', 4);
    this.particleLayer.appendChild(c);
    this.particles.push({
      el: c,
      from: this.positions[fromId],
      to: this.positions[toId],
      birth: performance.now(),
      duration: 900,
    });
  }

  _tick(t) {
    if (this.disposed) return;
    this._raf = requestAnimationFrame((t2) => this._tick(t2));
    const now = performance.now();
    const surviving = [];
    for (const p of this.particles) {
      const tt = (now - p.birth) / p.duration;
      if (tt >= 1) {
        p.el.remove();
        continue;
      }
      const x = p.from.x + (p.to.x - p.from.x) * tt;
      const y = p.from.y + (p.to.y - p.from.y) * tt;
      p.el.setAttribute('cx', x);
      p.el.setAttribute('cy', y);
      // Fade as it nears destination
      p.el.setAttribute('opacity', String(1 - Math.max(0, tt - 0.7) * 3));
      surviving.push(p);
    }
    this.particles = surviving;
  }

  dispose() {
    this.disposed = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resizeHandler);
    for (const p of this.particles) p.el.remove();
    this.particles = [];
  }
}
