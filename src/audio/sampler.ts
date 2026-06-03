import { TapRecorder } from './recorder';

// 8-pad sampler. Workflow:
//   - Hold REC + hold pad → records into that pad while held (its own ring buffer
//     grabs the elapsed window when the pad releases).
//   - Without REC, pressing a pad triggers its sample. The play mode (one-shot
//     vs hold-to-loop) is controlled by the parent via the `holdMode` arg.
// One pad is permanently locked to a synthesized airhorn and cannot be recorded over.
//
// The sampler sits at the very end of the chain: its recorder taps the post-FX
// output, so pads capture audio with all effects (filter/delay/reverb/bitcrush)
// printed in, and playback goes straight to the master out so it's unaffected by
// the FX chain.

export const PAD_COUNT = 8;
export const AIRHORN_PAD = 7;

export class Sampler {
  private ctx: AudioContext;
  private recorder: TapRecorder;
  private output: AudioNode;
  private samples: (AudioBuffer | null)[] = Array(PAD_COUNT).fill(null);
  private locked: boolean[] = Array(PAD_COUNT).fill(false);
  private recordStarts: (number | null)[] = Array(PAD_COUNT).fill(null);
  private active: (AudioBufferSourceNode | null)[] = Array(PAD_COUNT).fill(null);

  onSampleEnded: ((padIdx: number) => void) | null = null;

  constructor(ctx: AudioContext, recorder: TapRecorder, output: AudioNode) {
    this.ctx = ctx;
    this.recorder = recorder;
    this.output = output;
    // Airhorn pad is locked from the start so it can't be recorded over;
    // the buffer fills in once the .wav decodes (a few ms locally).
    this.locked[AIRHORN_PAD] = true;
    loadAirhorn(this.ctx).then(buf => { this.samples[AIRHORN_PAD] = buf; });
  }

  // `source` is the post-FX signal to record from; `output` is the master-out
  // node to play into (downstream of the FX chain).
  static async create(ctx: AudioContext, source: AudioNode, output: AudioNode): Promise<Sampler> {
    const recorder = await TapRecorder.create(ctx, source);
    return new Sampler(ctx, recorder, output);
  }

  startRecord(padIdx: number): void {
    if (this.locked[padIdx]) return;
    this.stopPad(padIdx);
    this.recordStarts[padIdx] = this.ctx.currentTime;
  }

  async endRecord(padIdx: number): Promise<boolean> {
    const start = this.recordStarts[padIdx];
    if (start === null) return false;
    this.recordStarts[padIdx] = null;
    const dur = this.ctx.currentTime - start;
    if (dur < 0.04) return false; // too short — ignore accidental taps
    const samples = Math.floor(dur * this.ctx.sampleRate);
    const buf = await this.recorder.grab(samples);
    this.samples[padIdx] = buf;
    return true;
  }

  triggerPad(padIdx: number, holdMode: boolean): boolean {
    const buf = this.samples[padIdx];
    if (!buf) return false;
    this.stopPad(padIdx);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = holdMode;
    src.connect(this.output);
    src.start();
    this.active[padIdx] = src;
    src.onended = () => {
      if (this.active[padIdx] === src) {
        this.active[padIdx] = null;
        this.onSampleEnded?.(padIdx);
      }
    };
    return true;
  }

  releasePad(padIdx: number, holdMode: boolean): void {
    if (!holdMode) return; // one-shot ignores release
    this.stopPad(padIdx);
  }

  stopPad(padIdx: number): void {
    const src = this.active[padIdx];
    if (!src) return;
    try { src.stop(); } catch {}
    src.disconnect();
    this.active[padIdx] = null;
  }

  hasSample(padIdx: number): boolean { return this.samples[padIdx] !== null; }
  isLocked(padIdx: number): boolean { return this.locked[padIdx]; }
  isRecording(padIdx: number): boolean { return this.recordStarts[padIdx] !== null; }
}

async function loadAirhorn(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch('/samples/airhorn.wav');
  const bytes = await res.arrayBuffer();
  const raw = await ctx.decodeAudioData(bytes);
  return bakeAirhorn(raw);
}

// Render the raw airhorn through an offline graph that scales it down and adds
// a convolution reverb tail. Result is one baked-in buffer — no runtime cost,
// and the airhorn keeps its character regardless of the main reverb send.
async function bakeAirhorn(raw: AudioBuffer): Promise<AudioBuffer> {
  const reverbTail = 2.4;
  const sr = raw.sampleRate;
  const outLen = Math.ceil((raw.duration + reverbTail) * sr);
  const offline = new OfflineAudioContext(2, outLen, sr);

  const src = offline.createBufferSource();
  src.buffer = raw;

  // Dry leg — quieter than the original
  const dry = offline.createGain();
  dry.gain.value = 0.30;

  // Wet leg through a synthesized exponential-decay noise IR
  const wet = offline.createGain();
  wet.gain.value = 0.45;
  const conv = offline.createConvolver();
  conv.buffer = synthIR(offline, reverbTail, 2.6);

  src.connect(dry).connect(offline.destination);
  src.connect(wet).connect(conv).connect(offline.destination);
  src.start();

  return offline.startRendering();
}

function synthIR(ctx: BaseAudioContext, duration: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(duration * sr);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}
