import { Handle, StudioUi, UiEvent } from './ui-runtime';
export * from './ui-runtime';

type Listener = (event: UiEvent) => unknown;

export declare class Ui extends StudioUi {
  /** Text: Text */
  readonly status: Handle & { text: string };
  /** TextInput: Text Input */
  readonly nameInput: Handle & { value: string; placeholder: string; onChange(fn: Listener): Listener; onSubmit(fn: Listener): Listener };
  /** Button: Button */
  readonly submitBtn: Handle & { label: string; onClick(fn: Listener): Listener };
  /** Checkbox: Checkbox */
  readonly agree: Handle & { checked: boolean; label: string; onChange(fn: Listener): Listener };
  /** Select: Select */
  readonly color: Handle & { value: string; options: string[]; onChange(fn: Listener): Listener };
  /** ProgressBar: Progress Bar */
  readonly progress: Handle & { value: number; max: number };
  /** Table: Table */
  readonly results: Handle & { columns: string[]; rows: string[][] };
  /** List: List */
  readonly files: Handle & { items: string[]; selected: number; onSelect(fn: Listener): Listener };
  /** Tabs: Tabs */
  readonly pages: Handle & { activeTab: number; onChange(fn: Listener): Listener };
  /** Box: Box */
  readonly panel: Handle;
  /** Text: Text */
  readonly inner: Handle & { text: string };
  /** Modal: Modal */
  readonly confirm: Handle & { title: string; open(): void; close(): void; readonly isOpen: boolean };
}
