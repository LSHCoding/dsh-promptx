# dsh-promptx

[English](README.md) | 中文

PromptX 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的插件，带一个配套的桌面小窗。在任何应用里按全局快捷键，Prompt 编辑小窗浮在当前应用上方；写 Prompt、从自己的 Markdown Prompt 库里取模板，或者让 dsh 里配置的模型帮忙改写。按 ⌘↩ 复制全文，小窗隐藏，焦点回到刚才的应用，直接粘贴。

> 版本 v0.1.7。macOS 正式支持。Windows 和 Linux 为预览，系统交互实机验收待完成。

## 功能

- **全局快捷键和置顶小窗**。macOS 默认 ⌃P，Windows 和 Linux 默认 Ctrl+Alt+P。点击窗外时小窗保持显示。再次按全局快捷键，或执行「复制并隐藏」，即可收起。
- **编辑器**：纯文本 Markdown 编辑，列表自动续行，Tab 缩进。Enter 永远只换行。
- **Prompt 库**：一个普通的 Markdown 文件夹，用 YAML front matter 记标题、标签、收藏。搜索、筛选、插入到光标、打开、保存、重命名、打标签、收藏、删除到回收站并恢复。没在 PromptX 里编辑过的文件不会被改动。
- **用 dsh 的模型改写**：侧边会话栏流式显示 dsh 默认模型给出的改写稿，可以追加要求、一键应用（一次撤销恢复原文）、复制。
- **草稿不丢**：隐藏小窗、重启小窗、重启 dsh 后草稿都还在。

## 运行环境

- DeepSeek Harness 0.2.2-rc.1 或之后的 0.2.x（桌面版或 `dsh web`）。
- macOS 13 及以上（Apple 芯片或 Intel）。Windows 10/11、Linux 为预览。
- 第一次运行需要联网：小窗基于 Electron 44.10.2（约 125–160 MB），PromptX 把它下载到 dsh 数据目录，按随插件发布的 SHA-256 校验。默认先用国内镜像，失败时换 GitHub；在 PromptX 设置或 dsh 的插件页里可以指定下载源。

## 安装

可以直接在 DeepSeek Harness 桌面版的插件页安装 PromptX。

1. 打开「插件」，点击「添加插件」。旁边的下拉菜单也提供「安装第三方插件」。
2. 在包名输入框填写 `dsh-promptx`。要固定到这个版本，可以填写 `dsh-promptx@0.1.7`。
3. 点击「安装」，完成后选择「立即启用」，按提示重启 dsh。
4. 打开 PromptX 插件页，查看小窗运行时的下载进度。状态显示全局快捷键已生效后，macOS 按 ⌃P，Windows 和 Linux 按 Ctrl+Alt+P 呼出小窗。

dsh 会安装构建好的插件，PromptX 在首次启动时自动下载并校验小窗运行时。使用改写、自动生成标题和标签时，需要先在 dsh 配置默认模型。

使用 dsh 命令行版时，在平时运行的 profile 中安装。

```bash
dsh plugin --profile <你的-profile> add dsh-promptx@0.1.7
```

安装后重启对应的 dsh 实例。桌面版用户可以直接通过插件页管理安装。

### 从 Release 安装包安装

