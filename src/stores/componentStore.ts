// Component tree state management

import { create } from 'zustand';
import type { ComponentNode } from '../types';
import { findNodeById, findParentNode, flattenTree, cloneNode } from '../utils/treeUtils';
import { generateComponentId } from '../utils/idGenerator';
import { collectTags } from '../utils/apiTag';
import { remapShowWhen } from '../utils/navBodies';
import { treeLinksTo, withoutScreenLinks } from '../utils/screenLinks';

/** One screen of the project. For the active screen `root`/history live in the store itself. */
export interface ScreenEntry {
  id: string;
  root: ComponentNode;
  history: ComponentNode[][];
  historyIndex: number;
}

/** A new, empty screen (root of its component tree). */
export function createScreenRoot(name: string, theme = 'dracula'): ComponentNode {
  return {
    id: 'root',
    type: 'Screen',
    name,
    props: { width: 80, height: 24, theme },
    layout: { type: 'absolute' },
    style: { border: false },
    events: {},
    children: [],
    locked: false,
    hidden: false,
    collapsed: false,
  };
}

interface ComponentState {
  // Tree
  root: ComponentNode | null;
  components: Map<string, ComponentNode>; // Flat lookup

  // Screens (the entry of the active screen is only a placeholder; `root` is the live tree)
  screens: ScreenEntry[];
  activeScreenId: string;

  // History
  history: ComponentNode[][];
  historyIndex: number;
  maxHistorySize: number;

  // Actions - Tree manipulation
  setRoot: (root: ComponentNode | null) => void;
  addComponent: (parentId: string, component: Omit<ComponentNode, 'id'>, index?: number) => string;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<ComponentNode>) => void;
  moveComponent: (id: string, newParentId: string, index?: number) => void;
  duplicateComponent: (id: string) => string | null;
  groupComponents: (
    ids: string[],
    boxData: Omit<ComponentNode, 'id' | 'children'>
  ) => string | null;
  ungroupComponents: (ids: string[]) => string[];

  // Actions - Properties
  updateProps: (id: string, props: Partial<ComponentNode['props']>) => void;
  updateLayout: (id: string, layout: Partial<ComponentNode['layout']>) => void;
  updateStyle: (id: string, style: Partial<ComponentNode['style']>) => void;
  updateEvents: (id: string, events: Partial<ComponentNode['events']>) => void;

  // Actions - Screens
  addScreen: (name?: string) => string;
  switchScreen: (id: string) => void;
  removeScreen: (id: string) => void;
  renameScreen: (id: string, name: string) => void;
  duplicateScreen: (id: string) => string | null;
  moveScreen: (id: string, delta: number) => void;
  /** Replace the whole project (opening a file). */
  loadProject: (screens: { id: string; root: ComponentNode }[], activeId?: string) => void;
  /** All screens with up-to-date trees, in order. */
  getScreenRoots: () => { id: string; root: ComponentNode }[];

  // Actions - History
  undo: () => void;
  redo: () => void;
  saveHistory: () => void;

  // Queries
  getComponent: (id: string) => ComponentNode | undefined;
  getParent: (id: string) => ComponentNode | undefined;
  getChildren: (id: string) => ComponentNode[];
}

