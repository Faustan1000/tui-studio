// Types of ui-runtime.js (generated, identical for every export).

export type State = 'active' | 'muted' | 'readonly' | 'hidden';
export type Level = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/** A user interaction: which component (`tag`), what happened (`name`) and its value. */
export interface UiEvent {
  tag: string;
  name: string;
  value: unknown;
  time: number;
}

export interface ErrorEntry {
  time: number;
  level: Level;
  message: string;
  details: string;
  source: string;
}

export declare class UiError extends Error {}

/** One component of the UI (the generated `Ui` adds its properties and event methods). */
export declare class Handle {
  readonly tag: string;
  readonly type: string;
  state: State;
  active(): void;
  mute(): void;
  readonly(): void;
  hide(): void;
  show(): void;
}

/** One screen of the UI (several screens only): `ui.settings.show()` switches to it. */
export declare class ScreenHandle {
  readonly key: string;
  readonly isActive: boolean;
  show(): void;
  /** Called every time this screen has been shown. */
  onShow(fn: () => unknown): () => unknown;
}

export declare class StudioUi {
  constructor(options?: Record<string, unknown>);
  /** The blessed screen (null before `start()`). */
  readonly screen: any;
  readonly ready: boolean;
  readonly running: boolean;
  readonly errors: ErrorEntry[];
  readonly log: {
    debug(message: unknown): void;
    info(message: unknown): void;
    warning(message: unknown): void;
    error(message: unknown): void;
  };
  start(): Promise<this>;
  run(main?: (ui: this) => unknown): Promise<void>;
  stop(): void;
  wait(): Promise<void>;
  report(error: Error | string, options?: { level?: Level; source?: string }): void;
  nextEvent(timeout?: number): Promise<UiEvent | null>;
  get(tag: string): Handle;
  on(tag: string, name: string, fn: (event: UiEvent) => unknown): (event: UiEvent) => unknown;
  installExcepthooks(): void;
  focusNext(step: number): void;
  /** Switch to another screen by its key (code name, else identifier). */
  showScreen(key: string): void;
  rounded(widget: unknown): void;
}

export declare const STATES: readonly State[];
