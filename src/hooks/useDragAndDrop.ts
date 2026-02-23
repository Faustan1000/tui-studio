// Drag and drop hook for components

import { useState, useCallback } from 'react';
import type { ComponentType } from '../types';

export interface DragData {
  type: 'new-component' | 'existing-component';
  componentType?: ComponentType;
  componentId?: string;
  sourceIndex?: number;
}

export function useDragAndDrop() {
  const [dragData, setDragData] = useState<DragData | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = useCallback((data: DragData) => {
    setDragData(data);
    setIsDragging(true);
  }, []);

  const endDrag = useCallback(() => {
    setDragData(null);
    setIsDragging(false);
  }, []);

  return {
    dragData,
    isDragging,
    startDrag,
    endDrag,
  };
}

// Drag store for global drag state
class DragStore {
  private listeners: Set<() => void> = new Set();
  private _dragData: DragData | null = null;
  private _isDragging = false;

  get dragData() {
    return this._dragData;
  }

  get isDragging() {
    return this._isDragging;
  }

  startDrag(data: DragData) {
    this._dragData = data;
    this._isDragging = true;
    this.notify();
  }

  endDrag() {
    this._dragData = null;
    this._isDragging = false;
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

export const dragStore = new DragStore();
