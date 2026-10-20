# Export architecture

Every framework exporter works the same way, so that adding or fixing a framework is a small,
well-defined task.

```
ComponentNode tree(s)          src/types
        │
        ▼  buildIR()           src/utils/export/ir.ts        (shared, written once)
   IRProject ── IRScreen ── IRNode
        │
        ▼  adapter.generate()  src/utils/export/exporters/<framework>.ts   (one per framework)
   ExportFile[]                entry point + manifest (package.json / go.mod / Cargo.toml / runtime)
```

## What the IR resolves (so adapters do not)

| Concern         | In the IR                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Defaults        | `text`, `options`, `items`, `rows`, `columns`, `progress`, `glyphs`, `selected`, ... are always filled |
| Colours         | `style.fg/bg/border.color` are `#rrggbb` (theme resolved) or `null` = terminal default                 |
| Borders         | `style.border` is `null` or `{kind: single\|double\|rounded\|bold, color, top/right/bottom/left}`      |
| Visibility      | `visible` already respects `hidden` and tab/menu bodies (`showWhen`); adapters skip `!visible`         |
| Layout (native) | `layout`: `mode` (flex/grid/absolute/none), direction, justify, align, gap, wrap, padding, grid cells  |
| Layout (exact)  | `box` / `rel`: the cell position and size the **editor's own layout engine** computed                  |
| Names           | `ident` (unique, snake_case; `recase(ident, 'camel'\|'pascal')`), `tag` = code name chosen by the user |
| Text of widgets | `inlineText`, `itemText`, `treeLines`, `progressText`: identical text in every framework               |
| Escaping        | `lang.ts`: `jsStr`, `jsxText`, `goStr`, `rustStr`, `pyStr`; `CodeWriter` for indentation               |

## Layout strategy

Every adapter picks one of two strategies per container, and says which in its file header:

1. **Native** – the framework has flexbox/constraints (Ink, OpenTUI, Textual, tview, Ratatui). Map
   `layout` (direction, gap, padding, justify, align, wrap) and `width`/`height` (`number`,
   `'fill'`, `'auto'`). Where a property has no equivalent (wrap, per-child alignment) fall back to
   strategy 2 for that container.
2. **Snapshot** – place every child at `rel` (or `box`) with `rel.width/height`. Frameworks with
   absolute positioning (Blessed, Ratatui `Rect`, Bubble Tea canvases) reproduce the editor
   exactly at the design size; the price is that it does not reflow when the terminal is resized.

Both strategies are measured against the editor (see `tests/python/parity.py` for Textual).

## Writing an adapter

1. Create `src/utils/export/exporters/<id>.ts` exporting an `ExportAdapter` and register it in
   `exporters/index.ts`.
2. Return the files a project needs: entry point **and** manifest, with pinned dependency
   versions and a header comment that says how to run it.
3. Handle all 20 component types, only `visible` nodes, escape every user string.
4. Use the user's code names: `node.ident` becomes the variable/field name, and `node.events`
   handler names become stub functions the user fills in.
5. Set `verification`: `run` (started against the real framework in tests), `syntax` (parsed in
   tests) or `snapshot` (only compared; no toolchain here).
6. Add `tests/export.<id>.test.ts` and make `tests/adapters.conformance.test.ts` green for the id.

## Test layers

| Layer                          | Where                                | Needs                          |
| ------------------------------ | ------------------------------------ | ------------------------------ |
| IR, layout, validation, stores | `tests/*.test.ts`                    | `npm test`                     |
| Conformance (all adapters)     | `tests/adapters.conformance.test.ts` | `npm test`                     |
| Per-framework output           | `tests/export.<id>.test.ts`          | `npm test`                     |
| Textual against real Textual   | `tests/python/`                      | Python + `pip install textual` |
