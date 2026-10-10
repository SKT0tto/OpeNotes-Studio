# Security

OpeNotes Studio is a local tool: the server binds to 127.0.0.1 and is not meant to be exposed to a network.

- API keys you enter in the AI settings dialog are stored only on your machine in `data/settings.local.json` (gitignored) or taken from `.env` / environment variables. They are sent only to the LLM endpoint you configure, and are never returned to the browser (only a masked form is shown).
- Never commit `.env`, `data/` or `studio.config.json`. If a key leaks, revoke it at the provider.
- Report vulnerabilities privately via the author's bilibili space (https://space.bilibili.com/358479834) rather than a public issue.
