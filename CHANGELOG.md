# Changelog

## 0.1.5 — 2026-11-12

- Align the headers and footers of the library, editor, and chat columns, and let the empty space in each header move the window. Put the library toggle at the left of the toolbar and Settings and Chat at the right. Keep the hide-window button in the window's top-right corner, in the chat header while the chat panel is open.
- Show the library preview only after you select a prompt. Keep Insert at cursor and More in a fixed row below the list. Delete a folder from the button on its row or from its context menu. Fix a horizontal scrollbar that appeared in the list when hovering over or selecting a prompt.
- Increase the editor line height to 1.6 and show the copy shortcut inside the Copy and hide button.
- Add an empty state to the chat panel with a button that rewrites the editor content. Put Send inside the chat box, show each rewrite in a card with Copy and Apply in its header, and collapse the first prompt to four lines.
- Show a single editable title in the entry editor, with the folder and tags on one row. Align dialog fields, and note when the model suggested the title and tags.

## 0.1.4 — 2026-11-12

- Place the toolbar above the editor and make each toolbar shortcut configurable in PromptX settings.
- Keep the Chat button visible and start with the chat panel closed. Send a prompt directly from the empty chat panel to start a rewrite. Clearing the conversation leaves the panel open.
- Create folders, move folders to the library trash, and choose a destination when saving a prompt. New prompts default to Uncategorized. Saving changes to an existing prompt can move it to another folder.
- Restore the editor width on restart when the chat panel was open at shutdown.

## 0.1.3 — 2026-11-11

- Generate a title and tags with the default dsh model when saving a new prompt. Review or edit the suggestions before saving, or enter metadata manually if generation fails.
- Edit a saved prompt's title, tags, and body in its separate editor. Keep multi-word tags and recover unfinished metadata edits with the entry draft.

## 0.1.2 — 2026-11-11

- Keep the floating editor visible when it loses focus, including on profiles that previously enabled automatic hiding. Pressing the global shortcut again hides the window even when another app has focus.
- Show both library columns on first launch. Keep the editor width when toggling the library where display space permits.
- Replace the toolbar's Settings icon with a gear.

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
