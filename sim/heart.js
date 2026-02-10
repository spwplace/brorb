/**
 * Heart rate model with respiratory sinus arrhythmia (RSA),
 * sympathetic/parasympathetic dual innervation, cardiac output,
 * and arrhythmia state machine.
 *
 * The cardiac vagal motor neuron (CVMN) in the nucleus ambiguus is
 * modeled as a neural population receiving synaptic input from the
 * respiratory CPG:
 *
 *   - Post-I neurons EXCITE CVMNs (vagal tone peaks in post-inspiration)
 *   - Pre-I/I neurons INHIBIT CVMNs (vagal withdrawal during inspiration)
 *   - Tonic excitatory drive (d_vagal) sets resting vagal tone
 *   - Autonomic module modulates d_vagal via baroreflex + hypoxic surge
 *
 * RSA amplitude is an EMERGENT property of the CPG-CVMN coupling.
 *
 * HR = intrinsicHr - vagalDepth * f(CVMN) + sympatheticHrGain * sympathetic + noise
 *
 * Cardiac output (CO) = HR × SV, where SV is modulated by sympathetic
 * inotropic effect and ischemia. CO feeds back to cerebral perfusion
 * (in simulation.js) and baroreceptors (in autonomic.js).
 *
 * Rhythm state machine: normal → vt → vf → asystole
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

        // Cardiac mechanics
        this.strokeVolume = 70.0;    // mL per beat
        this.cardiacOutput = 5.0;    // L/min

        // Ischemia / cardiac events
        this.ischemiaFactor = 1.0;   // 1.0 = healthy, 0 = dead myocardium
        this._ischemiaTarget = 1.0;  // for smooth ramping

        // Rhythm state machine
        this.cardiacRhythm = 'normal';  // 'normal' | 'vt' | 'vf' | 'asystole'
        this.rhythmTimer = 0;           // time in current abnormal rhythm
    }
}

export function defaultHeartParams() {
    return {
        // SA node intrinsic rate (without autonomic input)
        intrinsicHr: 100.0,

        // Cardiac vagal motor neuron (nucleus ambiguus) parameters
        // Output saturates at [0, 1] (firing rate bound).
        g_postI_cvmn: 0.15,  // post-I → CVMN excitation (Gilbey et al. 1984)
        g_preI_cvmn: 0.25,   // pre-I/I → CVMN inhibition (vagal withdrawal)
        d_vagal: 0.65,       // tonic excitatory drive → resting vagal tone
        tau_cvmn: 0.3,       // CVMN membrane time constant, s

        // Vagal effect on heart rate
        vagalDepth: 40.0,    // max HR reduction from vagal output, bpm

        // Sympathetic effect on heart rate (chronotropic)
        sympatheticHrGain: 40.0,  // max HR increase from sympathetic, bpm

        // Stroke volume
        baseSV: 70.0,              // mL, normal stroke volume
        sympatheticSvGain: 0.3,    // fractional SV increase (inotropic)

        // Noise
        noiseAmp: 0.5,

        // Stress index smoothing
        tauStress: 10.0,

        // Ischemia ramp rate (how fast MI develops)
        ischemiaRampTau: 10.0,     // seconds to reach target ischemia

        // Rhythm thresholds
        vtFromIschemiaThresh: 0.4,  // ischemiaFactor below which VT risk appears
        vfDelay: 15.0,              // seconds of VT before VF
        asystoleDelay: 30.0,        // seconds of VF before asystole
        asystolePao2: 20.0,         // PaO2 below which direct asystole occurs
    };
}

/**
 * @param {HeartState} state
 * @param {number} dt - timestep, s
 * @param {number} lungVolume - current lung volume
 * @param {string} phase - respiratory phase label
 * @param {number} estBpm - estimated breathing rate
 * @param {number} fPreI - pre-I/I firing rate (0-1)
 * @param {number} fPostI - post-I firing rate (0-1)
 * @param {number} sympatheticTone - from autonomic module (0-1)
 * @param {number} vagalModulation - from autonomic module (adjustment to d_vagal)
 * @param {number} pao2 - arterial PO2, mmHg (for direct asystole check)
 * @param {object} p - heart params
 */
