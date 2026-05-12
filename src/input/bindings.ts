// Ableton-style learn mode for mapping keys / MIDI notes to in-app actions.
// Each "action" has down/up handlers and an optional pill element. In learn mode,
// clicking a pill puts it in "waiting" state; the next key or MIDI noteon binds.
// Bindings persist to localStorage so the mapping survives reloads.

export type Binding =
  | { source: 'key'; code: string }      // KeyboardEvent.code (layout-independent)
  | { source: 'midi'; note: number };

export type ActionHandler = {
  down?: () => void;
  up?: () => void;
};

export type RegisterOptions = {
  pill?: HTMLElement;
  default?: Binding;
};

export class BindingManager {
  private actions = new Map<string, ActionHandler>();
  private pills = new Map<string, HTMLElement>();
  private defaults = new Map<string, Binding>();
  private actionToBinding = new Map<string, Binding>();
  private bindingKeyToAction = new Map<string, string>();
  private learning: string | null = null;
  private learnMode = false;
  private storageKey: string;

  constructor(storageKey = 'dj-keypad-bindings') {
    this.storageKey = storageKey;
    this.load();
  }

  register(id: string, handler: ActionHandler, opts?: RegisterOptions): void {
    this.actions.set(id, handler);
    if (opts?.pill) {
      this.pills.set(id, opts.pill);
      opts.pill.addEventListener('click', () => {
        if (!this.learnMode) return;
        // Click an already-learning pill to cancel.
        if (this.learning === id) this.cancelLearn();
        else this.startLearn(id);
      });
    }
    if (opts?.default) this.defaults.set(id, opts.default);
    if (opts?.default && !this.actionToBinding.has(id)) {
      this.applyBinding(id, opts.default);
    }
    this.refreshPillLabel(id);
  }

  enterLearnMode(): void {
    this.learnMode = true;
    document.body.classList.add('learn-mode');
  }

  exitLearnMode(): void {
    this.learnMode = false;
    this.cancelLearn();
    document.body.classList.remove('learn-mode');
  }

  toggleLearnMode(): boolean {
    if (this.learnMode) this.exitLearnMode();
    else this.enterLearnMode();
    return this.learnMode;
  }

  isLearnMode(): boolean {
    return this.learnMode;
  }

  cancelLearn(): void {
    if (this.learning) this.pills.get(this.learning)?.classList.remove('learning');
    this.learning = null;
  }

  private startLearn(actionId: string): void {
    this.cancelLearn();
    this.learning = actionId;
    this.pills.get(actionId)?.classList.add('learning');
  }

  handleKey(code: string, phase: 'down' | 'up'): boolean {
    if (this.learnMode && phase === 'down' && this.learning) {
      if (code === 'Escape') this.cancelLearn();
      else { this.applyBinding(this.learning, { source: 'key', code }); this.cancelLearn(); }
      return true;
    }
    if (this.learnMode) return false; // suppress triggers while mapping
    return this.fire(`key:${code}`, phase);
  }

  handleMidi(note: number, phase: 'on' | 'off'): boolean {
    if (this.learnMode && phase === 'on' && this.learning) {
      this.applyBinding(this.learning, { source: 'midi', note });
      this.cancelLearn();
      return true;
    }
    if (this.learnMode) return false;
    return this.fire(`midi:${note}`, phase === 'on' ? 'down' : 'up');
  }

  resetAll(): void {
    this.actionToBinding.clear();
    this.bindingKeyToAction.clear();
    for (const [id, b] of this.defaults) this.applyBinding(id, b);
    this.persist();
  }

  private fire(bindingKey: string, phase: 'down' | 'up'): boolean {
    const id = this.bindingKeyToAction.get(bindingKey);
    if (!id) return false;
    const h = this.actions.get(id);
    if (!h) return false;
    // Momentary press visual — toggled regardless of whatever state classes
    // (on/recording/armed/etc.) the action itself manages.
    const pill = this.pills.get(id);
    if (phase === 'down') {
      pill?.classList.add('pressed');
      h.down?.();
    } else {
      pill?.classList.remove('pressed');
      h.up?.();
    }
    return true;
  }

  private applyBinding(actionId: string, b: Binding): void {
    const bk = this.bKey(b);
    // Steal the binding from whichever action had it before
    const prevAction = this.bindingKeyToAction.get(bk);
    if (prevAction && prevAction !== actionId) {
      this.actionToBinding.delete(prevAction);
      this.refreshPillLabel(prevAction);
    }
    // Drop this action's previous binding from the reverse index
    const oldB = this.actionToBinding.get(actionId);
    if (oldB) this.bindingKeyToAction.delete(this.bKey(oldB));

    this.actionToBinding.set(actionId, b);
    this.bindingKeyToAction.set(bk, actionId);
    this.refreshPillLabel(actionId);
    this.persist();
  }

  private bKey(b: Binding): string {
    return b.source === 'key' ? `key:${b.code}` : `midi:${b.note}`;
  }

  private persist(): void {
    const obj: Record<string, Binding> = {};
    for (const [id, b] of this.actionToBinding) obj[id] = b;
    try { localStorage.setItem(this.storageKey, JSON.stringify(obj)); } catch {}
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, Binding>;
      for (const [id, b] of Object.entries(obj)) {
        this.actionToBinding.set(id, b);
        this.bindingKeyToAction.set(this.bKey(b), id);
      }
    } catch (e) {
      console.warn('[bindings] load failed:', e);
    }
  }

  private refreshPillLabel(actionId: string): void {
    const pill = this.pills.get(actionId);
    if (!pill) return;
    const span = pill.querySelector('.key') as HTMLElement | null;
    if (!span) return;
    const b = this.actionToBinding.get(actionId);
    span.textContent = b ? this.labelOf(b) : '—';
  }

  private labelOf(b: Binding): string {
    if (b.source === 'key') {
      const c = b.code;
      if (c.startsWith('Key')) return c.slice(3);
      if (c.startsWith('Digit')) return c.slice(5);
      if (c.startsWith('Numpad')) return 'np' + c.slice(6);
      if (c === 'Space') return '␣';
      return c;
    }
    return `M${b.note}`;
  }
}
