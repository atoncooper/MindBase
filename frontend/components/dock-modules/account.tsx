"use client";

import { useState, useEffect, useCallback } from "react";
import { Pencil, Check, Eye, EyeOff, AtSign, Smartphone, Key, Globe } from "lucide-react";
import QRLoginModal from "@/components/QRLoginModal";
import { userApi, type ProfileData, type SecurityOverview } from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";

/* ─── helpers ─── */

const GENDER_LABELS: Record<string, string> = { male: "男", female: "女", other: "其他" };
const LANG_LABELS: Record<string, string> = { zh: "中文", en: "English" };

/* ─── inline editor (shared) ─── */

function InlineField({
  value, onChange, placeholder, type = "text",
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      className="ac-input"
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}

/* ─── main ─── */

export default function AccountPanel({ isOpen }: DockPanelProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [security, setSecurity] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [showBiliBind, setShowBiliBind] = useState(false);

  // edit mode toggles
  const [editMode, setEditMode] = useState<"view" | "profile" | null>(null);
  const [profileForm, setProfileForm] = useState<Record<string, string>>({});

  // inline toggles
  const [editEmail, setEditEmail] = useState(false);
  const [editPhone, setEditPhone] = useState(false);
  const [editPassword, setEditPassword] = useState(false);
  const [emailVal, setEmailVal] = useState("");
  const [phoneVal, setPhoneVal] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  const flash = (message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3200);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([userApi.getProfile(), userApi.getSecurity()]);
      setProfile(p); setSecurity(s);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  // ── profile ──

  const enterProfileEdit = () => {
    if (!profile) return;
    setProfileForm({
      nickname: profile.nickname ?? "",
      avatar: profile.avatar ?? "",
      bio: profile.bio ?? "",
      birthday: profile.birthday ?? "",
      gender: profile.gender ?? "",
      location: profile.location ?? "",
      timezone: profile.timezone ?? "",
      language: profile.language ?? "",
    });
    setEditMode("profile");
  };

  const saveProfile = async () => {
    try {
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(profileForm)) { if (v?.trim()) data[k] = v.trim(); }
      const updated = await userApi.updateProfile(data);
      setProfile(updated); setEditMode(null);
      flash("个人资料已更新", "success");
    } catch (e) { flash(e instanceof Error ? e.message : "保存失败", "error"); }
  };

  // ── email ──

  const saveEmail = async () => {
    if (!emailVal.trim()) return;
    try { await userApi.bindEmail({ email: emailVal.trim() }); setEditEmail(false); flash("邮箱已绑定", "success"); load(); }
    catch (e) { flash(e instanceof Error ? e.message : "绑定失败", "error"); }
  };

  const unbindEmail = async () => {
    try { await userApi.unbindEmail(); flash("邮箱已解绑", "success"); load(); }
    catch (e) { flash(e instanceof Error ? e.message : "解绑失败", "error"); }
  };

  // ── phone ──

  const savePhone = async () => {
    if (!phoneVal.trim()) return;
    try { await userApi.bindPhone({ phone: phoneVal.trim() }); setEditPhone(false); flash("手机号已绑定", "success"); load(); }
    catch (e) { flash(e instanceof Error ? e.message : "绑定失败", "error"); }
  };

  const unbindPhone = async () => {
    try { await userApi.unbindPhone(); flash("手机号已解绑", "success"); load(); }
    catch (e) { flash(e instanceof Error ? e.message : "解绑失败", "error"); }
  };

  // ── password ──

  const onBiliBindSuccess = () => {
    setShowBiliBind(false);
    flash("B站账号已绑定", "success");
    load();
  };

  const savePassword = async () => {
    try {
      if (security?.has_password) {
        if (!oldPw || !newPw) return;
        await userApi.changePassword({ old_password: oldPw, new_password: newPw });
      } else {
        if (!newPw) return;
        await userApi.setPassword({ password: newPw });
      }
      setEditPassword(false); setOldPw(""); setNewPw("");
      flash(security?.has_password ? "密码已修改" : "密码已设置", "success");
      load();
    } catch (e) { flash(e instanceof Error ? e.message : "操作失败", "error"); }
  };

  if (!isOpen) return null;

  /* ─── loading ─── */
  if (loading) {
    return (
      <div className="ac-root">
        <div className="ac-loading">
          <div className="ac-spinner" />
          <p>加载中…</p>
        </div>
        <style jsx global>{AC_CSS}</style>
      </div>
    );
  }

  if (!profile || !security) {
    return (
      <div className="ac-root">
        <div className="ac-loading"><p>无法加载用户数据</p></div>
        <style jsx global>{AC_CSS}</style>
      </div>
    );
  }

  const avatarLetter = (profile.nickname ?? "U")[0].toUpperCase();

  return (
    <div className="ac-root">
      {toast && <div className={`ac-toast ${toast.type}`}>{toast.message}</div>}

      {/* ── Header / avatar row ── */}
      <div className="ac-header">
        <div className="ac-avatar">{avatarLetter}</div>
        <div className="ac-identity">
          <h2>{profile.nickname ?? "用户"}</h2>
          <p>{profile.email ?? "未绑定邮箱"}</p>
        </div>
      </div>

      {/* ── Security status chips ── */}
      <div className="ac-chips">
        <div className={`ac-chip ${profile.email_verified ? "ok" : ""}`}>
          <AtSign size={12} /> {profile.email ? (profile.email_verified ? "邮箱已验证" : "邮箱未验证") : "未绑定邮箱"}
        </div>
        <div className={`ac-chip ${profile.phone_verified ? "ok" : ""}`}>
          <Smartphone size={12} /> {profile.phone ? (profile.phone_verified ? "手机已验证" : "手机未验证") : "未绑定手机"}
        </div>
        <div className={`ac-chip ${security.has_password ? "ok" : ""}`}>
          <Key size={12} /> {security.has_password ? "密码已设置" : "未设密码"}
        </div>
        <div className={`ac-chip ${security.bilibili.valid ? "ok" : "warn"}`}>
          <Globe size={12} /> {security.bilibili.valid ? "B站已授权" : (security.bilibili.bound ? "B站授权失效" : "未绑定B站")}
        </div>
      </div>

      <div className="ac-body">
        {/* ── Profile card ── */}
        <section className="ac-card">
          <div className="ac-card-bar">
            <h3>个人资料</h3>
            {editMode !== "profile" && (
              <button className="ac-ghost-btn" onClick={enterProfileEdit}><Pencil size={14} /> 编辑</button>
            )}
          </div>

          {editMode === "profile" ? (
            <div className="ac-edit-area">
              <div className="ac-grid-2">
                <Field label="昵称" value={profileForm.nickname} onChange={v => setProfileForm(p => ({ ...p, nickname: v }))} placeholder="输入昵称" />
                <Field label="头像 URL" value={profileForm.avatar} onChange={v => setProfileForm(p => ({ ...p, avatar: v }))} placeholder="https://…" />
                <Field label="简介" value={profileForm.bio} onChange={v => setProfileForm(p => ({ ...p, bio: v }))} placeholder="介绍一下自己" />
                <Field label="生日" value={profileForm.birthday} onChange={v => setProfileForm(p => ({ ...p, birthday: v }))} placeholder="YYYY-MM-DD" />
                <SelectField label="性别" value={profileForm.gender} onChange={v => setProfileForm(p => ({ ...p, gender: v }))} options={GENDER_LABELS} />
                <Field label="位置" value={profileForm.location} onChange={v => setProfileForm(p => ({ ...p, location: v }))} placeholder="城市/地区" />
                <Field label="时区" value={profileForm.timezone} onChange={v => setProfileForm(p => ({ ...p, timezone: v }))} placeholder="Asia/Shanghai" />
                <SelectField label="语言" value={profileForm.language} onChange={v => setProfileForm(p => ({ ...p, language: v }))} options={LANG_LABELS} />
              </div>
              <div className="ac-edit-actions">
                <button className="ac-btn secondary" onClick={() => setEditMode(null)}>取消</button>
                <button className="ac-btn primary" onClick={saveProfile}><Check size={14} /> 保存</button>
              </div>
            </div>
          ) : (
            <div className="ac-readonly-grid">
              <ReadonlyField label="昵称" value={profile.nickname} />
              <ReadonlyField label="简介" value={profile.bio} />
              <ReadonlyField label="性别" value={GENDER_LABELS[profile.gender ?? ""]} />
              <ReadonlyField label="生日" value={profile.birthday} />
              <ReadonlyField label="位置" value={profile.location} />
              <ReadonlyField label="语言" value={LANG_LABELS[profile.language ?? ""]} />
              <ReadonlyField label="时区" value={profile.timezone} />
            </div>
          )}
        </section>

        {/* ── Bilibili binding ── */}
        <section className="ac-card">
          <div className="ac-card-bar">
            <h3><Globe size={15} /> B站授权</h3>
            <button className="ac-ghost-btn" onClick={() => setShowBiliBind(true)}>
              {security.bilibili.bound ? "重新扫码" : "扫码绑定"}
            </button>
          </div>
          <div className="ac-prop-row">
            <span className="ac-prop-label">状态</span>
            <span className="ac-prop-value">
              <span className={`ac-tag ${security.bilibili.valid ? "green" : "amber"}`}>
                {security.bilibili.valid ? "可用" : (security.bilibili.bound ? "已失效" : "未绑定")}
              </span>
              <span className="ac-help-text">{security.bilibili.message}</span>
            </span>
          </div>
          {security.bilibili.nickname && (
            <div className="ac-prop-row">
              <span className="ac-prop-label">账号</span>
              <span className="ac-prop-value">{security.bilibili.nickname}</span>
            </div>
          )}
        </section>

        {/* ── Email ── */}
        <section className="ac-card">
          <div className="ac-card-bar">
            <h3><AtSign size={15} /> 邮箱</h3>
            {!editEmail && (
              <button className="ac-ghost-btn" onClick={() => { setEmailVal(profile.email ?? ""); setEditEmail(true); }}>
                <Pencil size={14} /> {profile.email ? "修改" : "绑定"}
              </button>
            )}
          </div>
          {editEmail ? (
            <div className="ac-edit-area">
              <InlineField value={emailVal} onChange={setEmailVal} placeholder="your@email.com" />
              <div className="ac-edit-actions">
                <button className="ac-btn secondary" onClick={() => setEditEmail(false)}>取消</button>
                <button className="ac-btn primary" onClick={saveEmail}><Check size={14} /> 保存</button>
              </div>
            </div>
          ) : (
            <div className="ac-prop-row">
              <span className="ac-prop-label">当前绑定</span>
              <span className="ac-prop-value">
                {profile.email ? <>{profile.email} {profile.email_verified ? <span className="ac-tag green">已验证</span> : <span className="ac-tag amber">未验证</span>}</> : "—"}
              </span>
              {profile.email && (
                <button className="ac-link-btn danger" onClick={unbindEmail}>解绑</button>
              )}
            </div>
          )}
        </section>

        {/* ── Phone ── */}
        <section className="ac-card">
          <div className="ac-card-bar">
            <h3><Smartphone size={15} /> 手机号</h3>
            {!editPhone && (
              <button className="ac-ghost-btn" onClick={() => { setPhoneVal(profile.phone ?? ""); setEditPhone(true); }}>
                <Pencil size={14} /> {profile.phone ? "修改" : "绑定"}
              </button>
            )}
          </div>
          {editPhone ? (
            <div className="ac-edit-area">
              <InlineField value={phoneVal} onChange={setPhoneVal} placeholder="13800138000" />
              <div className="ac-edit-actions">
                <button className="ac-btn secondary" onClick={() => setEditPhone(false)}>取消</button>
                <button className="ac-btn primary" onClick={savePhone}><Check size={14} /> 保存</button>
              </div>
            </div>
          ) : (
            <div className="ac-prop-row">
              <span className="ac-prop-label">当前绑定</span>
              <span className="ac-prop-value">
                {profile.phone ? <>{profile.phone} {profile.phone_verified ? <span className="ac-tag green">已验证</span> : <span className="ac-tag amber">未验证</span>}</> : "—"}
              </span>
              {profile.phone && (
                <button className="ac-link-btn danger" onClick={unbindPhone}>解绑</button>
              )}
            </div>
          )}
        </section>

        {/* ── Password ── */}
        <section className="ac-card">
          <div className="ac-card-bar">
            <h3><Key size={15} /> 密码</h3>
            {!editPassword && (
              <button className="ac-ghost-btn" onClick={() => setEditPassword(true)}>
                <Pencil size={14} /> {security.has_password ? "修改" : "设置"}
              </button>
            )}
          </div>
          {editPassword ? (
            <div className="ac-edit-area">
              {security.has_password && (
                <InlineField value={oldPw} onChange={setOldPw} placeholder="当前密码" type={showPw ? "text" : "password"} />
              )}
              <InlineField value={newPw} onChange={setNewPw} placeholder="新密码" type={showPw ? "text" : "password"} />
              <div className="ac-edit-actions">
                <button className="ac-ghost-btn" onClick={() => setShowPw(p => !p)}>
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />} {showPw ? "隐藏" : "显示"}
                </button>
                <div style={{ flex: 1 }} />
                <button className="ac-btn secondary" onClick={() => setEditPassword(false)}>取消</button>
                <button className="ac-btn primary" onClick={savePassword}><Check size={14} /> 保存</button>
              </div>
            </div>
          ) : (
            <div className="ac-prop-row">
              <span className="ac-prop-label">状态</span>
              <span className="ac-prop-value">
                {security.has_password ? <span className="ac-tag green">已设置</span> : <span className="ac-tag amber">未设置</span>}
              </span>
            </div>
          )}
        </section>
      </div>

      <QRLoginModal
        isOpen={showBiliBind}
        onClose={() => setShowBiliBind(false)}
        onSuccess={onBiliBindSuccess}
        mode="bind"
      />
      <style jsx global>{AC_CSS}</style>
    </div>
  );
}

