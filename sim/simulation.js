/**
 * Simulation orchestrator.
 *
 * Runs the CPG + lung + chemo + autonomic + hemodynamics + heart models,
 * driven by requestAnimationFrame from app.js. Returns state snapshots
 * for the renderer.
 *
 * Rate control: breathing rate is modulated by smoothly interpolating
 * tonic drives (d1, d3, d5) toward target values computed by
 * driveProfile(). Biophysical timescales are FIXED.
 *
 * Hemodynamics: MAP = CO × TPR. Baroreflex senses MAP. Coronary
 * perfusion creates ischemia feedback loop. Cerebral autoregulation
 * from MAP (Guyton Ch. 62): plateau at 50–150 mmHg, fails below 50.
 *
 * Gas exchange: V/Q coupling — both ventilation AND perfusion needed.
 * Ventilation estimated from lung volume flow (|dV/dt|), not mean volume.
 */

import { CPGState, defaultParams, driveProfile, BASE_DRIVES, rk4Step, sigmoid } from './cpg.js';
import { LungState, defaultLungParams, lungRk4Step, heringBreuerDrives } from './lungs.js';
import { ChemoState, defaultChemoParams, stepChemo, chemoCpgDrives } from './chemo.js';
import { AutonomicState, defaultAutonomicParams, stepAutonomic } from './autonomic.js';
import { HemodynamicsState, defaultHemodynamicsParams, stepHemodynamics } from './hemodynamics.js';
import { HeartState, defaultHeartParams, stepHeart, resuscitateHeart } from './heart.js';

function determinePhase(cpgY, cpgP) {
    const f1 = sigmoid(cpgY[0], cpgP.k_f, cpgP.Vh_f);
    const f3 = sigmoid(cpgY[2], cpgP.k_f, cpgP.Vh_f);
    if (f1 > 0.4) return 'inspiration';
    if (f3 > 0.4) return 'post-inspiration';
    return 'expiration';
}

export class Simulation {
    constructor(targetBpm = 6.0) {
        this.dt = 0.001;

        // Models — params created once, drives interpolated smoothly
        this.cpgParams = defaultParams();
        this.lungParams = defaultLungParams();
        this.cpgState = new CPGState();
        this.lungState = new LungState();
        this.chemoState = new ChemoState();
        this.chemoParams = defaultChemoParams();
        this.autonomicState = new AutonomicState();
        this.autonomicParams = defaultAutonomicParams();
        this.hemoState = new HemodynamicsState();
        this.hemoParams = defaultHemodynamicsParams();
        this.heartState = new HeartState();
        this.heartParams = defaultHeartParams();

        // Time
        this.t = 0;
        this.stepCount = 0;

        // Drive interpolation
        this._targetBpm = targetBpm;
        this._targetDrives = driveProfile(targetBpm);
        this._driveInterpolTau = 2.0;  // smooth transition over ~2s

        // Manual drive (hyper/hypoventilation from controls)
        this.manualDrive = 0;

        // Entrainment (routes to d3 = post-I, reinforcing expiratory transition)
        this.entrainPulse = 0;
        this.entrainDecay = 0.995;
        this.entrainStrength = 0.8;
        this.breathDetected = false;
        this.breathDetectDecay = 0;

        // Flow-based ventilation estimation
        this._prevLungVolume = 0;
        this._smoothAbsFlow = 0;
        this._flowSmoothTau = 5.0;     // s, ~one breath cycle
        this._ventilationScale = 7.5;  // calibrated: mean|dV/dt|≈0.18, need vent≈1.35 for CO2=40

        // BPM estimation (for display and stress index only)
        this._estBpm = targetBpm;
        this._lastInspOnsetT = 0;
        this._wasInspiring = false;
        this._lastBreathDetectT = 0;

        // Phase tracking
        this._phaseStartT = 0;
        this._currentPhase = 'expiration';

        // Respiratory arrest override (for "Resp Arrest" button)
        this._respArrest = false;

        // Accumulator for frame-based stepping
        this._accumulator = 0;
    }

    tick(frameDt) {
        // Cap to prevent spiral after tab backgrounding
        const dt = Math.min(frameDt, 0.1);
        this._accumulator += dt;

        const steps = Math.floor(this._accumulator / this.dt);
        this._accumulator -= steps * this.dt;

        for (let i = 0; i < steps; i++) {
            this._step();
        }

        return this._snapshot();
    }

