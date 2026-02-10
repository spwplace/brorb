/**
 * Gas exchange and chemoreceptor feedback model.
 *
 * Tracks arterial PaCO2 and PaO2 (mmHg). Both rise/fall with metabolism
 * and are restored by alveolar ventilation. Two chemoreceptor populations
 * drive the CPG:
 *
 *   Central (medullary RTN): slow (tau ~60s), responds to brain tissue CO2.
 *     Routes → d1 (inspiratory) + d5 (active expiration).
 *
 *   Peripheral (carotid body): fast (tau ~5s), responds to arterial PaCO2
 *     AND PaO2. Hypoxic response has a "hockey stick" shape — minimal
 *     drive above PaO2 ~80, steep rise below ~60 (Marshall 1994).
 *     Routes → d1 (inspiratory, fast modulation).
 *
 * Normal PaCO2 ~40 mmHg, PaO2 ~100 mmHg. Apneic threshold ~35 mmHg CO2.
 *
 * SpO2 computed from PaO2 via the Hill equation (Severinghaus 1979):
 *   SaO2 = PaO2^n / (PaO2^n + P50^n),  P50 = 26.8, n = 2.7
 */

export class ChemoState {
    constructor() {
        this.paco2 = 40.0;          // arterial CO2, mmHg
        this.paco2Central = 40.0;   // brain tissue CO2 (lags arterial)
        this.pao2 = 100.0;          // arterial O2, mmHg
        this.spo2 = 0.98;           // pulse oximetry (≈ SaO2)
        this.chemoDrive = 0.0;      // total chemoreceptor output
        this.centralDrive = 0.0;
        this.peripheralDrive = 0.0;
        this.hypoxicDrive = 0.0;    // peripheral O2-sensitive component
    }
}

export function defaultChemoParams() {
    return {
        // ── CO2 ──────────────────────────────────────
        // Metabolic CO2 production (mmHg/s at rest)
        // Calibrated so PaCO2 ~40 mmHg at eupneic ventilation (~6-7 BPM)
        co2Production: 0.65,

        // Clearance coefficient: dPaCO2/dt -= clearance * ventilation * PaCO2
        co2Clearance: 0.012,

        // Central chemoreception (medullary RTN, slow)
        tauCentral: 60.0,           // brain tissue equilibration, s
        gainCentral: 0.04,          // drive per mmHg above threshold
        threshCentral: 35.0,        // mmHg (apneic threshold)

        // Peripheral chemoreception — CO2 component (carotid body, fast)
        tauPeripheral: 5.0,         // fast response, s
        gainPeripheral: 0.02,       // drive per mmHg above threshold
        threshPeripheral: 35.0,     // mmHg

        // ── O2 ───────────────────────────────────────
        // Metabolic O2 consumption (mmHg/s at rest)
        o2Consumption: 0.4,

        // Clearance: dPaO2/dt += clearance * ventilation * (alveolarPo2 - PaO2)
        o2Clearance: 0.008,

        // Inspired PO2 at sea level (after water vapor subtraction)
        alveolarPo2: 150.0,

        // Oxyhemoglobin dissociation (Hill equation)
        p50: 26.8,                  // mmHg (Severinghaus 1979)
        hillN: 2.7,                 // cooperativity coefficient

        // Peripheral chemoreception — O2 component (carotid body)
        // "Hockey stick": minimal drive above 80 mmHg, steep below 60
        gainHypoxic: 0.8,           // max hypoxic drive contribution
        hypoxicKnee: 80.0,          // PaO2 below which hypoxic drive activates

        // Output saturation
        chemoSaturation: 1.5,
    };
}

/**
 * Oxyhemoglobin dissociation curve (Hill equation).
 * @param {number} pao2 - arterial PO2, mmHg
 * @param {number} p50 - half-saturation PO2, mmHg
 * @param {number} n - Hill coefficient
 * @returns {number} SaO2 (0-1)
 */
function hillSaturation(pao2, p50, n) {
    if (pao2 <= 0) return 0;
    const pn = Math.pow(pao2, n);
    const p50n = Math.pow(p50, n);
    return pn / (pn + p50n);
}

export function stepChemo(state, dt, ventilation, perfusionFactor, p) {
    // V/Q coupling: effective gas exchange requires both ventilation AND
    // pulmonary blood flow. perfusionFactor = min(1, CO / normalCO).
    const effectiveExchange = ventilation * perfusionFactor;

    // ── CO2 dynamics ──────────────────────────────────
    const dpaco2 = p.co2Production - p.co2Clearance * effectiveExchange * state.paco2;
    state.paco2 = Math.max(0, state.paco2 + dpaco2 * dt);

    // Central: brain tissue CO2 tracks arterial with slow time constant
    const alphaC = 1 - Math.exp(-dt / p.tauCentral);
    state.paco2Central += (state.paco2 - state.paco2Central) * alphaC;

    // Central chemoreceptor drive (RTN)
    const centralRaw = Math.max(0, state.paco2Central - p.threshCentral) * p.gainCentral;
    state.centralDrive = Math.min(centralRaw, p.chemoSaturation);

    // Peripheral chemoreceptor drive — CO2 component (carotid body)
    const periCo2Raw = Math.max(0, state.paco2 - p.threshPeripheral) * p.gainPeripheral;
    const alphaP = 1 - Math.exp(-dt / p.tauPeripheral);
    state.peripheralDrive += (Math.min(periCo2Raw, p.chemoSaturation) - state.peripheralDrive) * alphaP;

    // ── O2 dynamics ───────────────────────────────────
    // Gas exchange raises PaO2 toward alveolar PO2; metabolism consumes it
    const dpao2 = p.o2Clearance * effectiveExchange * (p.alveolarPo2 - state.pao2) - p.o2Consumption;
    state.pao2 = Math.max(0, state.pao2 + dpao2 * dt);

    // Oxyhemoglobin saturation (Hill equation)
    state.spo2 = hillSaturation(state.pao2, p.p50, p.hillN);

    // Peripheral chemoreceptor drive — O2 component (carotid body)
    // Hockey stick: quadratic rise below knee, zero above
    const hypoxicFrac = Math.max(0, (p.hypoxicKnee - state.pao2) / p.hypoxicKnee);
    state.hypoxicDrive = p.gainHypoxic * hypoxicFrac * hypoxicFrac;

    // Total drive for snapshot
    state.chemoDrive = state.centralDrive + state.peripheralDrive + state.hypoxicDrive;
}

/**
 * Map chemoreceptor output to CPG tonic drive offsets.
 *
 * Central chemo → RTN → d1 (inspiratory) + d3 (post-I) + d5 (active expiration)
 * Peripheral chemo (CO2 + O2) → NTS → d1 (inspiratory) + d3 (post-I)
 *
 * drive_3 (post-I excitation) is critical: when the CPG is stuck in
 * inspiration, rising CO2 must help post-I neurons overcome early-I
 * inhibition to terminate the breath. Without this, chemo → drive_1
 * creates a positive feedback loop (stuck inspiration → rising CO2 →
 * more inspiratory drive → more stuck).
 */
export function chemoCpgDrives(state) {
    return {
        drive_1: state.centralDrive * 0.2
               + state.peripheralDrive * 0.3
               + state.hypoxicDrive * 0.6,
        drive_3: state.centralDrive * 0.3
               + state.peripheralDrive * 0.2,
        drive_5: state.centralDrive * 0.3,
    };
}
