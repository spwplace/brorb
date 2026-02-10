/**
 * Dashboard — full instrumentation view of all simulation subsystems.
 *
 * Skeuomorphic medical-instrument aesthetic: dark recessed panels,
 * oscilloscope grids, anatomical illustrations, glowing traces.
 *
 * Toggle with 'v' key. Shows:
 *   - CPG neural network (firing rates + synaptic connections)
 *   - Anatomical lung cross-section (volume, diaphragm, HB reflex)
 *   - Heart with ECG trace + RSA
 *   - Vitals readout (HR, BPM, CO2 gauge, stress)
 *   - Multi-channel strip chart
 *   - Mini orb widget
 */

// ── Palette ──────────────────────────────────────────────────────────

const C = {
    bg:          '#0a0a14',
    panelBg:     '#101020',
    panelBorder: 'rgba(70, 90, 130, 0.25)',
    panelGlow:   'rgba(80, 120, 180, 0.06)',
    grid:        'rgba(50, 70, 110, 0.12)',
    header:      'rgba(200, 180, 140, 0.55)',
    label:       'rgba(160, 155, 140, 0.6)',
    text:        '#c8c0a8',
    dim:         'rgba(160, 150, 130, 0.35)',
    accent:      '#e8a040',
    teal:        '#40c8c8',
    green:       '#40e868',
    rose:        '#e06070',
    blue:        '#4080d0',
    purple:      '#9060c0',
};

// ── CPG topology ─────────────────────────────────────────────────────

const CPG_NODES = [
    { id: 'pre-I/I',  x: 0.50, y: 0.12, color: '#e8a040', field: 'f_preI',   label: 'pre-I/I' },
    { id: 'early-I',  x: 0.85, y: 0.40, color: '#d4c040', field: 'f_earlyI', label: 'early-I' },
    { id: 'post-I',   x: 0.72, y: 0.80, color: '#40c8c8', field: 'f_postI',  label: 'post-I' },
    { id: 'aug-E',    x: 0.28, y: 0.80, color: '#4080d0', field: 'f_augE',   label: 'aug-E' },
    { id: 'late-E',   x: 0.15, y: 0.40, color: '#9060c0', field: 'f_lateE',  label: 'late-E' },
];

// Major connections only (|w| >= 1.5) for visual clarity
const CPG_EDGES = [
    { from: 0, to: 1, w:  1.2, exc: true },   // pre-I → early-I
    { from: 1, to: 2, w: -2.0, exc: false },   // early-I → post-I
    { from: 1, to: 3, w: -1.5, exc: false },   // early-I → aug-E
    { from: 2, to: 0, w: -2.5, exc: false },   // post-I → pre-I (kills burst)
    { from: 2, to: 1, w: -1.5, exc: false },   // post-I → early-I
    { from: 2, to: 3, w: -2.0, exc: false },   // post-I → aug-E
    { from: 3, to: 0, w: -1.5, exc: false },   // aug-E → pre-I
    { from: 3, to: 2, w: -2.5, exc: false },   // aug-E → post-I (kills PI)
    { from: 4, to: 0, w:  0.5, exc: true },    // late-E → pre-I (restart)
];

// ── ECG waveform ─────────────────────────────────────────────────────

function ecgWave(phase) {
    if (phase < 0 || phase > 0.55) return 0;
    if (phase < 0.08) return 0.12 * Math.sin(phase / 0.08 * Math.PI);          // P
    if (phase < 0.12) return 0;
    if (phase < 0.15) return -0.12 * ((phase - 0.12) / 0.03);                  // Q
    if (phase < 0.20) return -0.12 + 1.12 * Math.sin((phase - 0.15) / 0.05 * Math.PI); // R
    if (phase < 0.26) return -0.25 * Math.sin((phase - 0.20) / 0.06 * Math.PI); // S
    if (phase < 0.30) return 0;
    if (phase < 0.50) return 0.22 * Math.sin((phase - 0.30) / 0.20 * Math.PI); // T
    return 0;
}

// ── Dashboard class ──────────────────────────────────────────────────

