import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStored, readStoredJson, setStored } from '../src/utils/storage';

function stubStorage(data: Record<string, string>) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('stored settings', () => {
  it('reads valid values', () => {
    stubStorage({ flag: 'true', text: 'hello' });
    expect(readStoredJson('flag', false)).toBe(true);
    expect(getStored('text')).toBe('hello');
  });

  it('falls back for missing, broken or mistyped JSON instead of throwing', () => {
    stubStorage({ broken: '{broken', mistyped: '"yes"', empty: '' });
    expect(readStoredJson('missing', true)).toBe(true);
    expect(readStoredJson('broken', false)).toBe(false);
    expect(readStoredJson('mistyped', false)).toBe(false);
    expect(readStoredJson('empty', false)).toBe(false);
  });

  it('survives storage that throws or does not exist', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(getStored('a')).toBeNull();
    expect(readStoredJson('a', 3)).toBe(3);
    expect(() => setStored('a', 'b')).not.toThrow();
    vi.unstubAllGlobals();
    expect(readStoredJson('a', 1)).toBe(1); // no localStorage at all
  });
});
