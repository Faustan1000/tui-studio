# TUI Designer - Quick Start Guide

Get your TUI Designer project up and running in 10 minutes.

---

## 🚀 Initialize Project

```bash
# Create new Vite project
npm create vite@latest tui-designer -- --template react-ts
cd tui-designer

# Install core dependencies
npm install

# Install additional packages
npm install zustand react-router-dom

# Install UI dependencies
npm install tailwindcss autoprefixer postcss
npm install lucide-react clsx tailwind-merge class-variance-authority

# Install TUI preview
npm install @opentui/core @opentui/react

# Install drag-and-drop
npm install react-dnd react-dnd-html5-backend

# Install code editor
npm install @monaco-editor/react

# Install dev dependencies
npm install -D @types/node

# Initialize Tailwind
npx tailwindcss init -p
```

---

## ⚙️ Configure Tailwind CSS

Update `tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
```

Update `src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

---

## 📁 Create File Structure

```bash
mkdir -p src/{components,stores,types,utils,hooks,constants}
mkdir -p src/components/{common,editor,palette,properties,export,preview,ui}
mkdir -p src/utils/{codeGen,layout,validation}
```

Create the structure:

```
src/
├── components/
│   ├── common/
│   ├── editor/
│   ├── palette/
│   ├── properties/
│   ├── export/
│   ├── preview/
│   └── ui/
├── stores/
├── types/
├── utils/
│   ├── codeGen/
│   ├── layout/
│   └── validation/
├── hooks/
├── constants/
└── App.tsx
```

---

## 🎯 Create Type Definitions

Create `src/types/components.ts`:

```typescript
export type ComponentType = 'Box' | 'TextInput' | 'Button' | 'Text' | 'List';

export interface ComponentNode {
  id: string;
  type: ComponentType;
  name: string;
  props: Record<string, unknown>;
  layout: {
    type: 'flexbox' | 'none';
    direction?: 'row' | 'column';
    gap?: number;
    padding?: number;
  };
  style: {
    border?: boolean;
    borderStyle?: 'single' | 'double' | 'rounded';
    color?: string;
    backgroundColor?: string;
  };
  children: ComponentNode[];
}
```

---

## 🗂️ Create First Store

Create `src/stores/componentStore.ts`:

```typescript
import { create } from 'zustand';
import type { ComponentNode } from '../types/components';

interface ComponentState {
  root: ComponentNode | null;
  components: Map<string, ComponentNode>;

  addComponent: (parentId: string, component: ComponentNode) => void;
  updateComponent: (id: string, updates: Partial<ComponentNode>) => void;
  removeComponent: (id: string) => void;
}

export const useComponentStore = create<ComponentState>((set, get) => ({
  root: null,
  components: new Map(),

  addComponent: (parentId, component) => {
    set((state) => {
      const parent = state.components.get(parentId);
      if (!parent) return state;

      parent.children.push(component);
      const newComponents = new Map(state.components);
      newComponents.set(component.id, component);
      newComponents.set(parentId, parent);

      return { components: newComponents };
    });
  },

  updateComponent: (id, updates) => {
    set((state) => {
      const component = state.components.get(id);
      if (!component) return state;

      const updated = { ...component, ...updates };
      const newComponents = new Map(state.components);
      newComponents.set(id, updated);

      return { components: newComponents };
    });
  },

  removeComponent: (id) => {
    set((state) => {
      const newComponents = new Map(state.components);
      newComponents.delete(id);

      return { components: newComponents };
    });
  },
}));
```

---

## 🎨 Create Basic Editor Layout

Create `src/components/editor/EditorLayout.tsx`:

```tsx
import React from 'react';

interface EditorLayoutProps {
  palette: React.ReactNode;
  canvas: React.ReactNode;
  properties: React.ReactNode;
}

export function EditorLayout({ palette, canvas, properties }: EditorLayoutProps) {
  return (
    <div className="flex h-screen w-screen bg-background">
      {/* Left Sidebar - Component Palette */}
      <div className="w-64 border-r border-border bg-card">{palette}</div>

      {/* Center - Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="h-14 border-b border-border bg-card px-4 flex items-center">
          <h1 className="text-lg font-semibold">TUI Designer</h1>
        </div>

        {/* Canvas */}
        <div className="flex-1 overflow-auto">{canvas}</div>
      </div>

      {/* Right Sidebar - Properties */}
      <div className="w-80 border-l border-border bg-card">{properties}</div>
    </div>
  );
}
```

---

## 🧩 Create Component Palette

Create `src/components/palette/ComponentPalette.tsx`:

```tsx
import React from 'react';
import { Square, Type, RectangleHorizontal, List } from 'lucide-react';

