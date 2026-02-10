/**
 * CO2/chemoreceptor feedback model.
 *
 * Arterial PaCO2 (mmHg) rises from metabolism and is cleared by
 * alveolar ventilation. Two chemoreceptor populations drive the CPG:
 *
 *   Central (medullary): slow (tau ~60s), responds to brain tissue CO2.
 *     Routes through RTN → d1 (inspiratory) + d5 (active expiration).
 *
 *   Peripheral (carotid body): fast (tau ~5s), responds to arterial PaCO2.
 *     Routes through NTS → d1 (inspiratory).
 *
 * Normal PaCO2 ~40 mmHg. Apneic threshold ~35 mmHg.
 */

export class ChemoState {
    constructor() {
        this.paco2 = 40.0;          // arterial CO2, mmHg
        this.paco2Central = 40.0;   // brain tissue CO2 (lags arterial)
        this.chemoDrive = 0.0;      // total chemoreceptor output
        this.centralDrive = 0.0;
        this.peripheralDrive = 0.0;
    }
}

export function defaultChemoParams() {
    return {
        // Metabolic CO2 production (mmHg/s at rest)
        // Calibrated so PaCO2 ~40 mmHg at eupneic ventilation (~6-7 BPM)
        co2Production: 0.65,

        // Clearance coefficient: dPaCO2/dt -= clearance * ventilation * PaCO2
        co2Clearance: 0.012,

        // Central chemoreception (medullary RTN, slow)
        tauCentral: 60.0,           // brain tissue equilibration, s
        gainCentral: 0.04,          // drive per mmHg above threshold
        threshCentral: 35.0,        // mmHg (apneic threshold)

        // Peripheral chemoreception (carotid body, fast)
        tauPeripheral: 5.0,         // fast response, s
        gainPeripheral: 0.02,       // drive per mmHg above threshold
        threshPeripheral: 35.0,     // mmHg

        // Output saturation
        chemoSaturation: 1.5,
    };
}

export function stepChemo(state, dt, ventilation, p) {
    // Arterial CO2 dynamics
    const dpaco2 = p.co2Production - p.co2Clearance * ventilation * state.paco2;
    state.paco2 = Math.max(0, state.paco2 + dpaco2 * dt);

    // Central: brain tissue CO2 tracks arterial with slow time constant
    const alphaC = 1 - Math.exp(-dt / p.tauCentral);
    state.paco2Central += (state.paco2 - state.paco2Central) * alphaC;

    // Central chemoreceptor drive (RTN)
    const centralRaw = Math.max(0, state.paco2Central - p.threshCentral) * p.gainCentral;
    state.centralDrive = Math.min(centralRaw, p.chemoSaturation);

    // Peripheral chemoreceptor drive (carotid body)
    const periRaw = Math.max(0, state.paco2 - p.threshPeripheral) * p.gainPeripheral;
    const alphaP = 1 - Math.exp(-dt / p.tauPeripheral);
    state.peripheralDrive += (Math.min(periRaw, p.chemoSaturation) - state.peripheralDrive) * alphaP;

    // Total drive for snapshot
    state.chemoDrive = state.centralDrive + state.peripheralDrive;
}

/**
 * Map chemoreceptor output to CPG tonic drive offsets.
 *
 * Central chemo → RTN → d1 (inspiratory) + d5 (active expiration)
 * Peripheral chemo → NTS → d1 (inspiratory, fast modulation)
 */
export function chemoCpgDrives(state) {
    return {
        drive_1: state.centralDrive * 0.4 + state.peripheralDrive * 0.5,
        drive_5: state.centralDrive * 0.3,
    };
}
