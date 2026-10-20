/**
 * Aftershock BGM — alternate two loops forever (1→2→1→2…).
 * Starts on play; respects autoplay (retry on first gesture if blocked).
 * Mute preference persisted in localStorage.
 */

const MUTE_KEY = 'aftershock-bgm-muted';
const TRACKS = [
  '/audio/lub-dub-loop-1.mp3',
  '/audio/lub-dub-loop-2.mp3',
];

export function createBgm() {
  let index = 0;
  let audio = null;
  let started = false;
  let wantPlay = false;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* */ }

  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn({ muted, playing: !!(audio && !audio.paused) });
  }

  function persist() {
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* */ }
  }

  function makeAudio(src) {
    const a = new Audio(src);
    a.preload = 'auto';
    a.loop = false;
    a.volume = muted ? 0 : 0.55;
    a.addEventListener('ended', () => {
      index = (index + 1) % TRACKS.length;
      playCurrent();
    });
    a.addEventListener('error', () => {
      // Skip broken track after a beat
      setTimeout(() => {
        index = (index + 1) % TRACKS.length;
        if (wantPlay) playCurrent();
      }, 400);
    });
    return a;
  }

  function playCurrent() {
    if (!wantPlay) return;
    if (audio) {
      try { audio.pause(); } catch { /* */ }
      audio = null;
    }
    audio = makeAudio(TRACKS[index]);
    audio.muted = muted;
    audio.volume = muted ? 0 : 0.55;
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        started = true;
        notify();
      }).catch(() => {
        // Autoplay blocked — wait for unlock gesture
        started = false;
        notify();
      });
    } else {
      started = true;
      notify();
    }
  }

  function start() {
    wantPlay = true;
    if (!audio || audio.paused) playCurrent();
    else notify();
  }

  function stop() {
    wantPlay = false;
    if (audio) {
      try { audio.pause(); } catch { /* */ }
    }
    notify();
  }

  function setMuted(v) {
    muted = !!v;
    persist();
    if (audio) {
      audio.muted = muted;
      audio.volume = muted ? 0 : 0.55;
    }
    notify();
  }

  function toggleMute() {
    setMuted(!muted);
    // If user unmutes / interacts, try start (unlocks autoplay)
    if (!muted && wantPlay) {
      if (!audio || audio.paused) playCurrent();
      else audio.play().catch(() => {});
    }
    return muted;
  }

  function unlock() {
    if (wantPlay && (!audio || audio.paused)) playCurrent();
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    start,
    stop,
    unlock,
    toggleMute,
    setMuted,
    onChange,
    get muted() { return muted; },
    get playing() { return !!(audio && !audio.paused); },
  };
}
