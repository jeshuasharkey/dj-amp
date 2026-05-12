// Real-time BPM detection via low-band energy onsets + inter-onset autocorrelation,
// plus a tap-tempo fallback for setting the downbeat. The two combine well:
// auto-detection picks the BPM, the user taps once on "1" to establish phase.

export class BeatTracker {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private energyHistory: number[] = [];
  private onsets: number[] = [];
  private historySize = 43;
  private rafId: number | null = null;

  bpm = 120;
  bpmConfidence = 0;
  downbeat: number | null = null;
  beatsPerBar = 4;

  private tapTimes: number[] = [];

  constructor(ctx: AudioContext, source: AudioNode) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    source.connect(this.analyser);
  }

  start(): void {
    const loop = () => {
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private tick(): void {
    this.analyser.getByteFrequencyData(this.freqData);
    const nyquist = this.ctx.sampleRate / 2;
    const binHz = nyquist / this.freqData.length;
    const lowStart = Math.max(1, Math.floor(40 / binHz));
    const lowEnd = Math.min(this.freqData.length - 1, Math.floor(200 / binHz));
    let energy = 0;
    for (let i = lowStart; i <= lowEnd; i++) energy += this.freqData[i];

    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.historySize) this.energyHistory.shift();
    const avg = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;

    const now = this.ctx.currentTime;
    const last = this.onsets[this.onsets.length - 1] ?? -1;
    // Threshold: significantly above moving avg, and not within 150ms of last onset
    if (energy > avg * 1.5 && energy > 60 && now - last > 0.15) {
      this.onsets.push(now);
      if (this.onsets.length > 32) this.onsets.shift();
      this.estimateBPM();
      this.alignPhase(now);
    }
  }

  // Once we're confident in the BPM, seed the downbeat from the most recent onset
  // so the bar phase has an anchor without requiring a user tap. On every later
  // onset, nudge the anchor toward the nearest beat boundary so we track drift
  // and recover from a noisy initial guess. Picks an arbitrary beat as "1" —
  // good enough for a visual tempo check; the user can still tap to reset phase.
  private alignPhase(onsetTime: number): void {
    if (this.bpmConfidence < 0.3) return;
    if (this.downbeat === null) {
      this.downbeat = onsetTime;
      return;
    }
    const beatDur = 60 / this.bpm;
    const elapsed = onsetTime - this.downbeat;
    const wrapped = ((elapsed % beatDur) + beatDur) % beatDur;
    // Signed offset to the nearest beat boundary, in (-beatDur/2, beatDur/2].
    const offset = wrapped > beatDur / 2 ? wrapped - beatDur : wrapped;
    // Gentle correction so a single off-beat onset can't yank the phase.
    this.downbeat += offset * 0.15;
  }

  private estimateBPM(): void {
    if (this.onsets.length < 6) return;
    const intervals: number[] = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const dt = this.onsets[i] - this.onsets[i - 1];
      if (dt > 0.2 && dt < 1.5) intervals.push(dt);
    }
    if (intervals.length < 4) return;

    // Fold each interval into 90-180 BPM range so doubletime/halftime collapse together.
    // The previous 60-120 range biased low (modern DJ music is usually 110-140 BPM),
    // so detection consistently came back at half-time — this lands it in the right octave.
    const folded = intervals.map(iv => {
      let v = iv;
      while (v < 60 / 180) v *= 2;
      while (v > 60 / 90) v /= 2;
      return v;
    });
    folded.sort((a, b) => a - b);
    const median = folded[Math.floor(folded.length / 2)];
    const bpm = 60 / median;

    // Smooth a little so the displayed BPM doesn't jitter every onset.
    this.bpm = this.bpmConfidence > 0.2 ? this.bpm * 0.7 + bpm * 0.3 : bpm;
    this.bpmConfidence = Math.min(1, intervals.length / 16);
  }

  // User tap on every beat (or every 1). Two consecutive taps already give a BPM.
  // The most recent tap is also treated as a downbeat anchor for phase.
  tap(): void {
    const now = this.ctx.currentTime;
    if (this.tapTimes.length && now - this.tapTimes[this.tapTimes.length - 1] > 2) {
      this.tapTimes = [];
    }
    this.tapTimes.push(now);
    if (this.tapTimes.length > 4) this.tapTimes.shift();
    if (this.tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.tapTimes.length; i++) sum += this.tapTimes[i] - this.tapTimes[i - 1];
      const avg = sum / (this.tapTimes.length - 1);
      this.bpm = 60 / avg;
      this.bpmConfidence = 1;
    }
    this.downbeat = now;
  }

  reset(): void {
    this.tapTimes = [];
    this.onsets = [];
    this.energyHistory = [];
    this.downbeat = null;
    this.bpmConfidence = 0;
  }

  beatDuration(): number { return 60 / this.bpm; }
  barDuration(): number { return this.beatDuration() * this.beatsPerBar; }

  // ctx.currentTime of the next bar boundary, given the current downbeat.
  // If no downbeat is set, returns now (no quantization).
  nextBar(): number {
    if (this.downbeat === null) return this.ctx.currentTime;
    const barDur = this.barDuration();
    const elapsed = this.ctx.currentTime - this.downbeat;
    const barsElapsed = Math.floor(elapsed / barDur);
    return this.downbeat + (barsElapsed + 1) * barDur;
  }

  // Current position within the bar in [0, 1).
  barPhase(): number {
    if (this.downbeat === null) return 0;
    const barDur = this.barDuration();
    const elapsed = this.ctx.currentTime - this.downbeat;
    return ((elapsed % barDur) + barDur) % barDur / barDur;
  }
}
