/**
 * Autonomic nervous system integration.
 *
 * Computes sympathetic and parasympathetic (vagal) efferent tones from
 * afferent inputs: chemoreceptors, baroreceptors, and hypoxic reflexes.
 *
 * Sympathetic output:
 *   - Tonic baseline (~0.3)
 *   - Excited by chemoreceptors (hypoxia + hypercapnia via NTS → RVLM)
 *   - Inhibited by baroreceptors (high MAP → less sympathetic)
 *   → Heart: positive chronotropic (↑HR) + inotropic (↑SV)
 *   → Vasculature: vasoconstriction (↑TPR) via hemodynamics.js
 *
 * Vagal modulation:
 *   - Baroreflex: high MAP → more vagal tone (Guyton Ch. 18)
 *   - Hypoxic vagal surge: PaO2 < 30 mmHg → massive vagal activation
 *     → terminal bradycardia preceding asystole (Bezold-Jarisch-like)
 *   → Adjusts CVMN tonic drive (d_vagal)
 *
 * Baroreceptors sense MAP (mean arterial pressure), not cardiac output.
 * This is critical: sympathetic vasoconstriction raises TPR → MAP, which
 * the baroreflex reads as "pressure restored", completing the loop.
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

        // Baroreflex from MAP (Guyton Ch. 18)
        // Baroreceptors in carotid sinus sense wall tension ∝ MAP.
        // High MAP → inhibit sympathetic, excite vagal.
        // Low MAP → excite sympathetic, inhibit vagal.
        // Gain calibrated: 37 mmHg drop (CO 5→3, MAP 93→56) gives
        // sympathetic boost of ~0.6, matching old CO-based model.
        baroGain: 0.016,              // per mmHg deviation from setpoint
        baroSetpoint: 93.0,           // mmHg, normal MAP
        tauBaro: 2.0,                 // baroreflex time constant, s

        // Vagal modulation from baroreflex
        baroVagalGain: 0.004,         // d_vagal adjustment per mmHg deviation

        // Hypoxic vagal surge (terminal)
        // Severe hypoxia → direct vagal activation → profound bradycardia
        hypoxicVagalThreshold: 30.0,  // PaO2 mmHg below which surge activates
        hypoxicVagalGain: 1.5,        // max vagal drive increase

        // Smoothing
        tauSympathetic: 3.0,          // sympathetic response time, s
        tauVagalMod: 2.0,             // vagal modulation response time, s
    };
}

/**
 * @param {AutonomicState} state
 * @param {number} dt - timestep, s
 * @param {number} chemoDrive - total chemoreceptor drive (CO2 + O2)
 * @param {number} pao2 - arterial PO2, mmHg
 * @param {number} map - mean arterial pressure, mmHg
 * @param {object} p - autonomic params
 */
export function stepAutonomic(state, dt, chemoDrive, pao2, map, p) {
    // ── Sympathetic tone ──────────────────────────────
    // Excited by chemoreceptors, inhibited by baroreceptors (MAP)
    const mapDeviation = map - p.baroSetpoint;
    const sympatheticTarget = Math.max(0, Math.min(1,
        p.baseSympathetic
        + p.chemoSympatheticGain * chemoDrive        // chemoreflex excitation
        - p.baroGain * mapDeviation                  // baroreflex inhibition
    ));

    const alphaSym = 1 - Math.exp(-dt / p.tauSympathetic);
    state.sympatheticTone += (sympatheticTarget - state.sympatheticTone) * alphaSym;

    // ── Vagal modulation ──────────────────────────────
    // Baroreflex: high MAP → increase vagal tone (via NTS → NA pathway)
    const baroVagal = p.baroVagalGain * mapDeviation;

    // Hypoxic vagal surge: severe hypoxia → massive vagal activation
    let hypoxicVagal = 0;
    if (pao2 < p.hypoxicVagalThreshold) {
        const frac = (p.hypoxicVagalThreshold - pao2) / p.hypoxicVagalThreshold;
        hypoxicVagal = p.hypoxicVagalGain * frac * frac;
    }

    const vagalTarget = baroVagal + hypoxicVagal;
    const alphaVag = 1 - Math.exp(-dt / p.tauVagalMod);
    state.vagalModulation += (vagalTarget - state.vagalModulation) * alphaVag;
}
