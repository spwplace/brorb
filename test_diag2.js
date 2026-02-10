/**
 * Diagnostic 2 — test CPG alone at base drives (4 BPM), no chemo feedback.
 */
import { CPGState, defaultParams, driveProfile, BASE_DRIVES, rk4Step, sigmoid } from './sim/cpg.js';
import { LungState, defaultLungParams, lungRk4Step, heringBreuerDrives } from './sim/lungs.js';

const dt = 0.001;
const cpgP = defaultParams();
const lungP = defaultLungParams();
const cpg = new CPGState();
const lung = new LungState();

// Apply BASE_DRIVES (4 BPM baseline)
Object.assign(cpgP, { d1: BASE_DRIVES.d1, d2: BASE_DRIVES.d2, d3: BASE_DRIVES.d3, d4: BASE_DRIVES.d4, d5: BASE_DRIVES.d5 });

console.log('=== CPG at BASE_DRIVES (4 BPM) with HB reflex ===');
for (let sec = 0; sec < 30; sec++) {
    for (let i = 0; i < 1000; i++) {
        const hb = heringBreuerDrives(lung.y, lungP);
        rk4Step(cpg.y, dt, cpgP, hb);
        lungRk4Step(lung.y, dt, cpg.y, lungP, cpgP);
        lung.y[0] = Math.max(0, Math.min(1, lung.y[0]));
        lung.y[1] = Math.max(0, lung.y[1]);
        lung.y[2] = Math.max(0, lung.y[2]);
    }
    const f1 = sigmoid(cpg.y[0], cpgP.k_f, cpgP.Vh_f);
    const f3 = sigmoid(cpg.y[2], cpgP.k_f, cpgP.Vh_f);
    console.log(`t=${sec+1}s  f1=${f1.toFixed(3)} f3=${f3.toFixed(3)} vol=${lung.y[2].toFixed(3)} h1=${cpg.y[5].toFixed(3)} mAD2=${cpg.y[7].toFixed(3)}`);
}

// Now test at 6 BPM drives
console.log('\n=== CPG at 6 BPM drives with HB reflex ===');
const cpg2 = new CPGState();
const lung2 = new LungState();
const cpgP2 = defaultParams();
const dp = driveProfile(6.0);
cpgP2.d1 = BASE_DRIVES.d1 + dp.d1_offset;
cpgP2.d3 = BASE_DRIVES.d3 + dp.d3_offset;
cpgP2.d5 = BASE_DRIVES.d5 + dp.d5_offset;

for (let sec = 0; sec < 30; sec++) {
    for (let i = 0; i < 1000; i++) {
        const hb = heringBreuerDrives(lung2.y, lungP);
        rk4Step(cpg2.y, dt, cpgP2, hb);
        lungRk4Step(lung2.y, dt, cpg2.y, lungP, cpgP2);
        lung2.y[0] = Math.max(0, Math.min(1, lung2.y[0]));
        lung2.y[1] = Math.max(0, lung2.y[1]);
        lung2.y[2] = Math.max(0, lung2.y[2]);
    }
    const f1 = sigmoid(cpg2.y[0], cpgP2.k_f, cpgP2.Vh_f);
    const f3 = sigmoid(cpg2.y[2], cpgP2.k_f, cpgP2.Vh_f);
    console.log(`t=${sec+1}s  f1=${f1.toFixed(3)} f3=${f3.toFixed(3)} vol=${lung2.y[2].toFixed(3)} h1=${cpg2.y[5].toFixed(3)} mAD2=${cpg2.y[7].toFixed(3)}`);
}
