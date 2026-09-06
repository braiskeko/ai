import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render errors so one bad value (an unparseable date, a field an older
 * snapshot never had) shows a recoverable screen instead of a blank page.
 *
 * Remounting on navigation is deliberate: `resetKey` is the current path, so
 * leaving the broken screen clears the error without a reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; fallback?: (error: Error, retry: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = () => this.setState({ error: null });
    if (this.props.fallback) return this.props.fallback(error, retry);
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">😵</div>
        <h1 className="mt-4 text-lg font-bold">Something broke on this screen</h1>
        <p className="mt-1 break-words text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={retry}
            className="h-10 rounded-full border border-border px-4 text-sm font-semibold"
          >
            Try again
          </button>
          <a href="/" className="grid h-10 place-items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Go home
          </a>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
