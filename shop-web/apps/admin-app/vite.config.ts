/// <reference types="vitest/config" />
// The admin app: built into dist/ and served by the API at /bills and /jobs, its files at /app/assets/.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/admin-app',
  base: '/app/',
  plugins: [react()],
  resolve: { conditions: ['@org/source'] },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: false,
    assetsInlineLimit: 0, // every file from /app/assets (the CSP allows no data: scripts or fonts)
  },
  test: {
    name: 'admin-app',
    watch: false,
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default'],
  },
});
