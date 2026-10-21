/**
 * Positional one-shot SFX + quake rumble bed (WebAudio).
 *
 * Sounds were generated with Stable Audio Open 1.0 (see scripts/sfx/) and
 * live in public/audio/sfx/*.mp3. Distance attenuation and stereo pan are
 * computed against a 2D listener (x, z + camera right vector) set each frame.
 */
const BASE = (import.meta.env.BASE_URL || './').replace(/\/?$/, '/');
const FILES = [
  'crack', 'hole_open', 'rumble', 'whoosh',
  'impact_concrete', 'impact_metal', 'impact_tiles', 'impact_pot',
  'collapse', 'creak', 'hurt', 'fall',
  'horn', 'car_rush', 'car_crash',
];
/** Per-sound base gain + audible radius (m). */
const MIX = {
  crack: [0.8, 34],
  hole_open: [1.0, 44],
  whoosh: [0.45, 22],
  impact_concrete: [0.9, 36],
  impact_metal: [0.8, 36],
  impact_tiles: [0.8, 34],
  impact_pot: [0.75, 30],
  collapse: [1.0, 60],
  creak: [0.7, 28],
  hurt: [0.9, 0],
  fall: [0.9, 0],
  horn: [0.85, 40],
  car_rush: [0.9, 30],
  car_crash: [1.0, 45],
};
const MAX_VOICES = 3;

export function createSfx() {
  let ctx = null;
  let master = null;
  let muted = false;
  const buffers = new Map();
  const voices = new Map();
  const listener = { x: 0, z: 0, rx: 1, rz: 0, range: 1 };
  let rumble = null;
  let rumbleLevel = 0;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
      load();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  async function load() {
    await Promise.all(FILES.map(async (name) => {
      try {
        const res = await fetch(`${BASE}audio/sfx/${name}.mp3`);
        if (!res.ok) return;
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        buffers.set(name, buf);
      } catch { /* missing sound is non-fatal */ }
    }));
    if (typeof window !== 'undefined') window.__aftershockSfxLoaded = [...buffers.keys()];
    startRumble();
  }

  function startRumble() {
    const buf = buffers.get('rumble');
    if (!buf || rumble) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(master);
    src.start();
    rumble = { src, gain };
  }

  /** @param {{x:number,z:number,rx:number,rz:number,range?:number}} l */
  function setListener(l) {
    Object.assign(listener, l);
  }

  /** Every cue request, played or not — lets tests audit SFX coverage. */
  const log = {};
  if (typeof window !== 'undefined') window.__aftershockSfxLog = log;

  /**
   * Play a positional cue. x/z null → non-positional (UI / self).
   */
  function play(name, x = null, z = null, vol = 1) {
    log[name] = (log[name] || 0) + 1;
    if (!ctx || muted) return;
    const buf = buffers.get(name);
    if (!buf) return;
    const [base, radius] = MIX[name] || [0.8, 30];
    let gain = base * vol;
    let pan = 0;
    if (x != null && radius > 0) {
      const dx = x - listener.x;
      const dz = z - listener.z;
      const dist = Math.hypot(dx, dz);
      const r = radius * (listener.range || 1);
      const k = Math.max(0, 1 - dist / r);
      gain *= k * k;
      pan = dist > 0.5 ? Math.max(-0.85, Math.min(0.85, (dx * listener.rx + dz * listener.rz) / dist)) : 0;
    }
    if (gain < 0.02) return;
    const n = voices.get(name) || 0;
    if (n >= MAX_VOICES) return;
    voices.set(name, n + 1);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node = src.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(master);
    src.onended = () => voices.set(name, Math.max(0, (voices.get(name) || 1) - 1));
    src.start();
  }

  /** 0..1 quake intensity drives the looping rumble bed. */
  function setRumble(level, dt) {
    if (!rumble) return;
    rumbleLevel += (Math.min(1, level) - rumbleLevel) * Math.min(1, dt * 4);
    rumble.gain.gain.value = muted ? 0 : 0.08 + rumbleLevel * 0.75;
  }

  function setMuted(m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : 0.9;
  }

  return { unlock, play, setListener, setRumble, setMuted };
}
