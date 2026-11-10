# Changelog

## 0.1.1 — 2026-11-10

- Insert library entries at the editor cursor by double-clicking a row, preserving selection replacement, undo, and editor focus.
- Add independently configurable Chinese-input conversions for `·` to backticks/code blocks and `¥` / `￥` to dollar signs/display math blocks.
- Make Save and the save shortcut in the main window always create a new library entry. Restore older drafts without retaining their file-update binding.
- Open existing library entries in a separate editor window, where Save changes updates that entry. Keep the main draft intact, confirm unsaved closes and switches, and store unfinished entry edits in a separate recovery draft.

Manual macOS input-method and desktop-interaction acceptance, and cross-platform CI verification, remain pending.

## 0.1.0 — 2026-11-09

Initial version for local installation in DeepSeek Harness.

- Open a floating prompt editor with a configurable global shortcut; copy the prompt, hide the window, and return focus to the previous app.
- Edit Markdown with list continuation and indentation, and keep drafts across companion and dsh restarts.
- Search, insert, open, save, rename, tag, and favorite prompts in a local Markdown library; restore deleted prompts from the trash.
- Stream rewrites from the model configured in dsh, continue the conversation, and apply or copy the result.
- Download and verify the companion's Electron runtime, and manage the companion from the dsh plugin settings.

macOS is supported. Windows and Linux are previews; cross-platform CI verification and manual testing on those platforms are pending.
