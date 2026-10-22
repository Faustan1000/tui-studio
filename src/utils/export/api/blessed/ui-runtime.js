// Runtime for user interfaces exported from TUI Studio (Blessed).
//
// This file is generated and identical for every export - do not edit it, edit your own
// program instead. It lets your program drive the UI without blocking it:
//
//   const { Ui } = require('./index');
//   const ui = new Ui();
//   await ui.start();                       // creates the screen, returns when it is ready
//   ui.submitBtn.onClick((event) => ...);   // events (handlers run asynchronously)
//   ui.status.text = 'Ready';               // properties (writing never fires a change event)
//   ui.nameInput.readonly();                // states: active / mute / readonly / hide
//   ui.report('Connection lost');           // opens an error dialog and goes to the log
//   await ui.wait();                        // until the UI is closed
//
// Every component with a code name in the editor is a member of `ui`.
// Architecture: every handle keeps the state of its component (the store); the blessed widgets
// are views that follow the store. The user's input updates the store and emits events, the
// program's writes update the store and the views without emitting anything.

'use strict';

const blessed = require('blessed');

const NL = String.fromCharCode(10);
const STATES = ['active', 'muted', 'readonly', 'hidden'];
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };
const DIM = '#808080';
const HINT = '#808080';
const FOCUS = '#5fafff';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class UiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UiError';
  }
}

function clone(v) {
  return Array.isArray(v) ? v.map(clone) : v;
}

