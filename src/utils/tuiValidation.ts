// Validation for untrusted .tui files before they reach the stores

import type { ComponentNode, ComponentType } from '../types/components';
import { validateTag } from './apiTag';

export const MAX_TUI_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TREE_DEPTH = 50;
export const MAX_TREE_NODES = 5000;

const COMPONENT_TYPES: ReadonlySet<string> = new Set<ComponentType>([
  'Screen',
  'Box',
  'Grid',
  'Spacer',
  'TextInput',
  'Button',
  'Checkbox',
  'Radio',
  'Select',
  'Toggle',
  'Text',
  'Spinner',
  'ProgressBar',
  'Table',
  'List',
  'Tree',
  'Menu',
  'Tabs',
  'Breadcrumb',
  'Modal',
]);

const LAYOUT_TYPES: ReadonlySet<string> = new Set(['flexbox', 'grid', 'absolute', 'none']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively copy JSON data, dropping keys that could pollute prototypes. */
function sanitize(v: unknown, depth = 0): unknown {
  if (depth > MAX_TREE_DEPTH * 4) throw new Error('Data nested too deeply');
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = sanitize(val, depth + 1);
    }
    return out;
  }
  return v;
}

function validateNode(
  raw: unknown,
  depth: number,
  state: { count: number; ids: Set<string>; tags: Set<string> }
) {
  if (depth > MAX_TREE_DEPTH) throw new Error(`Tree deeper than ${MAX_TREE_DEPTH} levels`);
  if (++state.count > MAX_TREE_NODES) throw new Error(`More than ${MAX_TREE_NODES} components`);
  if (!isPlainObject(raw)) throw new Error('Component is not an object');

  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200)
    throw new Error('Component has an invalid id');
  if (state.ids.has(raw.id)) throw new Error(`Duplicate component id "${raw.id}"`);
  // Every screen's root is called "root"; all other ids must be unique across screens.
  if (depth > 0) {
    if (raw.id === 'root') throw new Error('The id "root" is reserved for screens');
    state.ids.add(raw.id);
  }

  if (raw.tag !== undefined) {
    if (typeof raw.tag !== 'string') throw new Error(`Component "${raw.id}": tag must be text`);
    const problem = validateTag(raw.tag, state.tags);
    if (problem) throw new Error(`Component "${raw.id}": invalid code name (${problem})`);
    if (raw.tag) state.tags.add(raw.tag);
  }

  if (raw.showWhen !== undefined) {
    const sw = raw.showWhen;
    if (
      !isPlainObject(sw) ||
      typeof sw.nav !== 'string' ||
      sw.nav.length === 0 ||
      sw.nav.length > 200 ||
      !Number.isInteger(sw.item) ||
      (sw.item as number) < 0 ||
      (sw.item as number) > 1000
    )
      throw new Error(`Component "${raw.id}": invalid "visible when" setting`);
  }

  if (typeof raw.type !== 'string' || !COMPONENT_TYPES.has(raw.type))
    throw new Error(`Unknown component type "${String(raw.type)}"`);
  if (typeof raw.name !== 'string' || raw.name.length > 500)
    throw new Error('Component has an invalid name');
  for (const key of ['props', 'style', 'events'] as const) {
    if (!isPlainObject(raw[key]))
      throw new Error(`Component "${raw.id}": "${key}" must be an object`);
  }
  if (!isPlainObject(raw.layout) || !LAYOUT_TYPES.has(raw.layout.type as string))
    throw new Error(`Component "${raw.id}": invalid layout`);
  if (!Array.isArray(raw.children))
    throw new Error(`Component "${raw.id}": children must be an array`);
  for (const key of ['locked', 'hidden', 'collapsed'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
      throw new Error(`Component "${raw.id}": "${key}" must be a boolean`);
  }

  raw.children.forEach((c) => validateNode(c, depth + 1, state));
}

export const MAX_SCREENS = 50;

export interface ValidTuiFile {
  screens: { id: string; tree: ComponentNode }[];
  activeId?: string;
  theme?: string;
}

/** Parse and validate the text of a .tui file. Throws an Error with a readable message. */
export function parseTuiFile(text: string, validThemes: readonly string[]): ValidTuiFile {
  if (text.length > MAX_TUI_FILE_BYTES) throw new Error('File is too large');
  let data: unknown;
  try {
    data = sanitize(JSON.parse(text));
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message.includes('deeply') ? e.message : 'Not valid JSON'
    );
  }
  if (!isPlainObject(data)) throw new Error('Unsupported file version');

  // Version 1 files hold a single tree, version 2 a list of screens.
  let rawScreens: unknown[];
  if (data.version === '1') {
    rawScreens = [{ id: 'screen-1', tree: data.tree }];
  } else if (data.version === '2') {
    if (!Array.isArray(data.screens) || data.screens.length === 0)
      throw new Error('File has no screens');
    if (data.screens.length > MAX_SCREENS) throw new Error(`More than ${MAX_SCREENS} screens`);
    rawScreens = data.screens;
  } else {
    throw new Error('Unsupported file version');
  }

  // Ids and code names are shared across screens (the exported Ui covers all of them).
  const state = { count: 0, ids: new Set<string>(), tags: new Set<string>() };
  const screenIds = new Set<string>();
  const screens: { id: string; tree: ComponentNode }[] = rawScreens.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0)
      throw new Error('Screen has an invalid id');
    if (entry.id.length > 100) throw new Error('Screen has an invalid id');
    if (screenIds.has(entry.id)) throw new Error(`Duplicate screen id "${entry.id}"`);
    screenIds.add(entry.id);
    validateNode(entry.tree, 0, state);
    const tree = entry.tree as ComponentNode;
    if (tree.type !== 'Screen') throw new Error('A screen must start with a Screen component');
    tree.locked ??= false;
    tree.hidden ??= false;
    tree.collapsed ??= false;
    return { id: entry.id, tree };
  });

  let theme: string | undefined;
  if (isPlainObject(data.meta) && data.meta.theme !== undefined) {
    if (typeof data.meta.theme !== 'string' || !validThemes.includes(data.meta.theme))
      throw new Error('Unknown theme');
    theme = data.meta.theme;
  }
  const activeId =
    isPlainObject(data.meta) && typeof data.meta.activeScreen === 'string'
      ? data.meta.activeScreen
      : undefined;
  return { screens, activeId, theme };
}
