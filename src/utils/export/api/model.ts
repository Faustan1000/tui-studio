// The program API of a design as data: which handles to generate, with which states,
// properties (and their initial values) and events. Every framework exporter renders this model
// in its own language, so the API is the same everywhere (see docs/PROGRAM_API.md).

import type { ComponentType } from '../../../types';
import type { IRNode, IRProject, IRScreen } from '../ir';
import { walkIR } from '../ir';
import { API_SPEC, type ApiState, type ApiValueType } from './spec';

export type ApiCase = 'snake' | 'camel' | 'pascal';

export interface ApiPropertyModel {
  /** Name in snake_case, as in spec.ts (`active_tab`). */
  name: string;
  type: ApiValueType;
  /** Initial value from the design, already of the right type. */
  initial: string | number | boolean | string[] | string[][];
}

export interface ApiEventModel {
  /** `click`, `change`, `submit`, `select`. */
  name: string;
  /** Name of the handler the user typed in the editor for this event, if any. */
  editorHandler?: string;
}

export interface ApiHandleModel {
  /** Code name exactly as typed. */
  tag: string;
  type: ComponentType;
  node: IRNode;
  states: readonly ApiState[];
  properties: ApiPropertyModel[];
  events: ApiEventModel[];
  /** Initial state: `hidden` when the user hid the component, else `active` (`muted` if disabled). */
  initialState: ApiState;
}

export interface ApiScreenModel {
  tag: string;
  screen: IRScreen;
}

export interface ApiModel {
  handles: ApiHandleModel[];
  /** Screens with a code name (`ui.<tag>.show()`); only meaningful for multi-screen exports. */
  screens: ApiScreenModel[];
}

/** All handles of a project: every component that has a code name and an API spec. */
export function buildApiModel(project: IRProject): ApiModel {
  const handles: ApiHandleModel[] = [];
  const screens: ApiScreenModel[] = [];
  for (const screen of project.screens) {
    if (screen.tag) screens.push({ tag: screen.tag, screen });
    for (const node of walkIR(screen.root)) {
      if (!node.tag || node === screen.root) continue;
      handles.push(handleOf(node));
    }
  }
  return { handles, screens };
}

function handleOf(node: IRNode): ApiHandleModel {
  const spec = API_SPEC[node.type];
  return {
    tag: node.tag!,
    type: node.type,
    node,
    states: spec.states,
    properties: spec.properties.map((p) => ({
      name: p.name,
      type: p.type,
      initial: initialValue(node, p.prop, p.type),
    })),
    events: spec.events.map((e) => ({
      name: e.name,
      editorHandler: e.editorKey ? node.events[e.editorKey] || undefined : undefined,
    })),
    initialState: node.hidden ? 'hidden' : node.disabled ? 'muted' : 'active',
  };
}

/** The value of a spec property as the IR has it (items are reduced to their labels). */
function initialValue(node: IRNode, prop: string, type: ApiValueType): ApiPropertyModel['initial'] {
  switch (prop) {
    case 'content':
    case 'label':
    case 'title':
      return node.text;
    case 'value':
      return node.type === 'ProgressBar' ? node.progress.value : node.value;
    case 'max':
      return node.progress.max;
    case 'placeholder':
      return node.placeholder;
    case 'checked':
      return node.checked;
    case 'options':
      return node.options;
    case 'columns':
      return node.columns;
    case 'rows':
      return node.rows;
    case 'items':
      return node.items.map((i) => i.label);
    case 'selectedIndex':
    case 'activeTab':
      return node.selected;
    default:
      return zeroOf(type);
  }
}

function zeroOf(type: ApiValueType): ApiPropertyModel['initial'] {
  switch (type) {
    case 'str':
      return '';
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'str_list':
      return [];
    case 'rows':
      return [];
  }
}

// ── Names ─────────────────────────────────────────────────────────────────────

/**
 * A code name in the case of the target language: `submit_btn` → `submitBtn` / `SubmitBtn`.
 * The user's own capitalisation inside the parts is kept (`Name_input` → `nameInput`).
 */
export function apiName(tag: string, style: ApiCase): string {
  if (style === 'snake') return tag;
  const parts = tag.split('_').filter(Boolean);
  const upper = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const lower = (w: string) => w.charAt(0).toLowerCase() + w.slice(1);
  const joined =
    style === 'pascal'
      ? parts.map(upper).join('')
      : lower(parts[0] ?? '') + parts.slice(1).map(upper).join('');
  return tag.endsWith('_') ? `${joined}_` : joined;
}

/** `active_tab` + `get` → `getActiveTab`; with no prefix → `activeTab` / `ActiveTab`. */
export function apiMember(name: string, style: ApiCase, prefix = ''): string {
  if (style === 'snake') return prefix ? `${prefix}_${name}` : name;
  const joined = apiName(prefix ? `${prefix}_${name}` : name, style);
  return joined;
}

/** `on_` + event: `on_click` / `onClick` / `OnClick`. */
export function apiEventMethod(event: string, style: ApiCase): string {
  return apiMember(event, style, 'on');
}

/** Words that cannot be a field/variable name in the language (a trailing `_` is added). */
const RESERVED: Record<'ts' | 'rust' | 'go', ReadonlySet<string>> = {
  ts: new Set(
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of'.split(
      ' '
    )
  ),
  rust: new Set(
    'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try'.split(
      ' '
    )
  ),
  go: new Set(
    'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(
      ' '
    )
  ),
};

/** Make `name` safe as an identifier in `lang` (keywords get a trailing `_`). */
export function safeIdent(name: string, lang: 'ts' | 'rust' | 'go'): string {
  return RESERVED[lang].has(name) ? `${name}_` : name;
}