function coerce(type, v) {
  switch (type) {
    case 'str':
      return v == null ? '' : String(v);
    case 'int':
      return Math.round(Number(v)) || 0;
    case 'float':
      return Number(v) || 0;
    case 'bool':
      return !!v;
    case 'str_list':
      return Array.from(v || [], (x) => String(x));
    case 'rows':
      return Array.from(v || [], (r) => Array.from(r || [], (x) => String(x)));
    default:
      return v;
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Make the text of a widget that has `tags: true` (listbar items) safe. */
function escapeTags(s) {
  return blessed.escape(String(s));
}

// ── Handles ───────────────────────────────────────────────────────────────────

/**
 * One component of the UI. States, properties and events come from the generated `Ui`:
 * `options.props` is `{ name: { type, value } }`, `options.events` a list of event names.
 */
class Handle {
  constructor(ui, tag, options) {
    const o = options || {};
    Object.defineProperties(this, {
      _ui: { value: ui },
      _views: { value: [] },
      _values: { value: {} },
      _dirty: { value: new Set() },
      _states: { value: o.states || ['active', 'hidden'] },
      _open: { value: false, writable: true },
    });
    this.tag = tag;
    this.type = o.type || '';
    this._state = o.state || 'active';
    for (const name of Object.keys(o.props || {})) this._defineProp(name, o.props[name].type, o.props[name].value);
    for (const name of o.events || []) {
      this['on' + cap(name)] = (fn) => {
        if (typeof fn !== 'function') throw new UiError('The handler of ' + tag + '.on' + cap(name) + ' must be a function');
        ui._addCallback(tag, name, fn);
        return fn;
      };
    }
    if (this.type === 'Modal') {
      Object.defineProperty(this, 'isOpen', { enumerable: true, get: () => this._open });
    }
    ui._register(this);
  }

  /** One of "active", "muted", "readonly", "hidden". */
  get state() {
    return this._state;
  }

  set state(value) {
    this._setState(value);
  }

  /** Normal: visible and usable. */
  active() {
    this._setState('active');
  }

  /** Visible but dimmed and not usable. */
  mute() {
    this._setState('muted');
  }

  /** Shows its value normally but the user cannot change it. */
  readonly() {
    this._setState('readonly');
  }

  hide() {
    this._setState('hidden');
  }

  /** Same as `active()`. */
  show() {
    this._setState('active');
  }

  /** Modal: show it on top of the UI. */
  open() {
    if (this.type !== 'Modal') throw new UiError(this.tag + ' is not a Modal');
    this._open = true;
    this._views.forEach((v) => v.setOpen(true));
    this._ui._touch();
  }

  /** Modal: close it. */
  close() {
    if (this.type !== 'Modal') throw new UiError(this.tag + ' is not a Modal');
    this._open = false;
    this._views.forEach((v) => v.setOpen(false));
    this._ui._touch();
  }

  toString() {
    return '<' + (this.type || 'Handle') + ' ' + this.tag + ' state=' + this._state + '>';
  }

  _setState(value) {
    if (!STATES.includes(value)) {
      throw new UiError('Unknown state ' + JSON.stringify(value) + '; use one of ' + STATES.join(', '));
    }
    if (!this._states.includes(value)) {
      throw new UiError(
        this.tag + ' (' + this.type + ') does not support ' + JSON.stringify(value) + '; supported: ' + this._states.join(', ')
      );
    }
    this._state = value;
    this._views.forEach((v) => v.setState(value));
    this._ui._stateChanged();
  }

  _defineProp(name, type, initial) {
    this._values[name] = coerce(type, initial);
    Object.defineProperty(this, name, {
      enumerable: true,
      get: () => clone(this._values[name]),
      set: (v) => {
        const value = coerce(type, v);
        this._values[name] = value;
        this._dirty.add(name);
        this._views.forEach((view) => view.apply(name, clone(value)));
        this._ui._touch();
      },
    });
  }

  _bind(view) {
    this._views.push(view);
    view.handle = this;
    view.widget._handle = this;
    const dirty = {};
    for (const name of this._dirty) dirty[name] = clone(this._values[name]);
    view.pull(dirty);
    view.setState(this._state);
    if (this.type === 'Modal') view.setOpen(this._open);
  }

  _canEdit() {
    return this._state === 'active';
  }
}

// ── Views: blessed widgets that follow a handle ──────────────────────────────

/** Dim a widget (muted) or restore it. */
function dim(widget, on) {
  const st = widget.style;
  if (!st) return;
  if (on) {
    if (!widget._dimmed) {
      widget._dimmed = { fg: st.fg, bold: st.bold, border: st.border ? st.border.fg : null, itemFg: st.item ? st.item.fg : null };
    }
    st.fg = DIM;
    st.bold = false;
    if (st.border) st.border.fg = DIM;
    if (st.item) st.item.fg = DIM;
  } else if (widget._dimmed) {
    const d = widget._dimmed;
    st.fg = d.fg;
    st.bold = d.bold;
    if (st.border) st.border.fg = d.border;
    if (st.item) st.item.fg = d.itemFg;
    widget._dimmed = null;
  }
}

class View {
  constructor(ui, widget, opts, handle) {
    this.ui = ui;
    this.widget = widget;
    this.opts = opts || {};
    this.handle = handle || null;
    widget._view = this;
    widget._handle = handle || null;
  }

  /** The user may change the value (a muted, readonly or hidden component ignores input). */
  canEdit() {
    return (!this.handle || this.handle._canEdit()) && !this.ui._covered(this.widget);
  }

  /** Report a user interaction (store first, then the event). */
  userEvent(name, value, store) {
    if (this.handle && store) this.handle._values[store] = value;
    if (this.ui._quiet || !this.canEdit()) return;
    this.ui._emit(this.handle ? this.handle.tag : '', name, value, !this.handle);
  }

  /** Programmatic change: nothing the widget does in here counts as the user's. */
  quietly(fn) {
    return this.ui._silent(fn);
  }

  pull(values) {
    for (const name of Object.keys(values)) this.apply(name, values[name]);
  }

  apply() {}

  /** The widget and the inner box next to it (containers with a frame). */
  parts() {
    return this.opts.inner ? [this.widget, this.opts.inner] : [this.widget];
  }

  setState(state) {
    for (const part of this.parts()) {
      if (state === 'hidden') part.hide();
      else part.show();
    }
    dim(this.widget, state === 'muted');
    this.stateChanged(state);
  }

  stateChanged() {}

  setOpen() {}
}

class TextView extends View {
  apply(name, value) {
    if (name !== 'text') return;
    this.widget.setContent(value);
    // A text is as wide as its content (the width was measured for the design's own text).
    const NL = String.fromCharCode(10);
    const widest = Math.max(1, ...String(value).split(NL).map((l) => l.length));
    this.widget.width = widest + (this.widget.border ? 2 : 0);
  }
}

class SpinnerView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.label = opts.label || 'Loading...';
    this.frame = 0;
    const timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.draw();
      ui._touch();
    }, 80);
    if (timer.unref) timer.unref();
    ui._timers.add(timer);
  }

  draw() {
    this.widget.setContent(SPINNER_FRAMES[this.frame] + ' ' + this.label);
  }

  apply(name, value) {
    if (name === 'label') {
      this.label = value;
      this.draw();
    }
  }
}

class ButtonView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    const proto = Object.getPrototypeOf(widget);
    const view = this;
    widget.press = function () {
      if (!view.canEdit()) return null;
      return proto.press.call(this);
    };
    widget.on('press', () => this.userEvent('click'));
  }

  apply(name, value) {
    if (name === 'label') this.widget.setContent((this.opts.prefix || '') + value + (this.opts.suffix || ''));
  }
}

class InputView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.placeholder = opts.placeholder || '';
    this.fg = widget.style.fg;
    this.shown = false;
    this.last = widget.value || '';
    widget.on('focus', () => {
      if (!this.shown) return;
      this.shown = false;
      widget.clearValue();
      widget.style.fg = this.fg;
    });
    widget.on('keypress', () => setImmediate(() => this.sync()));
    widget.on('submit', () => {
      this.sync();
      this.userEvent('submit', this.read());
      this.restore();
    });
    widget.on('cancel', () => this.restore());
    this.restore();
  }

  /** What the user sees as the value (not the placeholder). */
  read() {
    return this.shown ? '' : widget_value(this.widget);
  }

  sync() {
    const v = this.read();
    if (v === this.last) return;
    this.last = v;
    this.userEvent('change', v, 'value');
  }

  restore() {
    if (this.read() === '' && this.placeholder) {
      this.shown = true;
      this.widget.setValue(this.placeholder);
      this.widget.style.fg = HINT;
    } else {
      this.shown = false;
      this.widget.style.fg = this.fg;
    }
    this.ui._touch();
  }

  apply(name, value) {
    if (name === 'value') {
      this.shown = false;
      this.widget.style.fg = this.fg;
      this.widget.setValue(value);
      this.last = value;
      if (value === '') this.restore();
    } else if (name === 'placeholder') {
      this.placeholder = value;
      if (this.shown || this.read() === '') this.restore();
    }
  }

  stateChanged() {
    const w = this.widget;
    if (w._reading && !this.canEdit() && w.cancel) w.cancel();
  }
}

