// The Python runtime that every Textual export ships next to ui.py. It lives in a real .py
// file so it can be linted and run on its own; Vite inlines it as text.

import source from './ui_runtime.py?raw';

export const TEXTUAL_RUNTIME_FILENAME = 'ui_runtime.py';
export const TEXTUAL_RUNTIME_SOURCE: string = source;
