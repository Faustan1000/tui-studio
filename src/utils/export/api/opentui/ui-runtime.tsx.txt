// Runtime of the TUI Studio program API for OpenTUI. It is identical for every export; the typed
// facade `Ui` that goes with your design is generated in index.tsx (see PROGRAM_API.md).
//
//   const ui = new Ui();
//   await ui.start();                       // the UI runs in the event loop of this process, start() does not block
//   ui.submitBtn.onClick((e) => ...);       // events: handlers run asynchronously, never while rendering
//   ui.status.text = "Ready";               // properties: reading returns what the user sees, writing is silent
//   ui.nameInput.readonly();                // states: active / mute / readonly / hide
//   ui.report("Connection lost");           // error dialog + log
//   await ui.wait();                        // until the UI is closed

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import {
  TextAttributes,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { createRoot } from "@opentui/react";

export type UiState = "active" | "muted" | "readonly" | "hidden";
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

/** A user interaction: which component (`tag`), what happened (`name`) and its value. */
export interface UiEvent {
  tag: string;
  name: string;
  value: unknown;
  time: number;
}

export interface ErrorEntry {
  time: number;
  level: LogLevel;
  message: string;
  details: string;
  source: string;
}

export type UiHandler = (event: UiEvent) => unknown;

/** Misuse of the UI API (unsupported state, UI already closed, ...). */
export class UiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiError";
  }
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "#808080",
  info: "#00bcd4",
  warning: "#ffd54f",
  error: "#ff5252",
  critical: "#ff1744",
};

// ── Store ─────────────────────────────────────────────────────────────────────

type Listener = () => void;
type Slice = Readonly<Record<string, unknown>>;
const EMPTY: Slice = Object.freeze({});

/** State per code name. Components read it with `useSlice`; handles and user input write to it. */
export class Store {
  private data = new Map<string, Slice>();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  init(tag: string, value: Record<string, unknown>): void {
    this.data.set(tag, Object.freeze({ ...value }));
  }

  get(tag: string): Slice {
    return this.data.get(tag) ?? EMPTY;
  }

  patch(tag: string, patch: Record<string, unknown>): void {
    this.data.set(tag, Object.freeze({ ...this.get(tag), ...patch }));
    for (const listener of [...this.listeners]) listener();
  }
}

/** Re-render the calling component when the slice of `tag` changes. */
export function useSlice<T = Record<string, unknown>>(ui: UiCore, tag: string): Readonly<T> {
  return useSyncExternalStore(ui.store.subscribe, () => ui.store.get(tag)) as unknown as Readonly<T>;
}

export interface LogLine {
  time: number;
  level: LogLevel;
  message: string;
}

/** Internal slice `$ui`: error dialog, log panel. */
export interface UiSlice {
  dialog: ErrorEntry[];
  logOpen: boolean;
  lines: LogLine[];
  /** Counts scrolls of the app area (open dropdowns close when it scrolls). */
  scroll: number;
}

// ── Handles ───────────────────────────────────────────────────────────────────

/** What every code name offers: states, and (in generated subclasses) properties and events. */
export class Handle {
  constructor(
    protected readonly ui: UiCore,
    readonly tag: string,
    readonly type: string,
    readonly states: readonly UiState[]
  ) {}

  get state(): UiState {
    return this.ui.store.get(this.tag).state as UiState;
  }

  /** Normal. */
  active(): void {
    this.setState("active");
  }
  /** Visible and dimmed; ignores input and fires no events. */
  mute(): void {
    this.setState("muted");
  }
  /** Looks normal; the user cannot change it. */
  readonly(): void {
    this.setState("readonly");
  }
  /** Not shown, not focusable, takes no space. */
  hide(): void {
    this.setState("hidden");
  }
  /** Same as `active()`. */
  show(): void {
    this.setState("active");
  }

