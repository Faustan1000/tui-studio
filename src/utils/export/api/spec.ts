// Framework-neutral description of what program code can do with each component type:
// which states it supports, which values can be read/written and which events it emits.
// Exporters turn this into a typed API in their target language (so far: Textual).

import type { ComponentType } from '../../../types';

/**
 * - active: normal
 * - muted: visible but dimmed and not interactive
 * - readonly: shows its value normally but cannot be changed by the user
 * - hidden: not shown at all
 */
export type ApiState = 'active' | 'muted' | 'readonly' | 'hidden';

export type ApiValueType = 'str' | 'int' | 'float' | 'bool' | 'str_list' | 'rows';

export interface ApiProperty {
  /** Name in the generated API (snake_case). */
  name: string;
  type: ApiValueType;
  /** Key in the component's `props` that holds the editor's initial value. */
  prop: string;
}

export interface ApiEvent {
  /** Event name in the generated API: `on_<name>` / `events.<name>`. */
  name: string;
  /** Key in the component's `events` where the editor stores a handler name, if any. */
  editorKey?: string;
}

export interface ApiSpec {
  states: readonly ApiState[];
  properties: readonly ApiProperty[];
  events: readonly ApiEvent[];
}

const ALL: readonly ApiState[] = ['active', 'muted', 'readonly', 'hidden'];
const NO_READONLY: readonly ApiState[] = ['active', 'muted', 'hidden'];
const HIDE_ONLY: readonly ApiState[] = ['active', 'hidden'];

export const API_SPEC: Record<ComponentType, ApiSpec> = {
  Screen: { states: HIDE_ONLY, properties: [], events: [] },
  Box: { states: HIDE_ONLY, properties: [], events: [] },
  Grid: { states: HIDE_ONLY, properties: [], events: [] },
  Spacer: { states: HIDE_ONLY, properties: [], events: [] },

  TextInput: {
    states: ALL,
    properties: [
      { name: 'value', type: 'str', prop: 'value' },
      { name: 'placeholder', type: 'str', prop: 'placeholder' },
    ],
    events: [{ name: 'change', editorKey: 'onChange' }, { name: 'submit' }],
  },
  Button: {
    states: NO_READONLY,
    properties: [{ name: 'label', type: 'str', prop: 'label' }],
    events: [{ name: 'click', editorKey: 'onClick' }],
  },
  Checkbox: {
    states: ALL,
    properties: [
      { name: 'checked', type: 'bool', prop: 'checked' },
      { name: 'label', type: 'str', prop: 'label' },
    ],
    events: [{ name: 'change', editorKey: 'onChange' }],
  },
  Radio: {
    states: ALL,
    properties: [
      { name: 'checked', type: 'bool', prop: 'checked' },
      { name: 'label', type: 'str', prop: 'label' },
    ],
    events: [{ name: 'change', editorKey: 'onChange' }],
  },
  Select: {
    states: ALL,
    properties: [
      { name: 'value', type: 'str', prop: 'value' },
      { name: 'options', type: 'str_list', prop: 'options' },
    ],
    events: [{ name: 'change', editorKey: 'onChange' }],
  },
  Toggle: {
    states: ALL,
    properties: [
      { name: 'checked', type: 'bool', prop: 'checked' },
      { name: 'label', type: 'str', prop: 'label' },
    ],
    events: [{ name: 'change', editorKey: 'onChange' }],
  },

  Text: {
    states: HIDE_ONLY,
    properties: [{ name: 'text', type: 'str', prop: 'content' }],
    events: [],
  },
  Spinner: {
    states: HIDE_ONLY,
    properties: [{ name: 'label', type: 'str', prop: 'label' }],
    events: [],
  },
  ProgressBar: {
    states: NO_READONLY,
    properties: [
      { name: 'value', type: 'float', prop: 'value' },
      { name: 'max', type: 'float', prop: 'max' },
    ],
    events: [],
  },

  Table: {
    states: ALL,
    properties: [
      { name: 'columns', type: 'str_list', prop: 'columns' },
      { name: 'rows', type: 'rows', prop: 'rows' },
    ],
    events: [],
  },
  List: {
    states: ALL,
    properties: [
      { name: 'items', type: 'str_list', prop: 'items' },
      { name: 'selected', type: 'int', prop: 'selectedIndex' },
    ],
    events: [{ name: 'select', editorKey: 'onSelect' }],
  },
  Tree: {
    states: ALL,
    properties: [],
    events: [{ name: 'select', editorKey: 'onSelect' }],
  },

  Menu: {
    states: ALL,
    properties: [{ name: 'selected', type: 'int', prop: 'selectedIndex' }],
    events: [{ name: 'select', editorKey: 'onSelect' }],
  },
  Tabs: {
    states: ALL,
    // `active_tab`: plain `active` is taken by the state method `active()`.
    properties: [{ name: 'active_tab', type: 'int', prop: 'activeTab' }],
    events: [{ name: 'change', editorKey: 'onChange' }],
  },
  Breadcrumb: { states: HIDE_ONLY, properties: [], events: [] },

  Modal: {
    states: HIDE_ONLY,
    properties: [{ name: 'title', type: 'str', prop: 'title' }],
    events: [],
  },
};
