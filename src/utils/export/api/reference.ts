// API.md of an export: every component with a code name, spelled exactly as the program has to
// write it in the target language (names, states, properties, events). Rendered from the same
// model the exporters generate their handles from, so it cannot drift from the generated code.

import type { IRProject } from '../ir';
import {
  apiEventMethod,
  apiMember,
  apiName,
  buildApiModel,
  safeIdent,
  type ApiCase,
  type ApiHandleModel,
} from './model';
import { methodsOf } from './facade';
import type { ApiState, ApiValueType } from './spec';

type Lang = 'python' | 'ts' | 'go' | 'rust';

interface Style {
  title: string;
  /** Case of code names, properties and events. */
  style: ApiCase;
  ident: (tag: string) => string;
  access: (name: string) => string;
  read: (prop: string) => string;
  write: (prop: string, value: string) => string;
  event: (event: string, arg: string) => string;
  state: (state: string) => string;
  types: Record<ApiValueType, string>;
  lifecycle: string[];
}

const STATE_VERB: Record<ApiState, string> = {
  active: 'active',
  muted: 'mute',
  readonly: 'readonly',
  hidden: 'hide',
};

const FRAMEWORK_LANG: Record<string, Lang> = {
  textual: 'python',
  ink: 'ts',
  opentui: 'ts',
  blessed: 'ts',
  bubbletea: 'go',
  tview: 'go',
  ratatui: 'rust',
};

const STYLES: Record<Lang, Style> = {
  python: {
    title: 'Python',
    style: 'snake',
    ident: (t) => t,
    access: (n) => `ui.${n}`,
    read: (p) => `.${p}`,
    write: (p, v) => `.${p} = ${v}`,
    event: (e, a) => `.${apiEventMethod(e, 'snake')}(${a})`,
    state: (s) => `.${STATE_VERB[s as ApiState]}()`,
    types: {
      str: 'str',
      int: 'int',
      float: 'float',
      bool: 'bool',
      str_list: 'list[str]',
      rows: 'list[list[str]]',
    },
    lifecycle: ['ui = Ui()', 'ui.start()', 'ui.wait()', 'ui.report(error_or_message)', 'ui.log.info("...")'],
  },
  ts: {
    title: 'TypeScript',
    style: 'camel',
    ident: (t) => safeIdent(apiName(t, 'camel'), 'ts'),
    access: (n) => `ui.${n}`,
    read: (p) => `.${apiMember(p, 'camel')}`,
    write: (p, v) => `.${apiMember(p, 'camel')} = ${v}`,
    event: (e, a) => `.${apiEventMethod(e, 'camel')}(${a})`,
    state: (s) => `.${STATE_VERB[s as ApiState]}()`,
    types: {
      str: 'string',
      int: 'number',
      float: 'number',
      bool: 'boolean',
      str_list: 'string[]',
      rows: 'string[][]',
    },
    lifecycle: ['const ui = new Ui()', 'await ui.start()', 'await ui.wait()', 'ui.report(errorOrMessage)', 'ui.log.info("...")'],
  },
  go: {
    title: 'Go',
    style: 'pascal',
    ident: (t) => apiName(t, 'pascal'),
    access: (n) => `ui.${n}`,
    read: (p) => `.${apiMember(p, 'pascal')}()`,
    write: (p, v) => `.${apiMember(p, 'pascal', 'set')}(${v})`,
    event: (e, a) => `.${apiEventMethod(e, 'pascal')}(${a})`,
    state: (s) => `.${apiName(STATE_VERB[s as ApiState], 'pascal')}()`,
    types: {
      str: 'string',
      int: 'int',
      float: 'float64',
      bool: 'bool',
      str_list: '[]string',
      rows: '[][]string',
    },
    lifecycle: ['ui := NewUi()', 'func program(ui *Ui) { ... }', 'ui.Report(err)', 'ui.Log.Info("...")'],
  },
  rust: {
    title: 'Rust',
    style: 'snake',
    ident: (t) => safeIdent(t, 'rust'),
    access: (n) => `ui.${n}`,
    read: (p) => `.${p}()`,
    write: (p, v) => `.${apiMember(p, 'snake', 'set')}(${v})`,
    event: (e, a) => `.${apiEventMethod(e, 'snake')}(${a})`,
    state: (s) => `.${STATE_VERB[s as ApiState]}()`,
    types: {
      str: 'String',
      int: 'i64',
      float: 'f64',
      bool: 'bool',
      str_list: 'Vec<String>',
      rows: 'Vec<Vec<String>>',
    },
    lifecycle: ['fn program(ui: Ui) { ... }', 'ui.report(error_or_message)', 'ui.log().info("...")'],
  },
};

