/**
 * 技能快选菜单：输入框键入 "/" 时弹出，↑↓ 导航、Enter/Tab 选中、Esc 关闭。
 * 选中即「强制注入」——该技能全文随本轮 chat_ask 传给后端，优先于模型
 * 自主调用 load_skill 的行为。
 */

import type { SkillMeta } from "../../lib/skills";

interface SkillMenuProps {
  skills: SkillMeta[];
  selectedIndex: number;
  onPick: (skill: SkillMeta) => void;
  onHover: (index: number) => void;
}

function SkillMenu({ skills, selectedIndex, onPick, onHover }: SkillMenuProps): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <div className="skill-menu" role="listbox" aria-label="技能快选">
        <p className="skill-menu__empty">没有匹配的技能；在「设置 → 技能」中添加 SKILL.md 后即可使用</p>
      </div>
    );
  }
  return (
    <div className="skill-menu" role="listbox" aria-label="技能快选">
      <p className="skill-menu__hint">选择要强制注入的技能（↑↓ 导航 · Enter 确认 · Esc 取消）</p>
      {skills.map((skill, index) => (
        <button
          key={skill.folder}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          className={index === selectedIndex ? "skill-menu__item is-active" : "skill-menu__item"}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(skill)}
        >
          <span className="skill-menu__name">/{skill.name}</span>
          <span className="skill-menu__desc">
            {skill.description === "" ? "（无描述）" : skill.description}
          </span>
        </button>
      ))}
    </div>
  );
}

export default SkillMenu;
