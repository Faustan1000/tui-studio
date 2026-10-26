// The `Api` class of an export: one place with a flat method per thing a program does with the
// UI ("was the button clicked?", "is the box checked?", "set the text", "hide the spinner").
// It is a thin layer over the handles (`ui.<code name>`), generated from the same model, and
// reachable as `ui.api`. Every exporter renders it through `renderFacade` so the method names
// are identical across frameworks (only the casing of the language differs).

import type { ApiHandleModel } from './model';
import { apiMember, apiName } from './model';
import type { ApiState, ApiValueType } from './spec';

export type FacadeLang = 'python' | 'ts' | 'js' | 'go' | 'rust';

export interface FacadeOptions {
  lang: FacadeLang;
  handles: readonly ApiHandleModel[];
  /** Member of `ui` that holds the handle, spelled as the exporter generated it (`nameInput`). */
  member: (h: ApiHandleModel) => string;
  /** TypeScript only: module that exports `Ui` (`./app`, `./index`). */
  uiModule?: string;
  /** Rust only: the typed handle struct of a component (`ButtonHandle`). */
  rustType?: (h: ApiHandleModel) => string;
}

export interface FacadeOutput {
  code: string;
  /** JavaScript only: the declaration file next to it. */
  types?: string;
}

type Case = 'snake' | 'camel' | 'pascal';
const CASE: Record<FacadeLang, Case> = {
  python: 'snake',
  ts: 'camel',
  js: 'camel',
  go: 'pascal',
  rust: 'snake',
};

const PAST: Record<string, string> = {
  click: 'clicked',
  change: 'changed',
  submit: 'submitted',
  select: 'selected',
};

const STATE_VERB: Partial<Record<ApiState, string>> = {
  muted: 'mute',
  readonly: 'readonly',
  hidden: 'hide',
};

// ── Neutral description of the methods ───────────────────────────────────────

type Kind = 'was' | 'get' | 'set' | 'state' | 'show' | 'isHidden' | 'open' | 'close' | 'isOpen';

interface Method {
  /** snake_case name, converted to the language's case when rendered. */
  name: string;
  kind: Kind;
  h: ApiHandleModel;
  doc: string;
  prop?: string;
  type?: ApiValueType;
  event?: string;
  state?: ApiState;
}

/** Everything the facade offers for one handle. */
export function methodsOf(h: ApiHandleModel): Method[] {
  const t = h.tag;
  const out: Method[] = [];
  for (const e of h.events) {
    const past = PAST[e.name] ?? `${e.name}ed`;
    out.push({
      name: `${t}_was_${past}`,
      kind: 'was',
      h,
      event: e.name,
      doc: `True once per "${e.name}" by the user since the last call.`,
    });
  }
  for (const p of h.properties) {
    out.push({
      name: p.type === 'bool' ? `${t}_is_${p.name}` : `${t}_${p.name}`,
      kind: 'get',
      h,
      prop: p.name,
      type: p.type,
      doc: `Current ${p.name} (what the user sees, including what was typed).`,
    });
    out.push({
      name: `${t}_set_${p.name}`,
      kind: 'set',
      h,
      prop: p.name,
      type: p.type,
      doc: `Change the ${p.name} on screen (fires no event).`,
    });
  }
  if (h.type === 'Modal') {
    out.push({ name: `${t}_open`, kind: 'open', h, doc: 'Show the dialog.' });
    out.push({ name: `${t}_close`, kind: 'close', h, doc: 'Close the dialog.' });
    out.push({ name: `${t}_is_open`, kind: 'isOpen', h, doc: 'Whether the dialog is open.' });
  }
  out.push({ name: `${t}_show`, kind: 'show', h, doc: 'Show it (normal state).' });
  for (const s of h.states) {
    const verb = STATE_VERB[s];
    if (!verb) continue;
    out.push({
      name: `${t}_${verb}`,
      kind: 'state',
      h,
      state: s,
      doc:
        s === 'hidden'
          ? 'Hide it (not shown, takes no space).'
          : s === 'muted'
            ? 'Dim it and ignore input.'
            : 'Show it, but the user cannot change it.',
    });
  }
  out.push({ name: `${t}_is_hidden`, kind: 'isHidden', h, doc: 'Whether it is hidden.' });
  return out;
}

