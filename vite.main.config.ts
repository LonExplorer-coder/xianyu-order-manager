import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['@napi-rs/keyring', 'node:sqlite'],
    },
  },
});
