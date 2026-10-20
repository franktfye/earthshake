import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createCharacter } from '../world/character.js';

/**
 * Remote players: same stylized human + name label above head.
 */
export function createRemoteManager(scene, camera) {
  const remotes = new Map(); // id → { char, label, target, name }

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = 'fixed';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.style.zIndex = '4';
  document.body.appendChild(labelRenderer.domElement);

  function makeLabel(name, self = false) {
    const el = document.createElement('div');
    el.className = 'nametag' + (self ? ' self' : '');
    el.textContent = name;
    const obj = new CSS2DObject(el);
    obj.position.set(0, 2.05, 0);
    return obj;
  }

  function add(player, { isSelf = false } = {}) {
    if (remotes.has(player.id)) {
      update(player);
      return;
    }
    if (isSelf) {
      // local body already rendered by Player — only need nametag parented to a helper
      const anchor = new THREE.Group();
      anchor.position.set(player.x || 0, player.y || 0, player.z || 0);
      scene.add(anchor);
      const label = makeLabel(player.name || 'You', true);
      anchor.add(label);
      remotes.set(player.id, {
        char: null,
        anchor,
        label,
        name: player.name,
        target: { ...player },
        isSelf: true,
      });
      return;
    }
    const char = createCharacter();
    scene.add(char.root);
    const label = makeLabel(player.name || 'Runner');
    char.root.add(label);
    char.root.position.set(player.x || 0, player.y || 0, player.z || 0);
    remotes.set(player.id, {
      char,
      anchor: char.root,
      label,
      name: player.name,
      target: { ...player },
      isSelf: false,
    });
  }

  function remove(id) {
    const r = remotes.get(id);
    if (!r) return;
    scene.remove(r.anchor);
    if (r.char) scene.remove(r.char.root);
    remotes.delete(id);
  }

  function update(player) {
    const r = remotes.get(player.id);
    if (!r) {
      add(player);
      return;
    }
    r.target = { ...r.target, ...player };
    if (player.name && player.name !== r.name) {
      r.name = player.name;
      r.label.element.textContent = player.name;
    }
  }

  function applyStates(list, myId) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      if (p.id === myId) {
        // keep self nametag synced to local player via setSelfPose
        if (!remotes.has(p.id)) add(p, { isSelf: true });
        continue;
      }
      if (!remotes.has(p.id)) add(p);
      else update(p);
    }
    for (const id of remotes.keys()) {
      if (id === myId) continue;
      if (!seen.has(id)) remove(id);
    }
  }

  function setSelfPose(id, name, pos, facing) {
    let r = remotes.get(id);
    if (!r) {
      add({ id, name, x: pos.x, y: pos.y, z: pos.z }, { isSelf: true });
      r = remotes.get(id);
    }
    if (r?.anchor) {
      r.anchor.position.set(pos.x, pos.y, pos.z);
      if (name && r.label) r.label.element.textContent = name;
    }
  }

  function tick(dt) {
    for (const r of remotes.values()) {
      if (r.isSelf || !r.char) continue;
      const t = r.target;
      const root = r.char.root;
      root.position.x += (t.x - root.position.x) * Math.min(1, dt * 12);
      root.position.y += (t.y - root.position.y) * Math.min(1, dt * 12);
      root.position.z += (t.z - root.position.z) * Math.min(1, dt * 12);
      r.char.update(
        root.position,
        t.facing ?? 0,
        t.moving ?? 0,
        !!t.run,
        dt
      );
      // createCharacter.update sets position again — fine
      if (t.alive === false) {
        root.visible = false;
      } else {
        root.visible = true;
      }
    }
  }

  function render() {
    labelRenderer.render(scene, camera);
  }

  function resize(w, h) {
    labelRenderer.setSize(w, h);
  }

  function clear() {
    for (const id of [...remotes.keys()]) remove(id);
  }

  return { add, remove, applyStates, setSelfPose, tick, render, resize, clear, remotes };
}
