"""
Simulation orchestrator.

Runs the CPG + lung model at ~1kHz, processes microphone breath
events for entrainment, and emits decimated state at ~60Hz for
WebSocket transmission.
"""

import asyncio
import time
import numpy as np

from .cpg import CPGState, default_params, rk4_step, sigmoid
from .lungs import LungState, default_lung_params, lung_rk4_step, hering_breuer_drives
from .mic import MicCapture


class SimState:
    """Complete simulation state snapshot for transmission."""

    __slots__ = (
        "lung_volume", "phase", "phase_progress",
        "f_preI", "f_earlyI", "f_postI", "f_augE", "f_lateE",
        "ramp_I", "breath_detected", "t",
    )

    def __init__(self):
        self.lung_volume = 0.0
        self.phase = "expiration"
        self.phase_progress = 0.0
        self.f_preI = 0.0
        self.f_earlyI = 0.0
        self.f_postI = 0.0
        self.f_augE = 0.0
        self.f_lateE = 0.0
        self.ramp_I = 0.0
        self.breath_detected = False
        self.t = 0.0

    def to_dict(self):
        return {
            "lung_volume": round(self.lung_volume, 4),
            "phase": self.phase,
            "phase_progress": round(self.phase_progress, 4),
            "f_preI": round(self.f_preI, 4),
            "f_earlyI": round(self.f_earlyI, 4),
            "f_postI": round(self.f_postI, 4),
            "f_augE": round(self.f_augE, 4),
            "f_lateE": round(self.f_lateE, 4),
            "ramp_I": round(self.ramp_I, 4),
            "breath_detected": self.breath_detected,
            "t": round(self.t, 4),
        }


def determine_phase(cpg_y, cpg_p):
    """Determine respiratory phase from CPG population activities."""
    f1 = sigmoid(cpg_y[0], cpg_p["k_f"], cpg_p["Vh_f"])  # pre-I/I
    f3 = sigmoid(cpg_y[2], cpg_p["k_f"], cpg_p["Vh_f"])  # post-I
    f4 = sigmoid(cpg_y[3], cpg_p["k_f"], cpg_p["Vh_f"])  # aug-E

    if f1 > 0.4:
        return "inspiration"
    elif f3 > 0.4:
        return "post-inspiration"
    else:
        return "expiration"


