// 打包 Chrome Web Store 发布包
// 用法: npm run build:store
import { execSync } from 'child_process'
import { copyFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const dist = join(root, 'dist')
const outDir = join(root, 'dist-store')

// 读取版本号
const pkg = require(join(root, 'package.json'))
const version = pkg.version
const outZip = join(root, `miaob-extension-v${version}.zip`)

console.log(`[package-store] 打包 v${version}...`)

// 清理并创建临时目录
if (existsSync(outDir)) rmSync(outDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

// 复制 dist 内容到临时目录（排除 src 源码文件夹）
const entries = readdirSync(dist, { withFileTypes: true })
for (const entry of entries) {
  if (entry.name === 'src') continue // 排除源码
  const src = join(dist, entry.name)
  const dest = join(outDir, entry.name)
  if (entry.isDirectory()) cpDir(src, dest)
  else copyFileSync(src, dest)
}

// 确保图标在 assets/ 下（manifest 引用 assets/icons/）
const iconsDir = join(outDir, 'assets', 'icons')
mkdirSync(iconsDir, { recursive: true })
const iconSrcDir = join(dist, 'src', 'assets', 'icons')
if (existsSync(iconSrcDir)) {
  for (const icon of readdirSync(iconSrcDir)) {
    copyFileSync(join(iconSrcDir, icon), join(iconsDir, icon))
  }
}

// 修正 manifest.json 中的图标路径（递归替换所有 src/assets/icons → assets/icons）
const manifestPath = join(outDir, 'manifest.json')
let manifestStr = require('fs').readFileSync(manifestPath, 'utf8')
manifestStr = manifestStr.replace(/"src\/assets\/icons\//g, '"assets/icons/')
require('fs').writeFileSync(manifestPath, manifestStr)

// 打包 zip
if (existsSync(outZip)) rmSync(outZip)
process.chdir(outDir)
execSync(`zip -r ${outZip} . -x "*.DS_Store"`, { stdio: 'inherit' })

// 清理临时目录
rmSync(outDir, { recursive: true })

const sizeKB = Math.round(require('fs').statSync(outZip).size / 1024)
console.log(`[package-store] 完成: miaob-extension-v${version}.zip (${sizeKB}KB)`)

function cpDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) cpDir(s, d)
    else copyFileSync(s, d)
  }
}
