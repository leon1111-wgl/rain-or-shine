import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  override state: { error: Error | null; key: string } = { error: null, key: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert" data-testid="render-fault">
        <h2>{t("app.renderFault")}</h2>
        <p className="subtext mono">{this.state.error.message}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          {t("app.reload")}
        </button>
      </div>
    );
  }
}
