/**
 * Brainstem respiratory CPG model.
 *
 * Activity-based model after Molkov et al. (2017) / Rubin et al. (2011).
 * Five neural populations with 10 coupled ODEs producing a three-phase
 * respiratory rhythm (inspiration -> post-inspiration -> late expiration).
 *
 * Populations:
 *   1. pre-I/I   (excitatory, pre-BotC) — INaP bursting
 *   2. early-I   (inhibitory, pre-BotC) — adaptation
 *   3. post-I    (inhibitory, BotC)     — adaptation
 *   4. aug-E     (inhibitory, BotC)     — adaptation
 *   5. late-E    (excitatory, RTN/pFRG) — INaP bursting
 *
 * State vector [10]:
 *   V1, V2, V3, V4, V5, hNaP1, hNaP5, mAD2, mAD3, mAD4
 *
 * Uses current-based synaptic formulation.
 */

const N = 10;

// State indices
const V1 = 0, V2 = 1, V3 = 2, V4 = 3, V5 = 4;
const H1 = 5, H5 = 6;
const M2 = 7, M3 = 8, M4 = 9;

export function sigmoid(V, k = 10.0, Vhalf = 0.0) {
    const x = Math.max(-50, Math.min(50, k * (V - Vhalf)));
    return 1.0 / (1.0 + Math.exp(-x));
}

/**
 * Default CPG parameters with FIXED biophysical timescales.
 *
 * Time constants are intrinsic membrane properties (Rubin et al. 2011,
 * J Comput Neurosci 30:607-632) — they do NOT change with breathing rate.
 * Rate modulation works through tonic drives d1–d5 (Molkov et al. 2017).
 */
export function defaultParams() {
    return {
        tau_m: 0.02,          // membrane time constant, 20ms (fast)

        // Tonic drives — baseline for ~4 BPM eupnea
        d1: 0.0, d2: -0.3, d3: 0.3, d4: 0.15, d5: -0.5,

        // INaP inactivation — FIXED biophysical (pops 1, 5)
        g_NaP1: 3.0, g_NaP5: 2.5,
        k_hNaP: -10.0, Vh_hNaP: -0.2,
        tau_hNaP: 9.0,        // INaP inactivation, ~9s

        // Adaptation — FIXED biophysical (pops 2, 3, 4)
        g_AD2: 4.0, g_AD3: 3.5, g_AD4: 3.0,
        k_mAD: 6.0, Vh_mAD: 0.1,
        tau_AD2: 7.0,         // early-I adaptation, ~7s
        tau_AD3: 11.0,        // post-I adaptation, ~11s
        tau_AD4: 14.0,        // aug-E adaptation, ~14s

        // Synaptic weights
        w_21: 1.2,                          // pre-I/I -> early-I (exc)
        w_32: -2.0, w_42: -1.5, w_52: -1.0, // early-I -> (inh)
        w_13: -2.5, w_23: -1.5, w_43: -2.0, w_53: -0.8, // post-I -> (inh)
        w_14: -1.5, w_24: -1.0, w_34: -2.5, w_54: -0.5, // aug-E -> (inh)
        w_15: 0.5,                          // late-E -> pre-I/I (exc)

        // Firing rate sigmoid
        k_f: 8.0, Vh_f: 0.0,
    };
}

/**
 * Baseline tonic drives (for drive interpolation).
 * Separated from defaultParams so simulation can interpolate toward targets.
 */
export const BASE_DRIVES = { d1: 0.0, d2: -0.3, d3: 0.3, d4: 0.15, d5: -0.5 };

/**
 * Compute drive offsets for a target breathing rate.
 *
 * Per Molkov et al. (2017): rate is controlled by adjusting external
 * excitatory drives, not timescales. Increasing d1 (pre-I/I) strengthens
 * inspiration; decreasing d3 (post-I) shortens the post-inspiratory
 * pause; increasing d5 (late-E) recruits active expiration at high rates.
 *
 * @param {number} targetBpm - desired breaths per minute
 * @returns {{ d1_offset: number, d3_offset: number, d5_offset: number }}
 */
export function driveProfile(targetBpm) {
    const ratio = targetBpm / 4.0;
    return {
        d1_offset: (ratio - 1.0) * 0.4,
        d3_offset: (1.0 - ratio) * 0.2,
        d5_offset: Math.max(0, ratio - 2.0) * 0.3,
    };
}

export class CPGState {
    constructor(y = null) {
        if (y) {
            this.y = new Float64Array(y);
        } else {
            this.y = new Float64Array([
                -0.5,   // V1: pre-I/I (inactive)
                -0.5,   // V2: early-I (inactive)
                -0.5,   // V3: post-I (inactive)
                 0.3,   // V4: aug-E (active, about to exhaust)
                -0.5,   // V5: late-E (inactive)
                 0.95,  // hNaP1: fully de-inactivated
                 0.95,  // hNaP5: fully de-inactivated
                 0.02,  // mAD2: low
                 0.02,  // mAD3: low
                 0.6,   // mAD4: high (aug-E about to adapt)
            ]);
        }
    }
}

