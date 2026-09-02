# 妙笔 (Miaob) — 中文网页阅读增强 Chrome 扩展

> 打开任意中文网页，自动标注成语、名句、歇后语，点击即知出处与含义。

## 功能

- 📖 **成语标注** — 自动识别文中成语，悬浮查看出处、解释
- 💬 **名句识别** — 标注经典名句，显示作者与出处
- 🃏 **歇后语** — 识别歇后语，展示谜面和谜底
- 🔍 **错别字检查** — AI 驱动的错别字、语病检查
- 📊 **阅读报告** — 检查完成后展示发现汇总
- 🏆 **游戏化** — 发现排行、成就徽章、积分系统

## 安装

### 方式一：Chrome Web Store（推荐）

> 正在审核中...

### 方式二：开发者模式

1. 下载 [最新版本](https://github.com/cobola/miaob-extension/releases)
2. 解压 zip
3. 打开 `chrome://extensions`
4. 开启"开发者模式"
5. 点击"加载已解压的扩展程序"，选择解压后的文件夹

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build
```

## 技术栈

- Chrome Manifest V3
- Vite + @crxjs/vite-plugin
- React 19 + Tailwind CSS 4
- TypeScript (strict)

## 协议

[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html)

您可以自由使用、修改、分发本软件，但任何基于本软件的衍生作品也必须以相同协议开源。

## 相关项目

- [妙笔词典数据](https://github.com/cobola/miaob-dictionary) — 成语/名句/歇后语数据
