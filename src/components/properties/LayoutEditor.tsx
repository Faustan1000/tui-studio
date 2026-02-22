// Layout property editor

import { useState, useEffect } from 'react';
import { Maximize2, LayoutGrid } from 'lucide-react';
import { useComponentStore } from '../../stores';
import type { ComponentNode } from '../../types';
import { canHaveChildren } from '../../constants/components';

// ─── Numeric input that allows clearing before typing a new value ─────────────

export function NumericInput({
  value, onChange, min, max, className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const clamp = (n: number) =>
    Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9-]/g, '');
        setText(raw);
        const n = parseInt(raw, 10);
        if (!isNaN(n)) onChange(clamp(n));
      }}
      onFocus={() => { setFocused(true); setText(String(value)); }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(text, 10);
        setText(String(isNaN(n) ? value : clamp(n)));
      }}
      className={className}
    />
  );
}

interface LayoutEditorProps {
  component: ComponentNode;
}

const input = 'w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none';
const select = 'w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none';
const label = 'text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide';

// ─── Edge editor (padding & margin) ──────────────────────────────────────────

type EdgeValue = number | { top: number; right: number; bottom: number; left: number };

function getSide(p: EdgeValue, side: 'top' | 'right' | 'bottom' | 'left'): number {
  if (typeof p === 'number') return p;
  return (p as any)?.[side] ?? 0;
}