/** Every method name of an export (for API.md and tests). */
export function facadeMethodNames(handles: readonly ApiHandleModel[], lang: FacadeLang): string[] {
  return handles.flatMap((h) => methodsOf(h).map((m) => apiName(m.name, CASE[lang])));
}

// ── Rendering ────────────────────────────────────────────────────────────────

const TYPES: Record<FacadeLang, Record<ApiValueType, string>> = {
  python: {
    str: 'str',
    int: 'int',
    float: 'float',
    bool: 'bool',
    str_list: 'List[str]',
    rows: 'List[List[str]]',
  },
  ts: {
    str: 'string',
    int: 'number',
    float: 'number',
    bool: 'boolean',
    str_list: 'string[]',
    rows: 'string[][]',
  },
  js: {
    str: 'string',
    int: 'number',
    float: 'number',
    bool: 'boolean',
    str_list: 'string[]',
    rows: 'string[][]',
  },
  go: {
    str: 'string',
    int: 'int',
    float: 'float64',
    bool: 'bool',
    str_list: '[]string',
    rows: '[][]string',
  },
  rust: {
    str: 'String',
    int: 'i64',
    float: 'f64',
    bool: 'bool',
    str_list: 'Vec<String>',
    rows: 'Vec<Vec<String>>',
  },
};

function pyStr(s: string): string {
  return JSON.stringify(s);
}

export function renderFacade(o: FacadeOptions): FacadeOutput {
  switch (o.lang) {
    case 'python':
      return { code: renderPython(o) };
    case 'ts':
      return { code: renderTs(o) };
    case 'js':
      return renderJs(o);
    case 'go':
      return { code: renderGo(o) };
    case 'rust':
      return { code: renderRust(o) };
  }
}

const HEADER =
  'Generated by TUI Studio. One method per thing the program does with the UI; the names follow the\ncode names of the components. Reach it as `ui.api`.';

function eventPairs(o: FacadeOptions): { h: ApiHandleModel; event: string }[] {
  return o.handles.flatMap((h) => h.events.map((e) => ({ h, event: e.name })));
}

// Python ----------------------------------------------------------------------

function renderPython(o: FacadeOptions): string {
  const T = TYPES.python;
  const L: string[] = [];
  L.push(
    `"""${HEADER.replace(/\n/g, ' ')}"""`,
    '',
    'import threading',
    'from typing import Any, Dict, List',
    '',
    '',
    'class Api:',
    '    """Flat methods over the components of the UI. Safe to call from any thread."""',
    '',
    '    def __init__(self, ui: Any) -> None:',
    '        self._ui = ui',
    '        self._lock = threading.Lock()',
    '        self._events: Dict[str, int] = {}'
  );
  for (const { h, event } of eventPairs(o)) {
    L.push(`        ui.${o.member(h)}.on_${event}(self._counter(${pyStr(`${h.tag}.${event}`)}))`);
  }
  L.push(
    '',
    '    def _counter(self, key: str):',
    '        def count() -> None:',
    '            with self._lock:',
    '                self._events[key] = self._events.get(key, 0) + 1',
    '',
    '        return count',
    '',
    '    def _take(self, key: str) -> bool:',
    '        with self._lock:',
    '            seen = self._events.pop(key, 0)',
    '        return seen > 0'
  );
  for (const h of o.handles) {
    const hm = `self._ui.${o.member(h)}`;
    for (const m of methodsOf(h)) {
      const name = apiName(m.name, 'snake');
      L.push('');
      switch (m.kind) {
        case 'was':
          L.push(
            `    def ${name}(self) -> bool:`,
            `        """${m.doc}"""`,
            `        return self._take(${pyStr(`${h.tag}.${m.event}`)})`
          );
          break;
        case 'get':
          L.push(
            `    def ${name}(self) -> ${T[m.type!]}:`,
            `        """${m.doc}"""`,
            `        return ${hm}.${m.prop}`
          );
          break;
        case 'set':
          L.push(
            `    def ${name}(self, value: ${T[m.type!]}) -> None:`,
            `        """${m.doc}"""`,
            `        ${hm}.${m.prop} = value`
          );
          break;
        case 'state':
        case 'show':
        case 'open':
        case 'close': {
          const call = m.kind === 'state' ? STATE_VERB[m.state!] : m.kind;
          L.push(`    def ${name}(self) -> None:`, `        """${m.doc}"""`, `        ${hm}.${call}()`);
          break;
        }
        case 'isHidden':
          L.push(
            `    def ${name}(self) -> bool:`,
            `        """${m.doc}"""`,
            `        return ${hm}.state == "hidden"`
          );
          break;
        case 'isOpen':
          L.push(`    def ${name}(self) -> bool:`, `        """${m.doc}"""`, `        return ${hm}.is_open`);
          break;
      }
    }
  }
  return L.join('\n') + '\n';
}

