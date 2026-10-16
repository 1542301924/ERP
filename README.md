# ERP

轻量级进销存出入库管理系统（pnpm workspace，P0 阶段：脚手架与骨架）。

## 目录结构

```
/workspace
├─ apps/desktop/            # Electron + Vue3 + SQLite 桌面端
│  ├─ src/main/            # 主进程：db(建表/连接/统一写入口/种子) + IPC
│  ├─ src/preload/         # preload：暴露 window.api
│  ├─ src/renderer/        # Vue3 + Vite 渲染进程（左菜单 + 表格工作区、深浅主题）
│  └─ test/                # node:test（库层）
├─ packages/shared/         # 实体模型 / ULID / HLC / 同步 apply / 校验规则
│  ├─ src/
│  └─ test/
└─ docs/                    # 设计文档（specs / plans），只读
```

## 常用命令

```bash
pnpm install            # 安装依赖（Electron 二进制下载会被跳过：ELECTRON_SKIP_BINARY_DOWNLOAD=1）
pnpm -r typecheck       # 全仓库类型校验（shared: tsc；desktop: vue-tsc + tsc）
pnpm test               # 运行 shared 与 desktop 主进程的 node:test 用例
pnpm build              # shared 产出 dist；desktop 产出渲染进程 dist/renderer
```

标题：轻量级进销存（离线优先，局域网主节点 + 云端中转/备份）。
权威设计见 `docs/superpowers/specs/2026-10-16-inventory-system-design.md`。
