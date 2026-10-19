// "Bodies" of navigation elements: a component with `showWhen` is only shown while the
// referenced Tabs/Menu/List has that item selected, so every entry can have its own content.

import type { ComponentNode } from '../types';

const NAV_TYPES = new Set(['Tabs', 'Menu', 'List']);

export function isNavElement(node: ComponentNode): boolean {
  return NAV_TYPES.has(node.type);
}

/** Currently selected item of a navigation element (Tabs: active tab, Menu/List: selection). */
export function navActiveIndex(nav: ComponentNode): number {
  const raw = nav.type === 'Tabs' ? nav.props.activeTab : nav.props.selectedIndex;
  return typeof raw === 'number' && raw >= 0 ? raw : 0;
}

/** Display labels of the items of a navigation element. */
export function navItemLabels(nav: ComponentNode): string[] {
  const raw = nav.type === 'Tabs' ? nav.props.tabs : nav.props.items;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const label =
      typeof item === 'string' ? item : ((item as { label?: unknown } | null)?.label ?? '');
    return String(label) || `Item ${i + 1}`;
  });
}

/** All navigation elements in a tree (depth first). */
export function collectNavElements(root: ComponentNode | null): ComponentNode[] {
  const found: ComponentNode[] = [];
  const walk = (node: ComponentNode) => {
    if (isNavElement(node)) found.push(node);
    node.children.forEach(walk);
  };
  if (root) walk(root);
  return found;
}

/**
 * Whether `node` is shown. Components without `showWhen`, or whose navigation element no
 * longer exists, are always shown.
 */
export function isShownByNav(
  node: ComponentNode,
  byId: ReadonlyMap<string, ComponentNode>
): boolean {
  if (!node.showWhen) return true;
  const nav = byId.get(node.showWhen.nav);
  if (!nav || !isNavElement(nav)) return true;
  return navActiveIndex(nav) === node.showWhen.item;
}

/** Components that are bodies of `navId`, grouped by item index. */
export function bodiesOf(root: ComponentNode | null, navId: string): Map<number, ComponentNode[]> {
  const groups = new Map<number, ComponentNode[]>();
  const walk = (node: ComponentNode) => {
    if (node.showWhen?.nav === navId) {
      const list = groups.get(node.showWhen.item) ?? [];
      list.push(node);
      groups.set(node.showWhen.item, list);
    }
    node.children.forEach(walk);
  };
  if (root) walk(root);
  return groups;
}

/** After cloning a subtree: point `showWhen` at the cloned navigation element, if it was cloned too. */
export function remapShowWhen(node: ComponentNode, idMap: ReadonlyMap<string, string>): void {
  const target = node.showWhen && idMap.get(node.showWhen.nav);
  if (node.showWhen && target) node.showWhen = { ...node.showWhen, nav: target };
  node.children.forEach((child) => remapShowWhen(child, idMap));
}
