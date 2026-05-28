import { requestMicPermission, listInputDevices, captureFromDevice, captureTabAudio } from './audio/capture';
import { buildFxChain } from './audio/fx-chain';
import { BeatTracker } from './audio/beat';
import { Looper } from './audio/looper';
import { MasterGate } from './audio/gate';
import { Sampler, PAD_COUNT } from './audio/sampler';
import { setupMidi, type MidiEvent } from './input/midi';
import { BindingManager } from './input/bindings';

// ──────────────────────────────────────────────────────────────────────
// Element refs
// ──────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const deviceSelect = $<HTMLSelectElement>('device-select');
const startBtn = $<HTMLButtonElement>('start-btn');
const tabBtn = $<HTMLButtonElement>('tab-btn');
const stopBtn = $<HTMLButtonElement>('stop-btn');
const meter = $('meter');
const bpmDisplay = $('bpm-display');
const bpmConf = $('bpm-conf');
const barDisplay = $('bar-display');
const tapPill = $('tap-pill');
const filterSweepPill = $('filter-sweep-pill');
const delayThrowPill = $('delay-throw-pill');
const reverbThrowPill = $('reverb-throw-pill');
const hpKillPill = $('hp-kill-pill');
const lpKillPill = $('lp-kill-pill');
const bitcrushPills: Record<string, HTMLElement> = {
  '5': $('bitcrush-5'),
  '3': $('bitcrush-3'),
};
const reversePill = $('reverse-pill');
const freezePill = $('freeze-pill');
const tapeStopPill = $('tape-stop-pill');
const loopPitch = $<HTMLInputElement>('loop-pitch');
const beatLEDs = Array.from(document.querySelectorAll<HTMLElement>('#beat-leds .beat-led'));
const lcdViz = $<HTMLCanvasElement>('lcd-viz');
const lcdVizCtx = lcdViz.getContext('2d');
const padElements: HTMLElement[] = [];
for (let i = 0; i < PAD_COUNT; i++) padElements.push($(`pad-${i}`));
const recPill = $('rec-pill');
const modePill = $('mode-pill');
const resetBtn = $<HTMLButtonElement>('reset-btn');
const learnBtn = $<HTMLButtonElement>('learn-btn');
const resetBindingsBtn = $<HTMLButtonElement>('reset-bindings-btn');
const filterCutoff = $<HTMLInputElement>('filter-cutoff');
const filterQ = $<HTMLInputElement>('filter-q');
const filterType = $<HTMLSelectElement>('filter-type');
const delaySend = $<HTMLInputElement>('delay-send');
const reverbSend = $<HTMLInputElement>('reverb-send');
const masterVol = $<HTMLInputElement>('master-vol');
const gatePills: Record<string, HTMLElement> = {
  kill: $('gate-kill'),
  '1.0': $('gate-1-4'),
  '0.5': $('gate-1-8'),
  '0.25': $('gate-1-16'),
  '0.125': $('gate-1-32'),
  '0.0625': $('gate-1-64'),
  '0.03125': $('gate-1-128'),
};
const LOOP_PILLS: Record<number, HTMLElement> = {
  4: $('loop-bar1'),
  2: $('loop-beat2'),
  1: $('loop-beat1'),
  0.5: $('loop-beat-half'),
  0.25: $('loop-beat-quarter'),
  0.125: $('loop-beat-eighth'),
};
const midiStatus = $('midi-status');
const midiLast = $('midi-last');

// ──────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let beat: BeatTracker | null = null;
let looper: Looper | null = null;
let fx: ReturnType<typeof buildFxChain> | null = null;
let masterGain: GainNode | null = null;
let masterGate: MasterGate | null = null;
// liveGain sits on the live FX path only (not the loop playback path), so we can
// duck the live signal while loops are playing — otherwise you hear loop + live underneath.
let liveGain: GainNode | null = null;
let meterAnalyser: AnalyserNode | null = null;
let meterData: Uint8Array<ArrayBuffer> | null = null;
let lastBeatIndex = -1;
let sampler: Sampler | null = null;
let recordModeActive = false;
let oneShotMode = false; // false = hold-to-loop
let running = false;

