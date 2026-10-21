import { defineConfig } from 'vite';

// Room server listens on 19090. 8790 was the Pi port.
const wsProxy = {
  '/ws': {
    target: 'ws://127.0.0.1:19090',
    ws: true,
    rewrite: (p) => p.replace(/^\/ws/, '') || '/',
  },
};

const allowedHosts = ['.tailec59b1.ts.net', 'spark-043f', 'localhost', '127.0.0.1', '100.80.26.29', '192.168.1.213'];

export default defineConfig({
  base: './',
  server: {
    port: 19078,
    host: '0.0.0.0',
    open: false,
    allowedHosts,
    proxy: wsProxy,
  },
  preview: {
    port: 19079,
    host: '0.0.0.0',
    allowedHosts,
    proxy: wsProxy,
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
