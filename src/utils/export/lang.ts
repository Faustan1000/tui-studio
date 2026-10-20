// Small helpers every exporter needs: string literals per language and an indenting writer.

/** JS/TS string literal (double quotes). */
export function jsStr(s: unknown): string {
  return JSON.stringify(String(s ?? ''))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Go interpreted string literal. JSON escapes are valid Go except \u2028/\u2029 handling, which Go accepts. */
export function goStr(s: unknown): string {
  return JSON.stringify(String(s ?? ''));
}

/** Rust string literal. Rust has no \uXXXX, so non-BMP and control characters use \u{...}. */
export function rustStr(s: unknown): string {
  const out = [...String(s ?? '')]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      if (ch === '\\') return '\\\\';
      if (ch === '"') return '\\"';
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '\\r';
      if (ch === '\t') return '\\t';
      if (cp < 0x20 || cp === 0x7f) return `\\u{${cp.toString(16)}}`;
      return ch;
    })
    .join('');
  return `"${out}"`;
}

/** Python string literal (JSON string syntax is valid Python). */
export function pyStr(s: unknown): string {
  return JSON.stringify(String(s ?? ''));
}

/** Text inside JSX: braces, angle brackets and ampersands would be parsed as code. */
export function jsxText(s: unknown): string {
  return String(s ?? '').replace(
    /[{}<>&]/g,
    (c) => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c
  );
}

/** Line-based writer with an indentation level. */
export class CodeWriter {
  private lines: string[] = [];
  private level: number;

  constructor(
    private readonly unit = '  ',
    start = 0
  ) {
    this.level = start;
  }

  line(text = ''): this {
    this.lines.push(text === '' ? '' : this.unit.repeat(this.level) + text);
    return this;
  }

  /** Several lines at the current indentation. */
  block(text: string): this {
    for (const l of text.split('\n')) this.line(l);
    return this;
  }

  indent(): this {
    this.level++;
    return this;
  }

  dedent(): this {
    this.level = Math.max(0, this.level - 1);
    return this;
  }

  /** Write `open`, run `body` indented, write `close`. */
  wrap(open: string, body: () => void, close: string): this {
    this.line(open).indent();
    body();
    return this.dedent().line(close);
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