  private setState(state: UiState): void {
    if (!this.states.includes(state)) {
      throw new UiError(`${this.type} "${this.tag}" does not support the state "${state}"`);
    }
    this.ui.store.patch(this.tag, { state });
  }

  protected _get(name: string): unknown {
    return this.ui.store.get(this.tag)[name];
  }

  /** Writing never fires an event: events mean "the user did this". */
  protected _set(name: string, value: unknown): void {
    this.ui.store.patch(this.tag, { [name]: value });
  }

  protected _on(event: string, handler: UiHandler): () => void {
    return this.ui.on(this.tag, event, handler);
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

export class Log {
  constructor(private readonly ui: UiCore) {}
  debug(message: unknown): void {
    this.ui.addLog("debug", String(message));
  }
  info(message: unknown): void {
    this.ui.addLog("info", String(message));
  }
  warning(message: unknown): void {
    this.ui.addLog("warning", String(message));
  }
  error(message: unknown): void {
    this.ui.addLog("error", String(message));
  }
}

export interface StartOptions {
  /** Use this renderer instead of creating one (tests pass a headless one). */
  renderer?: CliRenderer;
}

type RootHandle = { render(node: ReactNode): void; unmount(): void };

export abstract class UiCore {
  readonly store = new Store();
  /** Errors reported with `report()` or thrown by handlers. */
  readonly errors: ErrorEntry[] = [];
  readonly log: Log = new Log(this);
  ready = false;
  /** A popup (dropdown) is open: clicks elsewhere only close it. */
  capture = false;
  running = false;
  renderer: CliRenderer | null = null;
  /** The scroll area around the app (a design taller than the terminal scrolls instead of shrinking). */
  readonly scrollRef: { current: ScrollBoxRenderable | null } = { current: null };

  private root: RootHandle | null = null;
  private closed = false;
  private closeWaiters: Array<() => void> = [];
  private queue: UiEvent[] = [];
  private pending: Array<(event: UiEvent | null) => void> = [];
  private callbacks = new Map<string, UiHandler[]>();
  private modals: Array<{ tag: string }> = [];

  /** The React element of the UI (generated). */
  protected abstract view(): ReactNode;

  constructor() {
    this.store.init("$overlay", { node: null });
    this.store.init("$ui", { dialog: [], logOpen: false, lines: [], scroll: 0 } satisfies UiSlice);
  }

  /** Register a handle with its initial values (used by the generated facade). */
  protected add<H extends Handle>(handle: H, initial: Record<string, unknown>): H {
    this.store.init(handle.tag, initial);
    if (handle.type === "Modal") this.modals.push({ tag: handle.tag });
    return handle;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Start the UI in this process; resolves when it is ready. Does not block. */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.running) return;
    if (this.closed) throw new UiError("the UI was closed; create a new Ui to start again");
    const renderer = options.renderer ?? (await createCliRenderer({ exitOnCtrlC: false, useMouse: true }));
    this.renderer = renderer;
    renderer.on("destroy", () => this.markClosed());
    this.root = createRoot(renderer) as RootHandle;
    this.root.render(<UiRoot ui={this}>{this.view()}</UiRoot>);
    this.running = true;
    this.ready = true;
  }

  /** Close the UI. Later calls on handles are ignored without error. */
  stop(): void {
    if (this.closed) return;
    this.markClosed();
    try {
      this.root?.unmount();
      this.renderer?.destroy();
    } catch (error) {
      this.report(error, { source: "stop" });
    }
  }

  /** Resolves when the UI is closed. */
  wait(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /** Start the UI, run `main(ui)` next to it (errors are reported) and wait until the UI closes. */
  async run(main?: (ui: this) => unknown): Promise<void> {
    await this.start();
    if (main) {
      void Promise.resolve()
        .then(() => main(this))
        .catch((error) => this.report(error, { source: "main" }));
    }
    await this.wait();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    for (const wake of this.pending.splice(0)) wake(null);
    for (const resolve of this.closeWaiters.splice(0)) resolve();
  }

  // ── events ──────────────────────────────────────────────────────────────────

  /** Register `handler` for `tag.name`; returns a function that removes it. */
  on(tag: string, name: string, handler: UiHandler): () => void {
    const key = `${tag}.${name}`;
    const list = this.callbacks.get(key) ?? [];
    list.push(handler);
    this.callbacks.set(key, list);
    return () => {
      const current = this.callbacks.get(key) ?? [];
      this.callbacks.set(
        key,
        current.filter((h) => h !== handler)
      );
    };
  }

  /** The next user interaction of any component; `null` after `timeoutMs` or when the UI closes. */
  nextEvent(timeoutMs?: number): Promise<UiEvent | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = (event: UiEvent | null) => {
        if (timer !== null) clearTimeout(timer);
        resolve(event);
      };
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.pending = this.pending.filter((w) => w !== wake);
          resolve(null);
        }, timeoutMs);
      }
      this.pending.push(wake);
    });
  }

  /** Whether the user may interact with `tag` (active; muted, readonly and hidden are not). */
  isActive(tag: string): boolean {
    const state = this.store.get(tag).state;
    return state == null || state === "active";
  }

  /**
   * Called by the generated components when the user did something. Muted, readonly and hidden
   * components send nothing. Handlers (and the editor's handler stubs) run asynchronously.
   */
  emit(tag: string | null, name: string, value: unknown, stubs: Array<(value?: unknown) => unknown> = []): void {
    if (this.closed) return;
    if (tag !== null) {
      if (!this.isActive(tag)) return;
      const event: UiEvent = { tag, name, value, time: Date.now() };
      const waiting = this.pending.shift();
      if (waiting) waiting(event);
      else this.queue.push(event);
      if (this.queue.length > 1000) this.queue.shift();
      for (const handler of [...(this.callbacks.get(`${tag}.${name}`) ?? [])]) {
        this.defer(() => handler(event), `${tag}.on_${name}`);
      }
    }
    for (const stub of stubs) this.defer(() => stub(value), tag ? `${tag}.${name}` : name);
  }

  private defer(fn: () => unknown, source: string): void {
    queueMicrotask(() => {
      try {
        const result = fn();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>)
          .then(null, (error: unknown) => this.report(error, { source }));
        }
      } catch (error) {
        this.report(error, { source });
      }
    });
  }

  // ── errors and log ──────────────────────────────────────────────────────────

  /** Report an error: it goes to `errors` and the log, and opens the error dialog. */
  report(error: unknown, options: { level?: LogLevel; source?: string } = {}): void {
    const level = options.level ?? "error";
    let message: string;
    let details = "";
    if (error instanceof Error) {
      message = error.message ? `${error.name}: ${error.message}` : error.name;
      details = error.stack ?? "";
    } else {
      message = String(error);
    }
    const entry: ErrorEntry = { time: Date.now(), level, message, details, source: options.source ?? "" };
    this.addLog(level, message);
    if (LEVELS[level] < LEVELS.error) return;
    this.errors.push(entry);
    const slice = this.store.get("$ui") as unknown as UiSlice;
    this.store.patch("$ui", { dialog: [...slice.dialog, entry] });
  }

  addLog(level: LogLevel, message: string): void {
    const slice = this.store.get("$ui") as unknown as UiSlice;
    const lines = [...slice.lines, { time: Date.now(), level, message }].slice(-200);
    this.store.patch("$ui", { lines });
  }

  /** Report uncaught exceptions and rejected promises of the program instead of printing over the UI. */
  installExcepthooks(): void {
    const proc = (globalThis as { process?: { on(event: string, fn: (error: unknown) => void): void } }).process;
    proc?.on("uncaughtException", (error) => this.report(error, { source: "uncaught" }));
    proc?.on("unhandledRejection", (error) => this.report(error, { source: "unhandled rejection" }));
  }

  // ── keys ────────────────────────────────────────────────────────────────────

  /** An error dialog is open: the app must not react to keys. */
  get blocked(): boolean {
    return this.capture || (this.store.get("$ui") as unknown as UiSlice).dialog.length > 0;
  }

  /** Content drawn above the whole UI (popup lists of dropdowns); below error dialogs. */
  setOverlay(node: ReactNode): void {
    this.store.patch("$overlay", { node });
  }

  /** The app area was scrolled. */
  bumpScroll(): void {
    const slice = this.store.get("$ui") as unknown as UiSlice;
    this.store.patch("$ui", { scroll: slice.scroll + 1 });
  }

  /**
   * Keys that belong to the runtime: Ctrl+C (close), Ctrl+L (log panel), Enter/Esc on the error
   * dialog, Esc on an open modal. Returns true when the key was used.
   */
  handleKey(key: KeyEvent): boolean {
    const slice = this.store.get("$ui") as unknown as UiSlice;
    if (key.ctrl && key.name === "c") {
      this.stop();
      return true;
    }
    if (key.ctrl && key.name === "l") {
      this.store.patch("$ui", { logOpen: !slice.logOpen });
      return true;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      const area = this.scrollRef.current;
      this.bumpScroll();
      if (area) area.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, (this.renderer?.height ?? 24) - 4));
      return true;
    }
    if (slice.dialog.length) {
      if (key.name === "return" || key.name === "linefeed" || key.name === "escape") {
        this.store.patch("$ui", { dialog: [] });
      }
      return true;
    }
    if (key.name === "escape") {
      for (let i = this.modals.length - 1; i >= 0; i--) {
        const tag = this.modals[i].tag;
        if (this.store.get(tag).open) {
          this.store.patch(tag, { open: false });
          return true;
        }
      }
    }
    return false;
  }
}