从 GitHub Releases 下载名为 `dsh-promptx-0.1.7.tgz` 的附件。在 dsh 的「添加插件」对话框填写下载文件的绝对路径，安装后启用 PromptX。命令行版也可以安装同一个文件。见 [GitHub Releases](https://github.com/LSHCoding/dsh-promptx/releases)。

```bash
dsh plugin --profile <你的-profile> add /安装包的/绝对路径/dsh-promptx-0.1.7.tgz
```

插件页提供更新操作时，可以直接使用。若所用 dsh 版本要求重新安装第三方插件来更新，可以卸载 PromptX 后安装目标版本，库和草稿会保留。

## 使用

| 操作 | macOS 默认键位 | Windows / Linux 默认键位 |
| --- | --- | --- |
| 呼出或隐藏小窗 | ⌃P（可修改） | Ctrl+Alt+P（可修改） |
| 复制全文并隐藏 | ⌘↩ | Ctrl+Enter |
| 保存到库 | ⌘S | Ctrl+S |
| 展开或收起库侧栏 | ⌘L | Ctrl+L |
| 用模型改写 / 停止 | ⇧⌘O | Shift+Ctrl+O |
| 隐藏小窗 | Esc | Esc |

清空、聊天和设置默认没有快捷键。留空任意工具栏快捷键字段即可停用该键位。

首次启动时，文件夹和提示词两列在左侧展开。选中提示词后，预览在列表下方展开；点预览标题右侧的 ×，或在「更多」里选「隐藏预览」，可以收起预览。标签按名称自动上色，同一个标签在哪里都是同一个颜色。切换库侧栏时，小窗在屏幕空间和窗口尺寸允许的范围内调整外框，保持编辑区宽度。

工具栏位于编辑区上方，左端是「库」，右端是「聊天」。「聊天」可以展开或收起右侧面板，启动时面板收起。隐藏小窗的按钮始终在窗口右上角，面板展开时位于面板标题栏。空面板里可以点「优化编辑区内容」，也可以在底部输入 Prompt 并发送，直接发起优化，同一个输入框也可以追加要求。工具栏的「优化」和「优化编辑区内容」使用主编辑区草稿。改写稿显示在单独的卡片里，点击卡片上的「应用」才会更新草稿。清空对话后面板保持展开。小窗重启时会在屏幕空间允许的范围内恢复编辑区宽度。

双击库条目，将正文插入编辑器光标位置。有选区时替换选区。主窗口的「保存」及其快捷键会新建库条目。dsh 默认模型会生成标题和标签，你可以修改预填内容、选择文件夹（默认「未分类」），点击「保存」后写入库。生成失败或多次重试仍然重名时，可以手动填写后保存。文件夹列可以新建文件夹。把指针移到文件夹上点删除按钮，或者右键文件夹，可以将它连同内容移入回收站。已删除的文件夹可以从回收站恢复。

点击条目的「在编辑器中打开」，可以在独立窗口编辑正文、标题、标签和文件夹。标签用逗号分隔，`Code Review` 这样的词组算一个标签。点击「保存修改」或按 ⌘S / Ctrl+S 更新当前条目。选了其他文件夹时，保存会将条目移到该文件夹。关闭或切换未保存的编辑时会询问保存、放弃或取消，未完成的条目编辑有单独的恢复草稿。

开启中文输入转换后，连续两个 `·` 变成两个反引号，第三个生成代码块；连续两个 `¥` 或 `￥` 变成 `$$`，第三个生成行间公式块。单个字符和粘贴内容保持原样，转换可以撤销，两项在 PromptX 设置里各有开关。

菜单栏（macOS）或托盘图标里有显示 / 隐藏、重置窗口位置、设置…、重启小窗。点击编辑区右上角的齿轮或「设置…」，会在小窗上方打开 PromptX 设置窗口，不再切到 dsh。全局快捷键和工具栏七个按钮的快捷键按下组合键即可录制，库目录用系统的选择文件夹对话框更换，也可以调整删除前确认、输入转换、优化指令和运行时下载源，每项改动立即生效。dsh 的 PromptX 插件页只留小窗没在运行时也必须能用的部分：小窗的运行状态、显示和重启，运行时的下载与删除，下载源和全局快捷键。插件页上的「打开 PromptX 设置」会打开设置窗口，设置窗口的「关于」里也有回到插件页的入口。

## 数据存放位置

都在 dsh 数据目录下（默认 `~/.dsh`，设置了 `DSH_HOME` 时以它为准）：

| 内容 | 位置 |
| --- | --- |
| Prompt 库（默认） | `promptx/library/`，可以在配置里换成任意目录 |
| 删除的 Prompt 和文件夹 | 库目录下的 `_trash/` |
| 草稿 | `storages/promptx_draft_<profile 哈希>.json` |
| 条目编辑恢复草稿 | `storages/promptx_entry_draft_<profile 哈希>.json` |
| 小窗运行时 | `promptx/runtime/` |
| 小窗位置和侧栏状态 | `promptx/prefs.json` |
| 小窗日志（不含 Prompt 内容） | `promptx/logs/` |

PromptX 将库和草稿保存在本机。保存新条目或请求改写时，dsh 会把 Prompt 正文发给配置的模型。小窗通过标准输入输出和 dsh 通信。

## 卸载

在 dsh 的「插件」页选择 PromptX，点击「卸载」。命令行版使用安装时的同一个 profile。

```bash
dsh plugin --profile <你的-profile> remove dsh-promptx
```

卸载插件不会删除库和草稿。要释放磁盘空间，可以在卸载前到 dsh 的 PromptX 插件页删除运行时，或者卸载后手动删除 dsh 数据目录下的 `promptx/runtime/`。

## 开发

使用 Node.js >=24.9.0，以及 `package.json` 声明的 pnpm 版本。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test        # 单元测试
pnpm smoke       # 构建、下载 Electron、启动小窗并检查握手
```

试用本地代码时，运行 `pnpm build`，再在 dsh 的「添加插件」对话框填写仓库的绝对路径。开发时使用 `promptx-dev` 这样的专用 profile。重新构建 Host 或小程序代码后，重启对应的 dsh 实例。

`pnpm pack` 会执行构建，生成 `dsh-promptx-0.1.7.tgz`。可以用下面的命令在独立的临时 dsh profile 中检查安装包。脚本使用 dsh 0.2.2-rc.1，结束后会清理临时 profile。加上 `--keep` 可以保留现场用于排查。

```bash
node scripts/e2e-local.mjs --package /安装包的/绝对路径/dsh-promptx-0.1.7.tgz
```

## 许可证

PromptX 使用 MIT 许可证。安装包包含项目许可证、借用代码和打包依赖的版权声明。见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
