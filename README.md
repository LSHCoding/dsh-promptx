# dsh-promptx

English | [中文](README.zh.md)

PromptX is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin with a small companion window. Press a global shortcut in any app and a prompt editor floats above it. Write a prompt, reuse one from your Markdown prompt library, or let the model configured in dsh rewrite it. Press ⌘↩ to copy the whole prompt; the window hides and focus returns to the app you were using, ready to paste.

> Version v0.1.7. macOS is the supported platform. Windows and Linux are previews pending manual verification.

## What it does

- **Global shortcut and floating window.** The default is ⌃P on macOS and Ctrl+Alt+P on Windows and Linux. The window stays above other apps when you click elsewhere. Press the global shortcut again or copy and hide to dismiss it.
- **Editor**: plain-text Markdown editing with list continuation, Tab indentation, and optional Chinese-input conversions for backticks/code blocks and dollar signs/math blocks. Enter never sends anything.
- **Prompt library**: a normal folder of Markdown files with YAML front matter (title, tags, favorite). Search, filter, insert at the cursor, open, save, rename, tag, favorite, delete to a trash folder and restore. Files you have not edited in PromptX are never modified.
- **Rewrite with your dsh model**: a side panel streams a rewrite from the default model configured in dsh, with follow-up requests, apply (one undo restores the original), and copy.
- **Drafts are kept**: hiding the window, restarting the companion or restarting dsh keeps your draft.

## Requirements

- DeepSeek Harness 0.2.2-rc.1 or a later 0.2.x release (desktop app or `dsh web`).
- macOS 13 or later (Apple silicon or Intel). Windows 10/11 and Linux are previews.
- Network access on first run: the companion window runs on Electron 44.10.2 (about 125–160 MB), which PromptX downloads once into the dsh data directory and verifies against SHA-256 checksums shipped with the plugin. The download uses a mirror in mainland China first and falls back to GitHub; you can choose the source in PromptX settings or on the plugin page in dsh.

## Install

Install PromptX from the Plugins page in DeepSeek Harness Desktop.

1. Open **Plugins** and select **Add plugin**. The dropdown also has **Install third-party plugin**.
2. Enter `dsh-promptx` in the package input. To install this version explicitly, enter `dsh-promptx@0.1.7`.
3. Select **Install**, then **Enable now**. Restart dsh if prompted.
4. Open the PromptX plugin page to see the companion runtime download progress. When the status shows the global shortcut is active, press ⌃P on macOS or Ctrl+Alt+P on Windows and Linux.

dsh installs the built plugin and PromptX downloads and verifies the companion runtime on first launch. Configure dsh's default model to use prompt rewriting and model-generated titles and tags.

For a CLI installation of dsh, use the profile you normally run.

```bash
dsh plugin --profile <your-profile> add dsh-promptx@0.1.7
```

Restart that dsh instance after installation. Desktop users can manage their installation through its Plugins page.

### Install a release tarball

Download the `dsh-promptx-0.1.7.tgz` attachment from GitHub Releases. In dsh's **Add plugin** dialog, enter the downloaded file's absolute path, install it, and enable PromptX. CLI users can install the same file with the following command. See [GitHub Releases](https://github.com/LSHCoding/dsh-promptx/releases).

```bash
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-promptx-0.1.7.tgz
```

Use the plugin page's update action when offered. If your dsh version requires reinstalling third-party plugins to update them, remove PromptX and install the desired version. Your library and drafts are kept.

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

With input conversions enabled, typing two `·` characters produces two backticks; a third creates a code block. Two `¥` or `￥` characters produce `$$`; a third creates a display math block. Single characters and pasted text are preserved. Each conversion can be undone, and each feature has its own switch in PromptX settings.

The menu bar (macOS) or tray icon has Show/Hide, Reset window position, Settings…, and Restart window. The gear in the editor toolbar and Settings… open the PromptX settings window above the editor, without switching to dsh. Change the global shortcut and the seven toolbar shortcuts by recording a key combination, choose the library folder with the system folder picker, and adjust delete confirmation, input conversions, the rewrite instruction, and the runtime download source. Each change takes effect immediately. The PromptX plugin page in dsh keeps what has to work even when the window isn't running: the window status, Show window, Restart window, runtime download and deletion, the download source, and the global shortcut. Its Open PromptX settings button opens the settings window, and the settings window's About section links back to the plugin page.

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

In dsh, open **Plugins**, select PromptX, and choose **Uninstall**. For a CLI installation, use the same profile as during installation.

```bash
dsh plugin --profile <your-profile> remove dsh-promptx
```

Removing the plugin keeps your library and draft. To reclaim disk space, delete the runtime from the PromptX plugin page in dsh before removing the plugin, or delete `promptx/runtime/` in the dsh data directory afterwards.

## Development

Use Node.js >=24.9.0 and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test        # unit tests
pnpm smoke       # builds, downloads Electron, starts the companion and checks the handshake
```

To try a local checkout, run `pnpm build`, then enter the checkout's absolute path in dsh's **Add plugin** dialog. For development, use a dedicated dsh profile such as `promptx-dev`. Restart that dsh instance after rebuilding Host or companion code.

`pnpm pack` runs the build and produces `dsh-promptx-0.1.7.tgz`. Check the built package in an isolated temporary dsh profile with the following command. The script uses dsh 0.2.2-rc.1 and removes its temporary profile on exit. Add `--keep` to retain it for diagnosis.

```bash
node scripts/e2e-local.mjs --package /absolute/path/to/dsh-promptx-0.1.7.tgz
```

## License

PromptX is released under the MIT license. The project license and notices for adapted code and bundled libraries are included in the installable package. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
