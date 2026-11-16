// Modal wrapper for export panel

import { lazy, Suspense } from 'react';
import { X } from 'lucide-react';

// The exporters and their runtimes are large and only needed here: load them when the dialog opens.
const ExportPanel = lazy(() => import('./ExportPanel').then((m) => ({ default: m.ExportPanel })));

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportModal({ isOpen, onClose }: ExportModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-4xl h-[80vh] bg-background border border-border rounded-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Export Design</h2>
          <button onClick={onClose} className="p-2 hover:bg-accent rounded" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={<div className="p-4 text-sm text-muted-foreground">Loading exporters...</div>}
          >
            <ExportPanel />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
