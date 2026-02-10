/**
 * Hemodynamic model — arterial pressure, peripheral resistance,
 * coronary perfusion, and cerebral autoregulation.
 *
 * Core equation: MAP = CO × TPR  (Guyton & Hall Ch. 14)
 *
 * Arterial pressure is smoothed by compliance (Windkessel RC).
 * TPR is modulated by sympathetic vasoconstriction.
 *
 * Coronary circulation: flow depends on diastolic BP minus LVEDP.
 * When coronary flow drops below threshold, ischemia develops —
 * creating a positive feedback loop (low CO → low MAP → low
 * coronary flow → more ischemia → lower CO).
 *
 * Cerebral autoregulation (Guyton Ch. 62): CBF is constant at
 * MAP 50–150 mmHg, then drops linearly to zero at MAP 20.
 */

export class HemodynamicsState {
    constructor() {
        this.map = 93.0;              // Mean arterial pressure, mmHg
        this.tpr = 18.6;             // Total peripheral resistance, mmHg·min/L
        this.coronaryFlow = 250.0;    // mL/min
        this.coronaryOcclusion = 0.0; // 0.0 = patent, 0.9 = 90% occluded
        this.ischemiaFactor = 1.0;    // 0 = dead myocardium, 1 = healthy
        this.cerebralPerfusion = 1.0; // fraction of normal (0–1)
    }
}

export function defaultHemodynamicsParams() {
    return {
        // ── Arterial compliance dynamics ────────────────────
        tauArterial: 1.5,             // s, pressure smoothing (Windkessel RC)

        // ── Total peripheral resistance ─────────────────────
        baseTpr: 15.0,                // mmHg·min/L (without sympathetic tone)
        vasoGain: 0.5,               // sympathetic vasoconstriction: ↑TPR ~50%
        tauTpr: 5.0,                 // s, TPR adjustment time constant

        // ── Coronary circulation ────────────────────────────
        // Coronary flow ≈ (diastolicBP − LVEDP) / resistance
        // Normal: (93×0.75 − 8) / 0.25 = 246 mL/min
        baseCoronaryResistance: 0.25, // mmHg·min/mL
        lvedp: 8.0,                  // mmHg, LV end-diastolic pressure
        normalCoronaryFlow: 250.0,   // mL/min reference

        // Ischemia dynamics
        coronaryFlowThreshold: 0.4,  // fraction of normal below which ischemia worsens
        ischemiaProgressTau: 8.0,    // s, ischemia development when flow inadequate
        ischemiaRecoveryTau: 30.0,   // s, slow myocardial recovery when reperfused

        // ── Cerebral autoregulation (Guyton Ch. 62) ─────────
        // CBF is autoregulated at MAP 50–150 mmHg (constant perfusion).
        // Below 50: pressure-passive, linearly declining.
        // Below 20: CBF ≈ 0 → brain death.
        cerebralAutoregLow: 50.0,    // mmHg, lower limit of plateau
        cerebralAutoregHigh: 150.0,  // mmHg, upper limit of plateau
        cerebralFailureMap: 20.0,    // mmHg, zero CBF threshold
        tauCerebral: 3.0,           // s, cerebral perfusion response time

        // ── Reference values ────────────────────────────────
        normalCO: 5.0,              // L/min
    };
}

/**
 * Step the hemodynamic model.
 *
 * @param {HemodynamicsState} state
 * @param {number} dt - timestep, s
 * @param {number} cardiacOutput - L/min (from heart model, previous step)
 * @param {number} sympatheticTone - 0–1 (from autonomic model)
 * @param {object} p - hemodynamics params
 */
export function stepHemodynamics(state, dt, cardiacOutput, sympatheticTone, p) {
    // ── TPR: sympathetic vasoconstriction ──────────────────
    const tprTarget = p.baseTpr * (1 + p.vasoGain * sympatheticTone);
    const tprAlpha = 1 - Math.exp(-dt / p.tauTpr);
    state.tpr += (tprTarget - state.tpr) * tprAlpha;

    // ── MAP: arterial compliance dynamics ──────────────────
    // Windkessel: MAP tracks toward CO × TPR with arterial RC time constant
    const mapTarget = cardiacOutput * state.tpr;
    const mapAlpha = 1 - Math.exp(-dt / p.tauArterial);
    state.map += (mapTarget - state.map) * mapAlpha;
    state.map = Math.max(0, state.map);

    // ── Coronary perfusion ─────────────────────────────────
    // Diastolic BP ≈ MAP × 0.75 (MAP − pulse_pressure/3)
    const diastolicBp = state.map * 0.75;
    const coronaryPerfusionPressure = Math.max(0, diastolicBp - p.lvedp);
    // Occlusion increases effective resistance
    const effectiveResistance = p.baseCoronaryResistance /
        Math.max(0.01, 1.0 - state.coronaryOcclusion);
    state.coronaryFlow = coronaryPerfusionPressure / effectiveResistance;

    // ── Ischemia from coronary flow ────────────────────────
    const coronaryFraction = Math.min(1.0, state.coronaryFlow / p.normalCoronaryFlow);
    if (coronaryFraction < p.coronaryFlowThreshold) {
        // Flow below threshold: ischemia progresses
        const ischemiaTarget = coronaryFraction / p.coronaryFlowThreshold;
        const ischAlpha = 1 - Math.exp(-dt / p.ischemiaProgressTau);
        state.ischemiaFactor += (ischemiaTarget - state.ischemiaFactor) * ischAlpha;
    } else {
        // Flow adequate: slow recovery
        const recovAlpha = 1 - Math.exp(-dt / p.ischemiaRecoveryTau);
        state.ischemiaFactor += (1.0 - state.ischemiaFactor) * recovAlpha;
    }
    state.ischemiaFactor = Math.max(0, Math.min(1, state.ischemiaFactor));

    // ── Cerebral autoregulation ────────────────────────────
    // Autoregulated plateau at MAP 50–150, linear ramp 20–50, zero below 20
    let cerebralTarget;
    if (state.map >= p.cerebralAutoregHigh) {
        cerebralTarget = 1.0;
    } else if (state.map >= p.cerebralAutoregLow) {
        cerebralTarget = 1.0;
    } else if (state.map > p.cerebralFailureMap) {
        cerebralTarget = (state.map - p.cerebralFailureMap) /
            (p.cerebralAutoregLow - p.cerebralFailureMap);
    } else {
        cerebralTarget = 0.0;
    }
    const cerebralAlpha = 1 - Math.exp(-dt / p.tauCerebral);
    state.cerebralPerfusion += (cerebralTarget - state.cerebralPerfusion) * cerebralAlpha;
    state.cerebralPerfusion = Math.max(0, Math.min(1, state.cerebralPerfusion));
}