function EdgeEditor({
  label: edgeLabel,
  value,
  onChange,
}: {
  label: string;
  value: EdgeValue | undefined;
  onChange: (v: EdgeValue) => void;
}) {
  const isObj = typeof value === 'object' && value !== null;
  const [individual, setIndividual] = useState(isObj);

  const uniform = typeof value === 'number' ? value : 0;

  const toggleIndividual = () => {
    if (individual) {
      onChange(getSide(value ?? 0, 'top'));
    } else {
      const u = typeof value === 'number' ? value : 0;
      onChange({ top: u, right: u, bottom: u, left: u });
    }
    setIndividual(!individual);
  };

  const setAll = (v: number) => onChange(v);

  const setSide = (side: 'top' | 'right' | 'bottom' | 'left', v: number) => {
    onChange({
      top:    getSide(value ?? 0, 'top'),
      right:  getSide(value ?? 0, 'right'),
      bottom: getSide(value ?? 0, 'bottom'),
      left:   getSide(value ?? 0, 'left'),
      [side]: v,
    });
  };

  const sides = [
    { side: 'top'    as const, icon: '↑', title: 'Top' },
    { side: 'right'  as const, icon: '→', title: 'Right' },
    { side: 'bottom' as const, icon: '↓', title: 'Bottom' },
    { side: 'left'   as const, icon: '←', title: 'Left' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={label}>{edgeLabel}</span>
        <button
          onClick={toggleIndividual}
          title={individual ? 'Uniform' : 'Individual sides'}
          className={`w-5 h-5 flex items-center justify-center rounded border transition-colors ${
            individual
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-input border-border/50 text-muted-foreground hover:bg-accent'
          }`}
        >
          {individual
            ? <LayoutGrid size={12} />
            : <Maximize2 size={12} />}
        </button>
      </div>

      {!individual ? (
        <div className="flex items-center gap-1">
          <Maximize2 size={12} className="text-muted-foreground flex-shrink-0" />
          <NumericInput value={uniform} onChange={setAll} min={0} className={input} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1">
          {sides.map(({ side, icon, title }) => (
            <div key={side} className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground font-mono w-4 text-center" title={title}>
                {icon}
              </span>
              <NumericInput
                value={getSide(value ?? 0, side)}
                onChange={(v) => setSide(side, v)}
                min={0}
                className={input}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main editor ─────────────────────────────────────────────────────────────

export function LayoutEditor({ component }: LayoutEditorProps) {
  const updateLayout = useComponentStore(state => state.updateLayout);

  const upd = (updates: Partial<ComponentNode['layout']>) => updateLayout(component.id, updates);

  const isTabs = component.type === 'Tabs';
  const isLeaf = !canHaveChildren(component.type);

  return (
    <div className="space-y-2">
      {/* Position */}
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label className={label}>X</label>
          <NumericInput value={component.layout.x || 0} onChange={(v) => upd({ x: v })} className={input} />
        </div>
        <div>
          <label className={label}>Y</label>
          <NumericInput value={component.layout.y || 0} onChange={(v) => upd({ y: v })} className={input} />
        </div>
      </div>

      {/* Tabs: only tab alignment */}
      {isTabs && (
        <div>
          <label className={label}>Tab Alignment</label>
          <select
            value={(component.layout as any).justify || 'start'}
            onChange={(e) => upd({ justify: e.target.value as any })}
            className={select}
          >
            <option value="start">Left</option>
            <option value="center">Center</option>
            <option value="end">Right</option>
          </select>
        </div>
      )}

      {/* Container options */}
      {!isLeaf && !isTabs && (
        <>
          <div>
            <label className={label}>Layout</label>
            <select
              value={component.layout.type}
              onChange={(e) => upd({ type: e.target.value as any })}
              className={select}
            >
              <option value="none">None</option>
              <option value="flexbox">Flexbox</option>
              <option value="grid">Grid</option>
              <option value="absolute">Absolute</option>
            </select>
          </div>

          {component.layout.type === 'flexbox' && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className={label}>Direction</label>
                  <select
                    value={['List', 'Tree'].includes(component.type) ? 'column' : component.layout.direction}
                    onChange={(e) => upd({ direction: e.target.value as any })}
                    disabled={['List', 'Tree'].includes(component.type)}
                    className={select + ' disabled:opacity-50'}
                  >
                    <option value="row">Row →</option>
                    <option value="column">Column ↓</option>
                  </select>
                </div>
                <div>
                  <label className={label}>Gap</label>
                  <NumericInput value={component.layout.gap || 0} onChange={(v) => upd({ gap: v })} min={0} className={input} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className={label}>Justify</label>
                  <select
                    value={component.layout.justify}
                    onChange={(e) => upd({ justify: e.target.value as any })}
                    className={select}
                  >
                    <option value="start">Start</option>
                    <option value="center">Center</option>
                    <option value="end">End</option>
                    <option value="space-between">Between</option>
                    <option value="space-around">Around</option>
                  </select>
                </div>
                <div>
                  <label className={label}>Align</label>
                  <select
                    value={component.layout.align}
                    onChange={(e) => upd({ align: e.target.value as any })}
                    className={select}
                  >
                    <option value="start">Start</option>
                    <option value="center">Center</option>
                    <option value="end">End</option>
                    <option value="stretch">Stretch</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  id="wrap"
                  checked={component.layout.wrap || false}
                  onChange={(e) => upd({ wrap: e.target.checked })}
                  className="w-3 h-3"
                />
                <label htmlFor="wrap" className="text-[11px]">Wrap</label>
              </div>
            </>
          )}

          {component.layout.type === 'grid' && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className={label}>Columns</label>
                  <NumericInput value={component.layout.columns || 2} onChange={(v) => upd({ columns: v })} min={1} className={input} />
                </div>
                <div>
                  <label className={label}>Rows</label>
                  <NumericInput value={component.layout.rows || 2} onChange={(v) => upd({ rows: v })} min={1} className={input} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className={label}>Col Gap</label>
                  <NumericInput value={component.layout.columnGap || 0} onChange={(v) => upd({ columnGap: v })} min={0} className={input} />
                </div>
                <div>
                  <label className={label}>Row Gap</label>
                  <NumericInput value={component.layout.rowGap || 0} onChange={(v) => upd({ rowGap: v })} min={0} className={input} />
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Padding */}
      {!isTabs && (
        <EdgeEditor
          label="Padding"
          value={component.layout.padding}
          onChange={(v) => upd({ padding: v })}
        />
      )}

    </div>
  );
}
