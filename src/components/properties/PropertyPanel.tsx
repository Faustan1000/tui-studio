// Compact Figma-style property panel with collapsible sections

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronDown, Trash2, Copy, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { useSelectionStore, useComponentStore } from '../../stores';
import { LayoutEditor } from './LayoutEditor';
import { StyleEditor } from './StyleEditor';

// Collapsible Section Component
function Section({
  title,
  defaultOpen = true,
  children,
  action
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border/30">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-1">
          {isOpen ? (
            <ChevronDown className="w-2.5 h-2.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-2.5 h-2.5 text-muted-foreground" />
          )}
          <span className="text-[11px] font-semibold">{title}</span>
        </div>
        {action}
      </button>
      {isOpen && <div className="px-3 py-2 space-y-2">{children}</div>}
    </div>
  );
}

export function PropertyPanel() {
  const selectionStore = useSelectionStore();
  const componentStore = useComponentStore();
  const [activeTab, setActiveTab] = useState<'visual' | 'content'>('visual');

  const selectedComponents = selectionStore.getSelectedComponents();
  const selectedComponent = selectedComponents[0];

  if (!selectedComponent) {
    return (
      <div className="p-3">
        <div className="text-center text-xs text-muted-foreground py-8">
          Select a component
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border/30 flex items-center justify-between">
        <div className="text-[11px] font-semibold truncate">{selectedComponent.name}</div>
        <div className="flex gap-0.5">
          <button
            onClick={() => {
              const id = componentStore.duplicateComponent(selectedComponent.id);
              if (id) selectionStore.select(id);
            }}
            className="p-1 hover:bg-accent rounded transition-colors"
            title="Duplicate"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            onClick={() => {
              componentStore.removeComponent(selectedComponent.id);
              selectionStore.clearSelection();
            }}
            className="p-1 hover:bg-destructive/10 text-destructive rounded transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/30">
        <button
          onClick={() => setActiveTab('visual')}
          className={`flex-1 px-3 py-1.5 text-[11px] font-medium transition-colors ${
            activeTab === 'visual'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Visual
        </button>
        <button
          onClick={() => setActiveTab('content')}
          className={`flex-1 px-3 py-1.5 text-[11px] font-medium transition-colors ${
            activeTab === 'content'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Content
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'visual' ? (
          <VisualProperties component={selectedComponent} />
        ) : (
          <ContentProperties component={selectedComponent} />
        )}
      </div>
    </div>
  );
}

// Visual properties tab (dimensions, layout, appearance)
function VisualProperties({ component }: { component: import('../../types').ComponentNode }) {
  const componentStore = useComponentStore();

  return (
    <>
      {/* Dimensions Section */}
      <Section title="Dimensions" defaultOpen={true}>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">W</label>
            <input
              type="text"
              value={component.props.width || 'auto'}
              onChange={(e) =>
                componentStore.updateProps(component.id, {
                  width: e.target.value === 'auto' ? 'auto' : Number(e.target.value) || 'auto'
                })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">H</label>
            <input
              type="text"
              value={component.props.height || 'auto'}
              onChange={(e) =>
                componentStore.updateProps(component.id, {
                  height: e.target.value === 'auto' ? 'auto' : Number(e.target.value) || 'auto'
                })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      </Section>

      {/* Layout Section */}
      <Section title="Layout" defaultOpen={true}>
        <LayoutEditor component={component} />
      </Section>

      {/* Appearance Section */}
      <Section title="Appearance" defaultOpen={true}>
        <StyleEditor component={component} />
      </Section>
    </>
  );
}

// Content properties tab (component-specific content)
function ContentProperties({ component }: { component: import('../../types').ComponentNode }) {
  if (!component) {
    return <div className="p-3 text-muted-foreground">No component selected</div>;
  }

  return (
    <div className="p-3">
      <ComponentProps component={component} />
    </div>
  );
}

function TextContentEditor({ component }: { component: import('../../types').ComponentNode }) {
  const componentStore = useComponentStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const align = (component.props.align as string) || 'left';

  const insertGlyph = (glyph: string) => {
    const el = textareaRef.current;
    const current = (component.props.content as string) || '';
    if (el) {
      const start = el.selectionStart ?? current.length;
      const end = el.selectionEnd ?? current.length;
      const next = current.slice(0, start) + glyph + current.slice(end);
      componentStore.updateProps(component.id, { content: next });
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + glyph.length;
        el.focus();
      });
    } else {
      componentStore.updateProps(component.id, { content: current + glyph });
    }
  };

  return (
    <div className="space-y-1.5">
      {/* Alignment */}
      <div className="flex items-center justify-between">
        <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Align</label>
        <div className="flex gap-0.5 bg-input border border-border/50 rounded p-0.5">
          {(['left', 'center', 'right'] as const).map((a) => {
            const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
            return (
              <button
                key={a}
                onClick={() => componentStore.updateProps(component.id, { align: a })}
                className={`p-1 rounded transition-colors ${align === a ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'}`}
                title={a.charAt(0).toUpperCase() + a.slice(1)}
              >
                <Icon className="w-3 h-3" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div>
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Content</label>
          <GlyphPicker onInsert={insertGlyph} />
        </div>
        <textarea
          ref={textareaRef}
          value={(component.props.content as string) || ''}
          onChange={(e) => componentStore.updateProps(component.id, { content: e.target.value })}
          rows={3}
          className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] font-mono resize-none focus:border-primary focus:outline-none"
        />
      </div>
    </div>
  );
}

const GLYPHS: { name: string; chars: string[] }[] = [
  { name: 'Dots', chars: ['●', '○', '◉', '◎', '◆', '◇', '▪', '□', '■', '▫', '▬', '▮'] },
  { name: 'Arrows', chars: ['→', '←', '↑', '↓', '↗', '↘', '↙', '↖', '▶', '◀', '▲', '▼', '⇒', '⇐', '⟹', '⟸'] },
  { name: 'Box', chars: ['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '═', '║', '╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '╬'] },
  { name: 'Blocks', chars: ['░', '▒', '▓', '█', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '▉'] },
  { name: 'Status', chars: ['✓', '✗', '✕', '⚠', 'ℹ', '★', '☆', '✦', '⊕', '⊗', '⊘', '⊙', '⬤'] },
  { name: 'Math', chars: ['±', '×', '÷', '≤', '≥', '≠', '∞', 'π', '√', '∑', '∂', '∆'] },
];

function GlyphPicker({ onInsert }: { onInsert: (glyph: string) => void }) {
  const [open, setOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    const close = (e: MouseEvent) => {
      if (!buttonRef.current?.closest('[data-glyph-picker]')?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div data-glyph-picker>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        className="px-1.5 py-0.5 text-[10px] bg-input border border-border/50 rounded hover:bg-accent transition-colors font-mono"
        title="Insert glyph"
      >
        Ω
      </button>
      {open && createPortal(
        <div
          className="fixed w-56 bg-popover border border-border rounded-lg shadow-lg"
          style={{ top: pos.top, right: pos.right, zIndex: 9999 }}
        >
          {/* Category tabs */}
          <div className="flex flex-wrap gap-0.5 p-1.5 border-b border-border/50">
            {GLYPHS.map((cat, i) => (
              <button
                key={cat.name}
                onClick={() => setActiveCategory(i)}
                className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                  activeCategory === i ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
          {/* Glyph grid */}
          <div className="grid grid-cols-8 gap-0.5 p-1.5">
            {GLYPHS[activeCategory].chars.map((g) => (
              <button
                key={g}
                onClick={() => { onInsert(g); setOpen(false); }}
                className="w-6 h-6 flex items-center justify-center text-sm font-mono hover:bg-accent rounded transition-colors"
                title={`U+${g.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Component-specific properties in compact format
function ComponentProps({ component }: { component: import('../../types').ComponentNode }) {
  const componentStore = useComponentStore();

  return (
    <div className="space-y-3">
      {/* Text Content */}
      {component.type === 'Text' && (
        <TextContentEditor component={component} />
      )}

      {/* Button Properties */}
      {component.type === 'Button' && (
        <>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Label</label>
            <input
              type="text"
              value={(component.props.label as string) || ''}
              onChange={(e) =>
                componentStore.updateProps(component.id, { label: e.target.value })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id="iconLeftEnabled"
              checked={component.props.iconLeftEnabled as boolean || false}
              onChange={(e) =>
                componentStore.updateProps(component.id, { iconLeftEnabled: e.target.checked })
              }
              className="w-3 h-3"
            />
            <label htmlFor="iconLeftEnabled" className="text-[9px] text-muted-foreground uppercase tracking-wide">Left Icon</label>
            <input
              type="text"
              value={(component.props.iconLeft as string) || ''}
              onChange={(e) =>
                componentStore.updateProps(component.id, { iconLeft: e.target.value })
              }
              disabled={!component.props.iconLeftEnabled}
              className="flex-1 px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none disabled:opacity-50"
              placeholder="+"
            />
            <div className={!component.props.iconLeftEnabled ? 'opacity-50 pointer-events-none' : ''}>
              <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { iconLeft: g })} />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id="iconRightEnabled"
              checked={component.props.iconRightEnabled as boolean || false}
              onChange={(e) =>
                componentStore.updateProps(component.id, { iconRightEnabled: e.target.checked })
              }
              className="w-3 h-3"
            />
            <label htmlFor="iconRightEnabled" className="text-[9px] text-muted-foreground uppercase tracking-wide">Right Icon</label>
            <input
              type="text"
              value={(component.props.iconRight as string) || ''}
              onChange={(e) =>
                componentStore.updateProps(component.id, { iconRight: e.target.value })
              }
              disabled={!component.props.iconRightEnabled}
              className="flex-1 px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none disabled:opacity-50"
              placeholder="→"
            />
            <div className={!component.props.iconRightEnabled ? 'opacity-50 pointer-events-none' : ''}>
              <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { iconRight: g })} />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id="separated"
              checked={component.props.separated as boolean || false}
              onChange={(e) =>
                componentStore.updateProps(component.id, { separated: e.target.checked })
              }
              className="w-3 h-3"
            />
            <label htmlFor="separated" className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Separated (│)</label>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id="disabled"
              checked={component.props.disabled as boolean || false}
              onChange={(e) =>
                componentStore.updateProps(component.id, { disabled: e.target.checked })
              }
              className="w-3 h-3"
            />
            <label htmlFor="disabled" className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Disabled</label>
          </div>
        </>
      )}

      {/* TextInput Placeholder */}
      {component.type === 'TextInput' && (
        <div>
          <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Placeholder</label>
          <input
            type="text"
            value={(component.props.placeholder as string) || ''}
            onChange={(e) =>
              componentStore.updateProps(component.id, { placeholder: e.target.value })
            }
            className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
          />
        </div>
      )}


      {/* Checkbox Properties */}
      {component.type === 'Checkbox' && (
        <>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Label</label>
            <input
              type="text"
              value={(component.props.label as string) || ''}
              onChange={(e) => componentStore.updateProps(component.id, { label: e.target.value })}
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input type="checkbox" checked={component.props.checked as boolean || false}
              onChange={(e) => componentStore.updateProps(component.id, { checked: e.target.checked })}
              className="w-3 h-3" />
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Checked</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input type="checkbox" checked={component.props.showBrackets !== false}
              onChange={(e) => componentStore.updateProps(component.id, { showBrackets: e.target.checked })}
              className="w-3 h-3" />
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Show brackets [ ]</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide w-16">Checked</span>
            <input type="text" value={(component.props.checkedIcon as string) || '✓'}
              onChange={(e) => componentStore.updateProps(component.id, { checkedIcon: e.target.value })}
              className="w-8 px-1 py-0.5 bg-input border border-border/50 rounded text-[11px] text-center font-mono focus:border-primary focus:outline-none" />
            <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { checkedIcon: g })} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide w-16">Unchecked</span>
            <input type="text" value={(component.props.uncheckedIcon as string) || ' '}
              onChange={(e) => componentStore.updateProps(component.id, { uncheckedIcon: e.target.value })}
              className="w-8 px-1 py-0.5 bg-input border border-border/50 rounded text-[11px] text-center font-mono focus:border-primary focus:outline-none" />
            <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { uncheckedIcon: g })} />
          </div>
        </>
      )}

      {/* Radio Properties */}
      {component.type === 'Radio' && (
        <>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Label</label>
            <input
              type="text"
              value={(component.props.label as string) || ''}
              onChange={(e) => componentStore.updateProps(component.id, { label: e.target.value })}
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input type="checkbox" checked={component.props.checked as boolean || false}
              onChange={(e) => componentStore.updateProps(component.id, { checked: e.target.checked })}
              className="w-3 h-3" />
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Selected</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input type="checkbox" checked={component.props.showBrackets !== false}
              onChange={(e) => componentStore.updateProps(component.id, { showBrackets: e.target.checked })}
              className="w-3 h-3" />
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Show brackets ( )</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide w-16">Selected</span>
            <input type="text" value={(component.props.selectedIcon as string) || '●'}
              onChange={(e) => componentStore.updateProps(component.id, { selectedIcon: e.target.value })}
              className="w-8 px-1 py-0.5 bg-input border border-border/50 rounded text-[11px] text-center font-mono focus:border-primary focus:outline-none" />
            <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { selectedIcon: g })} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide w-16">Unselected</span>
            <input type="text" value={(component.props.unselectedIcon as string) || '○'}
              onChange={(e) => componentStore.updateProps(component.id, { unselectedIcon: e.target.value })}
              className="w-8 px-1 py-0.5 bg-input border border-border/50 rounded text-[11px] text-center font-mono focus:border-primary focus:outline-none" />
            <GlyphPicker onInsert={(g) => componentStore.updateProps(component.id, { unselectedIcon: g })} />
          </div>
        </>
      )}

      {/* ProgressBar Properties */}
      {component.type === 'ProgressBar' && (
        <>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Value</label>
            <input
              type="number"
              value={(component.props.value as number) || 0}
              onChange={(e) =>
                componentStore.updateProps(component.id, { value: Number(e.target.value) })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Max</label>
            <input
              type="number"
              value={(component.props.max as number) || 100}
              onChange={(e) =>
                componentStore.updateProps(component.id, { max: Number(e.target.value) })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
        </>
      )}

      {/* Select Properties */}
      {component.type === 'Select' && (
        <>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Value</label>
            <input
              type="text"
              value={(component.props.value as string) || ''}
              onChange={(e) =>
                componentStore.updateProps(component.id, { value: e.target.value })
              }
              className="w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">Options (one per line)</label>
            <textarea
              value={
                Array.isArray(component.props.options)
                  ? (component.props.options as string[]).join('\n')
                  : ''
              }
              onChange={(e) =>
                componentStore.updateProps(component.id, {
                  options: e.target.value.split('\n').filter((s) => s.trim()),
                })
              }
              rows={5}
              placeholder="Option 1&#10;Option 2&#10;Option 3"
              className="w-full px-2 py-1 bg-input border border-border/50 rounded text-[11px] font-mono resize-none focus:border-primary focus:outline-none"
            />
          </div>
        </>
      )}

      {/* Table Properties */}
      {component.type === 'Table' && (
        <TableEditor
          columns={(component.props.columns as string[]) || ['Column 1', 'Column 2']}
          rows={(component.props.rows as string[][]) || []}
          onChange={(columns, rows) => componentStore.updateProps(component.id, { columns, rows })}
        />
      )}

      {/* List Properties */}
      {component.type === 'List' && (
        <ListItemsEditor
          items={(component.props.items as any[]) || []}
          selectedIndex={(component.props.selectedIndex as number) || 0}
          onChange={(items, selectedIndex) => componentStore.updateProps(component.id, { items, selectedIndex })}
        />
      )}

      {/* Breadcrumb Properties */}
      {component.type === 'Breadcrumb' && (
        <BreadcrumbEditor
          items={(component.props.items as any[]) || []}
          separator={(component.props.separator as string) || '/'}
          onChange={(items, separator) => componentStore.updateProps(component.id, { items, separator })}
        />
      )}

      {/* Tabs Properties */}
      {component.type === 'Tabs' && (
        <div className="space-y-3">
          <label className="text-xs font-medium mb-1.5 block">Tabs</label>
          {Array.isArray(component.props.tabs) &&
            (component.props.tabs as any[]).map((tab, index) => {
              const tabData = typeof tab === 'string' ? { label: tab, icon: '', status: false, hotkey: '' } : tab;

              return (
                <div key={index} className="p-2 bg-accent/50 rounded space-y-2">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={tabData.label || ''}
                      onChange={(e) => {
                        const newTabs = [...(component.props.tabs as any[])];
                        newTabs[index] = { ...tabData, label: e.target.value };
                        componentStore.updateProps(component.id, { tabs: newTabs });
                      }}
                      className="flex-1 px-2 py-1 bg-secondary border border-border rounded text-xs"
                      placeholder="Label"
                    />
                    <button
                      onClick={() => {
                        const newTabs = (component.props.tabs as any[]).filter((_, i) => i !== index);
                        const activeTab = component.props.activeTab as number;
                        const newActiveTab = activeTab >= newTabs.length ? Math.max(0, newTabs.length - 1) : activeTab;
                        componentStore.updateProps(component.id, {
                          tabs: newTabs,
                          activeTab: newActiveTab,
                        });
                      }}
                      className="px-2 py-1 bg-secondary hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded transition-colors"
                      title="Remove tab"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Icon</label>
                      <input
                        type="text"
                        value={tabData.icon || ''}
                        onChange={(e) => {
                          const newTabs = [...(component.props.tabs as any[])];
                          newTabs[index] = { ...tabData, icon: e.target.value };
                          componentStore.updateProps(component.id, { tabs: newTabs });
                        }}
                        maxLength={3}
                        className="w-full px-1.5 py-0.5 bg-secondary border border-border rounded text-xs text-center"
                        placeholder="⌂"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Status</label>
                      <div className="flex items-center justify-center h-6">
                        <input
                          type="checkbox"
                          checked={tabData.status || false}
                          onChange={(e) => {
                            const newTabs = [...(component.props.tabs as any[])];
                            newTabs[index] = { ...tabData, status: e.target.checked };
                            componentStore.updateProps(component.id, { tabs: newTabs });
                          }}
                          className="w-3.5 h-3.5"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Hotkey</label>
                      <input
                        type="text"
                        value={tabData.hotkey || ''}
                        onChange={(e) => {
                          const newTabs = [...(component.props.tabs as any[])];
                          newTabs[index] = { ...tabData, hotkey: e.target.value };
                          componentStore.updateProps(component.id, { tabs: newTabs });
                        }}
                        className="w-full px-1.5 py-0.5 bg-secondary border border-border rounded text-xs text-center font-mono"
                        placeholder="^1"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          <button
            onClick={() => {
              const currentTabs = (component.props.tabs as any[]) || [];
              const newTabs = [...currentTabs, { label: `Tab ${currentTabs.length + 1}`, icon: '', status: false, hotkey: '' }];
              componentStore.updateProps(component.id, { tabs: newTabs });
            }}
            className="w-full px-2 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded text-xs"
          >
            + Add Tab
          </button>
          <div>
            <label className="text-xs font-medium mb-1.5 block">Active Tab</label>
            <select
              value={(component.props.activeTab as number) || 0}
              onChange={(e) =>
                componentStore.updateProps(component.id, {
                  activeTab: parseInt(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 bg-secondary border border-border rounded text-xs"
            >
              {Array.isArray(component.props.tabs) &&
                (component.props.tabs as any[]).map((tab, index) => {
                  const label = typeof tab === 'string' ? tab : tab.label || `Tab ${index + 1}`;
                  return (
                    <option key={index} value={index}>
                      {label}
                    </option>
                  );
                })}
            </select>
          </div>
        </div>
      )}

      {/* Tree Properties */}
      {component.type === 'Tree' && (
        <div className="space-y-3">
          <TreeItemsEditor
            items={(component.props.items as any[]) || []}
            onChange={(newItems) => {
              componentStore.updateProps(component.id, { items: newItems });
            }}
            level={0}
          />
          <button
            onClick={() => {
              const currentItems = (component.props.items as any[]) || [];
              componentStore.updateProps(component.id, {
                items: [...currentItems, { label: 'Item', children: [] }],
              });
            }}
            className="w-full px-2 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded text-xs"
          >
            + Add Item
          </button>
        </div>
      )}
    </div>
  );
}


// Table Editor
function TableEditor({
  columns, rows, onChange,
}: {
  columns: string[];
  rows: string[][];
  onChange: (columns: string[], rows: string[][]) => void;
}) {
  const addColumn = () => {
    const newCols = [...columns, `Col ${columns.length + 1}`];
    const newRows = rows.map(r => [...r, '']);
    onChange(newCols, newRows);
  };
  const removeColumn = (ci: number) => {
    if (columns.length <= 1) return;
    const newCols = columns.filter((_, i) => i !== ci);
    const newRows = rows.map(r => r.filter((_, i) => i !== ci));
    onChange(newCols, newRows);
  };
  const updateColumn = (ci: number, val: string) => {
    const newCols = [...columns];
    newCols[ci] = val;
    onChange(newCols, rows);
  };
  const addRow = () => {
    onChange(columns, [...rows, columns.map(() => '')]);
  };
  const removeRow = (ri: number) => {
    onChange(columns, rows.filter((_, i) => i !== ri));
  };
  const updateCell = (ri: number, ci: number, val: string) => {
    const newRows = rows.map((r, i) => i === ri ? r.map((c, j) => j === ci ? val : c) : r);
    onChange(columns, newRows);
  };

  const inputCls = 'px-1 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none w-full min-w-0';

  return (
    <div className="space-y-2">
      {/* Column headers */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Columns</span>
        <button onClick={addColumn} className="text-[10px] px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary rounded">+ Col</button>
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr) 20px` }}>
        {columns.map((col, ci) => (
          <input key={ci} value={col} onChange={e => updateColumn(ci, e.target.value)}
            className={inputCls + ' font-semibold'} placeholder={`Col ${ci + 1}`} />
        ))}
        <div />
      </div>

      {/* Rows */}
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Rows</span>
        <button onClick={addRow} className="text-[10px] px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary rounded">+ Row</button>
      </div>
      <div className="space-y-1">
        {rows.map((row, ri) => (
          <div key={ri} className="grid gap-1 items-center" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr) 20px` }}>
            {columns.map((_, ci) => (
              <input key={ci} value={row[ci] ?? ''} onChange={e => updateCell(ri, ci, e.target.value)}
                className={inputCls} placeholder="—" />
            ))}
            <button onClick={() => removeRow(ri)} className="flex items-center justify-center text-muted-foreground hover:text-destructive">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      {rows.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center py-1">No rows — click + Row</p>
      )}
    </div>
  );
}

// Breadcrumb Editor
function BreadcrumbEditor({
  items, separator, onChange,
}: {
  items: any[];
  separator: string;
  onChange: (items: any[], separator: string) => void;
}) {
  const updateItem = (i: number, patch: object) => {
    const next = items.map((item, idx) => idx === i ? { ...item, ...patch } : item);
    onChange(next, separator);
  };
  const addItem = () => {
    onChange([...items, { label: 'Item', icon: '' }], separator);
  };
  const removeItem = (i: number) => {
    onChange(items.filter((_, idx) => idx !== i), separator);
  };

  const inputCls = 'px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none';

  return (
    <div className="space-y-2">
      {/* Separator */}
      <div className="flex items-center gap-2">
        <label className="text-[9px] text-muted-foreground uppercase tracking-wide w-16">Separator</label>
        <input value={separator} onChange={e => onChange(items, e.target.value)}
          className={inputCls + ' w-16 font-mono'} placeholder="/" />
        <GlyphPicker onInsert={(g) => onChange(items, g)} />
      </div>

      {/* Items */}
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Items</span>
        <button onClick={addItem} className="text-[10px] px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary rounded">+ Item</button>
      </div>
      <div className="space-y-1">
        {items.map((item: any, i: number) => {
          const d = typeof item === 'string' ? { label: item, icon: '' } : item;
          return (
            <div key={i} className="flex items-center gap-1">
              {/* Icon */}
              <input value={d.icon || ''} onChange={e => updateItem(i, { icon: e.target.value })}
                className={inputCls + ' w-8 text-center font-mono'} placeholder="⌂" />
              <GlyphPicker onInsert={(g) => updateItem(i, { icon: g })} />
              {/* Label */}
              <input value={d.label || ''} onChange={e => updateItem(i, { label: e.target.value })}
                className={inputCls + ' flex-1 min-w-0'} placeholder="Label" />
              <button onClick={() => removeItem(i)} className="text-muted-foreground hover:text-destructive flex-shrink-0">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// List Items Editor
function ListItemsEditor({
  items, selectedIndex, onChange,
}: {
  items: any[];
  selectedIndex: number;
  onChange: (items: any[], selectedIndex: number) => void;
}) {
  const updateItem = (i: number, patch: object) => {
    onChange(items.map((item, idx) => idx === i ? { ...item, ...patch } : item), selectedIndex);
  };
  const addItem = () => {
    onChange([...items, { label: 'Item', icon: '•', hotkey: '' }], selectedIndex);
  };
  const removeItem = (i: number) => {
    const next = items.filter((_, idx) => idx !== i);
    onChange(next, Math.min(selectedIndex, Math.max(0, next.length - 1)));
  };

  const inputCls = 'px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide flex-1">Items</span>
        <button onClick={addItem} className="text-[10px] px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary rounded">+ Item</button>
      </div>
      <div className="space-y-1">
        {items.map((item: any, i: number) => {
          const d = typeof item === 'string' ? { label: item, icon: '•', hotkey: '' } : item;
          return (
            <div key={i} className="flex items-center gap-1">
              <input value={d.icon || ''} onChange={e => updateItem(i, { icon: e.target.value })}
                className={inputCls + ' w-8 text-center font-mono'} placeholder="•" />
              <GlyphPicker onInsert={(g) => updateItem(i, { icon: g })} />
              <input value={d.label || ''} onChange={e => updateItem(i, { label: e.target.value })}
                className={inputCls + ' flex-1 min-w-0'} placeholder="Label" />
              <input value={d.hotkey || ''} onChange={e => updateItem(i, { hotkey: e.target.value })}
                className={inputCls + ' w-8 text-center font-mono'} placeholder="⌘K" />
              <button onClick={() => removeItem(i)} className="text-muted-foreground hover:text-destructive flex-shrink-0">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
      {items.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-[9px] text-muted-foreground uppercase tracking-wide w-20">Selected</label>
          <input
            type="number" min={0} max={items.length - 1}
            value={selectedIndex}
            onChange={e => onChange(items, Math.max(0, Math.min(items.length - 1, Number(e.target.value))))}
            className={inputCls + ' w-14'}
          />
        </div>
      )}
    </div>
  );
}

// Tree Items Editor Component
function TreeItemsEditor({ items, onChange, level }: { items: any[]; onChange: (items: any[]) => void; level: number }) {
  const updateItem = (index: number, updates: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], ...updates };
    onChange(newItems);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const addChild = (index: number) => {
    const newItems = [...items];
    const children = newItems[index].children || [];
    newItems[index] = {
      ...newItems[index],
      children: [...children, { label: 'Sub-Item', children: [] }],
    };
    onChange(newItems);
  };

  return (
    <div className="space-y-1">
      {items.map((item, index) => {
        const itemData = typeof item === 'string' ? { label: item, children: [] } : item;
        const hasChildren = itemData.children && itemData.children.length > 0;
        const isLast = index === items.length - 1;

        return (
          <div key={index} style={{ paddingLeft: `${level * 12}px` }}>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[10px] text-muted-foreground select-none w-4 shrink-0">
                {isLast ? '╰╼' : '├╼'}
              </span>
              <input
                type="text"
                value={itemData.label || ''}
                onChange={(e) => updateItem(index, { label: e.target.value })}
                className="flex-1 min-w-0 px-2 py-1 bg-secondary border border-border rounded text-xs"
              />
              <button
                onClick={() => addChild(index)}
                className="px-1.5 py-1 bg-secondary hover:bg-accent text-muted-foreground hover:text-foreground rounded text-[10px] font-mono shrink-0"
                title="Add sub-item"
              >
                +╼
              </button>
              <button
                onClick={() => removeItem(index)}
                className="px-1.5 py-1 bg-secondary hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded shrink-0"
                title="Remove"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>

            {hasChildren && (
              <TreeItemsEditor
                items={itemData.children}
                onChange={(newChildren) => updateItem(index, { children: newChildren })}
                level={level + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
