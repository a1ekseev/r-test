import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: { target: 'safari15', sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], retry: 0 },
});
