/**
 * 扫码登录弹窗: renders the Bilibili login QR on a canvas and polls its
 * status every 2 seconds until a terminal state.
 *
 * Closing is deliberately paranoid: the dialog portals to `document.body`
 * AND decides close-intent by *geometry* in window-level capture listeners.
 * Rationale — inside WebView2 an ancestor's filled transform animation made
 * `position: fixed` descendants fail hit-testing (the ✕ was visibly there
 * but clicks landed on an invisible layer above it). Capture-phase listeners
 * fire before anything else, and rectangles cannot be covered, so the close
 * affordance works no matter what sits on top.
 *
 * Lifecycle rules:
 * - The polling effect is keyed by `attempt`; 刷新二维码 bumps the counter
 *   which rebuilds generation + canvas + interval as one unit.
 * - Every terminal state (confirmed/expired/error) clears the interval.
 * - Unmount clears the interval and drops in-flight results via `cancelled`.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { biliQrGenerate, biliQrPoll } from "../lib/bili";
import type { BiliAccount } from "../lib/bili";

/** One polling round-trip; errors land in `error` instead of crashing. */
type Phase = "loading" | "waiting" | "scanned" | "expired" | "error";

interface BiliLoginDialogProps {
  onClose: () => void;
  /** Called exactly once, when the scan confirms. */
  onSuccess: (account: BiliAccount) => void;
}

/** Human-readable copy for each phase. */
const PHASE_TEXT: Record<Exclude<Phase, "loading">, string> = {
  waiting: "请使用哔哩哔哩 App 扫码",
  scanned: "已扫码，请在手机上确认登录",
  expired: "二维码已过期",
  error: "出错了，请重试",
};

function BiliLoginDialog({ onClose, onSuccess }: BiliLoginDialogProps) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorText, setErrorText] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Latest-callback refs keep effects free of callback identity churn.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Polling round: keyed by `attempt` so 刷新二维码 rebuilds everything.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    setPhase("loading");
    setErrorText("");

    void (async () => {
      try {
        const start = await biliQrGenerate();
        if (cancelled) return;
        if (canvasRef.current !== null) {
          // Fixed light palette: the QR must stay scannable in dark mode.
          await QRCode.toCanvas(canvasRef.current, start.qrUrl, {
            width: 220,
            margin: 1,
            color: { dark: "#1f1f1e", light: "#ffffff" },
          });
        }
        timer = window.setInterval(() => {
          void (async () => {
            try {
              const state = await biliQrPoll(start.qrcodeKey);
              if (cancelled) return;
              if (state.state === "confirmed" && state.account !== null) {
                if (timer !== undefined) window.clearInterval(timer);
                onSuccessRef.current(state.account);
              } else if (state.state === "expired") {
                if (timer !== undefined) window.clearInterval(timer);
                setPhase("expired");
              } else {
                setPhase(state.state === "scanned" ? "scanned" : "waiting");
              }
            } catch (err) {
              if (cancelled) return;
              if (timer !== undefined) window.clearInterval(timer);
              setErrorText(String(err));
              setPhase("error");
            }
          })();
        }, 2000);
        if (!cancelled) setPhase("waiting");
      } catch (err) {
        if (cancelled) return;
        setErrorText(String(err));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [attempt]);

  // Coverage-proof close wiring (see module docs).
  useEffect(() => {
    closeButtonRef.current?.focus();

    const inRect = (x: number, y: number, el: HTMLElement): boolean => {
      const rect = el.getBoundingClientRect();
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    };

    const onPointerDown = (event: PointerEvent): void => {
      const modal = modalRef.current;
      // Any press outside the dialog rectangle dismisses it — regardless of
      // which element the hit-test reports.
      if (modal !== null && !inRect(event.clientX, event.clientY, modal)) {
        onCloseRef.current();
      }
    };

    const onClickCapture = (event: MouseEvent): void => {
      const modal = modalRef.current;
      const closeBtn = closeButtonRef.current;
      // The ✕ works even when an invisible layer wins hit-testing: the
      // decision uses coordinates, captured before every other listener.
      if (closeBtn !== null && inRect(event.clientX, event.clientY, closeBtn)) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (modal !== null && !inRect(event.clientX, event.clientY, modal)) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Portal to document.body: never live inside transformed ancestors.
  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="扫码登录哔哩哔哩"
      >
        <div className="modal__head">
          <h3 className="modal__title">扫码登录</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="qr-stage">
          {phase === "expired" || phase === "error" ? (
            <div className="qr-stage__overlay">
              <p>{phase === "expired" ? PHASE_TEXT.expired : PHASE_TEXT.error}</p>
              {phase === "error" && errorText !== "" && (
                <p className="qr-stage__detail">{errorText}</p>
              )}
              <button
                type="button"
                className="button button--primary"
                onClick={() => setAttempt((prev) => prev + 1)}
              >
                刷新二维码
              </button>
            </div>
          ) : null}
          {/* Canvas stays mounted so the effect can always draw into it. */}
          <canvas ref={canvasRef} className="qr-stage__canvas" aria-label="登录二维码" />
        </div>

        <p className="modal__hint">
          {phase === "loading" ? "正在获取二维码…" : PHASE_TEXT[phase]}
        </p>
      </div>
    </div>,
    document.body,
  );
}

export default BiliLoginDialog;
