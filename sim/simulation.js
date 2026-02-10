/**
 * Simulation orchestrator.
 *
 * Runs the CPG + lung + chemo + autonomic + heart models, driven by
 * requestAnimationFrame from app.js. Returns state snapshots
 * for the renderer.
 *
 * Rate control: breathing rate is modulated by smoothly interpolating
 * tonic drives (d1, d3, d5) toward target values computed by
 * driveProfile(). Biophysical timescales are FIXED.
 *
 * Cerebral perfusion: cardiac output → cerebral blood flow → CPG drive
 * scaling. When perfusion drops, inhibitory populations lose drive first,
 * then pre-I/I fires alone (gasping), then silence (brain death).
 */

import { CPGState, defaultParams, driveProfile, BASE_DRIVES, rk4Step, sigmoid } from './cpg.js';
import { LungState, defaultLungParams, lungRk4Step, heringBreuerDrives } from './lungs.js';
import { ChemoState, defaultChemoParams, stepChemo, chemoCpgDrives } from './chemo.js';
import { AutonomicState, defaultAutonomicParams, stepAutonomic } from './autonomic.js';
import { HeartState, defaultHeartParams, stepHeart, triggerHeartAttack, resuscitateHeart } from './heart.js';

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

        // Ventilation estimation
        this._smoothVolume = 0;
        this._volumeEmaAlpha = 0.0002;
        this._estBpm = targetBpm;
        this._lastInspOnsetT = 0;
        this._wasInspiring = false;

        // Phase tracking
        this._phaseStartT = 0;
        this._currentPhase = 'expiration';

        // Cerebral perfusion (cardiac output → brain blood flow → CPG viability)
        this.cerebralPerfusion = 1.0;    // fraction of normal (0-1)
        this._perfusionTau = 3.0;        // ~3s response to CO changes
        this._normalCO = 5.0;            // normal cardiac output, L/min

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
        // ── 1. Cerebral perfusion → CPG drive scaling ──────────
        const perfTarget = Math.min(1.0, this.heartState.cardiacOutput / this._normalCO);
        const perfAlpha = 1 - Math.exp(-this.dt / this._perfusionTau);
        this.cerebralPerfusion += (perfTarget - this.cerebralPerfusion) * perfAlpha;

        // Drive scaling: linear ramp from 0 at perf=0.1 to 1.0 at perf=0.5
        // Below 0.5: inhibitory pops lose drive → pattern degrades
        // Below 0.1: even INaP bursting fails → flat line
        const perf = this.cerebralPerfusion;
        const driveScale = this._respArrest ? 0.0
            : perf > 0.5 ? 1.0
            : perf > 0.1 ? (perf - 0.1) / 0.4
            : 0.0;

        // ── 2. Drive interpolation (with perfusion scaling) ────
        const alpha = 1 - Math.exp(-this.dt / this._driveInterpolTau);
        const targetD1 = (BASE_DRIVES.d1 + this._targetDrives.d1_offset) * driveScale;
        const targetD3 = (BASE_DRIVES.d3 + this._targetDrives.d3_offset) * driveScale;
        const targetD5 = (BASE_DRIVES.d5 + this._targetDrives.d5_offset) * driveScale;

        this.cpgParams.d1 += (targetD1 - this.cpgParams.d1) * alpha;
        this.cpgParams.d3 += (targetD3 - this.cpgParams.d3) * alpha;
        this.cpgParams.d5 += (targetD5 - this.cpgParams.d5) * alpha;

        // Scale the non-interpolated drives too (d2, d4 are constant normally)
        this.cpgParams.d2 = BASE_DRIVES.d2 * driveScale;
        this.cpgParams.d4 = BASE_DRIVES.d4 * driveScale;

        // ── 3. Gather external drives from feedback loops ──────
        const hbDrives = heringBreuerDrives(this.lungState.y, this.lungParams);
        const chemDrives = chemoCpgDrives(this.chemoState);

        const ext = {};
        for (const d of [hbDrives, chemDrives]) {
            for (const k in d) {
                ext[k] = (ext[k] ?? 0) + d[k];
            }
        }

        // Scale external drives by perfusion too
        for (const k in ext) {
            ext[k] *= driveScale;
        }

        // Add manual drive (hyper/hypoventilation)
        if (this.manualDrive !== 0) {
            ext.drive_1 = (ext.drive_1 ?? 0) + this.manualDrive * driveScale;
        }

        // Entrainment pulse → post-I drive (d3) to reinforce expiratory transition
        if (this.entrainPulse > 0.01) {
            ext.drive_3 = (ext.drive_3 ?? 0) + this.entrainPulse * this.entrainStrength * driveScale;
            this.entrainPulse *= this.entrainDecay;
        }

        // ── 4. Step CPG (RK4) ─────────────────────────────────
        rk4Step(this.cpgState.y, this.dt, this.cpgParams, ext);

        // ── 5. Step lungs (RK4) ───────────────────────────────
        lungRk4Step(this.lungState.y, this.dt, this.cpgState.y, this.lungParams, this.cpgParams);

        // Clamp lung state
        const ly = this.lungState.y;
        ly[0] = Math.max(0, Math.min(1, ly[0]));  // ramp_I
        ly[1] = Math.max(0, ly[1]);                // x_diaph
        ly[2] = Math.max(0, ly[2]);                // v_lung

        // ── 6. Detect inspiration onset → estimate BPM ───────
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
        }
        this._wasInspiring = isInspiring;

        // Smoothed ventilation EMA
        const v = ly[2];
        this._smoothVolume += (v - this._smoothVolume) * this._volumeEmaAlpha;

        // ── 7. Step chemo model (CO2 + O2) ────────────────────
        const ventilation = this._smoothVolume * (this._estBpm / 4.0);
        stepChemo(this.chemoState, this.dt, ventilation, this.chemoParams);

        // ── 8. Step autonomic model ───────────────────────────
        stepAutonomic(
            this.autonomicState, this.dt,
            this.chemoState.chemoDrive,
            this.chemoState.pao2,
            this.heartState.cardiacOutput,
            this.autonomicParams
        );

        // ── 9. Step heart model ───────────────────────────────
        const phase = determinePhase(this.cpgState.y, this.cpgParams);
        const fPostI = sigmoid(this.cpgState.y[2], this.cpgParams.k_f, this.cpgParams.Vh_f);
        stepHeart(
            this.heartState, this.dt, v, phase, this._estBpm,
            f1, fPostI,
            this.autonomicState.sympatheticTone,
            this.autonomicState.vagalModulation,
            this.chemoState.pao2,
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

            // Perfusion
            cerebral_perfusion: this.cerebralPerfusion,

            est_bpm: this._estBpm,
        };

        // Consume heartbeat flag
        this.heartState.heartbeat = false;

        return snap;
    }

    applyBreathEvent(event) {
        if (event.kind === 'exhale_start') {
            // Boost post-I drive to reinforce expiratory phase transition
            this.entrainPulse = Math.max(this.entrainPulse, event.strength * 0.5);
            this.breathDetected = true;
            this.breathDetectDecay = Math.floor(0.5 / this.dt);  // 500ms
        }
    }

    setTargetBpm(bpm) {
        // Smoothly interpolate drives — does NOT recreate params
        this._targetBpm = bpm;
        this._targetDrives = driveProfile(bpm);
    }

    // ── Cardiac event triggers ────────────────────────────────

    triggerHeartAttack(severity = 0.3) {
        triggerHeartAttack(this.heartState, severity);
    }

    triggerRespArrest() {
        this._respArrest = true;
    }

    resuscitate() {
        this._respArrest = false;
        resuscitateHeart(this.heartState);
        // Restore cerebral perfusion target will follow naturally from CO recovery
    }
}
