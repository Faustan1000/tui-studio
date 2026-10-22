# Visual consistency of the exports

The same design must look the same in every framework. **Textual is the reference**: its export is
the one verified against the editor's layout engine (`tests/python/parity.py`). Its frame of the demo
design (`tests/fixtures/apiDesign.ts`) at 100x40 cells is stored in
`tests/visual/reference.apiDesign.100x40.txt` (regenerate with `tests/python/dump_frame.py <dir of
the generated ui.py>`).

## What "the same" means

Compared cell by cell on the text of the frame (colours are not compared):

| Item              | Rule                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Root screen       | single-line border around the whole terminal, one blank cell padding inside                                               |
| Position and size | every widget starts at the same column and row and is as wide and as high as Textual                                      |
| Text              | Text: content only. Checkbox `[ ] label` / `[✓] label`. Select: `Red` + `▼` at right                                      |
| Text input        | bordered (3 rows), content indented by two cells, placeholder as text                                                     |
| Button            | rounded border (`╭╮╰╯`), label centred, 3 rows                                                                            |
| Table             | bordered, header row, rows, columns separated by two spaces, width of the content                                         |
| List              | bordered, items from the first column                                                                                     |
| Tabs              | one row of labels separated by two spaces, an underline row below (`╸━━╺━━`)                                              |
| Progress bar      | bordered (3 rows); one row `█`×filled `░`×rest, then the percentage right-aligned in 5 cells                              |
| Select (open)     | a bordered box under the field starting on the field's bottom border row, one option per row, the current one highlighted |
| Box with children | bordered, children inside at one cell of padding                                                                          |

Layout: a column of auto-sized children is stacked like Textual does it, at natural size, with the
box's padding added to its border (the editor's engine puts such children in fixed slots).

Known, accepted differences (listed in the tests, not silently ignored):
the unchecked checkbox is `[ ]` (Textual draws its mark `[✓]` dimmed), and the glyph of the underline under Tabs may differ
as long as it is one row of `─`, `━` or `▔`.

The comparison test per framework is `tests/visual.<framework>.test.ts`: it renders the demo design
at 100x40 in the real framework, normalises (trailing spaces) and diffs against the reference.