function widget_value(w) {
  return typeof w.getValue === 'function' ? w.getValue() : w.value || '';
}

class CheckView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    const proto = Object.getPrototypeOf(widget);
    const view = this;
    for (const name of ['check', 'uncheck', 'toggle']) {
      widget[name] = function () {
        if (!view.canEdit()) return null;
        return proto[name].call(this);
      };
    }
    const on = opts.on != null ? opts.on : '[x]';
    const off = opts.off != null ? opts.off : '[ ]';
    widget.render = function () {
      this.clearPos(true);
      this.setContent((this.checked ? on : off) + ' ' + this.text, true);
      return this._render();
    };
    widget.on('check', () => this.userEvent('change', true, 'checked'));
    widget.on('uncheck', () => this.userEvent('change', false, 'checked'));
  }

  apply(name, value) {
    const w = this.widget;
    if (name === 'label') {
      w.text = value;
    } else if (name === 'checked') {
      const proto = Object.getPrototypeOf(w);
      this.quietly(() => (value ? proto.check.call(w) : proto.uncheck.call(w)));
    }
  }
}

/**
 * blessed selects a list row with the first click and reports `select` only for the second;
 * a click should choose the row at once.
 */
function clickChooses(widget, allowed) {
  let fired = false;
  widget.on('select', () => {
    fired = true;
    setImmediate(() => {
      fired = false;
    });
  });
  widget.on('element click', (el) => {
    const i = widget.items ? widget.items.indexOf(el) : -1;
    if (i < 0 || fired || !allowed()) return;
    widget.emit('select', el, i);
  });
}

/** Select: a closed box that opens a list of options below it. */
class SelectView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.options = clone(opts.options || []);
    this.value = opts.value != null ? opts.value : this.options[0] || '';
    this.popup = null;
    this.onChange = opts.onChange;
    widget.key(['enter', 'space'], () => this.open());
    widget.on('click', () => this.open());
    if (opts.chevron) {
      // The value on the left, the arrow at the right edge (follows the width of the widget).
      const render = widget.render;
      const view = this;
      widget.render = function () {
        view.draw();
        return render.apply(this, arguments);
      };
      this.draw();
    }
  }

  draw() {
    const w = this.widget;
    if (!this.opts.chevron) {
      w.setContent(this.value + ' ' + String.fromCharCode(0x25be));
      return;
    }
    const inner = Math.max(0, w.width - (w.border ? 2 : 0));
    const head = '  ' + this.value;
    const tail = String.fromCharCode(0x25bc) + '  ';
    const text = head + ' '.repeat(Math.max(1, inner - head.length - tail.length)) + tail;
    if (text !== this._text) {
      this._text = text;
      w.setContent(text, true);
    }
  }

  ensurePopup() {
    if (this.popup) return this.popup;
    const box = this.widget;
    const popup = blessed.list({
      parent: this.ui.screen,
      hidden: true,
      tags: false,
      keys: true,
      mouse: true,
      items: this.options,
      border: { type: 'line' },
      width: box.width,
      height: Math.min(Math.max(this.options.length, 1), 8) + 2,
      style: { fg: box.style.fg, bg: box.style.bg, border: box.style.border, selected: { bold: true, inverse: true } },
    });
    popup.on('select', (item, index) => {
      const value = this.options[index];
      this.close();
      if (value == null) return;
      const changed = value !== this.value;
      this.value = value;
      this.draw();
      if (changed) {
        this.userEvent('change', value, 'value');
        if (this.onChange) this.onChange(value, index);
      }
      this.ui._touch();
    });
    popup.key(['escape'], () => this.close());
    clickChooses(popup, () => true);
    this.popup = popup;
    return popup;
  }

  open() {
    if (!this.canEdit() || this.ui._closed) return;
    const popup = this.ensurePopup();
    const box = this.widget;
    // lpos is where the box is drawn (scrolled); aleft/atop are its design position.
    popup.left = box.lpos ? box.lpos.xi : box.aleft;
    popup.top = (box.lpos ? box.lpos.yi : box.atop) + box.height;
    popup.setItems(this.options);
    popup.show();
    popup.setFront();
    popup.select(Math.max(0, this.options.indexOf(this.value)));
    popup.focus();
    this.ui._overlays++;
    this.ui._touch();
  }

  close() {
    if (!this.popup || this.popup.hidden) return;
    this.ui._overlays--;
    this.popup.hide();
    this.widget.focus();
    this.ui._touch();
  }

  apply(name, value) {
    if (name === 'value') {
      this.value = value;
      this.draw();
    } else if (name === 'options') {
      this.options = value;
      if (this.popup) this.popup.setItems(value);
    }
  }

  stateChanged() {
    if (!this.canEdit() && this.popup && !this.popup.hidden) this.close();
  }
}

