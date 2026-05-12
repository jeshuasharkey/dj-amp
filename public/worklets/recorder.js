// Continuously fills a stereo ring buffer with the latest audio.
// Main thread can request a grab of the last N samples (rear-looking capture).
// Sized for 4-bar loops at slow tempos: 4 bars × 4 beats × (60/60 BPM) = 16s, so 32s gives headroom.
const RING_SECONDS = 32;

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.ceil(sampleRate * RING_SECONDS);
    this.ch0 = new Float32Array(this.size);
    this.ch1 = new Float32Array(this.size);
    this.writeIdx = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'grab') {
        const n = Math.min(e.data.samples, this.size);
        const out0 = new Float32Array(n);
        const out1 = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const idx = (this.writeIdx - n + i + this.size) % this.size;
          out0[i] = this.ch0[idx];
          out1[i] = this.ch1[idx];
        }
        this.port.postMessage(
          { type: 'grabbed', id: e.data.id, ch0: out0, ch1: out1 },
          [out0.buffer, out1.buffer]
        );
      }
    };
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const in0 = inp[0];
    const in1 = inp[1] || inp[0];
    for (let i = 0; i < in0.length; i++) {
      this.ch0[this.writeIdx] = in0[i];
      this.ch1[this.writeIdx] = in1[i];
      this.writeIdx = (this.writeIdx + 1) % this.size;
    }
    return true;
  }
}

registerProcessor('recorder', Recorder);
