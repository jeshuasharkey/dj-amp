// Rotary knob widget — replaces an <input type=range> with a draggable dial.
// The original input is kept (hidden) as the value store, so existing
// 'input'/'change' listeners keep working: the knob writes the input's value
// and dispatches the events. Visual design matches pan-knob.html.

const SWEEP = 270;          // total travel, degrees
const HALF = SWEEP / 2;     // ±135°
const DEG_PER_PX = 1.35;    // drag sensitivity (matches pan-knob)
const TICK_COUNT = 11;
const TICK_RADIUS = 60;     // px from centre at 1× (scaled by --s below)
const SVG_NS = 'http://www.w3.org/2000/svg';

// Master control scale — single source of truth lives in CSS (:root { --s }),
// matching pan-knob.html. The tick ring radius and the indicator's faux-3D
// shadow offsets are computed here in JS, so they must be scaled by --s too.
const SCALE =
  parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--s'),
  ) || 1;

// Per-input setter that moves only the indicator rotation (no input.value write,
// no input/change event) — used by setKnobVisual so an FX button can spin a dial
// to follow its live param sweep without re-driving the audio param.
const visualSetters = new WeakMap<HTMLInputElement, (value: number) => void>();

function makeRing(cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '50');
  c.setAttribute('cy', '50');
  c.setAttribute('r', '49.5');
  svg.appendChild(c);
  return svg;
}

export function knobify(input: HTMLInputElement): void {
  const label = input.closest('label');
  if (!label || label.classList.contains('has-knob')) return;

  const min = parseFloat(input.min || '0');
  const max = parseFloat(input.max || '1');
  const step = parseFloat(input.step || '') || 0;
  const caption = (label.textContent || '').trim();

  // ── build the dial ──
  const stage = document.createElement('span');
  stage.className = 'knob-stage';

  const notch = document.createElement('div');
  notch.className = 'top-notch';

  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  for (let i = 0; i < TICK_COUNT; i++) {
    const angle = 45 + 270 * (i / (TICK_COUNT - 1)); // lower-left → lower-right
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.transform = `rotate(${angle}deg) translate(0, ${TICK_RADIUS * SCALE}px)`;
    ticks.appendChild(tick);
  }

  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.appendChild(makeRing('inner-ring'));
  knob.appendChild(makeRing('inner-ring-sharp'));
  const orbit = document.createElement('div');
  orbit.className = 'indicator-orbit';
  const indicator = document.createElement('div');
  indicator.className = 'indicator';
  orbit.appendChild(indicator);
  knob.appendChild(orbit);

  stage.append(notch, ticks, knob);

  // ── reflow the label: [caption text][input] → [dial][caption span], input hidden ──
  for (const node of Array.from(label.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) label.removeChild(node);
  }
  label.classList.add('has-knob');
  label.insertBefore(stage, input.nextSibling);
  const cap = document.createElement('span');
  cap.className = 'knob-cap';
  cap.textContent = caption;
  label.appendChild(cap);

  // ── value <-> rotation ──
  const valueToRot = (v: number) => -HALF + ((v - min) / (max - min)) * SWEEP;
  const rotToValue = (r: number) => {
    let v = min + ((r + HALF) / SWEEP) * (max - min);
    if (step > 0) v = Math.round(v / step) * step;
    return Math.max(min, Math.min(max, v));
  };

  let rotation = valueToRot(parseFloat(input.value));

  function updateIndicator() {
    const rad = (rotation * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const set = (k: string, v: string) => indicator.style.setProperty(k, v);
    // keep the pill's drop-shadow pointing "down" in screen space as it orbits
    // (offsets scaled by --s so they shrink with the dial)
    set('--sh1-x', (1 * SCALE * s).toFixed(3) + 'px');
    set('--sh1-y', (1 * SCALE * c).toFixed(3) + 'px');
    set('--sh2-x', (2 * SCALE * s).toFixed(3) + 'px');
    set('--sh2-y', (2 * SCALE * c).toFixed(3) + 'px');
    set('--ins-top-x', (SCALE * s).toFixed(3) + 'px');
    set('--ins-top-y', (SCALE * c).toFixed(3) + 'px');
    set('--ins-bot-x', (-SCALE * s).toFixed(3) + 'px');
    set('--ins-bot-y', (-SCALE * c).toFixed(3) + 'px');
    set('--grad-angle', (180 - rotation).toFixed(3) + 'deg');
  }
  function render() {
    knob.style.setProperty('--rotation', rotation + 'deg');
    updateIndicator();
  }
  render();

  // Visual-only setter (see visualSetters): clamp to the dial's range and spin
  // the indicator, but leave input.value and its listeners alone.
  visualSetters.set(input, (v: number) => {
    rotation = valueToRot(Math.max(min, Math.min(max, v)));
    render();
  });

  // keep the dial in sync if the value is changed elsewhere (e.g. reset)
  input.addEventListener('change', () => {
    rotation = valueToRot(parseFloat(input.value));
    render();
  });

  // ── drag-to-rotate (up & right increase) ──
  let startX = 0;
  let startY = 0;
  let rotAtStart = 0;
  let dragging = false;

  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    knob.style.cursor = 'grabbing';
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    rotAtStart = rotation;
  });
  knob.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = (-(e.clientY - startY) + (e.clientX - startX)) * DEG_PER_PX;
    const candidate = Math.max(-HALF, Math.min(HALF, rotAtStart + delta));
    const v = rotToValue(candidate);
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    rotation = valueToRot(v); // snap indicator to the quantised value
    render();
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    knob.style.cursor = 'grab';
    try { knob.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  // Safety net: if the release lands somewhere the knob never sees (capture
  // dropped, button released off-window), end the drag anyway so it can't get
  // stuck and re-engage when the pointer wanders back over the dial.
  knob.addEventListener('lostpointercapture', end);
  window.addEventListener('pointerup', end);
}

export function knobifyAll(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(knobify);
}

// Spin a knobified input's dial to `value` for display only — no input.value
// write, no input/change event (so it won't re-drive whatever the dial controls).
// No-op if the input was never knobified.
export function setKnobVisual(input: HTMLInputElement, value: number): void {
  visualSetters.get(input)?.(value);
}
