// ASCII border rendering utilities

export interface BorderStyle {
  top: string;
  bottom: string;
  left: string;
  right: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

export const BORDER_STYLES: Record<string, BorderStyle> = {
  single: {
    top: '─',
    bottom: '─',
    left: '│',
    right: '│',
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
  },
  double: {
    top: '═',
    bottom: '═',
    left: '║',
    right: '║',
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
  },
  rounded: {
    top: '─',
    bottom: '─',
    left: '│',
    right: '│',
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
  },
  bold: {
    top: '━',
    bottom: '━',
    left: '┃',
    right: '┃',
    topLeft: '┏',
    topRight: '┓',
    bottomLeft: '┗',
    bottomRight: '┛',
  },
  ascii: {
    top: '-',
    bottom: '-',
    left: '|',
    right: '|',
    topLeft: '+',
    topRight: '+',
    bottomLeft: '+',
    bottomRight: '+',
  },
  hidden: {
    top: ' ',
    bottom: ' ',
    left: ' ',
    right: ' ',
    topLeft: ' ',
    topRight: ' ',
    bottomLeft: ' ',
    bottomRight: ' ',
  },
};

export interface BorderConfig {
  style: string;
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
  topStyle?: string;
  rightStyle?: string;
  bottomStyle?: string;
  leftStyle?: string;
  corners?: boolean; // false = replace corner chars with line chars
}

/**
 * Render a box with borders around content
 */
export function renderBox(
  content: string[],
  width: number,
  height: number,
  config: BorderConfig = { style: 'single' }
): string[] {
  // Per-side styles fall back to the global style
  const globalStyle = BORDER_STYLES[config.style] || BORDER_STYLES.single;
  const topSty = BORDER_STYLES[config.topStyle ?? config.style] || globalStyle;
  const bottomSty = BORDER_STYLES[config.bottomStyle ?? config.style] || globalStyle;
  const leftSty = BORDER_STYLES[config.leftStyle ?? config.style] || globalStyle;
  const rightSty = BORDER_STYLES[config.rightStyle ?? config.style] || globalStyle;

  const lines: string[] = [];

  const showTop = config.top !== false;
  const showBottom = config.bottom !== false;
  const showLeft = config.left !== false;
  const showRight = config.right !== false;
  const showCorners = config.corners !== false;

  const innerWidth = width - (showLeft ? 1 : 0) - (showRight ? 1 : 0);
  const contentHeight = height - (showTop ? 1 : 0) - (showBottom ? 1 : 0);

  // Top border
  if (showTop) {
    const topLeft = showLeft ? (showCorners ? globalStyle.topLeft : topSty.top) : '';
    const topRight = showRight ? (showCorners ? globalStyle.topRight : topSty.top) : '';
    const topLine = topSty.top.repeat(innerWidth);
    lines.push(topLeft + topLine + topRight);
  }

  // Content with side borders
  for (let i = 0; i < contentHeight; i++) {
    const contentLine = content[i] || '';
    const paddedContent = contentLine.padEnd(innerWidth, ' ').slice(0, innerWidth);
    const left = showLeft ? leftSty.left : '';
    const right = showRight ? rightSty.right : '';
    lines.push(left + paddedContent + right);
  }

  // Bottom border
  if (showBottom) {
    const bottomLeft = showLeft ? (showCorners ? globalStyle.bottomLeft : bottomSty.bottom) : '';
    const bottomRight = showRight ? (showCorners ? globalStyle.bottomRight : bottomSty.bottom) : '';
    const bottomLine = bottomSty.bottom.repeat(innerWidth);
    lines.push(bottomLeft + bottomLine + bottomRight);
  }

  return lines;
}

/**
 * Render horizontal divider
 */
export function renderDivider(width: number, style: string = 'single', char?: string): string {
  const borderStyle = BORDER_STYLES[style] || BORDER_STYLES.single;
  const dividerChar = char || borderStyle.top;
  return dividerChar.repeat(width);
}

/**
 * Calculate content area dimensions accounting for borders
 */
export function getContentArea(
  width: number,
  height: number,
  config: BorderConfig
): { width: number; height: number } {
  const showTop = config.top !== false;
  const showBottom = config.bottom !== false;
  const showLeft = config.left !== false;
  const showRight = config.right !== false;

  return {
    width: width - (showLeft ? 1 : 0) - (showRight ? 1 : 0),
    height: height - (showTop ? 1 : 0) - (showBottom ? 1 : 0),
  };
}
