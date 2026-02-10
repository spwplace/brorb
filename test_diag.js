/**
 * Diagnostic — trace first 30s of simulation to find why ventilation is zero.
 */
import { Simulation } from './sim/simulation.js';
import { sigmoid } from './sim/cpg.js';

const sim = new Simulation(6.0);
const dt = 1 / 60;

for (let sec = 0; sec < 30; sec++) {
    // Run 1 second
    let state;
    for (let i = 0; i < 60; i++) {
        state = sim.tick(dt);
    }

    const y = sim.cpgState.y;
    const p = sim.cpgParams;
    const f1 = sigmoid(y[0], p.k_f, p.Vh_f);
    const f3 = sigmoid(y[2], p.k_f, p.Vh_f);
    const f5 = sigmoid(y[4], p.k_f, p.Vh_f);

    const ly = sim.lungState.y;
    console.log(
        `t=${sec+1}s  ` +
        `f1=${f1.toFixed(3)} f3=${f3.toFixed(3)} f5=${f5.toFixed(3)}  ` +
        `rampI=${ly[0].toFixed(3)} diaph=${ly[1].toFixed(3)} vol=${ly[2].toFixed(3)}  ` +
        `flow=${sim._smoothAbsFlow.toFixed(4)}  ` +
        `CO2=${state.pco2.toFixed(1)} O2=${state.pao2.toFixed(1)}  ` +
        `drives: d1=${p.d1.toFixed(3)} d3=${p.d3.toFixed(3)} d5=${p.d5.toFixed(3)}  ` +
        `driveScale=${(sim.hemoState.cerebralPerfusion > 0.5 ? 1.0 : 0.0).toFixed(1)}  ` +
        `perf=${sim.hemoState.cerebralPerfusion.toFixed(3)}`
    );
}
