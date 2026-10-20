import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createCharacter } from '../world/character.js';

/**
 * Remote players: same stylized human + exactly one name label above each head.
 * CSS2D DOM nodes are removed on detach so clear/rejoin never stacks duplicates.
 */
export function createRemoteManager(scene, camera) {
  const remotes = new Map(); // id → { char, label, target, name, isSelf, anchor }

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = 'fixed';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.style.zIndex = '4';
  labelRenderer.domElement.className = 'nametag-layer';
  document.body.appendChild(labelRenderer.domElement);

  let localRoot = null; // Player character root — self nametag parents here

  function detachLabel(label) {
    if (!label) return;
    if (label.parent) label.parent.remove(label);
    const el = label.element;
    if (el?.parentNode) el.parentNode.removeChild(el);
  }

  function makeLabel(name, self = false) {
    const el = document.createElement('div');
    el.className = 'nametag' + (self ? ' self' : '');
    el.textContent = name || 'Runner';
    const obj = new CSS2DObject(el);
    obj.position.set(0, 2.15, 0);
    obj.center.set(0.5, 1);
    return obj;
  }

  function purgeOrphanDom() {
    const layer = labelRenderer.domElement;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function remove(id) {
    const r = remotes.get(id);
    if (!r) return;
    detachLabel(r.label);
    if (r.isSelf) {
      // anchor may be the shared local character — don't remove the avatar
      if (r.anchor && r.anchor !== localRoot && r.ownedAnchor) {
        scene.remove(r.anchor);
      }
    } else {
      if (r.char) scene.remove(r.char.root);
      else if (r.anchor) scene.remove(r.anchor);
    }
    remotes.delete(id);
  }

  function add(player, { isSelf = false } = {}) {
    if (!player?.id) return;
    const existing = remotes.get(player.id);
    if (existing) {
      // Same entry — just refresh name / target. Rebuild if self/remote kind flipped.
      if (!!existing.isSelf !== !!isSelf) {
        remove(player.id);
      } else {
        update(player);
        return;
      }
    }

    if (isSelf) {
      const parent = localRoot || (() => {
        const g = new THREE.Group();
        g.position.set(player.x || 0, player.y || 0, player.z || 0);
        scene.add(g);
        return g;
      })();
      const ownedAnchor = parent !== localRoot;
      const label = makeLabel(player.name || 'You', true);
      parent.add(label);
      remotes.set(player.id, {
        char: null,
        anchor: parent,
        ownedAnchor,
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
      ownedAnchor: true,
      label,
      name: player.name,
      target: { ...player },
      isSelf: false,
    });
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
      if (r.label) r.label.element.textContent = player.name;
    }
  }

  function applyStates(list, myId) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      if (p.id === myId) {
        if (!remotes.has(p.id)) add(p, { isSelf: true });
        else if (p.name) update(p);
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

  /** Bind local avatar so the self nametag sits on the real character (one label). */
  function setLocalRoot(root) {
    localRoot = root;
    for (const r of remotes.values()) {
      if (!r.isSelf || !r.label) continue;
      if (r.label.parent === root) {
        r.anchor = root;
        r.ownedAnchor = false;
        continue;
      }
      const oldAnchor = r.anchor;
      const owned = r.ownedAnchor;
      detachLabel(r.label);
      if (owned && oldAnchor && oldAnchor !== root) scene.remove(oldAnchor);
      const label = makeLabel(r.name || 'You', true);
      root.add(label);
      r.label = label;
      r.anchor = root;
      r.ownedAnchor = false;
    }
  }

  function setSelfPose(id, name, pos, facing) {
    let r = remotes.get(id);
    if (!r) {
      add({ id, name, x: pos.x, y: pos.y, z: pos.z }, { isSelf: true });
      r = remotes.get(id);
    }
    if (!r) return;
    if (name && r.label) {
      r.name = name;
      r.label.element.textContent = name;
    }
    // When parented to local character, pose follows the avatar automatically.
    if (r.ownedAnchor && r.anchor && r.anchor !== localRoot) {
      r.anchor.position.set(pos.x, pos.y, pos.z);
    }
    void facing;
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
    purgeOrphanDom();
  }

  return {
    add, remove, applyStates, setSelfPose, setLocalRoot,
    tick, render, resize, clear, remotes,
  };
}