class ProgressView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.vals = { value: opts.value || 0, max: opts.max || 100 };
    // The row follows the width of the widget, so it is drawn right before every render.
    widget.on('prerender', () => this.draw());
  }

  draw() {
    const max = this.vals.max || 100;
    const ratio = Math.max(0, Math.min(1, this.vals.value / max));
    const inner = Math.max(1, this.widget.width - (this.widget.border ? 2 : 0));
    const room = Math.max(1, inner - 5);
    const filled = Math.round(ratio * room);
    this.filled = Math.round(ratio * 100);
    this.widget.setContent(
      '█'.repeat(filled) + '░'.repeat(room - filled) + (this.filled + '%').padStart(5)
    );
  }

  apply(name, value) {
    this.vals[name] = value;
    this.draw();
  }
}

class TableView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.vals = { columns: clone(opts.columns || []), rows: clone(opts.rows || []) };
    guardSelect(this);
    if (opts.indent) {
      // The table is drawn indented (padding): the last column gives up the room it takes.
      const calc = widget._calculateMaxes;
      widget._calculateMaxes = function () {
        const m = calc.call(this);
        if (m && m.length) m[m.length - 1] = Math.max(1, m[m.length - 1] - opts.indent);
        return m;
      };
      widget.setRows(widget.rows);
    }
  }

  apply(name, value) {
    this.vals[name] = value;
    this.widget.setRows([this.vals.columns].concat(this.vals.rows));
  }
}

/** The user cannot move the selection of a list or table while it is muted or readonly. */
function guardSelect(view) {
  const w = view.widget;
  const proto = Object.getPrototypeOf(w);
  w.select = function (index) {
    if (!view.programmatic && !view.canEdit()) return null;
    return proto.select.call(this, index);
  };
}

class ListView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.items = clone(opts.items || []);
    this.programmatic = false;
    // The wheel scrolls the page, not the selection of the list under the pointer.
    widget.removeAllListeners('wheeldown');
    widget.removeAllListeners('wheelup');
    guardSelect(this);
    widget.on('select item', (item, index) => {
      if (this.handle) this.handle._values.selected = index;
    });
    widget.on('select', (item, index) => {
      this.userEvent('select', opts.byLabel ? this.items[index] : index);
    });
    clickChooses(widget, () => this.canEdit());
  }

  apply(name, value) {
    this.programmatic = true;
    try {
      if (name === 'items') {
        this.items = value;
        this.widget.setItems(value);
        const sel = this.handle ? this.handle._values.selected : 0;
        if (value.length) this.widget.select(Math.min(sel || 0, value.length - 1));
      } else if (name === 'selected') {
        this.widget.select(value);
      }
    } finally {
      this.programmatic = false;
    }
  }
}

class TabsView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.programmatic = false;
    guardSelect(this);
    const labels = opts.tabs || [];
    // blessed's listbar scrolls its tabs: selecting one that it thinks does not fit hides every
    // tab before it. A tab bar must keep all tabs in place (the widget clips what is too wide).
    widget.select = function select(offset) {
      if (typeof offset !== 'number') offset = this.items.indexOf(offset);
      offset = Math.max(0, Math.min(offset, this.items.length - 1));
      this.leftBase = 0;
      this.leftOffset = offset;
      if (this.items[offset]) this.emit('select item', this.items[offset], offset);
    };
    widget.commands.forEach((cmd, i) => {
      cmd.callback = () => {
        if (!this.canEdit()) return;
        this.userEvent('change', i, 'activeTab');
        if (opts.onChange) opts.onChange(i);
      };
      // blessed prefixes every tab with "1:"; the design shows the label only.
      const el = widget.items[i];
      if (el && labels[i] != null) el.setContent(escapeTags(labels[i]));
    });
    if (opts.underline) this.underline(labels);
  }

  /**
   * Tabs side by side (one cell of padding on both sides of every label) with a rule below:
   * the active tab is marked by a heavier piece of it.
   */
  underline(labels) {
    const widget = this.widget;
    const line = blessed.box({
      parent: widget,
      left: 0,
      top: 1,
      width: '100%',
      height: 1,
      tags: false,
      style: { fg: widget.style.fg },
    });
    const widths = labels.map((l) => [...l].length + 2);
    widget.render = function () {
      let x = 0;
      this.items.forEach((el, i) => {
        el.width = widths[i];
        el.rleft = x;
        x += widths[i];
        el.show();
      });
      const total = Math.max(0, this.width);
      const cells = new Array(total).fill('━');
      let start = 0;
      for (let i = 0; i < widths.length; i++) {
        if (i === this.selected && widths[i] >= 2) {
          if (start < total) cells[start] = '╸';
          if (start + widths[i] - 1 < total) cells[start + widths[i] - 1] = '╺';
        }
        start += widths[i];
      }
      line.setContent(cells.join(''), true);
      return this._render();
    };
  }

  apply(name, value) {
    if (name !== 'activeTab') return;
    this.programmatic = true;
    try {
      this.widget.select(value);
    } finally {
      this.programmatic = false;
    }
  }
}

