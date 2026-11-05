import { useEffect, useState } from "react";
import { type MessageKey, t } from "../i18n";
import { Icon, type IconName } from "./Icon";

const STEPS: Array<{ key: string; icon: IconName }> = [
  { key: "bet", icon: "wallet" },
  { key: "close", icon: "lock" },
  { key: "data", icon: "rain" },
  { key: "assert", icon: "shield" },
  { key: "challenge", icon: "hourglass" },
  { key: "claim", icon: "receipt" },
];
const RULES: MessageKey[] = ["how.rule.topUp", "how.rule.oneSide", "how.rule.final", "how.rule.single", "how.rule.fee"];
const STEP_MS = 4_500;

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Steps({ step, playing, onPick }: { step: number; playing: boolean; onPick: (i: number) => void }) {
  return (
    <ol className="how-steps">
      {STEPS.map((s, i) => (
        <li key={s.key} className={i < step ? "done" : i === step ? "current" : ""}>
          <button type="button" aria-current={i === step ? "step" : undefined} onClick={() => onPick(i)}>
            <span className="how-icon">
              <Icon name={s.icon} />
            </span>
            <span className="how-label">{t(`how.${s.key}.title` as MessageKey)}</span>
          </button>
          <span className="how-track">{i === step && <span key={`${step}-${playing}`} className={playing ? "how-fill playing" : "how-fill"} style={{ animationDuration: `${STEP_MS}ms` }} />}</span>
        </li>
      ))}
    </ol>
  );
}

export function HowItWorks({ hours, autoplay = false }: { hours: bigint; autoplay?: boolean }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(() => autoplay && !prefersReducedMotion());
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, step]);
  const current = STEPS[step]!;
  return (
    <section className="card how" aria-labelledby="how-title" data-testid="how-it-works">
      <div className="panel-heading">
        <div>
          <h2 id="how-title">{t("how.title")}</h2>
          <p className="subtext">{t("how.sub")}</p>
        </div>
        <button type="button" className="secondary small-button" onClick={() => setPlaying((p) => !p && !prefersReducedMotion())} aria-pressed={playing} data-testid="how-play">
          <Icon name={playing ? "pause" : "play"} />
          {playing ? t("how.pause") : t("how.play")}
        </button>
      </div>
      <Steps
        step={step}
        playing={playing}
        onPick={(i) => {
          setStep(i);
          setPlaying(false);
        }}
      />
      <div className="how-detail" key={step} aria-live="polite">
        <span className="how-detail-icon">
          <Icon name={current.icon} />
        </span>
        <div>
          <small>{t("how.counter", { n: step + 1, total: STEPS.length })}</small>
          <strong>{t(`how.${current.key}.title` as MessageKey)}</strong>
          <p>{t(`how.${current.key}.body` as MessageKey, { hours })}</p>
        </div>
      </div>
      <ul className="rule-chips" aria-label={t("how.rules")}>
        {RULES.map((k) => (
          <li key={k}>
            <Icon name="check" />
            {t(k)}
          </li>
        ))}
      </ul>
    </section>
  );
}
