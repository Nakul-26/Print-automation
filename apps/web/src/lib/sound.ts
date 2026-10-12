const KEY = 'pp_owner_sound';

let context: AudioContext | null = null;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: the choice just will not be remembered.
  }
}

/**
 * Browsers only allow sound after the person has touched the page, so call this from a click
 * (the sound toggle or the first button pressed) to unlock it for later alerts.
 */
export function unlockSound(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // No audio support: alerts stay silent.
  }
}

/** Two short rising notes: loud enough for a busy counter, not a siren. */
export function playNewOrderChime(): void {
  if (!soundEnabled() || !context || context.state !== 'running') return;
  const start = context.currentTime;
  [660, 880].forEach((frequency, i) => {
    const osc = context!.createOscillator();
    const gain = context!.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + i * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.35, start + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.16 + 0.25);
    osc.connect(gain).connect(context!.destination);
    osc.start(start + i * 0.16);
    osc.stop(start + i * 0.16 + 0.3);
  });
}
