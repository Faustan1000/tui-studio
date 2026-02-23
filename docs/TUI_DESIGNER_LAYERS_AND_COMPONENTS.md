# TUI Designer - Layers & Reusable Components

**Inspired by Figma's component and layer system**

This document describes the layer organization system and reusable component library features, similar to Figma.

---

## 🎨 Layer System (Figma-style)

### Concept

Organize your TUI design into logical layers, just like Figma:

- **Pages**: Top-level organization (e.g., "Login Screen", "Dashboard", "Settings")
- **Frames**: Artboards/screens within pages
- **Layers**: Individual components with hierarchy
- **Groups**: Organize related components

### Data Model

```typescript
// src/types/layers.ts

export interface Project {
  id: string;
  name: string;
  created: Date;
  modified: Date;
  pages: Page[];
  componentLibrary: ComponentLibrary;
}

export interface Page {
  id: string;
  name: string;
  frames: Frame[];
  order: number;
}

export interface Frame {
  id: string;
  name: string;
  width: number; // Terminal columns
  height: number; // Terminal rows
  root: LayerNode;
  backgroundColor?: string;
}

export interface LayerNode {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  locked: boolean;
  opacity: number;

  // Component instance reference
  componentId?: string; // If this is an instance of a reusable component

  // Actual component data
  component?: ComponentNode;

  // Children
  children: LayerNode[];

  // Metadata
  expanded: boolean; // In layer panel
  order: number;
}

export type LayerType = 'frame' | 'group' | 'component' | 'instance';
```

### Layer Panel UI

```
┌─ Layers ────────────────────────────┐
│ 🔍 Search layers...                 │
├─────────────────────────────────────┤
│                                     │
│ 📄 Login Screen                     │
│   📦 Container                    👁 │
│     ├─ 📝 Title                   🔒 │
│     ├─ 📦 Form Fields               │
│     │   ├─ 🔢 Username Input         │
│     │   └─ 🔒 Password Input         │
│     └─ 📦 Button Row                │
│         ├─ 🔘 Login Btn (Instance)  │
│         └─ 🔘 Cancel Btn (Instance) │
│                                     │
│ 📄 Dashboard                        │
│   📦 Header                         │
│   📦 Sidebar                        │
│   📦 Content                        │
│                                     │
└─────────────────────────────────────┘

Icons:
📄 = Frame/Screen
📦 = Container/Box
📝 = Text
🔢 = Input
🔘 = Button
👁 = Visible/Hidden toggle
🔒 = Locked
```

### Layer Actions

```typescript
interface LayerActions {
  // Visibility
  toggleVisibility: (layerId: string) => void;
  showLayer: (layerId: string) => void;
  hideLayer: (layerId: string) => void;

  // Lock
  toggleLock: (layerId: string) => void;
  lockLayer: (layerId: string) => void;
  unlockLayer: (layerId: string) => void;

  // Organization
  renameLayer: (layerId: string, name: string) => void;
  reorderLayer: (layerId: string, newIndex: number) => void;
  groupLayers: (layerIds: string[], groupName: string) => void;
  ungroupLayer: (groupId: string) => void;

  // Navigation
  selectLayer: (layerId: string) => void;
  expandLayer: (layerId: string) => void;
  collapseLayer: (layerId: string) => void;

  // Duplication
  duplicateLayer: (layerId: string) => void;

  // Deletion
  deleteLayer: (layerId: string) => void;
}
```

---

## 🧩 Reusable Components (Figma-style)

### Concept

Create **master components** that can be instantiated multiple times. Changes to the master automatically propagate to all instances.

**Key Features:**

- **Component Library**: Centralized collection of reusable components
- **Instances**: Linked copies that inherit from master
- **Overrides**: Customize instances without breaking the link
- **Variants**: Multiple versions of the same component (Primary, Secondary, Disabled)
- **Publishing**: Share component libraries across projects

### Component System Architecture

