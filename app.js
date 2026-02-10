/**
 * Brorb — main entry point.
 *
 * Wires simulation, renderer, debug panel, dashboard, and mic together.
 * No server needed — everything runs in the browser.
 *
 * Keys:
 *   v — toggle between orb view and dashboard view
 *   d — toggle debug overlay (orb view only)
 */

import { Simulation } from './sim/simulation.js';
import { OrbRenderer } from './vis/orb.js';
import { DebugPanel } from './vis/debug.js';
import { Dashboard } from './vis/dashboard.js';
import { MicCapture } from './audio/mic.js';

const canvas = document.getElementById('canvas');
const renderer = new OrbRenderer(canvas);
const debug = new DebugPanel();
const sim = new Simulation(6.0);
const dashboard = new Dashboard(sim);

// Status elements
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('connection-dot');
const textEl = document.getElementById('status-text');

// View toggle helper
function setView(showDashboard) {
    if (dashboard.visible !== showDashboard) dashboard.toggle();
    canvas.style.display = dashboard.visible ? 'none' : 'block';
    statusEl.style.display = dashboard.visible ? 'none' : '';
    window.location.hash = dashboard.visible ? 'panel' : '';
}

// 'v' key toggles view
window.addEventListener('keydown', (e) => {
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        setView(!dashboard.visible);
    }
});

// #panel hash → open dashboard on load
if (window.location.hash === '#panel') {
    setView(true);
}

// Respond to hash changes (e.g. back/forward)
window.addEventListener('hashchange', () => {
    setView(window.location.hash === '#panel');
});

// Hint — fade after 5s or first keypress
const hintEl = document.getElementById('hint');
const dismissHint = () => hintEl.classList.add('fade');
setTimeout(dismissHint, 5000);
window.addEventListener('keydown', dismissHint, { once: true });

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

    if (!dashboard.visible) {
        renderer.render(state);
        debug.update(state);
    }

    dashboard.update(state);

    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
