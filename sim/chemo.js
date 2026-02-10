/**
 * CO2/chemoreceptor feedback model.
 *
 * Blood CO2 rises from metabolism and is cleared by ventilation.
 * Chemoreceptors increase CPG drive when CO2 is high.
 */

export class ChemoState {
    constructor() {
        this.pco2 = 1.0;
        this.chemoDrive = 0.15;
    }
}

export function defaultChemoParams() {
    return {
        co2Production: 0.03,
        co2Clearance: 0.05,
        apneicThreshold: 0.75,
        chemoGain: 0.6,
        chemoSaturation: 1.5,
        tauChemo: 2.0,
    };
}

export function stepChemo(state, dt, ventilation, p) {
    const dpco2 = p.co2Production - p.co2Clearance * ventilation * state.pco2;
    state.pco2 = Math.max(0, state.pco2 + dpco2 * dt);

    let raw = Math.max(0, state.pco2 - p.apneicThreshold) * p.chemoGain;
    raw = Math.min(raw, p.chemoSaturation);

    const alpha = Math.min(dt / p.tauChemo, 1.0);
    state.chemoDrive += (raw - state.chemoDrive) * alpha;
}

export function chemoCpgDrives(state) {
    const d = state.chemoDrive;
    return {
        drive_1: d * 0.5,
        drive_3: d * 0.2,
    };
}
