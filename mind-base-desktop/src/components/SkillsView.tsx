/**
 * 技能管理页（侧边栏独立入口）：技能商店（GitHub 搜索安装）+ 本地安装
 * （zip / 文件夹）+ 已安装列表（启停 / 卸载）。
 *
 * 商店协议与 app/skills/store 一致：GitHub Search API 按 query（空 =
 * topic:mindbase-skill）搜仓库，安装即下载 zipball 落到技能目录——
 * 与 Web 版技能包格式互通。
 */

import { useCallback, useEffect, useState } from "react";
import { pickDirectory } from "../lib/data-dir";
import {
  installFromStore,
  installSkillFromPath,
  installSkillZip,
  listSkills,
  openSkillsDir,
  searchStore,
  setSkillEnabled,
  uninstallSkill,
} from "../lib/skills";
import type { SkillMeta, StoreRepo } from "../lib/skills";
import { toErrorMessage } from "../lib/updater";
import type { Feedback } from "../lib/ui-state";

/** 仓库搜索结果行（名称 + 描述 + ★ + 安装按钮，安装中显示进度文案）。 */
function StoreRow({
  repo,
  busy,
  installing,
  onInstall,
}: {
  repo: StoreRepo;
  busy: boolean;
  installing: boolean;
  onInstall: (repo: StoreRepo) => void;
}): React.JSX.Element {
  return (
    <div className="store-row">
      <span className="store-row__info">
        <span className="store-row__name">{repo.fullName}</span>
        <span className="store-row__desc">
          {repo.description === "" ? "（无描述）" : repo.description}
        </span>
      </span>
      <span className="store-row__side">
        <span className="store-row__stars">★ {repo.stargazersCount}</span>
        <button
          type="button"
          className="button"
          disabled={busy}
          title={`从 ${repo.fullName}（${repo.defaultBranch} 分支）安装`}
          onClick={() => onInstall(repo)}
        >
          {installing ? "下载中…" : "安装"}
        </button>
      </span>
    </div>
  );
}

