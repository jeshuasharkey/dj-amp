// Real-time BPM detection by autocorrelation of a bass-weighted spectral-flux
// onset envelope, with a perceptual tempo prior for octave resolution and a
// comb-matched phase estimate for the downbeat. A tap-tempo fallback lets the
// user pin the BPM and the "1" by hand; taps win over auto-detection for a few
// seconds so a manual sync isn't immediately dragged away.
//
// Why autocorrelation rather than inter-onset-interval medians: the envelope is
// integrated over several seconds, so a missed kick or a doubled detection only
// dents one lag's score instead of poisoning the whole estimate. The dominant
// lag is the beat period (or one of its octaves), and the prior picks the octave
// a listener would tap to.

export class BeatTracker {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private prevMag: Float32Array;
  private prevValid = false;

  // Onset-strength envelope, sampled once per animation frame into a ring buffer.
  // We track the real frame interval (meanDt) instead of assuming 60fps, so lag→
  // tempo conversion is correct on 120Hz displays and the math is unit-clean.
  private static readonly ENV_LEN = 1024;
  private env = new Float32Array(BeatTracker.ENV_LEN);
  private work = new Float32Array(BeatTracker.ENV_LEN);
  private envWrite = 0;
  private envCount = 0;
  private meanDt = 1 / 60;
  private lastTick = 0;
  private lastEnvTime = 0;
  private lastEstimate = 0;
  private recentBpm: number[] = []; // recent estimates, median-voted for stability

  bpm = 120;
  bpmConfidence = 0;
  downbeat: number | null = null;
  beatsPerBar = 4;

  private tapTimes: number[] = [];
  private tapLockUntil = 0;

  private rafId: number | null = null;

