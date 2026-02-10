/**
 * Lung mechanics model with Hering-Breuer reflex.
 *
 * State variables:
 *   - ramp_I:  Phrenic motor neuron activity (0-1)
 *   - x_diaph: Diaphragm displacement (0 = resting)
 *   - v_lung:  Lung volume above FRC
 */

import { sigmoid } from './cpg.js';

const NL = 3;
const RAMP_I = 0, X_DIAPH = 1, V_LUNG = 2;

export class LungState {
    constructor(y = null) {
        this.y = y ? new Float64Array(y) : new Float64Array(NL);
    }
}

export function defaultLungParams() {
    return {
        tau_ramp: 0.15,
        g_ramp_exc: 2.0,
        g_ramp_inh: 3.0,
        ramp_leak: 0.5,

        tau_diaph_contract: 0.5,
        tau_diaph_relax: 2.0,
        diaph_gain: 1.0,

        compliance: 1.0,
        resistance: 0.8,

        hb_threshold: 0.85,
        hb_gain_postI: 0.3,
        hb_gain_earlyI: 0.15,
    };
}

export function lungDerivatives(lungY, cpgY, lp, cp, dydt) {
    const rampI = lungY[RAMP_I];
    const xDiaph = lungY[X_DIAPH];
    const vLung = lungY[V_LUNG];

    const fPreI = sigmoid(cpgY[0], cp.k_f, cp.Vh_f);
    const fPostI = sigmoid(cpgY[2], cp.k_f, cp.Vh_f);

    // Ramp-I motor neuron
    let dRamp = (lp.g_ramp_exc * fPreI - lp.g_ramp_inh * fPostI - lp.ramp_leak * rampI) / lp.tau_ramp;
    if (rampI <= 0 && dRamp < 0) dRamp = 0;
    if (rampI >= 1.0 && dRamp > 0) dRamp = 0;
    dydt[RAMP_I] = dRamp;

    // Diaphragm displacement
    const rampOut = Math.max(0, rampI);
    if (rampOut > 0.01) {
        dydt[X_DIAPH] = (lp.diaph_gain * rampOut - xDiaph) / lp.tau_diaph_contract;
    } else {
        dydt[X_DIAPH] = -xDiaph / lp.tau_diaph_relax;
    }

    // Lung volume
    const targetVol = lp.compliance * Math.max(0, xDiaph);
    dydt[V_LUNG] = (targetVol - vLung) / (lp.resistance * lp.compliance + 0.01);

    return dydt;
}

export function heringBreuerDrives(lungY, lp) {
    const psr = Math.max(0, lungY[V_LUNG] - lp.hb_threshold);
    return {
        drive_3: lp.hb_gain_postI * psr,
        drive_2: -lp.hb_gain_earlyI * psr,
    };
}

// Pre-allocated scratch arrays for lung RK4
const _lk1 = new Float64Array(NL);
const _lk2 = new Float64Array(NL);
const _lk3 = new Float64Array(NL);
const _lk4 = new Float64Array(NL);
const _ltmp = new Float64Array(NL);

export function lungRk4Step(lungY, dt, cpgY, lp, cp) {
    lungDerivatives(lungY, cpgY, lp, cp, _lk1);

    for (let i = 0; i < NL; i++) _ltmp[i] = lungY[i] + 0.5 * dt * _lk1[i];
    lungDerivatives(_ltmp, cpgY, lp, cp, _lk2);

    for (let i = 0; i < NL; i++) _ltmp[i] = lungY[i] + 0.5 * dt * _lk2[i];
    lungDerivatives(_ltmp, cpgY, lp, cp, _lk3);

    for (let i = 0; i < NL; i++) _ltmp[i] = lungY[i] + dt * _lk3[i];
    lungDerivatives(_ltmp, cpgY, lp, cp, _lk4);

    const s = dt / 6.0;
    for (let i = 0; i < NL; i++) {
        lungY[i] += s * (_lk1[i] + 2 * _lk2[i] + 2 * _lk3[i] + _lk4[i]);
    }
    return lungY;
}