const COMPONENTS = [
  { type: 'Box', name: 'Box', icon: Square, description: 'Container' },
  { type: 'Text', name: 'Text', icon: Type, description: 'Static text' },
  { type: 'Button', name: 'Button', icon: RectangleHorizontal, description: 'Button' },
  { type: 'List', name: 'List', icon: List, description: 'Selectable list' },
];

export function ComponentPalette() {
  return (
    <div className="p-4">
      <h2 className="text-sm font-semibold mb-4 text-muted-foreground">Components</h2>

      <div className="space-y-2">
        {COMPONENTS.map((component) => (
          <button
            key={component.type}
            className="w-full p-3 rounded-lg border border-border hover:bg-accent hover:border-accent-foreground transition-colors flex items-center gap-3 text-left"
          >
            <component.icon className="w-5 h-5 text-muted-foreground" />
            <div className="flex-1">
              <div className="font-medium text-sm">{component.name}</div>
              <div className="text-xs text-muted-foreground">{component.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

---

## 🖼️ Create Basic Canvas

Create `src/components/editor/Canvas.tsx`:

```tsx
import React from 'react';

export function Canvas() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-muted/20">
      <div
        className="relative bg-background border-2 border-border"
        style={{
          width: '640px', // 80 cols * 8px
          height: '384px', // 24 rows * 16px
          fontFamily: 'monospace',
        }}
      >
        {/* Canvas grid background */}
        <div className="absolute inset-0 pointer-events-none opacity-20">
          <svg width="100%" height="100%">
            <defs>
              <pattern id="grid" width="8" height="16" patternUnits="userSpaceOnUse">
                <rect width="8" height="16" fill="none" stroke="currentColor" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>

        {/* Drop zone */}
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          Drop components here
        </div>
      </div>
    </div>
  );
}
```

---

## 📝 Create Property Panel

Create `src/components/properties/PropertyPanel.tsx`:

```tsx
import React from 'react';

export function PropertyPanel() {
  return (
    <div className="p-4">
      <h2 className="text-sm font-semibold mb-4 text-muted-foreground">Properties</h2>

      <div className="text-sm text-muted-foreground text-center py-8">
        Select a component to edit its properties
      </div>
    </div>
  );
}
```

---

## 🔗 Wire Everything Together

Update `src/App.tsx`:

```tsx
import { EditorLayout } from './components/editor/EditorLayout';
import { ComponentPalette } from './components/palette/ComponentPalette';
import { Canvas } from './components/editor/Canvas';
import { PropertyPanel } from './components/properties/PropertyPanel';

function App() {
  return (
    <div className="dark">
      {' '}
      {/* Force dark mode */}
      <EditorLayout
        palette={<ComponentPalette />}
        canvas={<Canvas />}
        properties={<PropertyPanel />}
      />
    </div>
  );
}

export default App;
```

---

## 🏃 Run Development Server

```bash
npm run dev
```

Open http://localhost:5173

You should see:

- Left sidebar with component palette
- Center canvas with grid
- Right sidebar for properties
- Dark mode UI

---

## ✅ Verification Checklist

- [ ] Project runs without errors
- [ ] Dark mode is applied
- [ ] Three-column layout renders
- [ ] Component palette shows 4 components
- [ ] Canvas shows grid background
- [ ] Property panel shows placeholder text

---

## 🎯 Next Steps

After verifying the basic setup:

1. **Implement Drag and Drop** (Week 3)
   - Add react-dnd providers
   - Make palette items draggable
   - Make canvas accept drops
   - Create component instances on drop

2. **Add Component Rendering** (Week 3)
   - Render dropped components on canvas
   - Show selection overlay
   - Enable click to select

3. **Build Property Editing** (Week 5)
   - Show selected component properties
   - Add input fields for properties
   - Update component on property change

4. **Implement Layout Engine** (Week 6)
   - Calculate component positions
   - Apply flexbox layout
   - Handle nesting

Refer to the main `TUI_DESIGNER_IMPLEMENTATION_PLAN.md` for detailed phases.

---

## 🐛 Troubleshooting

**Problem**: Tailwind styles not working

- **Solution**: Make sure `index.css` is imported in `main.tsx`

**Problem**: TypeScript errors

- **Solution**: Check `tsconfig.json` has correct paths and includes

**Problem**: Dark mode not applying

- **Solution**: Verify the `dark` class is on root div in `App.tsx`

**Problem**: Components not showing

- **Solution**: Check browser console for errors, verify imports

---

**Ready to build!** 🚀

Follow the implementation plan and you'll have a working TUI designer in 12 weeks.
