/**
 * 收藏夹主视图（主显示区）：账号门禁 + 收藏夹卡片列表。
 *
 * 未登录时提供**就地扫码**（弹窗直接打开，成功后立即加载收藏夹），
 * 也可以去「API 设置 → B 站账号」处理登录/退出。已登录则全宽渲染
 * 收藏夹卡片，第一个收藏夹自动展开直达视频。
 */

import { useEffect, useState } from "react";
import { biliSessionStatus, biliSessionVerify, isAuthExpiredError } from "../lib/bili";
import type { BiliAccount } from "../lib/bili";
import BiliLoginDialog from "./BiliLoginDialog";
import BiliFavorites from "./BiliFavorites";

function FavoritesView() {
  const [account, setAccount] = useState<BiliAccount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  // Bumped after a successful login so the folder list reloads.
  const [foldersToken, setFoldersToken] = useState(0);

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

  // Background cookie check: an expired session degrades the view to the
  // login gate even though the local row still exists.
  useEffect(() => {
    if (account === null || expired) return;
    let cancelled = false;
    void biliSessionVerify().catch((err: unknown) => {
      if (!cancelled && isAuthExpiredError(err)) setExpired(true);
    });
    return () => {
      cancelled = true;
    };
  }, [account?.mid, expired]);

  const loggedIn = account !== null && !expired;

  function handleLoginSuccess(fresh: BiliAccount): void {
    setShowLogin(false);
    setAccount(fresh);
    setExpired(false);
    setFoldersToken((token) => token + 1);
  }

  return (
    <section className="card">
      <h2 className="card__title">
        <span className="card__index">★</span>收藏夹
      </h2>

      {!loaded ? (
        <p className="placeholder">检查登录状态…</p>
      ) : !loggedIn ? (
        <>
          <p className="placeholder">
            {account !== null
              ? "登录已失效，请重新扫码后再浏览收藏夹。"
              : "浏览收藏夹前需要先登录哔哩哔哩。凭据仅保存在本地。"}
          </p>
          <div className="card__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => setShowLogin(true)}
            >
              扫码登录
            </button>
            <span className="hint-text">登录与退出也可以在「API 设置 → B 站账号」中管理</span>
          </div>
        </>
      ) : (
        <>
          <div className="fav-profile">
            {account.face !== "" ? (
              <img
                src={account.face}
                alt=""
                referrerPolicy="no-referrer"
                className="fav-profile__avatar"
              />
            ) : (
              <span className="fav-profile__avatar fav-profile__avatar--empty" aria-hidden="true" />
            )}
            <div className="fav-profile__text">
              <p className="fav-profile__name">{account.uname || `UID ${account.mid}`}</p>
              <p className="fav-profile__sub">MID {account.mid} · 已登录哔哩哔哩</p>
            </div>
            <span className="fav-profile__tag">已登录</span>
          </div>
          <BiliFavorites refreshToken={foldersToken} />
        </>
      )}

      {showLogin && (
        <BiliLoginDialog onClose={() => setShowLogin(false)} onSuccess={handleLoginSuccess} />
      )}
    </section>
  );
}

export default FavoritesView;
