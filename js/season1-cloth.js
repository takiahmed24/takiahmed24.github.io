// Last Charge - Season I page: live cloth, chains and lantern light.
// Verlet cloth (position-based constraints) written for this page; three.js only draws it.
// Everything that moves here is computed every frame in your browser. No video, no pre-baked animation.
import * as THREE from 'three';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP = 1 / 60;          // fixed physics step (s)
const ITER = 6;               // constraint passes per step
const GRAVITY = -9.8;
const stats = { points: 0, links: 0 };

// ---------- small helpers ----------
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function loadImage(src) {
  return new Promise((ok, bad) => { const i = new Image(); i.decoding = 'async'; i.onload = () => ok(i); i.onerror = bad; i.src = src; });
}

// Slow lantern colour: amber -> ember -> low, never a flash. Sum of three slow sines with odd periods.
const C_AMBER = new THREE.Color(1.0, 0.66, 0.28), C_EMBER = new THREE.Color(1.0, 0.40, 0.10), C_LOW = new THREE.Color(0.62, 0.22, 0.06);
function lanternColour(t, seed, out) {
  const a = 0.5 + 0.5 * (0.55 * Math.sin(t * 0.83 + seed) + 0.30 * Math.sin(t * 1.91 + seed * 2.3) + 0.15 * Math.sin(t * 3.7 + seed * 0.7));
  const b = 0.5 + 0.5 * Math.sin(t * 0.37 + seed * 1.3);
  out.copy(C_EMBER).lerp(C_AMBER, a);
  out.lerp(C_LOW, (1 - a) * 0.35 * b);
  return 0.55 + 0.45 * a;        // brightness 0.55..1.0
}

// Draws the banner art into a canvas and stamps the plate text, so the words move with the cloth.
function stampPlate(img, lines, rect, style) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const [u0, v0, u1, v1] = rect;
  const x0 = u0 * c.width, y0 = v0 * c.height, w = (u1 - u0) * c.width, h = (v1 - v0) * c.height;
  const lh = h / lines.length;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((txt, k) => {
    let size = lh * (k === 0 ? 0.78 : 0.72);
    g.font = `700 ${size}px "Schibsted Grotesk", Arial, sans-serif`;
    while (g.measureText(txt).width > w && size > 6) { size -= 1; g.font = `700 ${size}px "Schibsted Grotesk", Arial, sans-serif`; }
    const cx = x0 + w / 2, cy = y0 + lh * (k + 0.5);
    const off = Math.max(1, size * 0.045);
    g.fillStyle = style.shade; g.fillText(txt, cx - off, cy - off);   // cut edge
    g.fillStyle = style.edge; g.fillText(txt, cx + off, cy + off);    // lit lower edge
    g.fillStyle = style.ink; g.fillText(txt, cx, cy);
  });
  return c;
}

function makeTexture(source, renderer) {
  const t = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  t.needsUpdate = true;
  return t;
}

