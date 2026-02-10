/**
 * Heart rate model with respiratory sinus arrhythmia (RSA).
 *
 * HR modulated by breathing: rises during inspiration (vagal withdrawal),
 * falls during expiration. RSA amplitude indicates relaxation.
 */

export class HeartState {
    constructor() {
        this.currentHr = 70.0;
        this.beatAccumulator = 0.0;
        this.heartbeat = false;
        this.rsaAmplitude = 8.0;
        this._hrMin = 70.0;
        this._hrMax = 70.0;
        this._inInsp = false;
        this.stressIndex = 0.2;
    }
}

export function defaultHeartParams() {
    return {
        baseHr: 70.0,
        rsaDepth: 8.0,
        noiseAmp: 0.5,
        tauStress: 10.0,
    };
}

export function stepHeart(state, dt, lungVolume, phase, estBpm, p) {
    // Instantaneous HR
    const rsaMod = p.rsaDepth * lungVolume;
    const noise = p.noiseAmp * (Math.random() - 0.5);
    state.currentHr = p.baseHr + rsaMod + noise;

    // Track HR range within breath cycle
    const isInsp = (phase === 'inspiration');
    if (isInsp && !state._inInsp) {
        state.rsaAmplitude = Math.max(1.0, state._hrMax - state._hrMin);
        state._hrMin = state.currentHr;
        state._hrMax = state.currentHr;
    }
    state._inInsp = isInsp;

    state._hrMin = Math.min(state._hrMin, state.currentHr);
    state._hrMax = Math.max(state._hrMax, state.currentHr);

    // Beat accumulator
    const rrInterval = 60.0 / Math.max(30.0, state.currentHr);
    state.beatAccumulator += dt;
    if (state.beatAccumulator >= rrInterval) {
        state.beatAccumulator -= rrInterval;
        state.heartbeat = true;
    }

    // Stress index
    const bpmStress = Math.max(0, Math.min(1, (estBpm - 3.0) / 12.0));
    const rsaCalm = Math.max(0, Math.min(1, (state.rsaAmplitude - 2.0) / 10.0));
    const rawStress = bpmStress * 0.6 + (1.0 - rsaCalm) * 0.4;
    const alpha = Math.min(dt / p.tauStress, 1.0);
    state.stressIndex += (rawStress - state.stressIndex) * alpha;
}
