# dsh-promptx

English | [中文](README.zh.md)

PromptX is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin with a small companion window. Press a global shortcut in any app and a prompt editor floats above it. Write a prompt, reuse one from your Markdown prompt library, or let the model configured in dsh rewrite it. Press ⌘↩ to copy the whole prompt; the window hides and focus returns to the app you were using, ready to paste.

> Status: under development (V0.1.0). macOS is the supported platform. Windows and Linux are previews: they build and pass automated tests but have not been tested by hand.

## What it does

- **Global shortcut and floating window**: ⌃P on macOS, Ctrl+Alt+P on Windows and Linux. The window stays above other apps and hides again after you copy.
- **Editor**: plain-text Markdown editing with list continuation and Tab indentation. Enter never sends anything.
- **Prompt library**: a normal folder of Markdown files with YAML front matter (title, tags, favorite). Search, filter, insert at the cursor, open, save, rename, tag, favorite, delete to a trash folder and restore. Files you have not edited in PromptX are never modified.
- **Rewrite with your dsh model**: a side panel streams a rewrite from the default model configured in dsh, with follow-up requests, apply (one undo restores the original), and copy.
- **Drafts are kept**: hiding the window, restarting the companion or restarting dsh keeps your draft.

## Requirements

- DeepSeek Harness 0.2.2-rc.1 or a later 0.2.x release (desktop app or `dsh web`).
- macOS 13 or later (Apple silicon or Intel). Windows 10/11 and Linux are previews.
- Network access on first run: the companion window runs on Electron 44.10.2 (about 125–160 MB), which PromptX downloads once into the dsh data directory and verifies against SHA-256 checksums shipped with the plugin. The download uses a mirror in mainland China first and falls back to GitHub; you can choose the source in the plugin settings.

## Install from a local checkout

```bash
pnpm install
pnpm build
npx @deepseek-ai/dsh plugin --profile <your profile> add /absolute/path/to/dsh-promptx
```

Restart dsh after installing or updating the plugin. On the first start, open the Plugins page, choose PromptX, and watch the runtime download progress. When the status shows the global shortcut is active, press it from any app.

## Using it

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Show or hide the window | ⌃P (configurable) | Ctrl+Alt+P (configurable) |
| Copy everything and hide | ⌘↩ | Ctrl+Enter |
| Save to the library | ⌘S | Ctrl+S |
| Show or hide the library | ⌘L | Ctrl+L |
| Rewrite with the model / stop | ⇧⌘O | Shift+Ctrl+O |
| Hide the window | Esc | Esc |

The menu bar (macOS) or tray icon has Show/Hide, Reset window position, Settings…, and Restart window. Settings live on the PromptX page of dsh's Plugins page: library folder, delete confirmation, rewrite instruction, global shortcut, hide when the window loses focus, and runtime download source.

## Where data lives

All paths are under the dsh data directory (`~/.dsh` unless `DSH_HOME` is set):

| What | Where |
| --- | --- |
| Prompt library (default) | `promptx/library/` — any folder you choose in settings |
| Deleted prompts | `_trash/` inside the library folder |
| Draft | `storages/promptx_draft_<profile hash>.json` |
| Companion runtime | `promptx/runtime/` |
| Window position and panel state | `promptx/prefs.json` |
| Companion logs (no prompt text) | `promptx/logs/` |

PromptX does not sync anything, has no accounts and sends prompt text only to the model you configured in dsh, and only when you ask for a rewrite. The companion window opens no network ports; it talks to dsh over standard input and output.

## Uninstall

```bash
npx @deepseek-ai/dsh plugin --profile <your profile> remove dsh-promptx
```

Removing the plugin keeps your library and draft. To reclaim disk space, delete the runtime from the PromptX settings page before removing the plugin, or delete `promptx/runtime/` in the dsh data directory afterwards.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test        # unit tests
pnpm smoke       # builds, downloads Electron, starts the companion and checks the handshake
```

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for code and assets adapted from other projects.
