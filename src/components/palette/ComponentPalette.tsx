// Component palette with categorized components

import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { COMPONENT_LIBRARY, CATEGORIES, getComponentsByCategory } from '../../constants/components';
import { useComponentStore, useSelectionStore } from '../../stores';
import type { ComponentNode } from '../../types';
import { dragStore } from '../../hooks/useDragAndDrop';

export function ComponentPalette() {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(CATEGORIES.map((c) => c.id))
  );
  const [search, setSearch] = useState('');
  const componentStore = useComponentStore();

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const addComponent = (type: keyof typeof COMPONENT_LIBRARY) => {
    const def = COMPONENT_LIBRARY[type];
    let parentId = componentStore.root?.id;

    if (!parentId) {
      // Create root if it doesn't exist
      const root: ComponentNode = {
        id: 'root',
        type: 'Box',
        name: 'Root',
        props: { width: 80, height: 24, theme: 'dracula' },
        layout: {
          type: 'flexbox',
          direction: 'column',
          gap: 1,
          padding: 2,
        },
        style: {
          border: true,
          borderStyle: 'single',
        },
        events: {},
        children: [],
        locked: false,
        hidden: false,
        collapsed: false,
      };
      componentStore.setRoot(root);
      parentId = 'root'; // Now we have a parent to add to
    }

    const newComponent: Omit<ComponentNode, 'id'> = {
      type: def.type,
      name: def.name,
      props: { ...def.defaultProps },
      layout: { ...def.defaultLayout },
      style: { ...def.defaultStyle },
      events: { ...def.defaultEvents },
      children: [],
      locked: false,
      hidden: false,
      collapsed: false,
    };

    const id = componentStore.addComponent(parentId, newComponent);

    // Select the newly added component
    if (id) {
      useSelectionStore.getState().select(id);
    }
  };

  const query = search.toLowerCase().trim();

  return (
    <div className="p-2">
      {/* Search */}
      <div className="relative mb-2">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search components..."
          className="w-full pl-6 pr-2 py-1 bg-input border border-border/50 rounded text-[11px] focus:border-primary focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        {CATEGORIES.map((category) => {
          const isExpanded = expandedCategories.has(category.id);
          const allComponents = getComponentsByCategory(category.id);
          const components = query
            ? allComponents.filter(
                (c) =>
                  c.name.toLowerCase().includes(query) ||
                  c.description.toLowerCase().includes(query)
              )
            : allComponents;

          if (query && components.length === 0) return null;

          const isOpen = query ? true : isExpanded;

          return (
            <div key={category.id}>
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(category.id)}
                className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-accent rounded text-xs font-medium"
              >
                {isOpen ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                {category.name}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {components.length}
                </span>
              </button>

              {/* Components */}
              {isOpen && (
                <div className="ml-1 mt-0.5 space-y-0.5">
                  {components.map((component) => {
                    const IconComponent = (LucideIcons as any)[component.icon];

                    return (
                      <button
                        key={component.type}
                        onClick={() => addComponent(component.type)}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
                          dragStore.startDrag({
                            type: 'new-component',
                            componentType: component.type,
                          });
                          e.dataTransfer.effectAllowed = 'copy';
                          e.dataTransfer.setData('text/plain', component.type);
                        }}
                        onDragEnd={() => {
                          dragStore.endDrag();
                        }}
                        className="w-full px-2 py-1 rounded border border-border hover:bg-accent hover:border-accent-foreground transition-colors flex items-center gap-2 text-left cursor-move"
                      >
                        {IconComponent && (
                          <IconComponent className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-xs truncate">{component.name}</div>
                          <div className="text-[10px] text-muted-foreground truncate leading-tight">
                            {component.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
