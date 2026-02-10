/**
 * Simulation orchestrator.
 *
 * Runs the CPG + lung + chemo + heart models, driven by
 * requestAnimationFrame from app.js. Returns state snapshots
 * for the renderer.
 */

import { CPGState, defaultParams, rk4Step, sigmoid } from './cpg.js';
import { LungState, defaultLungParams, lungRk4Step, heringBreuerDrives } from './lungs.js';
import { ChemoState, defaultChemoParams, stepChemo, chemoCpgDrives } from './chemo.js';
import { HeartState, defaultHeartParams, stepHeart } from './heart.js';

function determinePhase(cpgY, cpgP) {
    const f1 = sigmoid(cpgY[0], cpgP.k_f, cpgP.Vh_f);
    const f3 = sigmoid(cpgY[2], cpgP.k_f, cpgP.Vh_f);
    if (f1 > 0.4) return 'inspiration';
    if (f3 > 0.4) return 'post-inspiration';
    return 'expiration';
}

export class Simulation {
    constructor(targetBpm = 4.0) {
        this.dt = 0.001;

        // Models
        this.cpgParams = defaultParams(targetBpm);
        this.lungParams = defaultLungParams();
        this.cpgState = new CPGState();
        this.lungState = new LungState();
        this.chemoState = new ChemoState();
        this.chemoParams = defaultChemoParams();
        this.heartState = new HeartState();
        this.heartParams = defaultHeartParams();

        // Time
        this.t = 0;
        this.stepCount = 0;

        // Entrainment
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
        // Gather external drives
        const hbDrives = heringBreuerDrives(this.lungState.y, this.lungParams);
        const chemDrives = chemoCpgDrives(this.chemoState);

        const ext = {};
        for (const d of [hbDrives, chemDrives]) {
            for (const k in d) {
                ext[k] = (ext[k] ?? 0) + d[k];
            }
        }

        // Add entrainment pulse to pre-I/I drive
        if (this.entrainPulse > 0.01) {
            ext.drive_1 = (ext.drive_1 ?? 0) + this.entrainPulse * this.entrainStrength;
            this.entrainPulse *= this.entrainDecay;
        }

        // Step CPG (RK4, mutates in place)
        rk4Step(this.cpgState.y, this.dt, this.cpgParams, ext);

        // Step lungs (RK4, mutates in place)
        lungRk4Step(this.lungState.y, this.dt, this.cpgState.y, this.lungParams, this.cpgParams);

        // Clamp lung state
        const ly = this.lungState.y;
        ly[0] = Math.max(0, Math.min(1, ly[0]));  // ramp_I
        ly[1] = Math.max(0, ly[1]);                // x_diaph
        ly[2] = Math.max(0, ly[2]);                // v_lung

        // Detect inspiration onset -> estimate BPM
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

        // Step chemo model
        const ventilation = this._smoothVolume * (this._estBpm / 4.0);
        stepChemo(this.chemoState, this.dt, ventilation, this.chemoParams);

        // Step heart model
        const phase = determinePhase(this.cpgState.y, this.cpgParams);
        stepHeart(this.heartState, this.dt, v, phase, this._estBpm, this.heartParams);

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
            pco2: this.chemoState.pco2,
            chemo_drive: this.chemoState.chemoDrive,
            heart_rate: this.heartState.currentHr,
            rsa_amplitude: this.heartState.rsaAmplitude,
            heartbeat: this.heartState.heartbeat,
            stress_index: this.heartState.stressIndex,
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
            this.breathDetectDecay = Math.floor(0.5 / this.dt);  // 500ms
        }
    }

    setTargetBpm(bpm) {
        this.cpgParams = defaultParams(bpm);
    }
}
