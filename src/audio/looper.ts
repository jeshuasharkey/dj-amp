import type { BeatTracker } from './beat';

// Forward-looking record-then-loop. Press loop key → live keeps playing while we
// record for the loop's duration. After N beats, the recorded buffer starts
// playing on a loop from its first sample. Release at any time:
//   - during recording: cancel, no playback ever happens
//   - during playback:   fade out the loop and return to live

export class Looper {
  private ctx: AudioContext;
  private beat: BeatTracker;
  private output: AudioNode;
  private recorder: AudioWorkletNode;
  private active: AudioBufferSourceNode | null = null;
  private activeFade: GainNode | null = null;
  private recordTimer: number | null = null;
  // Monotonic id — bumped on every startLoop/stopLoop, used to cancel
  // pending grabs and timeouts when the active loop is changed/cancelled.
  private gen = 0;
  // Current playback rate, applied to whatever source is playing AND inherited
  // by any new source that starts. Lets the loop-pitch slider and tape-stop affect
  // future loops, not just the one that's currently playing.
  private currentRate = 1;

  onRecordingStart: ((beats: number, durationMs: number) => void) | null = null;
  onRecordingCancel: ((beats: number) => void) | null = null;
  onPlaybackStart: ((beats: number) => void) | null = null;
  onPlaybackStop: (() => void) | null = null;

  constructor(ctx: AudioContext, source: AudioNode, output: AudioNode, beat: BeatTracker, recorder: AudioWorkletNode) {
    this.ctx = ctx;
    this.beat = beat;
    this.output = output;
    this.recorder = recorder;
    // The recorder taps the post-FX signal so loops include the FX as printed.
    source.connect(this.recorder);
  }

  static async create(ctx: AudioContext, source: AudioNode, output: AudioNode, beat: BeatTracker): Promise<Looper> {
    await ctx.audioWorklet.addModule('/worklets/recorder.js');
    const recorder = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    return new Looper(ctx, source, output, beat, recorder);
  }

  // Public so the Sampler can reuse the recorder's ring buffer.
  grab(samples: number): Promise<AudioBuffer> {
    return new Promise(resolve => {
      const id = Math.random();
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'grabbed' && e.data.id === id) {
          this.recorder.port.removeEventListener('message', handler);
          const ch0: Float32Array = e.data.ch0;
          const ch1: Float32Array = e.data.ch1;
          const buf = this.ctx.createBuffer(2, ch0.length, this.ctx.sampleRate);
          buf.getChannelData(0).set(ch0);
          buf.getChannelData(1).set(ch1);
          resolve(buf);
        }
      };
      this.recorder.port.addEventListener('message', handler);
      this.recorder.port.start();
      this.recorder.port.postMessage({ type: 'grab', samples, id });
    });
  }

  // Forward record-then-loop. Live keeps playing while we record; after `beats`
  // worth of beats the recorded buffer starts looping from sample 0. Caller is
  // responsible for ducking the live signal when onPlaybackStart fires.
  startLoop(beats: number): void {
    this.stopLoop();
    const myGen = ++this.gen;

    const loopDur = beats * this.beat.beatDuration();
    const samples = Math.floor(loopDur * this.ctx.sampleRate);

    this.onRecordingStart?.(beats, loopDur * 1000);

    this.recordTimer = window.setTimeout(async () => {
      this.recordTimer = null;
      if (myGen !== this.gen) return;

      const buf = await this.grab(samples);
      if (myGen !== this.gen) return;

      this.playBuffer(buf);
      this.onPlaybackStart?.(beats);
    }, loopDur * 1000);
  }

  // Rear-looking reverse roll: grab the last N beats, reverse, loop immediately.
  // No record window — meant for instant "play the recent music backwards" effect.
  async startReverseRoll(beats: number): Promise<void> {
    this.stopLoop();
    const myGen = ++this.gen;
    const samples = Math.floor(beats * this.beat.beatDuration() * this.ctx.sampleRate);
    const buf = await this.grab(samples);
    if (myGen !== this.gen) return;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      buf.getChannelData(ch).reverse();
    }
    this.playBuffer(buf);
  }

  // Freeze: grab a small slice and loop it as a sustained drone, Hann-windowed
  // at the edges so the loop point doesn't click.
  async startFreeze(): Promise<void> {
    this.stopLoop();
    const myGen = ++this.gen;
    const sliceSec = 0.1;
    const samples = Math.floor(sliceSec * this.ctx.sampleRate);
    const buf = await this.grab(samples);
    if (myGen !== this.gen) return;
    const len = buf.length;
    const fadeLen = Math.floor(len / 4);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < fadeLen; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeLen));
        data[i] *= w;
        data[len - 1 - i] *= w;
      }
    }
    this.playBuffer(buf);
  }

  // Set the playback rate (for tape stop + loop pitch). Persists across loop
  // restarts so the slider keeps applying to future loops.
  setPlaybackRate(rate: number, rampMs: number): void {
    const r = Math.max(0.0001, rate);
    this.currentRate = r;
    if (!this.active) return;
    const t = this.ctx.currentTime;
    this.active.playbackRate.cancelScheduledValues(t);
    this.active.playbackRate.setValueAtTime(this.active.playbackRate.value, t);
    this.active.playbackRate.linearRampToValueAtTime(r, t + rampMs / 1000);
  }

  private playBuffer(buf: AudioBuffer): void {
    const startAt = this.ctx.currentTime + 0.005;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = this.currentRate;
    const fade = this.ctx.createGain();
    fade.gain.setValueAtTime(0, startAt);
    fade.gain.linearRampToValueAtTime(1, startAt + 0.004);
    src.connect(fade).connect(this.output);
    src.start(startAt);
    this.active = src;
    this.activeFade = fade;
  }

  stopLoop(): void {
    // Cancel any pending recording
    if (this.recordTimer !== null) {
      clearTimeout(this.recordTimer);
      this.recordTimer = null;
      this.gen++;
      this.onRecordingCancel?.(0);
    }

    // Fade out any active playback
    if (this.active && this.activeFade) {
      const t = this.ctx.currentTime;
      this.activeFade.gain.cancelScheduledValues(t);
      this.activeFade.gain.setValueAtTime(this.activeFade.gain.value, t);
      this.activeFade.gain.linearRampToValueAtTime(0, t + 0.005);
      const src = this.active;
      const fade = this.activeFade;
      setTimeout(() => {
        try { src.stop(); } catch {}
        src.disconnect();
        fade.disconnect();
      }, 12);
      this.active = null;
      this.activeFade = null;
      this.onPlaybackStop?.();
    }
  }

  get isPlaying(): boolean { return this.active !== null; }
  get isRecording(): boolean { return this.recordTimer !== null; }
}