// TypeScript / JavaScript -------------------------------------------------------

function jsBody(o: FacadeOptions, m: Method): string {
  const hm = `this.ui.${o.member(m.h)}`;
  switch (m.kind) {
    case 'was':
      return `return this.take(${JSON.stringify(`${m.h.tag}.${m.event}`)});`;
    case 'get':
      return `return ${hm}.${apiMember(m.prop!, 'camel')};`;
    case 'set':
      return `${hm}.${apiMember(m.prop!, 'camel')} = value;`;
    case 'state':
      return `${hm}.${STATE_VERB[m.state!]}();`;
    case 'show':
      return `${hm}.show();`;
    case 'open':
      return `${hm}.open();`;
    case 'close':
      return `${hm}.close();`;
    case 'isHidden':
      return `return ${hm}.state === "hidden";`;
    case 'isOpen':
      return `return ${hm}.isOpen;`;
  }
}

function jsSignature(m: Method, lang: 'ts' | 'js'): { params: string; ret: string } {
  const T = TYPES[lang];
  const params = m.kind === 'set' ? `value: ${T[m.type!]}` : '';
  const ret =
    m.kind === 'was' || m.kind === 'isHidden' || m.kind === 'isOpen'
      ? 'boolean'
      : m.kind === 'get'
        ? T[m.type!]
        : 'void';
  return { params, ret };
}

function renderTs(o: FacadeOptions): string {
  const L: string[] = [
    `// ${HEADER.split('\n').join('\n// ')}`,
    '',
    `import type { Ui } from ${JSON.stringify(o.uiModule ?? './app')};`,
    '',
    '/** Flat methods over the components of the UI. */',
    'export class Api {',
    '  private readonly seen = new Map<string, number>();',
    '',
    '  constructor(private readonly ui: Ui) {',
  ];
  for (const { h, event } of eventPairs(o)) {
    L.push(
      `    ui.${o.member(h)}.${apiMember(event, 'camel', 'on')}(() => this.count(${JSON.stringify(`${h.tag}.${event}`)}));`
    );
  }
  L.push(
    '  }',
    '',
    '  private count(key: string): void {',
    '    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);',
    '  }',
    '',
    '  private take(key: string): boolean {',
    '    const n = this.seen.get(key) ?? 0;',
    '    this.seen.delete(key);',
    '    return n > 0;',
    '  }'
  );
  for (const h of o.handles) {
    for (const m of methodsOf(h)) {
      const { params, ret } = jsSignature(m, 'ts');
      L.push(
        '',
        `  /** ${m.doc} */`,
        `  ${apiName(m.name, 'camel')}(${params}): ${ret} {`,
        `    ${jsBody(o, m)}`,
        '  }'
      );
    }
  }
  L.push('}', '');
  return L.join('\n');
}

