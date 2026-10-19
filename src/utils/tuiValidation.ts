// Validation for untrusted .tui files before they reach the stores

import type { ComponentNode, ComponentType } from '../types/components';

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

function validateNode(raw: unknown, depth: number, state: { count: number; ids: Set<string> }) {
  if (depth > MAX_TREE_DEPTH) throw new Error(`Tree deeper than ${MAX_TREE_DEPTH} levels`);
  if (++state.count > MAX_TREE_NODES) throw new Error(`More than ${MAX_TREE_NODES} components`);
  if (!isPlainObject(raw)) throw new Error('Component is not an object');

  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200)
    throw new Error('Component has an invalid id');
  if (state.ids.has(raw.id)) throw new Error(`Duplicate component id "${raw.id}"`);
  state.ids.add(raw.id);

  if (typeof raw.type !== 'string' || !COMPONENT_TYPES.has(raw.type))
    throw new Error(`Unknown component type "${String(raw.type)}"`);
  if (typeof raw.name !== 'string' || raw.name.length > 500)
    throw new Error('Component has an invalid name');
  for (const key of ['props', 'style', 'events'] as const) {
    if (!isPlainObject(raw[key])) throw new Error(`Component "${raw.id}": "${key}" must be an object`);
  }
  if (!isPlainObject(raw.layout) || !LAYOUT_TYPES.has(raw.layout.type as string))
    throw new Error(`Component "${raw.id}": invalid layout`);
  if (!Array.isArray(raw.children)) throw new Error(`Component "${raw.id}": children must be an array`);
  for (const key of ['locked', 'hidden', 'collapsed'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
      throw new Error(`Component "${raw.id}": "${key}" must be a boolean`);
  }

  raw.children.forEach((c) => validateNode(c, depth + 1, state));
}

export interface ValidTuiFile {
  tree: ComponentNode;
  theme?: string;
}

/** Parse and validate the text of a .tui file. Throws an Error with a readable message. */
export function parseTuiFile(text: string, validThemes: readonly string[]): ValidTuiFile {
  if (text.length > MAX_TUI_FILE_BYTES) throw new Error('File is too large');
  let data: unknown;
  try {
    data = sanitize(JSON.parse(text));
  } catch (e) {
    throw new Error(e instanceof Error && e.message.includes('deeply') ? e.message : 'Not valid JSON');
  }
  if (!isPlainObject(data) || data.version !== '1') throw new Error('Unsupported file version');

  validateNode(data.tree, 0, { count: 0, ids: new Set() });

  let theme: string | undefined;
  if (isPlainObject(data.meta) && data.meta.theme !== undefined) {
    if (typeof data.meta.theme !== 'string' || !validThemes.includes(data.meta.theme))
      throw new Error('Unknown theme');
    theme = data.meta.theme;
  }
  const tree = data.tree as ComponentNode;
  tree.locked ??= false;
  tree.hidden ??= false;
  tree.collapsed ??= false;
  return { tree, theme };
}