// ---------- the cloth ----------
class Cloth {
  /**
   * width/height in world units; grid cols x rows; origin = top centre of the art.
   * pinned(u,v): particle is bolted (rod, chains, metal parts).
   * rigid: [u0,v0,u1,v1] rectangles that must not bend (metal plates) - extra long-range links.
   */
  constructor({ width, height, cols, rows, pinned, rigid = [], material }) {
    this.W = width; this.H = height; this.cols = cols; this.rows = rows;
    const n = cols * rows; this.n = n;
    this.p = new Float32Array(n * 3); this.q = new Float32Array(n * 3);
    this.f = new Float32Array(n * 3); this.pin = new Uint8Array(n);
    const uv = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, u = c / (cols - 1), v = r / (rows - 1);
      this.p[i * 3] = this.q[i * 3] = (u - 0.5) * width;
      this.p[i * 3 + 1] = this.q[i * 3 + 1] = -v * height;
      this.pin[i] = pinned(u, v) ? 1 : 0;
      uv[i * 2] = u; uv[i * 2 + 1] = 1 - v;
    }
    const inRect = (c, r) => rigid.some(([u0, v0, u1, v1]) => { const u = c / (cols - 1), v = r / (rows - 1); return u >= u0 && u <= u1 && v >= v0 && v <= v1; });
    const ci = [], cj = [], cs = [];
    const link = (c1, r1, c2, r2, s) => {
      if (c2 < 0 || c2 >= cols || r2 < 0 || r2 >= rows) return;
      const a = r1 * cols + c1, b = r2 * cols + c2;
      if (this.pin[a] && this.pin[b]) return;
      ci.push(a); cj.push(b); cs.push(s);
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      link(c, r, c + 1, r, 1); link(c, r, c, r + 1, 1);              // stretch
      link(c, r, c + 1, r + 1, 0.7); link(c + 1, r, c, r + 1, 0.7);  // shear
      link(c, r, c + 2, r, 0.18); link(c, r, c, r + 2, 0.18);        // bend (soft)
      if (inRect(c, r)) for (const [dc, dr] of [[2, 0], [0, 2], [2, 2], [2, -2], [4, 0], [0, 4], [4, 2], [4, -2]])
        if (inRect(c + dc, r + dr)) link(c, r, c + dc, r + dr, 1);
    }
    this.ci = Int32Array.from(ci); this.cj = Int32Array.from(cj); this.cs = Float32Array.from(cs);
    this.rest = new Float32Array(ci.length);
    for (let k = 0; k < ci.length; k++) {
      const a = ci[k] * 3, b = cj[k] * 3;
      this.rest[k] = Math.hypot(this.p[b] - this.p[a], this.p[b + 1] - this.p[a + 1]);
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.p, 3); this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    stats.points += n; stats.links += ci.length;
  }

  step(dt, wind, t) {
    const { p, q, f, pin, cols, rows, n } = this;
    f.fill(0);
    // aerodynamic force per grid quad: F = n * (n . wind) * area  (pushes on the face, like a sail)
    const k = 0.55; // per-corner; force per unit mass, so the grid size does not matter
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = (r * cols + c) * 3, b = a + 3, d = a + cols * 3, e = d + 3;
      const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      const fx = p[d] - p[a], fy = p[d + 1] - p[a + 1], fz = p[d + 2] - p[a + 2];
      const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
      const len2 = nx * nx + ny * ny + nz * nz || 1e-9;
      const s = k * (nx * wind.x + ny * wind.y + nz * wind.z) / len2; // n * s = n^ (n^ . wind) * k
      const gx = nx * s, gy = ny * s, gz = nz * s;
      f[a] += gx; f[a + 1] += gy; f[a + 2] += gz; f[b] += gx; f[b + 1] += gy; f[b + 2] += gz;
      f[d] += gx; f[d + 1] += gy; f[d + 2] += gz; f[e] += gx; f[e + 1] += gy; f[e + 2] += gz;
    }
    const dt2 = dt * dt, damp = 0.985, vmax = 0.06, turb = wind.turb;
    for (let i = 0; i < n; i++) {
      if (pin[i]) continue;
      const o = i * 3;
      const x = p[o], y = p[o + 1], z = p[o + 2];
      let vx = (x - q[o]) * damp, vy = (y - q[o + 1]) * damp, vz = (z - q[o + 2]) * damp;
      const vl = Math.hypot(vx, vy, vz); if (vl > vmax) { const m = vmax / vl; vx *= m; vy *= m; vz *= m; }
      // turbulence: travelling ripples so the cloth never hangs dead still
      const tz = turb * Math.sin(x * 2.3 + t * 3.1 + y * 1.4) * Math.cos(y * 1.9 - t * 2.2);
      const tx = turb * 0.35 * Math.sin(y * 2.7 + t * 1.7);
      q[o] = x; q[o + 1] = y; q[o + 2] = z;
      p[o] = x + vx + (f[o] + tx) * dt2;
      p[o + 1] = y + vy + (f[o + 1] + GRAVITY) * dt2;
      p[o + 2] = z + vz + (f[o + 2] + tz) * dt2;
    }
    const { ci, cj, cs, rest } = this, m = ci.length;
    for (let it = 0; it < ITER; it++) {
      for (let kk = 0; kk < m; kk++) {
        const a = ci[kk], b = cj[kk], ia = a * 3, ib = b * 3;
        const wa = pin[a] ? 0 : 1, wb = pin[b] ? 0 : 1;
        const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const corr = (d - rest[kk]) / d * cs[kk] / (wa + wb);
        if (wa) { p[ia] += dx * corr; p[ia + 1] += dy * corr; p[ia + 2] += dz * corr; }
        if (wb) { p[ib] -= dx * corr; p[ib + 1] -= dy * corr; p[ib + 2] -= dz * corr; }
      }
    }
  }

  // finger / mouse: local point + local delta. drag = button held.
  push(lp, ld, drag) {
    if (lp.x < -this.W / 2 - 0.1 || lp.x > this.W / 2 + 0.1 || lp.y > 0.05 || lp.y < -this.H - 0.1) return false;
    const { p, pin, n } = this, R = drag ? 0.26 : 0.2, R2 = R * R;
    const sp = Math.min(0.06, Math.hypot(ld.x, ld.y));
    for (let i = 0; i < n; i++) {
      if (pin[i]) continue;
      const o = i * 3, dx = p[o] - lp.x, dy = p[o + 1] - lp.y, d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      const w = (1 - Math.sqrt(d2) / R) ** 2;
      const mx = drag ? 0.9 : 0.25;
      p[o] += clamp(ld.x, -0.05, 0.05) * w * mx;
      p[o + 1] += clamp(ld.y, -0.05, 0.05) * w * mx;
      p[o + 2] -= sp * w * (drag ? 1.6 : 0.8);
    }
    return true;
  }

  poke(lp) { // tap: a single push into the cloth
    const { p, pin, n } = this, R = 0.25;
    for (let i = 0; i < n; i++) {
      if (pin[i]) continue;
      const o = i * 3, d = Math.hypot(p[o] - lp.x, p[o + 1] - lp.y);
      if (d < R) p[o + 2] -= 0.05 * (1 - d / R) ** 2;
    }
  }

  sync() { this.posAttr.needsUpdate = true; this.mesh.geometry.computeVertexNormals(); }
}

