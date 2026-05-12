import type { BeatTracker } from './beat';

// Master gate sits on the bus that carries both live FX output and loop playback,
// so all audible audio passes through it. Modes:
//   open     – pass-through (gain = 1)
//   kill     – fully muted (gain = 0)
//   rhythmic – square-wave on/off synced to the beat, phase-aligned to the downbeat
//
// "phaseBeats" is the length of one ON or OFF phase in beats:
//   1.0  = 1/4 gate  (one beat on, one beat off)
//   0.5  = 1/8 gate
//   0.25 = 1/16 gate
//   0.125= 1/32 gate
// Even-indexed phases from the downbeat are ON, odd are OFF, so the bar's "1" always lands on an ON.

export type GateMode = 'open' | 'kill' | 'rhythmic';

export class MasterGate {
  private ctx: AudioContext;
  private beat: BeatTracker;
  private timer: number | null = null;
  private nextEdge = 0;
  private lastValue = 1;
  private phaseBeats = 0;

  readonly node: GainNode;
  mode: GateMode = 'open';

  constructor(ctx: AudioContext, beat: BeatTracker) {
    this.ctx = ctx;
    this.beat = beat;
    this.node = ctx.createGain();
    this.node.gain.value = 1;
  }

  kill(): void {
    this.cancelTimer();
    this.mode = 'kill';
    const t = this.ctx.currentTime;
    this.node.gain.cancelScheduledValues(t);
    this.node.gain.setValueAtTime(this.node.gain.value, t);
    this.node.gain.linearRampToValueAtTime(0, t + 0.005);
    this.lastValue = 0;
  }

  open(): void {
    this.cancelTimer();
    this.mode = 'open';
    const t = this.ctx.currentTime;
    this.node.gain.cancelScheduledValues(t);
    this.node.gain.setValueAtTime(this.node.gain.value, t);
    this.node.gain.linearRampToValueAtTime(1, t + 0.008);
    this.lastValue = 1;
  }

  rhythmic(phaseBeats: number): void {
    this.cancelTimer();
    this.mode = 'rhythmic';
    this.phaseBeats = phaseBeats;

    const phase = phaseBeats * this.beat.beatDuration();
    const downbeat = this.beat.downbeat ?? this.ctx.currentTime;

    // Compute the current slot relative to the downbeat
    const elapsed = this.ctx.currentTime - downbeat;
    const slotIndex = Math.floor(elapsed / phase);
    const currentValue = slotIndex % 2 === 0 ? 1 : 0;
    this.nextEdge = downbeat + (slotIndex + 1) * phase;

    // Land cleanly on the current slot value to avoid an initial pop
    const now = this.ctx.currentTime;
    this.node.gain.cancelScheduledValues(now);
    this.node.gain.setValueAtTime(this.node.gain.value, now);
    this.node.gain.linearRampToValueAtTime(currentValue, now + 0.005);
    this.lastValue = currentValue;

    this.tick();
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  private tick(): void {
    if (this.mode !== 'rhythmic') return;
    // BPM may have changed since rhythmic() was called; refresh phase each tick.
    const phase = this.phaseBeats * this.beat.beatDuration();
    const lookahead = 0.4;
    const now = this.ctx.currentTime;
    while (this.nextEdge < now + lookahead) {
      const target = this.lastValue === 0 ? 1 : 0;
      const anchor = Math.max(now, this.nextEdge - 0.002);
      this.node.gain.setValueAtTime(this.lastValue, anchor);
      this.node.gain.linearRampToValueAtTime(target, this.nextEdge);
      this.lastValue = target;
      this.nextEdge += phase;
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
