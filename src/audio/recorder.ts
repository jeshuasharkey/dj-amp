// Wraps the ring-buffer recorder worklet: taps an upstream node and continuously
// fills a rear-looking ring buffer, so the main thread can grab the last N samples
// at any time. The tap point decides what gets captured — the Looper taps the raw
// source (so loops re-run through gate + FX), the Sampler taps the post-FX output
// (so samples are printed with all effects baked in).
export class TapRecorder {
  private ctx: AudioContext;
  private node: AudioWorkletNode;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
  }

  static async create(ctx: AudioContext, source: AudioNode): Promise<TapRecorder> {
    await ctx.audioWorklet.addModule('/worklets/recorder.js');
    const node = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    source.connect(node);
    return new TapRecorder(ctx, node);
  }

  // Grab the last `samples` samples from the ring buffer as a stereo AudioBuffer.
  grab(samples: number): Promise<AudioBuffer> {
    return new Promise(resolve => {
      const id = Math.random();
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'grabbed' && e.data.id === id) {
          this.node.port.removeEventListener('message', handler);
          const ch0: Float32Array = e.data.ch0;
          const ch1: Float32Array = e.data.ch1;
          const buf = this.ctx.createBuffer(2, ch0.length, this.ctx.sampleRate);
          buf.getChannelData(0).set(ch0);
          buf.getChannelData(1).set(ch1);
          resolve(buf);
        }
      };
      this.node.port.addEventListener('message', handler);
      this.node.port.start();
      this.node.port.postMessage({ type: 'grab', samples, id });
    });
  }
}
