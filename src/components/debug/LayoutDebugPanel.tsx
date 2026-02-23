// Layout debug panel for showing warnings and layout info

import { AlertTriangle } from 'lucide-react';
import { useComponentStore, useSelectionStore } from '../../stores';
import { layoutEngine } from '../../utils/layout';

export function LayoutDebugPanel() {
  const componentStore = useComponentStore();
  const selectionStore = useSelectionStore();

  const nodesWithWarnings = layoutEngine.getNodesWithWarnings();

  if (!componentStore.root || nodesWithWarnings.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border bg-background">
      {/* Warnings Summary */}
      <div className="p-3 border-b border-border bg-yellow-950/20">
        <div className="flex items-center gap-2 text-yellow-500 text-sm mb-2">
          <AlertTriangle className="w-4 h-4" />
          <span className="font-semibold">
            {nodesWithWarnings.length} Layout Warning{nodesWithWarnings.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="space-y-1 text-xs">
          {nodesWithWarnings.slice(0, 3).map((nodeId) => {
            const node = findNodeById(componentStore.root, nodeId);
            const debugInfo = layoutEngine.getDebugInfo(nodeId);
            if (!node || !debugInfo) return null;

            return (
              <div
                key={nodeId}
                className="flex items-start gap-2 cursor-pointer hover:bg-yellow-950/30 p-1 rounded"
                onClick={() => selectionStore.select(nodeId)}
              >
                <span className="text-yellow-400 font-semibold">{node.name}:</span>
                <span className="text-yellow-300">
                  {debugInfo.warnings.map((w) => formatWarning(w)).join(', ')}
                </span>
              </div>
            );
          })}
          {nodesWithWarnings.length > 3 && (
            <div className="text-yellow-400 text-xs">
              ... and {nodesWithWarnings.length - 3} more
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatWarning(warning: import('../../utils/layout').LayoutWarning): string {
  switch (warning.type) {
    case 'overflow':
      return `Overflow ${warning.axis}-axis: ${warning.amount} cols/rows`;
    case 'constraint-violation':
      return `Constraint violation: ${warning.constraint}`;
    case 'negative-space':
      return `Negative ${warning.dimension}`;
    case 'circular-dependency':
      return 'Circular dependency detected';
    default:
      return 'Unknown warning';
  }
}

function findNodeById(
  root: import('../../types').ComponentNode | null,
  id: string
): import('../../types').ComponentNode | null {
  if (!root) return null;
  if (root.id === id) return root;

  for (const child of root.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }

  return null;
}
