// Fixture helpers: build component trees the way the editor does (library defaults + overrides).

import { COMPONENT_LIBRARY } from '../../src/constants/components';
import type { ComponentNode, ComponentType } from '../../src/types';

export interface Over {
  id?: string;
  name?: string;
  tag?: string;
  props?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  events?: Record<string, string>;
  showWhen?: { nav: string; item: number };
  opensScreen?: string;
  hidden?: boolean;
}

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export function mk(
  type: ComponentType,
  over: Over = {},
  children: ComponentNode[] = []
): ComponentNode {
  const d = COMPONENT_LIBRARY[type];
  const node = {
    id: over.id ?? `id-${++counter}`,
    type,
    name: over.name ?? d.name,
    props: { ...d.defaultProps, ...(over.props ?? {}) },
    layout: { ...d.defaultLayout, ...(over.layout ?? {}) },
    style: { ...d.defaultStyle, ...(over.style ?? {}) },
    events: over.events ?? d.defaultEvents ?? {},
    children,
    locked: false,
    hidden: over.hidden ?? false,
    collapsed: false,
  } as unknown as ComponentNode;
  const extra = node as unknown as Record<string, unknown>;
  if (over.tag) extra.tag = over.tag;
  if (over.showWhen) extra.showWhen = over.showWhen;
  if (over.opensScreen) extra.opensScreen = over.opensScreen;
  return node;
}

export function screen(
  name: string,
  tag: string | undefined,
  children: ComponentNode[]
): ComponentNode {
  return mk('Screen', { id: 'root', name, tag }, children);
}
