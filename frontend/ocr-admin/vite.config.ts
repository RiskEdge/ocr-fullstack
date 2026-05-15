import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 3020,
    proxy: {
      '/v1': {
        target: 'http://localhost:8010',
        changeOrigin: true,
      },
    },
  },
})
