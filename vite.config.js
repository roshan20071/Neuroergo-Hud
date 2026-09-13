import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    // Camera access from getUserMedia requires a secure context; Vite's dev
    // server on localhost already satisfies that, so HTTPS is only needed
    // when testing over LAN from another device.
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    // MediaPipe's WASM-backed packages and Three.js are both large and
    // change far less often than application code; splitting them into
    // their own chunks lets browsers cache them independently across
    // deploys, instead of invalidating a single monolithic bundle on every
    // app-code change.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/face_mesh', '@mediapipe/hands'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: false,
  },
});