function SkillsView(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  // 商店搜索状态：query 草稿、结果、搜索中标记。
  const [searchDraft, setSearchDraft] = useState("");
  const [repos, setRepos] = useState<StoreRepo[] | null>(null);
  const [searching, setSearching] = useState(false);
  // 正在从 GitHub 下载的仓库（full_name）——驱动按钮 loading 文案。
  const [installingRepo, setInstallingRepo] = useState<string | null>(null);
  // 自由安装：owner/repo 输入（不经过搜索）。
  const [manualRepo, setManualRepo] = useState("");
  const [manualBranch, setManualBranch] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError("");
    try {
      setSkills(await listSkills());
    } catch (err) {
      setLoadError(toErrorMessage(err));
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runSearch(query: string | null): Promise<void> {
    setSearching(true);
    setFeedback(null);
    try {
      setRepos(await searchStore(query));
    } catch (err) {
      setFeedback({ kind: "error", text: `商店搜索失败：${toErrorMessage(err)}` });
      setRepos([]);
    } finally {
      setSearching(false);
    }
  }

  async function installRepo(repo: StoreRepo): Promise<void> {
    setBusy(true);
    setInstallingRepo(repo.fullName);
    setFeedback({
      kind: "ok",
      text: `正在从 GitHub 下载 ${repo.fullName}（zipball，视网络可能需要数十秒）…`,
    });
    try {
      const installed = await installFromStore(repo.fullName, repo.defaultBranch);
      setFeedback({ kind: "ok", text: `✓ 已从 GitHub 安装「${installed.name}」` });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "error", text: `安装失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
      setInstallingRepo(null);
    }
  }

  async function installManual(): Promise<void> {
    const repo = manualRepo.trim();
    if (repo === "") return;
    setBusy(true);
    setInstallingRepo(repo);
    setFeedback({
      kind: "ok",
      text: `正在从 GitHub 下载 ${repo}（zipball，视网络可能需要数十秒）…`,
    });
    try {
      const installed = await installFromStore(repo, manualBranch.trim() || null);
      setFeedback({ kind: "ok", text: `✓ 已从 GitHub 安装「${installed.name}」` });
      setManualRepo("");
      setManualBranch("");
      await refresh();
    } catch (err) {
      setFeedback({ kind: "error", text: `安装失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
      setInstallingRepo(null);
    }
  }

  async function installZipFile(): Promise<void> {
    setFeedback(null);
    const installed = await installSkillZip();
    if (installed === null) return; // 用户取消
    setBusy(true);
    try {
      setFeedback({ kind: "ok", text: `✓ 已安装「${installed.name}」，默认启用` });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "error", text: `安装失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function installFolder(): Promise<void> {
    setFeedback(null);
    const source = await pickDirectory("选择包含 SKILL.md 的技能文件夹");
    if (source === null) return;
    setBusy(true);
    try {
      const installed = await installSkillFromPath(source);
      setFeedback({ kind: "ok", text: `✓ 已安装「${installed.name}」，默认启用` });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "error", text: `安装失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(skill: SkillMeta): Promise<void> {
    const next = !skill.enabled;
    setSkills(
      (prev) =>
        prev?.map((entry) =>
          entry.folder === skill.folder ? { ...entry, enabled: next } : entry,
        ) ?? prev,
    );
    try {
      await setSkillEnabled(skill.folder, next);
      setFeedback({
        kind: "ok",
        text: next ? `✓ 已启用「${skill.name}」` : `✓ 已停用「${skill.name}」`,
      });
    } catch (err) {
      setSkills(
        (prev) =>
          prev?.map((entry) =>
            entry.folder === skill.folder ? { ...entry, enabled: !next } : entry,
          ) ?? prev,
      );
      setFeedback({ kind: "error", text: `保存失败：${toErrorMessage(err)}` });
    }
  }

  async function remove(skill: SkillMeta): Promise<void> {
    if (!window.confirm(`卸载技能「${skill.name}」？其文件夹将被删除。`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await uninstallSkill(skill.folder);
      setFeedback({ kind: "ok", text: `✓ 已卸载「${skill.name}」` });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "error", text: `卸载失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function openDir(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      await openSkillsDir();
    } catch (err) {
      setFeedback({ kind: "error", text: `打开失败：${toErrorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-pane">
      <section className="card">
        <h2 className="card__title">
          <span className="card__index">01</span>技能商店（GitHub）
        </h2>
        <p className="card-hint">
          搜索 GitHub 上的技能仓库（默认 topic：mindbase-skill），安装即下载仓库 zipball 到本地技能目录——
          与 Web 版（app/）技能包格式互通。
        </p>
        <div className="cfg-actions skills-view__search">
          <input
            type="text"
            className="cfg-input"
            placeholder="搜索关键词，留空用默认 topic"
            value={searchDraft}
            spellCheck={false}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch(searchDraft.trim() || null);
            }}
          />
          <button
            type="button"
            className="button button--primary"
            disabled={searching}
            onClick={() => void runSearch(searchDraft.trim() || null)}
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        {repos !== null && (
          <div className="store-list">
            {repos.length === 0 ? (
              <p className="placeholder">没有匹配的仓库；换个关键词，或直接在下方输入 owner/repo 安装。</p>
            ) : (
              repos.map((repo) => (
                <StoreRow
                  key={repo.fullName}
                  repo={repo}
                  busy={busy}
                  installing={installingRepo === repo.fullName}
                  onInstall={(r) => void installRepo(r)}
                />
              ))
            )}
          </div>
        )}

        <div className="cfg-actions skills-view__manual">
          <input
            type="text"
            className="cfg-input"
            placeholder="或直接输入 owner/repo"
            value={manualRepo}
            spellCheck={false}
            onChange={(event) => setManualRepo(event.target.value)}
          />
          <input
            type="text"
            className="cfg-input cfg-input--branch"
            placeholder="分支（默认）"
            value={manualBranch}
            spellCheck={false}
            onChange={(event) => setManualBranch(event.target.value)}
          />
          <button type="button" className="button" disabled={busy || manualRepo.trim() === ""} onClick={() => void installManual()}>
            {installingRepo === manualRepo.trim() && manualRepo.trim() !== "" ? "下载中…" : "安装"}
          </button>
        </div>

        {feedback !== null && (
          <p className={feedback.kind === "error" ? "error-text" : "hint-text"}>{feedback.text}</p>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">02</span>本地安装
        </h2>
        <div className="cfg-actions skills-card__actions">
          <button type="button" className="button" disabled={busy} onClick={() => void installZipFile()}>
            安装 zip 技能包…
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void installFolder()}>
            导入文件夹…
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void openDir()}>
            打开技能文件夹
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">03</span>已安装
        </h2>
        {skills === null ? (
          <p className="placeholder">加载中…</p>
        ) : loadError !== "" ? (
          <p className="error-text">技能目录读取失败：{loadError}</p>
        ) : skills.length === 0 ? (
          <p className="placeholder">还没有已安装的技能——从上方商店搜索，或导入本地技能包。</p>
        ) : (
          <ul className="skill-list">
            {skills.map((skill) => (
              <li key={skill.folder} className="skill-row">
                <span className="skill-row__info">
                  <span className="skill-row__name">{skill.name}</span>
                  <span className="skill-row__desc">
                    {skill.description === "" ? "（无描述）" : skill.description}
                  </span>
                </span>
                <span className="skill-row__side">
                  <label className="skill-row__toggle" title={skill.enabled ? "点击停用" : "点击启用"}>
                    <input
                      type="checkbox"
                      className="skill-switch"
                      checked={skill.enabled}
                      onChange={() => void toggle(skill)}
                    />
                    <span className="skill-row__state">{skill.enabled ? "已启用" : "已停用"}</span>
                  </label>
                  <button
                    type="button"
                    className="button skill-row__remove"
                    disabled={busy}
                    title="卸载并删除技能文件夹"
                    onClick={() => void remove(skill)}
                  >
                    卸载
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default SkillsView;
