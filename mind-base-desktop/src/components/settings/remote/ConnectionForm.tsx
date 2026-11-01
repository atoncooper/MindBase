//! 连接配置表单 + 安全区块（指纹固定/重置、项目绑定、Agent 授权、会话日志）。

import type { HostsController } from "./useHosts";
import { pinnedFingerprint, testSummary } from "./shared";

export interface ConnectionFormProps {
  hosts: HostsController;
  /** 弹窗内复用：去掉卡片外框与标题（标题由弹窗头提供）。 */
  embedded?: boolean;
  /** 保存成功后回调（弹窗据此自动关闭）。 */
  onSaved?: () => void;
  /** 删除成功后回调（弹窗据此关闭）。 */
  onDeleted?: () => void;
}

export default function ConnectionForm({
  hosts,
  embedded = false,
  onSaved,
  onDeleted,
}: ConnectionFormProps) {
  const {
    draft,
    isNew,
    selectedName,
    selectedHost,
    projects,
    busy,
    testing,
    testResult,
    feedback,
    fingerprintMismatch,
    resettingFingerprint,
    trustingFingerprint,
    fingerprintFeedback,
    updateDraft,
    handleSave,
    handleTest,
    handleDelete,
    handlePickKey,
    handleForgetFingerprint,
    handleTrustTestFingerprint,
    handleResetFingerprintAndRetry,
  } = hosts;

  // 绑定项目下拉选项：项目列表加载失败时只剩「未绑定」；已绑定但列表里没有的项目回退显示 id。
  const projectOptions = projects.map((project) => ({ id: project.id, title: project.title }));
  const currentProjectId = draft?.projectId ?? "";
  if (
    currentProjectId !== "" &&
    !projectOptions.some((option) => option.id === currentProjectId)
  ) {
    projectOptions.push({ id: currentProjectId, title: currentProjectId });
  }
  // 「测试连接」返回的实际指纹与当前固定值不同时，提供一键信任（人工核对后用）。
  const testFingerprint =
    testResult !== null && testResult.name === selectedName ? testResult.result.fingerprint : "";
  const canTrustTestFingerprint =
    !isNew &&
    selectedHost !== null &&
    testFingerprint !== "" &&
    pinnedFingerprint(selectedHost) !== testFingerprint;

  return (
    <section className={embedded ? "remote-editor remote-editor--embedded" : "card remote-editor"}>
      {!embedded && (
        <div className="remote-card__head">
          <h2 className="card__title remote-card__title">
            <span className="card__index">01</span>
            {isNew ? "新建会话" : "连接配置"}
          </h2>
          {selectedHost !== null && !isNew && (
            <span className="remote-editor__target">
              {selectedHost.username}@{selectedHost.host}:{selectedHost.port}
            </span>
          )}
        </div>
      )}

      {draft === null ? (
        <p className="placeholder">选择左侧会话，或点击「新建会话」添加一台远程服务器。</p>
      ) : (
        <>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-name">
              名称
            </label>
            <input
              id="remote-name"
              className="cfg-input"
              type="text"
              value={draft.name}
              placeholder="如：生产服务器"
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
          </div>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-host">
              主机
            </label>
            <input
              id="remote-host"
              className="cfg-input"
              type="text"
              value={draft.host}
              placeholder="IP 或域名"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => updateDraft({ host: event.target.value })}
            />
          </div>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-port">
              端口
            </label>
            <input
              id="remote-port"
              className="cfg-input cfg-input--narrow"
              type="number"
              min={1}
              max={65535}
              step={1}
              value={draft.port}
              onChange={(event) => updateDraft({ port: event.target.value })}
            />
          </div>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-username">
              用户名
            </label>
            <input
              id="remote-username"
              className="cfg-input"
              type="text"
              value={draft.username}
              placeholder="root"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => updateDraft({ username: event.target.value })}
            />
          </div>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-auth">
              认证方式
            </label>
            <select
              id="remote-auth"
              className="cfg-input cfg-input--narrow"
              value={draft.auth}
              onChange={(event) =>
                updateDraft({ auth: event.target.value === "key" ? "key" : "password" })
              }
            >
              <option value="password">密码</option>
              <option value="key">密钥（PEM）</option>
            </select>
          </div>
          {draft.auth === "password" ? (
            <div className="cfg-row cfg-row--wide">
              <label className="cfg-label" htmlFor="remote-password">
                密码
              </label>
              <input
                id="remote-password"
                className="cfg-input"
                type="password"
                autoComplete="new-password"
                value={draft.password}
                placeholder="SSH 登录密码（保存在系统凭据管理器）"
                onChange={(event) => updateDraft({ password: event.target.value })}
              />
            </div>
          ) : (
            <>
              <div className="cfg-row">
                <label className="cfg-label" htmlFor="remote-key-path">
                  密钥路径
                </label>
                <input
                  id="remote-key-path"
                  className="cfg-input"
                  type="text"
                  value={draft.keyPath}
                  placeholder="C:/Users/you/.ssh/id_ed25519"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => updateDraft({ keyPath: event.target.value })}
                />
                <button type="button" className="button" onClick={() => void handlePickKey()}>
                  选择 PEM
                </button>
              </div>
              <div className="cfg-row cfg-row--wide">
                <label className="cfg-label" htmlFor="remote-passphrase">
                  密钥口令
                </label>
                <input
                  id="remote-passphrase"
                  className="cfg-input"
                  type="password"
                  autoComplete="new-password"
                  value={draft.passphrase}
                  placeholder="可选：私钥有口令时填写"
                  onChange={(event) => updateDraft({ passphrase: event.target.value })}
                />
              </div>
            </>
          )}
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-dir">
              默认远程目录
            </label>
            <input
              id="remote-dir"
              className="cfg-input"
              type="text"
              value={draft.remoteDir}
              placeholder="可选：如 /home/user/project"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => updateDraft({ remoteDir: event.target.value })}
            />
          </div>
          <div className="cfg-row cfg-row--wide">
            <label className="cfg-label" htmlFor="remote-project">
              绑定科研项目
            </label>
            <select
              id="remote-project"
              className="cfg-input"
              value={draft.projectId}
              onChange={(event) => updateDraft({ projectId: event.target.value })}
            >
              <option value="">未绑定</option>
              {projectOptions.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.title} · {option.id}
                </option>
              ))}
            </select>
          </div>
          <div className="cfg-row cfg-row--wide">
            <span className="cfg-label">Agent 授权</span>
            <label className="checkbox-row remote-allow-agent">
              <input
                type="checkbox"
                checked={draft.allowAgent}
                onChange={(event) => updateDraft({ allowAgent: event.target.checked })}
              />
              允许 Agent 使用此服务器
            </label>
          </div>
          {draft.allowAgent && draft.projectId === "" && (
            <p className="hint-text remote-allow-agent__hint">
              未绑定科研项目时 Agent 无法使用该服务器：建议先绑定项目，再允许 Agent 使用。
            </p>
          )}
          <div className="cfg-row cfg-row--wide">
            <span className="cfg-label">会话日志</span>
            <label className="checkbox-row remote-allow-agent">
              <input
                type="checkbox"
                checked={draft.logSession}
                onChange={(event) => updateDraft({ logSession: event.target.checked })}
              />
              记录会话日志（输出写入本机 logs/ssh）
            </label>
          </div>

          <div className="card__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  const saved = await handleSave();
                  if (saved) onSaved?.();
                })();
              }}
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || testing || isNew || selectedHost === null}
              onClick={() => void handleTest()}
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || isNew || selectedHost === null}
              onClick={() => {
                void (async () => {
                  const deleted = await handleDelete();
                  if (deleted) onDeleted?.();
                })();
              }}
            >
              删除
            </button>
          </div>

          {testResult !== null && testResult.name === selectedName && (
            <p
              className={
                testResult.result.ok ? "remote-test remote-test--ok" : "remote-test"
              }
            >
              <span
                className={
                  testResult.result.ok ? "status status--ok" : "status status--error"
                }
              >
                {testResult.result.ok ? "连接成功" : "连接失败"}
              </span>
              <span className="remote-test__text">{testSummary(testResult.result)}</span>
            </p>
          )}
          <p className="hint-text">保存后才会用于连接；测试连接使用已保存的配置。</p>

          <div className="remote-security">
            <div className="remote-security__head">
              <span className="remote-security__title">安全</span>
              <span
                className={
                  selectedHost !== null && pinnedFingerprint(selectedHost) !== ""
                    ? "status status--ok"
                    : "status"
                }
              >
                {selectedHost !== null && pinnedFingerprint(selectedHost) !== ""
                  ? "指纹已固定"
                  : "指纹未信任"}
              </span>
            </div>
            <div className="remote-security__row">
              <span className="remote-security__label">主机指纹</span>
              <code className="remote-security__fp">
                {selectedHost !== null && pinnedFingerprint(selectedHost) !== ""
                  ? pinnedFingerprint(selectedHost)
                  : "未信任（首次连接自动记录）"}
              </code>
            </div>
            <p className="hint-text remote-security__hint">
              密码 / 私钥口令保存在系统凭据管理器（Windows Credential Manager / macOS Keychain /
              Linux Secret Service），配置文件里只保存引用；旧版 DPAPI 密文会在下次保存时自动迁移。
            </p>
            <div className="remote-security__actions">
              <button
                type="button"
                className="button"
                disabled={
                  selectedHost === null ||
                  pinnedFingerprint(selectedHost) === "" ||
                  resettingFingerprint
                }
                onClick={() => void handleForgetFingerprint()}
              >
                {resettingFingerprint ? "处理中…" : "重置指纹"}
              </button>
              {canTrustTestFingerprint && (
                <button
                  type="button"
                  className="button"
                  disabled={trustingFingerprint || resettingFingerprint}
                  onClick={() => void handleTrustTestFingerprint()}
                >
                  {trustingFingerprint ? "信任中…" : "信任测试返回的指纹"}
                </button>
              )}
            </div>
            <p className="hint-text">
              TOFU：首次连接会自动记录并信任服务器指纹；若服务器指纹变化（重装系统或中间人攻击），
              连接会被拒绝。请人工核对新指纹后再重置并重新连接。
            </p>
            {fingerprintMismatch !== null && fingerprintMismatch.name === selectedName && (
              <div className="remote-security__alert">
                <p className="error-text remote-security__alert-text">
                  {fingerprintMismatch.message}
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={resettingFingerprint}
                  onClick={() => void handleResetFingerprintAndRetry(fingerprintMismatch.retry)}
                >
                  {resettingFingerprint ? "重置中…" : "重置指纹并重试"}
                </button>
              </div>
            )}
            {fingerprintFeedback !== null && (
              <p
                className={
                  fingerprintFeedback.kind === "error" ? "error-text" : "hint-text"
                }
              >
                {fingerprintFeedback.text}
              </p>
            )}
          </div>
        </>
      )}

      {feedback !== null && (
        <p className={feedback.kind === "error" ? "error-text" : "hint-text"}>
          {feedback.text}
        </p>
      )}
    </section>
  );
}
