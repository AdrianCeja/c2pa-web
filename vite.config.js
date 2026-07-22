import { defineConfig } from 'vite';

// c2pa-web ships a web worker + a WASM binary. We keep it out of Vite's dep
// pre-bundling so the worker/wasm URLs resolve correctly.
//
// Note: c2pa-web does NOT use SharedArrayBuffer, so we do NOT set COOP/COEP.
// Cross-origin isolation (require-corp) would block c2pa-rs from fetching
// *remote* manifests (e.g. Runway assets that reference credentials by URL).
export default defineConfig({
  optimizeDeps: {
    exclude: ['@contentauth/c2pa-web'],
  },
  build: {
    target: 'es2022',
  },
});