// ---------- a swinging hanger (pendulum on two parallel chains) ----------
class Swing {
  constructor(length, seed) { this.L = length; this.th = 0; this.w = 0; this.tw = 0; this.tww = 0; this.seed = seed; }
  step(dt, wind, t) {
    const g = 9.8, L = this.L;
    const drive = wind.x * 0.05 + wind.gust * 0.035 * Math.sin(t * 1.3 + this.seed);
    this.w += (-(g / L) * Math.sin(this.th) - 1.1 * this.w + drive) * dt;
    this.th += this.w * dt;
    const twist = wind.z * 0.02 * Math.sin(t * 0.7 + this.seed) + wind.gust * 0.02;
    this.tww += (-6 * this.tw - 1.4 * this.tww + twist) * dt;
    this.tw += this.tww * dt;
  }
  kick(vx) { this.w += clamp(vx, -0.08, 0.08) * 6; this.tww += clamp(vx, -0.08, 0.08) * 4; }
}

// ---------- chains: instanced iron links between two moving points ----------
class Chains {
  constructor(scene, maxLinks) {
    const geo = new THREE.TorusGeometry(0.026, 0.0075, 6, 12); geo.scale(1, 1.55, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x5b5753 });
    this.mesh = new THREE.InstancedMesh(geo, mat, maxLinks); this.mesh.frustumCulled = false;
    scene.add(this.mesh); this.max = maxLinks; this.count = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._d = new THREE.Vector3(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._y = new THREE.Vector3(0, 1, 0);
  }
  begin() { this.count = 0; }
  add(a, b) {
    const d = this._d.subVectors(b, a), len = d.length(); d.normalize();
    const pitch = 0.064, n = Math.max(2, Math.round(len / pitch));
    this._q.setFromUnitVectors(this._y, d);
    for (let k = 0; k < n && this.count < this.max; k++) {
      this._p.copy(a).addScaledVector(d, (k + 0.5) * len / n);
      this._q2.setFromAxisAngle(d, k % 2 ? Math.PI / 2 : 0).multiply(this._q);
      this._m.compose(this._p, this._q2, this._s);
      this.mesh.setMatrixAt(this.count++, this._m);
    }
  }
  end() { this.mesh.count = this.count; this.mesh.instanceMatrix.needsUpdate = true; }
}