// ── Overlays ──────────────────────────────────────────────────────────────────

function UiRoot({ ui, children }: { ui: UiCore; children: ReactNode }) {
  const slice = useSlice<UiSlice>(ui, "$ui");
  const overlay = useSlice<{ node: ReactNode }>(ui, "$overlay");
  return (
    <box width="100%" height="100%" flexDirection="column">
      <scrollbox ref={ui.scrollRef} width="100%" flexGrow={1} onMouseScroll={() => ui.bumpScroll()}>
        {children}
      </scrollbox>
      {slice.logOpen ? <LogPanel lines={slice.lines} /> : null}
      {overlay.node}
      {slice.dialog.length ? <ErrorDialog entries={slice.dialog} /> : null}
    </box>
  );
}

function LogPanel({ lines }: { lines: LogLine[] }) {
  const shown = lines.slice(-6);
  return (
    <box
      width="100%"
      height={8}
      border
      borderStyle="single"
      title="Log (Ctrl+L closes)"
      flexDirection="column"
      backgroundColor="#000000"
    >
      {shown.map((line, i) => (
        <text key={i} fg={LEVEL_COLORS[line.level]} content={`${line.level.toUpperCase().padEnd(8)}${line.message}`} />
      ))}
    </box>
  );
}

function ErrorDialog({ entries }: { entries: ErrorEntry[] }) {
  return (
    <box
      position="absolute"
      zIndex={100}
      left="10%"
      top="20%"
      width="80%"
      border
      borderStyle="double"
      borderColor="#ff5252"
      title="Error"
      titleAlignment="center"
      flexDirection="column"
      padding={1}
      backgroundColor="#000000"
    >
      {entries.slice(-4).map((entry, i) => (
        <box key={i} flexDirection="column">
          <text fg="#ff5252" attributes={TextAttributes.BOLD} content={entry.message} />
          {entry.details
            .split("\n")
            .slice(1, 4)
            .map((line, j) => (
              <text key={j} fg="#808080" content={line.trim()} />
            ))}
        </box>
      ))}
      <text fg="#808080" content="Enter or Esc closes this message" />
    </box>
  );
}
