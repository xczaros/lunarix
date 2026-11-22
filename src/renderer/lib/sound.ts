let ctx: AudioContext | null = null;

/** Soft two-note chime played when the agent finishes. */
export function playChime() {
  try {
    ctx ||= new AudioContext();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
    [
      [783.99, 0],
      [1174.66, 0.12],
      [1567.98, 0.24]
    ].forEach(([freq, delay]) => {
      const osc = ctx!.createOscillator();
      const g = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(1, now + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, now + delay + 1.1);
      osc.connect(g);
      g.connect(master);
      osc.start(now + delay);
      osc.stop(now + delay + 1.2);
    });
  } catch {
    /* audio unavailable */
  }
}

export function playBlip() {
  try {
    ctx ||= new AudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
    /* ignore */
  }
}