// ---------- iron beam with bolts ----------
function beam(scene, len) {
  const g = new THREE.Group();
  const iron = new THREE.MeshLambertMaterial({ color: 0x34343a });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 0.075, 0.08), iron); g.add(bar);
  const capMat = new THREE.MeshLambertMaterial({ color: 0x6b5a3e });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(1, 0.012, 0.082), capMat); strip.position.y = 0.025; g.add(strip);
  scene.add(g);
  g.userData.setLength = (L) => { bar.scale.x = L; strip.scale.x = L; };
  g.userData.setLength(len);
  return g;
}
function bolt(scene, x, y) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 10), new THREE.MeshLambertMaterial({ color: 0x7a6a50 }));
  m.rotation.x = Math.PI / 2; m.position.set(x, y, 0); scene.add(m); return m;
}

// ---------- a code-built lantern (cage + glass) ----------
function makeLantern() {
  const g = new THREE.Group();
  const iron = new THREE.MeshLambertMaterial({ color: 0x2f2d2c });
  const glass = new THREE.MeshLambertMaterial({ color: 0x3a1a08, emissive: 0xff9a40 });
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.06, 8), iron); top.position.y = -0.03; g.add(top);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.016, 8), iron); ring.position.y = -0.066; g.add(ring);
  const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.15, 10), glass); gl.position.y = -0.15; g.add(gl);
  for (let k = 0; k < 4; k++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.16, 0.01), iron);
    const a = k * Math.PI / 2 + Math.PI / 4; bar.position.set(Math.cos(a) * 0.052, -0.15, Math.sin(a) * 0.052); g.add(bar);
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.05, 0.022, 8), iron); base.position.y = -0.236; g.add(base);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 8), iron); tip.rotation.x = Math.PI; tip.position.y = -0.287; g.add(tip);
  g.userData.glass = glass;
  return g;
}

