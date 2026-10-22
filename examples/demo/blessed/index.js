// Demo - terminal UI exported from TUI Studio (Blessed).
//
// Run:    npm install && npm start      (Node.js 14 or newer; terminal of at least 80x24 cells)
// Keys:   Tab / Shift-Tab move the focus, Enter / Space activate, q or Ctrl-C quit,
//         Esc closes an open dropdown or modal. In a text field Enter or Esc leaves the field.
//         Ctrl+L shows the log panel; errors open a dialog (Enter or Esc closes it).
//
// Program API: components with a code name are members of `ui` (see ui-runtime.js):
//   const { Ui } = require("./index");  const ui = new Ui();  await ui.start();
//   ui.status.text = "..."; ui.submitBtn.onClick((e) => ...); ui.nameInput.readonly();
//
// Layout: SNAPSHOT. Every widget is placed at the cell position and size the editor computed for the
//         design size 80x24. left/top are relative to the parent's outer box
//         (autoPadding is off, so a parent's border does not shift its children). The layout does
//         not reflow when the terminal is resized, and hidden widgets leave their space empty.
// Limits: blessed only knows "line" and "bg" borders (double, rounded and bold are drawn as line),
//         and has no italic or strikethrough.
'use strict';

const blessed = require('blessed');
const { Handle, StudioUi } = require('./ui-runtime');

// ── Event handlers: fill these in ─────────────────────────────────────────────

/** Called with the widget that fired the event, then the event arguments. */
function handleChange(widget, ...args) {
  // TODO: your code
}

/** Called with the widget that fired the event, then the event arguments. */
function handleClick(widget, ...args) {
  // TODO: your code
}

/** Called with the widget that fired the event, then the event arguments. */
function handleSelect(widget, ...args) {
  // TODO: your code
}

// ── The UI ────────────────────────────────────────────────────────────────────