export function stepHeart(state, dt, lungVolume, phase, estBpm, fPreI, fPostI,
                          sympatheticTone, vagalModulation, pao2, p) {

    // ── Rhythm state machine ──────────────────────────
    updateRhythm(state, dt, pao2, sympatheticTone, p);

    // ── Ischemia ramping ──────────────────────────────
    const ischAlpha = 1 - Math.exp(-dt / p.ischemiaRampTau);
    state.ischemiaFactor += (state._ischemiaTarget - state.ischemiaFactor) * ischAlpha;

    // ── Heart rate computation ────────────────────────
    if (state.cardiacRhythm === 'asystole') {
        // Dead — no electrical activity
        state.currentHr = 0;
        state.cvmnActivity = 0;
        state.strokeVolume = 0;
        state.cardiacOutput = 0;
        state.heartbeat = false;
        state.beatAccumulator = 0;
        return;
    }

    if (state.cardiacRhythm === 'vf') {
        // Ventricular fibrillation — chaotic, no effective output
        state.currentHr = 200 + (Math.random() - 0.5) * 100;
        state.strokeVolume = p.baseSV * 0.1 * state.ischemiaFactor;
        state.cardiacOutput = state.currentHr * state.strokeVolume / 1000;

        // No organized beats in VF — produce chaotic "beats" for ECG
        state.beatAccumulator += dt;
        if (state.beatAccumulator > 0.1 + Math.random() * 0.15) {
            state.beatAccumulator = 0;
            state.heartbeat = true;
        }
        state.rhythmTimer += dt;
        return;
    }

    if (state.cardiacRhythm === 'vt') {
        // Ventricular tachycardia — fast, regular, poor output
        state.currentHr = 180 + (Math.random() - 0.5) * 10;
        state.strokeVolume = p.baseSV * 0.3 * state.ischemiaFactor;
        state.cardiacOutput = state.currentHr * state.strokeVolume / 1000;

        // Regular fast beats
        const rrVT = 60.0 / state.currentHr;
        state.beatAccumulator += dt;
        if (state.beatAccumulator >= rrVT) {
            state.beatAccumulator -= rrVT;
            state.heartbeat = true;
        }
        state.rhythmTimer += dt;
        return;
    }

    // ── Normal sinus rhythm ───────────────────────────

    // CVMN dynamics: receives CPG input + autonomic modulation
    // vagalModulation adjusts the tonic drive from baroreflex / hypoxic surge
    const effectiveVagalDrive = Math.max(0, p.d_vagal + vagalModulation);
    const cvmnTarget = Math.max(0, Math.min(1,
        effectiveVagalDrive + p.g_postI_cvmn * fPostI - p.g_preI_cvmn * fPreI
    ));
    const cvmnAlpha = 1 - Math.exp(-dt / p.tau_cvmn);
    state.cvmnActivity += (cvmnTarget - state.cvmnActivity) * cvmnAlpha;

    // HR = intrinsic - vagal + sympathetic + noise
    const vagalEffect = p.vagalDepth * state.cvmnActivity;
    const sympatheticEffect = p.sympatheticHrGain * sympatheticTone;
    const noise = p.noiseAmp * (Math.random() - 0.5);
    state.currentHr = Math.max(0, p.intrinsicHr - vagalEffect + sympatheticEffect + noise);

    // ── Stroke volume + cardiac output ────────────────
    state.strokeVolume = p.baseSV
        * (1 + p.sympatheticSvGain * sympatheticTone)
        * state.ischemiaFactor;
    state.cardiacOutput = state.currentHr * state.strokeVolume / 1000;

    // ── Track HR range within breath cycle for RSA measurement ──
    const isInsp = (phase === 'inspiration');
    if (isInsp && !state._inInsp) {
        state.rsaAmplitude = Math.max(1.0, state._hrMax - state._hrMin);
        state._hrMin = state.currentHr;
        state._hrMax = state.currentHr;
    }
    state._inInsp = isInsp;
    state._hrMin = Math.min(state._hrMin, state.currentHr);
    state._hrMax = Math.max(state._hrMax, state.currentHr);

    // ── Beat accumulator ──────────────────────────────
    if (state.currentHr > 1) {
        const rrInterval = 60.0 / state.currentHr;
        state.beatAccumulator += dt;
        if (state.beatAccumulator >= rrInterval) {
            state.beatAccumulator -= rrInterval;
            state.heartbeat = true;
        }
    }

    // ── Stress index ──────────────────────────────────
    const bpmStress = Math.max(0, Math.min(1, (estBpm - 3.0) / 12.0));
    const rsaCalm = Math.max(0, Math.min(1, (state.rsaAmplitude - 2.0) / 15.0));
    const rawStress = bpmStress * 0.6 + (1.0 - rsaCalm) * 0.4;
    const alpha = Math.min(dt / p.tauStress, 1.0);
    state.stressIndex += (rawStress - state.stressIndex) * alpha;
}

/**
 * Cardiac rhythm state machine.
 *
 * Transitions:
 *   normal → vt:       ischemia below threshold + sympathetic overdrive
 *   vt → vf:           after vfDelay seconds
 *   vf → asystole:     after asystoleDelay seconds
 *   any → asystole:    PaO2 < asystolePao2 (direct myocardial failure)
 */
function updateRhythm(state, dt, pao2, sympatheticTone, p) {
    // Direct asystole from severe hypoxia (myocardial energy failure)
    if (pao2 < p.asystolePao2 && state.cardiacRhythm !== 'asystole') {
        state.cardiacRhythm = 'asystole';
        state.rhythmTimer = 0;
        return;
    }

    switch (state.cardiacRhythm) {
        case 'normal':
            // VT trigger: significant ischemia + high sympathetic tone
            if (state.ischemiaFactor < p.vtFromIschemiaThresh && sympatheticTone > 0.6) {
                state.cardiacRhythm = 'vt';
                state.rhythmTimer = 0;
            }
            break;

        case 'vt':
            // VT → VF after delay
            if (state.rhythmTimer > p.vfDelay) {
                state.cardiacRhythm = 'vf';
                state.rhythmTimer = 0;
            }
            // Recovery possible if ischemia resolves
            if (state.ischemiaFactor > 0.7) {
                state.cardiacRhythm = 'normal';
                state.rhythmTimer = 0;
            }
            break;

        case 'vf':
            // VF → asystole after delay
            if (state.rhythmTimer > p.asystoleDelay) {
                state.cardiacRhythm = 'asystole';
                state.rhythmTimer = 0;
            }
            break;

        case 'asystole':
            // Terminal — no recovery without external intervention
            break;
    }
}

/**
 * Trigger a myocardial infarction.
 * Sets ischemia target to a low value; actual factor ramps down smoothly.
 */
export function triggerHeartAttack(state, severity = 0.3) {
    state._ischemiaTarget = severity;
}

/**
 * Attempt resuscitation — restore ischemia and reset rhythm.
 * Only works if called before prolonged asystole.
 */
export function resuscitateHeart(state) {
    state._ischemiaTarget = 1.0;
    if (state.cardiacRhythm !== 'normal') {
        state.cardiacRhythm = 'normal';
        state.rhythmTimer = 0;
    }
}
