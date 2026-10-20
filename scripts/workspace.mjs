#!/usr/bin/env node
/**
 * FUSE-safe workspace runner.
 * Project Context mounts may not support npm's atomic rename().
 * This syncs sources to $AFTERSHOCK_WORK (default /tmp/aftershock),
 * runs npm there, and copies dist/ back into the store.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORK = process.env.AFTERSHOCK_WORK || '/tmp/aftershock';

const cmd = process.argv[2] || 'help';

function log(...a) {
  console.log('[aftershock]', ...a);
}

function ensureWork() {
  fs.mkdirSync(WORK, { recursive: true });
  // Work tree uses direct vite scripts (store package.json wraps via this runner).
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.scripts = {
    dev: 'vite',
    build: 'vite build',
    preview: 'vite preview',
    play: 'vite build && vite preview --port 5179 --open',
  };
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const name of ['vite.config.js', 'index.html', '.gitignore']) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(WORK, name));
  }
  if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(WORK, 'package-lock.json'));
  }
  copyDir(path.join(ROOT, 'src'), path.join(WORK, 'src'));
  copyDir(path.join(ROOT, 'public'), path.join(WORK, 'public'));
  copyDir(path.join(ROOT, 'server'), path.join(WORK, 'server'));
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function run(npmArgs) {
  const r = spawnSync('npm', npmArgs, { cwd: WORK, stdio: 'inherit', shell: false });
  if (r.status) process.exit(r.status);
}

function copyDistBack() {
  const from = path.join(WORK, 'dist');
  const to = path.join(ROOT, 'dist');
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  copyDir(from, to);
  log('copied dist/ → store');
}

function copyLockBack() {
  const lock = path.join(WORK, 'package-lock.json');
  if (fs.existsSync(lock)) {
    fs.copyFileSync(lock, path.join(ROOT, 'package-lock.json'));
  }
}

switch (cmd) {
  case 'install':
  case 'setup': {
    ensureWork();
    run(['install']);
    copyLockBack();
    log('deps ready in', WORK);
    break;
  }
  case 'build': {
    ensureWork();
    if (!fs.existsSync(path.join(WORK, 'node_modules', 'vite'))) run(['install']);
    run(['run', 'build']);
    copyDistBack();
    copyLockBack();
    break;
  }
  case 'dev': {
    ensureWork();
    if (!fs.existsSync(path.join(WORK, 'node_modules', 'vite'))) run(['install']);
    run(['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5178']);
    break;
  }
  case 'preview': {
    ensureWork();
    if (!fs.existsSync(path.join(WORK, 'dist'))) {
      run(['run', 'build']);
      copyDistBack();
    }
    run(['run', 'preview', '--', '--host', '127.0.0.1', '--port', '5179']);
    break;
  }
  case 'server': {
    ensureWork();
    if (!fs.existsSync(path.join(WORK, 'node_modules', 'ws'))) run(['install']);
    const r = spawnSync('node', ['server/index.js'], { cwd: WORK, stdio: 'inherit', shell: false });
    if (r.status) process.exit(r.status);
    break;
  }
  case 'work-path':
    console.log(WORK);
    break;
  default:
    console.log(`Usage: node scripts/workspace.mjs <install|build|dev|preview|server>`);
    process.exit(1);
}
