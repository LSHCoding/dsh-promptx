# Third-party notices

PromptX includes or adapts material from the projects below. Each is used under its own license, reproduced here.

## DeepSeek Harness

- Used for: the theme variables in `src/app/renderer/styles/dsh-theme.css` (extracted from `@deepseek-ai/dsh-client-ui-theme`), the Client module wrapper format, lint configuration copied from the official repository, and the config page's controls and styles (`src/client/controls.tsx`, `src/client/styles.ts`), adapted from the settings form, Switch, Button and StateDot in `packages/client/ui-primitives` of DeepSeek Harness 0.2.2-rc.1.
- Source: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT, Copyright (c) 2026 DeepSeek

## dsh-quorfloat

- Used for: the design of the companion process supervisor and the stdio JSON-RPC channel (`src/companion/`, `src/shared/ndjson.ts`), and the macOS focus hand-back approach. Files that adapt its code say so in their header.
- Source: <https://github.com/Azetus/dsh-quorfloat>
- License: MIT, Copyright (c) 2026 Azetus

## dsh-codex-pets

- Used for: the approach to downloading the Electron runtime on first launch and pinning its checksums in source (`src/companion/runtime.ts`), and long-polling between the dsh page and the Host.
- Source: <https://github.com/jusong/dsh-codex-pets>
- License: MIT, Copyright (c) 2026 jusong

## dsh-plugin-template

- Used for: the tsdown configuration that builds the Host and the Client module (`tsdown.config.ts`).
- Source: <https://github.com/kun2-5code/dsh-plugin-template>
- License: MIT, Copyright (c) 2026 dsh-plugin-template authors

## Bundled in the companion window

`lib/app/renderer/renderer.js` bundles the following packages. Their copyright notices are retained below. The MIT license text under the next heading applies to each of them.

| Packages | Copyright notice |
| --- | --- |
| React 18.3.1, ReactDOM 18.3.1, Scheduler 0.23.2 | Copyright (c) Facebook, Inc. and its affiliates. |
| CodeMirror commands 6.11.1, language 6.13.1, state 6.7.6, view 6.43.15 | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| Lezer common 1.5.5, highlight 1.2.5 | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @marijn/find-cluster-break 1.0.4 | Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin> |
| style-mod 4.1.4 | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| w3c-keyname 2.2.8 | Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