class ContainerView extends View {}

class ModalView extends View {
  constructor(ui, widget, opts, handle) {
    super(ui, widget, opts, handle);
    this.open = !widget.hidden;
    ui._modals.push(this);
  }

  setOpen(open) {
    this.open = open;
    this.sync();
    if (open) this.widget.setFront();
  }

  setState() {
    this.sync();
  }

  sync() {
    const hidden = this.handle && this.handle._state === 'hidden';
    for (const part of this.parts()) {
      if (this.open && !hidden) part.show();
      else part.hide();
    }
  }

  apply(name, value) {
    if (name === 'title' && this.widget.setLabel) this.widget.setLabel(' ' + value + ' ');
  }
}

const VIEWS = {
  Text: TextView,
  Breadcrumb: TextView,
  Spinner: SpinnerView,
  Button: ButtonView,
  TextInput: InputView,
  Checkbox: CheckView,
  Toggle: CheckView,
  Radio: CheckView,
  Select: SelectView,
  ProgressBar: ProgressView,
  Table: TableView,
  List: ListView,
  Menu: ListView,
  Tree: ListView,
  Tabs: TabsView,
  Box: ContainerView,
  Grid: ContainerView,
  Screen: ContainerView,
  Modal: ModalView,
};

// ── The UI ────────────────────────────────────────────────────────────────────

/** Base class of the generated `Ui`: lifecycle, events, errors and the log. */
class StudioUi {
  /**
   * @param {object} [options] extra options for `blessed.screen` (for example `input`, `output`
   *   and `terminal` to run headless in tests).
   */
  constructor(options) {
    this._options = options || {};
    this._handles = new Map();
    this._callbacks = new Map();
    this._queue = [];
    this._waiters = [];
    this._closeWaiters = [];
    this._timers = new Set();
    this._focusables = [];
    this._modals = [];
    this._overlays = 0;
    this._quiet = 0;
    this._renderPending = false;
    this._ready = false;
    this._closed = false;
    this._seen = 0;
    this._dialog = null;
    this._logPanel = null;
    this._history = [];
    this.screen = null;
    /** Reported errors and exceptions, oldest first. */
    this.errors = [];
    this.log = {
      debug: (m) => this.report(String(m), { level: 'debug' }),
      info: (m) => this.report(String(m), { level: 'info' }),
      warning: (m) => this.report(String(m), { level: 'warning' }),
      error: (m) => this.report(String(m), { level: 'error' }),
    };
  }

  // -- lifecycle -------------------------------------------------------------

  get ready() {
    return this._ready;
  }

  get running() {
    return this._ready && !this._closed;
  }

  /** Create the screen and show the UI. Returns (a promise) when it is ready; never blocks. */
  start() {
    if (this.screen) return Promise.reject(new UiError('The UI was already started'));
    const base = {
      smartCSR: true,
      fullUnicode: true,
      autoPadding: false,
      ignoreLocked: ['C-c', 'C-l'],
      title: this._title || 'TUI',
    };
    try {
      this.screen = blessed.screen(Object.assign(base, this._options));
      this._build(this.screen);
      this._installKeys();
      this._enableMouse();
      this._installScrollKeys();
      this._layoutScroll();
      this._ready = true;
      this._ensureFocus();
      this.screen.render();
      this._flushHistory();
    } catch (err) {
      this._finish();
      return Promise.reject(err);
    }
    return Promise.resolve(this);
  }

  /** `start()`, then run `main(ui)` asynchronously and wait until the UI is closed. */
  async run(main) {
    await this.start();
    if (main) {
      setImmediate(() => {
        Promise.resolve()
          .then(() => main(this))
          .catch((err) => this.report(err, { source: 'main' }));
      });
    }
    await this.wait();
  }

  /** Close the UI. */
  stop() {
    if (this._closed) return;
    this._finish();
  }

  /** Resolves when the UI is closed. */
  wait() {
    if (this._closed) return Promise.resolve();
    return new Promise((resolve) => this._closeWaiters.push(resolve));
  }

  _finish() {
    if (this._closed) return;
    this._closed = true;
    this._ready = this._ready && true;
    for (const t of this._timers) clearInterval(t);
    this._timers.clear();
    try {
      if (this.screen) this.screen.destroy();
    } catch (err) {
      this.errors.push({ time: Date.now(), level: 'critical', message: String(err), details: '', source: 'ui' });
    }
    this._waiters.splice(0).forEach((w) => w.resolve(null));
    this._closeWaiters.splice(0).forEach((r) => r());
  }

  // -- components ------------------------------------------------------------

  _register(handle) {
    if (this._handles.has(handle.tag)) throw new UiError('Duplicate code name ' + JSON.stringify(handle.tag));
    this._handles.set(handle.tag, handle);
  }