// Element-wise: out[i] = a[i] + s * b[i]
function addScaled(out, a, s, b) {
    for (let i = 0; i < N; i++) out[i] = a[i] + s * b[i];
    return out;
}

export function cpgDerivatives(y, p, ext, dydt) {
    const v1 = y[V1], v2 = y[V2], v3 = y[V3], v4 = y[V4], v5 = y[V5];
    const h1 = y[H1], h5 = y[H5];
    const m2 = y[M2], m3 = y[M3], m4 = y[M4];

    // Firing rates
    const kf = p.k_f, vf = p.Vh_f;
    const f1 = sigmoid(v1, kf, vf);
    const f2 = sigmoid(v2, kf, vf);
    const f3 = sigmoid(v3, kf, vf);
    const f4 = sigmoid(v4, kf, vf);
    const f5 = sigmoid(v5, kf, vf);

    // INaP: I = g * sigmoid(V) * h
    const iNaP1 = p.g_NaP1 * sigmoid(v1, 10.0, -0.1) * h1;
    const iNaP5 = p.g_NaP5 * sigmoid(v5, 10.0, -0.1) * h5;

    // Synaptic currents (current-based)
    const iSyn1 = p.w_13 * f3 + p.w_14 * f4 + p.w_15 * f5;
    const iSyn2 = p.w_21 * f1 + p.w_23 * f3 + p.w_24 * f4;
    const iSyn3 = p.w_32 * f2 + p.w_34 * f4;
    const iSyn4 = p.w_42 * f2 + p.w_43 * f3;
    const iSyn5 = p.w_52 * f2 + p.w_53 * f3 + p.w_54 * f4;

    // External drives
    const ext1 = p.d1 + (ext.drive_1 ?? 0);
    const ext2 = p.d2 + (ext.drive_2 ?? 0);
    const ext3 = p.d3 + (ext.drive_3 ?? 0);
    const ext4 = p.d4 + (ext.drive_4 ?? 0);
    const ext5 = p.d5 + (ext.drive_5 ?? 0);

    // Voltage dynamics
    const tau = p.tau_m;
    dydt[V1] = (-v1 + iNaP1           + iSyn1 + ext1) / tau;
    dydt[V2] = (-v2 - p.g_AD2 * m2    + iSyn2 + ext2) / tau;
    dydt[V3] = (-v3 - p.g_AD3 * m3    + iSyn3 + ext3) / tau;
    dydt[V4] = (-v4 - p.g_AD4 * m4    + iSyn4 + ext4) / tau;
    dydt[V5] = (-v5 + iNaP5           + iSyn5 + ext5) / tau;

    // h_NaP inactivation
    const hInf1 = sigmoid(v1, p.k_hNaP, p.Vh_hNaP);
    const hInf5 = sigmoid(v5, p.k_hNaP, p.Vh_hNaP);
    dydt[H1] = (hInf1 - h1) / p.tau_hNaP;
    dydt[H5] = (hInf5 - h5) / p.tau_hNaP;

    // m_AD adaptation
    const mInf2 = sigmoid(v2, p.k_mAD, p.Vh_mAD);
    const mInf3 = sigmoid(v3, p.k_mAD, p.Vh_mAD);
    const mInf4 = sigmoid(v4, p.k_mAD, p.Vh_mAD);
    dydt[M2] = (mInf2 - m2) / p.tau_AD2;
    dydt[M3] = (mInf3 - m3) / p.tau_AD3;
    dydt[M4] = (mInf4 - m4) / p.tau_AD4;

    return dydt;
}

// Pre-allocated scratch arrays for RK4
const _k1 = new Float64Array(N);
const _k2 = new Float64Array(N);
const _k3 = new Float64Array(N);
const _k4 = new Float64Array(N);
const _tmp = new Float64Array(N);

const _emptyExt = {};

export function rk4Step(y, dt, p, ext) {
    const e = ext ?? _emptyExt;
    cpgDerivatives(y, p, e, _k1);

    addScaled(_tmp, y, 0.5 * dt, _k1);
    cpgDerivatives(_tmp, p, e, _k2);

    addScaled(_tmp, y, 0.5 * dt, _k2);
    cpgDerivatives(_tmp, p, e, _k3);

    addScaled(_tmp, y, dt, _k3);
    cpgDerivatives(_tmp, p, e, _k4);

    // y_new = y + (dt/6) * (k1 + 2*k2 + 2*k3 + k4)
    const s = dt / 6.0;
    for (let i = 0; i < N; i++) {
        y[i] += s * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
    }
    return y;
}