class Ui extends StudioUi {
  constructor(options) {
    super(options);
    this._title = "Demo";
    /** Text: Text */
    this.status = new Handle(this, "status", {
      type: "Text",
      states: ["active","hidden"],
      state: "active",
      props: {"text":{"type":"str","value":"Ready"}},
      events: [],
    });
    /** TextInput: Text Input */
    this.nameInput = new Handle(this, "name_input", {
      type: "TextInput",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"value":{"type":"str","value":""},"placeholder":{"type":"str","value":"your name"}},
      events: ["change","submit"],
    });
    /** Button: Button */
    this.submitBtn = new Handle(this, "submit_btn", {
      type: "Button",
      states: ["active","muted","hidden"],
      state: "active",
      props: {"label":{"type":"str","value":"Send"}},
      events: ["click"],
    });
    /** Checkbox: Checkbox */
    this.agree = new Handle(this, "agree", {
      type: "Checkbox",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"checked":{"type":"bool","value":false},"label":{"type":"str","value":"I agree"}},
      events: ["change"],
    });
    /** Select: Select */
    this.color = new Handle(this, "color", {
      type: "Select",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"value":{"type":"str","value":""},"options":{"type":"str_list","value":["Red","Green","Blue"]}},
      events: ["change"],
    });
    /** ProgressBar: Progress Bar */
    this.progress = new Handle(this, "progress", {
      type: "ProgressBar",
      states: ["active","muted","hidden"],
      state: "active",
      props: {"value":{"type":"float","value":0},"max":{"type":"float","value":100}},
      events: [],
    });
    /** Table: Table */
    this.results = new Handle(this, "results", {
      type: "Table",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"columns":{"type":"str_list","value":["Column 1","Column 2"]},"rows":{"type":"rows","value":[["Cell 1","Cell 2"],["Cell 3","Cell 4"]]}},
      events: [],
    });
    /** List: List */
    this.files = new Handle(this, "files", {
      type: "List",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"items":{"type":"str_list","value":["Item 1","Item 2","Item 3"]},"selected":{"type":"int","value":0}},
      events: ["select"],
    });
    /** Tabs: Tabs */
    this.pages = new Handle(this, "pages", {
      type: "Tabs",
      states: ["active","muted","readonly","hidden"],
      state: "active",
      props: {"activeTab":{"type":"int","value":0}},
      events: ["change"],
    });
    /** Box: Box */
    this.panel = new Handle(this, "panel", {
      type: "Box",
      states: ["active","hidden"],
      state: "active",
      props: {},
      events: [],
    });
    /** Text: Text */
    this.inner = new Handle(this, "inner", {
      type: "Text",
      states: ["active","hidden"],
      state: "active",
      props: {"text":{"type":"str","value":"Inside the panel"}},
      events: [],
    });
    /** Modal: Modal */
    this.confirm = new Handle(this, "confirm", {
      type: "Modal",
      states: ["active","hidden"],
      state: "active",
      props: {"title":{"type":"str","value":"Sure?"}},
      events: [],
    });
  }

  /** Creates the widgets (called by start()). */
  _build(screen) {
    const ui = this;
        // Screen: Demo
        const demo = blessed.box({
          parent: screen,
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" } },
        });
        const demoInner = blessed.scrollablebox({
          parent: screen,
          left: 2,
          top: 2,
          width: '100%-4',
          height: '100%-4',
          tags: false,
          style: { fg: "#f8f8f2" },
        });
        ui.wire(demo, "Screen", { inner: demoInner }, null);

        ui.viewport(demo, demoInner, 31);

        // Text: Text
        const status = blessed.box({
          parent: demoInner,
          left: 0,
          top: 0,
          width: 5,
          height: 1,
          tags: false,
          style: { fg: "#f8f8f2" },
          content: "Ready",
          align: "left",
          wrap: false,
        });
        ui.wire(status, "Text", {  }, ui.status);

        // TextInput: Text Input
        const nameInput = ui.textbox({
          parent: demoInner,
          left: 0,
          top: 1,
          width: 20,
          height: 3,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" }, focus: { border: { fg: "#5fafff" } } },
          inputOnFocus: true,
          mouse: true,
          keys: true,
          padding: { left: 2 },
        });
        nameInput.on('keypress', () => setImmediate(() => handleChange(nameInput, nameInput.getValue())));
        ui.wire(nameInput, "TextInput", { placeholder: "your name", focusable: true }, ui.nameInput);

        // Button: Button
        const submitBtn = blessed.button({
          parent: demoInner,
          left: 0,
          top: 4,
          width: 16,
          height: 3,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", bold: true, border: { fg: "#f8f8f2" }, focus: { border: { fg: "#5fafff" } } },
          content: "Send",
          align: 'center',
          mouse: true,
          keys: true,
        });
        ui.rounded(submitBtn);
        submitBtn.on("press", () => handleClick(submitBtn));
        ui.wire(submitBtn, "Button", { prefix: "", suffix: "", focusable: true }, ui.submitBtn);

        // Checkbox: Checkbox
        const agree = blessed.checkbox({
          parent: demoInner,
          left: 0,
          top: 7,
          width: 11,
          height: 1,
          tags: false,
          style: { fg: "#f8f8f2", focus: { bold: true, underline: true } },
          text: "I agree",
          checked: false,
          mouse: true,
          keys: true,
        });
        ['check', 'uncheck'].forEach((ev) => agree.on(ev, () => handleChange(agree, agree.checked)));
        ui.wire(agree, "Checkbox", { on: "[✓]", off: "[ ]", focusable: true }, ui.agree);

        // Select: Select
        const color = blessed.box({
          parent: demoInner,
          left: 0,
          top: 8,
          width: '100%',
          height: 3,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" }, focus: { border: { fg: "#5fafff" } } },
          content: "Red ▾",
          wrap: false,
          keyable: true,
          mouse: true,
        });
        ui.wire(color, "Select", { options: ["Red","Green","Blue"], value: "Red", focusable: true, chevron: true, onChange: (value, index) => { handleChange(color, value, index); } }, ui.color);

        // ProgressBar: Progress Bar
        const progress = blessed.box({
          parent: demoInner,
          left: 0,
          top: 11,
          width: 20,
          height: 3,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" } },
          wrap: false,
        });
        ui.wire(progress, "ProgressBar", { value: 0, max: 100 }, ui.progress);

        // Table: Table
        const results = blessed.listtable({
          parent: demoInner,
          left: 0,
          top: 14,
          width: 22,
          height: 5,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" }, header: { bold: true }, cell: { fg: "#f8f8f2", selected: { bold: true, inverse: true } }, focus: { border: { fg: "#5fafff" } } },
          padding: { left: 1 },
          rows: [["Column 1","Column 2"],["Cell 1","Cell 2"],["Cell 3","Cell 4"]],
          align: 'left',
          noCellBorders: true,
          keys: true,
          mouse: true,
          interactive: true,
        });
        ui.wire(results, "Table", { columns: ["Column 1","Column 2"], rows: [["Cell 1","Cell 2"],["Cell 3","Cell 4"]], focusable: true, indent: 1 }, ui.results);

        // List: List
        const files = blessed.list({
          parent: demoInner,
          left: 0,
          top: 19,
          width: '100%',
          height: 5,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" }, selected: { bold: true, inverse: true }, focus: { border: { fg: "#5fafff" } } },
          items: ["Item 1", "Item 2", "Item 3"],
          keys: true,
          mouse: true,
          interactive: true,
        });
        files.on("select", (item, index) => handleSelect(files, index));
        ui.wire(files, "List", { items: ["Item 1", "Item 2", "Item 3"], focusable: true }, ui.files);

        // Tabs: Tabs
        const pages = blessed.listbar({
          parent: demoInner,
          left: 0,
          top: 24,
          width: '100%',
          height: 2,
          tags: false,
          style: { fg: "#f8f8f2", item: {}, selected: { bold: true, inverse: true }, focus: { bold: true, underline: true } },
          keys: true,
          mouse: true,
          autoCommandKeys: false,
          commands: [
            { text: "⌂ Dashboard", prefix: '' },
            { text: "Agent ● ^1", prefix: '' },
            { text: "QA Team ^2", prefix: '' },
          ],
        });
        ui.nest(pages);
        ui.wire(pages, "Tabs", { tabs: ["⌂ Dashboard", "Agent ● ^1", "QA Team ^2"], focusable: true, underline: true }, ui.pages);

        // Box: Box
        const panel = blessed.box({
          parent: demoInner,
          left: 0,
          top: 26,
          width: 20,
          height: 5,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", border: { fg: "#f8f8f2" } },
        });
        const panelInner = blessed.scrollablebox({
          parent: demoInner,
          left: 2,
          top: 28,
          width: 16,
          height: 1,
          tags: false,
          style: { fg: "#f8f8f2" },
        });
        ui.wire(panel, "Box", { inner: panelInner }, ui.panel);

        // Text: Text
        const inner = blessed.box({
          parent: panelInner,
          left: 0,
          top: 0,
          width: 16,
          height: 1,
          tags: false,
          style: { fg: "#f8f8f2" },
          content: "Inside the panel",
          align: "left",
          wrap: false,
        });
        ui.wire(inner, "Text", {  }, ui.inner);

        // Modal: Modal
        const confirm = blessed.box({
          parent: screen,
          left: 'center',
          top: 'center',
          width: 40,
          height: 12,
          tags: false,
          border: { type: 'line' },
          style: { fg: "#f8f8f2", bg: "#21222c", border: { fg: "#f8f8f2" } },
          label: " Sure? ",
          hidden: true,
          clickable: true,
        });
        const confirmInner = blessed.scrollablebox({
          parent: confirm,
          left: 1,
          top: 1,
          width: 38,
          height: 10,
          tags: false,
          style: { fg: "#f8f8f2", bg: "#21222c" },
        });
        ui.wire(confirm, "Modal", { inner: confirmInner }, ui.confirm);

        // Text: Text
        const text = blessed.box({
          parent: confirmInner,
          left: 1,
          top: 1,
          width: 7,
          height: 1,
          tags: false,
          style: { fg: "#f8f8f2" },
          content: "Really?",
          align: "left",
          wrap: false,
        });
  }
}

module.exports = { Ui };

if (require.main === module) {
  const ui = new Ui();
  ui.installExcepthooks();
  ui.run().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
