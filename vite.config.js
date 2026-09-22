import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT || 3210}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', proxyRequest => {
            proxyRequest.setHeader('origin', 'http://127.0.0.1:3210');
          });
        }
      }
    }
  }
});