  /** The handle of a code name: `ui.get('submit_btn')`. */
  get(tag) {
    const h = this._handles.get(tag);
    if (!h) throw new UiError('No component with the code name ' + JSON.stringify(tag));
    return h;
  }

  /** `ui.on('submit_btn', 'click', fn)` is the same as `ui.submitBtn.onClick(fn)`. */
  on(tag, name, fn) {
    this.get(tag);
    this._addCallback(tag, name, fn);
    return fn;
  }

  /** Connect a widget (created by the generated code) with its view and its handle. */
  wire(widget, type, opts, handle) {
    const View_ = VIEWS[type] || View;
    const view = new View_(this, widget, opts || {}, null);
    if (opts && opts.focusable) {
      this._focusables.push(widget);
      widget.on('focus', () => this.scrollIntoView(widget));
    }
    if (handle) handle._bind(view);
    return view;
  }

  /** A textbox that only starts reading input while its component is active. */
  textbox(options) {
    const proto = blessed.textbox.prototype;
    const el = Object.create(proto);
    el.readInput = function (callback) {
      const view = this._view;
      if (view ? !view.canEdit() : this._handle && !this._handle._canEdit()) return null;
      return proto.readInput.call(this, callback);
    };
    blessed.textbox.call(el, options);
    return el;
  }

  /**
   * Draw the border of a widget with rounded corners (blessed only knows square ones): after
   * the widget is drawn the four corner cells are replaced.
   */
  rounded(widget) {
    const render = widget.render;
    widget.render = function () {
      const c = render.apply(this, arguments);
      if (!c || !this.screen) return c;
      const lines = this.screen.lines;
      const put = (y, x, from, to) => {
        const row = lines[y];
        if (row && row[x] && row[x][1] === from) {
          row[x][1] = to;
          row.dirty = true;
        }
      };
      put(c.yi, c.xi, '┌', '╭');
      put(c.yi, c.xl - 1, '┐', '╮');
      put(c.yl - 1, c.xi, '└', '╰');
      put(c.yl - 1, c.xl - 1, '┘', '╯');
      return c;
    };
  }

  _silent(fn) {
    this._quiet++;
    try {
      return fn();
    } finally {
      this._quiet--;
    }
  }

  _touch() {
    if (this._renderPending || !this.screen || this._closed) return;
    this._renderPending = true;
    setImmediate(() => {
      this._renderPending = false;
      if (!this._closed) this.screen.render();
    });
  }

  _stateChanged() {
    this._ensureFocus();
    this._touch();
  }

  // -- focus and keys ----------------------------------------------------------

  /** A widget behind the error dialog or an open modal does not react (clicks included). */
  _covered(w) {
    const inside = (root) => {
      for (let e = w; e; e = e.parent) if (e === root) return true;
      return false;
    };
    if (this._dialog && !this._dialog.hidden && !inside(this._dialog)) return true;
    for (const m of this._modals) {
      if (m.handle && m.open && !m.widget.hidden && !inside(m.widget)) return true;
    }
    return false;
  }

  _canFocus(w) {
    if (!w.visible) return false;
    const h = w._handle;
    return !h || (h.state !== 'muted' && h.state !== 'hidden');
  }

  focusNext(step) {
    const list = this._focusables;
    if (!list.length) return;
    let i = list.indexOf(this.screen.focused);
    for (let n = 0; n < list.length; n++) {
      i = (i + step + list.length) % list.length;
      if (this._canFocus(list[i])) {
        list[i].focus();
        this.screen.render();
        return;
      }
    }
  }

  _ensureFocus() {
    if (!this.screen || !this._focusables.length) return;
    const f = this.screen.focused;
    if (f && this._focusables.includes(f) && this._canFocus(f)) return;
    // Leave the focus alone while a dialog or a popup has it; a container having it is no focus.
    if (this._overlays > 0 || (f && f.type === 'textbox' && f._reading)) return;
    // Start on something that is not a text field: a focused text field swallows the q key.
    const ok = this._focusables.filter((w) => this._canFocus(w));
    const target = ok.find((w) => w.type !== 'textbox') || ok[0];
    if (target) target.focus();
  }

  _installKeys() {
    const s = this.screen;
    s.key(['q', 'C-c'], (ch, key) => {
      if (key && key.full !== 'C-c' && this._overlays > 0) return;
      this.stop();
    });
    s.key(['escape'], () => {
      if (this._overlays > 0) return;
      for (let i = this._modals.length - 1; i >= 0; i--) {
        const m = this._modals[i];
        if (m.open && m.widget.visible) {
          if (m.handle) m.handle.close();
          else m.setOpen(false);
          this._touch();
          return;
        }
      }
      this.stop();
    });
    s.key(['tab'], () => {
      if (!this._overlays) this.focusNext(1);
    });
    s.key(['S-tab'], () => {
      if (!this._overlays) this.focusNext(-1);
    });
    s.key(['C-l'], () => this._toggleLog());
  }

