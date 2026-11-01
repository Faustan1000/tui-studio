import { describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../src/stores/canvasStore';
import { createScreenRoot } from '../src/stores/componentStore';

describe('canvas size', () => {
  it('starts as big as a new screen, so nothing overflows by default', () => {
    const { width, height } = useCanvasStore.getState();
    const root = createScreenRoot('S');
    expect([root.props.width, root.props.height]).toEqual([width, height]);
  });

  it('does not notify subscribers when the size is unchanged', () => {
    // Responsive mode sets the size from an effect; a notification per call looped forever.
    const { setCanvasSize, width, height } = useCanvasStore.getState();
    const listener = vi.fn();
    const unsubscribe = useCanvasStore.subscribe(listener);
    setCanvasSize(width, height);
    expect(listener).not.toHaveBeenCalled();
    setCanvasSize(width + 1, height);
    expect(listener).toHaveBeenCalledTimes(1);
    setCanvasSize(width, height);
    unsubscribe();
  });
});
