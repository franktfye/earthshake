import { sanitizeName, NAME_KEY } from '../net/protocol.js';

/**
 * Aftershock HUD: name login, start / death / retry, energy, timer, score.
 */

export function createHud() {
  const el = (tag, cls, parent, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    (parent || document.body).appendChild(n);
    return n;
  };

  const root = el('div', 'hud');
  const topBar = el('div', 'top-bar', root, `
    <button type="button" class="mute-btn" aria-label="Mute music" title="Mute / unmute BGM">
      <span class="mute-icon" aria-hidden="true">♪</span>
      <span class="mute-label">Sound</span>
    </button>
    <button type="button" class="mute-btn fs-btn" aria-label="Toggle full screen" title="Full screen">
      <span class="mute-icon" aria-hidden="true">⛶</span>
      <span class="fs-label">Full screen</span>
    </button>
  `);
  const muteBtn = topBar.querySelector('.mute-btn');
  const fsBtn = topBar.querySelector('.fs-btn');
  const fsEl = document.documentElement;
  const fsSupported = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
  if (!fsSupported) fsBtn.style.display = 'none'; // iPhone Safari: no page fullscreen
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else requestFullscreen();
  });
  const syncFs = () => {
    fsBtn.classList.toggle('is-on', isFs());
    fsBtn.querySelector('.fs-label').textContent = isFs() ? 'Exit full screen' : 'Full screen';
  };
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  let onMuteToggle = null;
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onMuteToggle?.();
  });

  const vitals = el('div', 'vitals', root, `
    <div class="lives-row" aria-label="Lives">
      <span class="heart on" data-i="0"></span>
      <span class="heart on" data-i="1"></span>
      <span class="heart on" data-i="2"></span>
      <span class="shindo" title="Quake intensity (shindo)">震度 1</span>
      <span class="jump-chip" title="Jump (Space) — 2 s cooldown">JUMP</span>
    </div>
    <div class="vital-row">
      <span class="vital-label">ENERGY</span>
      <div class="energy-track"><div class="energy-fill"></div></div>
    </div>
    <div class="vital-meta">
      <span class="time">0:00</span>
      <span class="players">1/30</span>
      <span class="score">0</span>
    </div>
  `);
  const energyFill = vitals.querySelector('.energy-fill');
  const timeEl = vitals.querySelector('.time');
  const scoreEl = vitals.querySelector('.score');
  const playersEl = vitals.querySelector('.players');
  const hearts = [...vitals.querySelectorAll('.heart')];

  const hint = el('div', 'hint', root, '');
  const toast = el('div', 'toast', root, '');
  const spectateBanner = el('div', 'spectate-banner', root, `
    <strong>Spectating</strong> · Waiting for round to end
  `);
  const roundTimer = el('div', 'round-timer', root, '');

  const lobby = el('div', 'lobby-panel', root, `
    <div class="lobby-head">
      <div>
        <div class="lobby-kicker">ROOM · 余震</div>
        <div class="lobby-title">Waiting for runners</div>
      </div>
      <div class="lobby-clock"><span class="lobby-secs">60</span><small>s</small></div>
    </div>
    <div class="lobby-meter"><div class="lobby-meter-fill"></div><div class="lobby-meter-ready"></div></div>
    <div class="lobby-sub">
      <span><b class="lobby-filled">0</b>/<span class="lobby-max">30</span> joined · <b class="lobby-readyn">0</b> ready</span>
      <span class="lobby-mode">auto-start</span>
    </div>
    <ul class="lobby-list"></ul>
    <button type="button" class="lobby-ready">I'm ready</button>
  `);
  const lobbyFilled = lobby.querySelector('.lobby-filled');
  const lobbyMax = lobby.querySelector('.lobby-max');
  const lobbyReadyN = lobby.querySelector('.lobby-readyn');
  const lobbySecs = lobby.querySelector('.lobby-secs');
  const lobbyMode = lobby.querySelector('.lobby-mode');
  const lobbyMeterFill = lobby.querySelector('.lobby-meter-fill');
  const lobbyMeterReady = lobby.querySelector('.lobby-meter-ready');
  const lobbyList = lobby.querySelector('.lobby-list');
  const lobbyReadyBtn = lobby.querySelector('.lobby-ready');

  const results = el('div', 'results-panel', root, `
    <div class="lobby-kicker">ROUND OVER · 余震</div>
    <div class="results-title">Results</div>
    <div class="results-me"></div>
    <ol class="results-list"></ol>
    <button type="button" class="lobby-ready results-again">Play again →</button>
    <div class="results-foot"><span class="results-clock"></span></div>
  `);
  const resultsMe = results.querySelector('.results-me');
  const resultsClock = results.querySelector('.results-clock');
  let onPlayAgain = null;
  results.querySelector('.results-again').addEventListener('click', () => onPlayAgain?.());
  const resultsList = results.querySelector('.results-list');
  let onReady = null;
  lobbyReadyBtn.addEventListener('click', () => onReady?.());

  let savedName = '';
  try { savedName = localStorage.getItem(NAME_KEY) || ''; } catch { /* */ }

  const overlay = el('div', 'overlay', root);
  overlay.dataset.mode = 'start';
  overlay.innerHTML = `
    <section class="menu-panel" role="dialog" aria-labelledby="menu-title">
      <div class="menu-art" aria-hidden="true">
        <div class="art-index">街区 · AFTERSHOCK</div>
        <div class="art-kanji">余震</div>
        <div class="art-caption"><span>Keep moving</span><strong>地面が割れる</strong></div>
      </div>
      <div class="menu-copy">
        <div class="menu-kicker">
          <span class="start-only">One map · up to 30 runners</span>
          <span class="dead-only">You didn't make it</span>
          <span class="full-only">Server full</span>
        </div>
        <h1 id="menu-title">After<span>shock</span></h1>
        <p class="menu-description start-only">
          Enter a name and run. The town comes apart on a shared timeline —
          Three lives. Dodge shadowed debris, collapses, and black fissures.
        </p>
        <p class="menu-description dead-only">
          <span class="death-reason">—</span><br/>
          Survived <strong class="final-time">0:00</strong>
          · Score <strong class="final-score">0</strong>
          · Best <strong class="best-score">0</strong>
        </p>
        <p class="menu-description full-only">
          <span class="full-message">Server full (30/30).</span>
        </p>
        <label class="name-field start-only">
          <span>Display name</span>
          <input class="name-input" type="text" maxlength="16" autocomplete="nickname"
            placeholder="Your name" value="${escapeAttr(savedName)}" />
        </label>
        <p class="name-error start-only" hidden></p>
        <div class="gender-pick start-only" role="radiogroup" aria-label="Character">
          <button type="button" class="gender-card" data-gender="m" role="radio">
            <img src="./character/aftershock-hero-sheet.jpg" alt="" /><span>Kenji</span>
          </button>
          <button type="button" class="gender-card" data-gender="f" role="radio">
            <img src="./character/aftershock-heroine-sheet.jpg" alt="" /><span>Aoi</span>
          </button>
        </div>
        <div class="control-strip desktop-only">
          <span><b>WASD</b> Walk (recharges)</span>
          <span><b>Shift</b> Run (drains)</span>
          <span><b>Space</b> Jump</span>
          <span><b>Mouse</b> Orbit</span>
        </div>
        <div class="control-strip mobile-only">
          <span><b>Stick</b> Walk (recharges)</span>
          <span><b>RUN</b> Drains</span>
          <span><b>JUMP</b> Hop gaps</span>
          <span><b>Drag</b> Orbit</span>
        </div>
        <button class="menu-action" type="button">
          <span class="start-only">Join &amp; run</span>
          <span class="dead-only">Try again</span>
          <span class="full-only">Back</span>
          <i aria-hidden="true">→</i>
        </button>
        <div class="server-load start-only" aria-live="polite">
          <span class="sl-label">Server load</span>
          <span class="sl-bars"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="sl-text">checking…</span>
        </div>
        <p class="net-status start-only"></p>
        <p class="made-by">Made by Frank</p>
      </div>
    </section>`;

  // ---- content warning (shown before the menu; can be skipped next time)
  const WARN_KEY = 'aftershock-warning-ack';
  let warnAck = false;
  try { warnAck = localStorage.getItem(WARN_KEY) === '1'; } catch { /* */ }
  const warning = el('div', 'content-warning' + (warnAck ? '' : ' on'), root, `
    <section class="cw-card" role="alertdialog" aria-labelledby="cw-title" aria-describedby="cw-body">
      <div class="cw-icon" aria-hidden="true">⚠</div>
      <h2 id="cw-title">Content warning</h2>
      <p id="cw-body">
        <b>Aftershock is an anxiety-inducing game.</b> It simulates an earthquake:
        constant ground shaking and camera shake, collapsing buildings, fire,
        explosions, sudden loud sounds, red flashing screens and time pressure.
      </p>
      <p class="cw-small">
        If you are sensitive to stress, panic, motion or flashing effects — or have
        been affected by a real earthquake — please take care, play in short
        sessions, and stop at any time. Muting sound (top right) lowers intensity.
      </p>
      <label class="cw-check"><input type="checkbox" class="cw-remember" /> Don't show this again</label>
      <div class="cw-actions">
        <button type="button" class="cw-ok">I understand — continue</button>
        <a class="cw-leave" href="about:blank">Leave</a>
      </div>
    </section>`);
  warning.querySelector('.cw-ok').addEventListener('click', () => {
    if (warning.querySelector('.cw-remember').checked) {
      try { localStorage.setItem(WARN_KEY, '1'); } catch { /* */ }
    }
    warning.classList.remove('on');
    overlay.querySelector('.name-input')?.focus();
  });

  // ---- server load bars on the login card
  const slBars = [...overlay.querySelectorAll('.sl-bars i')];
  const slText = overlay.querySelector('.server-load .sl-text');
  const slBox = overlay.querySelector('.server-load');
  function setServerLoad(h) {
    if (!h) {
      slBox.dataset.level = 'off';
      slBars.forEach((b) => b.classList.remove('on'));
      slText.textContent = 'offline — solo mode';
      return;
    }
    const load = Math.max(0, Math.min(1, h.load ?? (h.players / (h.max || 30))));
    const n = Math.max(1, Math.ceil(load * 5));
    slBars.forEach((b, i) => b.classList.toggle('on', i < n));
    const level = load >= 0.95 ? 'full' : load >= 0.7 ? 'high' : load >= 0.4 ? 'mid' : 'low';
    slBox.dataset.level = level;
    const word = { low: 'Low', mid: 'Moderate', high: 'High', full: 'Full' }[level];
    const phase = h.phase === 'playing' ? ' · round in progress (you’ll observe)' : '';
    slText.textContent = `${word} · ${h.players}/${h.max} runners${phase}`;
  }

  const actionBtn = overlay.querySelector('.menu-action');
  const nameInput = overlay.querySelector('.name-input');
  const nameError = overlay.querySelector('.name-error');
  const netStatus = overlay.querySelector('.net-status');
  const deathReason = overlay.querySelector('.death-reason');
  const finalTime = overlay.querySelector('.final-time');
  const finalScore = overlay.querySelector('.final-score');
  const bestScore = overlay.querySelector('.best-score');
  const fullMessage = overlay.querySelector('.full-message');

  let onStart = null;
  let toastTimer = 0;

  // Character / gender choice (remembered)
  let gender = 'm';
  try { gender = localStorage.getItem('aftershock-gender') === 'f' ? 'f' : 'm'; } catch { /* */ }
  const genderCards = [...overlay.querySelectorAll('.gender-card')];
  const syncGender = () => {
    for (const c of genderCards) {
      const on = c.dataset.gender === gender;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  for (const c of genderCards) {
    c.addEventListener('click', () => {
      gender = c.dataset.gender;
      try { localStorage.setItem('aftershock-gender', gender); } catch { /* */ }
      syncGender();
    });
  }
  syncGender();

  actionBtn.addEventListener('click', () => {
    if (overlay.dataset.mode === 'full') {
      showStart();
      return;
    }
    if (overlay.dataset.mode === 'start') {
      const name = sanitizeName(nameInput.value);
      if (!name) {
        nameError.hidden = false;
        nameError.textContent = 'Enter a name (letters, numbers, spaces).';
        nameInput.focus();
        return;
      }
      nameError.hidden = true;
      try { localStorage.setItem(NAME_KEY, name); } catch { /* */ }
      onStart?.(name, gender);
      return;
    }
    // dead / round-end → back to name/start (lobby rejoins via onStart)
    onStart?.(sanitizeName(nameInput?.value) || savedName || 'Runner', gender);
  });

  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actionBtn.click();
  });

  /** Must run inside a user gesture (button click / Join). */
  function requestFullscreen() {
    if (!fsSupported || isFs()) return;
    try {
      const r = (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl, { navigationUI: 'hide' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not allowed */ }
  }

  function setMobile(isMobile) {
    root.classList.toggle('is-mobile', isMobile);
  }

  function hideResults() { results.classList.remove('on'); }

  /** Solo-round cap countdown chip (null hides it). */
  function setRoundTimer(secondsLeft) {
    if (secondsLeft == null) { roundTimer.classList.remove('on'); return; }
    const s = Math.max(0, Math.ceil(secondsLeft));
    roundTimer.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
    roundTimer.classList.add('on');
    roundTimer.classList.toggle('urgent', s <= 30);
  }

  function showStart() {
    results.classList.remove('on');
    overlay.dataset.mode = 'start';
    overlay.classList.add('on');
    vitals.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
    setNetStatus('');
  }

  function showPlaying() {
    results.classList.remove('on');
    overlay.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
    vitals.classList.add('on');
  }

  function showLobby() {
    results.classList.remove('on');
    overlay.classList.remove('on');
    vitals.classList.remove('on');
    spectateBanner.classList.remove('on');
    lobby.classList.add('on');
  }

  function hideLobby() {
    lobby.classList.remove('on');
  }

  const CHIP_COLORS = ['#c84830', '#3d6ec4', '#2f9c9a', '#d39c1f', '#7a5aa8', '#4f8a4a', '#b0507a', '#8a6a4a'];
  const chipColor = (id) => CHIP_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % CHIP_COLORS.length];

  function updateLobby({ filled, max, endsAt, serverNow, mode, players, myId, ready }) {
    const list = players || [];
    const slots = max || 30;
    const n = filled ?? list.length;
    const nReady = list.filter((p) => p.ready).length;
    lobbyFilled.textContent = String(n);
    lobbyMax.textContent = String(slots);
    lobbyReadyN.textContent = String(nReady);
    const now = serverNow || Date.now();
    const left = Math.max(0, Math.ceil(((endsAt || now) - now) / 1000));
    lobbySecs.textContent = String(left);
    lobby.classList.toggle('starting', mode === 'starting');
    lobbyMode.textContent = mode === 'starting' ? 'everyone ready — starting!' : 'starts when timer ends or all ready';
    lobbyMeterFill.style.width = `${(n / slots) * 100}%`;
    lobbyMeterReady.style.width = `${(nReady / slots) * 100}%`;
    lobbyList.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      li.className = (p.ready ? 'is-ready' : '') + (p.id === myId ? ' is-me' : '');
      const initial = escapeAttr((p.name || '?').trim().charAt(0).toUpperCase() || '?');
      li.innerHTML = `<span class="av" style="background:${chipColor(p.id)}">${initial}</span>`
        + `<span class="nm">${escapeAttr(p.name)}${p.id === myId ? ' <em>you</em>' : ''}</span>`
        + `<span class="st">${p.ready ? '✓' : ''}</span>`;
      lobbyList.appendChild(li);
    }
    lobbyReadyBtn.disabled = !!ready;
    lobbyReadyBtn.textContent = ready ? 'Ready ✓ — waiting for others' : "I'm ready";
  }

  function showSpectate(html) {
    spectateBanner.innerHTML = html || '<strong>Out</strong> · watching until the round ends';
    spectateBanner.classList.add('on');
    vitals.classList.add('on');
    overlay.classList.remove('on');
    lobby.classList.remove('on');
  }

  function hideSpectate() {
    spectateBanner.classList.remove('on');
  }

  function showDead({ reason, time, score, best }) {
    overlay.dataset.mode = 'dead';
    deathReason.textContent = reasonLabel(reason);
    finalTime.textContent = formatTime(time);
    finalScore.textContent = String(Math.floor(score));
    bestScore.textContent = String(Math.floor(best));
    overlay.classList.add('on');
    vitals.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
  }

  function showRoundEnd({ scores, myId, reason, winnerId, mode }) {
    const list = scores || [];
    roundTimer.classList.remove('on');
    const winner = list.find((sc) => sc.id === winnerId);
    const title = results.querySelector('.results-title');
    if (reason === 'last-standing' && winner) {
      title.textContent = winner.id === myId ? 'You are the last one standing!' : `${winner.name} is the last one standing`;
    } else if (reason === 'time') {
      title.textContent = winner?.id === myId ? 'You outlasted the aftershock!' : 'Survived the full 10 minutes';
    } else {
      title.textContent = mode === 'solo' ? 'The town took you' : 'Nobody made it';
    }
    resultsList.innerHTML = '';
    list.slice(0, 30).forEach((sc, i) => {
      const li = document.createElement('li');
      li.className = (sc.id === myId ? 'is-me ' : '') + (i < 3 ? `top top${i + 1}` : '');
      li.innerHTML = `<span class="rk">${sc.id === winnerId ? '🏆' : i + 1}</span>`
        + `<span class="nm">${escapeAttr(sc.name)}${sc.id === myId ? ' <em>you</em>' : ''}${sc.alive ? ' <em class="alive">standing</em>' : ''}</span>`
        + `<span class="tm">${formatTime(sc.survived || 0)}</span>`
        + `<span class="sc">${sc.score}</span>`;
      resultsList.appendChild(li);
    });
    const rank = list.findIndex((sc) => sc.id === myId);
    resultsMe.innerHTML = rank >= 0
      ? `You placed <b>#${rank + 1}</b> of ${list.length} · survived <b>${formatTime(list[rank].survived || 0)}</b>`
      : `${list.length} runner${list.length === 1 ? '' : 's'}`;
    results.classList.add('on');
    overlay.classList.remove('on');
    vitals.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
  }

  function showFull(message) {
    overlay.dataset.mode = 'full';
    fullMessage.textContent = message || 'Server full (30/30).';
    overlay.classList.add('on');
    vitals.classList.remove('on');
  }

  const shindoEl = vitals.querySelector('.shindo');
  let lastShindo = 0;
  const jumpChip = vitals.querySelector('.jump-chip');
  function update({ energy, time, score, players, lives, exhausted = false, shindo = 0, jumpCd = 0 }) {
    const cdFrac = Math.min(1, Math.max(0, jumpCd / 2));
    jumpChip.style.setProperty('--cd', cdFrac.toFixed(3));
    jumpChip.classList.toggle('cooling', cdFrac > 0);
    const jb = document.querySelector('.jump-btn');
    if (jb) {
      jb.style.setProperty('--cd', cdFrac.toFixed(3));
      jb.classList.toggle('cooling', cdFrac > 0);
    }
    if (shindo && shindo !== lastShindo) {
      lastShindo = shindo;
      shindoEl.textContent = `震度 ${shindo}`;
      shindoEl.dataset.level = String(shindo);
      if (shindo > 1) {
        shindoEl.classList.remove('bump');
        void shindoEl.offsetWidth; // restart the bump animation
        shindoEl.classList.add('bump');
      }
    }
    energyFill.style.width = `${Math.round(clamp01(energy) * 100)}%`;
    energyFill.classList.toggle('exhausted', !!exhausted);
    energyFill.classList.toggle('low', energy < 0.28);
    timeEl.textContent = formatTime(time);
    scoreEl.textContent = String(Math.floor(score));
    if (players != null) playersEl.textContent = `${players}/30`;
    if (lives != null) {
      for (let i = 0; i < hearts.length; i++) {
        hearts[i].classList.toggle('on', i < lives);
        hearts[i].classList.toggle('off', i >= lives);
      }
    }
  }

  function pulseHurt() {
    vitals.classList.add('hurt');
    clearTimeout(pulseHurt._t);
    pulseHurt._t = setTimeout(() => vitals.classList.remove('hurt'), 420);
  }

  function flash(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
  }

  let hintTimer = 0;
  function setHint(html) {
    if (hint.innerHTML === html) return;
    hint.innerHTML = html;
    hint.classList.remove('fade');
    // on phones the hint sits by the stick — fade it once it's been read
    clearTimeout(hintTimer);
    if (root.classList.contains('is-mobile')) hintTimer = setTimeout(() => hint.classList.add('fade'), 6000);
  }
  function setNetStatus(text) {
    if (netStatus) netStatus.textContent = text || '';
  }

  function setMuted(muted) {
    muteBtn.classList.toggle('is-muted', !!muted);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
    muteBtn.title = muted ? 'Unmute BGM' : 'Mute BGM';
    const label = muteBtn.querySelector('.mute-label');
    const icon = muteBtn.querySelector('.mute-icon');
    if (label) label.textContent = muted ? 'Muted' : 'Sound';
    if (icon) icon.textContent = muted ? '✕' : '♪';
  }

  function getName() {
    return sanitizeName(nameInput?.value || savedName);
  }

  return {
    set onStart(fn) { onStart = fn; },
    set onMuteToggle(fn) { onMuteToggle = fn; },
    set onReady(fn) { onReady = fn; },
    set onPlayAgain(fn) { onPlayAgain = fn; },
    /** Countdown line under the leaderboard (next round start). */
    setResultsCountdown(text) { resultsClock.textContent = text; },
    get resultsOpen() { return results.classList.contains('on'); },
    setMobile,
    showStart,
    showPlaying,
    showLobby,
    hideLobby,
    updateLobby,
    showSpectate,
    hideSpectate,
    showDead,
    showRoundEnd,
    setServerLoad,
    requestFullscreen,
    hideResults,
    setRoundTimer,
    showFull,
    update,
    pulseHurt,
    flash,
    setHint,
    setNetStatus,
    setMuted,
    getName,
  };
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function reasonLabel(r) {
  if (r === 'fell') return 'Fell into a fissure.';
  if (r === 'car') return 'Run over by a runaway car.';
  if (r === 'fire') return 'Burned in a fire.';
  if (r === 'explosion') return 'Caught in an explosion.';
  if (r === 'survived') return 'You outlasted the aftershock — all 10 minutes!';
  if (r === 'debris') return 'Hit by falling debris.';
  if (r === 'collapse') return 'Caught in a collapse.';
  return 'The aftershock got you.';
}
