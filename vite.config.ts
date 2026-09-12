import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  base: './',
  build: {
    // 不压缩（FingerprintJS 库有三反引号模板字符串，压缩会破坏语法）
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        content: 'src/content/index.ts'
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'content') return 'content.js'
          return 'assets/[name]-[hash].js'
        },
      }
    }
  }
})
