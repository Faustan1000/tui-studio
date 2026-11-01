import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/** Shows a recovery screen instead of a blank page when rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private resetSettings = () => {
    try {
      localStorage.clear();
    } catch {
      // storage unavailable: reloading is all we can do
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-background text-foreground p-6 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground max-w-md break-words">
          {this.state.error.message}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium"
          >
            Reload
          </button>
          <button
            onClick={this.resetSettings}
            className="px-4 py-2 bg-secondary border border-border rounded text-sm"
          >
            Reset settings and reload
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Unsaved changes in the editor are lost.</p>
      </div>
    );
  }
}
