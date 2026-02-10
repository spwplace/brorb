/**
 * Brorb — main entry point.
 *
 * Wires simulation, renderer, debug panel, and mic together.
 * No server needed — everything runs in the browser.
 */

import { Simulation } from './sim/simulation.js';
import { OrbRenderer } from './vis/orb.js';
import { DebugPanel } from './vis/debug.js';
import { MicCapture } from './audio/mic.js';

const canvas = document.getElementById('canvas');
const renderer = new OrbRenderer(canvas);
const debug = new DebugPanel();
const sim = new Simulation(4.0);

// Status elements
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('connection-dot');
const textEl = document.getElementById('status-text');

// Mic setup — deferred to first user gesture (browser autoplay policy)
let mic = null;
let micInitiated = false;

async function initMic() {
    if (micInitiated) return;
    micInitiated = true;

    try {
        mic = new MicCapture((event) => {
            sim.applyBreathEvent(event);
        });
        await mic.start();
        dotEl.classList.add('connected');
        statusEl.classList.add('connected');
        textEl.textContent = 'breathing';
    } catch (e) {
        console.warn('Mic not available:', e);
        textEl.textContent = 'no mic';
    }
}

document.addEventListener('click', initMic, { once: true });
document.addEventListener('touchstart', initMic, { once: true });

// Main loop
let lastTime = performance.now();

function loop(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    const state = sim.tick(dt);
    renderer.render(state);
    debug.update(state);

    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
