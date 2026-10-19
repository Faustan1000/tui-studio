// Code names ("tags") that users give to components. A tag shows up unchanged as the
// identifier of that component in exported code, so it has to be a safe identifier in
// every target language we plan to support.

import type { ComponentNode } from '../types';

export const MAX_TAG_LENGTH = 48;

/** Python keywords (the strictest of the target languages we care about). */
const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/** Names the generated UI facade uses for its own members. */
const RESERVED_TAGS: ReadonlySet<string> = new Set([
  'app',
  'attach_logging',
  'close',
  'errors',
  'events',
  'install_excepthooks',
  'log',
  'main',
  'next_event',
  'on',
  'ready',
  'report',
  'run',
  'running',
  'start',
  'stop',
  'thread',
  'wait',
]);

// Letters, digits and single underscores; starts with a letter. A leading underscore is kept
// for generated names and "__" for derived ids, so neither can collide with a tag.
const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*_?$/;

/**
 * All tags used in the given tree(s), optionally ignoring one component (the one being
 * edited). Compared by identity: every screen's root has the id "root".
 */
export function collectTags(
  roots: ComponentNode | readonly ComponentNode[] | null,
  except?: ComponentNode
): Set<string> {
  const tags = new Set<string>();
  const walk = (node: ComponentNode) => {
    if (node.tag && node !== except) tags.add(node.tag);
    node.children.forEach(walk);
  };
  if (Array.isArray(roots)) roots.forEach(walk);
  else if (roots) walk(roots as ComponentNode);
  return tags;
}

/** Returns an error message for an invalid tag, or null if it is fine (empty = no tag). */
export function validateTag(tag: string, taken: ReadonlySet<string>): string | null {
  if (tag === '') return null;
  if (tag.length > MAX_TAG_LENGTH) return `At most ${MAX_TAG_LENGTH} characters`;
  if (!/^[A-Za-z]/.test(tag)) return 'Must start with a letter';
  if (tag.includes('__')) return 'No double underscores';
  if (!TAG_PATTERN.test(tag)) return 'Only letters, digits and "_" (no spaces)';
  if (PY_KEYWORDS.has(tag)) return `"${tag}" is a Python keyword`;
  if (RESERVED_TAGS.has(tag)) return `"${tag}" is reserved by the generated API`;
  if (taken.has(tag)) return `"${tag}" is already used`;
  return null;
}

/** Turn a display name like "Submit Button" into a free, valid tag like "submit_button". */
export function suggestTag(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize('NFKD')
    .replace(/[^ -~]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!/^[a-z]/.test(base)) base = `item_${base}`.replace(/_$/, '');
  base = base.slice(0, MAX_TAG_LENGTH - 4) || 'item';
  let candidate = base;
  for (let i = 2; validateTag(candidate, taken) !== null; i++) candidate = `${base}_${i}`;
  return candidate;
}