class Simulation:
    """
    Main simulation loop.

    Integrates the CPG and lung models, handles mic entrainment,
    and produces state snapshots for clients.
    """

    def __init__(self, target_bpm=4.0, use_mic=True):
        self.dt = 0.001  # 1ms integration step
        self.output_rate = 60  # Hz, decimation target
        self.steps_per_output = int(1.0 / (self.dt * self.output_rate))

        # Models
        self.cpg_params = default_params(target_bpm)
        self.lung_params = default_lung_params()
        self.cpg_state = CPGState()
        self.lung_state = LungState()

        # Time
        self.t = 0.0
        self.step_count = 0

        # Mic
        self.use_mic = use_mic
        self.mic = MicCapture() if use_mic else None

        # Entrainment
        self.entrain_pulse = 0.0          # current entrainment pulse amplitude
        self.entrain_decay = 0.995        # per-step decay (exponential)
        self.entrain_strength = 0.8       # coupling strength
        self.breath_detected = False
        self.breath_detect_decay = 0      # countdown for breath_detected flag

        # Output
        self._state_queue = asyncio.Queue(maxsize=120)
        self._running = False

        # Phase tracking for progress
        self._phase_start_t = 0.0
        self._current_phase = "expiration"

    def _step(self):
        """Advance simulation by one dt step."""
        # Compute Hering-Breuer feedback
        hb_drives = hering_breuer_drives(self.lung_state.y, self.lung_params)

        # Add entrainment pulse to pre-I/I drive
        ext_drives = dict(hb_drives)
        if self.entrain_pulse > 0.01:
            ext_drives["drive_1"] = ext_drives.get("drive_1", 0.0) + self.entrain_pulse * self.entrain_strength
            self.entrain_pulse *= self.entrain_decay

        # Step CPG
        self.cpg_state.y = rk4_step(
            self.cpg_state.y, self.dt, self.cpg_params, ext_drives
        )

        # Step lungs
        self.lung_state.y = lung_rk4_step(
            self.lung_state.y, self.dt,
            self.cpg_state.y, self.lung_params, self.cpg_params,
        )

        # Clamp lung state
        self.lung_state.y[0] = np.clip(self.lung_state.y[0], 0.0, 1.0)  # ramp_I
        self.lung_state.y[1] = max(0.0, self.lung_state.y[1])            # x_diaph
        self.lung_state.y[2] = max(0.0, self.lung_state.y[2])            # v_lung

        self.t += self.dt
        self.step_count += 1

        # Decay breath detection flag
        if self.breath_detect_decay > 0:
            self.breath_detect_decay -= 1
        else:
            self.breath_detected = False

    def _snapshot(self):
        """Create a state snapshot."""
        s = SimState()
        s.t = self.t
        s.lung_volume = float(self.lung_state.y[2])

        # Firing rates
        y = self.cpg_state.y
        p = self.cpg_params
        s.f_preI = float(sigmoid(y[0], p["k_f"], p["Vh_f"]))
        s.f_earlyI = float(sigmoid(y[1], p["k_f"], p["Vh_f"]))
        s.f_postI = float(sigmoid(y[2], p["k_f"], p["Vh_f"]))
        s.f_augE = float(sigmoid(y[3], p["k_f"], p["Vh_f"]))
        s.f_lateE = float(sigmoid(y[4], p["k_f"], p["Vh_f"]))

        s.ramp_I = float(self.lung_state.y[0])
        s.breath_detected = self.breath_detected

        # Phase
        phase = determine_phase(y, p)
        if phase != self._current_phase:
            self._current_phase = phase
            self._phase_start_t = self.t
        s.phase = phase
        s.phase_progress = min(1.0, (self.t - self._phase_start_t) / 3.0)  # rough 3s per phase

        return s

    def apply_breath_event(self, event):
        """Apply a detected breath event for entrainment."""
        if event.kind == "exhale_start":
            # User exhale detected — we want to nudge CPG toward
            # expiration if it's not already there. But since exhale
            # is the easiest to detect, and we want to sync the orb,
            # we use it to time the NEXT inspiration.
            # For now: pulse the pre-I/I to help trigger inspiration
            # (works when the CPG is near the I/E transition)
            self.entrain_pulse = max(self.entrain_pulse, event.strength * 0.5)
            self.breath_detected = True
            self.breath_detect_decay = int(0.5 / self.dt)  # 500ms flag

    async def _process_mic_events(self):
        """Continuously read mic events and apply them."""
        if self.mic is None:
            return
        while self._running:
            ev = await self.mic.get_event(timeout=0.1)
            if ev is not None:
                self.apply_breath_event(ev)

    async def run(self):
        """Main simulation loop. Runs until stopped."""
        self._running = True

        # Start mic
        if self.mic is not None:
            loop = asyncio.get_event_loop()
            mic_ok = await self.mic.start(loop)
            if mic_ok:
                asyncio.ensure_future(self._process_mic_events())
            else:
                self.mic = None

        print("Simulation running...")

        # We run the sim in batches to avoid blocking the event loop
        # too long per iteration. Each batch does steps_per_output steps
        # (about 16ms at 60Hz output), then yields to the event loop.
        while self._running:
            t_real_start = time.monotonic()

            # Run a batch of integration steps
            for _ in range(self.steps_per_output):
                self._step()

            # Emit state snapshot
            snap = self._snapshot()
            try:
                self._state_queue.put_nowait(snap)
            except asyncio.QueueFull:
                # Drop oldest
                try:
                    self._state_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                self._state_queue.put_nowait(snap)

            # Sleep to maintain real-time pacing
            t_elapsed = time.monotonic() - t_real_start
            t_target = self.steps_per_output * self.dt
            sleep_time = t_target - t_elapsed
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
            else:
                # We're behind — yield briefly so event loop doesn't starve
                await asyncio.sleep(0)

    async def stop(self):
        """Stop the simulation."""
        self._running = False
        if self.mic is not None:
            await self.mic.stop()

    async def get_state(self):
        """Get next state snapshot (async)."""
        return await self._state_queue.get()
