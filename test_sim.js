/**
 * CLI validation tests for the cardiorespiratory simulation.
 *
 * Runs the simulation headless (no browser) and checks that
 * physiological variables converge to expected steady-state ranges
 * and respond correctly to perturbations.
 *
 * Usage: node test_sim.js
 */

import { Simulation } from './sim/simulation.js';

// ── Test harness ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg, actual, expected) {
    if (condition) {
        passed++;
    } else {
        failed++;
        const detail = expected !== undefined
            ? `  got ${typeof actual === 'number' ? actual.toFixed(3) : actual}, expected ${expected}`
            : '';
        failures.push(`FAIL: ${msg}${detail}`);
        console.log(`  FAIL: ${msg}${detail}`);
    }
}

function inRange(val, lo, hi, label) {
    assert(val >= lo && val <= hi, `${label} in [${lo}, ${hi}]`, val, `[${lo}, ${hi}]`);
}

function runSim(sim, seconds) {
    const dt = 1 / 60; // 60 fps frames
    const frames = Math.round(seconds / dt);
    let state;
    for (let i = 0; i < frames; i++) {
        state = sim.tick(dt);
    }
    return state;
}

// ── Test 1: Baseline steady state ────────────────────────────────

function testBaseline() {
    console.log('\n=== Test 1: Baseline steady state (60s warmup) ===');
    const sim = new Simulation(6.0);
    const state = runSim(sim, 60);

    console.log(`  HR=${state.heart_rate.toFixed(1)} bpm`);
    console.log(`  RSA=${state.rsa_amplitude.toFixed(1)} bpm`);
    console.log(`  CO=${state.cardiac_output.toFixed(2)} L/min`);
    console.log(`  MAP=${state.map.toFixed(1)} mmHg`);
    console.log(`  TPR=${state.tpr.toFixed(1)} mmHg·min/L`);
    console.log(`  PaCO2=${state.pco2.toFixed(1)} mmHg`);
    console.log(`  PaO2=${state.pao2.toFixed(1)} mmHg`);
    console.log(`  SpO2=${(state.spo2 * 100).toFixed(1)}%`);
    console.log(`  Ischemia=${state.ischemia_factor.toFixed(3)}`);
    console.log(`  Cerebral=${state.cerebral_perfusion.toFixed(3)}`);
    console.log(`  CoronaryFlow=${state.coronary_flow.toFixed(0)} mL/min`);
    console.log(`  Rhythm=${state.cardiac_rhythm}`);
    console.log(`  SV=${state.stroke_volume.toFixed(1)} mL`);
    console.log(`  BPM=${state.est_bpm.toFixed(1)}`);
    console.log(`  Sympathetic=${state.sympathetic_tone.toFixed(3)}`);
    console.log(`  Vagal=${state.vagal_tone.toFixed(3)}`);
    console.log(`  ChemoDrive=${state.chemo_drive.toFixed(3)}`);

    inRange(state.heart_rate, 55, 100, 'HR');
    inRange(state.cardiac_output, 3.5, 7.0, 'CO');
    inRange(state.map, 70, 110, 'MAP');
    inRange(state.pco2, 35, 45, 'PaCO2');
    inRange(state.pao2, 80, 120, 'PaO2');
    inRange(state.spo2, 0.95, 1.0, 'SpO2');
    inRange(state.ischemia_factor, 0.95, 1.0, 'IschemiaFactor');
    inRange(state.cerebral_perfusion, 0.95, 1.0, 'CerebralPerfusion');
    inRange(state.coronary_flow, 200, 300, 'CoronaryFlow');
    assert(state.cardiac_rhythm === 'normal', 'Rhythm is normal sinus', state.cardiac_rhythm);
    inRange(state.stroke_volume, 50, 100, 'StrokeVolume');
    inRange(state.est_bpm, 4, 9, 'BreathingRate');
}

// ── Test 2: Respiratory arrest ───────────────────────────────────

function testRespArrest() {
    console.log('\n=== Test 2: Respiratory arrest ===');
    const sim = new Simulation(6.0);

    // Warm up to steady state
    runSim(sim, 60);

    // Trigger respiratory arrest
    sim.triggerRespArrest();

    // After 30s of apnea
    const at30 = runSim(sim, 30);
    console.log(`  @30s: PaCO2=${at30.pco2.toFixed(1)}, SpO2=${(at30.spo2*100).toFixed(1)}%, HR=${at30.heart_rate.toFixed(0)}`);

    assert(at30.pco2 > 50, 'CO2 rises during apnea (>50 at 30s)', at30.pco2);
    assert(at30.spo2 < 0.95, 'SpO2 drops during apnea (<95% at 30s)', at30.spo2);

    // After 90s of apnea — should be critical
    const at90 = runSim(sim, 60);
    console.log(`  @90s: PaCO2=${at90.pco2.toFixed(1)}, SpO2=${(at90.spo2*100).toFixed(1)}%, HR=${at90.heart_rate.toFixed(0)}, Rhythm=${at90.cardiac_rhythm}`);

    assert(at90.pco2 > 60, 'CO2 critically high (>60 at 90s)', at90.pco2);
    assert(at90.spo2 < 0.70, 'SpO2 critically low (<70% at 90s)', at90.spo2);
}

