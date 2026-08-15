import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// 简易错误边界（阶段 5 可替换为更完善的实现）
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('应用错误:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#fff' }}>
          <h2>应用发生错误</h2>
          <button onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}