  /**
   * Mouse: blessed picks the terminal mouse mode from the terminal name, which finds nothing for
   * unknown names (Windows, for example), so the modes are set explicitly: button events and
   * SGR coordinates are understood by every current terminal.
   */
  _enableMouse() {
    const s = this.screen;
    s.enableMouse();
    s.program.setMouse({ vt200Mouse: true, sgrMouse: true, cellMotion: true }, true);
  }

  /**
   * Mark a widget that is no scrollable box but has children (radio group, tab bar): blessed
   * only looks at the nearest scrollable ancestor, so it must count as one.
   */
  nest(widget) {
    widget.scrollable = true;
    widget.childBase = 0;
    widget.childOffset = 0;
  }

  // -- scrolling ---------------------------------------------------------------

  /**
   * The design lives in `inner`, a borderless blessed scrollable box (the viewport) inside the
   * frame of the root: scrolling sets its `childBase`, its children keep their snapshot
   * positions and blessed clips them at its edges. The dialogs, the log, the popups and
   * modals opened by the program belong to the screen and stay put.
   * @param {object|null} frame the bordered root widget (null when the root has no border)
   * @param {object} inner the viewport
   * @param {number} bottom the first row below the design (relative to the viewport)
   */
  viewport(frame, inner, bottom) {
    const bar = blessed.box({
      parent: frame || inner,
      fixed: true,
      left: '100%-1',
      top: frame ? 1 : 0,
      width: 1,
      height: 1,
      hidden: true,
      tags: false,
      ch: String.fromCharCode(0x2588),
      style: { fg: FOCUS },
    });
    this._vp = { frame, inner, bottom, offset: 0, bar };
  }

  /** How far the design is scrolled (rows). */
  get scrollOffset() {
    return this._vp ? this._vp.offset : 0;
  }

  /** The largest scroll offset: 0 when the design fits in the terminal. */
  get scrollMax() {
    const vp = this._vp;
    return vp ? Math.max(0, vp.bottom - vp.inner.height) : 0;
  }

  scrollTo(offset) {
    const vp = this._vp;
    if (!vp || this._closed) return;
    vp.offset = Math.min(Math.max(Math.round(offset), 0), this.scrollMax);
    this._layoutScroll();
  }

  scrollBy(rows) {
    this.scrollTo(this.scrollOffset + rows);
  }

  _layoutScroll() {
    const vp = this._vp;
    if (!vp) return;
    const max = this.scrollMax;
    vp.offset = Math.min(Math.max(vp.offset, 0), max);
    vp.inner.childBase = vp.offset;
    if (max > 0) {
      const len = Math.max(1, vp.inner.height);
      const total = Math.max(1, vp.bottom);
      const thumb = Math.max(1, Math.min(len, Math.round((len * len) / total)));
      vp.bar.top = (vp.frame ? 1 : 0) + Math.round(((len - thumb) * vp.offset) / max);
      vp.bar.height = thumb;
      vp.bar.show();
    } else {
      vp.bar.hide();
    }
    this._touch();
  }

  /** Scroll so that the (part of the) widget is visible. */
  scrollIntoView(w) {
    const vp = this._vp;
    if (!vp || !this.screen) return;
    let inside = false;
    for (let e = w; e; e = e.parent) if (e === vp.inner) inside = true;
    if (!inside) return;
    const view = vp.inner.height;
    // `atop` is the design position (blessed does not include the scroll in it).
    const y = w.atop - vp.inner.atop;
    const h = w.height;
    let off = vp.offset;
    if (y < off) off = y;
    else if (y + h > off + view) off = Math.min(y, y + h - view);
    if (off !== vp.offset) this.scrollTo(off);
  }

  _installScrollKeys() {
    const s = this.screen;
    const listy = () => {
      const f = s.focused;
      return !!f && (f.type === 'list' || f.type === 'list-table' || f.type === 'listbar');
    };
    const page = () => Math.max(1, this._vp.inner.height - 1);
    const when = (names, fn) =>
      s.key(names, () => {
        if (this._overlays > 0 || !this._vp || listy()) return;
        fn();
      });
    when(['pageup'], () => this.scrollBy(-page()));
    when(['pagedown'], () => this.scrollBy(page()));
    when(['home'], () => this.scrollTo(0));
    when(['end'], () => this.scrollTo(this.scrollMax));
    s.on('wheeldown', () => {
      if (!this._overlays) this.scrollBy(3);
    });
    s.on('wheelup', () => {
      if (!this._overlays) this.scrollBy(-3);
    });
    s.on('resize', () => this._layoutScroll());
  }

  // -- events ------------------------------------------------------------------

  _addCallback(tag, name, fn) {
    const k = tag + ' ' + name;
    if (!this._callbacks.has(k)) this._callbacks.set(k, []);
    this._callbacks.get(k).push(fn);
  }

  _emit(tag, name, value) {
    if (!tag) return;
    const event = { tag, name, value, time: Date.now() / 1000 };
    const waiter = this._waiters.shift();
    if (waiter) waiter.resolve(event);
    else {
      this._queue.push(event);
      if (this._queue.length > 1000) this._queue.shift();
    }
    for (const fn of (this._callbacks.get(tag + ' ' + name) || []).slice()) {
      setImmediate(() => this._runCallback(fn, event));
    }
  }