function renderJs(o: FacadeOptions): FacadeOutput {
  const L: string[] = [
    `// ${HEADER.split('\n').join('\n// ')}`,
    "'use strict';",
    '',
    '/** Flat methods over the components of the UI. */',
    'class Api {',
    '  constructor(ui) {',
    '    this.ui = ui;',
    '    this.seen = new Map();',
  ];
  for (const { h, event } of eventPairs(o)) {
    L.push(
      `    ui.${o.member(h)}.${apiMember(event, 'camel', 'on')}(() => this.count(${JSON.stringify(`${h.tag}.${event}`)}));`
    );
  }
  L.push(
    '  }',
    '',
    '  count(key) {',
    '    this.seen.set(key, (this.seen.get(key) || 0) + 1);',
    '  }',
    '',
    '  take(key) {',
    '    const n = this.seen.get(key) || 0;',
    '    this.seen.delete(key);',
    '    return n > 0;',
    '  }'
  );
  const D: string[] = [
    `// ${HEADER.split('\n').join('\n// ')}`,
    '',
    'export declare class Api {',
    '  constructor(ui: unknown);',
  ];
  for (const h of o.handles) {
    for (const m of methodsOf(h)) {
      const { params, ret } = jsSignature(m, 'js');
      const name = apiName(m.name, 'camel');
      L.push('', `  /** ${m.doc} */`, `  ${name}(${params.replace(/: [^,)]+/g, '')}) {`, `    ${jsBody(o, m)}`, '  }');
      D.push(`  /** ${m.doc} */`, `  ${name}(${params}): ${ret};`);
    }
  }
  L.push('}', '', 'module.exports = { Api };', '');
  D.push('}', '');
  return { code: L.join('\n'), types: D.join('\n') };
}

// Go -------------------------------------------------------------------------

function renderGo(o: FacadeOptions): string {
  const T = TYPES.go;
  const L: string[] = [
    `// ${HEADER.split('\n').join('\n// ')}`,
    '',
    'package main',
    '',
    'import (',
    '	"sync"',
    ')',
    '',
    '// Api is a flat set of methods over the components of the UI. Safe to call from any goroutine.',
    'type Api struct {',
    '\tui   *Ui',
    '\tmu   sync.Mutex',
    '\tseen map[string]int',
    '}',
    '',
    'func newApi(ui *Ui) *Api {',
    '\ta := &Api{ui: ui, seen: map[string]int{}}',
  ];
  for (const { h, event } of eventPairs(o)) {
    L.push(
      `\tui.${o.member(h)}.${apiMember(event, 'pascal', 'on')}(a.counter(${JSON.stringify(`${h.tag}.${event}`)}))`
    );
  }
  L.push(
    '\treturn a',
    '}',
    '',
    'func (a *Api) counter(key string) func(Event) {',
    '\treturn func(Event) {',
    '\t\ta.mu.Lock()',
    '\t\ta.seen[key]++',
    '\t\ta.mu.Unlock()',
    '\t}',
    '}',
    '',
    'func (a *Api) take(key string) bool {',
    '\ta.mu.Lock()',
    '\tdefer a.mu.Unlock()',
    '\tn := a.seen[key]',
    '\tdelete(a.seen, key)',
    '\treturn n > 0',
    '}'
  );
  for (const h of o.handles) {
    const hm = `a.ui.${o.member(h)}`;
    for (const m of methodsOf(h)) {
      const name = apiName(m.name, 'pascal');
      L.push('', `// ${name}: ${m.doc}`);
      switch (m.kind) {
        case 'was':
          L.push(
            `func (a *Api) ${name}() bool { return a.take(${JSON.stringify(`${h.tag}.${m.event}`)}) }`
          );
          break;
        case 'get':
          L.push(
            `func (a *Api) ${name}() ${T[m.type!]} { return ${hm}.${apiMember(m.prop!, 'pascal')}() }`
          );
          break;
        case 'set':
          L.push(
            `func (a *Api) ${name}(value ${T[m.type!]}) { ${hm}.${apiMember(m.prop!, 'pascal', 'set')}(value) }`
          );
          break;
        case 'state':
          L.push(
            `func (a *Api) ${name}() error { return ${hm}.${apiName(STATE_VERB[m.state!]!, 'pascal')}() }`
          );
          break;
        case 'show':
          L.push(`func (a *Api) ${name}() error { return ${hm}.Show() }`);
          break;
        case 'open':
          L.push(`func (a *Api) ${name}() { ${hm}.Open() }`);
          break;
        case 'close':
          L.push(`func (a *Api) ${name}() { ${hm}.Close() }`);
          break;
        case 'isHidden':
          L.push(`func (a *Api) ${name}() bool { return ${hm}.State() == StateHidden }`);
          break;
        case 'isOpen':
          L.push(`func (a *Api) ${name}() bool { return ${hm}.IsOpen() }`);
          break;
      }
    }
  }
  return L.join('\n') + '\n';
}

