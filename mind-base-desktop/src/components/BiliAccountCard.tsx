/**
 * 「B 站账号」卡片（放在 API 设置标签页）：扫码登录 / 会话状态 / 退出登录。
 *
 * 凭据不出后端——卡片只展示 mid / 昵称 / 头像。Cookie 失效时行内置灰并
 * 提供重扫入口，但不主动清除本地会话（失败可能只是暂时的网络问题）。
 */

import { useEffect, useState } from "react";
import {
  biliLogout,
  biliSessionStatus,
  biliSessionVerify,
  isAuthExpiredError,
} from "../lib/bili";
import type { BiliAccount } from "../lib/bili";
import { toErrorMessage } from "../lib/updater";
import BiliLoginDialog from "./BiliLoginDialog";

function BiliAccountCard() {
  const [account, setAccount] = useState<BiliAccount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Local status first (instant restore), then a background cookie check.
  useEffect(() => {
    let cancelled = false;
    void biliSessionStatus().then(
      (restored) => {
        if (cancelled) return;
        setLoaded(true);
        if (restored !== null) setAccount(restored);
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (account === null || expired) return;
    let cancelled = false;
    void biliSessionVerify().then(
      (fresh) => {
        if (!cancelled) setAccount(fresh);
      },
      (err) => {
        if (cancelled) return;
        // Only a real auth expiry greys the row; network errors keep it.
        if (isAuthExpiredError(err)) setExpired(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [account?.mid, expired]);

  async function handleLogout(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      await biliLogout();
      setAccount(null);
      setExpired(false);
      setFeedback({ kind: "ok", text: "✓ 已退出登录" });
    } catch (err) {
      setFeedback({ kind: "error", text: `退出失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  function handleLoginSuccess(fresh: BiliAccount): void {
    setShowLogin(false);
    setAccount(fresh);
    setExpired(false);
    setFeedback({ kind: "ok", text: "✓ 登录成功" });
  }

  return (
    <section className="card">
      <h2 className="card__title">
        <span className="card__index">01</span>B 站账号
      </h2>

      {account !== null ? (
        <>
          <div className={expired ? "account-row account-row--expired" : "account-row"}>
            {account.face !== "" ? (
              <img
                src={account.face}
                alt=""
                referrerPolicy="no-referrer"
                className="account-row__avatar"
              />
            ) : (
              <span className="account-row__avatar account-row__avatar--empty" aria-hidden="true" />
            )}
            <div className="account-row__text">
              <p className="account-row__name">
                {account.uname || `UID ${account.mid}`}
                {expired && <span className="status status--error">登录已失效</span>}
              </p>
              <p className="account-row__sub">MID {account.mid}</p>
            </div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void handleLogout()}
            >
              退出登录
            </button>
          </div>
          {expired && (
            <div className="card__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => setShowLogin(true)}
              >
                重新扫码登录
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="placeholder">
            {loaded ? "尚未登录哔哩哔哩。扫码登录后即可在收藏夹中浏览你的收藏。" : "检查登录状态…"}
          </p>
          <div className="card__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => setShowLogin(true)}
            >
              扫码登录
            </button>
            {feedback !== null && (
              <span className={feedback.kind === "error" ? "error-text" : "hint-text"}>
                {feedback.text}
              </span>
            )}
          </div>
        </>
      )}

      {showLogin && (
        <BiliLoginDialog onClose={() => setShowLogin(false)} onSuccess={handleLoginSuccess} />
      )}
    </section>
  );
}

export default BiliAccountCard;
