// Runs the API scenario (docs/API_SCENARIO.md) against the generated Ink project, headless with
// fake terminal streams (like ink-testing-library, but with a size). Copied next to the generated project and run with tsx; prints the
// results as JSON on the last line. Not part of the test run itself (see tests/api.ink.test.ts).

import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { Ui } from './src/app';

let cur = 0;
const results = [];
const check = (name, ok, info) =>
  results.push({ name, ok: !!ok, info: ok ? undefined : String(info ?? '') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

// A fake terminal: a size that can change, a TTY flag and a stdin that Ink reads like the real one.
class FakeOut extends EventEmitter {
  constructor(columns, rows, isTTY) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
    this.frames = [];
    this.writes = [];
  }
  write = (data) => {
    this.writes.push(data);
    if (!String(data).startsWith('\u001b[?')) this.frames.push(data);
  };
}
class FakeIn extends EventEmitter {
  isTTY = true;
  data = null;
  write = (data) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
}
function makeApp(element, columns = 80, rows = 60, tty = false) {
  const stdout = new FakeOut(columns, rows, tty);
  const stdin = new FakeIn();
  const instance = render(element, {
    stdout,
    stderr: new FakeOut(columns, rows, false),
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    stdout,
    unmount: instance.unmount,
    lastFrame: () => stdout.frames[stdout.frames.length - 1],
    resize(c, r) {
      stdout.columns = c;
      stdout.rows = r;
      stdout.emit('resize');
    },
  };
}

let app;
let ui = new Ui({ render: (el) => (app = makeApp(el)) });
const frame = () => app.lastFrame() ?? '';
const type = async (text) => {
  // Ink clears the focus on Esc.
  if (text === '') cur = 0;
  app.stdin.write(text);
  await sleep(60);
};

// Focus order of the design: name_input, submit_btn, agree, color, files, pages.
const FOCUSABLE = 6;
async function focus(k) {
  while (cur !== k) {
    await type('\t');
    cur = (cur % FOCUSABLE) + 1;
  }
}
async function drain() {
  const out = [];
  for (;;) {
    const e = await ui.nextEvent(120);
    if (!e) return out;
    out.push(e);
  }
}

const lines = () => frame().split('\n');

// S16: the root fills the terminal
async function fill() {
  for (const [c, r] of [
    [80, 24],
    [120, 40],
  ]) {
    ui = new Ui({ render: (el) => (app = makeApp(el, c, r)) });
    await ui.start();
    await sleep(100);
    const L = lines();
    const tag = 'S16 ' + c + 'x' + r + ' ';
    check(tag + 'rows', L.length === r, L.length);
    check(
      tag + 'top border spans the width',
      L[0].length === c && L[0].startsWith('┌') && L[0].endsWith('┐'),
      JSON.stringify(L[0])
    );
    check(
      tag + 'bottom border on the last row',
      L[r - 1].length === c && L[r - 1].startsWith('└') && L[r - 1].endsWith('┘'),
      JSON.stringify(L[r - 1])
    );
    check(
      tag + 'side borders on every row',
      L.slice(1, r - 1).every((l) => l.startsWith('│') && l.endsWith('│'))
    );
    if (c === 80) {
      app.resize(100, 30);
      await sleep(150);
      const R = lines();
      check(
        'S16 follows a resize',
        R.length === 30 && R[0].length === 100 && R[29].startsWith('└') && R[29].length === 100,
        R.length + ':' + R[0].length
      );
    }
    ui.stop();
  }
}

try {
  if (process.argv[2] === 'fill') {
    await fill();
    console.log('RESULTS ' + JSON.stringify(results));
    process.exit(0);
  }
  // S1
  await ui.start();
  check('S1 ready and running', ui.ready && ui.running);

  // S2
  check('S2 status text', ui.status.text === 'Ready', ui.status.text);
  check('S2 progress max', ui.progress.max === 100, ui.progress.max);
  check('S2 states active', ui.status.state === 'active' && ui.submitBtn.state === 'active');
  check(
    'S2 frame shows the design',
    frame().includes('Ready') && frame().includes('Send') && frame().includes('I agree'),
    frame()
  );

  // S3: written from another "thread" (a timer callback)
  await new Promise((resolve) =>
    setTimeout(() => {
      ui.status.text = 'Working';
      ui.progress.value = 40;
      ui.nameInput.value = 'Ada';
      check(
        'S3 read after write',
        ui.status.text === 'Working' && ui.progress.value === 40 && ui.nameInput.value === 'Ada'
      );
      resolve();
    }, 10)
  );
  await sleep(80);
  check(
    'S3 frame shows writes',
    frame().includes('Working') && frame().includes('Ada') && frame().includes('40%'),
    frame()
  );
  check('S3 writes fire no event', (await drain()).length === 0);

  // S4
  const clicks = [];
  let clickSync = null;
  let inSync = false;
  ui.submitBtn.onClick((e) => {
    clickSync = inSync;
    clicks.push(e);
  });
  ui.submitBtn.mute();
  await sleep(100);
  await focus(2);
  await type('\r');
  check('S4 muted button still drawn', frame().includes('Send'));
  const s4 = await drain();
  check(
    'S4 muted button fires nothing',
    clicks.length === 0 && s4.length === 0,
    JSON.stringify(s4)
  );
  ui.submitBtn.active();
  await sleep(100);

  // S5
  ui.panel.hide();
  await sleep(80);
  check('S5 hidden', !frame().includes('Inside the panel'), frame());
  ui.panel.show();
  await sleep(80);
  check('S5 shown again', frame().includes('Inside the panel'), frame());

  // S6
  ui.nameInput.readonly();
  await sleep(100);
  await focus(1);
  await type('abc');
  check(
    'S6 readonly ignores typing',
    ui.nameInput.value === 'Ada' && (await drain()).length === 0,
    ui.nameInput.value
  );
  ui.nameInput.active();
  await sleep(100);
  await type('z');
  check('S6 active accepts typing', ui.nameInput.value === 'Adaz', ui.nameInput.value);
  const typed = await drain();
  check(
    'S6 typing fires change',
    typed.length === 1 && typed[0].name === 'change' && typed[0].value === 'Adaz',
    JSON.stringify(typed)
  );

  // S7
  const err = throws(() => ui.submitBtn.readonly());
  check('S7 readonly on a button is an error', err && err.name === 'UiError', err);
  check('S7 nothing changed', ui.submitBtn.state === 'active');

  // S8
  await drain();
  await focus(2);
  inSync = true;
  app.stdin.write('\r');
  inSync = false;
  await sleep(80);
  check(
    'S8 click handler ran off the UI path',
    clicks.length === 1 && clickSync === false,
    JSON.stringify([clicks.length, clickSync])
  );
  check(
    'S8 handler event',
    clicks[0] && clicks[0].tag === 'submit_btn' && clicks[0].name === 'click',
    JSON.stringify(clicks[0])
  );
  await focus(1);
  await type('y');
  await focus(3);
  await type(' ');
  const queue = await drain();
  check(
    'S8 queue',
    queue.map((e) => e.tag + ':' + e.name).join() ===
      'submit_btn:click,name_input:change,agree:change' && queue[2].value === true,
    JSON.stringify(queue)
  );
  check('S8 checkbox drawn checked', frame().includes('[✓]'), frame());

  // S9
  ui.agree.checked = false;
  await sleep(80);
  check('S9 write shows', frame().includes('[ ]'), frame());
  ui.agree.checked = true;
  await sleep(40);
  check('S9 no echo', (await drain()).length === 0 && ui.agree.checked === true);

  // S10
  ui.report('boom');
  await sleep(80);
  check('S10 dialog shows the message', frame().includes('boom'), frame());
  check('S10 errors has it', ui.errors.length === 1 && ui.errors[0].message === 'boom');
  await type('\r');
  await sleep(60);
  check('S10 Enter closes the dialog', !frame().includes('boom'), frame());
  check(
    'S10 Enter did not press the widget below',
    ui.agree.checked === true && (await drain()).length === 0
  );
  ui.report(new Error('second'));
  await sleep(60);
  check('S10 error object shown', frame().includes('second'));
  await type('\x1b');
  await sleep(120);
  check('S10 Esc closes the dialog', !frame().includes('second'), frame());

  // S11
  ui.submitBtn.onClick(() => {
    throw new Error('handler failed');
  });
  await focus(2);
  await type('\r');
  await sleep(120);
  check(
    'S11 handler error reported',
    frame().includes('handler failed') && ui.errors.some((e) => e.message === 'handler failed'),
    JSON.stringify({ cur, errors: ui.errors.map((e) => e.message), events: await drain() })
  );
  check('S11 UI keeps running', ui.running);
  await type('\r');
  await sleep(60);

  // S12
  ui.log.info('hello');
  await sleep(60);
  check('S12 panel closed at first', !frame().includes('hello'), frame());
  await focus(1);
  const typedBefore = ui.nameInput.value;
  await type('\x0c');
  check('S12 Ctrl+L opens the log', frame().includes('hello'), frame());
  check('S12 Ctrl+L typed no character', ui.nameInput.value === typedBefore, ui.nameInput.value);
  check(
    'S12 errors are in the log',
    frame().includes('handler failed') || frame().includes('[error]'),
    frame()
  );
  await type('\x0c');
  check('S12 Ctrl+L closes the log', !frame().includes('hello'), frame());

  // S13
  check('S13 starts closed', !ui.confirm.isOpen && !frame().includes('Really?'), frame());
  ui.confirm.open();
  await sleep(80);
  check('S13 open again', frame().includes('Really?'), frame());
  await type('\x1b');
  await sleep(120);
  check('S13 Esc closes the modal', !ui.confirm.isOpen && !frame().includes('Really?'), frame());

  // Extras: select, tabs, list, typing q, tab/list properties
  await drain();
  await focus(4);
  await type('\r');
  check('X select opens', frame().includes('Green'), frame());
  await type('\x1b[B');
  await type('\r');
  const sel = await drain();
  check(
    'X select change',
    ui.color.value === 'Green' && sel.length === 1 && sel[0].value === 'Green',
    JSON.stringify(sel) + ui.color.value
  );
  await focus(6);
  await type('\x1b[C');
  const tab = await drain();
  check(
    'X tabs change',
    ui.pages.activeTab === 1 && tab.length === 1 && tab[0].name === 'change',
    JSON.stringify(tab)
  );
  ui.pages.activeTab = 0;
  check('X tab write no echo', (await drain()).length === 0);
  ui.results.rows = [['a', 'b']];
  ui.files.items = ['one', 'two'];
  await sleep(80);
  check(
    'X table and list writes',
    frame().includes('a') && frame().includes('one') && frame().includes('two'),
    frame()
  );
  await focus(1);
  await type('q');
  check(
    'X typing q does not quit',
    ui.running && ui.nameInput.value.endsWith('q'),
    ui.nameInput.value
  );

  // S14
  ui.stop();
  const waited = await Promise.race([ui.wait().then(() => true), sleep(1000).then(() => false)]);
  check('S14 wait returns', waited && !ui.running);
  check(
    'S14 later calls do not throw',
    throws(() => {
      ui.status.text = 'late';
      ui.submitBtn.mute();
      ui.report('late');
      ui.log.info('late');
    }) === null
  );

  // q quits
  const ui2 = new Ui({ render: (el) => (app = makeApp(el)) });
  await ui2.start();
  cur = 0;
  await type('q');
  const quit = await Promise.race([ui2.wait().then(() => true), sleep(1000).then(() => false)]);
  check('X q quits', quit && !ui2.running);

  // S15: the mouse. Every position is found in the rendered frame.
  const find = (text) => {
    const y = lines().findIndex((l) => l.includes(text));
    return { x: y < 0 ? -1 : lines()[y].indexOf(text), y };
  };
  const click = async (text, dx = 0) => {
    const p = find(text);
    if (p.y < 0) throw new Error('not on screen: ' + text);
    app.stdin.write('\u001b[<0;' + (p.x + dx + 1) + ';' + (p.y + 1) + 'M');
    await sleep(100);
  };
  ui = new Ui({ render: (el) => (app = makeApp(el, 80, 60, true)) });
  await ui.start();
  check(
    'S15 mouse reporting switched on',
    app.stdout.writes.includes('\u001b[?1000h\u001b[?1006h')
  );
  ui.confirm.close();
  await sleep(100);
  await click('your name');
  await type('hi');
  check('S15 click focuses a text input', ui.nameInput.value === 'hi', ui.nameInput.value);
  app.stdin.write('\u001b[<64;5;5M');
  await sleep(60);
  check('S15 wheel report is swallowed', ui.nameInput.value === 'hi', ui.nameInput.value);
  let evs = await drain();
  check(
    'S15 typing after the click fires change',
    evs.length === 1 && evs[0].tag === 'name_input',
    JSON.stringify(evs)
  );
  await click('Send');
  evs = await drain();
  check(
    'S15 click on a button',
    evs.length === 1 && evs[0].tag === 'submit_btn' && evs[0].name === 'click',
    JSON.stringify(evs)
  );
  await click('I agree');
  evs = await drain();
  check(
    'S15 click on a checkbox',
    ui.agree.checked === true &&
      evs.length === 1 &&
      evs[0].tag === 'agree' &&
      evs[0].value === true,
    JSON.stringify(evs)
  );
  await click('[✓]');
  check('S15 click again unchecks', ui.agree.checked === false);
  await drain();
  await click('Red');
  check('S15 click opens a select', frame().includes('Green'), frame());
  await click('Green');
  evs = await drain();
  check(
    'S15 click chooses an option',
    ui.color.value === 'Green' && evs.length === 1 && evs[0].value === 'Green',
    JSON.stringify(evs) + ui.color.value
  );
  await click('Item 2');
  evs = await drain();
  check(
    'S15 click on a list item',
    ui.files.selected === 1 &&
      evs.some((e) => e.tag === 'files' && e.name === 'select' && e.value === 1),
    JSON.stringify(evs)
  );
  await click('Agent');
  evs = await drain();
  check(
    'S15 click on a tab',
    ui.pages.activeTab === 1 &&
      evs.length === 1 &&
      evs[0].tag === 'pages' &&
      evs[0].name === 'change',
    JSON.stringify(evs)
  );
  ui.submitBtn.mute();
  await sleep(100);
  await click('Send');
  check('S15 muted button ignores clicks', (await drain()).length === 0);
  ui.submitBtn.active();
  ui.nameInput.readonly();
  await sleep(100);
  await click('hi');
  await type('x');
  check(
    'S15 readonly input ignores typing after a click',
    ui.nameInput.value === 'hi' && (await drain()).length === 0,
    ui.nameInput.value
  );
  ui.nameInput.active();
  ui.panel.hide();
  await sleep(100);
  check('S15 hidden component is not on screen to click', !frame().includes('Inside the panel'));
  ui.panel.show();
  await sleep(100);
  ui.report('boom');
  await sleep(100);
  await click('Send');
  await sleep(100);
  check(
    'S15 click with a dialog open does not press the button',
    (await drain()).filter((e) => e.name === 'click').length === 0
  );
  check('S15 click closes the dialog', !frame().includes('boom'), frame());
  ui.confirm.open();
  await sleep(100);
  await click('Send');
  check('S15 click outside an open modal does nothing', (await drain()).length === 0);
  await click('Really?');
  check(
    'S15 click inside the modal does nothing',
    (await drain()).length === 0 && ui.confirm.isOpen
  );
  ui.stop();
  await sleep(60);
  check(
    'S15 mouse reporting switched off',
    app.stdout.writes.includes('\u001b[?1006l\u001b[?1000l')
  );

  // S17: a click never ends the app
  const click1 = (x, y) => '\u001b[<0;' + (x + 1) + ';' + (y + 1) + 'M';
  const release1 = (x, y) => '\u001b[<0;' + (x + 1) + ';' + (y + 1) + 'm';
  ui = new Ui({ render: (el) => (app = makeApp(el, 80, 60, true)) });
  await ui.start();
  ui.confirm.close();
  await sleep(100);
  const box = find('I agree');
  for (const [x, y] of [
    [70, 40],
    [1, 1],
    [79, 59],
    [40, 30],
    [0, 0],
    [200, 200],
  ]) {
    app.stdin.write(click1(x, y) + release1(x, y));
    await sleep(40);
  }
  check(
    'S17 clicks on empty areas keep the app running',
    ui.running && ui.errors.length === 0,
    ui.errors.map((e) => e.message).join()
  );
  // The same report in pieces, down to one character per chunk (Windows Terminal).
  const report = click1(box.x + 1, box.y);
  for (const piece of [report.slice(0, 3), report.slice(3, 8), report.slice(8)]) {
    app.stdin.write(piece);
    await sleep(15);
  }
  await sleep(100);
  check(
    'S17 a report in three chunks is a click',
    ui.agree.checked === true && ui.running,
    ui.agree.checked
  );
  for (const ch of click1(box.x + 1, box.y)) {
    app.stdin.write(ch);
    await sleep(5);
  }
  await sleep(100);
  check(
    'S17 a report key by key is a click',
    ui.agree.checked === false && ui.running,
    ui.agree.checked
  );
  await drain();
  // Several reports in one chunk, with motion and release reports between them.
  app.stdin.write(
    click1(box.x + 1, box.y) +
      '\u001b[<35;5;5M' +
      release1(box.x + 1, box.y) +
      click1(box.x + 1, box.y)
  );
  await sleep(100);
  check(
    'S17 several reports in one chunk',
    ui.agree.checked === false && (await drain()).length === 2,
    ui.agree.checked
  );
  app.stdin.write('\u001b[<35;5;5M\u001b[<2;5;5M\u001b[<1;5;5m');
  await sleep(60);
  check('S17 motion and other buttons are ignored', ui.running && ui.errors.length === 0);
  // A lone Esc is still an Esc, and "q" next to a report still quits only when it is a key.
  app.stdin.write('\u001b');
  await sleep(120);
  check('S17 a lone Esc does not end the app', ui.running);
  app.stdin.write('\u001b[<0;3;3M');
  await sleep(60);
  check(
    'S17 report text never reaches the widgets',
    ui.nameInput.value === '' && ui.running,
    ui.nameInput.value
  );
  // A click that throws is reported, not fatal.
  ui.core.addHit({
    ref: {
      current: {
        yogaNode: {
          getComputedWidth() {
            throw new Error('broken layout');
          },
        },
      },
    },
    layer: 0,
    cb() {},
  });
  app.stdin.write(click1(10, 10));
  await sleep(100);
  check(
    'S17 an error while clicking is reported',
    ui.running && ui.errors.some((e) => e.message === 'broken layout'),
    ui.errors.map((e) => e.message).join()
  );
  ui.stop();

  // S18: scrolling
  for (const [c, r] of [
    [80, 24],
    [120, 30],
  ]) {
    const tag = 'S18 ' + c + 'x' + r + ' ';
    ui = new Ui({ render: (el) => (app = makeApp(el, c, r, true)) });
    await ui.start();
    await sleep(150);
    ui.confirm.close();
    await sleep(100);
    const wheel = async (down, n = 1) => {
      for (let i = 0; i < n; i++) {
        app.stdin.write('\u001b[<' + (down ? 65 : 64) + ';10;10M');
        await sleep(60);
      }
    };
    const core = ui.core;
    check(
      tag + 'content is taller than the terminal',
      core.maxScroll() > 0 && core.scroll === 0,
      core.contentHeight + '/' + core.viewHeight
    );
    check(
      tag + 'starts at the top',
      frame().includes('Ready') && !frame().includes('Inside the panel')
    );
    check(
      tag + 'scroll bar on the right edge',
      lines()
        .slice(1, r - 1)
        .some((l) => l.slice(c - 6, c - 1).includes('█')),
      lines()
        .map((l) => l.slice(c - 6))
        .join('|')
    );
    await wheel(true);
    check(tag + 'one wheel notch scrolls 3 rows', core.scroll === 3, core.scroll);
    await wheel(true, 2);
    check(
      tag + 'content moved',
      !frame().includes('Ready') && core.scroll === Math.min(9, core.maxScroll()),
      core.scroll
    );
    check(
      tag + 'frame stays',
      lines().length === r && lines()[0].startsWith('┌') && lines()[r - 1].startsWith('└')
    );
    await wheel(false, 10);
    check(
      tag + 'wheel up stops at the top',
      core.scroll === 0 && frame().includes('Ready'),
      core.scroll
    );
    app.stdin.write('\u001b[6~');
    await sleep(80);
    check(
      tag + 'PageDown scrolls a page',
      core.scroll === Math.min(core.maxScroll(), core.viewHeight - 1),
      core.scroll + '/' + core.viewHeight
    );
    app.stdin.write('\u001b[5~');
    await sleep(80);
    check(tag + 'PageUp scrolls back', core.scroll === 0, core.scroll);
    app.stdin.write('\u001b[F');
    await sleep(80);
    check(
      tag + 'End shows the bottom',
      core.scroll === core.maxScroll() && frame().includes('Inside the panel'),
      core.scroll
    );
    app.stdin.write('\u001b[H');
    await sleep(80);
    check(tag + 'Home shows the top', core.scroll === 0 && frame().includes('Ready'), core.scroll);

    // Tab into view
    cur = 0;
    for (let i = 0; i < 6; i++) await type('\t');
    cur = 6;
    check(
      tag + 'Tab scrolls the focused widget into view',
      // At 120x30 the tabs are in view without scrolling.
      (core.scroll > 0 || c >= 100) && frame().includes('Agent'),
      core.scroll
    );
    app.stdin.write('\u001b[Z');
    await sleep(100);
    app.stdin.write('\u001b[Z');
    await sleep(100);
    app.stdin.write('\u001b[Z');
    await sleep(100);
    app.stdin.write('\u001b[Z');
    await sleep(100);
    app.stdin.write('\u001b[Z');
    await sleep(100);
    check(
      tag + 'Shift+Tab scrolls back to the first widget',
      frame().includes('your name'),
      core.scroll
    );

    // Click after scrolling
    await drain();
    await type('\u001b');
    await sleep(100);
    app.stdin.write('\u001b[F');
    await sleep(80);
    const tab = find('Agent');
    check(tag + 'tabs are on screen at the end', tab.y > 0, tab.y);
    app.stdin.write(click1(tab.x + 1, tab.y));
    await sleep(100);
    let evs = await drain();
    check(
      tag + 'a click after scrolling hits the right widget',
      ui.pages.activeTab === 1 && evs.some((e) => e.tag === 'pages'),
      JSON.stringify(evs)
    );
    // The frame (border rows) does not take clicks from content that is scrolled out of view.
    app.stdin.write('\u001b[H');
    await sleep(80);
    const before = (await drain()).length;
    app.stdin.write(click1(5, r - 1) + click1(5, 0));
    await sleep(100);
    check(
      tag + 'clicks on the frame do nothing',
      before === 0 && (await drain()).length === 0 && ui.running
    );

    // The dialog, the log panel and modals do not scroll
    await wheel(true, 2);
    const at = core.scroll;
    ui.report('boom');
    await sleep(100);
    const boomRow = lines().findIndex((l) => l.includes('boom'));
    check(tag + 'dialog over scrolled content', boomRow > 0 && boomRow < 6, boomRow);
    await wheel(true, 3);
    check(tag + 'wheel does not scroll under a dialog', core.scroll === at, core.scroll);
    app.stdin.write('\r');
    await sleep(100);
    app.stdin.write('\u000c');
    await sleep(100);
    ui.log.info('hello log');
    await sleep(100);
    const logRow = lines().findIndex((l) => l.includes('hello log'));
    check(
      tag + 'log panel stays at the bottom',
      logRow >= r - 9 && core.scroll === at,
      logRow + ':' + core.scroll
    );
    app.stdin.write('\u000c');
    await sleep(100);
    await type('\u001b');
    await sleep(100);
    app.stdin.write('\u001b[H');
    await sleep(80);
    ui.confirm.open();
    await sleep(100);
    const top = lines().findIndex((l) => l.includes('Really?'));
    app.stdin.write('\u001b[F');
    await sleep(100);
    const bottom = lines().findIndex((l) => l.includes('Really?'));
    check(tag + 'modal does not scroll', top > 0 && top === bottom, top + ':' + bottom);
    ui.stop();
  }
  await fill();
} catch (e) {
  check('driver crashed', false, e && e.stack ? e.stack : e);
}
console.log('RESULTS ' + JSON.stringify(results));
process.exit(0);
