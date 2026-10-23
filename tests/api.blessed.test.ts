// The API scenario (docs/API_SCENARIO.md, S1..S14) against REAL blessed, headless: the generated
// project is written to tests/runtime/.generated/blessed/api and loaded; blessed renders into a
// PassThrough stream, keys are fed through the input stream and frames are read from the
// screen buffer.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents } from './fixtures/designs';
import { apiDesign } from './fixtures/apiDesign';
import {
  HAS_BLESSED,
  SKIP_REASON,
  click,
  frame,
  loadProject,
  makeTerm,
  resize,
  tick,
  wheel,
} from './helpers/blessedHeadless';

const ENTER = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const CTRL_L = String.fromCharCode(12);
const widgetOf = (h: any) => h._views[0].widget;

describe.skipIf(!HAS_BLESSED)(
  `blessed program API against real blessed${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    let ui: any;
    let term: ReturnType<typeof makeTerm>;
    let mod: any;
    const seen = () => frame(ui.screen);
    const focus = async (h: any) => {
      widgetOf(h).focus();
      await tick(40);
    };
    const drain = async () => {
      while (await ui.nextEvent(0.02)) {
        /* drain */
      }
    };

    beforeAll(() => {
      mod = loadProject(apiDesign(), 'api').mod;
      term = makeTerm(80, 50);
    });

    afterAll(() => {
      if (ui) ui.stop();
    });

    it('S1 start() returns when ready', async () => {
      ui = new mod.Ui(term.options);
      expect(ui.ready).toBe(false);
      await ui.start();
      expect(ui.ready).toBe(true);
      expect(ui.running).toBe(true);
      await expect(ui.start()).rejects.toThrow(/already started/);
      await tick(50);
      expect(seen()).toContain('Ready');
    });

    it('S2 initial properties and states equal the design', () => {
      expect(ui.status.text).toBe('Ready');
      expect(ui.progress.max).toBe(100);
      expect(ui.nameInput.placeholder).toBe('your name');
      expect(ui.nameInput.value).toBe('');
      expect(ui.agree.checked).toBe(false);
      expect(ui.color.options).toEqual(['Red', 'Green', 'Blue']);
      expect(ui.results.columns[0]).toBe('Column 1');
      expect(ui.files.items).toContain('Item 1');
      expect(ui.pages.activeTab).toBe(0);
      for (const h of [ui.status, ui.submitBtn, ui.nameInput, ui.panel]) {
        expect(h.state).toBe('active');
      }
      expect(ui.confirm.isOpen).toBe(false);
      expect(seen()).toContain('your name');
      expect(seen()).not.toContain('Really?');
    });

    it('S3 writes are readable at once and shown by the next frame', async () => {
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          ui.status.text = 'Working';
          ui.progress.value = 50;
          ui.nameInput.value = 'Bob';
          expect(ui.status.text).toBe('Working');
          expect(ui.progress.value).toBe(50);
          expect(ui.nameInput.value).toBe('Bob');
          resolve();
        })
      );
      await tick(50);
      const f = seen();
      expect(f).toContain('Working');
      expect(f).toContain('Bob');
      expect(f).not.toContain('your name');
      // Half of the bar is filled.
      expect(f).toMatch(/█{6,7}░{6,7} +50%/);
      ui.nameInput.value = '';
      await tick(30);
      expect(seen()).toContain('your name');
    });

    it('a text keeps its designed width when a shorter one is written and grows for a longer one', async () => {
      const widget = ui.status._views[0].widget;
      const designed = 'Ready'.length; // the design's own text
      ui.status.text = 'Hi';
      await tick(30);
      expect(widget.width).toBe(designed);
      ui.status.text = 'A much longer status text';
      await tick(30);
      expect(widget.width).toBe(25);
      ui.status.text = 'Ready';
      await tick(30);
      expect(widget.width).toBe(designed);
    });

    it('S4 a muted button is still drawn but fires nothing', async () => {
      const clicks: any[] = [];
      ui.submitBtn.onClick((e: any) => clicks.push(e));
      ui.submitBtn.mute();
      await tick(30);
      expect(ui.submitBtn.state).toBe('muted');
      expect(seen()).toContain('Send');
      expect(widgetOf(ui.submitBtn).style.fg).toBe('#808080');
      widgetOf(ui.submitBtn).focus();
      await term.type(ENTER);
      widgetOf(ui.submitBtn).press();
      await tick(40);
      expect(clicks).toHaveLength(0);
      expect(await ui.nextEvent(0.05)).toBeNull();
      ui.submitBtn.active();
      expect(widgetOf(ui.submitBtn).style.fg).not.toBe('#808080');
    });

    it('S5 hide() removes the text from the frame, show() brings it back', async () => {
      ui.panel.hide();
      await tick(40);
      expect(ui.panel.state).toBe('hidden');
      expect(seen()).not.toContain('Inside the panel');
      ui.panel.show();
      await tick(40);
      expect(seen()).toContain('Inside the panel');
    });

    it('S6 readonly ignores typing, active accepts it', async () => {
      await drain();
      ui.nameInput.readonly();
      await focus(ui.nameInput);
      await term.type('abc');
      expect(ui.nameInput.value).toBe('');
      expect(await ui.nextEvent(0.05)).toBeNull();
      ui.nameInput.active();
      await focus(ui.submitBtn);
      await focus(ui.nameInput);
      await term.type('abc');
      await tick(40);
      expect(ui.nameInput.value).toBe('abc');
      expect(seen()).toContain('abc');
      const e = await ui.nextEvent(0.2);
      expect(e).toMatchObject({ tag: 'name_input', name: 'change' });
      await term.type(ENTER);
      await tick(40);
    });

    it('S7 an unsupported state is an error and changes nothing', () => {
      expect(() => ui.submitBtn.readonly()).toThrow(/does not support/);
      expect(ui.submitBtn.state).toBe('active');
      expect(() => (ui.status.state = 'nonsense')).toThrow(/Unknown state/);
    });

    it('S8 user input fires handlers asynchronously with {tag, name, value}', async () => {
      await drain();
      const got: any[] = [];
      let inside = false;
      let syncCall = false;
      ui.submitBtn.onClick((e: any) => {
        if (inside) syncCall = true;
        got.push(e);
      });
      ui.nameInput.onChange((e: any) => got.push(e));
      ui.agree.onChange((e: any) => got.push(e));
      await focus(ui.submitBtn);
      inside = true;
      widgetOf(ui.submitBtn).press();
      inside = false;
      expect(got).toHaveLength(0); // never inside the UI call
      await tick(40);
      expect(syncCall).toBe(false);
      expect(got[0]).toMatchObject({ tag: 'submit_btn', name: 'click' });
      await focus(ui.nameInput);
      await term.type('Zed');
      await term.type(ENTER); // leaving a text field: Enter submits it
      await tick(40);
      await focus(ui.agree);
      await term.type(' ');
      await tick(40);
      expect(ui.agree.checked).toBe(true);
      expect(got.at(-1)).toMatchObject({ tag: 'agree', name: 'change', value: true });
      expect(got.some((e) => e.tag === 'name_input' && e.name === 'change')).toBe(true);
      const queue: any[] = [];
      for (let e = await ui.nextEvent(0.05); e; e = await ui.nextEvent(0.05)) queue.push(e);
      expect(queue.map((e) => e.tag)).toEqual(
        expect.arrayContaining(['submit_btn', 'name_input', 'agree'])
      );
      expect(queue[0]).toMatchObject({ tag: 'submit_btn', name: 'click' });
      expect(typeof queue[0].time).toBe('number');
    });

    it('S9 the program writing a value fires no change event (no echo)', async () => {
      await drain();
      const changes: any[] = [];
      ui.agree.onChange((e: any) => changes.push(e));
      ui.agree.checked = false;
      ui.agree.checked = true;
      ui.nameInput.value = 'written';
      ui.color.value = 'Blue';
      ui.pages.activeTab = 1;
      ui.files.selected = 1;
      await tick(60);
      expect(changes).toHaveLength(0);
      expect(await ui.nextEvent(0.05)).toBeNull();
      expect(ui.agree.checked).toBe(true);
      expect(seen()).toContain('[✓] I agree');
      expect(seen()).toContain('Blue');
      ui.nameInput.value = '';
    });

    it('S10 report() opens a dialog; Enter or Esc closes it', async () => {
      ui.report('boom');
      await tick(60);
      expect(seen()).toContain('boom');
      expect(ui.errors.at(-1).message).toBe('boom');
      await term.type(ENTER);
      await tick(60);
      expect(seen()).not.toContain('boom');
      ui.report('again');
      await tick(60);
      expect(seen()).toContain('again');
      await term.type(ESC);
      await tick(250);
      expect(seen()).not.toContain('again');
      expect(ui.running).toBe(true);
    });

    it('S11 a throwing handler is reported and the UI keeps running', async () => {
      ui.submitBtn.onClick(() => {
        throw new Error('handler exploded');
      });
      await focus(ui.submitBtn);
      widgetOf(ui.submitBtn).press();
      await tick(80);
      expect(ui.errors.some((e: any) => e.message.includes('handler exploded'))).toBe(true);
      expect(seen()).toContain('handler exploded');
      await term.type(ENTER);
      await tick(40);
      expect(ui.running).toBe(true);
      ui.status.text = 'still alive';
      await tick(40);
      expect(seen()).toContain('still alive');
    });

    it('S12 log.info and Ctrl+L toggle the log panel', async () => {
      ui.log.info('hello log');
      await tick(30);
      expect(seen()).not.toContain('hello log');
      await term.type(CTRL_L);
      expect(seen()).toContain('hello log');
      await term.type(CTRL_L);
      expect(seen()).not.toContain('hello log');
      // Errors are in the log as well.
      await term.type(CTRL_L);
      expect(seen()).toContain('[error]');
      await term.type(CTRL_L);
    });

    it('S13 a modal opens and closes', async () => {
      ui.confirm.open();
      await tick(40);
      expect(ui.confirm.isOpen).toBe(true);
      expect(seen()).toContain('Really?');
      expect(seen()).toContain('Sure?');
      ui.confirm.title = 'Changed';
      await tick(30);
      expect(seen()).toContain('Changed');
      ui.confirm.close();
      await tick(40);
      expect(ui.confirm.isOpen).toBe(false);
      expect(seen()).not.toContain('Really?');
      ui.confirm.open();
      await tick(30);
      await term.type(ESC);
      await tick(250);
      expect(ui.confirm.isOpen).toBe(false);
    });

    it('S14 stop() ends wait(); later calls do not throw', async () => {
      await drain();
      ui.stop();
      await ui.wait();
      expect(ui.running).toBe(false);
      expect(() => {
        ui.status.text = 'late';
        ui.submitBtn.mute();
        ui.panel.hide();
        ui.report('too late');
        ui.log.info('x');
        ui.stop();
      }).not.toThrow();
      expect(await ui.nextEvent(0.02)).toBeNull();
    });
  }
);

// ── S15: the mouse ────────────────────────────────────────────────────────────

describe.skipIf(!HAS_BLESSED)(
  `blessed program API: mouse (S15)${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    const started: any[] = [];
    afterAll(() => started.forEach((u) => u.stop()));

    async function boot(root: ComponentNode, name: string, options: Record<string, unknown> = {}) {
      const { mod } = loadProject(root, name);
      const term = makeTerm(100, 60);
      const ui = new mod.Ui({ ...term.options, ...options });
      started.push(ui);
      await ui.start();
      await tick(40);
      return { ui, term };
    }
    /** Click the widget (positions come from blessed itself). */
    const clickOn = (term: ReturnType<typeof makeTerm>, el: any) =>
      click(term, el.aleft + Math.min(2, el.width - 1), el.atop + Math.min(1, el.height - 1));
    const events = (ui: any, tag: string, name: string) => {
      const got: any[] = [];
      ui.on(tag, name, (e: any) => got.push(e));
      return got;
    };

    it('clicks every interactive component of the API design', async () => {
      const { ui, term } = await boot(apiDesign(), 'mouse');
      const seen = () => frame(ui.screen);
      // Button
      const clicks = events(ui, 'submit_btn', 'click');
      await clickOn(term, widgetOf(ui.submitBtn));
      expect(clicks).toHaveLength(1);
      // Checkbox
      const changes = events(ui, 'agree', 'change');
      await clickOn(term, widgetOf(ui.agree));
      expect(ui.agree.checked).toBe(true);
      expect(changes.at(-1)).toMatchObject({ tag: 'agree', name: 'change', value: true });
      expect(seen()).toContain('[✓] I agree');
      await clickOn(term, widgetOf(ui.agree));
      expect(ui.agree.checked).toBe(false);
      // Text field: a click focuses it and starts input
      const typed = events(ui, 'name_input', 'change');
      await clickOn(term, widgetOf(ui.nameInput));
      expect(widgetOf(ui.nameInput)._reading).toBe(true);
      await tick(40);
      await term.type('Zed');
      await tick(40);
      expect(ui.nameInput.value).toBe('Zed');
      expect(typed.at(-1)).toMatchObject({ tag: 'name_input', name: 'change', value: 'Zed' });
      await term.type(ENTER);
      // Select: open, click an option
      const picked = events(ui, 'color', 'change');
      await clickOn(term, widgetOf(ui.color));
      const popup = ui.color._views[0].popup;
      expect(popup.hidden).toBe(false);
      await click(term, popup.aleft + 2, popup.atop + 1 + 1);
      expect(ui.color.value).toBe('Green');
      expect(picked).toMatchObject([{ tag: 'color', name: 'change', value: 'Green' }]);
      expect(popup.hidden).toBe(true);
      // List row
      const rows = events(ui, 'files', 'select');
      const list = widgetOf(ui.files);
      await click(term, list.aleft + 3, list.atop + 1 + 1);
      expect(ui.files.selected).toBe(1);
      expect(rows.at(-1)).toMatchObject({ tag: 'files', name: 'select', value: 1 });
      // Tab
      const tabs = events(ui, 'pages', 'change');
      const second = widgetOf(ui.pages).items[1];
      await click(term, second.aleft + 1, second.atop);
      expect(tabs.at(-1)).toMatchObject({ tag: 'pages', name: 'change', value: 1 });
      expect(ui.pages.activeTab).toBe(1);
      // Selecting a tab never hides the tabs before it, whichever one is clicked.
      const bar = widgetOf(ui.pages);
      for (const i of [bar.items.length - 1, 0, 1]) {
        await click(term, bar.items[i].aleft + 1, bar.items[i].atop);
        expect(ui.pages.activeTab).toBe(i);
        expect(bar.items.map((el: any) => !el.hidden)).toEqual(bar.items.map(() => true));
        for (const c of bar.commands) expect(seen()).toContain(c.text);
      }
      // The table shows all its rows (an automatic height follows the content).
      expect(widgetOf(ui.results).height).toBeGreaterThanOrEqual(ui.results.rows.length + 3);
      expect(seen()).toContain('Cell 1');
    });

    it('a muted, readonly or hidden component ignores clicks', async () => {
      const { ui, term } = await boot(apiDesign(), 'mouse-states');
      const clicks = events(ui, 'submit_btn', 'click');
      const changes = events(ui, 'agree', 'change');
      const typed = events(ui, 'name_input', 'change');
      const picked = events(ui, 'color', 'change');
      const rows = events(ui, 'files', 'select');
      const tabs = events(ui, 'pages', 'change');
      ui.submitBtn.mute();
      ui.agree.readonly();
      ui.nameInput.readonly();
      ui.color.mute();
      ui.files.readonly();
      ui.pages.mute();
      await tick(40);
      for (const h of [ui.submitBtn, ui.agree, ui.nameInput, ui.color, ui.files]) {
        await clickOn(term, widgetOf(h));
      }
      const second = widgetOf(ui.pages).items[1];
      await click(term, second.aleft + 1, second.atop);
      await term.type('abc');
      await tick(40);
      expect([clicks, changes, typed, picked, rows, tabs].map((l) => l.length)).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
      expect(widgetOf(ui.nameInput)._reading).toBeFalsy();
      expect(ui.nameInput.value).toBe('');
      expect(ui.agree.checked).toBe(false);
      expect(ui.color._views[0].popup?.hidden ?? true).toBe(true);
      expect(ui.pages.activeTab).toBe(0);
      // Hidden: nothing to click on. Shown again: it works.
      ui.submitBtn.hide();
      await tick(40);
      await clickOn(term, widgetOf(ui.submitBtn));
      expect(clicks).toHaveLength(0);
      ui.submitBtn.active();
      await tick(40);
      await clickOn(term, widgetOf(ui.submitBtn));
      expect(clicks).toHaveLength(1);
    });

    it('radio buttons, toggles, menus and trees react to clicks', async () => {
      const { ui, term } = await boot(allComponents(), 'mouse-more');
      const a = events(ui, 'opt_a', 'change');
      const b = events(ui, 'opt_b', 'change');
      await clickOn(term, widgetOf(ui.optA));
      expect(ui.optA.checked).toBe(true);
      await clickOn(term, widgetOf(ui.optB));
      expect(ui.optB.checked).toBe(true);
      expect(ui.optA.checked).toBe(false);
      expect(a.map((e) => e.value)).toEqual([true, false]);
      expect(b.map((e) => e.value)).toEqual([true]);
      const dark = events(ui, 'dark', 'change');
      await clickOn(term, widgetOf(ui.dark));
      expect(ui.dark.checked).toBe(true);
      expect(dark).toHaveLength(1);
      const menu = events(ui, 'main_menu', 'select');
      const m = widgetOf(ui.mainMenu);
      await click(term, m.aleft + 3, m.atop + 1 + 1);
      expect(menu.at(-1)).toMatchObject({ tag: 'main_menu', name: 'select', value: 1 });
      const tree = events(ui, 'nav_tree', 'select');
      const tr = widgetOf(ui.navTree);
      await click(term, tr.aleft + 3, tr.atop + 1);
      expect(tree).toHaveLength(1);
    });

    it('clicks do not reach widgets behind an error dialog or a modal', async () => {
      resetIds();
      const root = screen('S', 'demo', [
        mk('Button', {
          tag: 'under',
          props: { label: 'Under', width: 12, height: 3 },
          layout: { x: 45, y: 28 },
        }),
        mk('Modal', {
          tag: 'dlg',
          props: { title: 'Dialog', width: 50, height: 12 },
          layout: { x: 30, y: 22 },
        }),
      ]);
      root.layout = { ...root.layout, type: 'absolute' } as typeof root.layout;
      const { ui, term } = await boot(root, 'mouse-overlay');
      const clicks = events(ui, 'under', 'click');
      const target = widgetOf(ui.under);
      await clickOn(term, target);
      expect(clicks).toHaveLength(1);
      const covers = (el: any) => {
        const x = target.aleft + Math.min(2, target.width - 1);
        const y = target.atop + Math.min(1, target.height - 1);
        return x >= el.aleft && x < el.aleft + el.width && y >= el.atop && y < el.atop + el.height;
      };
      // Error dialog on top of the button
      ui.report('overlay boom');
      await tick(60);
      expect(covers(ui._dialog)).toBe(true);
      await clickOn(term, target);
      expect(clicks).toHaveLength(1);
      await term.type(ENTER);
      await tick(40);
      await clickOn(term, target);
      expect(clicks).toHaveLength(2);
      // Modal on top of the button
      ui.dlg.open();
      await tick(40);
      expect(covers(widgetOf(ui.dlg))).toBe(true);
      await clickOn(term, target);
      expect(clicks).toHaveLength(2);
      ui.dlg.close();
      await tick(40);
      await clickOn(term, target);
      expect(clicks).toHaveLength(3);
    });

    it('enables the mouse modes itself when blessed does not know the terminal', async () => {
      // blessed only enables the mouse for terminals it knows by name (Windows reports none).
      const { ui, term } = await boot(apiDesign(), 'mouse-unknown-term', {
        terminal: 'windows-ansi',
      });
      expect(ui.screen.program.mouseEnabled).toBe(true);
      const clicks = events(ui, 'submit_btn', 'click');
      await clickOn(term, widgetOf(ui.submitBtn));
      expect(clicks).toHaveLength(1);
    });
  }
);

