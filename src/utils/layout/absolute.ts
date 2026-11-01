// Absolute positioning calculator

import type { ComponentNode } from '../../types';
import type { ComputedLayout } from './types';
import { parsePercent, resolvePercent } from './dimension';

export function calculateAbsoluteLayout(
  container: ComponentNode,
  availableWidth: number,
  availableHeight: number
): Map<string, ComputedLayout> {
  const layouts = new Map<string, ComputedLayout>();

  const padding = typeof container.layout.padding === 'number' ? container.layout.padding : 0;

  container.children.forEach((child) => {
    // Get absolute position from child's layout
    const x = (child.layout.x || 0) + padding;
    const y = (child.layout.y || 0) + padding;

    // Resolve dimensions
    let width = 20; // default
    let height = 3; // default

    if (typeof child.props.width === 'number') {
      width = child.props.width;
    } else if (child.props.width === 'fill') {
      width = availableWidth - x - padding;
    } else if (parsePercent(child.props.width) !== null) {
      width = resolvePercent(parsePercent(child.props.width)!, availableWidth - padding * 2);
    }

    if (typeof child.props.height === 'number') {
      height = child.props.height;
    } else if (child.props.height === 'fill') {
      height = availableHeight - y - padding;
    } else if (parsePercent(child.props.height) !== null) {
      height = resolvePercent(parsePercent(child.props.height)!, availableHeight - padding * 2);
    }

    layouts.set(child.id, {
      x,
      y,
      width,
      height,
      contentBox: { x, y, width, height },
      paddingBox: { x, y, width, height },
      marginBox: { x, y, width, height },
    });
  });

  return layouts;
}
