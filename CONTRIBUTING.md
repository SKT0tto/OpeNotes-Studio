# Contributing

Thanks for helping. This is an unofficial fan project (GPL-3.0-or-later); by contributing you agree your work is released under the same license.

- Never commit game assets (models, textures, backgrounds, audio), Live2D Cubism Core, screenshots containing them, API keys, or personal paths. Fixtures under `tests/fixtures` must be synthetic.
- Setup: see README. Before opening a PR run `npm run typecheck && npm run lint && npm test` (and `npm run test:e2e` for UI changes).
- Keep changes focused, add or update tests, and keep user-visible text in Chinese consistent with the existing UI.
- Project files must stay backward compatible: old `.ournotes.json` exports have to keep importing.