// ── S16: the frame fills the terminal ─────────────────────────────────────────

describe.skipIf(!HAS_BLESSED)(
  `blessed program API: fill (S16)${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    const check = (ui: any, cols: number, rows: number) => {
      const lines = frame(ui.screen).split(String.fromCharCode(10));
      expect(lines).toHaveLength(rows);
      expect(lines[0]).toMatch(/^┌─+┐$/);
      expect(lines[0]).toHaveLength(cols);
      expect(lines[rows - 1]).toMatch(/^└─+┘$/);
      expect(lines[rows - 1]).toHaveLength(cols);
      // The side borders run down the whole height.
      for (const l of lines.slice(1, rows - 1)) {
        expect(l[0]).toBe('│');
        // The scrollbar thumb is drawn over the right border.
        expect(['│', '█']).toContain(l.at(-1));
      }
    };

    it.each([
      [80, 24],
      [120, 40],
    ])('fills a %ix%i terminal', async (cols, rows) => {
      const { mod } = loadProject(apiDesign(), `fill-${cols}`);
      const term = makeTerm(cols, rows);
      const ui = new mod.Ui(term.options);
      await ui.start();
      await tick(50);
      check(ui, cols, rows);
      // Content stays where the design puts it.
      expect(frame(ui.screen).split(String.fromCharCode(10))[2]).toContain('Ready');
      ui.stop();
    });

    it('follows a resize of the terminal', async () => {
      const { mod } = loadProject(apiDesign(), 'fill-resize');
      const term = makeTerm(80, 24);
      const ui = new mod.Ui(term.options);
      await ui.start();
      await tick(50);
      check(ui, 80, 24);
      await resize(term, 120, 40);
      check(ui, 120, 40);
      await resize(term, 90, 30);
      check(ui, 90, 30);
      ui.stop();
    });
  }
);

// ── S17: scrolling when the design is taller than the terminal ───────────────

describe.skipIf(!HAS_BLESSED)(
  `blessed program API: scroll (S17)${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    const started: any[] = [];
    afterAll(() => started.forEach((u) => u.stop()));

    async function boot(root: ComponentNode, name: string, cols: number, rows: number) {
      const { mod } = loadProject(root, name);
      const term = makeTerm(cols, rows);
      const ui = new mod.Ui(term.options);
      started.push(ui);
      await ui.start();
      await tick(50);
      return { ui, term };
    }
    const lines = (ui: any) => frame(ui.screen).split(String.fromCharCode(10));
    const thumbRows = (ui: any) => lines(ui).filter((l) => l.endsWith('█')).length;
    const PGDN = String.fromCharCode(27) + '[6~';
    const PGUP = String.fromCharCode(27) + '[5~';
    const END = String.fromCharCode(27) + '[F';
    const HOME = String.fromCharCode(27) + '[H';
    /** Where blessed really drew the widget (scrolled), not where the design puts it. */
    const drawn = (h: any) => widgetOf(h).lpos;

    it.each([
      [80, 24],
      [120, 30],
    ])('scrolls a design taller than a %ix%i terminal', async (cols, rows) => {
      const { ui, term } = await boot(apiDesign(), `scroll-${cols}`, cols, rows);
      expect(ui.scrollMax).toBeGreaterThan(0);
      expect(ui.scrollOffset).toBe(0);
      expect(frame(ui.screen)).toContain('Ready');
      expect(frame(ui.screen)).not.toContain('Inside the panel');
      expect(thumbRows(ui)).toBeGreaterThan(0); // the scrollbar is there
      // Wheel down: 3 rows per notch, until the lower widgets show.
      await wheel(term, 10, 5, true);
      expect(ui.scrollOffset).toBe(3);
      for (let i = 0; i < 20; i++) await wheel(term, 10, 5, true);
      expect(ui.scrollOffset).toBe(ui.scrollMax);
      expect(frame(ui.screen)).toContain('Inside the panel');
      expect(frame(ui.screen)).not.toContain('Ready');
      // The frame stays: borders on the first and the last row.
      expect(lines(ui)[0]).toMatch(/^┌─+┐$/);
      expect(lines(ui)[rows - 1]).toMatch(/^└─+┘$/);
      // Wheel up returns.
      for (let i = 0; i < 20; i++) await wheel(term, 10, 5, false);
      expect(ui.scrollOffset).toBe(0);
      expect(frame(ui.screen)).toContain('Ready');
      expect(frame(ui.screen)).not.toContain('Inside the panel');
      // Keys: PageDown / PageUp / End / Home.
      await term.type(PGDN);
      expect(ui.scrollOffset).toBe(Math.min(rows - 3, ui.scrollMax));
      await term.type(PGUP);
      expect(ui.scrollOffset).toBe(0);
      await term.type(END);
      expect(ui.scrollOffset).toBe(ui.scrollMax);
      expect(frame(ui.screen)).toContain('Inside the panel');
      await term.type(HOME);
      expect(ui.scrollOffset).toBe(0);
      // The thumb moves with the offset.
      const top = lines(ui).findIndex((l) => l.endsWith('█'));
      await term.type(END);
      const bottom = lines(ui).findIndex((l) => l.endsWith('█'));
      expect(bottom).toBeGreaterThan(top);
    });

    it.each([
      [80, 24],
      [120, 30],
    ])('every scroll offset shows a clean window of the content (%ix%i)', async (cols, rows) => {
      // Reference: the same design in a terminal so tall that nothing scrolls.
      const ref = await boot(apiDesign(), `scroll-ref-${cols}`, cols, 90);
      expect(ref.ui.scrollMax).toBe(0);
      const full = lines(ref.ui);
      const { ui } = await boot(apiDesign(), `scroll-all-${cols}`, cols, rows);
      const max = ui.scrollMax;
      expect(max).toBeGreaterThan(3);
      for (let off = 0; off <= max; off++) {
        ui.scrollTo(off);
        await tick(30);
        const got = lines(ui);
        const at = `offset ${off}/${max}`;
        expect(got, at).toHaveLength(rows);
        // The frame never changes: corners and edges on the first and the last row ...
        expect(got[0], at).toMatch(/^┌─+┐$/);
        expect(got[0], at).toHaveLength(cols);
        expect(got[rows - 1], at).toMatch(/^└─+┘$/);
        expect(got[rows - 1], at).toHaveLength(cols);
        // ... and the side borders stay intact on every row between (the thumb is the only thing
        // that may replace the right one).
        for (let y = 1; y < rows - 1; y++) {
          expect(got[y][0], `${at} row ${y}`).toBe('│');
          expect(['│', '█'], `${at} row ${y}`).toContain(got[y].at(-1));
        }
        // The inside is exactly the window of the full content: no fragments of widgets that
        // are cut away, nothing of the part below the fold.
        // The root has one row of padding inside its border, above and below the scrolled content.
        for (let y = 1; y < rows - 1; y++) {
          const padding = y === 1 || y === rows - 2;
          const want = (padding ? '' : (full[y + off] ?? '')).slice(1, cols - 1).padEnd(cols - 2);
          const have = got[y].slice(1, cols - 1).padEnd(cols - 2);
          expect(have, `${at} row ${y}`).toBe(want);
        }
      }
    });

    it('a click after scrolling hits the widget that is drawn there', async () => {
      const { ui, term } = await boot(apiDesign(), 'scroll-click', 80, 24);
      const clicks: any[] = [];
      const tabs: any[] = [];
      const checks: any[] = [];
      ui.on('submit_btn', 'click', (e: any) => clicks.push(e));
      ui.on('pages', 'change', (e: any) => tabs.push(e));
      ui.on('agree', 'change', (e: any) => checks.push(e));
      // The button moved up when we scroll down by 2 rows (more would hide it above the content).
      const before = drawn(ui.submitBtn).yi;
      ui.scrollTo(2);
      await tick(50);
      const after = drawn(ui.submitBtn).yi;
      expect(after).toBe(before - 2);
      // Its old place is now taken by another widget: clicking there must not press it.
      await click(term, drawn(ui.submitBtn).xi + 2, before + 1);
      expect(clicks).toHaveLength(0);
      await click(term, drawn(ui.submitBtn).xi + 2, drawn(ui.submitBtn).yi + 1);
      expect(clicks).toHaveLength(1);
      // Further down: the checkbox and the second tab.
      ui.scrollTo(ui.scrollMax);
      await tick(50);
      const box = drawn(ui.agree);
      if (box) {
        await click(term, box.xi + 2, box.yi);
        expect(checks.length).toBeLessThanOrEqual(1);
      }
      const second = widgetOf(ui.pages).items[1];
      expect(second.lpos).toBeTruthy();
      await click(term, second.lpos.xi + 1, second.lpos.yi);
      expect(tabs.at(-1)).toMatchObject({ tag: 'pages', name: 'change', value: 1 });
      // Nested widgets are drawn at the scrolled place too.
      const rowsOf = lines(ui);
      const inner = rowsOf.findIndex((l) => l.includes('Inside the panel'));
      expect(inner).toBeGreaterThan(0);
      expect(widgetOf(ui.inner).lpos.yi).toBe(inner);
    });

    it('Tab to a widget below the fold scrolls it into view', async () => {
      const { ui, term } = await boot(apiDesign(), 'scroll-tab', 80, 24);
      expect(ui.scrollOffset).toBe(0);
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await term.type(String.fromCharCode(9));
        const f = ui.screen.focused;
        if (f === widgetOf(ui.pages)) reached = true;
        if (f && f.type === 'textbox') {
          // Leave the text field the way a user does.
          await term.type(String.fromCharCode(13));
        }
      }
      expect(reached).toBe(true);
      expect(ui.scrollOffset).toBeGreaterThan(0);
      const pos = drawn(ui.pages);
      expect(pos.yi).toBeGreaterThan(0);
      expect(pos.yl).toBeLessThanOrEqual(23);
      expect(frame(ui.screen)).toContain('Dashboard');
      // Back to the first widget: scrolls up again.
      widgetOf(ui.submitBtn).focus();
      await tick(40);
      expect(ui.scrollOffset).toBeLessThan(pos.yi);
      // A click that focuses a widget keeps it visible, too.
      ui.scrollTo(0);
      widgetOf(ui.nameInput).focus();
      await tick(40);
      expect(ui.scrollOffset).toBe(0);
    });

    it('has no scrollbar and does not scroll when everything fits', async () => {
      resetIds();
      const small = screen('S', 'demo', [
        mk('Text', { tag: 'hello', props: { content: 'Hi there' } }),
      ]);
      const { ui, term } = await boot(small, 'scroll-fits', 80, 24);
      expect(ui.scrollMax).toBe(0);
      expect(thumbRows(ui)).toBe(0);
      await wheel(term, 10, 5, true);
      await term.type(PGDN);
      await term.type(END);
      expect(ui.scrollOffset).toBe(0);
      expect(frame(ui.screen)).toContain('Hi there');
      expect(lines(ui).every((l) => !l.endsWith('█'))).toBe(true);
    });

    it('keeps the error dialog, the log and modals where they are', async () => {
      const { ui, term } = await boot(apiDesign(), 'scroll-overlay', 80, 24);
      ui.scrollTo(ui.scrollMax);
      await tick(50);
      ui.report('overlay while scrolled');
      await tick(60);
      expect(frame(ui.screen)).toContain('overlay while scrolled');
      // The wheel does nothing while the dialog is open.
      const at = ui.scrollOffset;
      await wheel(term, 10, 5, false);
      expect(ui.scrollOffset).toBe(at);
      await term.type(String.fromCharCode(13));
      await tick(40);
      ui.scrollTo(0);
      ui.confirm.open();
      await tick(50);
      expect(frame(ui.screen)).toContain('Really?');
      ui.scrollTo(ui.scrollMax);
      await tick(50);
      expect(frame(ui.screen)).toContain('Really?');
      ui.confirm.close();
      await term.type(String.fromCharCode(12));
      expect(frame(ui.screen)).toContain('Log');
    });
  }
);