// ---------- a stage = one canvas, one scene ----------
const stages = [];
class Stage {
  constructor(el) {
    this.el = el; this.canvas = el.querySelector('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const key = new THREE.DirectionalLight(0xfff1dc, 1.9); key.position.set(-1.5, 2.2, 3.5); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb2d8, 0.55); rim.position.set(2, 0.5, -2); this.scene.add(rim);
    this.objects = []; this.cloths = []; this.swings = [];
    this.box = { x0: -1, x1: 1, y0: -1, y1: 0 };
    this.wind = { x: 0, y: 0, z: 0, turb: 0, gust: 0 };
    this.gustAt = 2 + Math.random() * 3; this.gustLen = 1.6; this.gustPow = 0; this.gustStart = -10; this.dir = 1;
    this.acc = 0; this.visible = true; this.t = Math.random() * 10;
    this.pointer = { down: false, ndc: new THREE.Vector2(), prev: null, moved: 0 };
    this.ray = new THREE.Raycaster(); this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(el);
    new IntersectionObserver((es) => { this.visible = es[es.length - 1].isIntersecting; }, { rootMargin: '80px' }).observe(el);
    stages.push(this);
  }
  fit(box) { this.box = box; this.resize(); }
  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const cam = this.camera; cam.aspect = w / h;
    const { x0, x1, y0, y1 } = this.box, bw = x1 - x0, bh = y1 - y0, tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dist = Math.max(bh / 2 / tan, bw / 2 / (tan * cam.aspect)) * 1.04;
    cam.position.set((x0 + x1) / 2, (y0 + y1) / 2, dist + 0.2);
    cam.lookAt((x0 + x1) / 2, (y0 + y1) / 2, 0);
    cam.updateProjectionMatrix();
    this.halfW = dist * tan * cam.aspect;   // visible half width at z=0
    if (this.onResize) this.onResize(this.halfW);
  }
  worldAt(ndc, out) {
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.intersectPlane(this.plane, out);
  }
  bindPointer() {
    const c = this.canvas, P = this.pointer;
    const toNdc = (e) => { const r = c.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    c.addEventListener('pointerdown', (e) => {
      P.down = true; P.prev = toNdc(e); P.moved = 0;
      if (e.pointerType === 'mouse') c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const ndc = toNdc(e);
      if (P.prev && this.worldAt(ndc, a) && this.worldAt(P.prev, b)) {
        const d = new THREE.Vector3().subVectors(a, b);
        P.moved += d.length();
        for (const o of this.objects) o.interact && o.interact(a, d, P.down || e.pointerType !== 'mouse');
      }
      P.prev = ndc;
    });
    const up = (e) => {
      if (P.down && P.moved < 0.01 && P.prev && this.worldAt(P.prev, a)) for (const o of this.objects) o.tap && o.tap(a);
      P.down = false; if (e.pointerType !== 'mouse') P.prev = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { P.down = false; P.prev = null; });
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !P.down) P.prev = null; });
  }
  updateWind(t) {
    const W = this.wind, calm = REDUCED ? 0.25 : 1;
    if (!REDUCED && t > this.gustAt) { this.gustStart = t; this.gustPow = 2 + Math.random() * 2.2; this.gustLen = 1.2 + Math.random() * 1.4; this.gustAt = t + 3.5 + Math.random() * 5; if (Math.random() < 0.35) this.dir *= -1; }
    const gt = (t - this.gustStart) / this.gustLen;
    W.gust = gt > 0 && gt < 1 ? Math.sin(gt * Math.PI) ** 2 * this.gustPow : 0;
    const base = (1.1 + 0.6 * Math.sin(t * 0.21) + 0.3 * Math.sin(t * 0.53)) * calm;
    const s = base + W.gust;
    W.z = s * 0.9; W.x = s * 0.45 * this.dir * (0.6 + 0.4 * Math.sin(t * 0.17)); W.y = 0;
    W.turb = (2.6 + W.gust * 0.8) * calm;
  }
  frame(dt) {
    this.acc = Math.min(this.acc + dt, STEP * 3);
    while (this.acc >= STEP) {
      this.t += STEP; this.acc -= STEP;
      this.updateWind(this.t);
      for (const s of this.swings) s.step(STEP, this.wind, this.t);
      for (const c of this.cloths) c.step(STEP, this.wind, this.t);
    }
    for (const o of this.objects) o.update && o.update(this.t);
    for (const c of this.cloths) c.sync();
    this.renderer.render(this.scene, this.camera);
  }
}

function clothHit(cloth, group, wp, wd, drag) {
  const lp = group.worldToLocal(wp.clone());
  const q = group.getWorldQuaternion(new THREE.Quaternion()).invert();
  const ld = wd.clone().applyQuaternion(q);
  return cloth.push(lp, ld, drag);
}

