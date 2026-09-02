import * as esbuild from 'esbuild'

// 将 content script 打包为 IIFE（无模块语法），便于 executeScript files 注入
await esbuild.build({
  entryPoints: ['src/content/index.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/content.js',
  minify: true,
  target: ['chrome100'],
  logLevel: 'info',
})

console.log('[build-content] content.js (IIFE) 已生成')
