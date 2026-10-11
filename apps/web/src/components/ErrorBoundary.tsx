import { Component, type ReactNode } from 'react';

/** A crashing page shows its error (and a retry) instead of blanking the whole dashboard. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string | undefined }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey?: string | undefined }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <div className="font-medium">This page crashed.</div>
        <pre className="mt-2 whitespace-pre-wrap break-all text-xs">{this.state.error.message}</pre>
        <button className="mt-3 underline" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
