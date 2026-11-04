import { t } from "../i18n";

/** Whether the page is shown inside another page. A browser that will not say counts as framed. */
export function isFramed(win: Window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true; // reading top threw: some other page holds this one
  }
}

/** Shown instead of the app inside another site's frame, where a page laid over it could steer clicks to the wallet. */
export function FramedNotice() {
  return (
    <div className="empty" role="alert" data-testid="framed-notice">
      <h2>{t("frame.title")}</h2>
      <p className="subtext">{t("frame.body")}</p>
      <a className="primary" href={window.location.href} target="_top">
        {t("frame.open")}
      </a>
    </div>
  );
}