export const useComponentStore = create<ComponentState>((set, get) => ({
  // Initial state
  root: null,
  components: new Map(),
  screens: [],
  activeScreenId: '',
  history: [],
  historyIndex: -1,
  maxHistorySize: 50,

  // Set root
  setRoot: (root) => {
    set({
      root,
      components: flattenTree(root),
    });
    // The first root creates the project's first screen.
    if (root && get().screens.length === 0) {
      set({
        screens: [{ id: 'screen-1', root, history: [], historyIndex: -1 }],
        activeScreenId: 'screen-1',
      });
    }
    get().saveHistory();
  },

  // Add component
  addComponent: (parentId, componentData, index) => {
    const { root } = get();
    if (!root) {
      return '';
    }

    // Clone tree FIRST to create new references
    const newRoot = cloneNode(root);

    // Find parent in the NEW tree
    const parent = findNodeById(newRoot, parentId);
    if (!parent) {
      return '';
    }

    const id = generateComponentId();
    const newComponent: ComponentNode = {
      ...componentData,
      id,
      children: [],
    };
    // Tags must stay unique: a pasted component keeps its tag only if nobody uses it.
    if (newComponent.tag) {
      const others = get()
        .screens.filter((s) => s.id !== get().activeScreenId)
        .map((s) => s.root);
      if (collectTags([newRoot, ...others]).has(newComponent.tag)) delete newComponent.tag;
    }

    // If parent is a container and has explicit height/width, change to auto so it fits children
    if (['Box', 'Grid'].includes(parent.type)) {
      if (typeof parent.props.height === 'number') {
        parent.props.height = 'auto';
      }
      if (typeof parent.props.width === 'number' && parent.layout.direction !== 'column') {
        parent.props.width = 'auto';
      }
    }

    // Insert at index or append in the NEW tree
    if (index !== undefined) {
      parent.children.splice(index, 0, newComponent);
    } else {
      parent.children.push(newComponent);
    }

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
    return id;
  },

  // Remove component
  removeComponent: (id) => {
    const { root } = get();
    if (!root || root.id === id) return;

    // Clone tree FIRST
    const newRoot = cloneNode(root);

    // Find parent in the NEW tree
    const parent = findParentNode(newRoot, id);
    if (!parent) return;

    parent.children = parent.children.filter((child) => child.id !== id);

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Update component
  updateComponent: (id, updates) => {
    const { root } = get();
    if (!root) return;

    // Clone tree FIRST
    const newRoot = cloneNode(root);

    // Find component in the NEW tree
    const component = findNodeById(newRoot, id);
    if (!component) return;

    Object.assign(component, updates);

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Move component
  moveComponent: (id, newParentId, index) => {
    const { root } = get();
    if (!root || id === newParentId) return;

    // Clone tree FIRST
    const newRoot = cloneNode(root);

    // Find component and remove from old parent in the NEW tree
    const oldParent = findParentNode(newRoot, id);
    if (!oldParent) return;

    const componentIndex = oldParent.children.findIndex((c) => c.id === id);
    if (componentIndex === -1) return;

    const [component] = oldParent.children.splice(componentIndex, 1);

    // Add to new parent in the NEW tree
    const newParent = findNodeById(newRoot, newParentId);
    if (!newParent) {
      // Restore if new parent not found
      oldParent.children.splice(componentIndex, 0, component);
      return;
    }

    if (index !== undefined) {
      newParent.children.splice(index, 0, component);
    } else {
      newParent.children.push(component);
    }

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Duplicate component
  duplicateComponent: (id) => {
    const { root } = get();
    if (!root) return null;

    // Clone tree FIRST
    const newRoot = cloneNode(root);

    // Find component and parent in the NEW tree
    const component = findNodeById(newRoot, id);
    const parent = findParentNode(newRoot, id);
    if (!component || !parent) return null;

    const cloned = cloneNode(component);
    const idMap = new Map<string, string>([[cloned.id, generateComponentId()]]);
    cloned.id = idMap.get(cloned.id)!;
    cloned.name = `${cloned.name} Copy`;
    delete cloned.tag; // tags are unique, so a copy starts without one

    // Assign new IDs to all descendants
    function reassignIds(node: ComponentNode) {
      idMap.set(node.id, generateComponentId());
      node.id = idMap.get(node.id)!;
      delete node.tag;
      node.children.forEach(reassignIds);
    }
    cloned.children.forEach(reassignIds);
    // Bodies of a navigation element inside the copy must follow the copy of that element.
    remapShowWhen(cloned, idMap);

    // Insert after original
    const index = parent.children.findIndex((c) => c.id === id);
    parent.children.splice(index + 1, 0, cloned);

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
    return cloned.id;
  },

  // Group multiple components into a new Box
  groupComponents: (ids, boxData) => {
    const { root } = get();
    if (!root || ids.length === 0) return null;

    const newRoot = cloneNode(root);

    // All ids must share the same parent
    const parents = ids.map((id) => findParentNode(newRoot, id));
    const parentId = parents[0]?.id;
    if (!parentId || parents.some((p) => p?.id !== parentId)) return null;

    const parent = findNodeById(newRoot, parentId)!;

    // Insert Box at the earliest position of the selected nodes
    const indices = ids.map((id) => parent.children.findIndex((c) => c.id === id));
    const insertIndex = Math.min(...indices);

    // Extract selected nodes in document order
    const ordered = parent.children.filter((c) => ids.includes(c.id));
    parent.children = parent.children.filter((c) => !ids.includes(c.id));

    const newBox: ComponentNode = { ...boxData, id: generateComponentId(), children: ordered };
    parent.children.splice(insertIndex, 0, newBox);

    set({ root: newRoot, components: flattenTree(newRoot) });
    get().saveHistory();
    return newBox.id;
  },

  // Ungroup containers: promote children to parent, remove containers
  ungroupComponents: (ids) => {
    const { root } = get();
    if (!root || ids.length === 0) return [];

    const newRoot = cloneNode(root);
    const allChildIds: string[] = [];

    for (const id of ids) {
      const node = findNodeById(newRoot, id);
      const parent = findParentNode(newRoot, id);
      if (!node || !parent) continue;

      const index = parent.children.findIndex((c) => c.id === id);
      allChildIds.push(...node.children.map((c) => c.id));
      parent.children.splice(index, 1, ...node.children);
    }

    set({ root: newRoot, components: flattenTree(newRoot) });
    get().saveHistory();
    return allChildIds;
  },

  // Update props
  updateProps: (id, props) => {
    const { root } = get();
    if (!root) return;

    // Clone tree FIRST to create new references
    const newRoot = cloneNode(root);

    // Find component in the NEW tree
    const component = findNodeById(newRoot, id);
    if (!component) return;

    // Mutate the NEW tree's component
    component.props = { ...component.props, ...props };

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Update layout
  updateLayout: (id, layout) => {
    const { root } = get();
    if (!root) return;

    // Clone tree FIRST to create new references
    const newRoot = cloneNode(root);

    // Find component in the NEW tree
    const component = findNodeById(newRoot, id);
    if (!component) return;

    // Mutate the NEW tree's component
    component.layout = { ...component.layout, ...layout };

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Update style
  updateStyle: (id, style) => {
    const { root } = get();
    if (!root) return;

    // Clone tree FIRST to create new references
    const newRoot = cloneNode(root);

    // Find component in the NEW tree
    const component = findNodeById(newRoot, id);
    if (!component) return;

    // Mutate the NEW tree's component
    component.style = { ...component.style, ...style };

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Update events
  updateEvents: (id, events) => {
    const { root } = get();
    if (!root) return;

    // Clone tree FIRST to create new references
    const newRoot = cloneNode(root);

    // Find component in the NEW tree
    const component = findNodeById(newRoot, id);
    if (!component) return;

    // Mutate the NEW tree's component
    component.events = { ...component.events, ...events };

    set({
      root: newRoot,
      components: flattenTree(newRoot),
    });

    get().saveHistory();
  },

  // Save history
  saveHistory: () => {
    const { root, history, historyIndex, maxHistorySize } = get();
    if (!root) return;

    // Clone root for history
    const snapshot = cloneNode(root);

    // Remove future history if we're not at the end
    const newHistory = history.slice(0, historyIndex + 1);

    // Add new snapshot
    newHistory.push([snapshot]);

    // Limit history size
    if (newHistory.length > maxHistorySize) {
      newHistory.shift();
    }

    set({
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });
  },

  // Undo
  undo: () => {
    const { history, historyIndex } = get();

    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const snapshot = history[newIndex][0];

      set({
        root: cloneNode(snapshot),
        components: flattenTree(snapshot),
        historyIndex: newIndex,
      });
    }
  },

  // Redo
  redo: () => {
    const { history, historyIndex } = get();

    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const snapshot = history[newIndex][0];

      set({
        root: cloneNode(snapshot),
        components: flattenTree(snapshot),
        historyIndex: newIndex,
      });
    }
  },

  // ── Screens ─────────────────────────────────────────────────────────────────

  getScreenRoots: () => {
    const { screens, activeScreenId, root } = get();
    return screens.map((s) => ({
      id: s.id,
      root: s.id === activeScreenId && root ? root : s.root,
    }));
  },

  switchScreen: (id) => {
    const { screens, activeScreenId, root, history, historyIndex } = get();
    if (id === activeScreenId || !screens.some((s) => s.id === id)) return;

    // Park the live tree and its history in the screen we are leaving.
    const parked = screens.map((s) =>
      s.id === activeScreenId && root ? { ...s, root, history, historyIndex } : s
    );
    const target = parked.find((s) => s.id === id)!;
    const hasHistory = target.history.length > 0;
    set({
      screens: parked,
      activeScreenId: id,
      root: target.root,
      components: flattenTree(target.root),
      history: hasHistory ? target.history : [[cloneNode(target.root)]],
      historyIndex: hasHistory ? target.historyIndex : 0,
    });
  },

  addScreen: (name) => {
    const { screens, root, activeScreenId } = get();
    const n = screens.length + 1;
    const used = new Set(
      get()
        .getScreenRoots()
        .map((s) => s.root.name)
    );
    let title = name?.trim() || `Screen ${n}`;
    for (let i = 2; used.has(title); i++) title = `${name?.trim() || `Screen ${n}`} ${i}`;
    const theme = (root?.props.theme as string) || 'dracula';
    let id = `screen-${n}`;
    for (let i = n + 1; screens.some((s) => s.id === id); i++) id = `screen-${i}`;
    const entry: ScreenEntry = {
      id,
      root: createScreenRoot(title, theme),
      history: [],
      historyIndex: -1,
    };
    set({ screens: [...screens, entry] });
    if (!activeScreenId) {
      set({ activeScreenId: id, root: entry.root, components: flattenTree(entry.root) });
      get().saveHistory();
    } else {
      get().switchScreen(id);
    }
    return id;
  },

  removeScreen: (id) => {
    const { screens, activeScreenId } = get();
    if (screens.length <= 1) return;
    const index = screens.findIndex((s) => s.id === id);
    if (index < 0) return;
    if (id === activeScreenId) {
      get().switchScreen(screens[index === 0 ? 1 : index - 1].id);
    }
    // Buttons and menu items that opened the removed screen lose that link.
    const forgetLinks = (root: ComponentNode) =>
      treeLinksTo(root, id) ? withoutScreenLinks(root, (target) => target === id) : root;
    const remaining = get()
      .screens.filter((s) => s.id !== id)
      .map((s) => ({ ...s, root: forgetLinks(s.root) }));
    const liveRoot = get().root;
    const cleanedRoot = liveRoot ? forgetLinks(liveRoot) : liveRoot;
    set({
      screens: remaining.map((s) =>
        s.id === get().activeScreenId && cleanedRoot ? { ...s, root: cleanedRoot } : s
      ),
      ...(cleanedRoot !== liveRoot && cleanedRoot
        ? { root: cleanedRoot, components: flattenTree(cleanedRoot) }
        : {}),
    });
  },

  renameScreen: (id, name) => {
    const title = name.trim();
    if (!title) return;
    if (id === get().activeScreenId) {
      get().updateComponent('root', { name: title });
      return;
    }
    set({
      screens: get().screens.map((s) =>
        s.id === id ? { ...s, root: { ...s.root, name: title } } : s
      ),
    });
  },

  duplicateScreen: (id) => {
    const source = get()
      .getScreenRoots()
      .find((s) => s.id === id);
    if (!source) return null;
    const idMap = new Map<string, string>();
    const copy = cloneNode(source.root);
    copy.name = `${copy.name} Copy`;
    delete copy.tag; // code names are unique
    const reassign = (node: ComponentNode) => {
      if (node !== copy) {
        idMap.set(node.id, generateComponentId());
        node.id = idMap.get(node.id)!;
        delete node.tag;
      }
      node.children.forEach(reassign);
    };
    reassign(copy);
    idMap.set(copy.id, copy.id);
    remapShowWhen(copy, idMap);

    const { screens } = get();
    let newId = `screen-${screens.length + 1}`;
    for (let i = screens.length + 2; screens.some((s) => s.id === newId); i++)
      newId = `screen-${i}`;
    const at = screens.findIndex((s) => s.id === id) + 1;
    const entry: ScreenEntry = { id: newId, root: copy, history: [], historyIndex: -1 };
    set({ screens: [...screens.slice(0, at), entry, ...screens.slice(at)] });
    get().switchScreen(newId);
    return newId;
  },

  moveScreen: (id, delta) => {
    const { screens } = get();
    const from = screens.findIndex((s) => s.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= screens.length) return;
    const next = [...screens];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ screens: next });
  },

  loadProject: (loaded, activeId) => {
    if (loaded.length === 0) return;
    const entries: ScreenEntry[] = loaded.map((s) => ({
      id: s.id,
      root: s.root,
      history: [],
      historyIndex: -1,
    }));
    const active = entries.find((s) => s.id === activeId) ?? entries[0];
    set({
      screens: entries,
      activeScreenId: active.id,
      root: active.root,
      components: flattenTree(active.root),
      history: [],
      historyIndex: -1,
    });
    get().saveHistory();
  },

  // Get component
  getComponent: (id) => {
    return get().components.get(id);
  },

  // Get parent
  getParent: (id) => {
    const { root } = get();
    if (!root) return undefined;
    const parent = findParentNode(root, id);
    return parent || undefined;
  },

  // Get children
  getChildren: (id) => {
    const component = get().getComponent(id);
    return component?.children || [];
  },
}));
