// The JavaScript runtime that every Blessed export ships next to index.js (the program API),
// and its type declarations. They live in real files so they can be linted and run on their
// own; Vite inlines them as text.

import source from './ui-runtime.js?raw';
import types from './ui-runtime.d.ts?raw';

export const BLESSED_RUNTIME_FILENAME = 'ui-runtime.js';
export const BLESSED_RUNTIME_SOURCE: string = source;
export const BLESSED_RUNTIME_TYPES: string = types;
