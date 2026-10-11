import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Where the API runs in development; override with API_PROXY_TARGET when port 4000 is taken.
  const env = loadEnv(mode, process.cwd(), '');
  const target = env['API_PROXY_TARGET'] || 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // Same-origin API in dev, mirroring production where the proxy serves both.
      proxy: {
        '/api': target,
        '/socket.io': { target, ws: true },
      },
    },
  };
});
