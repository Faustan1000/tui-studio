// Dimension input: auto, a number of cells, a percentage, or fill

import { NumericInput } from './LayoutEditor';
import { isPercent, parsePercent, type Dimension } from '../../utils/layout/dimension';

interface DimensionInputProps {
  value: Dimension | undefined;
  onChange: (value: Dimension) => void;
  label: string;
  max?: number;
}

type Mode = 'auto' | 'cells' | 'percent' | 'fill';

const field =
  'w-full px-1.5 py-0.5 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-hidden';

function modeOf(value: Dimension | undefined): Mode {
  if (typeof value === 'number') return 'cells';
  if (isPercent(value)) return 'percent';
  return value === 'fill' ? 'fill' : 'auto';
}

export function DimensionInput({ value, onChange, label, max = 1000 }: DimensionInputProps) {
  const mode = modeOf(value);
  const cells = typeof value === 'number' ? value : 10;
  const percent = parsePercent(value) ?? 100;

  const changeMode = (next: Mode) => {
    if (next === 'cells') onChange(cells);
    else if (next === 'percent') onChange(`${percent}%`);
    else onChange(next);
  };

  return (
    <div>
      <label className="text-[9px] text-muted-foreground block mb-0.5 uppercase tracking-wide">
        {label}
      </label>
      <div className="flex gap-1">
        <select
          value={mode}
          onChange={(e) => changeMode(e.target.value as Mode)}
          className={field}
          aria-label={`${label} unit`}
        >
          <option value="auto">auto</option>
          <option value="cells">cells</option>
          <option value="percent">%</option>
          <option value="fill">fill</option>
        </select>
        {mode === 'cells' && (
          <NumericInput value={cells} onChange={onChange} min={0} max={max} className={field} />
        )}
        {mode === 'percent' && (
          <NumericInput
            value={Math.round(percent)}
            onChange={(n) => onChange(`${n}%`)}
            min={1}
            max={100}
            className={field}
          />
        )}
      </div>
    </div>
  );
}
