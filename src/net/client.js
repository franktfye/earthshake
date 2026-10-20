import { getOrCreateClientId, sanitizeName, wsUrl } from './protocol.js';

/**
 * Thin WebSocket client for the Aftershock room.
 */
export function createNetClient({ onWelcome, onFull, onJoin, onLeave, onStates, onClose, onError }) {
  let ws = null;
  let myId = null;
  let connected = false;
  let sendAcc = 0;

  function connect(name) {
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
          break;
        case 'full':
          onFull?.(msg.message || 'Server full');
          break;
        case 'join':
          if (msg.player?.id !== myId) onJoin?.(msg.player);
          break;
        case 'leave':
          onLeave?.(msg.id);
          break;
        case 'states':
          onStates?.(msg.players || []);
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

  function sendState(state, dt) {
    if (!ws || ws.readyState !== 1) return;
    sendAcc += dt;
    if (sendAcc < 0.05) return; // ~20 Hz
    sendAcc = 0;
    ws.send(JSON.stringify({ type: 'state', ...state }));
  }

  return {
    connect,
    disconnect,
    sendState,
    get id() { return myId; },
    get connected() { return connected; },
  };
}
