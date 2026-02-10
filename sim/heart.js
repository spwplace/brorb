/**
 * Heart rate model with respiratory sinus arrhythmia (RSA),
 * sympathetic/parasympathetic dual innervation, Frank-Starling
 * stroke volume, and arrhythmia state machine.
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
 * Stroke volume: Frank-Starling mechanism (Guyton Ch. 9).
 *   SV = contractility × SVmax × starling(fillingTime) × afterloadPenalty
 *   - fillingTime = 60/HR - systoleDuration (faster HR → less filling → less SV)
 *   - contractility = (1 + inotropicGain × sympathetic) × ischemiaFactor
 *   - afterloadPenalty: higher MAP makes ejection harder
 *
 * This makes VT devastating: HR 180 → fillingTime 0.03s → SV ~7 mL → CO ~1.3 L/min
 *
 * Cardiac output (CO) = HR × SV / 1000 (L/min).
 * CO feeds back to MAP (hemodynamics.js) and baroreceptors (autonomic.js).
 *
 * Rhythm state machine: normal → vt → vf → asystole
 * Ischemia factor is owned by hemodynamics.js (coronary perfusion model).
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

        // Cardiac mechanics (Frank-Starling)
        this.strokeVolume = 70.0;    // mL per beat
        this.cardiacOutput = 5.0;    // L/min
        this.contractility = 1.0;    // sympathetic × ischemia

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
        g_postI_cvmn: 0.15,  // post-I → CVMN excitation (Gilbey et al. 1984)
        g_preI_cvmn: 0.25,   // pre-I/I → CVMN inhibition (vagal withdrawal)
        d_vagal: 0.65,       // tonic excitatory drive → resting vagal tone
        tau_cvmn: 0.3,       // CVMN membrane time constant, s

        // Vagal effect on heart rate
        vagalDepth: 40.0,    // max HR reduction from vagal output, bpm

        // Sympathetic effect on heart rate (chronotropic)
        sympatheticHrGain: 40.0,  // max HR increase from sympathetic, bpm

        // ── Frank-Starling SV parameters (Guyton Ch. 9) ────
        svMax: 120.0,              // mL, maximum SV at full preload
        preloadRef: 0.6,           // s, filling time reference for Starling curve
        systoleDuration: 0.3,      // s, approx constant systolic interval
        inotropicGain: 0.4,        // fractional contractility increase from sympathetic
        afterloadGain: 0.3,        // SV reduction factor for elevated MAP
        afterloadRef: 93.0,        // mmHg, reference MAP for afterload

        // Noise
        noiseAmp: 0.5,

        // Stress index smoothing
        tauStress: 10.0,

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
 * @param {number} estBpm - estimated breathing rate (for stress index)
 * @param {number} fPreI - pre-I/I firing rate (0-1)
 * @param {number} fPostI - post-I firing rate (0-1)
 * @param {number} sympatheticTone - from autonomic module (0-1)
 * @param {number} vagalModulation - from autonomic module (adjustment to d_vagal)
 * @param {number} pao2 - arterial PO2, mmHg (for direct asystole check)
 * @param {number} map - mean arterial pressure, mmHg (for afterload)
 * @param {number} ischemiaFactor - from hemodynamics (0-1)
 * @param {object} p - heart params
 */
