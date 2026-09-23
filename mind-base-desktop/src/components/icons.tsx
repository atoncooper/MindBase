/**
 * 共享的小型 UI glyph：多视图复用的单色描边图标（Material 风格）。
 * 图标统一 24 viewBox + currentColor，尺寸由使用处的容器控制。
 */

/** 放大镜 glyph（Google 式搜索框用）。 */
export function SearchGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}