    _step() {
        // ── 1. Hemodynamics (MAP, TPR, coronary, cerebral) ───
        // Uses previous-step CO — 1ms delay is negligible vs 1.5s arterial tau
        stepHemodynamics(
            this.hemoState, this.dt,
            this.heartState.cardiacOutput,
            this.autonomicState.sympatheticTone,
            this.hemoParams
        );

        // ── 2. Cerebral perfusion → CPG drive scaling ────────
        const perf = this.hemoState.cerebralPerfusion;
        const driveScale = this._respArrest ? 0.0
            : perf > 0.5 ? 1.0
            : perf > 0.1 ? (perf - 0.1) / 0.4
            : 0.0;

        // ── 3. Drive interpolation (with perfusion scaling) ──
        const alpha = 1 - Math.exp(-this.dt / this._driveInterpolTau);
        const targetD1 = (BASE_DRIVES.d1 + this._targetDrives.d1_offset) * driveScale;
        const targetD3 = (BASE_DRIVES.d3 + this._targetDrives.d3_offset) * driveScale;
        const targetD5 = (BASE_DRIVES.d5 + this._targetDrives.d5_offset) * driveScale;

        this.cpgParams.d1 += (targetD1 - this.cpgParams.d1) * alpha;
        this.cpgParams.d3 += (targetD3 - this.cpgParams.d3) * alpha;
        this.cpgParams.d5 += (targetD5 - this.cpgParams.d5) * alpha;

        this.cpgParams.d2 = BASE_DRIVES.d2 * driveScale;
        this.cpgParams.d4 = BASE_DRIVES.d4 * driveScale;

        // ── 4. External drives from feedback loops ───────────
        const hbDrives = heringBreuerDrives(this.lungState.y, this.lungParams);
        const chemDrives = chemoCpgDrives(this.chemoState);

        const ext = {};
        for (const d of [hbDrives, chemDrives]) {
            for (const k in d) {
                ext[k] = (ext[k] ?? 0) + d[k];
            }
        }

        for (const k in ext) {
            ext[k] *= driveScale;
        }

        if (this.manualDrive !== 0) {
            ext.drive_1 = (ext.drive_1 ?? 0) + this.manualDrive * driveScale;
        }

        if (this.entrainPulse > 0.01) {
            ext.drive_3 = (ext.drive_3 ?? 0) + this.entrainPulse * this.entrainStrength * driveScale;
            this.entrainPulse *= this.entrainDecay;
        }

        // ── 5. Step CPG (RK4) ────────────────────────────────
        rk4Step(this.cpgState.y, this.dt, this.cpgParams, ext);

        // ── 6. Step lungs (RK4) ──────────────────────────────
        lungRk4Step(this.lungState.y, this.dt, this.cpgState.y, this.lungParams, this.cpgParams);

        const ly = this.lungState.y;
        ly[0] = Math.max(0, Math.min(1, ly[0]));
        ly[1] = Math.max(0, ly[1]);
        ly[2] = Math.max(0, ly[2]);

        // ── 7. Flow-based ventilation estimate ───────────────
        // |dV/dt| smoothed over tau=5s. Naturally decays to zero in apnea.
        const currentVolume = ly[2];
        const dVdt = (currentVolume - this._prevLungVolume) / this.dt;
        this._prevLungVolume = currentVolume;

        const absFlow = Math.abs(dVdt);
        const flowAlpha = 1 - Math.exp(-this.dt / this._flowSmoothTau);
        this._smoothAbsFlow += (absFlow - this._smoothAbsFlow) * flowAlpha;

        const ventilation = this._smoothAbsFlow * this._ventilationScale;

        // ── 8. BPM estimation (display only) ─────────────────
        const f1 = sigmoid(this.cpgState.y[0], this.cpgParams.k_f, this.cpgParams.Vh_f);
        const isInspiring = f1 > 0.4;
        if (isInspiring && !this._wasInspiring) {
            if (this._lastInspOnsetT > 0) {
                const interval = this.t - this._lastInspOnsetT;
                if (interval > 1.0) {
                    const instBpm = 60.0 / interval;
                    this._estBpm += (instBpm - this._estBpm) * 0.3;
                }
            }
            this._lastInspOnsetT = this.t;
            this._lastBreathDetectT = this.t;
        }
        this._wasInspiring = isInspiring;

        // Decay BPM estimate toward 0 if no breaths detected for >15s
        if (this.t - this._lastBreathDetectT > 15.0) {
            this._estBpm *= (1 - this.dt * 0.2);
        }

        // ── 9. Step chemo (CO2 + O2) with V/Q coupling ──────
        const perfusionFactor = Math.min(1.0, this.heartState.cardiacOutput / this.hemoParams.normalCO);
        stepChemo(this.chemoState, this.dt, ventilation, perfusionFactor, this.chemoParams);

        // ── 10. Step autonomic (from MAP) ────────────────────
        stepAutonomic(
            this.autonomicState, this.dt,
            this.chemoState.chemoDrive,
            this.chemoState.pao2,
            this.hemoState.map,
            this.autonomicParams
        );

        // ── 11. Step heart (Frank-Starling, from MAP + ischemia) ──
        const v = ly[2];
        const phase = determinePhase(this.cpgState.y, this.cpgParams);
        const fPostI = sigmoid(this.cpgState.y[2], this.cpgParams.k_f, this.cpgParams.Vh_f);
        stepHeart(
            this.heartState, this.dt, v, phase, this._estBpm,
            f1, fPostI,
            this.autonomicState.sympatheticTone,
            this.autonomicState.vagalModulation,
            this.chemoState.pao2,
            this.hemoState.map,
            this.hemoState.ischemiaFactor,
            this.heartParams
        );

        this.t += this.dt;
        this.stepCount++;

        // Decay breath detection flag
        if (this.breathDetectDecay > 0) {
            this.breathDetectDecay--;
        } else {
            this.breathDetected = false;
        }
    }

