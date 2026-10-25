# Third-party components

Runtime dependencies (exact versions pinned in `package.json`):

| Package | Version | License | Use |
|---|---|---|---|
| express | 5.3.0 | MIT | server, read-only asset serving |
| zod | 4.6.5 | MIT | shared schemas |
| react / react-dom | 19.3.0 | MIT | editor UI |
| pixi.js | 8.22.0 | MIT | rendering |
| untitled-pixi-live2d-engine | 1.4.0 | MIT (bundles Cubism Framework, Live2D Open Software License) | Live2D runtime (`/cubism` entry) |
| zustand | 5.0.15 | MIT | editor state store |
| immer | 11.1.21 | MIT | immutable edits with patches (undo/redo) |
| @anthropic-ai/sdk | 0.133.0 | MIT | Claude API client (`server/llm/anthropic.ts`) |
| quickjs-emscripten | 0.32.0 | MIT (QuickJS, MIT, compiled to WebAssembly) | sandbox of the assistant's `run_script` (`server/agent/sandbox.ts`) |
| yazl | 3.3.1 | MIT | zip writing for `npm run pack-assets` (depends on `buffer-crc32`, MIT) |
| yauzl | 3.4.0 | MIT | safe zip reading for asset import (`server/assets/import/zip.ts`); depends on `pend` (MIT) |

Development tooling: typescript, tsx, vite (6.4.2), @vitejs/plugin-react, vitest, @playwright/test, concurrently, eslint, typescript-eslint, eslint-plugin-react-hooks, globals, @types/* (all MIT/Apache-2.0).

## Not bundled / not reused

- `haneoka-gakuen/haneoka` (MPL-2.0) and `altair-plugin-haneoka` (GitHub licence field: NOASSERTION): only read for ideas (site structure, the shape of the public index API, which fields a model3.json needs). **No code or files from either project are used**; the importer, normaliser and manifest generator are original work, so no MPL notice is attached to any file. If a MPL-2.0 file is ever copied in, keep its header and list it here; `altair-plugin-haneoka` must not be copied without a confirmed licence.
- The three public JSON endpoints of haneoka.org are read at run time by the optional manifest feature (metadata only; no media is downloaded).


- **Live2D Cubism Core** (proprietary, Live2D Proprietary Software License): never committed; loaded at runtime from the official CDN or from a user-provided local copy under `vendor/` (gitignored).
- **Game assets** (models, backgrounds, audio): an external read-only library referenced through `ASSET_ROOT`; never copied into this repository.
- `empty-sekai/ournotes-player` (AGPL-3.0): documentation read for behaviour semantics only; no code used.

## Full production dependency list (from package-lock.json)

Licenses as declared by each package (all permissive: MIT, ISC, BSD-3-Clause, Unlicense; GPL-compatible).

| Package | Version | License |
|---|---|---|
| @anthropic-ai/sdk | 0.133.0 | MIT |
| @babel/runtime | 7.29.10 | MIT |
| @jitl/quickjs-ffi-types | 0.32.0 | MIT |
| @jitl/quickjs-wasmfile-debug-asyncify | 0.32.0 | MIT |
| @jitl/quickjs-wasmfile-debug-sync | 0.32.0 | MIT |
| @jitl/quickjs-wasmfile-release-asyncify | 0.32.0 | MIT |
| @jitl/quickjs-wasmfile-release-sync | 0.32.0 | MIT |
| @pixi/colord | 2.9.6 | MIT |
| @pixi/sound | 6.0.1 | MIT |
| @stablelib/base64 | 1.0.1 | MIT |
| @types/earcut | 3.0.0 | MIT |
| @types/react | 19.3.0 | MIT |
| @webgpu/types | 0.1.74 | BSD-3-Clause |
| @xmldom/xmldom | 0.8.15 | MIT |
| accepts | 2.0.0 | MIT |
| body-parser | 2.3.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| content-disposition | 2.0.1 | MIT |
| content-type | 2.1.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| csstype | 3.2.3 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| dunder-proto | 1.0.1 | MIT |
| earcut | 3.2.4 | ISC |
| ee-first | 1.1.1 | MIT |
| encodeurl | 2.0.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| eventemitter3 | 5.0.4 | MIT |
| express | 5.3.0 | MIT |
| fast-sha256 | 1.3.0 | Unlicense |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gifuct-js | 2.1.2 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| http-errors | 2.0.1 | MIT |
| iconv-lite | 0.7.3 | MIT |
| immer | 11.1.21 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| ismobilejs | 1.1.1 | MIT |
| js-binary-schema-parser | 2.0.3 | MIT |
| json-schema-to-ts | 3.1.1 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 1.1.1 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 3.0.2 | MIT |
| ms | 2.1.3 | MIT |
| negotiator | 1.1.0 | MIT |
| object-inspect | 1.13.4 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| parse-svg-path | 0.2.0 | MIT |
| parseurl | 1.3.3 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pend | 1.2.0 | MIT |
| pixi.js | 8.22.0 | MIT |
| proxy-addr | 2.0.8 | MIT |
| qs | 6.16.0 | BSD-3-Clause |
| range-parser | 1.3.0 | MIT |
| raw-body | 3.0.2 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| router | 2.2.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| scheduler | 0.28.0 | MIT |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setprototypeof | 1.2.0 | ISC |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| standardwebhooks | 1.1.1 | MIT |
| quickjs-emscripten | 0.32.0 | MIT |
| quickjs-emscripten-core | 0.32.0 | MIT |
| statuses | 2.0.2 | MIT |
| tiny-lru | 11.4.7 | BSD-3-Clause |
| toidentifier | 1.0.1 | MIT |
| ts-algebra | 2.0.0 | MIT |
| type-is | 2.1.0 | MIT |
| unpipe | 1.0.0 | MIT |
| untitled-pixi-live2d-engine | 1.4.0 | MIT |
| vary | 1.1.2 | MIT |
| wrappy | 1.0.2 | ISC |
| yauzl | 3.4.0 | MIT |
| zod | 4.6.5 | MIT |
| zustand | 5.0.15 | MIT |
