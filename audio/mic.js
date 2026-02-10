/**
 * Microphone capture with WebAudio API.
 *
 * Audio graph:
 *   getUserMedia -> MediaStreamSource -> BiquadFilter(bandpass) -> AudioWorkletNode
 *
 * The BiquadFilterNode replaces the Python bandpass filter.
 * The AudioWorklet runs the envelope follower + threshold detection.
 */

export class MicCapture {
    constructor(onBreathEvent) {
        this.onBreathEvent = onBreathEvent;
        this.audioCtx = null;
        this.stream = null;
        this.active = false;
    }

    async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });

        this.audioCtx = new AudioContext();
        const source = this.audioCtx.createMediaStreamSource(this.stream);

        // Bandpass filter: 100-2000 Hz (breath sound range)
        const bandpass = this.audioCtx.createBiquadFilter();
        bandpass.type = 'bandpass';
        const fLow = 100, fHigh = 2000;
        bandpass.frequency.value = Math.sqrt(fLow * fHigh);
        bandpass.Q.value = Math.sqrt(fLow * fHigh) / (fHigh - fLow);

        // Load AudioWorklet processor
        await this.audioCtx.audioWorklet.addModule('audio/breath-detector.js');
        const detector = new AudioWorkletNode(this.audioCtx, 'breath-detector');

        detector.port.onmessage = (e) => {
            this.onBreathEvent(e.data);
        };

        source.connect(bandpass).connect(detector);
        // Don't connect to destination (no audio output)

        this.active = true;
    }

    stop() {
        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) {
                track.stop();
            }
            this.stream = null;
        }
        this.active = false;
    }
}
