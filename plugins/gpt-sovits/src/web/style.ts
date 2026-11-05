/** The plugin's styles, added to the page when it activates (the studio's own classes cover the rest). */
export const CSS = `
.voice-form .voice-h { margin: 10px 0 0; font-size: 14px; }
.voice-form .voice-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.voice-form .voice-line > input.text { flex: 1; min-width: 160px; }
.voice-form .voice-char { border: 1px solid var(--line, #3a3f4b); border-radius: 6px; padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 6px; }
.voice-form .voice-char legend { padding: 0 6px; }
.voice-form .voice-char legend small { color: var(--text-2); }
.voice-form .voice-errors { margin: 4px 0 0; padding-left: 18px; max-height: 120px; overflow: auto; font-size: 12px; }
.voice-form .voice-sel { flex: 1; min-width: 0; max-width: 100%; }
.voice-form .voice-match-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.voice-form .voice-match-table th, .voice-form .voice-match-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line, #3a3f4b); vertical-align: top; word-break: break-all; }
`;