```typescript
// src/types/components-library.ts

export interface ComponentLibrary {
  components: Map<string, MasterComponent>;
  categories: ComponentCategory[];
}

export interface ComponentCategory {
  id: string;
  name: string;
  icon: string;
  components: string[]; // Component IDs
}

export interface MasterComponent {
  id: string;
  name: string;
  description: string;
  category: string;
  thumbnail?: string;

  // The actual component tree
  root: ComponentNode;

  // Customizable properties (props that can be overridden)
  props: ComponentProp[];

  // Variants (e.g., "Primary", "Secondary", "Disabled")
  variants?: ComponentVariant[];

  // Metadata
  created: Date;
  modified: Date;
  author?: string;
  tags: string[];
}

export interface ComponentProp {
  key: string;
  label: string;
  type: 'text' | 'number' | 'color' | 'boolean' | 'select';
  defaultValue: unknown;
  options?: string[]; // For select type
  description?: string;
}

export interface ComponentVariant {
  id: string;
  name: string;
  props: Record<string, unknown>; // Override values
}

export interface ComponentInstance {
  id: string;
  componentId: string; // Reference to master

  // Property overrides
  overrides: Record<string, unknown>;

  // Child component overrides (for nested instances)
  childOverrides: Map<string, Record<string, unknown>>;

  // Break the link to master (detach)
  detached: boolean;
}
```

### Example: Button Component

```typescript
const buttonComponent: MasterComponent = {
  id: 'btn-001',
  name: 'Button',
  description: 'Standard button with variants',
  category: 'controls',
  props: [
    {
      key: 'label',
      label: 'Label',
      type: 'text',
      defaultValue: 'Button',
      description: 'Button text',
    },
    {
      key: 'variant',
      label: 'Variant',
      type: 'select',
      defaultValue: 'primary',
      options: ['primary', 'secondary', 'danger'],
      description: 'Visual style',
    },
    {
      key: 'disabled',
      label: 'Disabled',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'width',
      label: 'Width',
      type: 'number',
      defaultValue: 'auto',
    },
  ],
  variants: [
    {
      id: 'primary',
      name: 'Primary',
      props: {
        backgroundColor: 'blue',
        color: 'white',
        bold: true,
      },
    },
    {
      id: 'secondary',
      name: 'Secondary',
      props: {
        backgroundColor: 'transparent',
        color: 'white',
        borderColor: 'white',
      },
    },
    {
      id: 'danger',
      name: 'Danger',
      props: {
        backgroundColor: 'red',
        color: 'white',
        bold: true,
      },
    },
  ],
  root: {
    id: 'root',
    type: 'Button',
    name: 'Button',
    props: {
      label: '{{label}}', // Variable
      width: '{{width}}',
    },
    style: {
      border: true,
      borderStyle: 'rounded',
      backgroundColor: '{{backgroundColor}}',
      color: '{{color}}',
      bold: '{{bold}}',
    },
    layout: {
      type: 'none',
      padding: { top: 0, right: 2, bottom: 0, left: 2 },
    },
    events: {
      onClick: 'handleClick',
    },
    children: [],
  },
  created: new Date(),
  modified: new Date(),
  tags: ['button', 'control', 'form'],
};
```

### Using Component Instances

```typescript
// Create an instance of the Button component
const loginButton: ComponentInstance = {
  id: 'btn-inst-001',
  componentId: 'btn-001', // Links to master
  overrides: {
    label: 'Login',
    variant: 'primary',
    width: 20,
  },
  childOverrides: new Map(),
  detached: false,
};

// Another instance with different overrides
const cancelButton: ComponentInstance = {
  id: 'btn-inst-002',
  componentId: 'btn-001',
  overrides: {
    label: 'Cancel',
    variant: 'secondary',
    width: 20,
  },
  childOverrides: new Map(),
  detached: false,
};
```

### Component Panel UI

```
┌─ Components ────────────────────────┐
│ 🔍 Search components...             │
├─────────────────────────────────────┤
│                                     │
│ 📚 Your Components                  │
│                                     │
│ ┌─ Controls ──────────────────┐    │
│ │  🔘 Button                   │    │
│ │  ☑️  Checkbox                 │    │
│ │  🔽 Dropdown                 │    │
│ │  📝 Text Input               │    │
│ └─────────────────────────────┘    │
│                                     │
│ ┌─ Layout ────────────────────┐    │
│ │  📦 Card                     │    │
│ │  📋 Form Group               │    │
│ │  🏗️  Split View               │    │
│ └─────────────────────────────┘    │
│                                     │
│ ┌─ Navigation ────────────────┐    │
│ │  🧭 Tab Bar                  │    │
│ │  📑 Menu                     │    │
│ │  🍔 Hamburger Menu           │    │
│ └─────────────────────────────┘    │
│                                     │
│ + Create Component                  │
│                                     │
└─────────────────────────────────────┘
```

### Component Actions