/* ─── sub-components ─── */

function Field({ label, value, onChange, placeholder, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <label className="ac-field">
      <span>{label}</span>
      <input className="ac-input" type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: Record<string, string>;
}) {
  return (
    <label className="ac-field">
      <span>{label}</span>
      <select className="ac-input" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">—</option>
        {Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="ac-ro-field">
      <span className="ac-ro-label">{label}</span>
      <span className="ac-ro-value">{value || "—"}</span>
    </div>
  );
}

/* ─── CSS ─── */

const AC_CSS = `
  .ac-root {
    height:100%;flex:1;display:flex;flex-direction:column;gap:16px;
    padding:24px;overflow-y:auto;
    background:var(--background, #0d1117);
    color:var(--foreground, #e6edf3);
    font-family:system-ui,-apple-system,sans-serif;
  }

  /* toast */
  .ac-toast {
    position:fixed;top:16px;right:16px;z-index:10000;
    padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;
    backdrop-filter:blur(12px);
    animation:acFadeIn .25s ease;
  }
  .ac-toast.success { background:rgba(22,163,74,.15);color:#4ade80;border:1px solid rgba(22,163,74,.2); }
  .ac-toast.error   { background:rgba(220,38,38,.12);color:#f87171;border:1px solid rgba(220,38,38,.18); }
  @keyframes acFadeIn { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }

  /* loading */
  .ac-loading { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted-foreground, #8b949e); }
  .ac-spinner { width:28px;height:28px;border:3px solid rgba(6,182,212,.15);border-top-color:#06b6d4;border-radius:50%;animation:acSpin .6s linear infinite; }
  @keyframes acSpin { to{transform:rotate(360deg)} }

  /* header */
  .ac-header { display:flex;align-items:center;gap:16px;padding-bottom:8px; }
  .ac-avatar {
    width:56px;height:56px;border-radius:50%;
    background:linear-gradient(135deg,#06b6d4 0%,#3b82f6 100%);
    color:#fff;font-size:22px;font-weight:700;
    display:flex;align-items:center;justify-content:center;flex-shrink:0;
  }
  .ac-identity h2 { margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em; }
  .ac-identity p  { margin:2px 0 0;font-size:13px;color:var(--muted-foreground, #8b949e); }

  /* chips */
  .ac-chips { display:flex;flex-wrap:wrap;gap:8px; }
  .ac-chip {
    display:inline-flex;align-items:center;gap:5px;
    padding:5px 12px;border-radius:20px;
    font-size:12px;font-weight:500;
    background:rgba(48,54,61,.5);color:#8b949e;
    border:1px solid rgba(48,54,61,.6);
  }
  .ac-chip.ok { background:rgba(22,163,74,.08);color:#4ade80;border-color:rgba(22,163,74,.15); }
  .ac-chip.warn { background:rgba(251,191,36,.08);color:#fbbf24;border-color:rgba(251,191,36,.15); }

  /* body */
  .ac-body { display:flex;flex-direction:column;gap:14px; }

  /* card */
  .ac-card {
    border:1px solid var(--border,rgba(48,54,61,.7));
    border-radius:14px;background:var(--card, #161b22);
    padding:20px;
  }
  .ac-card-bar { display:flex;align-items:center;justify-content:space-between;margin-bottom:14px; }
  .ac-card-bar h3 { margin:0;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px; }

  /* ghost / link buttons */
  .ac-ghost-btn {
    display:inline-flex;align-items:center;gap:4px;
    padding:6px 12px;border-radius:8px;border:1px solid rgba(48,54,61,.5);
    background:transparent;color:var(--muted-foreground, #8b949e);
    font-size:12px;font-weight:500;cursor:pointer;
    transition:background .12s,border-color .12s,color .12s;
  }
  .ac-ghost-btn:hover { background:rgba(6,182,212,.06);border-color:rgba(6,182,212,.25);color:var(--foreground,#e6edf3); }
  .ac-link-btn {
    background:none;border:none;font-size:12px;font-weight:500;cursor:pointer;padding:4px 0;
    color:var(--muted-foreground,#8b949e);
  }
  .ac-link-btn:hover { text-decoration:underline; }
  .ac-link-btn.danger { color:#f87171; }

  /* edit area */
  .ac-edit-area { display:flex;flex-direction:column;gap:10px; }
  .ac-grid-2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
  @media(max-width:760px) { .ac-grid-2{grid-template-columns:1fr} }
  .ac-edit-actions { display:flex;align-items:center;gap:8px;margin-top:4px; }

  /* buttons */
  .ac-btn {
    display:inline-flex;align-items:center;gap:4px;
    padding:8px 16px;border-radius:8px;border:1px solid transparent;
    font-size:13px;font-weight:500;cursor:pointer;
    transition:background .12s,opacity .12s;
  }
  .ac-btn.primary { background:#06b6d4;color:#0d1117;border-color:#06b6d4; }
  .ac-btn.primary:hover { background:#0891b2; }
  .ac-btn.secondary { background:transparent;color:var(--muted-foreground,#8b949e);border-color:rgba(48,54,61,.5); }
  .ac-btn.secondary:hover { background:rgba(48,54,61,.3);color:var(--foreground,#e6edf3); }

  /* field */
  .ac-field { display:flex;flex-direction:column;gap:5px; }
  .ac-field span { font-size:12px;font-weight:500;color:var(--muted-foreground,#8b949e); }
  .ac-input {
    width:100%;padding:9px 12px;border-radius:8px;box-sizing:border-box;
    border:1px solid rgba(48,54,61,.7);background:var(--background,#0d1117);
    color:var(--foreground,#e6edf3);font-size:13px;outline:none;
    transition:border-color .15s;
  }
  .ac-input:focus { border-color:#06b6d4; }
  select.ac-input { cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:32px; }

  /* readonly fields */
  .ac-readonly-grid { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
  @media(max-width:760px) { .ac-readonly-grid{grid-template-columns:1fr} }
  .ac-ro-field { display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:8px;background:rgba(48,54,61,.12); }
  .ac-ro-label { font-size:11px;font-weight:600;color:var(--muted-foreground,#8b949e);text-transform:uppercase;letter-spacing:.04em; }
  .ac-ro-value { font-size:13px; }

  /* prop row */
  .ac-prop-row { display:flex;align-items:center;gap:12px;padding:6px 0; }
  .ac-prop-label { font-size:13px;color:var(--muted-foreground,#8b949e);min-width:60px; }
  .ac-prop-value { font-size:13px;flex:1; }
  .ac-tag { display:inline-block;font-size:10px;padding:3px 8px;border-radius:10px;font-weight:600;margin-left:6px; }
  .ac-tag.green { background:rgba(22,163,74,.1);color:#4ade80; }
  .ac-tag.amber { background:rgba(251,191,36,.1);color:#fbbf24; }
  .ac-help-text { margin-left:8px;color:var(--muted-foreground,#8b949e); }

  /* light-mode overrides */
  html:not(.dark) .ac-root { background:var(--card,#fff);color:var(--foreground,#111827); }
  html:not(.dark) .ac-card { border-color:var(--border,#e5e7eb);background:var(--paper,#f9fafb); }
  html:not(.dark) .ac-chip { background:#f3f4f6;color:#6b7280;border-color:#e5e7eb; }
  html:not(.dark) .ac-chip.ok { background:rgba(22,163,74,.06);color:#16a34a;border-color:rgba(22,163,74,.12); }
  html:not(.dark) .ac-chip.warn { background:rgba(217,119,6,.06);color:#d97706;border-color:rgba(217,119,6,.12); }
  html:not(.dark) .ac-input { border-color:#e5e7eb;background:#fff;color:#111827; }
  html:not(.dark) .ac-input:focus { border-color:#06b6d4; }
  html:not(.dark) .ac-ro-field { background:#f3f4f6; }
  html:not(.dark) .ac-ghost-btn { border-color:#e5e7eb;color:#6b7280; }
  html:not(.dark) .ac-ghost-btn:hover { background:#f3f4f6;color:#111827; }
  html:not(.dark) .ac-btn.secondary { border-color:#e5e7eb;color:#6b7280; }
  html:not(.dark) .ac-btn.secondary:hover { background:#f3f4f6;color:#111827; }
  html:not(.dark) .ac-toast.success { background:rgba(22,163,74,.06);color:#16a34a;border-color:rgba(22,163,74,.12); }
  html:not(.dark) .ac-toast.error   { background:rgba(220,38,38,.06);color:#dc2626;border-color:rgba(220,38,38,.1); }

  @media(max-width:760px) {
    .ac-root { padding:16px; }
    .ac-header { flex-direction:column;text-align:center; }
  }
`;
