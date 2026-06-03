import type { BeatTracker } from './beat';
import { TapRecorder } from './recorder';

// Forward-looking record-then-loop. Press loop key → live keeps playing while we
// record for the loop's duration. After N beats, the recorded buffer starts
// playing on a loop from its first sample. Release at any time:
//   - during recording: cancel, no playback ever happens
//   - during playback:   fade out the loop and return to live

export class Looper {
  private ctx: AudioContext;
  private beat: BeatTracker;
  private output: AudioNode;
  private recorder: TapRecorder;
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
  // Retained copy of the playing loop's buffer and its length in beats, so a
  // resize can re-slice the same audio (shorten) without re-recording. Also acts
  // as the token guarding the async grab in a lengthening resize.
  private loopBuf: AudioBuffer | null = null;
  private currentBeats = 0;

  onRecordingStart: ((beats: number, durationMs: number) => void) | null = null;
  onRecordingCancel: ((beats: number) => void) | null = null;
  onPlaybackStart: ((beats: number) => void) | null = null;
  onPlaybackStop: ((beats: number) => void) | null = null;

  constructor(ctx: AudioContext, output: AudioNode, beat: BeatTracker, recorder: TapRecorder) {
    this.ctx = ctx;
    this.beat = beat;
    this.output = output;
    this.recorder = recorder;
  }

  static async create(ctx: AudioContext, source: AudioNode, output: AudioNode, beat: BeatTracker): Promise<Looper> {
    // Tap the raw source so loops carry no baked-in FX — they re-run through
    // gate + FX live on playback.
    const recorder = await TapRecorder.create(ctx, source);
    return new Looper(ctx, output, beat, recorder);
  }

  // Forward record-then-loop. Live keeps playing while we record; after `beats`
  // worth of beats the recorded buffer starts looping from sample 0. Caller is
  // responsible for ducking the live signal when onPlaybackStart fires.
  startLoop(beats: number): void {
    this.stopLoop();
    const myGen = ++this.gen;
    this.currentBeats = beats;

    const loopDur = beats * this.beat.beatDuration();
    const samples = Math.floor(loopDur * this.ctx.sampleRate);

    this.onRecordingStart?.(beats, loopDur * 1000);

    this.recordTimer = window.setTimeout(async () => {
      this.recordTimer = null;
      if (myGen !== this.gen) return;

      const buf = await this.recorder.grab(samples);
      if (myGen !== this.gen) return;

      this.loopBuf = buf;
      this.playBuffer(buf);
      this.onPlaybackStart?.(beats);
    }, loopDur * 1000);
  }

  // Resize the *currently playing* loop in place — shorten or lengthen — without
  // starting a new record-then-loop. Shortening re-slices the front of the
  // already-captured buffer (same audio, just less of it); lengthening past what
  // we captured grabs a fresh rear-looking window of the new length. If no loop
  // is playing yet (still inside the record window), there's nothing to resize,
  // so we just restart the record at the new size.
  resizeLoop(beats: number): void {
    if (!this.active) { this.startLoop(beats); return; }

    const prev = this.currentBeats;
    if (beats === prev) return;
    this.currentBeats = beats; // doubles as the token guarding the async grab below
    this.onPlaybackStop?.(prev);
    this.onPlaybackStart?.(beats);

    const samples = Math.floor(beats * this.beat.beatDuration() * this.ctx.sampleRate);
    if (this.loopBuf && samples <= this.loopBuf.length) {
      this.swapTo(this.sliceBuffer(this.loopBuf, samples));
    } else {
      this.recorder.grab(samples).then(buf => {
        // Bail if another resize/stop superseded this grab while it was in flight.
        if (this.currentBeats !== beats || !this.active) return;
        this.loopBuf = buf;
        this.swapTo(buf);
      });
    }
  }

  // Rear-looking reverse roll: grab the last N beats, reverse, loop immediately.
  // No record window — meant for instant "play the recent music backwards" effect.
  async startReverseRoll(beats: number): Promise<void> {
    this.stopLoop();
    const myGen = ++this.gen;
    const samples = Math.floor(beats * this.beat.beatDuration() * this.ctx.sampleRate);
    const buf = await this.recorder.grab(samples);
    if (myGen !== this.gen) return;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      buf.getChannelData(ch).reverse();
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

  // Crossfade the active loop source over to a new buffer without firing the
  // start/stop callbacks (the caller owns the visuals). Used by resizeLoop so a
  // size change is seamless rather than a hard cut.
  private swapTo(buf: AudioBuffer): void {
    if (this.active && this.activeFade) {
      const t = this.ctx.currentTime;
      const old = this.active;
      const oldFade = this.activeFade;
      oldFade.gain.cancelScheduledValues(t);
      oldFade.gain.setValueAtTime(oldFade.gain.value, t);
      oldFade.gain.linearRampToValueAtTime(0, t + 0.01);
      setTimeout(() => {
        try { old.stop(); } catch {}
        old.disconnect();
        oldFade.disconnect();
      }, 20);
    }
    this.playBuffer(buf);
  }

  // Copy the front `samples` of a buffer into a fresh, shorter buffer.
  private sliceBuffer(src: AudioBuffer, samples: number): AudioBuffer {
    const n = Math.min(samples, src.length);
    const out = this.ctx.createBuffer(src.numberOfChannels, n, this.ctx.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      out.getChannelData(ch).set(src.getChannelData(ch).subarray(0, n));
    }
    return out;
  }

  stopLoop(): void {
    // Cancel any pending recording
    if (this.recordTimer !== null) {
      clearTimeout(this.recordTimer);
      this.recordTimer = null;
      this.gen++;
      this.onRecordingCancel?.(this.currentBeats);
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
      this.onPlaybackStop?.(this.currentBeats);
    }
    this.loopBuf = null;
  }

  // Live playback rate of the currently playing source (so a dial can follow
  // tape stop dragging the loop down). Falls back to the inherited rate when idle.
  get playbackRate(): number {
    return this.active ? this.active.playbackRate.value : this.currentRate;
  }

  get isPlaying(): boolean { return this.active !== null; }
  get isRecording(): boolean { return this.recordTimer !== null; }
}