```typescript
interface ComponentActions {
  // Creation
  createComponent: (node: ComponentNode, name: string) => MasterComponent;
  createComponentFromSelection: (selection: LayerNode[]) => MasterComponent;

  // Instantiation
  createInstance: (componentId: string, parentId: string) => ComponentInstance;

  // Editing
  editComponent: (componentId: string) => void; // Enter edit mode
  updateComponentMaster: (componentId: string, updates: Partial<ComponentNode>) => void;

  // Instance management
  updateInstance: (instanceId: string, overrides: Record<string, unknown>) => void;
  resetInstanceOverride: (instanceId: string, propKey: string) => void;
  detachInstance: (instanceId: string) => void; // Break link, convert to regular component

  // Propagation
  pushUpdatesToInstances: (componentId: string) => void; // Sync all instances

  // Organization
  renameComponent: (componentId: string, name: string) => void;
  categorizeComponent: (componentId: string, categoryId: string) => void;
  tagComponent: (componentId: string, tags: string[]) => void;
  deleteComponent: (componentId: string) => void;

  // Publishing
  exportComponentLibrary: (componentIds: string[]) => void;
  importComponentLibrary: (libraryData: ComponentLibrary) => void;
}
```

---

## 🏗️ Implementation

### Phase 1: Layer System (Week 9-10)

**Tasks:**

**9.1 Layer Data Model** (`src/stores/layerStore.ts`)

```typescript
interface LayerState {
  pages: Page[];
  currentPageId: string;
  currentFrameId: string;

  // Actions
  addPage: (name: string) => void;
  deletePage: (pageId: string) => void;
  renamePage: (pageId: string, name: string) => void;

  addFrame: (pageId: string, name: string, width: number, height: number) => void;
  deleteFrame: (frameId: string) => void;

  addLayer: (frameId: string, layer: LayerNode) => void;
  updateLayer: (layerId: string, updates: Partial<LayerNode>) => void;
  deleteLayer: (layerId: string) => void;

  toggleVisibility: (layerId: string) => void;
  toggleLock: (layerId: string) => void;

  groupLayers: (layerIds: string[]) => void;
  ungroupLayer: (groupId: string) => void;
}
```

**9.2 Layer Panel Component** (`src/components/layers/`)

- [ ] `LayerPanel.tsx` - Main layer panel
- [ ] `LayerTree.tsx` - Hierarchical tree view
- [ ] `LayerItem.tsx` - Individual layer item
- [ ] `LayerContextMenu.tsx` - Right-click menu
- [ ] Drag-and-drop reordering
- [ ] Search and filter layers
- [ ] Multi-select layers

**9.3 Page Management** (`src/components/pages/`)

- [ ] `PageTabs.tsx` - Tab bar for pages
- [ ] `PageContextMenu.tsx` - Page actions
- [ ] Add/delete/rename pages
- [ ] Switch between pages

**9.4 Frame/Artboard System**

- [ ] `FrameSelector.tsx` - Select frame on canvas
- [ ] Multiple frames per page
- [ ] Frame thumbnails
- [ ] Navigate between frames

---

### Phase 2: Component Library (Week 11-12)

**Tasks:**

**11.1 Component Library Data** (`src/stores/componentLibraryStore.ts`)

```typescript
interface ComponentLibraryState {
  library: ComponentLibrary;

  // Master components
  createMasterComponent: (node: ComponentNode, name: string, props: ComponentProp[]) => void;
  updateMasterComponent: (id: string, updates: Partial<MasterComponent>) => void;
  deleteMasterComponent: (id: string) => void;

  // Instances
  createInstance: (componentId: string) => ComponentInstance;
  updateInstance: (instanceId: string, overrides: Record<string, unknown>) => void;
  detachInstance: (instanceId: string) => void;

  // Propagation
  propagateChanges: (componentId: string) => void;

  // Categories
  createCategory: (name: string) => void;
  assignCategory: (componentId: string, categoryId: string) => void;
}
```

**11.2 Component Panel** (`src/components/components/`)

- [ ] `ComponentPanel.tsx` - Main component library panel
- [ ] `ComponentGrid.tsx` - Grid view of components
- [ ] `ComponentItem.tsx` - Draggable component item
- [ ] `ComponentEditor.tsx` - Edit component properties
- [ ] `ComponentPreview.tsx` - Preview component
- [ ] Search components
- [ ] Filter by category/tags

**11.3 Component Creation Flow**

- [ ] "Create Component" button
- [ ] Component name dialog
- [ ] Define customizable props
- [ ] Select which properties can be overridden
- [ ] Add to library

**11.4 Instance Management**

- [ ] Visual indicator for instances (purple outline, like Figma)
- [ ] "Go to Master Component" button
- [ ] Override indicators in property panel
- [ ] Reset override button per property
- [ ] "Detach Instance" action

