import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5178,
    host: '127.0.0.1',
    open: false,
    proxy: {
      // Optional: ws://localhost:5178/ws → game server
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
  preview: {
    port: 5179,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