// ---------- scene 1: the logo on chains + the hero banner ----------
async function buildHero(el) {
  const st = new Stage(el), sc = st.scene, R = st.renderer;
  const [heroImg, logoImg, heroMask, logoMask] = await Promise.all(['img/s1/hero.webp', 'img/s1/logo.webp', 'img/s1/hero-glow-mask.webp', 'img/s1/logo-glow-mask.webp'].map(loadImage));
  const heroCanvas = stampPlate(heroImg, ['SEASON I  CASH PRIZES'], [0.30, 0.552, 0.70, 0.668], { ink: '#3b200b', shade: 'rgba(30,14,4,.55)', edge: 'rgba(255,236,190,.55)' });

  const beamG = beam(sc, 3); const chains = new Chains(sc, 160);
  // logo
  const LW = 1.5, LH = LW * 399 / 1000, LCH = 0.2;
  const logoMat = new THREE.MeshLambertMaterial({ map: makeTexture(logoImg, R), transparent: true, side: THREE.DoubleSide, emissiveMap: makeTexture(logoMask, R), emissive: 0xffffff, depthWrite: false });
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(LW, LH), logoMat);
  const logoG = new THREE.Group(); logoG.add(logo); sc.add(logoG); logo.renderOrder = 2;
  const logoSwing = new Swing(LCH + LH / 2, 1.1); st.swings.push(logoSwing);
  const logoAnchors = [-0.5, 0.5];
  bolt(sc, -0.5, 0); bolt(sc, 0.5, 0);
  // hero cloth
  const HW = 2.4, HH = HW * 456 / 1100, HTOP = -(LCH + LH + 0.12);
  const inR = (u, v, r) => u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3];
  const shield = [0.335, 0, 0.665, 0.44], plate = [0.255, 0.525, 0.745, 0.70], chest = [0.27, 0.70, 0.71, 1];
  const heroMat = new THREE.MeshLambertMaterial({ map: makeTexture(heroCanvas, R), alphaTest: 0.5, side: THREE.DoubleSide, emissiveMap: makeTexture(heroMask, R), emissive: 0xffffff });
  const hero = new Cloth({
    width: HW, height: HH, cols: 52, rows: 22, material: heroMat,
    pinned: (u, v) => v < 0.19 || u < 0.115 || u > 0.885 || inR(u, v, shield) || inR(u, v, plate) || inR(u, v, chest),
  });
  const heroG = new THREE.Group(); heroG.add(hero.mesh); sc.add(heroG);
  const heroSwing = new Swing(-HTOP, 2.7); st.swings.push(heroSwing);
  st.cloths.push(hero);
  const heroAnchors = [-1.13, 1.13];
  bolt(sc, -1.13, 0); bolt(sc, 1.13, 0);
  // lanterns hung from the beam ends (only when the screen is wide enough)
  const lanterns = [makeLantern(), makeLantern()].map((l, k) => { sc.add(l); return { g: l, swing: new Swing(0.3, 4 + k * 1.9), x: 0 }; });
  lanterns.forEach((l) => st.swings.push(l.swing));
  const lights = [new THREE.PointLight(0xffa050, 1.6, 0, 2), new THREE.PointLight(0xffa050, 1.6, 0, 2)];
  lights.forEach((p, k) => { p.position.set(k ? 1.25 : -1.25, HTOP - 0.5, 0.45); sc.add(p); });
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), col = new THREE.Color(), col2 = new THREE.Color();

  st.onResize = (halfW) => {
    beamG.userData.setLength(halfW * 2 + 0.4);
    const show = halfW > 1.62;
    lanterns.forEach((l, k) => { l.g.visible = show; l.x = (k ? 1 : -1) * Math.min(halfW - 0.2, 2.3); });
  };
  st.objects.push({
    update(t) {
      // logo: parallel chains keep it level; it travels on the arc and twists a little
      logoG.position.set(Math.sin(logoSwing.th) * logoSwing.L, -LCH - LH / 2 - (1 - Math.cos(logoSwing.th)) * logoSwing.L, 0.06);
      logoG.rotation.set(0, logoSwing.tw * 0.6, logoSwing.th * 0.12);
      heroG.position.set(Math.sin(heroSwing.th) * heroSwing.L * 0.35, HTOP, 0);
      heroG.rotation.set(0, heroSwing.tw * 0.25, heroSwing.th * 0.05);
      chains.begin();
      logoAnchors.forEach((ax) => { tmpA.set(ax, -0.03, 0); logo.localToWorld(tmpB.set(ax, LH / 2 - 0.085, 0)); chains.add(tmpA, tmpB); });
      heroAnchors.forEach((ax) => { tmpA.set(ax, -0.03, 0); heroG.localToWorld(tmpB.set(ax, -0.055, 0)); chains.add(tmpA, tmpB); });
      lanterns.forEach((l, k) => {
        if (!l.g.visible) return;
        const L = l.swing.L;
        l.g.position.set(l.x + Math.sin(l.swing.th) * L, -0.03 - Math.cos(l.swing.th) * L, 0.1);
        l.g.rotation.set(0, l.swing.tw, l.swing.th);
        tmpA.set(l.x, -0.03, 0.1); chains.add(tmpA, l.g.position);
        const br = lanternColour(t, 3 + k * 2.1, col);
        l.g.userData.glass.emissive.copy(col).multiplyScalar(br);
      });
      chains.end();
      // the hero's two lantern tubes + the logo lantern change colour slowly
      const b1 = lanternColour(t, 0.4, col); heroMat.emissive.copy(col).multiplyScalar(0.15 + 0.55 * b1);
      lights[0].color.copy(col); lights[0].intensity = 0.9 + 1.4 * b1;
      const b2 = lanternColour(t, 1.9, col2); lights[1].color.copy(col2); lights[1].intensity = 0.9 + 1.4 * b2;
      const b3 = lanternColour(t, 5.2, col); logoMat.emissive.copy(col).multiplyScalar(0.2 + 0.5 * b3);
    },
    interact(wp, wd, drag) {
      const lp = logo.worldToLocal(wp.clone());
      if (Math.abs(lp.x) < LW / 2 && Math.abs(lp.y) < LH / 2) { logoSwing.kick(wd.x * (drag ? 1 : 0.4)); return; }
      clothHit(hero, heroG, wp, wd, drag);
    },
    tap(wp) {
      const lp = logo.worldToLocal(wp.clone());
      if (Math.abs(lp.x) < LW / 2 && Math.abs(lp.y) < LH / 2) { logoSwing.kick(0.06 * Math.sign(lp.x || 1)); return; }
      hero.poke(heroG.worldToLocal(wp.clone()));
    },
  });
  st.fit({ x0: -1.3, x1: 1.3, y0: HTOP - HH - 0.06, y1: 0.08 });
  return st;
}

