// Main editor layout with three columns and resizable sidebars

import { ReactNode, useState, useCallback, useRef } from 'react';

interface EditorLayoutProps {
  toolbar: ReactNode;
  leftSidebar: ReactNode;
  canvas: ReactNode;
  rightSidebar: ReactNode;
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const isDragging = useRef(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = true;
      lastX.current = e.clientX;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = e.clientX - lastX.current;
        lastX.current = e.clientX;
        onResize(delta);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [onResize]
  );

  return (
    <div
      className="w-1 flex-shrink-0 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors group relative"
      onMouseDown={handleMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

export function EditorLayout({ toolbar, leftSidebar, canvas, rightSidebar }: EditorLayoutProps) {
  const [leftWidth, setLeftWidth] = useState(256); // 16rem = 256px
  const [rightWidth, setRightWidth] = useState(320); // 20rem = 320px

  const resizeLeft = useCallback((delta: number) => {
    setLeftWidth((w) => Math.max(160, Math.min(480, w + delta)));
  }, []);

  const resizeRight = useCallback((delta: number) => {
    setRightWidth((w) => Math.max(200, Math.min(560, w - delta)));
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden">
      {/* Top Toolbar */}
      <div className="flex-shrink-0 border-b border-border">{toolbar}</div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div
          className="flex-shrink-0 border-r border-border bg-card overflow-y-auto"
          style={{ width: leftWidth }}
        >
          {leftSidebar}
        </div>

        <ResizeHandle onResize={resizeLeft} />

        {/* Center - Canvas */}
        <div className="flex-1 overflow-hidden">{canvas}</div>

        <ResizeHandle onResize={resizeRight} />

        {/* Right Sidebar - Properties */}
        <div
          className="flex-shrink-0 border-l border-border bg-card overflow-y-auto"
          style={{ width: rightWidth }}
        >
          {rightSidebar}
        </div>
      </div>
    </div>
  );
}
