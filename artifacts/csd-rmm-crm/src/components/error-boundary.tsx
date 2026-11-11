import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const normalized =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : JSON.stringify(error));
    console.error("Unhandled UI error:", {
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
      componentStack: info.componentStack,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-xl border p-8 text-center space-y-4">
            <h1 className="text-2xl font-bold text-gray-900">
              Something went wrong
            </h1>
            <p className="text-gray-600">
              The page ran into a problem. Please reload, or contact us and
              we'll help right away.
            </p>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-white font-medium hover:bg-red-700"
              data-testid="button-reload"
            >
              Reload page
            </button>
            <div className="pt-2 text-sm text-gray-600">
              <p>Need help now?</p>
              <a
                href="tel:9546377300"
                className="text-xl font-bold text-red-600 hover:text-red-700"
                data-testid="link-phone-error"
              >
                954-637-7300
              </a>
              <p className="mt-1">
                <a
                  href="mailto:support@computersystemsdepot.com"
                  className="text-red-600 hover:underline"
                >
                  support@computersystemsdepot.com
                </a>
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
