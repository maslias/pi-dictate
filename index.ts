/**
 * dictate — minimal voice dictation for pi.
 *
 * Press ctrl+shift+m to start, press it again to stop.
 * Press escape to cancel and discard the in-flight transcript.
 *
 * Focus-aware: ctrl+shift+m/escape are intercepted at the TUI input layer (before any
 * focused component), so dictation works inside ANY dialog — quiz popups,
 * ask_user_question, ctx.ui.editor()/input() — not just the main chat editor.
 *
 * Start rule: dictation only begins if some text-capable component is
 * focused; otherwise an ephemeral notification explains why nothing happened.
 * Opaque dialogs (quiz/ask selects) count as text-capable, but their internal
 * focus is invisible to us — Tab into the note/Other field first so the text
 * lands there.
 *
 * Stop rule: the delivery target is resolved fresh at stop time and the
 * transcript goes to whatever is focused THEN (editor-like components get a
 * direct setText append; opaque components get synthetic keystrokes). If
 * nothing text-capable is focused at stop, the transcript is copied to the
 * clipboard and a notification says so — a finished dictation is never lost.
 *
 * Requires:
 *   - sox installed (`brew install sox` — provides the `rec` command)
 *   - DEEPGRAM_API_KEY environment variable set
 *
 * Streaming model: audio is sent to Deepgram while you talk; the server
 * transcribes in real time and emits per-utterance "final" results. We
 * collect those finals and inject the concatenated text on stop. No
 * partials are shown in the editor (cosmetic-only), so quality is good
 * and the editor never shows revisable text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync } from "node:fs";

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// lifecycle events (listener hits, toggles, ws open/error/close with their
// generation) to /tmp/dictate-debug.log.
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

// Deepgram streaming endpoint. Tuning notes:
//   model=nova-3        — flagship, sub-300ms latency, best accuracy
//   encoding=linear16   — raw 16-bit PCM (what sox/rec gives us with -e signed-integer -b 16)
//   sample_rate=16000   — 16kHz mono is the standard low-bandwidth STT format
//   interim_results=false — we only want finals, never partials
//   smart_format=true   — formats numbers, dates, currencies nicely
//   punctuate=true      — adds commas/periods/question marks
//   endpointing=300     — 300ms of silence ends an utterance (faster finals)
//   language=<code>     — selected by /dictate-language or /dictate-language-switch; default cycle is de/en-US
const LANGUAGE_PRESETS = [
  { code: "de", label: "German" },
  { code: "en-US", label: "English" },
];

function buildDeepgramUrl(languageCode: string): string {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "false",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    language: languageCode,
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so ctrl+shift+m works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Inspect tui.focusedComponent to decide where the transcript goes.
// `focusedComponent` is declared private in the typings but is a plain
// runtime property — a benign peek, easily patched if pi internals change.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Compute normalized RMS (0..1) over a buffer of signed 16-bit little-endian PCM samples. */
function rmsFromPcm16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const s = buf.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let rec: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let ws: WebSocket | null = null;
  let finals: string[] = [];
  let activeCtx: ExtensionContext | null = null;
  let flushed = false;
  let cancelled = false;
  let stopTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Session generation: incremented on every start and every cleanup. All
  // rec/ws event handlers capture the generation they belong to and no-op
  // when it's stale — otherwise a PREVIOUS session's socket erroring/closing
  // late (e.g. one we aborted mid-handshake) would run cleanup() and tear
  // down the CURRENT live session.
  let generation = 0;
  // Audio meter state. `meter` is a ring of recent RMS values, newest at
  // index METER_CELLS-1. `currentLevel` is the most recent RMS observed from
  // any audio chunk — the meter tick just samples it. Crucially we never reset
  // it: empty ticks re-render the last observed value, so the bars never drop
  // to silence just because no chunk happened to arrive in that 60ms window.
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;
  let languageIndex = 0;

  const currentLanguage = () => LANGUAGE_PRESETS[languageIndex] ?? LANGUAGE_PRESETS[0]!;

  const announceLanguage = (ctx: ExtensionContext) => {
    const lang = currentLanguage();
    const suffix = state === "idle" ? "" : " (applies to next dictation)";
    ctx.ui.notify(`Dictation language: ${lang.label}${suffix}`);
  };

  const cycleLanguage = (ctx: ExtensionContext) => {
    languageIndex = (languageIndex + 1) % LANGUAGE_PRESETS.length;
    announceLanguage(ctx);
  };

  const setLanguage = (codeOrLabel: string, ctx: ExtensionContext): boolean => {
    const wanted = codeOrLabel.trim().toLowerCase();
    const idx = LANGUAGE_PRESETS.findIndex(
      (lang) => lang.code.toLowerCase() === wanted || lang.label.toLowerCase() === wanted,
    );
    if (idx < 0) return false;
    languageIndex = idx;
    announceLanguage(ctx);
    return true;
  };

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    // Recording dot: a text glyph colored via the theme, not an emoji — emoji
    // presentation renders double-width in its own baked-in color and visually
    // shouts in the footer. `●` is the same dot pi's own docs use for
    // indicators; theme "error" gives the red. (If you ever want strictly
    // ASCII, swap the glyph for "O".)
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      setStatus(`${dot} ${meter.map(rmsToBlock).join("")} listening… ${currentLanguage().label}`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    // Editor-like focus: the main chat editor, custom editors, and the
    // ctx.ui.editor()/input() popups (their inner pi-tui Editor hangs off
    // `.editor`). These accept a guaranteed direct setText append.
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    // Opaque component with input handling (quiz/ask selects, selectors):
    // we can type into it, but whether the text lands depends on its
    // internal focus (e.g. the quiz note field must be Tab-focused).
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const flush = () => {
    if (flushed || !activeCtx) return;
    flushed = true;
    if (cancelled) return; // discard transcript on cancel
    const text = finals.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;

    // Legacy fallback: no TUI handle captured (non-TUI mode / older pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + text);
      return;
    }

    // Resolve the target NOW — focus may have changed while dictating.
    const target = resolveTarget();
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      // Synthetic typing: the component routes the text wherever its
      // internal focus is. Text is plain printable words (whitespace
      // already normalized), so no keybindings/autocomplete can trigger.
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on
    // the clipboard and say so.
    try {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.end(text);
    } catch {}
    activeCtx.ui.notify("Dictation finished but no input field is focused — transcript copied to clipboard", "warning");
  };

  const cleanup = () => {
    generation++; // invalidate the dying session's event handlers
    dbg(`cleanup → gen ${generation}`);
    flush();
    stopSpinner();
    stopMeter();
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
      rec = null;
    }
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {}
      ws = null;
    }
    finals = [];
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    flushed = false;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      ctx.ui.notify("DEEPGRAM_API_KEY not set in environment", "error");
      return;
    }

    activeCtx = ctx;
    finals = [];
    flushed = false;
    cancelled = false;
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();

    // Spawn sox `rec` to capture 16kHz / 16-bit / mono PCM to stdout.
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(
        "rec",
        [
          "-q", // quiet
          // Shrink sox's IO buffer so stdout flushes ~every 16ms instead of
          // the default ~256ms. 512 bytes = 256 samples = 16ms at 16kHz/16-bit
          // mono. This is the dominant source of meter latency.
          "--buffer", "512",
          "-r", "16000",
          "-c", "1",
          "-b", "16",
          "-e", "signed-integer",
          "-t", "raw",
          "-", // stdout
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      ctx.ui.notify(`Failed to spawn 'rec'. Install sox: brew install sox`, "error");
      cleanup();
      return;
    }
    rec = proc;

    proc.on("error", (err) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`rec error: ${err.message} (install sox: brew install sox)`, "error");
      cleanup();
    });

    proc.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale recorder — a newer/ended session owns state
      // Natural exit on SIGTERM during stopDictation is fine. Anything else
      // mid-recording is a problem.
      if (state === "recording" && code !== null && code !== 0) {
        if (activeCtx) {
          activeCtx.ui.notify(`rec exited unexpectedly (code ${code})`, "warning");
        }
        cleanup();
      }
    });

    // Open Deepgram WebSocket. Auth via subprotocol (portable across Node native
    // WebSocket and browsers): `new WebSocket(url, ["token", API_KEY])`.
    try {
      ws = new WebSocket(buildDeepgramUrl(currentLanguage().code), ["token", apiKey]);
    } catch (e: any) {
      ctx.ui.notify(`Deepgram WS failed: ${e.message}`, "error");
      cleanup();
      return;
    }

    ws.addEventListener("open", () => {
      if (myGeneration !== generation) {
        dbg(`ws open (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws open (gen ${myGeneration})`);
      if (!rec || !ws) return;
      rec.stdout.on("data", (chunk: Buffer) => {
        // Track loudness for the meter (just the latest chunk's RMS — the meter
        // tick samples this), then forward to Deepgram.
        currentLevel = rmsFromPcm16(chunk);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      if (myGeneration !== generation) return;
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "Results" && msg.is_final) {
          const t = msg.channel?.alternatives?.[0]?.transcript;
          if (t) finals.push(t);
        }
        // We could also handle msg.type === "Metadata" (sent after CloseStream
        // finishes draining), but ws.close handles the same flush path.
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.addEventListener("error", () => {
      if (myGeneration !== generation) {
        dbg(`ws error (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws error (gen ${myGeneration})`);
      if (activeCtx) activeCtx.ui.notify("Deepgram WebSocket error", "error");
      cleanup();
    });

    ws.addEventListener("close", (ev) => {
      if (myGeneration !== generation) {
        dbg(`ws close (stale gen ${myGeneration}, current ${generation}, code ${ev.code}) — ignored`);
        return;
      }
      dbg(`ws close (gen ${myGeneration}, code ${ev.code})`);
      // Server-initiated close (or our own close in cleanup): finalize.
      if (state === "recording" || state === "stopping") {
        cleanup();
      }
    });
  };

  /** Stop dictation, finalize transcript, append to editor. */
  const stopDictation = () => {
    if (state !== "recording") return;
    state = "stopping";
    stopMeter();
    startSpinner("finalizing…");

    // Stop the mic first so no more audio enqueues.
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
    }

    // Tell Deepgram we're done; it will flush remaining finals then close.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        cleanup();
        return;
      }
      // Safety net: if Deepgram never closes the socket, force cleanup after 3s.
      stopTimeout = setTimeout(() => {
        if (state === "stopping") cleanup();
      }, 3000);
    } else {
      cleanup();
    }
  };

  /** Cancel dictation: discard any collected transcript and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    finals = [];
    // No need to wait for Deepgram to flush — we're throwing the result away.
    cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      stopDictation();
    }
    // Ignore presses during the "stopping" state — Deepgram is finalizing.
  };

  // Global input listener: catches ctrl+shift+m/escape before ANY focused component,
  // which is what makes dictation work inside dialogs. Registered once the
  // TUI handle is captured (see session_start below).
  const onGlobalInput = (data: string) => {
    // Kitty flag-2 terminals send press + REPEAT + RELEASE events, and input
    // listeners run BEFORE the TUI's release filter (that filter only guards
    // dispatch to the focused component). matchesKey also ignores the Kitty
    // event type. Without this guard a single physical ctrl+shift+m press toggles
    // TWICE: press starts dictation, release instantly stops it and closes
    // the WebSocket mid-handshake — which then surfaces as
    // "Deepgram WebSocket error" (and its stale error event can kill the NEXT
    // session). Filter to press events only.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.ctrlShift("m"))) {
      dbg(`ctrl+shift+m (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if ((state === "recording" || state === "stopping") && matchesKey(data, Key.escape)) {
      dbg(`escape cancel (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    // Capture the TUI handle via an invisible zero-height widget. The
    // listener function reference is stable, so even if the factory re-runs
    // the TUI's listener Set de-dupes it.
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (non-TUI modes, older pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Toggle voice dictation (Deepgram)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  pi.registerCommand("dictate-language-switch", {
    description: "Cycle voice dictation language (German ↔ English)",
    handler: async (_args, ctx) => {
      cycleLanguage(ctx);
    },
  });

  pi.registerCommand("dictate-language", {
    description: "Set voice dictation language: /dictate-language de|en-US|german|english",
    getArgumentCompletions: (prefix: string) => {
      const items = LANGUAGE_PRESETS.flatMap((lang) => [
        { value: lang.code, label: lang.label },
        { value: lang.label.toLowerCase(), label: lang.label },
      ]);
      const p = prefix.toLowerCase();
      return items.filter((item) => item.value.toLowerCase().startsWith(p));
    },
    handler: async (args, ctx) => {
      const value = (args ?? "").trim();
      if (!value) {
        announceLanguage(ctx);
        return;
      }
      if (!setLanguage(value, ctx)) {
        ctx.ui.notify("Usage: /dictate-language de|en-US|german|english", "warning");
      }
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });
}
