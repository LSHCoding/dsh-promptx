# dsh-promptx

[English](README.md) | 中文

PromptX 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的插件，带一个配套的桌面小窗。在任何应用里按全局快捷键，Prompt 编辑小窗浮在当前应用上方；写 Prompt、从自己的 Markdown Prompt 库里取模板，或者让 dsh 里配置的模型帮忙改写。按 ⌘↩ 复制全文，小窗隐藏，焦点回到刚才的应用，直接粘贴。

> 状态：开发中（V0.1.0）。macOS 正式支持；Windows、Linux 为预览：能构建并通过自动化测试，但没有经过实机验收。

## 功能

- **全局快捷键和置顶小窗**：macOS 默认 ⌃P，Windows、Linux 默认 Ctrl+Alt+P。小窗浮在其他应用上方，复制后自动隐藏。
- **编辑器**：纯文本 Markdown 编辑，列表自动续行，Tab 缩进。Enter 永远只换行。
- **Prompt 库**：一个普通的 Markdown 文件夹，用 YAML front matter 记标题、标签、收藏。搜索、筛选、插入到光标、打开、保存、重命名、打标签、收藏、删除到回收站并恢复。没在 PromptX 里编辑过的文件不会被改动。
- **用 dsh 的模型改写**：侧边会话栏流式显示 dsh 默认模型给出的改写稿，可以追加要求、一键应用（一次撤销恢复原文）、复制。
- **草稿不丢**：隐藏小窗、重启小窗、重启 dsh 后草稿都还在。

## 运行环境

- DeepSeek Harness 0.2.2-rc.1 或之后的 0.2.x（桌面版或 `dsh web`）。
- macOS 13 及以上（Apple 芯片或 Intel）。Windows 10/11、Linux 为预览。
- 第一次运行需要联网：小窗基于 Electron 44.10.2（约 125–160 MB），PromptX 把它下载到 dsh 数据目录，按随插件发布的 SHA-256 校验。默认先用国内镜像，失败时换 GitHub；在插件配置里可以指定下载源。

## 从本地代码安装

```bash
pnpm install
pnpm build
npx @deepseek-ai/dsh plugin --profile <你的 profile> add /本仓库的/绝对路径
```

安装或更新插件后要重启 dsh。第一次启动时，在 dsh 的插件页打开 PromptX，可以看到运行时的下载进度；状态显示全局快捷键已生效后，就能在任何应用里按快捷键呼出小窗。

## 使用

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 呼出或隐藏小窗 | ⌃P（可修改） | Ctrl+Alt+P（可修改） |
| 复制全文并隐藏 | ⌘↩ | Ctrl+Enter |
| 保存到库 | ⌘S | Ctrl+S |
| 展开或收起库侧栏 | ⌘L | Ctrl+L |
| 用模型改写 / 停止 | ⇧⌘O | Shift+Ctrl+O |
| 隐藏小窗 | Esc | Esc |

菜单栏（macOS）或托盘图标里有显示 / 隐藏、重置窗口位置、设置…、重启小窗。配置在 dsh 插件页的 PromptX 页面：库目录、删除前确认、优化指令、全局快捷键、失焦时自动隐藏、运行时下载源。

## 数据存放位置

都在 dsh 数据目录下（默认 `~/.dsh`，设置了 `DSH_HOME` 时以它为准）：

| 内容 | 位置 |
| --- | --- |
| Prompt 库（默认） | `promptx/library/`，可以在配置里换成任意目录 |
| 删除的 Prompt | 库目录下的 `_trash/` |
| 草稿 | `storages/promptx_draft_<profile 哈希>.json` |
| 小窗运行时 | `promptx/runtime/` |
| 小窗位置和侧栏状态 | `promptx/prefs.json` |
| 小窗日志（不含 Prompt 内容） | `promptx/logs/` |

PromptX 不做同步、没有账号，只在你发起改写时把 Prompt 发给你在 dsh 里配置的模型。小窗不开网络端口，通过标准输入输出和 dsh 通信。

## 卸载

```bash
npx @deepseek-ai/dsh plugin --profile <你的 profile> remove dsh-promptx
```

卸载插件不会删除库和草稿。要释放磁盘空间，可以在卸载前到 PromptX 配置页删除运行时，或者卸载后手动删除 dsh 数据目录下的 `promptx/runtime/`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test        # 单元测试
pnpm smoke       # 构建、下载 Electron、启动小窗并检查握手
```

借用的代码和素材见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