export function stepHeart(state, dt, lungVolume, phase, estBpm, fPreI, fPostI,
                          sympatheticTone, vagalModulation, pao2, map, ischemiaFactor, p) {

    // ── Rhythm state machine ──────────────────────────
    updateRhythm(state, dt, pao2, sympatheticTone, ischemiaFactor, p);

    // ── Heart rate computation ────────────────────────
    if (state.cardiacRhythm === 'asystole') {
        state.currentHr = 0;
        state.cvmnActivity = 0;
        state.strokeVolume = 0;
        state.cardiacOutput = 0;
        state.heartbeat = false;
        state.beatAccumulator = 0;
        return;
    }

    if (state.cardiacRhythm === 'vf') {
        // Ventricular fibrillation — chaotic, no effective contraction
        state.currentHr = 200 + (Math.random() - 0.5) * 100;
        state.strokeVolume = p.svMax * 0.05 * ischemiaFactor;
        state.cardiacOutput = state.currentHr * state.strokeVolume / 1000;

        state.beatAccumulator += dt;
        if (state.beatAccumulator > 0.1 + Math.random() * 0.15) {
            state.beatAccumulator = 0;
            state.heartbeat = true;
        }
        state.rhythmTimer += dt;
        return;
    }

    if (state.cardiacRhythm === 'vt') {
        // Ventricular tachycardia — fast, bypasses normal conduction
        state.currentHr = 180 + (Math.random() - 0.5) * 10;

        // Frank-Starling still applies: very short filling time at HR 180
        // Plus 0.5 efficiency factor for abnormal conduction + no atrial kick
        const vtFilling = Math.max(0.05, 60.0 / state.currentHr - p.systoleDuration);
        const vtPreload = 1.0 - Math.exp(-vtFilling / p.preloadRef);
        state.contractility = (1.0 + p.inotropicGain * sympatheticTone) * ischemiaFactor;
        state.strokeVolume = Math.max(0, state.contractility * p.svMax * vtPreload * 0.5);
        state.cardiacOutput = state.currentHr * state.strokeVolume / 1000;

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

    // ── Frank-Starling stroke volume ────────────────
    // Filling time = diastolic interval (total cycle minus systole)
    const fillingTime = Math.max(0.05, 60.0 / Math.max(1, state.currentHr) - p.systoleDuration);

    // Preload: saturating function of filling time (Starling curve)
    const preloadFilling = 1.0 - Math.exp(-fillingTime / p.preloadRef);

    // Contractility: sympathetic inotropic effect × myocardial health
    state.contractility = (1.0 + p.inotropicGain * sympatheticTone) * ischemiaFactor;

    // Afterload: higher MAP → harder to eject → lower SV
    const afterloadPenalty = Math.max(0.2,
        1.0 - p.afterloadGain * Math.max(0, map - p.afterloadRef) / 100.0);

    // SV = contractility × SVmax × starling(filling) × afterload
    state.strokeVolume = Math.max(0,
        state.contractility * p.svMax * preloadFilling * afterloadPenalty);

    // Cardiac output
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
function updateRhythm(state, dt, pao2, sympatheticTone, ischemiaFactor, p) {
    // Direct asystole from severe hypoxia (myocardial energy failure)
    if (pao2 < p.asystolePao2 && state.cardiacRhythm !== 'asystole') {
        state.cardiacRhythm = 'asystole';
        state.rhythmTimer = 0;
        return;
    }

    switch (state.cardiacRhythm) {
        case 'normal':
            if (ischemiaFactor < p.vtFromIschemiaThresh && sympatheticTone > 0.6) {
                state.cardiacRhythm = 'vt';
                state.rhythmTimer = 0;
            }
            break;

        case 'vt':
            if (state.rhythmTimer > p.vfDelay) {
                state.cardiacRhythm = 'vf';
                state.rhythmTimer = 0;
            }
            if (ischemiaFactor > 0.7) {
                state.cardiacRhythm = 'normal';
                state.rhythmTimer = 0;
            }
            break;

        case 'vf':
            if (state.rhythmTimer > p.asystoleDelay) {
                state.cardiacRhythm = 'asystole';
                state.rhythmTimer = 0;
            }
            break;

        case 'asystole':
            break;
    }
}

/**
 * Attempt resuscitation — reset rhythm to normal sinus.
 * Coronary occlusion is cleared separately on hemodynamics state.
 */
export function resuscitateHeart(state) {
    if (state.cardiacRhythm !== 'normal') {
        state.cardiacRhythm = 'normal';
        state.rhythmTimer = 0;
    }
}
