import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    proxy: {
      '/api/formflow/crm': {
        target: process.env.VITE_DEV_PROXY_CLICKUPBACKEND_ORIGIN || 'https://click.acquisition-central.com',
        changeOrigin: true,
      },
    },
  },
});
