import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  resolve: {
    alias: {
      'jotai': path.resolve(__dirname, 'node_modules/jotai'),
      '@zuccadev-labs/zenith/react': path.resolve(__dirname, '../../src/react/mod.ts'),
      '@zuccadev-labs/zenith': path.resolve(__dirname, '../../src/index.ts'),
    }
  },
  server: {
    proxy: {
      '/parse': {
        target: 'http://127.0.0.1:1337',
        changeOrigin: true,
        ws: true,
      }
    }
  }
})
