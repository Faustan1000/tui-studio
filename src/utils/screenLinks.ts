// Links from components to screens: a Button's `opensScreen`, and the `screen` of a Menu/List
// item. They refer to the id of a screen of the project (not its name or code name).

import type { ComponentNode } from '../types';

type Item = Record<string, unknown>;

/** Items of a Menu/List/Tabs that can carry a `screen` link. */
function linkableItems(node: ComponentNode): Item[] {
  const raw = node.type === 'Menu' || node.type === 'List' ? node.props.items : undefined;
  return Array.isArray(raw)
    ? raw.filter((i): i is Item => typeof i === 'object' && i !== null)
    : [];
}

/** Screen ids a component links to (its button link and its item links). */
export function linkedScreens(node: ComponentNode): string[] {
  const ids: string[] = [];
  if (node.opensScreen) ids.push(node.opensScreen);
  for (const item of linkableItems(node)) {
    if (typeof item.screen === 'string' && item.screen) ids.push(item.screen);
  }
  return ids;
}

export function treeLinksTo(root: ComponentNode, screenId: string): boolean {
  return (
    linkedScreens(root).includes(screenId) || root.children.some((c) => treeLinksTo(c, screenId))
  );
}

/**
 * Copy of the tree without links for which `drop(screenId)` is true. Only nodes that change
 * are copied, so history snapshots that share the old nodes stay intact.
 */
export function withoutScreenLinks(
  node: ComponentNode,
  drop: (screenId: string) => boolean
): ComponentNode {
  let next = node;
  if (node.opensScreen && drop(node.opensScreen)) {
    next = { ...next };
    delete next.opensScreen;
  }
  const items = node.props.items;
  if (
    (node.type === 'Menu' || node.type === 'List') &&
    Array.isArray(items) &&
    items.some((i) => typeof i === 'object' && i && drop(String((i as Item).screen ?? '')))
  ) {
    const cleaned = items.map((i) => {
      if (typeof i === 'object' && i && (i as Item).screen && drop(String((i as Item).screen))) {
        const rest = { ...(i as Item) };
        delete rest.screen;
        return rest;
      }
      return i;
    });
    next = { ...next, props: { ...next.props, items: cleaned } };
  }
  const children = node.children.map((c) => withoutScreenLinks(c, drop));
  if (children.some((c, i) => c !== node.children[i])) next = { ...next, children };
  return next;
}