// Rust -----------------------------------------------------------------------

function renderRust(o: FacadeOptions): string {
  const T = TYPES.rust;
  const type = o.rustType!;
  const L: string[] = [
    `// ${HEADER.split('\n').join('\n// ')}`,
    '',
    '#![allow(dead_code)]',
    '',
    'use std::collections::HashMap;',
    'use std::sync::{Arc, Mutex};',
    '',
    '#[allow(unused_imports)]',
    'use crate::ui_runtime::*;',
    '',
    '/// A flat set of methods over the components of the UI. Safe to call from any thread.',
    '#[derive(Clone)]',
    'pub struct Api {',
    '    _events: Arc<Mutex<HashMap<&\'static str, usize>>>,',
  ];
  for (const h of o.handles) L.push(`    ${o.member(h)}: ${type(h)},`);
  L.push('}', '', 'impl Api {', '    pub(crate) fn new(rt: &Runtime) -> Api {');
  L.push('        let seen: Arc<Mutex<HashMap<&\'static str, usize>>> = Arc::default();');
  for (const h of o.handles) {
    L.push(`        let ${o.member(h)} = ${type(h)}::new(rt, ${JSON.stringify(h.tag)});`);
  }
  for (const { h, event } of eventPairs(o)) {
    const key = JSON.stringify(`${h.tag}.${event}`);
    L.push(
      `        {`,
      `            let seen = seen.clone();`,
      `            ${o.member(h)}.${apiMember(event, 'snake', 'on')}(move |_e: &Event| {`,
      `                *seen.lock().unwrap().entry(${key}).or_insert(0) += 1;`,
      `            });`,
      `        }`
    );
  }
  L.push('        Api {', '            _events: seen,');
  for (const h of o.handles) L.push(`            ${o.member(h)},`);
  L.push(
    '        }',
    '    }',
    '',
    '    fn take(&self, key: &str) -> bool {',
    '        self._events.lock().unwrap().remove(key).unwrap_or(0) > 0',
    '    }'
  );
  for (const h of o.handles) {
    const hm = `self.${o.member(h)}`;
    for (const m of methodsOf(h)) {
      const name = apiName(m.name, 'snake');
      L.push('', `    /// ${m.doc}`);
      switch (m.kind) {
        case 'was':
          L.push(
            `    pub fn ${name}(&self) -> bool {`,
            `        self.take(${JSON.stringify(`${h.tag}.${m.event}`)})`,
            '    }'
          );
          break;
        case 'get':
          L.push(`    pub fn ${name}(&self) -> ${T[m.type!]} {`, `        ${hm}.${m.prop}()`, '    }');
          break;
        case 'set':
          L.push(
            `    pub fn ${name}(&self, value: ${T[m.type!]}) {`,
            `        ${hm}.${apiMember(m.prop!, 'snake', 'set')}(value);`,
            '    }'
          );
          break;
        case 'state':
          L.push(
            `    pub fn ${name}(&self) -> Result<(), UiError> {`,
            `        ${hm}.${STATE_VERB[m.state!]}()`,
            '    }'
          );
          break;
        case 'show':
          L.push(`    pub fn ${name}(&self) -> Result<(), UiError> {`, `        ${hm}.show()`, '    }');
          break;
        case 'open':
        case 'close':
          L.push(`    pub fn ${name}(&self) {`, `        ${hm}.${m.kind}();`, '    }');
          break;
        case 'isHidden':
          L.push(
            `    pub fn ${name}(&self) -> bool {`,
            `        ${hm}.state() == State::Hidden`,
            '    }'
          );
          break;
        case 'isOpen':
          L.push(`    pub fn ${name}(&self) -> bool {`, `        ${hm}.is_open()`, '    }');
          break;
      }
    }
  }
  L.push('}', '');
  return L.join('\n');
}
