import { describe, expect, it } from 'vitest';
import { MAX_TAG_LENGTH, collectTags, suggestTag, validateTag } from '../src/utils/apiTag';
import { mk, resetIds, screen } from './fixtures/build';

const none = new Set<string>();

describe('validateTag', () => {
  it('accepts identifiers', () => {
    for (const ok of ['a', 'submit_btn', 'Button2', 'x_1_y', 'trailing_']) {
      expect(validateTag(ok, none), ok).toBeNull();
    }
  });

  it('treats the empty string as "no code name"', () => {
    expect(validateTag('', none)).toBeNull();
  });

  it.each([
    ['1st', 'start with a letter'],
    ['_private', 'start with a letter'],
    ['has space', 'Only letters'],
    ['dash-ed', 'Only letters'],
    ['ümlaut', 'start with a letter'],
    ['double__under', 'double underscores'],
    ['x'.repeat(MAX_TAG_LENGTH + 1), 'At most'],
    ['class', 'keyword'],
    ['None', 'keyword'],
    ['log', 'reserved'],
  ])('rejects %s', (tag, message) => {
    expect(validateTag(tag, none)).toContain(message);
  });

  it('rejects a tag that is taken', () => {
    expect(validateTag('name', new Set(['name']))).toContain('already used');
  });
});

describe('suggestTag', () => {
  it('turns names into snake_case tags', () => {
    expect(suggestTag('Submit Button', none)).toBe('submit_button');
    expect(suggestTag('  Hello,  World! ', none)).toBe('hello_world');
  });

  it('strips accents and non-latin characters', () => {
    expect(suggestTag('Café', none)).toBe('cafe');
  });

  it('never returns something invalid', () => {
    for (const name of ['', '123', '___', '日本語', 'class', 'ui']) {
      expect(validateTag(suggestTag(name, none), none), name).toBeNull();
    }
  });

  it('numbers duplicates', () => {
    expect(suggestTag('Save', new Set(['save']))).toBe('save_2');
    expect(suggestTag('Save', new Set(['save', 'save_2']))).toBe('save_3');
  });
});

describe('collectTags', () => {
  it('collects tags of one or several trees', () => {
    resetIds();
    const a = screen('A', 'home', [mk('Text', { tag: 'one' })]);
    const b = screen('B', undefined, [mk('Box', {}, [mk('Text', { tag: 'two' })])]);
    expect([...collectTags(a)].sort()).toEqual(['home', 'one']);
    expect([...collectTags([a, b])].sort()).toEqual(['home', 'one', 'two']);
    expect(collectTags(null).size).toBe(0);
  });

  it('can ignore the component being edited', () => {
    resetIds();
    const text = mk('Text', { tag: 'mine' });
    const root = screen('A', undefined, [text, mk('Text', { tag: 'other' })]);
    expect([...collectTags(root, text)]).toEqual(['other']);
  });
});
