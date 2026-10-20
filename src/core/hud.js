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
  `);
  const muteBtn = topBar.querySelector('.mute-btn');
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

  const lobby = el('div', 'lobby-panel', root, `
    <div class="lobby-head">
      <div class="lobby-title">Lobby</div>
      <div class="lobby-slots"><span class="lobby-filled">0</span>/30</div>
    </div>
    <div class="lobby-countdown">—</div>
    <ul class="lobby-list"></ul>
    <button type="button" class="lobby-ready">Ready</button>
  `);
  const lobbyFilled = lobby.querySelector('.lobby-filled');
  const lobbyCountdown = lobby.querySelector('.lobby-countdown');
  const lobbyList = lobby.querySelector('.lobby-list');
  const lobbyReadyBtn = lobby.querySelector('.lobby-ready');
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
        <div class="control-strip desktop-only">
          <span><b>WASD</b> Walk (recharges)</span>
          <span><b>Shift</b> Run (drains)</span>
          <span><b>Mouse</b> Orbit</span>
        </div>
        <div class="control-strip mobile-only">
          <span><b>Stick</b> Walk (recharges)</span>
          <span><b>RUN</b> Drains</span>
          <span><b>Drag</b> Orbit</span>
        </div>
        <button class="menu-action" type="button">
          <span class="start-only">Join &amp; run</span>
          <span class="dead-only">Try again</span>
          <span class="full-only">Back</span>
          <i aria-hidden="true">→</i>
        </button>
        <p class="net-status start-only"></p>
      </div>
    </section>`;

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
      onStart?.(name);
      return;
    }
    // dead / round-end → back to name/start (lobby rejoins via onStart)
    onStart?.(sanitizeName(nameInput?.value) || savedName || 'Runner');
  });

  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actionBtn.click();
  });

  function setMobile(isMobile) {
    root.classList.toggle('is-mobile', isMobile);
  }

  function showStart() {
    overlay.dataset.mode = 'start';
    overlay.classList.add('on');
    vitals.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
    setNetStatus('');
  }

  function showPlaying() {
    overlay.classList.remove('on');
    lobby.classList.remove('on');
    spectateBanner.classList.remove('on');
    vitals.classList.add('on');
  }

  function showLobby() {
    overlay.classList.remove('on');
    vitals.classList.remove('on');
    spectateBanner.classList.remove('on');
    lobby.classList.add('on');
  }

  function hideLobby() {
    lobby.classList.remove('on');
  }

  function updateLobby({ filled, max, endsAt, serverNow, mode, players, myId, ready }) {
    lobbyFilled.textContent = String(filled ?? players?.length ?? 0);
    const now = serverNow || Date.now();
    const left = Math.max(0, Math.ceil(((endsAt || now) - now) / 1000));
    if (mode === 'starting') {
      lobbyCountdown.textContent = `All ready — starting in ${left}s`;
    } else {
      lobbyCountdown.textContent = `Auto-start in ${left}s · or Ready up`;
    }
    lobbyList.innerHTML = '';
    const slots = max || 30;
    const list = players || [];
    for (let i = 0; i < slots; i++) {
      const li = document.createElement('li');
      const p = list[i];
      if (p) {
        li.className = 'filled' + (p.ready ? ' is-ready' : '') + (p.id === myId ? ' is-me' : '');
        li.innerHTML = `<span class="nm">${escapeAttr(p.name)}</span>`
          + `<span class="st">${p.ready ? 'Ready' : '…'}</span>`;
      } else {
        li.className = 'empty';
        li.textContent = 'Empty';
      }
      lobbyList.appendChild(li);
    }
    lobbyReadyBtn.disabled = !!ready;
    lobbyReadyBtn.textContent = ready ? 'Waiting…' : 'Ready';
  }

  function showSpectate() {
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

  function showRoundEnd({ scores, best: bestScoreVal }) {
    const top = (scores || []).slice(0, 5)
      .map((s, i) => `${i + 1}. ${s.name} — ${s.score}`)
      .join('<br/>') || '—';
    overlay.dataset.mode = 'dead';
    deathReason.innerHTML = `Round over<br/><span class="round-scores">${top}</span>`;
    finalTime.textContent = '—';
    finalScore.textContent = scores?.[0] ? String(scores.find((s) => s)?.score ?? 0) : '0';
    // show local best if provided
    if (bestScoreVal != null) bestScore.textContent = String(Math.floor(bestScoreVal));
    const deadOnly = overlay.querySelector('.dead-only');
    if (deadOnly) deadOnly.textContent = 'Round results';
    const btn = overlay.querySelector('.menu-action .dead-only');
    if (btn) btn.textContent = 'Back to lobby';
    overlay.classList.add('on');
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

  function update({ energy, time, score, players, lives }) {
    energyFill.style.width = `${Math.round(clamp01(energy) * 100)}%`;
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

  function setHint(html) { hint.innerHTML = html; }
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
  if (r === 'debris') return 'Hit by falling debris.';
  if (r === 'collapse') return 'Caught in a collapse.';
  return 'The aftershock got you.';
}
