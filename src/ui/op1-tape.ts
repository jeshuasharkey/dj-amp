// OP-1 "tape" screen — a faithful pastiche of the Teenage Engineering OP-1
// tape view rendered to a <canvas>: two spinning reels, a running timecode,
// the capstan/head transport at the bottom, and a four-lane tape timeline that
// scrolls past a fixed centre playhead.
//
// Look: pure-black CRT with a fine dot-matrix grid, faint scanlines, and a
// red/cyan chromatic-aberration split on every white line — exactly the cheap,
// gorgeous OLED-through-a-lens vibe of the real thing. All of that is faked in
// 2D canvas: white linework is drawn onto an offscreen buffer, punched through
// a dot pattern, then composited additively three times (red shifted left,
// cyan shifted right, white centred).

export interface TapeState {
  running: boolean;   // audio engine live → reels at speed, timecode runs
  bpm: number;        // current detected tempo
  level: number;      // 0..1 live output level — drives brightness/wobble
}

const TWO_PI = Math.PI * 2;

// White-ish phosphor for the line core, plus the two fringe tints.
const INK = 'rgba(214,230,255,1)';
const FRINGE_R = 'rgba(255,45,45,0.85)';
const FRINGE_C = 'rgba(40,170,255,0.85)';
const PLAYHEAD = '#46ff95';

export class Op1Tape {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private getState: () => TapeState;

  // offscreen buffers (device-pixel sized, rebuilt on resize)
  private art: HTMLCanvasElement;
  private artCtx: CanvasRenderingContext2D;
  private tint: HTMLCanvasElement;
  private tintCtx: CanvasRenderingContext2D;
  private dots: CanvasPattern | null = null;

  private dpr = 1;
  private W = 0;
  private H = 0;
  private unit = 1;     // 1% of the short edge, in device px — the layout grid

