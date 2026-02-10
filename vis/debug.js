/**
 * Debug panel — toggleable overlay showing internal simulation state.
 * Press 'd' to show/hide.
 */

export class DebugPanel {
    constructor() {
        this.visible = false;
        this.W = 320;
        this.H = 420;

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'debug-canvas';
        this.canvas.width = this.W * (window.devicePixelRatio || 1);
        this.canvas.height = this.H * (window.devicePixelRatio || 1);
        this.canvas.style.cssText =
            `position:fixed;bottom:8px;left:8px;width:${this.W}px;height:${this.H}px;` +
            'pointer-events:none;z-index:100;display:none;';
        document.body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this.ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

        this.bufLen = 1800;
        this.lungBuf = new Float32Array(this.bufLen);
        this.co2Buf = new Float32Array(this.bufLen);
        this.hrBuf = new Float32Array(this.bufLen);
        this.writeIdx = 0;

        this._beatFlash = 0;

        window.addEventListener('keydown', (e) => {
            if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                this.visible = !this.visible;
                this.canvas.style.display = this.visible ? 'block' : 'none';
            }
        });
    }

    update(state) {
        if (!state) return;

        const i = this.writeIdx % this.bufLen;
        this.lungBuf[i] = state.lung_volume || 0;
        this.co2Buf[i] = state.pco2 || 40;
        this.hrBuf[i] = state.heart_rate || 70;
        this.writeIdx++;

        if (state.heartbeat) this._beatFlash = 1.0;

        if (!this.visible) return;
        this._draw(state);
    }

    _draw(state) {
        const ctx = this.ctx;
        const W = this.W;
        const H = this.H;

        ctx.fillStyle = 'rgba(6, 6, 16, 0.85)';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(100,120,160,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

        let y = 10;

        // 1. Neural population bars
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px monospace';
        ctx.fillText('Neural Populations', 8, y + 2);
        y += 8;

        const pops = [
            { label: 'pre-I/I', val: state.f_preI, color: '#e8a040' },
            { label: 'early-I', val: state.f_earlyI, color: '#d4c040' },
            { label: 'post-I',  val: state.f_postI,  color: '#40c8c8' },
            { label: 'aug-E',   val: state.f_augE,   color: '#4080d0' },
            { label: 'late-E',  val: state.f_lateE,  color: '#9060c0' },
        ];

        const barH = 10;
        const barX = 60;
        const barW = W - barX - 12;
        for (const pop of pops) {
            ctx.fillStyle = '#667788';
            ctx.font = '9px monospace';
            ctx.fillText(pop.label, 8, y + barH - 1);

            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(barX, y, barW, barH);

            const fw = Math.max(0, Math.min(1, pop.val)) * barW;
            ctx.fillStyle = pop.color;
            ctx.fillRect(barX, y, fw, barH);

            y += barH + 3;
        }

        y += 6;

        // 2. Lung volume trace
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px monospace';
        ctx.fillText('Lung Volume', 8, y + 2);
        y += 8;

        const traceH = 90;
        const traceX = 8;
        const traceW = W - 16;

        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(traceX, y, traceW, traceH);

        ctx.beginPath();
        ctx.strokeStyle = '#60a8e0';
        ctx.lineWidth = 1.2;
        for (let s = 0; s < traceW; s++) {
            const bufIdx = (this.writeIdx - traceW + s + this.bufLen * 2) % this.bufLen;
            const v = this.lungBuf[bufIdx];
            const px = traceX + s;
            const py = y + traceH - v * traceH;
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        y += traceH + 8;

        // 3. CO2 indicator (mmHg)
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px monospace';
        const pco2 = state.pco2 || 40.0;
        ctx.fillText(`CO\u2082: ${pco2.toFixed(1)} mmHg`, 8, y + 2);
        y += 8;

        const co2BarH = 14;
        const co2Min = 20.0;
        const co2Max = 60.0;

        const co2Grad = ctx.createLinearGradient(traceX, 0, traceX + traceW, 0);
        co2Grad.addColorStop(0, '#206830');
        co2Grad.addColorStop(0.375, '#60a830');
        co2Grad.addColorStop(0.625, '#c8a020');
        co2Grad.addColorStop(1, '#c03030');
        ctx.fillStyle = co2Grad;
        ctx.fillRect(traceX, y, traceW, co2BarH);

        const co2Frac = Math.min(1, Math.max(0, (pco2 - co2Min) / (co2Max - co2Min)));
        const co2X = traceX + co2Frac * traceW;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(co2X - 1, y - 2, 3, co2BarH + 4);

        // Apneic threshold at 35 mmHg
        const threshFrac = (35.0 - co2Min) / (co2Max - co2Min);
        const threshX = traceX + threshFrac * traceW;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(threshX, y);
        ctx.lineTo(threshX, y + co2BarH);
        ctx.stroke();
        ctx.setLineDash([]);

        y += co2BarH + 10;

        // 4. Heart rate + RSA + stress
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px monospace';
        const hr = state.heart_rate || 70;
        const rsa = state.rsa_amplitude || 0;
        ctx.fillText(`HR: ${hr.toFixed(0)} bpm   RSA: ${rsa.toFixed(1)} bpm`, 8, y + 2);
        y += 14;

        if (this._beatFlash > 0.05) {
            const dotR = 4 + this._beatFlash * 3;
            ctx.beginPath();
            ctx.arc(W - 20, y - 8, dotR, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(220, 60, 60, ${this._beatFlash})`;
            ctx.fill();
            this._beatFlash *= 0.90;
        }

        ctx.fillStyle = '#667788';
        ctx.font = '9px monospace';
        ctx.fillText('Stress', 8, y + 9);
        const stressBarX = 50;
        const stressBarW = W - stressBarX - 12;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(stressBarX, y, stressBarW, 10);

        const stress = Math.min(1, Math.max(0, state.stress_index || 0));
        const sr = Math.round(stress * 220);
        const sg = Math.round((1 - stress) * 180);
        ctx.fillStyle = `rgb(${sr}, ${sg}, 40)`;
        ctx.fillRect(stressBarX, y, stress * stressBarW, 10);

        y += 20;

        // 5. Breathing rate
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px monospace';
        const bpm = state.est_bpm || 0;
        ctx.fillText(`Breathing: ${bpm.toFixed(1)} bpm`, 8, y + 2);
        y += 14;

        ctx.fillStyle = '#667788';
        ctx.font = '9px monospace';
        ctx.fillText(`Chemo: ${(state.chemo_drive || 0).toFixed(3)}  Vagal: ${(state.vagal_tone || 0).toFixed(2)}`, 8, y + 2);
    }
}
