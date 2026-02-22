import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  envDir: '..',
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/'),
      // 👇 Add this alias to redirect pino to a stub
      pino: path.resolve(__dirname, './src/stubs/pino.js'),
      'pino-pretty': path.resolve(__dirname, './src/stubs/pino-pretty.js'),
    },
    dedupe: ['@stellar/stellar-sdk'],
  },
  optimizeDeps: {
    include: [
      '@stellar/stellar-sdk',
      '@stellar/stellar-sdk/contract',
      '@stellar/stellar-sdk/rpc',
      'buffer',
    ],
    exclude: [
      '@noir-lang/noir_js',
      '@noir-lang/acvm_js',
      '@noir-lang/noirc_abi',
      '@aztec/bb.js',
      'pino',           // 👈 keep excluded
      'pino-pretty',    // 👈 keep excluded
    ],
    esbuildOptions: {
      define: { global: 'globalThis' },
    },
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    target: 'esnext',
    rollupOptions: {
      external: ['pino', 'pino-pretty'], // 👈 prevent bundling
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    fs: {
      allow: ['..'],
    },
  },
});