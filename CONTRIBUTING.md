# 妙笔 - 贡献指南

感谢你对妙笔项目的关注！

## 如何贡献

### 报告 Bug

在 [Issues](https://github.com/yourusername/miaob/issues) 中创建新问题，包含：

- 问题描述
- 复现步骤
- 预期行为
- 实际行为
- 环境信息（浏览器版本、操作系统等）

### 提交功能建议

在 Issues 中创建功能请求，说明：

- 功能描述
- 使用场景
- 预期效果

### 提交代码

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 开发规范

### 代码风格

- 使用 TypeScript strict 模式
- 遵循 ESLint 规则
- 使用 Prettier 格式化代码

### 提交信息

使用语义化提交信息：

- `feat:` 新功能
- `fix:` 修复 Bug
- `docs:` 文档更新
- `style:` 代码格式调整
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具相关

示例：

```
feat: 添加语法检查功能
fix: 修复标点检查的边界问题
docs: 更新 API 文档
```

### 测试

提交代码前请确保：

- 所有测试通过
- 新功能有对应测试
- 代码覆盖率不降低

## 项目结构

```
miaob/
├── packages/
│   ├── extension/    # 插件端
│   ├── server/       # 服务端
│   ├── web/          # 网站端
│   ├── core/         # 核心逻辑
│   └── shared/       # 共享类型
└── docs/             # 文档
```

## 开发流程

1. 克隆项目
2. 安装依赖：`pnpm install`
3. 启动开发环境：`./dev.sh`
4. 进行开发
5. 提交代码

## 添加新的检查规则

在 `packages/server/src/check/check.service.ts` 中添加：

```typescript
private checkNewRule(text: string): TextError[] {
  const errors: TextError[] = [];
  // 实现检查逻辑
  return errors;
}
```

## 问题讨论

加入我们的讨论：

- GitHub Discussions
- 微信群（扫码加入）

## 行为准则

- 尊重他人
- 建设性反馈
- 包容不同观点
- 专注于项目目标

## 许可证

贡献的代码将采用 MIT 许可证。
