# 妙笔开发指南

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 开发插件

```bash
cd packages/extension
pnpm dev
```

然后在 Chrome 中加载 `packages/extension/dist` 目录。

### 3. 开发服务端（待实现）

```bash
cd packages/server
pnpm dev
```

## 项目结构

```
miaob/
├── packages/
│   ├── extension/      # Chrome 扩展
│   │   ├── src/
│   │   │   ├── background/    # Service Worker
│   │   │   ├── content/       # Content Script
│   │   │   ├── popup/         # 弹窗界面
│   │   │   └── assets/        # 静态资源
│   │   ├── public/
│   │   │   └── _locales/      # 多语言
│   │   ├── manifest.json      # 扩展配置
│   │   └── vite.config.ts     # Vite 配置
│   ├── server/         # 后端服务（待实现）
│   ├── web/            # 网站端（待实现）
│   ├── core/           # 核心逻辑
│   └── shared/         # 类型定义
├── package.json        # 根配置
└── pnpm-workspace.yaml # Workspace 配置
```

## 核心功能

### 文本提取

- 监听 `input[type="text"]`
- 监听 `textarea`
- 监听 `[contenteditable="true"]`
- 使用 MutationObserver 监听新增元素

### 错误检查

1. 用户输入 → 防抖 500ms
2. 提取文本 → 发送到 background
3. Background → 调用服务端 API
4. 返回错误列表 → 标注到页面

### 错误标注

- 红色波浪线：错别字
- 橙色波浪线：语法错误
- 蓝色波浪线：标点错误

### 悬浮提示

- 鼠标悬停显示错误详情
- 显示修复建议
- 一键修复按钮

## 快捷键

- `Ctrl+Shift+E`: 检查整个页面

## 配置选项

- 启用/禁用检查
- 自动检查开关
- 严格程度（基础/标准/严格）
- API 地址配置

## 技术细节

### 通信机制

```
Content Script ←→ Background ←→ Server API
```

### 缓存策略

- 相同文本不重复检查
- 缓存存储在内存中
- 可手动清除缓存

### 性能优化

- 防抖处理（500ms）
- 增量检查（只检查变化部分）
- 本地规则库（减少 API 调用）

## 开发建议

1. 先实现插件端基础功能
2. 再实现服务端 API
3. 最后实现网站端用户管理

## 调试技巧

### 查看 Content Script 日志

打开页面的开发者工具 → Console

### 查看 Background 日志

Chrome 扩展管理页面 → 点击"Service Worker" → Console

### 查看存储数据

```javascript
chrome.storage.sync.get(null, console.log)
```
