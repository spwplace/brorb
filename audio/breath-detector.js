/**
 * AudioWorklet processor for breath detection.
 *
 * Runs in the audio thread. Receives bandpass-filtered audio from
 * a BiquadFilterNode upstream. Computes envelope, applies adaptive
 * threshold, and posts breath events to the main thread.
 *
 * Must be self-contained (no ES module imports in WorkletGlobalScope).
 */

class BreathDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Envelope follower
        this.envelope = 0;
        this.envAttack = 0.02;    // 20ms
        this.envRelease = 0.15;   // 150ms

        // Adaptive threshold
        this.envMean = 0.01;
        this.envVar = 0.001;
        this.adaptRate = 0.005;

        // State machine
        this.inBreath = false;
        this.lastEventTime = 0;
        this.minBreathGap = 1.0;
        this.onsetThresholdMult = 2.5;
        this.offsetThresholdMult = 1.2;

        // Time tracking
        this.sampleCount = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];
        const dt = 1.0 / sampleRate;

        for (let i = 0; i < samples.length; i++) {
            const t = this.sampleCount / sampleRate;
            const amp = Math.abs(samples[i]);

            // Envelope follower (asymmetric attack/release)
            if (amp > this.envelope) {
                const alpha = 1.0 - Math.exp(-dt / this.envAttack);
                this.envelope += alpha * (amp - this.envelope);
            } else {
                const alpha = 1.0 - Math.exp(-dt / this.envRelease);
                this.envelope += alpha * (amp - this.envelope);
            }

            // Update adaptive statistics
            this.envMean += this.adaptRate * dt * (this.envelope - this.envMean);
            const diff = this.envelope - this.envMean;
            this.envVar += this.adaptRate * dt * (diff * diff - this.envVar);

            // Thresholds
            const std = Math.max(Math.sqrt(this.envVar), 1e-6);
            const onsetThresh = this.envMean + this.onsetThresholdMult * std;
            const offsetThresh = this.envMean + this.offsetThresholdMult * std;

            // State machine
            if (!this.inBreath) {
                if (this.envelope > onsetThresh && (t - this.lastEventTime) > this.minBreathGap) {
                    this.inBreath = true;
                    this.lastEventTime = t;
                    this.port.postMessage({
                        kind: 'exhale_start',
                        strength: this.envelope / Math.max(this.envMean, 1e-6),
                    });
                }
            } else {
                if (this.envelope < offsetThresh) {
                    this.inBreath = false;
                }
            }

            this.sampleCount++;
        }

        return true;
    }
}

registerProcessor('breath-detector', BreathDetectorProcessor);
