export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  filter: BiquadFilterNode;
  hpKill: BiquadFilterNode;
  lpKill: BiquadFilterNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  delaySend: GainNode;
  reverbSend: GainNode;
  dryGain: GainNode;
  bitcrushDry: GainNode;
  bitcrushSteps: { wet: GainNode; bits: number }[];
}

// Light → destroyed. Same parallel-crossfade design as the gate: only one wet
// path is non-zero at a time, all others stay at 0, so the sum-into-output is
// effectively a single-stage selector.
export const BITCRUSH_BITS = [5, 3] as const;

export function buildFxChain(ctx: AudioContext): FxChain {
  const nyquist = Math.floor(ctx.sampleRate / 2) - 1;

  // EQ kills: transparent at rest, swept to a kill frequency on hold.
  const hpKill = ctx.createBiquadFilter();
  hpKill.type = 'highpass';
  hpKill.frequency.value = 20;
  hpKill.Q.value = 0.707;

  const lpKill = ctx.createBiquadFilter();
  lpKill.type = 'lowpass';
  lpKill.frequency.value = nyquist;
  lpKill.Q.value = 0.707;

  // Main filter (filter sweep + manual cutoff control)
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(20000, nyquist);
  filter.Q.value = 1;

  const dryGain = ctx.createGain();
  dryGain.gain.value = 1;

  // Echo: delay → feedback → back into delay; tap to mix via delaySend
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.375;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.4;
  const delaySend = ctx.createGain();
  delaySend.gain.value = 0;

  // Reverb: convolver with synthesized exponential-decay noise IR
  const convolver = ctx.createConvolver();
  convolver.buffer = synthIR(ctx, 2.8, 2.5);
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0;

  // Pre-bitcrush mix point (sums dry + delay tap + reverb tap)
  const preBitcrush = ctx.createGain();
  preBitcrush.gain.value = 1;

  // Bitcrush: dry path + one waveshaper-wet path per bit depth, all summed.
  // Active step ramps its wet→1 and dry→0; everything else stays at 0.
  const bitcrushDry = ctx.createGain();
  bitcrushDry.gain.value = 1;

  const output = ctx.createGain();
  output.gain.value = 1;

  // Wire: hpKill → lpKill → filter → {dry, delay-send, reverb-send} → preBitcrush
  //                                  → {dry-path, N × (waveshaper → wet-path)} → output
  hpKill.connect(lpKill);
  lpKill.connect(filter);

  filter.connect(dryGain).connect(preBitcrush);

  filter.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(preBitcrush);

  filter.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(preBitcrush);

  preBitcrush.connect(bitcrushDry).connect(output);

  const bitcrushSteps = BITCRUSH_BITS.map(bits => {
    const crusher = ctx.createWaveShaper();
    crusher.curve = makeBitCrushCurve(bits);
    crusher.oversample = 'none';
    const wet = ctx.createGain();
    wet.gain.value = 0;
    preBitcrush.connect(crusher).connect(wet).connect(output);
    return { wet, bits };
  });

  return {
    input: hpKill,
    output,
    filter, hpKill, lpKill,
    delay, delayFeedback, delaySend, reverbSend,
    dryGain, bitcrushDry, bitcrushSteps,
  };
}

function makeBitCrushCurve(bits: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const levels = Math.pow(2, bits);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

function synthIR(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

// Smooth ramp to avoid clicks when toggling gate / kill.
export function rampTo(param: AudioParam, value: number, time: number, ms = 8): void {
  param.cancelScheduledValues(time);
  param.setValueAtTime(param.value, time);
  param.linearRampToValueAtTime(value, time + ms / 1000);
}
