// Engraved control labels.
//
// pan-knob.html draws its button labels with `background-clip: text` over a
// dedicated `.pad-text` overlay. We can't put that clip on the .pill / .pad
// itself (it would clip the control's own face background to the glyphs), so we
// wrap each control's leading label text in a `.ctl-label` span and style that.
// The trailing `.key` keycap badge is left untouched.

export function styleControlLabels(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.pill, .pad').forEach((el) => {
    if (el.querySelector(':scope > .ctl-label')) return; // already wrapped

    const label = document.createElement('span');
    label.className = 'ctl-label';

    // Move every node up to (but not including) the .key badge into the label.
    while (
      el.firstChild &&
      !(el.firstChild instanceof HTMLElement && el.firstChild.classList.contains('key'))
    ) {
      label.appendChild(el.firstChild);
    }

    // Nothing to engrave (e.g. an icon-only or empty control) → drop the wrapper.
    if (!label.textContent?.trim()) return;
    el.insertBefore(label, el.firstChild);
  });
}

// Set a control's engraved label text, keeping the .ctl-label wrapper intact.
// Use this instead of `el.textContent = …` for controls whose label changes at
// runtime (e.g. the sampler mode pill), so they don't lose their styling.
export function setControlLabel(el: HTMLElement, text: string): void {
  const label = el.querySelector<HTMLElement>(':scope > .ctl-label') ?? el;
  label.textContent = text;
}