  _runCallback(fn, event) {
    const fail = (err) => this.report(err, { source: event.tag + '.on' + cap(event.name) });
    try {
      const r = fn(event);
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (err) {
      fail(err);
    }
  }

  /** The next user interaction of any component; resolves to null after `timeout` seconds. */
  nextEvent(timeout) {
    const queued = this._queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this._closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve };
      this._waiters.push(waiter);
      if (timeout != null) {
        setTimeout(() => {
          const i = this._waiters.indexOf(waiter);
          if (i >= 0) {
            this._waiters.splice(i, 1);
            resolve(null);
          }
        }, timeout * 1000).unref();
      }
    });
  }

  // -- errors and log ------------------------------------------------------------

  /**
   * Report an error: it goes to the log and, for errors, opens the error dialog.
   * @param {Error|string} error
   * @param {{level?: string, source?: string}} [options]
   */
  report(error, options) {
    const o = options || {};
    const level = LEVELS[o.level] ? o.level : 'error';
    let message;
    let details = '';
    if (error instanceof Error) {
      message = error.message ? error.name + ': ' + error.message : error.name;
      details = error.stack || '';
    } else {
      message = String(error);
    }
    const entry = { time: Date.now() / 1000, level, message, details, source: o.source || '' };
    this._history.push(entry);
    if (this._history.length > 1000) this._history.shift();
    if (LEVELS[level] >= LEVELS.error) {
      this.errors.push(entry);
      if (this.errors.length > 500) this.errors.shift();
    }
    if (!this.screen || this._closed) return;
    try {
      this._logWrite(entry);
      if (LEVELS[level] >= LEVELS.error) this._showError();
      this._touch();
    } catch (err) {
      // Never report a failure of the error display through the error display.
      this.errors.push({ time: Date.now() / 1000, level: 'critical', message: 'Error display failed: ' + err, details: '', source: 'ui' });
    }
  }

  /** Report uncaught exceptions and rejected promises of your own program. */
  installExcepthooks() {
    process.on('uncaughtException', (err) => this.report(err, { source: 'uncaughtException' }));
    process.on('unhandledRejection', (err) => this.report(err instanceof Error ? err : String(err), { source: 'unhandledRejection' }));
  }

  _flushHistory() {
    if (this._logPanel) this._logRefresh();
  }

  _logLines() {
    return this._history.slice(-200).map((e) => '[' + e.level + '] ' + (e.source ? e.source + ': ' : '') + e.message);
  }

  _ensureLogPanel() {
    if (this._logPanel) return this._logPanel;
    this._logPanel = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 8,
      hidden: true,
      tags: false,
      clickable: true,
      scrollable: true,
      alwaysScroll: true,
      border: { type: 'line' },
      label: ' Log (Ctrl+L) ',
      style: { fg: 'white', bg: 'black', border: { fg: FOCUS } },
    });
    return this._logPanel;
  }

  _logRefresh() {
    const p = this._logPanel;
    if (!p) return;
    p.setContent(this._logLines().join(NL));
    p.setScrollPerc(100);
  }

  _logWrite() {
    if (this._logPanel && !this._logPanel.hidden) this._logRefresh();
  }

  _toggleLog() {
    const p = this._ensureLogPanel();
    if (p.hidden) {
      this._logRefresh();
      p.show();
      p.setFront();
    } else {
      p.hide();
    }
    this._touch();
  }

  _showError() {
    const unseen = this.errors.slice(this._seen > this.errors.length ? 0 : this._seen);
    const shown = unseen.slice(-4);
    const lines = [];
    shown.forEach((e) => {
      lines.push(e.message);
      lines.push('');
    });
    if (unseen.length > shown.length) lines.push('+' + (unseen.length - shown.length) + ' more');
    lines.push('Enter / Esc: close    Ctrl+L: log');
    const width = Math.max(24, Math.min(70, (this.screen.width || 80) - 4));
    const height = Math.min(lines.length + 2, Math.max(5, (this.screen.height || 24) - 2));
    if (!this._dialog) {
      this._dialog = blessed.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        hidden: true,
        tags: false,
        keys: true,
        clickable: true,
        scrollable: true,
        border: { type: 'line' },
        label: ' Error ',
        style: { fg: 'white', bg: 'black', border: { fg: '#ff5f5f' } },
      });
      this._dialog.key(['enter', 'escape'], () => this._closeError());
    }
    const d = this._dialog;
    d.width = width;
    d.height = height;
    d.setContent(lines.join(NL));
    if (d.hidden) {
      this._prevFocus = this.screen.focused;
      this._overlays++;
      d.show();
    }
    d.setFront();
    d.focus();
  }

  _closeError() {
    const d = this._dialog;
    if (!d || d.hidden) return;
    this._seen = this.errors.length;
    d.hide();
    this._overlays--;
    if (this._prevFocus && this._prevFocus.focus) this._prevFocus.focus();
    this._touch();
  }
}

module.exports = {
  UiError,
  Handle,
  StudioUi,
  STATES,
};
