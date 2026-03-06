# ClawRocket 中文说明

此文档只提供简短中文概览。**英文版 [README.md](README.md) 是当前项目的唯一权威说明**；如果两者有差异，以英文版为准。

## 当前项目状态

ClawRocket 已不再只是上游 NanoClaw 的直接介绍文本。当前仓库包含两个执行域：

1. **核心执行器**
   - 继续走容器化 Claude / NanoClaw 路径
   - 对上游兼容性敏感
   - 负责渠道、调度、IPC、分组上下文等核心能力

2. **Talk 运行时**
   - 走 ClawRocket 自己的直连 HTTP 路径
   - 支持流式输出、无状态上下文重建、多 Agent Talk
   - 使用 SQLite 中的 Provider / Route / Agent 配置

此外，ClawRocket 还提供：

- 认证后的 Web UI 和 API
- `owner` / `admin` / `member` 权限模型
- 核心执行器设置页
- Talk LLM Provider / Route 设置
- 按 Talk 的多 Agent 路由与回退
- 单实例接管保护（同一 `DATA_DIR` 只允许一个进程拥有）

## 开发命令

```bash
npm install
npm run install:webapp
npm run dev
npm run dev:web
npm run typecheck
npm run test
```

## 推荐阅读顺序

- [README.md](README.md)：项目总览与开发入口
- [CLAUDE.md](CLAUDE.md)：给编码代理的仓库上下文
- [docs/SPEC.md](docs/SPEC.md)：当前架构说明
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)：当前设计约束
- [docs/SECURITY.md](docs/SECURITY.md)：安全模型
- [docs/OPERATIONS_UBUNTU.md](docs/OPERATIONS_UBUNTU.md)：Ubuntu 运维方式

## 说明

- 旧的阶段计划、迁移草案、上游 NanoClaw-only 描述不再作为当前事实文档。
- 如果您要修改上游敏感区域，请先阅读 [docs/UPSTREAM-PATCH-SURFACE.md](docs/UPSTREAM-PATCH-SURFACE.md)。
