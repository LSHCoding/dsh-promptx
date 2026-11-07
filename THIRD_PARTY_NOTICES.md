# Third-party notices

PromptX includes or adapts material from the projects below. Each is used under its own license, reproduced here.

## DeepSeek Harness

- Used for: the theme variables in `src/app/renderer/styles/dsh-theme.css` (extracted from `@deepseek-ai/dsh-client-ui-theme`), the Client module wrapper format, and lint configuration copied from the official repository.
- Source: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT

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

`lib/app/renderer/renderer.js` bundles React and ReactDOM (MIT, Copyright (c) Meta Platforms, Inc. and affiliates) and CodeMirror 6 with its Lezer dependencies (MIT, Copyright (c) 2018-2021 by Marijn Haverbeke and others).

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
