export type MidiEvent =
  | { type: 'noteon'; note: number; velocity: number }
  | { type: 'noteoff'; note: number }
  | { type: 'cc'; controller: number; value: number };

export type MidiHandler = (e: MidiEvent) => void;

export async function setupMidi(handler: MidiHandler): Promise<{
  access: MIDIAccess;
  inputNames: string[];
} | null> {
  if (!('requestMIDIAccess' in navigator)) {
    console.warn('WebMIDI not supported in this browser');
    return null;
  }
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const inputNames: string[] = [];

  const bind = (input: MIDIInput) => {
    inputNames.push(input.name ?? 'unknown');
    input.onmidimessage = (e) => {
      const data = e.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const d1 = data[1];
      const d2 = data[2] ?? 0;
      if (status === 0x90 && d2 > 0) handler({ type: 'noteon', note: d1, velocity: d2 });
      else if (status === 0x80 || (status === 0x90 && d2 === 0)) handler({ type: 'noteoff', note: d1 });
      else if (status === 0xb0) handler({ type: 'cc', controller: d1, value: d2 });
    };
  };

  for (const input of access.inputs.values()) bind(input);
  access.onstatechange = (e) => {
    const port = (e as MIDIConnectionEvent).port;
    if (port && port.type === 'input' && port.state === 'connected') {
      bind(port as MIDIInput);
    }
  };

  return { access, inputNames };
}