export class Dashboard {
    constructor() {
        this.visible = false;

        // Ring buffers for strip chart (600 = 10s at 60fps)
        this.bufLen = 600;
        this.bufs = {
            lungVol: new Float32Array(600),
            fPreI:   new Float32Array(600),
            fPostI:  new Float32Array(600),
            fAugE:   new Float32Array(600),
            pco2:    new Float32Array(600),
            hr:      new Float32Array(600),
        };
        this.writeIdx = 0;

        // ECG trace buffer (300 = 5s at 60fps)
        this.ecgBuf = new Float32Array(300);
        this.ecgIdx = 0;
        this.beatPhase = -1;

        // Animation
        this._heartScale = 1.0;
        this._smoothDiaph = 0;
        this._smoothVol = 0;
        this._inspBlend = 0;

        // DOM
        this._container = null;
        this._panels = {};
        this._build();

        window.addEventListener('resize', () => this._resize());
    }

    // ── DOM construction ─────────────────────────────────────────────

    _build() {
        // Inject styles
        const style = document.createElement('style');
        style.textContent = `
            .brorb-dash {
                position: fixed; inset: 0; z-index: 50;
                display: none;
                background: ${C.bg};
                font-family: Georgia, "Times New Roman", serif;
            }
            .brorb-dash.active { display: grid; }
            .brorb-dash {
                grid-template-columns: 200px 1fr 1fr;
                grid-template-rows: 1fr 1fr 160px;
                gap: 6px;
                padding: 8px;
            }
            .brorb-panel {
                position: relative;
                background: linear-gradient(165deg, #13132a 0%, ${C.panelBg} 100%);
                border: 1px solid ${C.panelBorder};
                border-radius: 5px;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,0.02),
                    inset 0 0 20px rgba(0,0,0,0.3),
                    0 2px 8px rgba(0,0,0,0.5);
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            .brorb-panel-hdr {
                padding: 6px 10px 3px;
                font-size: 9.5px;
                letter-spacing: 2.5px;
                text-transform: uppercase;
                color: ${C.header};
                flex-shrink: 0;
                border-bottom: 1px solid rgba(60,70,100,0.15);
            }
            .brorb-panel canvas {
                flex: 1;
                width: 100%;
                min-height: 0;
            }
            .brorb-panel-orb   { grid-column: 1; grid-row: 1; }
            .brorb-panel-cpg   { grid-column: 2 / 4; grid-row: 1; }
            .brorb-panel-vitals { grid-column: 1; grid-row: 2; }
            .brorb-panel-lungs  { grid-column: 2; grid-row: 2; }
            .brorb-panel-heart  { grid-column: 3; grid-row: 2; }
            .brorb-panel-strip  { grid-column: 1 / 4; grid-row: 3; }
        `;
        document.head.appendChild(style);

        // Container
        this._container = document.createElement('div');
        this._container.className = 'brorb-dash';
        document.body.appendChild(this._container);

        // Create panels
        const defs = [
            ['orb',    'Orb'],
            ['cpg',    'Brainstem CPG Circuit'],
            ['vitals', 'Vitals'],
            ['lungs',  'Respiratory Mechanics'],
            ['heart',  'Cardiac \u2014 ECG'],
            ['strip',  'Physiological Traces'],
        ];

        for (const [id, title] of defs) {
            const panel = document.createElement('div');
            panel.className = `brorb-panel brorb-panel-${id}`;

            const hdr = document.createElement('div');
            hdr.className = 'brorb-panel-hdr';
            hdr.textContent = title;
            panel.appendChild(hdr);

            const cvs = document.createElement('canvas');
            panel.appendChild(cvs);

            this._container.appendChild(panel);
            this._panels[id] = { el: panel, canvas: cvs, ctx: cvs.getContext('2d'), w: 0, h: 0 };
        }

        this._resize();
    }

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        for (const key in this._panels) {
            const p = this._panels[key];
            const rect = p.canvas.getBoundingClientRect();
            p.w = rect.width;
            p.h = rect.height;
            p.canvas.width = rect.width * dpr;
            p.canvas.height = rect.height * dpr;
            p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    }

