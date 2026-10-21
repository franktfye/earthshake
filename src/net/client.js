import { getOrCreateClientId, sanitizeName, wsUrl } from './protocol.js';

/**
 * Thin WebSocket client for the Aftershock room / lobby.
 */
export function createNetClient({
  onWelcome, onFull, onJoin, onLeave, onStates,
  onLobby, onRoundStart, onRoundEnd,
  onClose, onError,
}) {
  let ws = null;
  let myId = null;
  let connected = false;
  let sendAcc = 0;

  function connect(name, gender = 'm') {
    disconnect();
    const url = wsUrl();
    const clean = sanitizeName(name);
    if (!clean) {
      onError?.(new Error('Name required'));
      return;
    }
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onError?.(e);
      return;
    }

    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({
        type: 'join',
        name: clean,
        gender: gender === 'f' ? 'f' : 'm',
        clientId: getOrCreateClientId(),
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'welcome':
          myId = msg.id;
          onWelcome?.(msg);
          if (msg.lobby) onLobby?.(msg.lobby);
          break;
        case 'full':
          onFull?.(msg.message || 'Server full');
          break;
        case 'lobby':
          onLobby?.(msg);
          break;
        case 'roundStart':
          onRoundStart?.(msg);
          break;
        case 'roundEnd':
          onRoundEnd?.(msg);
          break;
        case 'join':
          if (msg.player?.id !== myId) onJoin?.(msg.player);
          break;
        case 'leave':
          onLeave?.(msg.id);
          break;
        case 'states':
          onStates?.(msg.players || [], msg);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      connected = false;
      onClose?.();
    };
    ws.onerror = () => onError?.(new Error('WebSocket error — is the server running?'));
  }

  function disconnect() {
    if (ws) {
      try { ws.close(); } catch { /* */ }
      ws = null;
    }
    connected = false;
    myId = null;
  }

  function sendReady() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'ready' }));
  }

  function sendState(state, dt) {
    if (!ws || ws.readyState !== 1) return;
    sendAcc += dt;
    if (sendAcc < 0.05) return;
    sendAcc = 0;
    ws.send(JSON.stringify({ type: 'state', ...state }));
  }

  return {
    connect,
    disconnect,
    sendReady,
    sendState,
    get id() { return myId; },
    get connected() { return connected; },
  };
}