    _snapshot() {
        const y = this.cpgState.y;
        const p = this.cpgParams;
        const kf = p.k_f, vf = p.Vh_f;

        const phase = determinePhase(y, p);
        if (phase !== this._currentPhase) {
            this._currentPhase = phase;
            this._phaseStartT = this.t;
        }

        const snap = {
            lung_volume: this.lungState.y[2],
            phase,
            phase_progress: Math.min(1.0, (this.t - this._phaseStartT) / 3.0),
            f_preI: sigmoid(y[0], kf, vf),
            f_earlyI: sigmoid(y[1], kf, vf),
            f_postI: sigmoid(y[2], kf, vf),
            f_augE: sigmoid(y[3], kf, vf),
            f_lateE: sigmoid(y[4], kf, vf),
            ramp_I: this.lungState.y[0],
            breath_detected: this.breathDetected,
            t: this.t,

            // Gas exchange
            pco2: this.chemoState.paco2,
            pao2: this.chemoState.pao2,
            spo2: this.chemoState.spo2,
            chemo_drive: this.chemoState.chemoDrive,

            // Autonomic
            sympathetic_tone: this.autonomicState.sympatheticTone,
            vagal_tone: this.heartState.cvmnActivity,

            // Cardiac
            heart_rate: this.heartState.currentHr,
            rsa_amplitude: this.heartState.rsaAmplitude,
            heartbeat: this.heartState.heartbeat,
            stress_index: this.heartState.stressIndex,
            cardiac_output: this.heartState.cardiacOutput,
            cardiac_rhythm: this.heartState.cardiacRhythm,
            stroke_volume: this.heartState.strokeVolume,

            // Hemodynamics
            map: this.hemoState.map,
            tpr: this.hemoState.tpr,
            coronary_flow: this.hemoState.coronaryFlow,
            ischemia_factor: this.hemoState.ischemiaFactor,
            cerebral_perfusion: this.hemoState.cerebralPerfusion,

            est_bpm: this._estBpm,
        };

        // Consume heartbeat flag
        this.heartState.heartbeat = false;

        return snap;
    }

    applyBreathEvent(event) {
        if (event.kind === 'exhale_start') {
            this.entrainPulse = Math.max(this.entrainPulse, event.strength * 0.5);
            this.breathDetected = true;
            this.breathDetectDecay = Math.floor(0.5 / this.dt);
        }
    }

    setTargetBpm(bpm) {
        this._targetBpm = bpm;
        this._targetDrives = driveProfile(bpm);
    }

    // ── Cardiac event triggers ────────────────────────────────

    triggerHeartAttack(occlusionFraction = 0.7) {
        // Occlude coronary artery → reduced coronary flow → ischemia cascade
        this.hemoState.coronaryOcclusion = occlusionFraction;
    }

    triggerRespArrest() {
        this._respArrest = true;
    }

    resuscitate() {
        this._respArrest = false;
        this.hemoState.coronaryOcclusion = 0.0;  // PCI / thrombolysis
        resuscitateHeart(this.heartState);
    }
}
