/**
 * Autonomic nervous system integration.
 *
 * Computes sympathetic and parasympathetic (vagal) efferent tones from
 * afferent inputs: chemoreceptors, baroreceptors, and hypoxic reflexes.
 *
 * Sympathetic output:
 *   - Tonic baseline (~0.3)
 *   - Excited by chemoreceptors (hypoxia + hypercapnia)
 *   - Inhibited by baroreceptors (high cardiac output → less sympathetic)
 *   → Heart: positive chronotropic (↑HR) + inotropic (↑SV)
 *
 * Vagal modulation:
 *   - Baroreflex: high CO → more vagal tone
 *   - Hypoxic vagal surge: PaO2 < 30 mmHg → massive vagal activation
 *     → terminal bradycardia preceding asystole (Bezold-Jarisch-like)
 *   → Adjusts CVMN tonic drive (d_vagal)
 *
 * The CVMN itself (with CPG-driven RSA) lives in heart.js.
 * This module provides the slower autonomic modulation on top.
 */

export class AutonomicState {
    constructor() {
        this.sympatheticTone = 0.3;   // sympathetic efferent activity (0-1)
        this.vagalModulation = 0.0;    // adjustment to CVMN tonic drive (d_vagal)
    }
}

export function defaultAutonomicParams() {
    return {
        // Baseline sympathetic tone (resting)
        baseSympathetic: 0.3,

        // Chemoreflex → sympathetic excitation
        // Both hypoxia and hypercapnia activate sympathetic via NTS → RVLM
        chemoSympatheticGain: 0.4,

        // Baroreflex (cardiac output as pressure proxy)
        // High CO → baroreceptor activation → inhibit sympathetic, excite vagal
        // Low CO → baroreceptor unloading → excite sympathetic, inhibit vagal
        baroGain: 0.3,
        baroSetpoint: 5.0,        // normal cardiac output, L/min
        tauBaro: 2.0,             // baroreflex time constant, s

        // Vagal modulation from baroreflex
        baroVagalGain: 0.15,      // d_vagal adjustment per L/min deviation

        // Hypoxic vagal surge (terminal)
        // Severe hypoxia → direct vagal activation → profound bradycardia
        // This is the pathway from hypoxia → asystole
        hypoxicVagalThreshold: 30.0,  // PaO2 mmHg below which surge activates
        hypoxicVagalGain: 1.5,        // max vagal drive increase

        // Smoothing
        tauSympathetic: 3.0,      // sympathetic response time, s
        tauVagalMod: 2.0,         // vagal modulation response time, s
    };
}

/**
 * @param {AutonomicState} state
 * @param {number} dt - timestep, s
 * @param {number} chemoDrive - total chemoreceptor drive (CO2 + O2)
 * @param {number} pao2 - arterial PO2, mmHg
 * @param {number} cardiacOutput - cardiac output, L/min
 * @param {object} p - autonomic params
 */
export function stepAutonomic(state, dt, chemoDrive, pao2, cardiacOutput, p) {
    // ── Sympathetic tone ──────────────────────────────
    // Excited by chemoreceptors, inhibited by baroreceptors
    const coDeviation = cardiacOutput - p.baroSetpoint;
    const sympatheticTarget = Math.max(0, Math.min(1,
        p.baseSympathetic
        + p.chemoSympatheticGain * chemoDrive        // chemoreflex excitation
        - p.baroGain * coDeviation                   // baroreflex inhibition
    ));

    const alphaSym = 1 - Math.exp(-dt / p.tauSympathetic);
    state.sympatheticTone += (sympatheticTarget - state.sympatheticTone) * alphaSym;

    // ── Vagal modulation ──────────────────────────────
    // Baroreflex: high CO → increase vagal tone (via NTS → NA pathway)
    const baroVagal = p.baroVagalGain * coDeviation;

    // Hypoxic vagal surge: severe hypoxia → massive vagal activation
    // Smooth onset below threshold using quadratic ramp
    let hypoxicVagal = 0;
    if (pao2 < p.hypoxicVagalThreshold) {
        const frac = (p.hypoxicVagalThreshold - pao2) / p.hypoxicVagalThreshold;
        hypoxicVagal = p.hypoxicVagalGain * frac * frac;
    }

    const vagalTarget = baroVagal + hypoxicVagal;
    const alphaVag = 1 - Math.exp(-dt / p.tauVagalMod);
    state.vagalModulation += (vagalTarget - state.vagalModulation) * alphaVag;
}
