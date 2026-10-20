/**
 * Input layer: desktop WASD + pointer-lock, or mobile virtual stick + touch-look.
 * Detects touch / coarse pointer and exposes a unified wish vector + look deltas.
 */

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
  const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  return !!(coarse || touch);
}

export function createControls(domElement) {
  const mobile = isTouchDevice();
  const state = {
    mobile,
    locked: false,
    fwd: 0,
    side: 0,
    sprint: false,
    lookDx: 0,
    lookDy: 0,
    energyBlocked: false,
  };

  const keys = new Set();
  let stickActive = false;
  let stickId = null;
  let stickOrigin = { x: 0, y: 0 };
  let stickVec = { x: 0, y: 0 };
  let lookId = null;
  let lastLook = { x: 0, y: 0 };
  let runHeld = false;

  // --- desktop ---
  const onKeyDown = (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  };
  const onKeyUp = (e) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  const onMouseMove = (e) => {
    if (!state.locked || mobile) return;
    state.lookDx += e.movementX;
    state.lookDy += e.movementY;
  };

  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === domElement;
    if (!state.locked) keys.clear();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);

  // --- mobile UI ---
  let ui = null;
  if (mobile) {
    ui = buildMobileUI();
    const zone = ui.stickZone;
    const knob = ui.knob;
    const runBtn = ui.runBtn;

    const setKnob = (nx, ny) => {
      const max = 48;
      const len = Math.hypot(nx, ny) || 1;
      const clamped = Math.min(len, max);
      const cx = (nx / len) * clamped;
      const cy = (ny / len) * clamped;
      knob.style.transform = `translate(${cx}px, ${cy}px)`;
      stickVec.x = cx / max;
      stickVec.y = cy / max;
    };

    const resetStick = () => {
      stickActive = false;
      stickId = null;
      stickVec.x = 0;
      stickVec.y = 0;
      knob.style.transform = 'translate(0, 0)';
    };

    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      stickId = e.pointerId;
      stickActive = true;
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      stickOrigin.x = r.left + r.width / 2;
      stickOrigin.y = r.top + r.height / 2;
      setKnob(e.clientX - stickOrigin.x, e.clientY - stickOrigin.y);
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      setKnob(e.clientX - stickOrigin.x, e.clientY - stickOrigin.y);
      e.preventDefault();
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      resetStick();
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    runBtn.addEventListener('pointerdown', (e) => {
      runHeld = true;
      runBtn.classList.add('on');
      e.preventDefault();
    });
    const endRun = () => {
      runHeld = false;
      runBtn.classList.remove('on');
    };
    runBtn.addEventListener('pointerup', endRun);
    runBtn.addEventListener('pointercancel', endRun);
    runBtn.addEventListener('pointerleave', endRun);

    // touch-look: any pointer on the canvas / look area that isn't the stick
    const onLookDown = (e) => {
      if (e.target.closest?.('.mobile-controls')) return;
      if (lookId !== null) return;
      lookId = e.pointerId;
      lastLook.x = e.clientX;
      lastLook.y = e.clientY;
      try { domElement.setPointerCapture(e.pointerId); } catch { /* */ }
      e.preventDefault();
    };
    const onLookMove = (e) => {
      if (e.pointerId !== lookId) return;
      state.lookDx += e.clientX - lastLook.x;
      state.lookDy += e.clientY - lastLook.y;
      lastLook.x = e.clientX;
      lastLook.y = e.clientY;
      e.preventDefault();
    };
    const onLookUp = (e) => {
      if (e.pointerId !== lookId) return;
      lookId = null;
    };
    domElement.addEventListener('pointerdown', onLookDown, { passive: false });
    domElement.addEventListener('pointermove', onLookMove, { passive: false });
    domElement.addEventListener('pointerup', onLookUp);
    domElement.addEventListener('pointercancel', onLookUp);
  }

  function poll() {
    state.lookDx = 0;
    state.lookDy = 0;
    // look deltas accumulate via listeners; we snapshot and clear each frame after player reads them
  }

  function sample() {
    const look = { dx: state.lookDx, dy: state.lookDy };
    state.lookDx = 0;
    state.lookDy = 0;

    if (mobile) {
      const mag = Math.hypot(stickVec.x, stickVec.y);
      // stick: y down is positive in screen space → forward is -y
      state.fwd = mag > 0.12 ? -stickVec.y : 0;
      state.side = mag > 0.12 ? stickVec.x : 0;
      // run if button held OR stick past ~70% magnitude
      state.sprint = runHeld || mag > 0.7;
      return look;
    }

    let fwd = 0, side = 0;
    if (state.locked) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1;
    }
    state.fwd = fwd;
    state.side = side;
    state.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    return look;
  }

  function lock() {
    if (mobile) {
      state.locked = true;
      return;
    }
    domElement.requestPointerLock?.();
  }

  function unlock() {
    if (mobile) {
      state.locked = false;
      return;
    }
    document.exitPointerLock?.();
  }

  function setVisible(v) {
    if (ui) ui.root.style.display = v ? 'block' : 'none';
  }

  return {
    state,
    sample,
    poll,
    lock,
    unlock,
    setVisible,
    keys,
    get mobile() { return mobile; },
  };
}

function buildMobileUI() {
  const root = document.createElement('div');
  root.className = 'mobile-controls';
  root.innerHTML = `
    <div class="stick-zone" aria-label="Move">
      <div class="stick-base"><div class="stick-knob"></div></div>
    </div>
    <button type="button" class="run-btn" aria-label="Run">RUN</button>
  `;
  document.body.appendChild(root);
  return {
    root,
    stickZone: root.querySelector('.stick-zone'),
    knob: root.querySelector('.stick-knob'),
    runBtn: root.querySelector('.run-btn'),
  };
}
