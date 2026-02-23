// Left sidebar with tabs for Components and Layers

import { useState } from 'react';
import { Package, Layers, AlertTriangle } from 'lucide-react';
import { ComponentPalette } from '../palette/ComponentPalette';
import { ComponentTree } from './ComponentTree';
import { useComponentStore, useSelectionStore } from '../../stores';
import { layoutEngine } from '../../utils/layout';

type Tab = 'components' | 'layers';

export function LeftSidebar() {
  const [activeTab, setActiveTab] = useState<Tab>('layers');
  const componentStore = useComponentStore();
  const selectionStore = useSelectionStore();

  const nodesWithWarnings = layoutEngine.getNodesWithWarnings();

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('layers')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'layers'
              ? 'bg-background border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          }`}
        >
          <Layers className="w-4 h-4" />
          Layers
          {nodesWithWarnings.length > 0 && activeTab !== 'layers' && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 flex-shrink-0" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('components')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'components'
              ? 'bg-background border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          }`}
        >
          <Package className="w-4 h-4" />
          Components
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'components' && <ComponentPalette />}
        {activeTab === 'layers' && <ComponentTree warningNodeIds={new Set(nodesWithWarnings)} />}
      </div>

      {/* Warning summary — layers tab only */}
      {activeTab === 'layers' && nodesWithWarnings.length > 0 && (
        <div className="flex-shrink-0 border-t border-yellow-500/30 bg-yellow-950/20 px-3 py-2">
          <div className="flex items-center gap-1.5 text-yellow-500 text-xs font-semibold mb-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {nodesWithWarnings.length} Layout Warning{nodesWithWarnings.length !== 1 ? 's' : ''}
          </div>
          <div className="space-y-0.5">
            {nodesWithWarnings.slice(0, 3).map((nodeId) => {
              const node = findNode(componentStore.root, nodeId);
              const info = layoutEngine.getDebugInfo(nodeId);
              if (!node || !info) return null;
              return (
                <button
                  key={nodeId}
                  onClick={() => selectionStore.select(nodeId)}
                  className="w-full text-left text-[10px] text-yellow-300 hover:text-yellow-100 truncate"
                >
                  <span className="text-yellow-400 font-semibold">{node.name}:</span>{' '}
                  {info.warnings[0] && formatWarning(info.warnings[0])}
                </button>
              );
            })}
            {nodesWithWarnings.length > 3 && (
              <p className="text-[10px] text-yellow-500">+{nodesWithWarnings.length - 3} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function findNode(
  root: import('../../types').ComponentNode | null,
  id: string
): import('../../types').ComponentNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function formatWarning(warning: import('../../utils/layout').LayoutWarning): string {
  switch (warning.type) {
    case 'overflow':
      return `Overflow ${warning.axis}-axis: ${warning.amount} cols/rows`;
    case 'constraint-violation':
      return `Constraint: ${warning.constraint}`;
    case 'negative-space':
      return `Negative ${warning.dimension}`;
    case 'circular-dependency':
      return 'Circular dependency';
    default:
      return 'Layout issue';
  }
}
