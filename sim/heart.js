/**
 * Heart rate model with respiratory sinus arrhythmia (RSA).
 *
 * The cardiac vagal motor neuron (CVMN) in the nucleus ambiguus is
 * modeled as a neural population receiving synaptic input from the
 * respiratory CPG:
 *
 *   - Post-I neurons EXCITE CVMNs (vagal tone peaks in post-inspiration)
 *   - Pre-I/I neurons INHIBIT CVMNs (vagal withdrawal during inspiration)
 *   - Tonic excitatory drive (d_vagal) sets resting vagal tone
 *
 * This is the actual mechanism of RSA (Gilbey et al. 1984; Eckberg 2003).
 * RSA amplitude is an EMERGENT property of the CPG-CVMN coupling,
 * not a parameter. It varies with breathing rate because the duty cycle
 * of inspiratory vs post-inspiratory phases changes with rate.
 *
 * HR = intrinsicHr - vagalDepth * f(CVMN) + noise
 *
 * The SA node intrinsic rate (~100 bpm) is slowed by vagal efferent
 * activity. Sympathetic effects are not yet modeled.
 */

export class HeartState {
    constructor() {
        this.currentHr = 70.0;
        this.cvmnActivity = 0.5;   // cardiac vagal motor neuron activity (0-1)
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
        // SA node intrinsic rate (without autonomic input)
        intrinsicHr: 100.0,

        // Cardiac vagal motor neuron (nucleus ambiguus) parameters
        // Modeled as: dV/dt = (-V + g_postI*fPostI - g_preI*fPreI + d_vagal) / tau
        // Output saturates at [0, 1] (firing rate bound).
        g_postI_cvmn: 0.15,  // post-I → CVMN excitation (Gilbey et al. 1984)
        g_preI_cvmn: 0.25,   // pre-I/I → CVMN inhibition (vagal withdrawal)
        d_vagal: 0.65,       // tonic excitatory drive → resting vagal tone
        tau_cvmn: 0.3,       // CVMN membrane time constant, s

        // Vagal effect on heart rate
        vagalDepth: 40.0,    // max HR reduction from vagal output, bpm

        // Noise
        noiseAmp: 0.5,

        // Stress index smoothing
        tauStress: 10.0,
    };
}

/**
 * @param {HeartState} state
 * @param {number} dt - timestep, s
 * @param {number} lungVolume - current lung volume (for legacy compat)
 * @param {string} phase - respiratory phase label
 * @param {number} estBpm - estimated breathing rate
 * @param {number} fPreI - pre-I/I firing rate (0-1)
 * @param {number} fPostI - post-I firing rate (0-1)
 * @param {object} p - heart params
 */
export function stepHeart(state, dt, lungVolume, phase, estBpm, fPreI, fPostI, p) {
    // Cardiac vagal motor neuron dynamics (nucleus ambiguus).
    // Receives excitatory post-I input and inhibitory pre-I/I input,
    // plus a tonic drive. Same formulation as CPG populations.
    const cvmnTarget = Math.max(0, Math.min(1, p.d_vagal + p.g_postI_cvmn * fPostI - p.g_preI_cvmn * fPreI));
    const cvmnAlpha = 1 - Math.exp(-dt / p.tau_cvmn);
    state.cvmnActivity += (cvmnTarget - state.cvmnActivity) * cvmnAlpha;

    // HR = intrinsic - vagal effect + noise
    // Vagal efferents from NA slow the SA node via muscarinic receptors
    const vagalEffect = p.vagalDepth * state.cvmnActivity;
    const noise = p.noiseAmp * (Math.random() - 0.5);
    state.currentHr = p.intrinsicHr - vagalEffect + noise;

    // Track HR range within breath cycle for RSA measurement
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

    // Stress index: high BPM + low RSA = stressed
    const bpmStress = Math.max(0, Math.min(1, (estBpm - 3.0) / 12.0));
    const rsaCalm = Math.max(0, Math.min(1, (state.rsaAmplitude - 2.0) / 15.0));
    const rawStress = bpmStress * 0.6 + (1.0 - rsaCalm) * 0.4;
    const alpha = Math.min(dt / p.tauStress, 1.0);
    state.stressIndex += (rawStress - state.stressIndex) * alpha;
}
