/**
 * Brorb — Breathing orb visualization.
 *
 * Renders a softly glowing orb on a dark canvas whose size and color
 * are driven by the brainstem CPG simulation via WebSocket.
 *
 * - Radius: driven by lung_volume (smoothly interpolated)
 * - Color: warm gold/amber during inspiration, cool blue during expiration
 * - Surface: organic noise displacement (simplex noise)
 * - Ambient: soft radial glow + drifting particles
 */

// ── Simplex noise (2D) ──────────────────────────────────────────────
// Minimal implementation for organic surface displacement.

const GRAD2 = [
    [1,1],[-1,1],[1,-1],[-1,-1],
    [1,0],[-1,0],[0,1],[0,-1],
];
const PERM = new Uint8Array(512);
const PERM12 = new Uint8Array(512);
{
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle with fixed seed
    let seed = 42;
    for (let i = 255; i > 0; i--) {
        seed = (seed * 16807 + 0) % 2147483647;
        const j = seed % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) {
        PERM[i] = p[i & 255];
        PERM12[i] = PERM[i] % 8;
    }
}

function noise2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;

    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;

    const X0 = i - t, Y0 = j - t;
    const x0 = x - X0, y0 = y - Y0;

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2*G2, y2 = y0 - 1 + 2*G2;

    const ii = i & 255, jj = j & 255;

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0*x0 - y0*y0;
    if (t0 > 0) {
        t0 *= t0;
        const gi = PERM12[ii + PERM[jj]];
        n0 = t0 * t0 * (GRAD2[gi][0]*x0 + GRAD2[gi][1]*y0);
    }

    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 > 0) {
        t1 *= t1;
        const gi = PERM12[ii + i1 + PERM[jj + j1]];
        n1 = t1 * t1 * (GRAD2[gi][0]*x1 + GRAD2[gi][1]*y1);
    }

    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 > 0) {
        t2 *= t2;
        const gi = PERM12[ii + 1 + PERM[jj + 1]];
        n2 = t2 * t2 * (GRAD2[gi][0]*x2 + GRAD2[gi][1]*y2);
    }

    return 70 * (n0 + n1 + n2);
}

// ── WebSocket connection ─────────────────────────────────────────────

class Connection {
    constructor() {
        this.ws = null;
        this.state = null;
        this.connected = false;
        this._reconnectDelay = 500;
        this.connect();
    }

    connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}/ws`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.connected = true;
            this._reconnectDelay = 500;
            document.getElementById('connection-dot').classList.add('connected');
            document.getElementById('status').classList.add('connected');
            document.getElementById('status-text').textContent = 'breathing';
        };

        this.ws.onmessage = (e) => {
            try {
                this.state = JSON.parse(e.data);
            } catch {}
        };

        this.ws.onclose = () => {
            this.connected = false;
            document.getElementById('connection-dot').classList.remove('connected');
            document.getElementById('status').classList.remove('connected');
            document.getElementById('status-text').textContent = 'reconnecting';
            setTimeout(() => this.connect(), this._reconnectDelay);
            this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 5000);
        };

        this.ws.onerror = () => {
            this.ws.close();
        };
    }
}

// ── Particles ────────────────────────────────────────────────────────

class Particle {
    constructor(cx, cy, maxR) {
        this.reset(cx, cy, maxR);
    }

    reset(cx, cy, maxR) {
        const angle = Math.random() * Math.PI * 2;
        const dist = maxR * (0.6 + Math.random() * 0.8);
        this.x = cx + Math.cos(angle) * dist;
        this.y = cy + Math.sin(angle) * dist;
        this.vx = (Math.random() - 0.5) * 0.3;
        this.vy = (Math.random() - 0.5) * 0.3;
        this.life = 1.0;
        this.decay = 0.001 + Math.random() * 0.003;
        this.size = 1 + Math.random() * 2;
        this.alpha = 0.1 + Math.random() * 0.2;
    }

    update(cx, cy, orbR, breathPhase) {
        // Gentle drift toward/away from orb based on breath phase
        const dx = this.x - cx;
        const dy = this.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / dist;
        const ny = dy / dist;

        // During inspiration, particles drift inward; expiration, outward
        const breathForce = breathPhase === 'inspiration' ? -0.05 : 0.02;
        this.vx += nx * breathForce;
        this.vy += ny * breathForce;

        // Damping
        this.vx *= 0.98;
        this.vy *= 0.98;

        this.x += this.vx;
        this.y += this.vy;
        this.life -= this.decay;
    }
}

// ── Orb renderer ─────────────────────────────────────────────────────

class OrbRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Smoothed state
        this.smoothVolume = 0;
        this.smoothPreI = 0;
        this.smoothPostI = 0;
        this.smoothAugE = 0;
        this.currentPhase = 'expiration';
        this.inspireBlend = 0;  // 0 = full expiration color, 1 = full inspiration

        // Particles
        this.particles = [];
        this.maxParticles = 60;

        // Animation
        this.time = 0;
        this.lastFrame = performance.now();

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.cx = this.width / 2;
        this.cy = this.height / 2;
        this.baseRadius = Math.min(this.width, this.height) * 0.15;
    }

    update(state, dt) {
        this.time += dt;

        if (state) {
            // Smooth interpolation toward target values
            const smooth = 0.08;
            this.smoothVolume += (state.lung_volume - this.smoothVolume) * smooth;
            this.smoothPreI += (state.f_preI - this.smoothPreI) * smooth;
            this.smoothPostI += (state.f_postI - this.smoothPostI) * smooth;
            this.smoothAugE += (state.f_augE - this.smoothAugE) * smooth;
            this.currentPhase = state.phase;

            // Inspiration blend: ramp toward 1 during inspiration, 0 otherwise
            const targetBlend = state.phase === 'inspiration' ? 1.0 : 0.0;
            this.inspireBlend += (targetBlend - this.inspireBlend) * 0.04;
        }

        // Update particles
        const orbR = this.baseRadius * (1 + this.smoothVolume * 0.8);
        for (let i = this.particles.length - 1; i >= 0; i--) {
            this.particles[i].update(this.cx, this.cy, orbR, this.currentPhase);
            if (this.particles[i].life <= 0) {
                this.particles[i].reset(this.cx, this.cy, orbR);
            }
        }

        // Spawn particles
        while (this.particles.length < this.maxParticles) {
            this.particles.push(new Particle(this.cx, this.cy, orbR));
        }
    }

    draw() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        // Clear with deep blue-black
        ctx.fillStyle = '#060610';
        ctx.fillRect(0, 0, w, h);

        const volume = this.smoothVolume;
        const orbR = this.baseRadius * (1 + volume * 0.8);
        const cx = this.cx;
        const cy = this.cy;

        // ── Color blending ───────────────────────────────────────
        // Inspiration: warm gold/amber (#d4a45a → #f0c878)
        // Expiration: cool blue (#3a6ea5 → #5b8ec9)
        const blend = this.inspireBlend;

        const r = Math.round(58 + blend * 154);   // 58 → 212
        const g = Math.round(110 + blend * 90);    // 110 → 200
        const b = Math.round(165 - blend * 75);    // 165 → 90

        const coreColor = `rgb(${r}, ${g}, ${b})`;

        // ── Outer glow ───────────────────────────────────────────
        const glowR = orbR * 3.0;
        const glowGrad = ctx.createRadialGradient(cx, cy, orbR * 0.5, cx, cy, glowR);
        glowGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.15)`);
        glowGrad.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.05)`);
        glowGrad.addColorStop(1, 'rgba(6, 6, 16, 0)');

        ctx.fillStyle = glowGrad;
        ctx.fillRect(0, 0, w, h);

        // ── Particles ────────────────────────────────────────────
        for (const p of this.particles) {
            const a = p.alpha * p.life;
            if (a < 0.01) continue;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            ctx.fill();
        }

        // ── Orb body with noise displacement ─────────────────────
        const segments = 120;
        const noiseScale = 1.5;
        const noiseAmp = orbR * 0.04;  // subtle surface perturbation
        const timeScale = this.time * 0.3;

        ctx.beginPath();
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const nx = Math.cos(angle);
            const ny = Math.sin(angle);

            // Simplex noise displacement
            const n = noise2D(
                nx * noiseScale + timeScale,
                ny * noiseScale + timeScale * 0.7
            );
            const displacement = orbR + n * noiseAmp;

            const x = cx + nx * displacement;
            const y = cy + ny * displacement;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();

        // Fill with radial gradient
        const bodyGrad = ctx.createRadialGradient(
            cx - orbR * 0.2, cy - orbR * 0.2, orbR * 0.1,
            cx, cy, orbR
        );
        bodyGrad.addColorStop(0, `rgba(${Math.min(255, r+60)}, ${Math.min(255, g+40)}, ${Math.min(255, b+20)}, 0.95)`);
        bodyGrad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.85)`);
        bodyGrad.addColorStop(1, `rgba(${Math.max(0, r-40)}, ${Math.max(0, g-30)}, ${Math.max(0, b-20)}, 0.7)`);

        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // ── Inner highlight (specular) ───────────────────────────
        const specGrad = ctx.createRadialGradient(
            cx - orbR * 0.25, cy - orbR * 0.25, 0,
            cx - orbR * 0.1, cy - orbR * 0.1, orbR * 0.6
        );
        specGrad.addColorStop(0, `rgba(255, 255, 255, ${0.12 + blend * 0.08})`);
        specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

        ctx.fillStyle = specGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
        ctx.fill();

        // ── Breath detection flash ───────────────────────────────
        if (this._breathFlash > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, orbR * 1.1, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 220, 150, ${this._breathFlash * 0.3})`;
            ctx.lineWidth = 2;
            ctx.stroke();
            this._breathFlash *= 0.92;
        }
    }

    render(state) {
        const now = performance.now();
        const dt = (now - this.lastFrame) / 1000;
        this.lastFrame = now;

        if (state && state.breath_detected) {
            this._breathFlash = 1.0;
        }
        if (!this._breathFlash) this._breathFlash = 0;

        this.update(state, dt);
        this.draw();
    }
}

// ── Main ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const renderer = new OrbRenderer(canvas);
const conn = new Connection();

function loop() {
    renderer.render(conn.state);
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