/** The flat `ui.api` methods of a component, as called in the language. */
function apiSection(h: ApiHandleModel, s: Style, api: string): string {
  const lines = [`### ${h.tag} (${h.type})`, ''];
  for (const m of methodsOf(h)) {
    const sig = m.kind === 'set' ? '(value)' : '()';
    lines.push(`- \`${api}.${apiName(m.name, s.style)}${sig}\`: ${m.doc}`);
  }
  return lines.join('\n');
}

function section(h: ApiHandleModel, s: Style): string {
  const name = s.access(s.ident(h.tag));
  const lines = [`### \`${name}\` (${h.type})`, ''];
  if (h.states.length > 1) {
    const verbs = h.states.map((st) => `\`${name}${s.state(st)}\``).join(', ');
    lines.push(`- states: ${verbs}`);
  }
  for (const p of h.properties) {
    const read = `${name}${s.read(p.name)}`;
    const write = `${name}${s.write(p.name, '…')}`;
    lines.push(`- property \`${p.name}\` (${s.types[p.type]}): read \`${read}\`, write \`${write}\``);
  }
  for (const e of h.events) {
    const handler = e.editorHandler ? `, the editor calls \`${e.editorHandler}\` too` : '';
    lines.push(`- event \`${e.name}\`: \`${name}${s.event(e.name, 'handler')}\`${handler}`);
  }
  if (lines.length === 2) lines.push('- only visibility: no properties or events');
  return lines.join('\n');
}

/** API.md for `framework`, or null when the design has no component with a code name. */
export function apiReference(project: IRProject, framework: string): string | null {
  const lang = FRAMEWORK_LANG[framework];
  if (!lang) return null;
  const s = STYLES[lang];
  const model = buildApiModel(project);
  if (model.handles.length === 0) return null;

  const out = [
    `# Program API (${s.title})`,
    '',
    'Generated by TUI Studio. Every component with a code name (Properties → Code name) is a member of `ui`;',
    'the names below are exactly what your program has to write. Rename a code name in the editor and export again.',
    'Writing a property never fires a change event; events mean "the user did this".',
    'The general rules (threading, states, errors, log) are in docs/PROGRAM_API.md of TUI Studio.',
    '',
    '## Lifecycle and helpers',
    '',
    ...s.lifecycle.map((l) => `- \`${l}\``),
    '',
    '## Api: `ui.api` (flat methods, one place for everything)',
    '',
    'Call these from your program. `*_was_*` is true once per user action since the last call;',
    '`*_set_*` changes the UI without firing an event.',
    '',
    model.handles.map((h) => apiSection(h, s, lang === 'go' ? 'ui.Api' : 'ui.api')).join('\n\n'),
    '',
    '## Handles: `ui.<code name>` (the same things, with handlers)',
    '',
    model.handles.map((h) => section(h, s)).join('\n\n'),
    '',
  ];
  if (lang === 'python' && model.screens.length) {
    out.push(
      '## Screens',
      '',
      ...model.screens.map((sc) => `- \`ui.${sc.tag}.show()\``),
      ''
    );
  }
  return out.join('\n');
}
