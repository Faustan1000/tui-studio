// Prints the first frame real Ink draws for the generated project at COLSxROWS (argv 2, 3),
// between FRAME_START / FRAME_END. Copied next to the generated project and run with tsx
// (see tests/visual.ink.test.ts).

import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { Ui } from './src/app';

const cols = Number(process.argv[2] ?? 100);
const rows = Number(process.argv[3] ?? 40);

class FakeOut extends EventEmitter {
  columns = cols;
  rows = rows;
  isTTY = false;
  frames = [];
  write = (data) => {
    if (!String(data).startsWith('\u001b[?')) this.frames.push(data);
  };
}
class FakeIn extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}
const stdout = new FakeOut();
const ui = new Ui({
  render: (el) =>
    render(el, {
      stdout,
      stderr: new FakeOut(),
      stdin: new FakeIn(),
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }),
});
await ui.start();
await new Promise((r) => setTimeout(r, 200));
console.log('FRAME_START');
console.log(stdout.frames[stdout.frames.length - 1]);
console.log('FRAME_END');
process.exit(0);
