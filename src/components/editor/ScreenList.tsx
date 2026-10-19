// List of the project's screens: switch, add, rename, duplicate, reorder and delete.

import { useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Monitor, Plus, Trash2 } from 'lucide-react';
import { useComponentStore, useSelectionStore } from '../../stores';
import { ApiNameField } from '../properties/PropertyPanel';

export function ScreenList() {
  const componentStore = useComponentStore();
  const selectionStore = useSelectionStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const screens = componentStore.getScreenRoots();
  if (screens.length === 0) return null;
  const activeRoot = screens.find((s) => s.id === componentStore.activeScreenId)?.root ?? null;

  const open = (id: string) => {
    componentStore.switchScreen(id);
    selectionStore.clearSelection();
  };

  const commitRename = (id: string) => {
    if (draft.trim()) componentStore.renameScreen(id, draft);
    setRenaming(null);
  };

  const iconButton =
    'p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Screens
        </span>
        <button
          type="button"
          title="Add screen"
          onClick={() => {
            const id = componentStore.addScreen();
            if (id) selectionStore.clearSelection();
          }}
          className={iconButton}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-1 pb-1">
        {screens.map(({ id, root }, index) => {
          const active = id === componentStore.activeScreenId;
          return (
            <div
              key={id}
              onClick={() => !active && open(id)}
              onDoubleClick={() => {
                setRenaming(id);
                setDraft(root.name);
              }}
              className={`group flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-xs ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              <Monitor className="w-3.5 h-3.5 shrink-0" />
              {renaming === id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 px-1 bg-input border border-primary rounded text-xs focus:outline-hidden"
                />
              ) : (
                <>
                  <span className="flex-1 min-w-0 truncate">{root.name}</span>
                  {root.tag && (
                    <span className="font-mono text-[10px] text-muted-foreground truncate">
                      {root.tag}
                    </span>
                  )}
                </>
              )}
              <span
                className="hidden group-hover:flex items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => componentStore.moveScreen(id, -1)}
                  className={iconButton}
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="Move down"
                  disabled={index === screens.length - 1}
                  onClick={() => componentStore.moveScreen(id, 1)}
                  className={iconButton}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="Duplicate screen"
                  onClick={() => {
                    if (componentStore.duplicateScreen(id)) selectionStore.clearSelection();
                  }}
                  className={iconButton}
                >
                  <Copy className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="Delete screen"
                  disabled={screens.length <= 1}
                  onClick={() => {
                    if (window.confirm(`Delete the screen "${root.name}"?`)) {
                      componentStore.removeScreen(id);
                      selectionStore.clearSelection();
                    }
                  }}
                  className={`${iconButton} hover:text-destructive`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {activeRoot && (
        <div className="-mx-0">
          <ApiNameField component={activeRoot} label="Screen code name" />
        </div>
      )}
    </div>
  );
}