  // animation accumulators
  private reel = 0;     // reel rotation (radians)
  private scroll = 0;   // tape timeline scroll (device px)
  private elapsed = 0;  // timecode seconds
  private bright = 0;   // smoothed brightness from level
  private lastT = 0;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, getState: () => TapeState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.getState = getState;
    this.art = document.createElement('canvas');
    this.artCtx = this.art.getContext('2d')!;
    this.tint = document.createElement('canvas');
    this.tintCtx = this.tint.getContext('2d')!;
    this.resize();
    // Re-measure whenever the plate's box actually changes — a flex reflow or
    // HMR style swap resizes the canvas without firing a window 'resize', which
    // would otherwise leave the backing store stale and the content stretched.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement ?? this.canvas);
    }
  }

  start(): void {
    if (this.raf) return;
    this.lastT = performance.now();
    const loop = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const plate = this.canvas.parentElement as HTMLElement | null;
    const rect = (plate ?? this.canvas).getBoundingClientRect();
    // The plate's height comes from the stretched player row; its width must
    // follow the 280:132 face ratio. We set it explicitly because the canvas is
    // absolutely positioned (.tape-screen canvas) and so no longer seeds the
    // plate's content width — which previously fed a ResizeObserver loop that ran
    // the backing store up to the browser's ~2^24 size clamp.
    const cssH = rect.height;
    const cssW = Math.round(cssH * 280 / 132);
    if (plate && plate.style.width !== cssW + 'px') plate.style.width = cssW + 'px';
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (w === this.W && h === this.H) return;   // size unchanged → skip the rebuild
    this.W = w;
    this.H = h;
    this.unit = Math.min(w, h) / 100;
    for (const c of [this.canvas, this.art, this.tint]) {
      c.width = w;
      c.height = h;
    }
    this.dots = this.buildDotPattern();
  }

  // A repeating tile holding one soft white dot — the matrix that every line is
  // punched through so it reads as stippled phosphor rather than a solid stroke.
  private buildDotPattern(): CanvasPattern | null {
    const t = Math.max(2, Math.round(3 * this.dpr));
    const tile = document.createElement('canvas');
    tile.width = t;
    tile.height = t;
    const c = tile.getContext('2d')!;
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(t / 2, t / 2, t * 0.4, 0, TWO_PI);
    c.fill();
    return this.artCtx.createPattern(tile, 'repeat');
  }

  // ── per-frame ──
  private frame(t: number): void {
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    const s = this.getState();

    // brightness eases toward the live level (with an idle floor so the screen
    // never goes fully dark) — used to subtly pulse the phosphor.
    const target = s.running ? 0.35 + s.level * 0.65 : 0.5;
    this.bright += (target - this.bright) * Math.min(1, dt * 6);

    // Reels idle slowly when parked, run at tape speed when live (a touch of
    // level-driven flutter keeps it from looking like a clean loop).
    const reelSpeed = s.running ? 1.15 + s.level * 0.5 : 0.16;
    this.reel = (this.reel + reelSpeed * dt) % TWO_PI;

    if (s.running) {
      this.elapsed += dt;
      this.scroll += this.unit * 6 * dt; // timeline crawls left under the head
    }

    this.render();
  }

  private render(): void {
    const { ctx, W, H, unit } = this;

    // 1) white linework onto the art buffer
    const a = this.artCtx;
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.clearRect(0, 0, W, H);
    a.globalCompositeOperation = 'source-over';
    a.lineCap = 'round';
    a.lineJoin = 'round';
    a.strokeStyle = INK;
    a.fillStyle = INK;

    this.drawTimecode(a);
    this.drawTrackBadge(a);
    this.drawReel(a, W * 0.255, H * 0.5, unit * 30, this.reel, true);
    this.drawReel(a, W * 0.745, H * 0.5, unit * 30, this.reel, false);
    this.drawTransport(a);
    this.drawTimeline(a);
    this.drawRightRail(a);

    // 2) punch the linework through the dot matrix
    if (this.dots) {
      a.globalCompositeOperation = 'destination-in';
      a.fillStyle = this.dots;
      a.fillRect(0, 0, W, H);
      a.globalCompositeOperation = 'source-over';
    }

    // 3) composite onto the screen. The plate uses the SAME glossy top→black
    // gradient as the BPM LCD so the two screens read as one inset, recessed
    // surface (the opaque canvas would otherwise hide the panel's bevel).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#26292e');
    bg.addColorStop(0.12, '#15171b');
    bg.addColorStop(0.45, '#0a0b0e');
    bg.addColorStop(1, '#040507');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const d = Math.max(1, this.dpr * 1.4); // split distance
    ctx.globalCompositeOperation = 'lighter';
    this.blitTinted(FRINGE_C, d);
    this.blitTinted(FRINGE_R, -d);
    ctx.globalAlpha = 0.92 * (0.7 + this.bright * 0.3);
    ctx.drawImage(this.art, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 4) overlays drawn straight on the glass
    this.drawScanlines(ctx);
    this.drawPlayhead(ctx);
    this.drawVignette(ctx);
    this.drawBevel(ctx);
  }

  // The panel's inset box-shadow bevel (bright top edge, dark bottom edge) is
  // hidden behind the opaque canvas, so redraw it here to match the BPM LCD.
  private drawBevel(c: CanvasRenderingContext2D): void {
    const { W, H, dpr } = this;
    const t = Math.max(1, Math.round(dpr));
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(0, 0, W, t);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, H - t, W, t);
  }

  // Recolour the (white) art buffer to `color`, then add it at an x-offset.
  private blitTinted(color: string, dx: number): void {
    const t = this.tintCtx;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, this.W, this.H);
    t.drawImage(this.art, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = color;
    t.fillRect(0, 0, this.W, this.H);
    t.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.tint, dx, 0);
  }

  // ── elements ──────────────────────────────────────────────────────────

  private drawTimecode(c: CanvasRenderingContext2D): void {
    const { W, H, unit } = this;
    const total = Math.floor(this.elapsed);
    const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const cs = String(Math.floor((this.elapsed % 1) * 100)).padStart(2, '0');
    const text = `${mm}:${ss}:${cs}`;

    const size = unit * 17;
    c.save();
    c.font = `700 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = unit * 0.6;
    c.strokeText(text, W * 0.5, H * 0.155);
    c.restore();

    // fine tick ruler beneath the clock
    const cx = W * 0.5;
    const y = H * 0.27;
    const span = unit * 26;
    c.lineWidth = Math.max(1, unit * 0.7);
    for (let i = -6; i <= 6; i++) {
      const x = cx + (i / 6) * span;
      const tall = i % 3 === 0;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x, y + (tall ? unit * 3.4 : unit * 1.8));
      c.stroke();
    }
  }

  private drawTrackBadge(c: CanvasRenderingContext2D): void {
    const { unit } = this;
    const x = unit * 5;
    const y = unit * 6;
    const sz = unit * 16;
    c.lineWidth = Math.max(1.5, unit * 1.1);
    this.roundRect(c, x, y, sz, sz, unit * 2.5);
    c.stroke();
    c.save();
    c.font = `700 ${unit * 11}px ui-monospace, Menlo, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('1', x + sz / 2, y + sz / 2 + unit * 0.5);
    c.restore();
  }

  // One tape reel: outer rim, inner rings, and a rotating three-arm spool clamp.
  private drawReel(
    c: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    angle: number,
    full: boolean,
  ): void {
    const { unit } = this;
    c.lineWidth = Math.max(1.5, unit * 1.2);

    c.beginPath();
    c.arc(cx, cy, r, 0, TWO_PI);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, r * 0.86, 0, TWO_PI);
    c.stroke();
    if (full) {
      // supply reel reads "fuller" with an extra tape-pack ring
      c.beginPath();
      c.arc(cx, cy, r * 0.62, 0, TWO_PI);
      c.stroke();
    }

    // hub
    const hub = r * 0.34;
    c.beginPath();
    c.arc(cx, cy, hub, 0, TWO_PI);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, r * 0.07, 0, TWO_PI);
    c.fill();

    // three spokes + clamp arms
    c.lineWidth = Math.max(1.5, unit * 1.6);
    for (let k = 0; k < 3; k++) {
      const ang = angle + (k * TWO_PI) / 3;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      // long thin spoke out toward the rim
      c.lineWidth = Math.max(1, unit * 0.9);
      c.beginPath();
      c.moveTo(cx + dx * hub, cy + dy * hub);
      c.lineTo(cx + dx * r * 0.82, cy + dy * r * 0.82);
      c.stroke();
      // stubby clamp arm on the hub
      c.lineWidth = Math.max(2, unit * 2.4);
      c.beginPath();
      c.moveTo(cx + dx * r * 0.1, cy + dy * r * 0.1);
      c.lineTo(cx + dx * hub * 1.05, cy + dy * hub * 1.05);
      c.stroke();
    }
  }

  // Capstan / pinch-roller / head cluster slung below the reels, with the tape
  // dipping down from each reel to the centre.
  private drawTransport(c: CanvasRenderingContext2D): void {
    const { W, H, unit } = this;
    const cx = W * 0.5;
    const baseY = H * 0.8;
    const rL = W * 0.255;
    const rR = W * 0.745;
    const reelBottom = H * 0.5 + unit * 30;

    c.lineWidth = Math.max(1, unit * 0.9);
    // tape path: reel → guide → centre, mirrored
    c.beginPath();
    c.moveTo(rL, reelBottom);
    c.quadraticCurveTo(rL + W * 0.04, baseY, cx - unit * 6, baseY);
    c.lineTo(cx + unit * 6, baseY);
    c.quadraticCurveTo(rR - W * 0.04, baseY, rR, reelBottom);
    c.stroke();

    // guide rollers
    for (const gx of [W * 0.36, W * 0.64]) {
      c.beginPath();
      c.arc(gx, baseY - unit * 0.5, unit * 3.2, 0, TWO_PI);
      c.stroke();
    }

    // capstan (with shaft slash) + pinch roller flanking the head
    c.beginPath();
    c.arc(cx - unit * 9, baseY - unit * 1, unit * 3.4, 0, TWO_PI);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - unit * 11, baseY - unit * 3);
    c.lineTo(cx - unit * 7, baseY + unit * 1);
    c.stroke();
    c.beginPath();
    c.arc(cx + unit * 9, baseY - unit * 1, unit * 3.4, 0, TWO_PI);
    c.stroke();

    // record/play head stack ( ⃦ ) sitting above the centre playhead square
    c.lineWidth = Math.max(2, unit * 2);
    for (const hx of [cx - unit * 1.8, cx + unit * 1.8]) {
      c.beginPath();
      c.moveTo(hx, baseY - unit * 13);
      c.lineTo(hx, baseY - unit * 5.5);
      c.stroke();
    }
    // playhead marker square riding on the tape
    c.lineWidth = Math.max(1.5, unit * 1.2);
    const sq = unit * 5;
    this.roundRect(c, cx - sq / 2, baseY - sq / 2, sq, sq, unit * 0.8);
    c.stroke();
  }

  // Four-lane tape timeline at the very bottom; pseudo-random clips scroll past
  // the centre. Deterministic per-lane hashing keeps clips stable as they move.
  private drawTimeline(c: CanvasRenderingContext2D): void {
    const { W, H, unit } = this;
    const lanes = 4;
    const top = H * 0.88;
    const laneH = (H * 0.11) / lanes;
    const cell = unit * 9;
    const cols = Math.ceil(W / cell) + 4;
    const offset = this.scroll % cell;
    const startCol = Math.floor(this.scroll / cell);

    for (let l = 0; l < lanes; l++) {
      const ly = top + l * laneH + laneH * 0.5;
      // baseline
      c.lineWidth = 1;
      c.globalAlpha = 0.5;
      c.beginPath();
      c.moveTo(0, ly);
      c.lineTo(W, ly);
      c.stroke();
      c.globalAlpha = 1;

      // clips
      for (let i = 0; i < cols; i++) {
        const col = startCol + i;
        const h = this.hash(l * 131 + col * 17);
        if (h < 0.45) continue;
        const x = i * cell - offset;
        const w = cell * (0.45 + this.hash(col * 7 + l) * 0.5);
        const bh = laneH * (0.3 + h * 0.5);
        c.fillRect(x, ly - bh / 2, w, bh);
      }
    }
  }

  // Thin vertical rail on the right edge with a record dot — the OP-1's
  // master/level tick. Just garnish for the silhouette.
  private drawRightRail(c: CanvasRenderingContext2D): void {
    const { W, H, unit } = this;
    const x = W - unit * 4;
    c.lineWidth = Math.max(1, unit * 0.8);
    c.beginPath();
    c.moveTo(x, H * 0.08);
    c.lineTo(x, H * 0.74);
    c.stroke();
    c.beginPath();
    c.arc(x, H * 0.06, unit * 2.4, 0, TWO_PI);
    c.fill();
  }

  // ── glass overlays ──────────────────────────────────────────────────────

  private drawScanlines(c: CanvasRenderingContext2D): void {
    const { W, H, dpr } = this;
    const step = Math.max(2, Math.round(2 * dpr));
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < H; y += step * 2) c.fillRect(0, y, W, step);
  }

  private drawPlayhead(c: CanvasRenderingContext2D): void {
    const { W, H, unit } = this;
    const x = W * 0.5;
    const top = H * 0.62;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = PLAYHEAD;
    c.shadowColor = PLAYHEAD;
    c.shadowBlur = unit * 4 * (0.6 + this.bright);
    c.lineWidth = Math.max(1.5, unit * 1.1);
    c.beginPath();
    c.moveTo(x, top);
    c.lineTo(x, H);
    c.stroke();
    // little diamond cursor where the head meets the timeline
    c.fillStyle = PLAYHEAD;
    const s = unit * 2.2;
    c.beginPath();
    c.moveTo(x, H * 0.85 - s);
    c.lineTo(x + s, H * 0.85);
    c.lineTo(x, H * 0.85 + s);
    c.lineTo(x - s, H * 0.85);
    c.closePath();
    c.fill();
    c.restore();
  }

  private drawVignette(c: CanvasRenderingContext2D): void {
    const { W, H } = this;
    const g = c.createRadialGradient(
      W * 0.5, H * 0.5, Math.min(W, H) * 0.2,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.62,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    // glossy top sheen, like light catching the recessed glass
    const t = c.createLinearGradient(0, 0, 0, H * 0.32);
    t.addColorStop(0, 'rgba(150,190,255,0.12)');
    t.addColorStop(0.5, 'rgba(120,170,255,0.04)');
    t.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = t;
    c.fillRect(0, 0, W, H * 0.32);
  }

  // ── helpers ──
  private roundRect(
    c: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // cheap stable pseudo-random in [0,1)
  private hash(n: number): number {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }
}
