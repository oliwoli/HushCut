import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
  maxRetries?: number;
}

interface State {
  hasError: boolean;
  retryCount: number;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    retryCount: 0,
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, retryCount: 0, error: error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public componentDidUpdate(prevProps: Props, prevState: State) {
    if (this.state.hasError && this.state.retryCount < (this.props.maxRetries || 3)) {
      // Attempt to re-render after a short delay
      setTimeout(() => {
        this.setState((prevState) => ({
          hasError: false,
          retryCount: prevState.retryCount + 1,
          error: null,
        }));
      }, 1000); // 1-second delay before retrying
    } else if (this.state.hasError && this.state.retryCount >= (this.props.maxRetries || 3) && !prevState.hasError) {
      // If retries are exhausted, and we just transitioned to this state, log it.
      console.warn("Error boundary: Max retries reached. Displaying fallback.");
    }
  }

  public render() {
    if (this.state.hasError && this.state.retryCount >= (this.props.maxRetries || 3)) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