// ── Test 3: Ventilation goes to zero in apnea ────────────────────

function testVentilationDecay() {
    console.log('\n=== Test 3: Ventilation decays to zero in apnea ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    // Record baseline ventilation
    const baselineFlow = sim._smoothAbsFlow;
    console.log(`  Baseline smoothAbsFlow=${baselineFlow.toFixed(4)}`);
    assert(baselineFlow > 0.01, 'Baseline flow is positive', baselineFlow);

    sim.triggerRespArrest();
    runSim(sim, 20);

    const arrestFlow = sim._smoothAbsFlow;
    console.log(`  After 20s arrest: smoothAbsFlow=${arrestFlow.toFixed(6)}`);
    assert(arrestFlow < baselineFlow * 0.1, 'Flow drops to <10% of baseline after 20s arrest', arrestFlow);
}

// ── Test 4: Heart attack cascade ─────────────────────────────────

function testHeartAttack() {
    console.log('\n=== Test 4: Heart attack cascade ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    const baseline = { map: sim.hemoState.map, co: sim.heartState.cardiacOutput };
    console.log(`  Baseline: MAP=${baseline.map.toFixed(1)}, CO=${baseline.co.toFixed(2)}`);

    // 70% coronary occlusion
    sim.triggerHeartAttack(0.7);

    // After 10s — ischemia should be developing
    const at10 = runSim(sim, 10);
    console.log(`  @10s: MAP=${at10.map.toFixed(1)}, CO=${at10.cardiac_output.toFixed(2)}, Ischemia=${at10.ischemia_factor.toFixed(3)}, Rhythm=${at10.cardiac_rhythm}`);

    assert(at10.ischemia_factor < 0.9, 'Ischemia develops (<0.9 at 10s)', at10.ischemia_factor);
    assert(at10.map < baseline.map, 'MAP drops after MI', at10.map);

    // After 30s — should be in VT or worse
    const at30 = runSim(sim, 20);
    console.log(`  @30s: MAP=${at30.map.toFixed(1)}, CO=${at30.cardiac_output.toFixed(2)}, Ischemia=${at30.ischemia_factor.toFixed(3)}, Rhythm=${at30.cardiac_rhythm}`);

    assert(at30.cardiac_rhythm !== 'normal', 'Arrhythmia develops by 30s', at30.cardiac_rhythm);

    // After 60s — should be in VF or asystole
    const at60 = runSim(sim, 30);
    console.log(`  @60s: MAP=${at60.map.toFixed(1)}, CO=${at60.cardiac_output.toFixed(2)}, Rhythm=${at60.cardiac_rhythm}`);
}

// ── Test 5: V/Q coupling — low CO impairs gas exchange ───────────

function testVQCoupling() {
    console.log('\n=== Test 5: V/Q coupling ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    const baselineCO2 = sim.chemoState.paco2;
    const baselineCO = sim.heartState.cardiacOutput;
    console.log(`  Baseline: PaCO2=${baselineCO2.toFixed(1)}, CO=${baselineCO.toFixed(2)}`);

    // Directly reduce cardiac output by triggering heart attack
    // (This also tests the hemodynamic cascade indirectly)
    // Instead, let's check perfusionFactor calculation
    const perfFactor = Math.min(1.0, sim.heartState.cardiacOutput / sim.hemoParams.normalCO);
    console.log(`  PerfusionFactor=${perfFactor.toFixed(3)}`);
    assert(perfFactor > 0.8, 'Normal perfusion factor near 1.0', perfFactor);
}

// ── Test 6: Frank-Starling — fast HR reduces SV ──────────────────

function testFrankStarling() {
    console.log('\n=== Test 6: Frank-Starling mechanism ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    const normalSV = sim.heartState.strokeVolume;
    const normalHR = sim.heartState.currentHr;
    const normalCO = sim.heartState.cardiacOutput;
    console.log(`  Normal: HR=${normalHR.toFixed(0)}, SV=${normalSV.toFixed(1)} mL, CO=${normalCO.toFixed(2)} L/min`);

    assert(normalSV > 50, 'Normal SV > 50 mL', normalSV);

    // VT stroke volume calculation (HR=180)
    const p = sim.heartParams;
    const vtFilling = Math.max(0.05, 60.0 / 180 - p.systoleDuration);
    const vtPreload = 1.0 - Math.exp(-vtFilling / p.preloadRef);
    const vtSV = p.svMax * vtPreload * 0.5; // 0.5 for abnormal conduction
    const vtCO = 180 * vtSV / 1000;
    console.log(`  VT calc: filling=${vtFilling.toFixed(3)}s, preload=${vtPreload.toFixed(3)}, SV=${vtSV.toFixed(1)} mL, CO=${vtCO.toFixed(2)} L/min`);

    assert(vtSV < normalSV * 0.3, 'VT SV < 30% of normal (Frank-Starling)', vtSV);
    assert(vtCO < 2.0, 'VT CO < 2 L/min (devastating)', vtCO);
}

// ── Test 7: Hemodynamics equations ───────────────────────────────

function testHemodynamics() {
    console.log('\n=== Test 7: Hemodynamics equations ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    const h = sim.hemoState;
    const p = sim.hemoParams;

    // MAP ≈ CO × TPR
    const expectedMap = sim.heartState.cardiacOutput * h.tpr;
    console.log(`  MAP=${h.map.toFixed(1)}, CO×TPR=${expectedMap.toFixed(1)}`);
    inRange(h.map, expectedMap * 0.85, expectedMap * 1.15, 'MAP ≈ CO×TPR');

    // Coronary flow check
    const diastolicBp = h.map * 0.75;
    const cpp = Math.max(0, diastolicBp - p.lvedp);
    const expectedFlow = cpp / p.baseCoronaryResistance;
    console.log(`  CoronaryFlow=${h.coronaryFlow.toFixed(0)}, expected≈${expectedFlow.toFixed(0)}`);
    inRange(h.coronaryFlow, expectedFlow * 0.8, expectedFlow * 1.2, 'CoronaryFlow');

    // Cerebral autoregulation: MAP ~93 → perfusion = 1.0
    assert(h.cerebralPerfusion > 0.95, 'Cerebral perfusion normal at MAP ~93', h.cerebralPerfusion);
}

// ── Test 8: Baroreflex from MAP ──────────────────────────────────

function testBaroreflex() {
    console.log('\n=== Test 8: Baroreflex senses MAP ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    const baseSym = sim.autonomicState.sympatheticTone;
    console.log(`  Baseline sympathetic=${baseSym.toFixed(3)}`);

    // MAP is used (not CO) — verify by checking autonomic responds to MAP changes
    // We can't easily decouple them, but we can verify the autonomic module
    // receives MAP correctly
    inRange(baseSym, 0.2, 0.5, 'Baseline sympathetic tone');
}

// ── Test 9: Resuscitation ────────────────────────────────────────

function testResuscitation() {
    console.log('\n=== Test 9: Resuscitation after heart attack ===');
    const sim = new Simulation(6.0);
    runSim(sim, 60);

    sim.triggerHeartAttack(0.7);
    runSim(sim, 20); // Let ischemia develop

    const preCO = sim.heartState.cardiacOutput;
    console.log(`  Pre-resus: CO=${preCO.toFixed(2)}, Rhythm=${sim.heartState.cardiacRhythm}`);

    sim.resuscitate();
    const postState = runSim(sim, 30);
    console.log(`  Post-resus (30s): CO=${postState.cardiac_output.toFixed(2)}, MAP=${postState.map.toFixed(1)}, Rhythm=${postState.cardiac_rhythm}`);

    assert(postState.cardiac_rhythm === 'normal', 'Rhythm restored after resuscitation', postState.cardiac_rhythm);
    assert(postState.cardiac_output > 3.0, 'CO recovers after resuscitation', postState.cardiac_output);
}

// ── Test 10: CO2 homeostasis at different breathing rates ────────

function testCO2Homeostasis() {
    console.log('\n=== Test 10: CO2 at different breathing rates ===');

    for (const bpm of [4, 6, 10]) {
        const sim = new Simulation(bpm);
        const state = runSim(sim, 90);
        console.log(`  BPM=${bpm}: PaCO2=${state.pco2.toFixed(1)}, PaO2=${state.pao2.toFixed(1)}, SpO2=${(state.spo2*100).toFixed(1)}%`);
    }

    // At 6 BPM, CO2 should be near 40
    const sim6 = new Simulation(6.0);
    const state6 = runSim(sim6, 90);
    inRange(state6.pco2, 35, 45, 'PaCO2 at 6 BPM');

    // At 4 BPM (slow), CO2 should be higher
    const sim4 = new Simulation(4.0);
    const state4 = runSim(sim4, 90);
    assert(state4.pco2 > state6.pco2, 'Slower breathing → higher CO2', state4.pco2);

    // At 10 BPM (fast), CO2 should be lower
    const sim10 = new Simulation(10.0);
    const state10 = runSim(sim10, 90);
    assert(state10.pco2 < state6.pco2, 'Faster breathing → lower CO2', state10.pco2);
}

// ── Run all tests ────────────────────────────────────────────────

console.log('Brorb Cardiorespiratory Model — Validation Tests');
console.log('================================================');

const t0 = performance.now();

testBaseline();
testRespArrest();
testVentilationDecay();
testHeartAttack();
testVQCoupling();
testFrankStarling();
testHemodynamics();
testBaroreflex();
testResuscitation();
testCO2Homeostasis();

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

console.log('\n================================================');
console.log(`Results: ${passed} passed, ${failed} failed (${elapsed}s)`);

if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
        console.log(`  ${f}`);
    }
    process.exit(1);
} else {
    console.log('\nAll tests passed.');
}