// ---------- scene 2: the two prize banners + the lantern chest ----------
async function buildPrizes(el) {
  const st = new Stage(el), sc = st.scene, R = st.renderer;
  const [blueImg, redImg] = await Promise.all(['img/s1/banner-35k.webp', 'img/s1/banner-50k.webp'].map(loadImage));
  const plateInk = { ink: '#f2e6c9', shade: 'rgba(10,6,3,.75)', edge: 'rgba(255,240,210,.25)' };
  const blueC = stampPlate(blueImg, ['35,000 m', 'Tk 2,000'], [0.215, 0.515, 0.785, 0.618], plateInk);
  const redC = stampPlate(redImg, ['50,000 m', 'Tk 5,000'], [0.265, 0.527, 0.775, 0.628], plateInk);
  const beamG = beam(sc, 3); const chains = new Chains(sc, 60);
  const defs = [
    { tex: blueC, W: 0.95, aspect: 1096 / 568, x: -0.54, rod: 0.085, plate: [0.13, 0.49, 0.86, 0.64], hang: [0.09, 0.91], seed: 0.3 },
    { tex: redC, W: 0.95 * 604 / 568, aspect: 1098 / 604, x: 0.56, rod: 0.08, plate: [0.19, 0.505, 0.84, 0.65], hang: [0.10, 0.90], seed: 2.2 },
  ];
  const TOP = -0.17;
  const banners = defs.map((d) => {
    const H = d.W * d.aspect;
    const mat = new THREE.MeshLambertMaterial({ map: makeTexture(d.tex, R), alphaTest: 0.5, side: THREE.DoubleSide });
    const cloth = new Cloth({ width: d.W, height: H, cols: 22, rows: 40, material: mat, pinned: (u, v) => v < d.rod, rigid: [d.plate] });
    const g = new THREE.Group(); g.add(cloth.mesh); sc.add(g);
    const swing = new Swing(0.5, d.seed); st.swings.push(swing); st.cloths.push(cloth);
    const hx = d.hang.map((u) => (u - 0.5) * d.W);
    hx.forEach((x) => bolt(sc, d.x + x, 0));
    return { d, H, cloth, g, swing, hx };
  });
  const light = new THREE.PointLight(0xffa050, 1.2, 0, 2); light.position.set(0, -1.6, 0.6); sc.add(light);
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), col = new THREE.Color();
  let chest = null, glassMat = null;
  st.onResize = (halfW) => beamG.userData.setLength(halfW * 2 + 0.4);
  st.objects.push({
    update(t) {
      chains.begin();
      banners.forEach((b) => {
        b.g.position.set(b.d.x + Math.sin(b.swing.th) * 0.08, TOP, 0);
        b.g.rotation.set(0, b.swing.tw * 0.3, b.swing.th * 0.06);
        b.hx.forEach((x) => { tmpA.set(b.d.x + x, -0.03, 0); b.g.localToWorld(tmpB.set(x, -0.02, 0)); chains.add(tmpA, tmpB); });
      });
      chains.end();
      const br = lanternColour(t, 0.9, col);
      light.color.copy(col); light.intensity = 0.6 + 1.2 * br;
      if (chest) {
        chest.rotation.y = t * (REDUCED ? 0.1 : 0.35);
        chest.position.y = chest.userData.y + Math.sin(t * 0.9) * 0.012;
        if (glassMat) glassMat.emissive.copy(col).multiplyScalar(0.35 + 0.65 * br);
      }
    },
    interact(wp, wd, drag) {
      for (const b of banners) if (clothHit(b.cloth, b.g, wp, wd, drag)) { if (drag) b.swing.kick(wd.x * 0.3); }
    },
    tap(wp) { for (const b of banners) b.cloth.poke(b.g.worldToLocal(wp.clone())); },
  });
  const bottom = TOP - Math.max(...banners.map((b) => b.H));
  st.fit({ x0: -1.06, x1: 1.1, y0: bottom - 0.04, y1: 0.08 });

  // the Meshy lantern chest from the game, loaded after the cloth is already moving
  const loadChest = async () => {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('img/s1/chest_lantern.glb');
      const m = gltf.scene;
      const box = new THREE.Box3().setFromObject(m), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
      const s = 0.5 / Math.max(size.x, size.y, size.z);
      m.position.sub(ctr); const holder = new THREE.Group(); holder.add(m); holder.scale.setScalar(s);
      m.traverse((o) => { if (o.isMesh) { if (o.material.map) o.material.map.anisotropy = 4; if (o.material.name === 'glass') { glassMat = o.material; } } });
      holder.position.set(0.0, bottom + 0.25, 0.35); holder.userData.y = holder.position.y;
      sc.add(holder); chest = holder;
    } catch (e) { /* page works without the chest */ }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(loadChest, { timeout: 2500 }); else setTimeout(loadChest, 1200);
  return st;
}

// ---------- start ----------
function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}
async function start() {
  if (!webglOK()) return;
  try { await document.fonts.load('700 40px "Schibsted Grotesk"'); } catch (e) {}
  const heroEl = document.getElementById('stage-hero'), prizeEl = document.getElementById('stage-prizes');
  const built = await Promise.all([buildHero(heroEl), buildPrizes(prizeEl)]);
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!document.hidden) for (const s of built) if (s.visible) s.frame(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame((n) => { last = n; loop(n); heroEl.classList.add('live'); prizeEl.classList.add('live'); });
  const note = document.getElementById('sim-note');
  if (note) note.textContent = `The banners on this page are a live cloth simulation running in your browser: ${stats.points.toLocaleString('en')} points, ${stats.links.toLocaleString('en')} links, solved ${ITER} times every 1/60 s (Verlet integration, WebGL). Drag or tap them.`;
  window.__s1 = { stats, stages: built };
}
start().catch((e) => { console.warn('Season I animation off:', e); });
