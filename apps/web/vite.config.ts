import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local dev sees one origin and zero CORS: every backend path is proxied to
// :8080 (plan §2.4). The deployed build talks to the container directly via
// VITE_FEED_URL instead (architecture §9.2). FX_BACKEND_PORT exists for dev
// machines where :8080 is already taken (pair it with PORT on the server).
const target = `http://localhost:${process.env.FX_BACKEND_PORT ?? '8080'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/feed': { target, ws: true },
      '/graphql': { target, ws: true },
      '/healthz': { target },
      '/api': { target },
      '/sim': { target },
    },
  },
});