**11.5 Component Variants**

- [ ] Define variant properties
- [ ] Variant switcher in property panel
- [ ] Visual variant preview
- [ ] Apply variant presets

**11.6 Publishing/Sharing**

- [ ] Export library as `.tuicomp` file
- [ ] Import library from file
- [ ] Component library marketplace (future)

---

## 🎨 UI/UX Patterns

### Component Highlighting

**Master Component** (in component library):

```
┌─────────────────┐
│  🔘 Button      │ ← Purple icon
│  ├─ Primary     │
│  ├─ Secondary   │
│  └─ Danger      │
└─────────────────┘
```

**Component Instance** (in layer panel):

```
┌─────────────────────────┐
│ 📄 Login Screen         │
│   └─ 🔘 Button Instance │ ← Purple icon + diamond indicator
│       (Login)           │ ← Shows override value
└─────────────────────────┘
```

### Property Panel for Instances

```
┌─ Properties ─────────────────────┐
│                                  │
│ 🔘 Button Instance               │
│ ↗ Go to Master Component         │
│                                  │
│ Overrides:                       │
│ ┌───────────────────────────┐   │
│ │ Label: Login         ↻    │   │ ← Override active, reset button
│ └───────────────────────────┘   │
│                                  │
│ ┌───────────────────────────┐   │
│ │ Variant: Primary          │   │ ← Default value
│ └───────────────────────────┘   │
│                                  │
│ ┌───────────────────────────┐   │
│ │ Width: 20            ↻    │   │ ← Override active
│ └───────────────────────────┘   │
│                                  │
│ [ Detach Instance ]              │
│                                  │
└──────────────────────────────────┘
```

---

## 🔄 Workflow Examples

### Example 1: Create Button Component

1. Design a button on canvas
2. Select the button layer
3. Right-click → "Create Component"
4. Name it "Button"
5. Define props:
   - `label` (text)
   - `variant` (select: primary, secondary, danger)
   - `width` (number)
6. Component appears in library

### Example 2: Use Button Instances

1. Drag "Button" from component library to canvas
2. Instance appears with default values
3. Override `label` to "Login"
4. Override `variant` to "primary"
5. Drag another instance
6. Override `label` to "Cancel"
7. Override `variant` to "secondary"

### Example 3: Update Master Component

1. Find "Button" in component library
2. Click "Edit Component"
3. Change border radius to "rounded"
4. Save changes
5. **All instances automatically update** with new border radius
6. Instances keep their overrides (label, variant)

### Example 4: Create Component Library

1. Create multiple components (Button, Input, Card, etc.)
2. Organize into categories (Controls, Layout, Forms)
3. Click "Export Library"
4. Save as `my-tui-components.tuicomp`
5. Share with team or community

---

## 📦 Component Library File Format

```typescript
// .tuicomp file (JSON)
interface ComponentLibraryFile {
  version: string;
  name: string;
  description: string;
  author: string;
  created: string;
  modified: string;

  components: MasterComponent[];
  categories: ComponentCategory[];

  // Metadata
  preview?: string; // Base64 thumbnail
  license?: string;
  repository?: string;
  tags: string[];
}
```

**Example:**

```json
{
  "version": "1.0.0",
  "name": "My TUI Components",
  "description": "Reusable components for terminal UIs",
  "author": "Your Name",
  "created": "2026-02-09T10:00:00Z",
  "modified": "2026-02-09T15:30:00Z",
  "components": [
    {
      "id": "btn-001",
      "name": "Button",
      "description": "Standard button",
      "category": "controls",
      "props": [...],
      "root": {...}
    }
  ],
  "categories": [
    {
      "id": "cat-001",
      "name": "Controls",
      "icon": "Sliders",
      "components": ["btn-001"]
    }
  ],
  "tags": ["button", "form", "controls"]
}
```

---

## 🚀 Benefits

### For Designers

- **Organization**: Keep designs structured with pages and layers
- **Consistency**: Reuse components across screens
- **Efficiency**: Update once, propagate everywhere
- **Collaboration**: Share component libraries with team

### For Developers

- **DRY Principle**: Single source of truth for components
- **Type Safety**: Generated code maintains component contracts
- **Flexibility**: Override what you need, inherit the rest
- **Scalability**: Build complex UIs from simple building blocks

---

## 📊 Success Metrics

- Average components per project: 5-10
- Average instances per component: 3-5
- Time saved vs manual copying: 60%+
- Component library adoption: 80% of power users

---

**This system brings Figma's powerful component model to TUI design!** 🎨
