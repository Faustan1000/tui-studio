// The Go runtime of the program API (framework-neutral, see ui_runtime.go). It lives in a real
// .go file so it can be vetted and tested on its own; Vite inlines it as text.

import source from './ui_runtime.go?raw';

export const GO_RUNTIME_FILENAME = 'ui_runtime.go';
export const GO_RUNTIME_SOURCE: string = source;