// Only one loop is active at a time (recording or playing). Pressing a second
// loop key replaces the first; releasing the current key stops everything.
let currentLoop: number | null = null;
// Mangle effects use the same single playback slot as loops, so pressing
// reverse/freeze cancels any active loop and vice versa.
let reverseActive = false;
let freezeActive = false;
let tapeStopActive = false;

// ──────────────────────────────────────────────────────────────────────
// Device list
// ──────────────────────────────────────────────────────────────────────
async function refreshDevices() {
  try {
    await requestMicPermission();
  } catch (e) {
    console.error('Microphone permission denied', e);
    return;
  }
  const inputs = await listInputDevices();
  deviceSelect.innerHTML = '';
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Input ${d.deviceId.slice(0, 6)}`;
    deviceSelect.appendChild(opt);
  }
  // Auto-pick BlackHole if present
  const black = inputs.find(d => /blackhole/i.test(d.label));
  if (black) deviceSelect.value = black.deviceId;
}

// ──────────────────────────────────────────────────────────────────────
// Audio graph lifecycle
// ──────────────────────────────────────────────────────────────────────
async function start(mode: 'device' | 'tab') {
  if (running) return;

  let nextStream: MediaStream;
  if (mode === 'tab') {
    try {
      nextStream = await captureTabAudio();
    } catch (e) {
      console.error(e);
      alert((e as Error).message ?? 'Tab capture cancelled or failed.');
      return;
    }
  } else {
    const deviceId = deviceSelect.value;
    if (!deviceId) return;
    nextStream = await captureFromDevice(deviceId);
  }

  ctx = new AudioContext({ latencyHint: 'interactive' });
  stream = nextStream;
  const source = ctx.createMediaStreamSource(stream);

  // If the user stops sharing from Chrome's bar, clean up.
  stream.getAudioTracks().forEach(t => {
    t.addEventListener('ended', () => { if (running) stop(); });
  });

  fx = buildFxChain(ctx);

  // Adapt the filter slider to the AudioContext's Nyquist (some devices run at 24kHz).
  const nyquist = Math.floor(ctx.sampleRate / 2) - 1;
  filterCutoff.max = String(nyquist);
  if (parseFloat(filterCutoff.value) > nyquist) filterCutoff.value = String(nyquist);

  // Apply current UI values
  fx.filter.type = filterType.value as BiquadFilterType;
  fx.filter.frequency.value = parseFloat(filterCutoff.value);
  fx.filter.Q.value = parseFloat(filterQ.value);
  fx.delaySend.gain.value = parseFloat(delaySend.value);
  fx.reverbSend.gain.value = parseFloat(reverbSend.value);

  // Meter + visualizer on the input pre-FX (so they show incoming signal even when killed)
  meterAnalyser = ctx.createAnalyser();
  meterAnalyser.fftSize = 512;
  meterAnalyser.smoothingTimeConstant = 0.78;
  meterData = new Uint8Array(new ArrayBuffer(meterAnalyser.frequencyBinCount));
  source.connect(meterAnalyser);
  setupVizCanvas();


  // Signal chain (top to bottom = upstream to downstream):
  //   source ──→ recorder           (raw capture for loops — no baked-in FX)
  //   source ──→ liveGain (duckable) ─┐
  //                                    ├─→ masterGate ─→ fx (filter + sends) ─→ masterGain ─→ destination
  //   loop playback ─────────────────┘
  //
  // FX sit POST-gate-and-loop, so filter/delay/reverb apply to whatever survives the gate
  // and to loop playback. Killing the gate cuts the dry signal but lets the FX tail trail.
  masterGain = ctx.createGain();
  masterGain.gain.value = parseFloat(masterVol.value);
  masterGain.connect(ctx.destination);

  beat = new BeatTracker(ctx, source);
  beat.start();

  masterGate = new MasterGate(ctx, beat);
  masterGate.node.connect(fx.input);
  fx.output.connect(masterGain);

  liveGain = ctx.createGain();
  liveGain.gain.value = 1;
  source.connect(liveGain);
  liveGain.connect(masterGate.node);

  // Looper records raw source and plays back into masterGate, so loop playback flows
  // through gate + FX the same way live audio does.
  looper = await Looper.create(ctx, source, masterGate.node, beat);

  // Sampler shares the looper's ring buffer (via grab) but plays back POST-gate
  // (straight into fx.input), so samples punch through gate kills/chops and aren't
  // dragged by loop-only effects like tape stop. They still get the global FX flavor.
  sampler = new Sampler(ctx, looper, fx.input);
  sampler.onSampleEnded = (idx) => padElements[idx]?.classList.remove('playing');
  // Mark pads that have preloaded samples (e.g., the locked airhorn)
  for (let i = 0; i < PAD_COUNT; i++) {
    padElements[i]?.classList.toggle('has-sample', sampler.hasSample(i));
  }

  // Visual + duck wiring: while recording the pill pulses amber; on playback
  // start it goes green and the live signal ducks so we hear the loop only.
  looper.onRecordingStart = (beats) => {
    LOOP_PILLS[beats]?.classList.add('recording');
  };
  looper.onRecordingCancel = () => {
    if (currentLoop !== null) LOOP_PILLS[currentLoop]?.classList.remove('recording');
  };
  looper.onPlaybackStart = (beats) => {
    LOOP_PILLS[beats]?.classList.remove('recording');
    LOOP_PILLS[beats]?.classList.add('on');
    duckLive(true);
  };
  looper.onPlaybackStop = () => {
    if (currentLoop !== null) LOOP_PILLS[currentLoop]?.classList.remove('on');
  };

  running = true;
  startBtn.disabled = true;
  tabBtn.disabled = true;
  stopBtn.disabled = false;
  requestAnimationFrame(uiTick);
}

function stop() {
  if (!running) return;
  beat?.stop();
  looper?.stopLoop();
  stream?.getTracks().forEach(t => t.stop());
  ctx?.close();
  ctx = null;
  stream = null;
  beat = null;
  looper = null;
  fx = null;
  masterGain = null;
  masterGate = null;
  liveGain = null;
  meterAnalyser = null;
  meterData = null;
  sampler = null;
  recordModeActive = false;
  recPill.classList.remove('armed');
  for (const pad of padElements) pad.classList.remove('playing', 'recording');
  lastBeatIndex = -1;
  for (const led of beatLEDs) led.classList.remove('lit', 'lit-1');
  running = false;
  startBtn.disabled = false;
  tabBtn.disabled = false;
  stopBtn.disabled = true;
}

// ──────────────────────────────────────────────────────────────────────
// LCD spectrum visualizer
// ──────────────────────────────────────────────────────────────────────
let vizDpr = 1;
function setupVizCanvas() {
  if (!lcdViz) return;
  vizDpr = window.devicePixelRatio || 1;
  const rect = lcdViz.getBoundingClientRect();
  lcdViz.width = Math.max(1, Math.floor(rect.width * vizDpr));
  lcdViz.height = Math.max(1, Math.floor(rect.height * vizDpr));
}
window.addEventListener('resize', () => { if (running) setupVizCanvas(); });

// Per-bar peak hold so the top edge has a falling "cap" — classic LCD viz look.
const vizPeaks: number[] = [];
function drawViz() {
  if (!lcdViz || !lcdVizCtx || !meterData) return;
  const w = lcdViz.width;
  const h = lcdViz.height;
  if (!w || !h) return;
  lcdVizCtx.clearRect(0, 0, w, h);

  // Skip the top half of the FFT (mostly empty above 10kHz for typical music);
  // use a square-root index map so bass takes more bars than treble.
  const bars = 28;
  const usable = Math.floor(meterData.length * 0.65);
  if (vizPeaks.length !== bars) vizPeaks.length = bars, vizPeaks.fill(0);
  const slotW = w / bars;
  const barW = slotW * 0.72;

  for (let i = 0; i < bars; i++) {
    const t0 = i / bars;
    const t1 = (i + 1) / bars;
    const lo = Math.floor(t0 * t0 * usable);
    const hi = Math.max(lo + 1, Math.floor(t1 * t1 * usable));
    let max = 0;
    for (let j = lo; j < hi; j++) if (meterData[j] > max) max = meterData[j];
    const v = max / 255;
    const barH = Math.min(h, v * h * 1.15);

    vizPeaks[i] = Math.max(vizPeaks[i] - h * 0.012, barH);

    const x = i * slotW + (slotW - barW) / 2;
    const y = h - barH;

    const grad = lcdVizCtx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, 'rgba(208,232,255,0.95)');
    grad.addColorStop(0.45, 'rgba(106,168,248,0.95)');
    grad.addColorStop(1, 'rgba(44,112,184,0.85)');
    lcdVizCtx.fillStyle = grad;
    lcdVizCtx.shadowColor = 'rgba(106,168,248,0.7)';
    lcdVizCtx.shadowBlur = 6 * vizDpr;
    lcdVizCtx.fillRect(x, y, barW, barH);

    // Peak cap
    lcdVizCtx.shadowBlur = 8 * vizDpr;
    lcdVizCtx.fillStyle = 'rgba(232,244,255,0.9)';
    lcdVizCtx.fillRect(x, h - vizPeaks[i] - 2 * vizDpr, barW, 2 * vizDpr);
  }
  lcdVizCtx.shadowBlur = 0;
}

// ──────────────────────────────────────────────────────────────────────
// UI tick
// ──────────────────────────────────────────────────────────────────────
function uiTick() {
  if (!running) return;
  if (meterAnalyser && meterData) {
    meterAnalyser.getByteFrequencyData(meterData);
    let sum = 0;
    for (let i = 0; i < meterData.length; i++) sum += meterData[i];
    const avg = sum / meterData.length;
    meter.style.width = `${Math.min(100, (avg / 200) * 100)}%`;
    drawViz();
  }
  if (beat) {
    bpmDisplay.textContent = beat.bpm.toFixed(1);
    bpmConf.textContent = beat.bpmConfidence > 0.5 ? `locked (${beat.bpmConfidence.toFixed(2)})` : 'auto';
    if (beat.downbeat !== null) {
      const phase = beat.barPhase();
      const beatInBar = Math.floor(phase * beat.beatsPerBar) + 1;
      barDisplay.textContent = `${beatInBar} / ${beat.beatsPerBar}`;
    } else {
      barDisplay.textContent = '— (listening… tap to set 1)';
    }
    updateBeatLEDs();
  }
  requestAnimationFrame(uiTick);
}

// ──────────────────────────────────────────────────────────────────────
// Action handlers
// ──────────────────────────────────────────────────────────────────────
// Gate stack: most-recently-pressed gate wins. Keys are stable identifiers
// (e.g. 'g', '1.0', '0.5') so MIDI and keyboard can share the same stack.
type GateAction = { kind: 'kill' } | { kind: 'rhythmic'; phase: number };
const GATE_ACTIONS: Record<string, GateAction> = {
  kill: { kind: 'kill' },
  '1.0': { kind: 'rhythmic', phase: 1.0 },
  '0.5': { kind: 'rhythmic', phase: 0.5 },
  '0.25': { kind: 'rhythmic', phase: 0.25 },
  '0.125': { kind: 'rhythmic', phase: 0.125 },
  '0.0625': { kind: 'rhythmic', phase: 0.0625 },
  '0.03125': { kind: 'rhythmic', phase: 0.03125 },
};
const heldGateStack: string[] = [];

function gateDown(id: string) {
  if (!masterGate || !GATE_ACTIONS[id]) return;
  if (heldGateStack.includes(id)) return;
  heldGateStack.push(id);
  applyTopGate();
}

function gateUp(id: string) {
  const idx = heldGateStack.indexOf(id);
  if (idx >= 0) heldGateStack.splice(idx, 1);
  applyTopGate();
}

function applyTopGate() {
  if (!masterGate) return;
  if (heldGateStack.length === 0) {
    masterGate.open();
    refreshGatePills(null);
    return;
  }
  const top = heldGateStack[heldGateStack.length - 1];
  const action = GATE_ACTIONS[top]!;
  if (action.kind === 'kill') masterGate.kill();
  else masterGate.rhythmic(action.phase);
  refreshGatePills(top);
}

function refreshGatePills(activeId: string | null) {
  for (const [id, el] of Object.entries(gatePills)) {
    el.classList.toggle('on', id === activeId);
  }
}

function holdLoop(beats: number) {
  if (!looper) return;
  cancelActivePlayback();
  currentLoop = beats;
  looper.startLoop(beats); // visual handled by onRecordingStart / onPlaybackStart
}

function releaseLoop(beats: number) {
  if (!looper) return;
  if (currentLoop !== beats) return;
  cancelActivePlayback();
  duckLive(false);
}

function holdReverse(beats: number) {
  if (!looper) return;
  cancelActivePlayback();
  reverseActive = true;
  reversePill.classList.add('on');
  duckLive(true);
  looper.startReverseRoll(beats);
}

function releaseReverse() {
  if (!reverseActive) return;
  cancelActivePlayback();
  duckLive(false);
}

function holdFreeze() {
  if (!looper) return;
  cancelActivePlayback();
  freezeActive = true;
  freezePill.classList.add('on');
  duckLive(true);
  looper.startFreeze();
}

function releaseFreeze() {
  if (!freezeActive) return;
  cancelActivePlayback();
  duckLive(false);
}

function cancelActivePlayback() {
  if (currentLoop !== null) {
    LOOP_PILLS[currentLoop]?.classList.remove('on', 'recording');
    currentLoop = null;
  }
  if (reverseActive) { reversePill.classList.remove('on'); reverseActive = false; }
  if (freezeActive) { freezePill.classList.remove('on'); freezeActive = false; }
  looper?.stopLoop();
}

function duckLive(ducked: boolean) {
  if (!liveGain || !ctx) return;
  const t = ctx.currentTime;
  liveGain.gain.cancelScheduledValues(t);
  liveGain.gain.setValueAtTime(liveGain.gain.value, t);
  liveGain.gain.linearRampToValueAtTime(ducked ? 0 : 1, t + 0.006);
}

// ──────────────────────────────────────────────────────────────────────
// Input bindings (keyboard / MIDI / learn mode)
// ──────────────────────────────────────────────────────────────────────
const bindings = new BindingManager();

// Filter sweep: slow exponential ramp (octave-uniform, sounds musical).
// Press → sweep down to 300 Hz over ~800ms; release → sweep back to the slider value.
const SWEEP_MS = 800;
function filterSweepDown() {
  if (!fx || !ctx) return;
  const t = ctx.currentTime;
  fx.filter.frequency.cancelScheduledValues(t);
  fx.filter.frequency.setValueAtTime(Math.max(fx.filter.frequency.value, 20), t);
  fx.filter.frequency.exponentialRampToValueAtTime(300, t + SWEEP_MS / 1000);
}
function filterSweepUp() {
  if (!fx || !ctx) return;
  const t = ctx.currentTime;
  fx.filter.frequency.cancelScheduledValues(t);
  fx.filter.frequency.setValueAtTime(Math.max(fx.filter.frequency.value, 20), t);
  fx.filter.frequency.exponentialRampToValueAtTime(parseFloat(filterCutoff.value), t + SWEEP_MS / 1000);
}

// Register every learnable action with its handler, pill, and default keyboard binding.
bindings.register('tap',
  { down: () => beat?.tap() },
  { pill: tapPill, default: { source: 'key', code: 'Space' } });

bindings.register('filter-sweep',
  { down: filterSweepDown, up: filterSweepUp },
  { pill: filterSweepPill, default: { source: 'key', code: 'KeyF' } });

// Send "throw" actions: hold to slam the send to a wet level (fast attack),
// release to ramp back to whatever the slider is set to (slower release so
// the natural delay/reverb tail breathes back down).
const THROW_LEVEL = 0.85;
function throwSend(gain: AudioParam, level: number, attackMs: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  gain.cancelScheduledValues(t);
  gain.setValueAtTime(gain.value, t);
  gain.linearRampToValueAtTime(level, t + attackMs / 1000);
}
bindings.register('delay-throw', {
  down: () => fx && throwSend(fx.delaySend.gain, THROW_LEVEL, 50),
  up:   () => fx && throwSend(fx.delaySend.gain, parseFloat(delaySend.value), 300),
}, { pill: delayThrowPill, default: { source: 'key', code: 'KeyT' } });
bindings.register('reverb-throw', {
  down: () => fx && throwSend(fx.reverbSend.gain, THROW_LEVEL, 50),
  up:   () => fx && throwSend(fx.reverbSend.gain, parseFloat(reverbSend.value), 300),
}, { pill: reverbThrowPill, default: { source: 'key', code: 'KeyR' } });

// EQ kills — exponential cutoff sweep on hold
const KILL_RAMP_MS = 60;
function killSweep(p: AudioParam, target: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(Math.max(p.value, 20), t);
  p.exponentialRampToValueAtTime(target, t + KILL_RAMP_MS / 1000);
}
bindings.register('hp-kill', {
  down: () => fx && killSweep(fx.hpKill.frequency, 800),  // kill below 800 Hz
  up:   () => fx && killSweep(fx.hpKill.frequency, 20),
}, { pill: hpKillPill, default: { source: 'key', code: 'KeyL' } });
bindings.register('lp-kill', {
  down: () => fx && killSweep(fx.lpKill.frequency, 600),  // kill above 600 Hz
  up:   () => fx && ctx && killSweep(fx.lpKill.frequency, Math.floor(ctx.sampleRate / 2) - 1),
}, { pill: lpKillPill, default: { source: 'key', code: 'KeyH' } });

// Bitcrush — parallel crossfade between dry and crushed paths
function rampLinear(p: AudioParam, target: number, ms: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(target, t + ms / 1000);
}
// Most-recent-pressed crush step wins, same stack pattern as the gate so
// holding multiple keys layers gracefully.
const heldBitcrushStack: string[] = [];
function bitcrushDown(id: string) {
  if (heldBitcrushStack.includes(id)) return;
  heldBitcrushStack.push(id);
  applyTopBitcrush();
}
function bitcrushUp(id: string) {
  const idx = heldBitcrushStack.indexOf(id);
  if (idx >= 0) heldBitcrushStack.splice(idx, 1);
  applyTopBitcrush();
}
function applyTopBitcrush() {
  if (!fx) return;
  if (heldBitcrushStack.length === 0) {
    rampLinear(fx.bitcrushDry.gain, 1, 200);
    for (const s of fx.bitcrushSteps) rampLinear(s.wet.gain, 0, 200);
    for (const el of Object.values(bitcrushPills)) el.classList.remove('on');
    return;
  }
  const top = heldBitcrushStack[heldBitcrushStack.length - 1];
  const bits = parseInt(top, 10);
  rampLinear(fx.bitcrushDry.gain, 0, 50);
  for (const s of fx.bitcrushSteps) rampLinear(s.wet.gain, s.bits === bits ? 1 : 0, 50);
  for (const [id, el] of Object.entries(bitcrushPills)) el.classList.toggle('on', id === top);
}

const BITCRUSH_DEFAULTS: Array<[string, string]> = [
  ['5', 'KeyB'],
  ['3', 'KeyN'],
];
for (const [id, code] of BITCRUSH_DEFAULTS) {
  bindings.register(`bitcrush:${id}`,
    { down: () => bitcrushDown(id), up: () => bitcrushUp(id) },
    { pill: bitcrushPills[id], default: { source: 'key', code } });
}

// Reverse roll — rear-looking, 1 beat
bindings.register('reverse', {
  down: () => holdReverse(1),
  up:   () => releaseReverse(),
}, { pill: reversePill, default: { source: 'key', code: 'KeyV' } });

// Freeze — rear-looking tiny slice
bindings.register('freeze', {
  down: () => holdFreeze(),
  up:   () => releaseFreeze(),
}, { pill: freezePill, default: { source: 'key', code: 'KeyC' } });

// Tape stop — slow active loop's playback rate to ~0 on hold
// ────────────────────── Sampler ──────────────────────
function setRecordMode(on: boolean) {
  recordModeActive = on;
  recPill.classList.toggle('armed', on);
}

function padDown(idx: number) {
  if (!sampler) return;
  if (recordModeActive) {
    if (sampler.isLocked(idx)) return;
    sampler.startRecord(idx);
    padElements[idx].classList.add('recording');
    padElements[idx].classList.remove('has-sample');
    return;
  }
  const fired = sampler.triggerPad(idx, !oneShotMode);
  if (fired) {
    padElements[idx].classList.remove('playing');
    void padElements[idx].offsetWidth; // restart animation
    padElements[idx].classList.add('playing');
  }
}

function padUp(idx: number) {
  if (!sampler) return;
  if (sampler.isRecording(idx)) {
    sampler.endRecord(idx).then(ok => {
      padElements[idx].classList.remove('recording');
      if (ok) padElements[idx].classList.add('has-sample');
    });
    return;
  }
  sampler.releasePad(idx, !oneShotMode);
  // For hold-mode the source ends on stop; the onSampleEnded handler clears the class.
  // For one-shot we leave the class until the sample naturally finishes (handled by onSampleEnded).
}

modePill.addEventListener('click', () => {
  oneShotMode = !oneShotMode;
  modePill.textContent = oneShotMode ? 'ONE-SHOT' : 'HOLD';
});

bindings.register('rec-hold', {
  down: () => setRecordMode(true),
  up:   () => setRecordMode(false),
}, { pill: recPill, default: { source: 'key', code: 'Backquote' } });

const PAD_DEFAULT_KEYS = ['Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
for (let i = 0; i < PAD_COUNT; i++) {
  const idx = i;
  bindings.register(`pad:${i}`, {
    down: () => padDown(idx),
    up:   () => padUp(idx),
  }, { pill: padElements[i], default: { source: 'key', code: PAD_DEFAULT_KEYS[i] } });
}

bindings.register('tape-stop', {
  down: () => {
    tapeStopActive = true;
    tapeStopPill.classList.add('on');
    looper?.setPlaybackRate(0.001, 800);
  },
  up: () => {
    if (!tapeStopActive) return;
    tapeStopActive = false;
    tapeStopPill.classList.remove('on');
    looper?.setPlaybackRate(parseFloat(loopPitch.value), 200);
  },
}, { pill: tapeStopPill, default: { source: 'key', code: 'KeyZ' } });

const GATE_DEFAULTS: Array<[string, string]> = [
  ['kill', 'KeyG'],
  ['1.0', 'Digit1'],
  ['0.5', 'Digit2'],
  ['0.25', 'Digit3'],
  ['0.125', 'Digit4'],
  ['0.0625', 'Digit5'],
  ['0.03125', 'Digit6'],
];
for (const [id, code] of GATE_DEFAULTS) {
  bindings.register(`gate:${id}`,
    { down: () => gateDown(id), up: () => gateUp(id) },
    { pill: gatePills[id], default: { source: 'key', code } });
}

const LOOP_DEFAULTS: Array<[number, string]> = [
  [4, 'KeyQ'],       // 1 bar
  [2, 'KeyW'],       // 2 beats
  [1, 'KeyA'],       // 1 beat
  [0.5, 'KeyS'],     // 1/2 beat
  [0.25, 'KeyD'],    // 1/4 beat
  [0.125, 'KeyE'],   // 1/8 beat (stutter)
];
for (const [beats, code] of LOOP_DEFAULTS) {
  bindings.register(`loop:${beats}`,
    { down: () => holdLoop(beats), up: () => releaseLoop(beats) },
    { pill: LOOP_PILLS[beats], default: { source: 'key', code } });
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const handled = bindings.handleKey(e.code, 'down');
  // Always prevent Space from scrolling the page if it's our binding.
  if (handled && e.code === 'Space') e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  bindings.handleKey(e.code, 'up');
});

function handleMidi(e: MidiEvent) {
  midiLast.textContent = JSON.stringify(e);
  if (e.type === 'noteon') bindings.handleMidi(e.note, 'on');
  else if (e.type === 'noteoff') bindings.handleMidi(e.note, 'off');
  // CC handling (knobs/encoders) bypasses the binding manager for now —
  // continuous controls deserve their own mapping flow.
}

learnBtn.addEventListener('click', () => {
  const on = bindings.toggleLearnMode();
  learnBtn.classList.toggle('active', on);
  learnBtn.textContent = on ? 'Learning…' : 'Learn';
});

resetBindingsBtn.addEventListener('click', () => {
  if (!confirm('Reset all key/MIDI mappings to defaults?')) return;
  bindings.resetAll();
});

// ──────────────────────────────────────────────────────────────────────
// UI wiring
// ──────────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => start('device'));
tabBtn.addEventListener('click', () => start('tab'));
stopBtn.addEventListener('click', stop);
resetBtn.addEventListener('click', () => beat?.reset());

filterCutoff.addEventListener('input', () => {
  if (fx && ctx) fx.filter.frequency.setTargetAtTime(parseFloat(filterCutoff.value), ctx.currentTime, 0.01);
});
filterQ.addEventListener('input', () => {
  if (fx) fx.filter.Q.value = parseFloat(filterQ.value);
});
filterType.addEventListener('change', () => {
  if (fx) fx.filter.type = filterType.value as BiquadFilterType;
});
delaySend.addEventListener('input', () => {
  if (fx && ctx) fx.delaySend.gain.setTargetAtTime(parseFloat(delaySend.value), ctx.currentTime, 0.01);
});
reverbSend.addEventListener('input', () => {
  if (fx && ctx) fx.reverbSend.gain.setTargetAtTime(parseFloat(reverbSend.value), ctx.currentTime, 0.01);
});
masterVol.addEventListener('input', () => {
  if (masterGain && ctx) masterGain.gain.setTargetAtTime(parseFloat(masterVol.value), ctx.currentTime, 0.01);
});
loopPitch.addEventListener('input', () => {
  if (tapeStopActive) return; // tape stop owns the rate while held
  looper?.setPlaybackRate(parseFloat(loopPitch.value), 30);
});

// ──────────────────────────────────────────────────────────────────────
// Beat LEDs (visual tempo check)
// The current beat's LED stays lit for the full beat; on the next beat the
// previous LED clears and the new one takes over. If the active LED doesn't
// match what you hear, the BPM is off — tap Space to re-sync.
// ──────────────────────────────────────────────────────────────────────
function updateBeatLEDs() {
  if (!beat || beat.downbeat === null) {
    if (lastBeatIndex !== -1) {
      for (const led of beatLEDs) led.classList.remove('lit', 'lit-1');
      lastBeatIndex = -1;
    }
    return;
  }
  const idx = Math.floor(beat.barPhase() * beat.beatsPerBar);
  if (idx === lastBeatIndex) return;
  lastBeatIndex = idx;
  for (const led of beatLEDs) led.classList.remove('lit', 'lit-1');
  const cls = idx === 0 ? 'lit-1' : 'lit';
  beatLEDs[idx]?.classList.add(cls);
}

// ──────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────
refreshDevices();
navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

setupMidi(handleMidi).then(res => {
  if (!res) { midiStatus.textContent = 'WebMIDI unavailable (use Chrome/Edge)'; return; }
  midiStatus.textContent = res.inputNames.length
    ? `connected: ${res.inputNames.join(', ')}`
    : 'no MIDI inputs found';
});