    toggle() {
        this.visible = !this.visible;
        this._container.classList.toggle('active', this.visible);
        if (this.visible) this._resize();
    }

    // ── Data ─────────────────────────────────────────────────────────

    _pushBuffers(state) {
        const i = this.writeIdx % this.bufLen;
        this.bufs.lungVol[i] = state.lung_volume ?? 0;
        this.bufs.fPreI[i]   = state.f_preI ?? 0;
        this.bufs.fPostI[i]  = state.f_postI ?? 0;
        this.bufs.fAugE[i]   = state.f_augE ?? 0;
        this.bufs.pco2[i]    = state.pco2 ?? 1;
        this.bufs.hr[i]      = state.heart_rate ?? 70;
        this.writeIdx++;

        // ECG
        if (state.heartbeat) this.beatPhase = 0;
        const rrSec = 60 / Math.max(30, state.heart_rate ?? 70);
        const ecgVal = this.beatPhase >= 0 ? ecgWave(this.beatPhase) : 0;
        if (this.beatPhase >= 0) {
            this.beatPhase += (1 / 60) / rrSec;
            if (this.beatPhase > 1) this.beatPhase = -1;
        }
        this.ecgBuf[this.ecgIdx % 300] = ecgVal;
        this.ecgIdx++;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _drawGrid(ctx, w, h, rows = 4, cols = 5) {
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 0.5;
        for (let r = 1; r < rows; r++) {
            const y = (r / rows) * h;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        for (let c = 1; c < cols; c++) {
            const x = (c / cols) * w;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
    }

    _clearPanel(key) {
        const p = this._panels[key];
        p.ctx.clearRect(0, 0, p.w, p.h);
    }

    // ── CPG Network ──────────────────────────────────────────────────

    _renderCPG(state) {
        const p = this._panels.cpg;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);
        this._drawGrid(ctx, w, h, 5, 8);

        const pad = 40;
        const cw = w - pad * 2, ch = h - pad * 2;

        // Draw edges first (behind nodes)
        for (const edge of CPG_EDGES) {
            const a = CPG_NODES[edge.from];
            const b = CPG_NODES[edge.to];
            const ax = pad + a.x * cw, ay = pad + a.y * ch;
            const bx = pad + b.x * cw, by = pad + b.y * ch;

            // Firing rate of source modulates edge visibility
            const srcRate = state[a.field] ?? 0;
            const alpha = 0.08 + srcRate * 0.5;
            const thickness = 1 + srcRate * 2.5;

            // Control point offset for curve (perpendicular to line)
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            const dx = bx - ax, dy = by - ay;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len, ny = dx / len;
            const curveOff = len * 0.15;
            const cpx = mx + nx * curveOff, cpy = my + ny * curveOff;

            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.quadraticCurveTo(cpx, cpy, bx, by);
            ctx.strokeStyle = edge.exc
                ? `rgba(232, 180, 80, ${alpha})`
                : `rgba(100, 160, 220, ${alpha})`;
            ctx.lineWidth = thickness;
            ctx.stroke();

            // Arrowhead at target
            const t = 0.85;
            const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cpx + t * t * bx;
            const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cpy + t * t * by;
            const tdx = bx - cpx, tdy = by - cpy;
            const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
            const arrSize = 5 + thickness;
            const adx = tdx / tlen, ady = tdy / tlen;

            ctx.beginPath();
            ctx.moveTo(px + adx * arrSize, py + ady * arrSize);
            ctx.lineTo(px - ady * arrSize * 0.5 - adx * 2, py + adx * arrSize * 0.5 - ady * 2);
            ctx.lineTo(px + ady * arrSize * 0.5 - adx * 2, py - adx * arrSize * 0.5 - ady * 2);
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
        }

        // Draw nodes
        for (const node of CPG_NODES) {
            const nx = pad + node.x * cw;
            const ny = pad + node.y * ch;
            const rate = state[node.field] ?? 0;
            const r = 14 + rate * 18;

            // Glow
            if (rate > 0.1) {
                const glow = ctx.createRadialGradient(nx, ny, r * 0.3, nx, ny, r * 3);
                glow.addColorStop(0, node.color + Math.round(rate * 40).toString(16).padStart(2, '0'));
                glow.addColorStop(1, 'transparent');
                ctx.fillStyle = glow;
                ctx.fillRect(nx - r * 3, ny - r * 3, r * 6, r * 6);
            }

            // Body
            const grad = ctx.createRadialGradient(nx - r * 0.2, ny - r * 0.2, r * 0.1, nx, ny, r);
            const baseAlpha = 0.3 + rate * 0.7;
            grad.addColorStop(0, node.color + 'ee');
            grad.addColorStop(1, node.color + Math.round(baseAlpha * 100).toString(16).padStart(2, '0'));
            ctx.beginPath();
            ctx.arc(nx, ny, r, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = node.color + '80';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Label
            ctx.fillStyle = C.text;
            ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(node.label, nx, ny + r + 14);

            // Rate value
            ctx.fillStyle = C.dim;
            ctx.font = '9px "SF Mono", Menlo, Consolas, monospace';
            ctx.fillText(rate.toFixed(2), nx, ny + r + 25);
        }

        // Phase indicator
        ctx.textAlign = 'left';
        ctx.font = '12px Georgia, serif';
        ctx.fillStyle = C.accent;
        const phaseLabel = (state.phase ?? 'expiration').toUpperCase();
        ctx.fillText(phaseLabel, 10, h - 10);
    }

    // ── Lungs ────────────────────────────────────────────────────────

    _renderLungs(state) {
        const p = this._panels.lungs;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);
        this._drawGrid(ctx, w, h, 4, 4);

        const vol = state.lung_volume ?? 0;
        const rampI = state.ramp_I ?? 0;
        this._smoothVol += (vol - this._smoothVol) * 0.1;
        this._smoothDiaph += (rampI - this._smoothDiaph) * 0.08;

        const cx = w * 0.5, cy = h * 0.42;
        const scale = Math.min(w, h) * 0.0038;
        const sv = this._smoothVol;
        const diaphY = cy + 85 * scale + this._smoothDiaph * -15 * scale;

        // Trachea
        const trW = 8 * scale;
        ctx.fillStyle = 'rgba(80, 120, 160, 0.25)';
        ctx.fillRect(cx - trW / 2, cy - 65 * scale, trW, 40 * scale);

        // Bronchi (Y-split)
        ctx.strokeStyle = 'rgba(80, 120, 160, 0.25)';
        ctx.lineWidth = trW * 0.7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 25 * scale);
        ctx.quadraticCurveTo(cx - 15 * scale, cy - 10 * scale, cx - 40 * scale, cy + 5 * scale);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - 25 * scale);
        ctx.quadraticCurveTo(cx + 15 * scale, cy - 10 * scale, cx + 40 * scale, cy + 5 * scale);
        ctx.stroke();

        // Draw lung lobes
        const drawLobe = (side) => {
            const s = side === 'left' ? -1 : 1;
            const lx = cx + s * 50 * scale;

            ctx.beginPath();
            ctx.moveTo(cx + s * 10 * scale, cy - 30 * scale);
            ctx.bezierCurveTo(
                cx + s * 15 * scale, cy - 55 * scale,
                lx + s * 40 * scale, cy - 40 * scale,
                lx + s * 45 * scale, cy - 5 * scale
            );
            ctx.bezierCurveTo(
                lx + s * 48 * scale, cy + 40 * scale,
                lx + s * 30 * scale, cy + 75 * scale,
                cx + s * 5 * scale, cy + 70 * scale
            );
            ctx.bezierCurveTo(
                cx + s * 3 * scale, cy + 30 * scale,
                cx + s * 8 * scale, cy - 5 * scale,
                cx + s * 10 * scale, cy - 30 * scale
            );
            ctx.closePath();

            // Fill: volume-dependent gradient
            const fillGrad = ctx.createLinearGradient(lx, cy + 80 * scale, lx, cy - 50 * scale);
            const fillAlpha = 0.15 + sv * 0.45;
            fillGrad.addColorStop(0, `rgba(60, 180, 200, ${fillAlpha})`);
            fillGrad.addColorStop(1 - sv, `rgba(60, 180, 200, ${fillAlpha * 0.1})`);
            fillGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = fillGrad;
            ctx.fill();

            // Outline
            ctx.strokeStyle = `rgba(80, 160, 190, ${0.3 + sv * 0.3})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        };

        drawLobe('left');
        drawLobe('right');

        // Diaphragm
        ctx.beginPath();
        ctx.moveTo(cx - 90 * scale, diaphY);
        ctx.quadraticCurveTo(cx, diaphY + (20 - this._smoothDiaph * 20) * scale, cx + 90 * scale, diaphY);
        ctx.strokeStyle = `rgba(200, 160, 100, ${0.3 + this._smoothDiaph * 0.4})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Airflow arrows
        if (sv > 0.05) {
            const isInsp = (state.phase === 'inspiration');
            const arrowAlpha = isInsp ? sv * 0.5 : sv * 0.2;
            ctx.strokeStyle = `rgba(200, 200, 255, ${arrowAlpha})`;
            ctx.lineWidth = 1.5;
            const arrowDir = isInsp ? 1 : -1;
            for (let a = -1; a <= 1; a += 2) {
                const ax = cx + a * 25 * scale;
                const ay1 = cy - 50 * scale;
                const ay2 = ay1 + arrowDir * 20 * scale;
                ctx.beginPath();
                ctx.moveTo(ax, ay1);
                ctx.lineTo(ax, ay2);
                ctx.moveTo(ax - 4, ay2 - arrowDir * 6);
                ctx.lineTo(ax, ay2);
                ctx.lineTo(ax + 4, ay2 - arrowDir * 6);
                ctx.stroke();
            }
        }

        // Readouts
        ctx.textAlign = 'left';
        ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
        ctx.fillStyle = C.label;
        ctx.fillText(`Vol: ${sv.toFixed(2)}`, 8, h - 24);
        ctx.fillText(`Ramp-I: ${rampI.toFixed(2)}`, 8, h - 10);

        // HB reflex indicator
        if (sv > 0.85) {
            ctx.fillStyle = `rgba(255, 100, 60, ${(sv - 0.85) * 5})`;
            ctx.font = '9px "SF Mono", Menlo, Consolas, monospace';
            ctx.textAlign = 'right';
            ctx.fillText('HB REFLEX', w - 8, h - 10);
        }
    }

    // ── Heart + ECG ──────────────────────────────────────────────────

    _renderHeart(state) {
        const p = this._panels.heart;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);

        // Upper half: heart shape, lower half: ECG trace
        const splitY = h * 0.5;

        // ── Heart shape ──────────────
        if (state.heartbeat) this._heartScale = 1.18;
        this._heartScale += (1.0 - this._heartScale) * 0.12;

        const hcx = w * 0.5, hcy = splitY * 0.48;
        const hs = Math.min(w, splitY) * 0.22 * this._heartScale;

        ctx.save();
        ctx.translate(hcx, hcy);

        // Glow
        const glow = ctx.createRadialGradient(0, 0, hs * 0.3, 0, 0, hs * 2.5);
        glow.addColorStop(0, `rgba(220, 80, 90, ${0.08 + (this._heartScale - 1) * 1.5})`);
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.fillRect(-hs * 3, -hs * 3, hs * 6, hs * 6);

        // Heart path
        ctx.beginPath();
        ctx.moveTo(0, hs * 0.9);
        ctx.bezierCurveTo(-hs * 0.1, hs * 0.6, -hs * 1.0, hs * 0.2, -hs * 1.0, -hs * 0.2);
        ctx.bezierCurveTo(-hs * 1.0, -hs * 0.8, -hs * 0.5, -hs * 1.0, 0, -hs * 0.5);
        ctx.bezierCurveTo(hs * 0.5, -hs * 1.0, hs * 1.0, -hs * 0.8, hs * 1.0, -hs * 0.2);
        ctx.bezierCurveTo(hs * 1.0, hs * 0.2, hs * 0.1, hs * 0.6, 0, hs * 0.9);
        ctx.closePath();

        const heartGrad = ctx.createRadialGradient(-hs * 0.2, -hs * 0.3, hs * 0.1, 0, 0, hs * 1.1);
        heartGrad.addColorStop(0, '#e87080');
        heartGrad.addColorStop(0.6, '#c04050');
        heartGrad.addColorStop(1, '#802030');
        ctx.fillStyle = heartGrad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 120, 140, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Specular
        ctx.beginPath();
        ctx.ellipse(-hs * 0.35, -hs * 0.35, hs * 0.25, hs * 0.15, -0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fill();

        ctx.restore();

        // HR + RSA readout
        ctx.textAlign = 'center';
        ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
        ctx.fillStyle = C.text;
        const hr = state.heart_rate ?? 70;
        const rsa = state.rsa_amplitude ?? 0;
        ctx.fillText(`${hr.toFixed(0)} bpm`, hcx - 30, splitY - 8);
        ctx.fillStyle = C.dim;
        ctx.font = '9px "SF Mono", Menlo, Consolas, monospace';
        ctx.fillText(`RSA ${rsa.toFixed(1)}`, hcx + 35, splitY - 8);

        // ── ECG trace ────────────────
        const ecgTop = splitY + 4;
        const ecgH = h - ecgTop - 4;
        const ecgW = w - 16;
        const ex = 8;

        // Grid
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 0.5;
        for (let r = 0; r < 4; r++) {
            const gy = ecgTop + (r / 3) * ecgH;
            ctx.beginPath(); ctx.moveTo(ex, gy); ctx.lineTo(ex + ecgW, gy); ctx.stroke();
        }

        // Trace
        ctx.beginPath();
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 1.5;
        const ecgLen = 300;
        const n = Math.min(this.ecgIdx, ecgLen);
        for (let s = 0; s < ecgW; s++) {
            const bi = Math.floor((s / ecgW) * ecgLen);
            const bufI = (this.ecgIdx - ecgLen + bi + ecgLen * 100) % ecgLen;
            const val = this.ecgBuf[bufI];
            const px = ex + s;
            const py = ecgTop + ecgH * 0.55 - val * ecgH * 0.4;
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Glow on trace
        ctx.strokeStyle = `rgba(64, 232, 104, 0.3)`;
        ctx.lineWidth = 4;
        ctx.stroke();
    }

    // ── Vitals ───────────────────────────────────────────────────────

    _renderVitals(state) {
        const p = this._panels.vitals;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);

        const x = 10;
        let y = 12;
        const lineH = 18;

        const mono = '11px "SF Mono", Menlo, Consolas, monospace';
        const monoSm = '9px "SF Mono", Menlo, Consolas, monospace';

        // HR
        ctx.font = mono;
        ctx.fillStyle = C.label;
        ctx.fillText('HR', x, y);
        ctx.fillStyle = C.text;
        ctx.fillText(`${(state.heart_rate ?? 70).toFixed(0)} bpm`, x + 50, y);
        y += lineH;

        // RSA
        ctx.fillStyle = C.label;
        ctx.fillText('RSA', x, y);
        ctx.fillStyle = C.text;
        ctx.fillText(`${(state.rsa_amplitude ?? 0).toFixed(1)} bpm`, x + 50, y);
        y += lineH;

        // BPM
        ctx.fillStyle = C.label;
        ctx.fillText('BPM', x, y);
        ctx.fillStyle = C.accent;
        ctx.fillText(`${(state.est_bpm ?? 4).toFixed(1)}`, x + 50, y);
        y += lineH;

        // Phase
        ctx.fillStyle = C.label;
        ctx.fillText('Phase', x, y);
        ctx.fillStyle = state.phase === 'inspiration' ? C.accent : C.teal;
        ctx.font = monoSm;
        ctx.fillText((state.phase ?? '').toUpperCase(), x + 50, y);
        y += lineH + 6;

        // ── CO2 gauge ────────────────
        ctx.font = mono;
        ctx.fillStyle = C.label;
        ctx.fillText('CO\u2082', x, y);
        ctx.fillStyle = C.text;
        ctx.fillText(`${(state.pco2 ?? 1).toFixed(2)}`, x + 50, y);
        y += lineH;

        // Arc gauge
        const gcx = w * 0.5, gcy = y + 42;
        const gr = 35;
        const startAngle = Math.PI * 0.75;
        const endAngle = Math.PI * 0.25;
        const totalAngle = Math.PI * 1.5;

        // Background arc
        ctx.beginPath();
        ctx.arc(gcx, gcy, gr, startAngle, startAngle + totalAngle);
        ctx.strokeStyle = 'rgba(60, 70, 100, 0.3)';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Colored arc segments
        const co2 = Math.max(0, Math.min(2, state.pco2 ?? 1));
        const co2Frac = co2 / 2.0;
        const segments = [
            { frac: 0.375, color: 'rgba(50, 180, 80, 0.6)' },
            { frac: 0.625, color: 'rgba(200, 180, 50, 0.6)' },
            { frac: 1.0,   color: 'rgba(200, 60, 60, 0.6)' },
        ];
        let prevFrac = 0;
        for (const seg of segments) {
            if (co2Frac <= prevFrac) break;
            const from = startAngle + prevFrac * totalAngle;
            const to = startAngle + Math.min(co2Frac, seg.frac) * totalAngle;
            ctx.beginPath();
            ctx.arc(gcx, gcy, gr, from, to);
            ctx.strokeStyle = seg.color;
            ctx.lineWidth = 6;
            ctx.stroke();
            prevFrac = seg.frac;
        }

        // Needle
        const needleAngle = startAngle + co2Frac * totalAngle;
        const nx = gcx + Math.cos(needleAngle) * (gr - 10);
        const ny = gcy + Math.sin(needleAngle) * (gr - 10);
        const ntx = gcx + Math.cos(needleAngle) * (gr + 4);
        const nty = gcy + Math.sin(needleAngle) * (gr + 4);
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(ntx, nty);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Center dot
        ctx.beginPath();
        ctx.arc(gcx, gcy, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Threshold tick
        const threshFrac = 0.75 / 2.0;
        const tAngle = startAngle + threshFrac * totalAngle;
        ctx.beginPath();
        ctx.moveTo(gcx + Math.cos(tAngle) * (gr + 6), gcy + Math.sin(tAngle) * (gr + 6));
        ctx.lineTo(gcx + Math.cos(tAngle) * (gr + 12), gcy + Math.sin(tAngle) * (gr + 12));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();

        y = gcy + gr + 20;

        // ── Stress bar ───────────────
        ctx.font = monoSm;
        ctx.fillStyle = C.label;
        ctx.fillText('Stress', x, y);

        const barX = x + 45, barW = w - barX - 10, barH = 8;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(barX, y - 7, barW, barH);

        const stress = Math.max(0, Math.min(1, state.stress_index ?? 0));
        const sr = Math.round(stress * 220);
        const sg = Math.round((1 - stress) * 180);
        ctx.fillStyle = `rgb(${sr}, ${sg}, 40)`;
        ctx.fillRect(barX, y - 7, stress * barW, barH);

        y += lineH;

        // Chemo drive
        ctx.fillStyle = C.label;
        ctx.fillText('Chemo', x, y);
        ctx.fillStyle = C.dim;
        ctx.fillText(`${(state.chemo_drive ?? 0).toFixed(3)}`, x + 45, y);
    }

    // ── Strip chart ──────────────────────────────────────────────────

    _renderStrip() {
        const p = this._panels.strip;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);

        const channels = [
            { buf: this.bufs.lungVol, color: '#40c8c8', label: 'Vol', min: 0, max: 1.2 },
            { buf: this.bufs.fPreI,   color: '#e8a040', label: 'pre-I', min: 0, max: 1 },
            { buf: this.bufs.fPostI,  color: '#40c8c8', label: 'post-I', min: 0, max: 1 },
            { buf: this.bufs.fAugE,   color: '#4080d0', label: 'aug-E', min: 0, max: 1 },
            { buf: this.bufs.pco2,    color: '#60b840', label: 'CO\u2082', min: 0.5, max: 1.5 },
            { buf: this.bufs.hr,      color: '#e06070', label: 'HR', min: 55, max: 90 },
        ];

        const chH = h / channels.length;
        const lx = 42;
        const traceW = w - lx - 8;

        for (let ci = 0; ci < channels.length; ci++) {
            const ch = channels[ci];
            const ty = ci * chH;

            // Separator
            if (ci > 0) {
                ctx.strokeStyle = 'rgba(60, 70, 100, 0.2)';
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(0, ty);
                ctx.lineTo(w, ty);
                ctx.stroke();
            }

            // Label
            ctx.font = '8px "SF Mono", Menlo, Consolas, monospace';
            ctx.fillStyle = ch.color + '99';
            ctx.textAlign = 'right';
            ctx.fillText(ch.label, lx - 4, ty + chH * 0.6);

            // Trace
            ctx.beginPath();
            ctx.strokeStyle = ch.color;
            ctx.lineWidth = 1;
            const n = Math.min(this.writeIdx, this.bufLen);
            for (let s = 0; s < traceW; s++) {
                const bi = Math.floor((s / traceW) * this.bufLen);
                const bufI = (this.writeIdx - this.bufLen + bi + this.bufLen * 100) % this.bufLen;
                const raw = ch.buf[bufI];
                const norm = (raw - ch.min) / (ch.max - ch.min);
                const py = ty + chH - Math.max(0, Math.min(1, norm)) * (chH - 2) - 1;
                if (s === 0) ctx.moveTo(lx + s, py);
                else ctx.lineTo(lx + s, py);
            }
            ctx.stroke();
        }

        ctx.textAlign = 'left';
    }

    // ── Mini orb ─────────────────────────────────────────────────────

    _renderMiniOrb(state) {
        const p = this._panels.orb;
        const ctx = p.ctx, w = p.w, h = p.h;
        ctx.clearRect(0, 0, w, h);

        const vol = state.lung_volume ?? 0;
        this._inspBlend += ((state.phase === 'inspiration' ? 1 : 0) - this._inspBlend) * 0.04;
        const blend = this._inspBlend;

        const cx = w / 2, cy = h / 2;
        const baseR = Math.min(w, h) * 0.28;
        const orbR = baseR * (1 + vol * 0.5);

        // Colors (same as main orb)
        const rBase = 58 + blend * 154;
        const gBase = 110 + blend * 90;
        const bBase = 165 - blend * 75;
        const r = Math.round(rBase);
        const g = Math.round(gBase);
        const b = Math.round(bBase);

        // Glow
        const glow = ctx.createRadialGradient(cx, cy, orbR * 0.3, cx, cy, orbR * 2.5);
        glow.addColorStop(0, `rgba(${r},${g},${b}, 0.2)`);
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);

        // Body
        const bodyGrad = ctx.createRadialGradient(cx - orbR * 0.2, cy - orbR * 0.2, orbR * 0.1, cx, cy, orbR);
        bodyGrad.addColorStop(0, `rgba(${Math.min(255,r+50)},${Math.min(255,g+30)},${Math.min(255,b+15)}, 0.95)`);
        bodyGrad.addColorStop(0.6, `rgba(${r},${g},${b}, 0.85)`);
        bodyGrad.addColorStop(1, `rgba(${Math.max(0,r-30)},${Math.max(0,g-20)},${Math.max(0,b-15)}, 0.7)`);
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // Specular
        const spec = ctx.createRadialGradient(cx - orbR * 0.25, cy - orbR * 0.25, 0, cx, cy, orbR * 0.6);
        spec.addColorStop(0, `rgba(255,255,255, ${0.1 + blend * 0.08})`);
        spec.addColorStop(1, 'transparent');
        ctx.fillStyle = spec;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
        ctx.fill();
    }

    // ── Main update ──────────────────────────────────────────────────

    update(state) {
        if (!state) return;

        // Always push buffers (even when hidden, for strip chart history)
        this._pushBuffers(state);

        if (!this.visible) return;

        this._renderMiniOrb(state);
        this._renderCPG(state);
        this._renderVitals(state);
        this._renderLungs(state);
        this._renderHeart(state);
        this._renderStrip();
    }
}
