"""
Microphone breath detection.

Captures audio via sounddevice, applies bandpass filtering,
computes signal envelope, and detects inhale/exhale onsets
using an adaptive threshold.

Outputs breath phase events for CPG entrainment.
"""

import asyncio
import time
import numpy as np

try:
    import sounddevice as sd
    HAS_SOUNDDEVICE = True
except (ImportError, OSError):
    HAS_SOUNDDEVICE = False


# ── Bandpass filter (simple biquad) ───────────────────────────────────

def design_bandpass(low_hz, high_hz, sample_rate):
    """
    Design a simple second-order bandpass filter (biquad coefficients).
    Uses the bilinear transform of an analog bandpass.
    Returns (b, a) coefficient arrays.
    """
    w_low = 2.0 * np.pi * low_hz / sample_rate
    w_high = 2.0 * np.pi * high_hz / sample_rate
    w0 = np.sqrt(w_low * w_high)
    bw = w_high - w_low
    Q = w0 / bw

    # Bilinear-transformed biquad bandpass
    w0d = 2.0 * np.tan(w0 / 2.0)
    alpha = w0d / (2.0 * Q)

    b0 = alpha
    b1 = 0.0
    b2 = -alpha
    a0 = 1.0 + alpha
    a1 = -2.0 * np.cos(w0)
    # Use pre-warped center frequency for a1
    a1 = -(1.0 - (w0d * w0d / 4.0)) / (1.0 + alpha) * 2.0
    a2 = (1.0 - alpha) / a0

    b = np.array([b0/a0, b1/a0, b2/a0])
    a = np.array([1.0, a1, a2])
    return b, a


class BiquadFilter:
    """Stateful biquad IIR filter."""

    def __init__(self, b, a):
        self.b = b
        self.a = a
        self.z1 = 0.0
        self.z2 = 0.0

    def process(self, x):
        """Process a single sample. Returns filtered sample."""
        y = self.b[0] * x + self.z1
        self.z1 = self.b[1] * x - self.a[1] * y + self.z2
        self.z2 = self.b[2] * x - self.a[2] * y
        return y

    def process_block(self, block):
        """Process a block of samples. Returns filtered block."""
        out = np.empty_like(block)
        for i in range(len(block)):
            out[i] = self.process(block[i])
        return out


# ── Breath detector ───────────────────────────────────────────────────

class BreathEvent:
    """A detected breath event."""
    __slots__ = ("kind", "timestamp", "strength")

    def __init__(self, kind, timestamp, strength=0.0):
        self.kind = kind           # "inhale_start", "exhale_start"
        self.timestamp = timestamp
        self.strength = strength   # relative amplitude

    def __repr__(self):
        return f"BreathEvent({self.kind}, t={self.timestamp:.3f}, s={self.strength:.3f})"


class BreathDetector:
    """
    Detects breath events from audio using envelope tracking
    and adaptive thresholding.
    """

    def __init__(self, sample_rate=16000):
        self.sample_rate = sample_rate

        # Bandpass filter for breath noise (~100-2000 Hz)
        b, a = design_bandpass(100.0, 2000.0, sample_rate)
        self.bp_filter = BiquadFilter(b, a)

        # Envelope follower
        self.envelope = 0.0
        self.env_attack = 0.02    # fast attack (20ms equivalent)
        self.env_release = 0.15   # slow release

        # Adaptive threshold
        self.env_mean = 0.01
        self.env_var = 0.001
        self.adapt_rate = 0.005   # how fast the threshold adapts

        # State machine
        self.in_breath = False
        self.last_event_time = 0.0
        self.min_breath_gap = 1.0  # minimum seconds between events
        self.onset_threshold_mult = 2.5   # multiplier above mean for onset
        self.offset_threshold_mult = 1.2  # multiplier for offset

        # Pending events
        self._events = []

    def process_block(self, audio_block, block_time):
        """
        Process a block of audio samples.

        Parameters
        ----------
        audio_block : ndarray (N,) float32/float64
            Mono audio samples.
        block_time : float
            Timestamp of the start of this block.

        Returns
        -------
        events : list of BreathEvent
        """
        # Bandpass filter
        filtered = self.bp_filter.process_block(audio_block.astype(np.float64))

        # Compute per-sample envelope and detect events
        events = []
        samples_per_ms = self.sample_rate / 1000.0
        dt = 1.0 / self.sample_rate

        for i, sample in enumerate(filtered):
            t = block_time + i / self.sample_rate
            amp = abs(sample)

            # Envelope follower (asymmetric attack/release)
            if amp > self.envelope:
                alpha = 1.0 - np.exp(-dt / self.env_attack)
                self.envelope += alpha * (amp - self.envelope)
            else:
                alpha = 1.0 - np.exp(-dt / self.env_release)
                self.envelope += alpha * (amp - self.envelope)

            # Update adaptive statistics (slow)
            self.env_mean += self.adapt_rate * dt * (self.envelope - self.env_mean)
            diff = self.envelope - self.env_mean
            self.env_var += self.adapt_rate * dt * (diff * diff - self.env_var)

            # Thresholds
            std = max(np.sqrt(self.env_var), 1e-6)
            onset_thresh = self.env_mean + self.onset_threshold_mult * std
            offset_thresh = self.env_mean + self.offset_threshold_mult * std

            # State machine
            if not self.in_breath:
                if self.envelope > onset_thresh and (t - self.last_event_time) > self.min_breath_gap:
                    self.in_breath = True
                    self.last_event_time = t
                    events.append(BreathEvent(
                        "exhale_start", t,
                        strength=self.envelope / max(self.env_mean, 1e-6)
                    ))
            else:
                if self.envelope < offset_thresh:
                    self.in_breath = False

        return events


# ── Async microphone capture ──────────────────────────────────────────

class MicCapture:
    """
    Async wrapper around sounddevice for continuous microphone capture.
    Runs the audio callback and pushes BreathEvents to an asyncio queue.
    """

    def __init__(self, sample_rate=16000, block_size=800):
        self.sample_rate = sample_rate
        self.block_size = block_size  # 50ms at 16kHz
        self.detector = BreathDetector(sample_rate)
        self.event_queue = None
        self._stream = None
        self._start_time = None

    async def start(self, loop=None):
        """Start capturing audio."""
        if not HAS_SOUNDDEVICE:
            print("Warning: sounddevice not available, microphone disabled")
            return False

        self.event_queue = asyncio.Queue()
        self._start_time = time.monotonic()

        if loop is None:
            loop = asyncio.get_event_loop()

        def audio_callback(indata, frames, time_info, status):
            if status:
                pass  # ignore overflows etc
            mono = indata[:, 0].copy()
            block_time = time.monotonic() - self._start_time
            events = self.detector.process_block(mono, block_time)
            for ev in events:
                loop.call_soon_threadsafe(self.event_queue.put_nowait, ev)

        try:
            self._stream = sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                blocksize=self.block_size,
                dtype="float32",
                callback=audio_callback,
            )
            self._stream.start()
            print(f"Microphone active (rate={self.sample_rate}, block={self.block_size})")
            return True
        except Exception as e:
            print(f"Warning: could not open microphone: {e}")
            return False

    async def stop(self):
        """Stop capturing."""
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    async def get_event(self, timeout=None):
        """Get next breath event (async)."""
        if self.event_queue is None:
            return None
        try:
            if timeout is not None:
                return await asyncio.wait_for(self.event_queue.get(), timeout)
            else:
                return await self.event_queue.get()
        except asyncio.TimeoutError:
            return None
