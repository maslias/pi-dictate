# dictate

Minimal voice dictation for pi. No floating bubbles, no menu bar app, no notifications.

- **Toggle:** `ctrl+shift+m` (press to start, press again to stop) — works **anywhere in pi**, not just the main chat input: quiz popups, `ask_user_question`, `ctx.ui.editor()`/`input()` dialogs, selectors. The key is intercepted at the TUI input layer, before whatever component has focus.
- **Cancel:** `escape` while recording (discard the in-flight transcript)
- **Language:** `/dictate-language-switch` cycles German → English. `/dictate-language de` and `/dictate-language en-US` set it directly. The selected language is used for the next dictation.
- **Where text goes:** to whatever input field is focused **when you stop** (never replaces, always appends):
  - Main chat editor or any `ctx.ui.editor()`/`input()` popup → appended directly.
  - Opaque dialogs (quiz / ask_user_question selects) → typed in as keystrokes. Their internal focus is invisible to the extension, so **Tab into the note/Other field first** — that's where the text will land.
  - Nothing text-capable focused → transcript is copied to the clipboard (via `pbcopy`, so macOS-only) and a notification says so. A finished dictation is never lost.
- **Start guard:** if no input field is focused when you press `ctrl+shift+m`, dictation doesn't start and a notification explains why.
- **Live feedback:** while recording, the status row shows a red `●` plus a real-time mic-level meter (`● ▂▅▇ listening…`) — instant confirmation your mic is live. On stop it flips to a `finalizing…` spinner.
- **Backend:** Deepgram Nova-3 streaming
- **What's "real-time":** audio is transcribed *while you talk*; the finalized text is inserted in one shot when you stop. Stop-to-display latency is typically ~300-500ms.

## Install

```bash
pi install git:github.com/amosblomqvist/pi-dictate
```

Or manually: copy `index.ts` to `~/.pi/agent/extensions/dictate/index.ts`.

## One-time setup

```bash
brew install sox                              # provides `rec` for audio capture
export DEEPGRAM_API_KEY=dg_xxxxxxxxxxxxxxxx   # add to ~/.zshrc or ~/.bashrc
```

Sign up at https://console.deepgram.com — $200 free credit, no card. The Nova-3 streaming rate is ~$0.0077/min (~$0.46/hr).

## Usage

1. Focus any pi input field — the main chat input, a quiz note field, an `ask_user_question` answer box.
2. Optional: use `/dictate-language-switch` to cycle German → English, or `/dictate-language de` / `/dictate-language en-US` to set it directly.
3. Press `ctrl+shift+m`. The status row shows a red `●` with a live mic-level meter and selected language: `● ▁▂▃▅ listening… German`. The bars move with your voice — if they stay flat, no audio is reaching the extension.
4. Talk.
5. Press `ctrl+shift+m` again. The meter is replaced by a braille spinner (`⠋ finalizing…`), then the text appears in the focused input.

Focus is resolved fresh at stop time, so if a dialog opened (or focus moved) while you were talking, the text goes to whatever is focused at that moment.

Run `/reload` in pi after first install (or after editing `index.ts`) to pick up changes.

## How it works

- The extension spawns `rec` (sox) capturing 16kHz mono 16-bit PCM to stdout.
- It opens a Deepgram WebSocket and pipes the PCM stream in.
- Deepgram returns "final" results (per-utterance, stable) as you talk. Interim/partial results are disabled — the editor never shows revisable text.
- While recording, each audio chunk's RMS loudness is mapped to a bar glyph and shifted through a 6-cell ring every 60ms — the live level meter in the status row.
- On stop, the extension sends `{"type": "CloseStream"}`, waits for the server to flush, and concatenates all finals. (If Deepgram never closes the socket, a 3s timeout forces finalization.)
- **Focus-aware delivery:** the extension captures pi's `TUI` instance once (via an invisible zero-height widget) and installs a `tui.addInputListener` handler — listeners run *before* the focused component, which is why `ctrl+shift+m` works inside dialogs (extension shortcuts are otherwise only matched by the main editor). Kitty-protocol key **release/repeat** events are filtered out, so one physical press toggles exactly once. On stop it inspects `tui.focusedComponent`: editor-like components (anything with `getText`/`setText`, including popups' inner `.editor`) get a direct append; opaque components get the text as synthetic keystrokes routed by their own focus logic.

## Customizing

All knobs are at the top of `index.ts`:

- **Hotkey:** change the `Key.ctrlShift("m")` and `Key.escape` references near the bottom (the input listener `onGlobalInput`; toggle also has a fallback `pi.registerShortcut` call).
- **Language cycle:** edit `LANGUAGE_PRESETS` near the top. Current cycle: `de` (German), `en-US` (English).
- **Model:** edit `buildDeepgramUrl()` — swap `model=nova-3` for `nova-2`, `enhanced`, etc.
- **Endpointing (how long a silence ends an utterance):** `endpointing=300` in the URL. Lower = faster finals, more fragmentation. Higher = slower finals, more coherent chunks.
- **Smart formatting / punctuation:** toggle `smart_format` and `punctuate` in the URL.
- **Level meter:** `METER_CELLS` (width in bars), `METER_TICK_MS` (update rate), `METER_FLOOR_DB` / `METER_CEILING_DB` (loudness range mapped to empty/full bars).

## Why `ctrl+shift+m` requires tmux extended keys

These bindings are `ctrl+shift`-based, which means tmux must forward extended keys because **`ctrl+shift+<letter>` is not representable as a legacy terminal byte** — adding Shift to `Ctrl+M` doesn't change the byte, so `Ctrl+Shift+M` is indistinguishable from `Ctrl+M` (i.e. `\r` = Enter). That means inside **tmux** (which doesn't pass through the Kitty keyboard protocol, and only forwards modified keys when `extended-keys` is on — it's off by default), `ctrl+shift+m` would collapse to **Enter and submit your prompt**.

When running inside tmux, use this in `~/.tmux.conf` (tmux 3.5+) so tmux forwards modified keys in CSI-u form:

```
set -g extended-keys on
set -g extended-keys-format csi-u
```

See https://pi.dev/docs/latest/tmux for the full pi-on-tmux keyboard guide.

## Troubleshooting

- **"DEEPGRAM_API_KEY not set"** — env var isn't visible to pi. Restart your terminal after editing your shell rc file, or run `export DEEPGRAM_API_KEY=...` in the same shell that launches pi.
- **"Failed to spawn 'rec'" / "rec error"** — `brew install sox` and verify with `which rec`.
- **No mic input** — first check the level meter: if the bars stay flat while you talk, no audio is reaching sox. macOS may need to grant your terminal app microphone access. System Settings → Privacy & Security → Microphone → enable your terminal (Terminal.app, iTerm, Ghostty, etc.).
- **Nothing happens after stop** — check console output (errors are surfaced as pi notifications). Most common cause: WebSocket couldn't reach Deepgram (firewall, bad key). If you saw "no input field is focused", the transcript was copied to the clipboard — paste with ⌘V.
- **Dictated text vanished into a quiz/ask dialog** — the dialog's option list (not its text field) had focus. Tab into the note/Other field before toggling dictation.
- **Shortcuts don't work inside tmux** — `ctrl+shift+m` can collapse to Enter unless tmux forwards modified keys; see the tmux section above. The old `alt+m`/`alt+n` bindings did not have this problem.
- **Need lifecycle logs?** Run pi with `DICTATE_DEBUG=1` — the extension appends timestamped events (key hits, toggles, WebSocket open/error/close with their session generation) to `/tmp/dictate-debug.log`.
