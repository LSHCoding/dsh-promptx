# dsh-promptx

English | [中文](README.zh.md)

PromptX is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin with a small companion window. Press a global shortcut in any app and a prompt editor floats above it. Write a prompt, reuse one from your Markdown prompt library, or let the model configured in dsh rewrite it. Press ⌘↩ to copy the whole prompt; the window hides and focus returns to the app you were using, ready to paste.

> Version v0.1.5. macOS is the supported platform. Windows and Linux are previews pending CI and manual verification.

## What it does

- **Global shortcut and floating window.** The default is ⌃P on macOS and Ctrl+Alt+P on Windows and Linux. The window stays above other apps when you click elsewhere. Press the global shortcut again or copy and hide to dismiss it.
- **Editor**: plain-text Markdown editing with list continuation, Tab indentation, and optional Chinese-input conversions for backticks/code blocks and dollar signs/math blocks. Enter never sends anything.
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

| Action | macOS default | Windows / Linux default |
| --- | --- | --- |
| Show or hide the window | ⌃P (configurable) | Ctrl+Alt+P (configurable) |
| Copy everything and hide | ⌘↩ | Ctrl+Enter |
| Save to the library | ⌘S | Ctrl+S |
| Show or hide the library | ⌘L | Ctrl+L |
| Rewrite with the model / stop | ⇧⌘O | Shift+Ctrl+O |
| Hide the window | Esc | Esc |

Clear, Chat, and Settings start without a shortcut. Leave any toolbar shortcut field blank to disable that binding.

On first launch, the folder and prompt columns are visible on the left. Select a prompt to preview it below the list. To close the preview, click **×** at the right of its title or choose **Hide preview** from **More**. Each tag gets a color from its name, so it looks the same everywhere. Toggling the library adjusts the window width to preserve the editor width within display and window size limits.

The toolbar sits above the editor, with the library toggle on the left and **Chat** on the right. **Chat** shows or hides the panel on the right, which starts closed. The button that hides the window stays in the window's top-right corner, in the chat header while the panel is open. In an empty chat panel, select **Optimize editor content**, or enter a prompt in the chat box and select **Send** to start a rewrite, then use the same box for follow-up requests. The toolbar's rewrite button and **Optimize editor content** use the main editor draft. Each rewrite appears in its own card. Select **Apply** on the card to update that draft. Clearing the conversation leaves the panel open. PromptX restores the editor width on restart within the available screen space.

Double-click a library entry to insert its body at the editor's cursor, replacing any selected text. **Save** and the Save shortcut in the main window start a new library entry. The default dsh model suggests a title and tags. Review or edit them, choose a folder (default **Uncategorized**), and select **Save**. If the model can't suggest a unique title, you can enter the title and tags yourself. Use the folder column to create folders. Hover over a folder and select its delete button, or right-click it, to move the folder and its contents to the library trash. Restore deleted folders from the trash.

Use **Open in editor** on a library entry to edit its body, title, tags, and folder in a separate window above PromptX. Separate tags with commas to keep phrases like `Code Review` together. **Save changes** and ⌘S / Ctrl+S update the selected entry and move it if you chose a different folder. Closing or switching away from unsaved edits asks whether to save, discard, or cancel. Unfinished entry edits have their own recovery draft.

With input conversions enabled, typing two `·` characters produces two backticks; a third creates a code block. Two `¥` or `￥` characters produce `$$`; a third creates a display math block. Single characters and pasted text are preserved. Each conversion can be undone, and each feature has its own switch in the plugin settings.

The menu bar (macOS) or tray icon has Show/Hide, Reset window position, Settings…, and Restart window. Use the gear in the editor toolbar to open PromptX settings in dsh. The seven toolbar shortcuts can be changed there alongside the global shortcut, library folder, delete confirmation, input conversions, rewrite instruction, and runtime download source.

## Where data lives

All paths are under the dsh data directory (`~/.dsh` unless `DSH_HOME` is set):

| What | Where |
| --- | --- |
| Prompt library (default) | `promptx/library/` — any folder you choose in settings |
| Deleted prompts and folders | `_trash/` inside the library folder |
| Draft | `storages/promptx_draft_<profile hash>.json` |
| Entry-editor recovery draft | `storages/promptx_entry_draft_<profile hash>.json` |
| Companion runtime | `promptx/runtime/` |
| Window position and panel state | `promptx/prefs.json` |
| Companion logs (no prompt text) | `promptx/logs/` |

PromptX stores your library and drafts locally. When you save a new prompt or request a rewrite, dsh sends the prompt text to your configured model. The companion window talks to dsh over standard input and output.

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