  constructor(ctx: AudioContext, source: AudioNode) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0; // raw frames — flux needs true frame-to-frame deltas
    this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.prevMag = new Float32Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);
  }

  start(): void {
    this.lastTick = this.ctx.currentTime;
    this.prevValid = false;
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
    const now = this.ctx.currentTime;
    const dt = now - this.lastTick;
    this.lastTick = now;

    if (dt <= 0) return;
    // A long gap means the tab was backgrounded / RAF was paused. The envelope is
    // only meaningful as a continuous signal, so drop it and rebuild rather than
    // autocorrelating across a time hole.
    if (dt > 0.5) {
      this.envCount = 0;
      this.envWrite = 0;
      this.recentBpm = [];
      this.prevValid = false;
      return;
    }
    // A merely janky frame (a hitch, not a sleep): keep the envelope intact but
    // skip this irregular sample so it doesn't smear the uniform-spacing
    // assumption — just re-prime the flux reference and move on.
    if (dt > 0.05) {
      this.analyser.getByteFrequencyData(this.freqData);
      this.computeODF();
      this.prevValid = true;
      return;
    }
    this.meanDt = this.meanDt * 0.95 + dt * 0.05;

    this.analyser.getByteFrequencyData(this.freqData);
    const odf = this.computeODF();
    this.lastEnvTime = now;

    // First good frame after a (re)start primes the flux reference without
    // emitting the artificial "everything just appeared" spike.
    if (!this.prevValid) {
      this.prevValid = true;
      return;
    }

    this.env[this.envWrite] = odf;
    this.envWrite = (this.envWrite + 1) % BeatTracker.ENV_LEN;
    if (this.envCount < BeatTracker.ENV_LEN) this.envCount++;

    if (now - this.lastEstimate > 0.2) {
      this.lastEstimate = now;
      this.estimate(now);
    }
  }

  // Half-wave-rectified spectral flux, weighted toward the low end so the kick
  // dominates (the most reliable beat cue in dance material) while mids still
  // contribute snare/hat transients. Returns the per-frame onset strength.
  private computeODF(): number {
    const f = this.freqData;
    const prev = this.prevMag;
    const nyquist = this.ctx.sampleRate / 2;
    const binHz = nyquist / f.length;
    const lowEnd = Math.min(f.length - 1, Math.max(1, Math.floor(200 / binHz)));
    const midEnd = Math.min(f.length - 1, Math.floor(4000 / binHz));

    let flux = 0;
    for (let i = 1; i <= lowEnd; i++) {
      const d = f[i] - prev[i];
      if (d > 0) flux += d;
      prev[i] = f[i];
    }
    for (let i = lowEnd + 1; i <= midEnd; i++) {
      const d = f[i] - prev[i];
      if (d > 0) flux += d * 0.3;
      prev[i] = f[i];
    }
    for (let i = midEnd + 1; i < f.length; i++) prev[i] = f[i];
    return flux;
  }

  private estimate(now: number): void {
    if (now < this.tapLockUntil) return; // a manual tap owns the tempo for now

    // Use the most recent ~8s of envelope: long enough for sharp autocorrelation
    // peaks, short enough to follow a real tempo change in a mix.
    const win = Math.min(this.envCount, Math.round(8 / this.meanDt));
    if (win < Math.round(2.5 / this.meanDt)) return; // need a couple of seconds first

    // Flatten the ring into chronological order (work[0] oldest, work[win-1] newest).
    const start = ((this.envWrite - win) % BeatTracker.ENV_LEN + BeatTracker.ENV_LEN) % BeatTracker.ENV_LEN;
    const work = this.work;
    let mean = 0;
    for (let j = 0; j < win; j++) {
      const v = this.env[(start + j) % BeatTracker.ENV_LEN];
      work[j] = v;
      mean += v;
    }
    mean /= win;

    const minBpm = 70, maxBpm = 180;
    const lagMin = Math.max(1, Math.round(60 / (maxBpm * this.meanDt)));
    const lagMax = Math.min(win - 1, Math.round(60 / (minBpm * this.meanDt)));
    if (lagMax <= lagMin) return;

    // Normalized autocorrelation: ac[lag]/energy behaves like a correlation
    // coefficient in [-1, 1], so the confidence threshold means the same thing
    // regardless of how loud the input is.
    let energy = 0;
    for (let i = 0; i < win; i++) { const d = work[i] - mean; energy += d * d; }
    if (energy <= 0) return;

    const ac = new Float32Array(lagMax + 1);
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0;
      for (let i = lag; i < win; i++) s += (work[i] - mean) * (work[i - lag] - mean);
      ac[lag] = s / energy;
    }

    // Score every lag by autocorrelation × a log-normal tempo prior (centered on a
    // typical dance tempo). The prior pulls the estimate toward the octave a
    // listener would tap, instead of locking onto whichever raw lag is tallest —
    // half/double-time are also strong peaks, so without it the value flip-flops.
    const prior = (bpm: number) => {
      const x = Math.log2(bpm / 125) / 0.5;
      return Math.exp(-0.5 * x * x);
    };
    let bestLag = lagMin, bestScore = -Infinity;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const score = ac[lag] * prior(60 / (lag * this.meanDt));
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    const peak = ac[bestLag];
    // Nothing periodic enough this frame: hold the last tempo, let confidence ebb.
    if (peak < 0.05) { this.bpmConfidence *= 0.9; return; }

    // Parabolic interpolation around the chosen lag for sub-bin BPM precision.
    let refined = bestLag;
    if (bestLag > lagMin && bestLag < lagMax) {
      const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom !== 0) {
        const delta = 0.5 * (y0 - y2) / denom;
        if (Math.abs(delta) <= 1) refined = bestLag + delta;
      }
    }
    let bpm = 60 / (refined * this.meanDt);
    const confidence = Math.min(1, peak * 2);
    const prevConf = this.bpmConfidence;

    // Octave lock: once a tempo is held, fold a half/double-time estimate back into
    // the held octave so the displayed BPM can't suddenly jump by 2×.
    if (prevConf > 0.2) {
      while (bpm > this.bpm * 1.4) bpm /= 2;
      while (bpm < this.bpm * 0.72) bpm *= 2;
    }

    // Median-vote over ~1.2s of estimates, then glide toward the vote. The median
    // discards single-frame outliers outright; the glide keeps the number from
    // twitching. Together these are what stop the display being "chaotic".
    this.recentBpm.push(bpm);
    if (this.recentBpm.length > 6) this.recentBpm.shift();
    const voted = [...this.recentBpm].sort((a, b) => a - b)[this.recentBpm.length >> 1];

    if (prevConf < 0.2) this.bpm = voted;                 // first lock — jump there
    else this.bpm = this.bpm * 0.85 + voted * 0.15;       // otherwise glide gently
    this.bpmConfidence = Math.max(confidence, prevConf * 0.8);
    this.alignPhase(work, win, this.bpmConfidence);
  }

  // Find the beat phase by comb-matching the envelope at the detected period: the
  // offset whose pulse train best sums the recent onset energy is the latest beat.
  // Seeds the downbeat when there's none (an arbitrary beat becomes "1", same as
  // before), then nudges gently so a single noisy frame can't yank the grid.
  private alignPhase(work: Float32Array, win: number, confidence: number): void {
    if (confidence < 0.35) return;
    const beatDur = 60 / this.bpm;
    const pSamp = beatDur / this.meanDt;
    if (!(pSamp > 1)) return;

    const steps = 64;
    const newest = win - 1;
    const maxK = Math.min(12, Math.floor(newest / pSamp));
    let bestOff = 0, bestSum = -Infinity;
    for (let s = 0; s < steps; s++) {
      const off = (s / steps) * pSamp;
      let sum = 0;
      for (let k = 0; k <= maxK; k++) {
        const idx = Math.round(newest - off - k * pSamp);
        if (idx < 0) break;
        sum += work[idx];
      }
      if (sum > bestSum) { bestSum = sum; bestOff = off; }
    }
    const beatTime = this.lastEnvTime - bestOff * this.meanDt;

    if (this.downbeat === null) {
      this.downbeat = beatTime;
      return;
    }
    const elapsed = beatTime - this.downbeat;
    const wrapped = ((elapsed % beatDur) + beatDur) % beatDur;
    const offset = wrapped > beatDur / 2 ? wrapped - beatDur : wrapped;
    // Correct genuine drift but ignore near-half-beat "corrections": off-beat
    // energy (hats/claps) can rival the kick and flip the comb to the wrong pulse,
    // which would make the beat grid lurch by half a beat. Gentle time constant.
    if (Math.abs(offset) < beatDur * 0.3) this.downbeat += offset * 0.08;
  }

  // User tap on every beat (or every 1). Two consecutive taps already give a BPM.
  // The most recent tap is also treated as a downbeat anchor for phase, and the
  // tempo is locked briefly so auto-detection doesn't immediately pull it off.
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
      this.tapLockUntil = now + 6;
    }
    this.downbeat = now;
  }

  reset(): void {
    this.tapTimes = [];
    this.tapLockUntil = 0;
    this.envCount = 0;
    this.envWrite = 0;
    this.recentBpm = [];
    this.prevValid = false;
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
