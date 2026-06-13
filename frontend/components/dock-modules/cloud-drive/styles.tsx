// Global styled-jsx block for the cloud-drive panel.
// Extracted verbatim from cloud-drive.tsx to keep the main file lean.
// `<style jsx global>` injects rules at the document level, so it
// doesn't matter which component renders this — the rules apply panel-wide.

export default function CloudDriveStyles() {
  return (
    <style jsx global>{`
        /* ── Google Drive-inspired tokens ──
           Light palette by default; dark mode rules at the bottom.
           No glassmorphism, no backdrop-blur — flat Material surfaces. */
        .cd-panel {
          --gd-primary: #1a73e8;
          --gd-primary-hover: #1765cc;
          --gd-primary-50: #e8f0fe;
          --gd-primary-100: #d2e3fc;
          --gd-on-primary: #ffffff;
          --gd-surface: #ffffff;
          --gd-surface-2: #f8f9fa;
          --gd-surface-3: #f1f3f4;
          --gd-border: #dadce0;
          --gd-divider: #e8eaed;
          --gd-text: #202124;
          --gd-text-secondary: #5f6368;
          --gd-text-muted: #80868b;
          --gd-success: #188038;
          --gd-success-50: #e6f4ea;
          --gd-warning: #b06000;
          --gd-warning-50: #feefc3;
          --gd-danger: #d93025;
          --gd-danger-50: #fce8e6;
          --gd-skip: #5f6368;
          --gd-skip-50: #f1f3f4;
          --gd-shadow-1: 0 1px 2px 0 rgba(60,64,67,0.10), 0 1px 3px 1px rgba(60,64,67,0.06);
          --gd-shadow-2: 0 1px 3px 0 rgba(60,64,67,0.16), 0 4px 8px 3px rgba(60,64,67,0.08);

          height: 100%; flex: 1; display: flex; flex-direction: column;
          background: var(--gd-surface-2);
          color: var(--gd-text);
          font-family: "Google Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          overflow: hidden;
          position: relative;
        }

        /* ── Custom scrollbars (Material thin overlay style) ──
           Applied to every scrollable child of the panel. Track is
           transparent until hover, thumb is a soft pill that darkens
           on hover. WebKit + Firefox both covered. */
        .cd-panel *::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .cd-panel *::-webkit-scrollbar-track {
          background: transparent;
        }
        .cd-panel *::-webkit-scrollbar-thumb {
          background-color: transparent;
          border: 2px solid transparent;
          border-radius: 999px;
          background-clip: padding-box;
          transition: background-color .2s;
        }
        .cd-panel *:hover::-webkit-scrollbar-thumb,
        .cd-panel *:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(60, 64, 67, 0.35);
        }
        .cd-panel *::-webkit-scrollbar-thumb:hover {
          background-color: rgba(60, 64, 67, 0.55);
        }
        .cd-panel *::-webkit-scrollbar-thumb:active {
          background-color: rgba(60, 64, 67, 0.75);
        }
        .cd-panel *::-webkit-scrollbar-corner {
          background: transparent;
        }
        /* Firefox — coarse-grained but consistent palette */
        .cd-panel * {
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
        }
        .cd-panel *:hover,
        .cd-panel *:focus-within {
          scrollbar-color: rgba(60, 64, 67, 0.45) transparent;
        }
        .sk-toast {
          position: fixed; top: 20px; right: 24px; z-index: 99999;
          padding: 10px 18px; border-radius: 4px; font-size: 13.5px; font-weight: 500;
          animation: cdFadeSlideIn .25s ease;
          box-shadow: var(--gd-shadow-2); pointer-events: none;
        }
        .sk-toast.success {
          background: #323639; color: #fff;
        }
        @keyframes cdFadeSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Header ── */
        .cd-header {
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding: 12px 24px; background: var(--gd-surface);
          border-bottom: 1px solid var(--gd-divider); flex-shrink: 0;
        }
        .cd-header-left { display: flex; align-items: center; gap: 10px; color: var(--gd-primary); }
        .cd-header-left h2 {
          font-size: 18px; font-weight: 500; color: var(--gd-text); margin: 0;
          letter-spacing: 0;
        }
        .cd-header-sub { font-size: 12px; color: var(--gd-text-secondary); margin-left: 4px; }
        .cd-header-actions { display: flex; align-items: center; gap: 8px; }

        /* ── Buttons (Material-ish) ── */
        .cd-btn {
          display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px;
          border-radius: 999px; font-size: 13px; font-weight: 500; cursor: pointer;
          border: 1px solid transparent; transition: background .12s, border-color .12s, box-shadow .12s;
          font-family: inherit;
        }
        .cd-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .cd-btn-primary {
          background: var(--gd-primary-50); color: var(--gd-primary);
          border-color: transparent;
        }
        .cd-btn-primary:hover { background: var(--gd-primary-100); }
        .cd-btn-accent {
          background: var(--gd-primary); color: var(--gd-on-primary);
          border-color: var(--gd-primary);
        }
        .cd-btn-accent:hover { background: var(--gd-primary-hover); border-color: var(--gd-primary-hover); }
        .cd-btn-outline {
          border-color: var(--gd-border); background: var(--gd-surface);
          color: var(--gd-text-secondary);
        }
        .cd-btn-outline:hover { color: var(--gd-text); background: var(--gd-surface-3); }
        .cd-btn-icon {
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; border-radius: 999px;
          border: none; background: transparent; color: var(--gd-text-secondary);
          cursor: pointer; transition: background .12s, color .12s;
        }
        .cd-btn-icon:hover { color: var(--gd-text); background: var(--gd-surface-3); }
        .cd-btn-icon-danger:hover { color: var(--gd-danger); background: var(--gd-danger-50); }

        .cd-input {
          padding: 8px 12px; border-radius: 4px; border: 1px solid var(--gd-border);
          background: var(--gd-surface); color: var(--gd-text); font-size: 13px;
          outline: none; min-width: 200px; font-family: inherit;
          transition: border-color .12s, box-shadow .12s;
        }
        .cd-input:focus {
          border-color: var(--gd-primary);
          box-shadow: 0 0 0 1px var(--gd-primary);
        }

        /* ── Upload progress ── */
        .cd-upload-bar-wrap {
          display: flex; align-items: center; gap: 12px; padding: 8px 24px;
          background: var(--gd-primary-50); border-bottom: 1px solid var(--gd-divider);
          flex-shrink: 0;
        }
        .cd-upload-bar-track {
          flex: 1; height: 4px; border-radius: 2px;
          background: var(--gd-primary-100); overflow: hidden;
        }
        .cd-upload-bar-fill {
          height: 100%; border-radius: 2px;
          background: var(--gd-primary);
          transition: width .3s ease;
        }
        .cd-upload-bar-label {
          font-size: 12px; color: var(--gd-primary); white-space: nowrap; font-weight: 500;
          min-width: 160px; text-align: right;
        }

        /* ── Inline create folder ── */
        .cd-create-folder {
          display: flex; align-items: center; gap: 8px; padding: 12px 24px;
          background: var(--gd-surface); border-bottom: 1px solid var(--gd-divider);
          flex-shrink: 0;
        }

        .cd-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }

        /* ── Sidebar (Drive nav rail style) ── */
        .cd-sidebar {
          width: 256px; flex-shrink: 0; overflow-y: auto;
          background: var(--gd-surface-2);
          border-right: 1px solid var(--gd-divider);
          padding: 8px 8px 16px;
        }
        .cd-folder-row {
          display: flex; align-items: center; gap: 8px;
          padding: 0 12px; height: 36px;
          cursor: pointer; font-size: 14px; color: var(--gd-text);
          border-radius: 0 999px 999px 0; margin-right: 8px;
          transition: background .1s;
        }
        .cd-folder-row:hover { background: var(--gd-surface-3); }
        .cd-folder-row--active {
          background: var(--gd-primary-50); color: var(--gd-primary); font-weight: 500;
        }
        .cd-folder-row--active:hover { background: var(--gd-primary-100); }
        .cd-folder-root {
          font-weight: 500; height: 40px; padding-left: 16px;
          margin-bottom: 4px;
        }
        .cd-folder-chevron {
          display: flex; width: 18px; height: 18px;
          align-items: center; justify-content: center;
          background: none; border: none; color: inherit; cursor: pointer; padding: 0;
          flex-shrink: 0; border-radius: 50%;
        }
        .cd-folder-chevron:hover { background: rgba(0,0,0,0.05); }
        .cd-folder-chevron-placeholder { width: 18px; flex-shrink: 0; }
        .cd-folder-icon {
          display: flex; color: var(--gd-text-secondary); flex-shrink: 0;
        }
        .cd-folder-row--active .cd-folder-icon { color: var(--gd-primary); }
        .cd-folder-name {
          flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .cd-folder-count {
          font-size: 11px; padding: 1px 7px; border-radius: 999px;
          background: var(--gd-surface-3); color: var(--gd-text-secondary); font-weight: 500;
        }
        .cd-folder-row--active .cd-folder-count {
          background: var(--gd-primary-100); color: var(--gd-primary);
        }
        .cd-folder-del, .cd-folder-rename {
          display: none; background: none; border: none; cursor: pointer;
          padding: 4px; border-radius: 50%; color: var(--gd-text-secondary);
        }
        .cd-folder-row:hover .cd-folder-del,
        .cd-folder-row:hover .cd-folder-rename { display: flex; }
        .cd-folder-del:hover { color: var(--gd-danger); background: var(--gd-danger-50); }
        .cd-folder-rename:hover { color: var(--gd-primary); background: var(--gd-primary-50); }
        .cd-folder-rename-input {
          flex: 1; min-width: 0; font-size: 13px; padding: 4px 8px;
          border: 1px solid var(--gd-primary); border-radius: 4px;
          background: var(--gd-surface); color: var(--gd-text); outline: none;
        }

        .cd-empty-sidebar {
          padding: 24px 16px; text-align: center;
          font-size: 13px; color: var(--gd-text-muted);
        }
        .cd-loading {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          padding: 32px; color: var(--gd-text-secondary); font-size: 13px;
        }

        /* ── File list area ── */
        .cd-file-list {
          flex: 1; overflow-y: auto; background: var(--gd-surface-2);
          display: flex; flex-direction: column;
        }
        .cd-breadcrumb {
          display: flex; align-items: center; gap: 2px;
          padding: 12px 24px; background: var(--gd-surface-2);
          flex-shrink: 0; flex-wrap: wrap;
        }
        .cd-crumb {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 10px; border-radius: 4px;
          background: transparent; border: none; cursor: pointer;
          font-size: 14px; font-weight: 500; color: var(--gd-text);
          font-family: inherit; transition: background .12s, color .12s;
        }
        .cd-crumb:hover { background: var(--gd-surface-3); }
        .cd-crumb--active {
          color: var(--gd-text); font-weight: 500;
        }
        .cd-crumb-group { display: inline-flex; align-items: center; }
        .cd-crumb-sep { color: var(--gd-text-muted); margin: 0 2px; }

        .cd-empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          flex: 1; gap: 12px; color: var(--gd-text-secondary); padding: 64px 24px;
        }
        .cd-empty p { margin: 0; font-size: 14px; font-weight: 500; color: var(--gd-text); }
        .cd-empty-sub {
          font-size: 13px !important; font-weight: 400 !important;
          color: var(--gd-text-secondary) !important;
        }

        /* ── Toolbar (search + sort + view) ── */
        .cd-toolbar {
          display: flex; align-items: center; gap: 12px;
          padding: 0 24px 8px; flex-shrink: 0;
        }
        .cd-search {
          position: relative; flex: 1; max-width: 720px;
          display: flex; align-items: center;
        }
        .cd-search-icon {
          position: absolute; left: 14px; color: var(--gd-text-secondary);
          pointer-events: none;
        }
        .cd-search-input {
          width: 100%; height: 40px; padding: 0 36px 0 40px;
          border-radius: 8px; border: 1px solid transparent;
          background: var(--gd-surface-3); color: var(--gd-text);
          font-size: 14px; outline: none; font-family: inherit;
          transition: background .12s, box-shadow .12s, border-color .12s;
        }
        .cd-search-input::placeholder { color: var(--gd-text-secondary); }
        .cd-search-input:hover {
          background: var(--gd-surface);
          box-shadow: var(--gd-shadow-1);
        }
        .cd-search-input:focus {
          background: var(--gd-surface);
          border-color: var(--gd-primary);
          box-shadow: 0 0 0 1px var(--gd-primary);
        }
        .cd-search-clear {
          position: absolute; right: 8px;
          width: 24px; height: 24px; border-radius: 50%;
          border: none; background: transparent;
          color: var(--gd-text-secondary); cursor: pointer;
          font-size: 18px; line-height: 1;
        }
        .cd-search-clear:hover { background: rgba(0,0,0,0.06); color: var(--gd-text); }

        .cd-toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .cd-toolbar-btn {
          display: inline-flex; align-items: center; gap: 6px;
          height: 32px; padding: 0 10px; border-radius: 4px;
          background: transparent; border: 1px solid transparent;
          color: var(--gd-text-secondary); cursor: pointer;
          font-size: 13px; font-weight: 500; font-family: inherit;
          transition: background .12s, color .12s, border-color .12s;
        }
        .cd-toolbar-btn:hover { background: var(--gd-surface-3); color: var(--gd-text); }

        .cd-sort-wrap { position: relative; }
        .cd-sort-menu {
          position: absolute; top: 36px; right: 0; z-index: 50;
          min-width: 160px; padding: 6px 0; border-radius: 4px;
          background: var(--gd-surface);
          box-shadow: var(--gd-shadow-2);
          border: 1px solid var(--gd-divider);
        }
        .cd-sort-item {
          display: flex; align-items: center; justify-content: space-between;
          width: 100%; padding: 8px 16px;
          background: transparent; border: none; cursor: pointer;
          font-size: 13px; font-family: inherit; color: var(--gd-text);
          text-align: left;
        }
        .cd-sort-item:hover { background: var(--gd-surface-3); }
        .cd-sort-item--active { color: var(--gd-primary); font-weight: 500; }

        .cd-view-toggle {
          display: inline-flex; border-radius: 4px;
          background: var(--gd-surface-3); padding: 2px;
        }
        .cd-view-btn {
          height: 28px; padding: 0 8px; border-radius: 3px;
        }
        .cd-view-btn:hover { background: var(--gd-surface); }
        .cd-view-btn--active {
          background: var(--gd-surface);
          color: var(--gd-primary);
          box-shadow: var(--gd-shadow-1);
        }

        /* ── File rows (Drive list view) ── */
        .cd-video-grid {
          display: flex; flex-direction: column; gap: 4px;
          padding: 0 24px 24px;
        }
        .cd-video-grid--grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 12px;
          padding: 0 24px 24px;
        }
        .cd-video-grid--grid .cd-video-card {
          flex-direction: column; align-items: stretch;
          gap: 12px; padding: 14px;
          border: 1px solid var(--gd-divider);
        }
        .cd-video-grid--grid .cd-video-icon {
          width: 100%; height: 96px; border-radius: 6px;
        }
        .cd-video-grid--grid .cd-video-meta { flex-wrap: wrap; gap: 8px; }
        .cd-video-grid--grid .cd-video-actions { opacity: 1; align-self: flex-end; }

        .cd-empty-search {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          flex: 1; gap: 8px; color: var(--gd-text-secondary); padding: 64px 24px;
        }
        .cd-empty-search p { margin: 0; font-size: 14px; font-weight: 500; color: var(--gd-text); }
        .cd-video-card {
          display: flex; align-items: center; gap: 16px;
          padding: 10px 14px; border-radius: 8px;
          background: var(--gd-surface);
          border: 1px solid transparent;
          transition: background .12s, border-color .12s, box-shadow .12s;
        }
        .cd-video-card:hover {
          background: var(--gd-surface-3);
          box-shadow: var(--gd-shadow-1);
        }
        .cd-video-icon {
          display: flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; border-radius: 4px;
          background: var(--gd-surface-3); flex-shrink: 0;
        }
        .cd-video-info {
          flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
        }
        .cd-video-name {
          font-size: 14px; font-weight: 500;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: var(--gd-text);
        }
        .cd-video-meta {
          display: flex; gap: 12px; align-items: center;
          font-size: 12px; color: var(--gd-text-secondary);
        }
        .cd-meta-type {
          font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 500;
          background: var(--gd-surface-3); color: var(--gd-text-secondary);
        }
        .cd-status-group { display: flex; gap: 6px; }
        .cd-status-tag {
          font-size: 11px; padding: 2px 8px; border-radius: 999px;
          font-weight: 500; white-space: nowrap;
        }
        .cd-status-done { background: var(--gd-success-50); color: var(--gd-success); }
        .cd-status-proc { background: var(--gd-warning-50); color: var(--gd-warning); }
        .cd-status-pend { background: var(--gd-skip-50); color: var(--gd-skip); }
        .cd-status-fail { background: var(--gd-danger-50); color: var(--gd-danger); }
        .cd-status-skip { background: var(--gd-skip-50); color: var(--gd-skip); }
        .cd-video-actions {
          display: flex; gap: 2px; flex-shrink: 0; opacity: 0;
          transition: opacity .12s;
        }
        .cd-video-card:hover .cd-video-actions { opacity: 1; }
        .cd-load-more { align-self: center; margin: 16px 0; }

        /* ── Multi-select checkbox ── */
        .cd-card-checkbox {
          flex-shrink: 0;
          width: 18px; height: 18px;
          margin: 0; cursor: pointer;
          accent-color: var(--gd-primary);
          opacity: 0;
          transition: opacity .12s;
        }
        .cd-video-card:hover .cd-card-checkbox,
        .cd-card-checkbox:checked,
        .cd-video-card--selected .cd-card-checkbox { opacity: 1; }
        .cd-video-card--selected {
          background: var(--gd-primary-50);
          border-color: var(--gd-primary-100);
        }
        .cd-video-card--selected:hover { background: var(--gd-primary-100); }
        .cd-video-grid--grid .cd-card-checkbox {
          position: absolute; top: 10px; left: 10px; z-index: 2;
        }
        .cd-video-grid--grid .cd-video-card { position: relative; }

        /* ── Bulk action bar (floating) ── */
        .cd-bulk-bar {
          position: absolute; left: 50%; bottom: 24px;
          transform: translateX(-50%);
          display: flex; align-items: center; gap: 12px;
          padding: 8px 12px 8px 8px; border-radius: 8px;
          background: #323639; color: #fff;
          box-shadow: var(--gd-shadow-2);
          z-index: 30;
          animation: cdFadeSlideIn .2s ease;
        }
        .cd-bulk-bar .cd-btn-icon { color: #e8eaed; }
        .cd-bulk-bar .cd-btn-icon:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .cd-bulk-count { font-size: 13px; font-weight: 500; }
        .cd-bulk-spacer { width: 1px; height: 20px; background: rgba(255,255,255,0.2); margin: 0 4px; }
        .cd-bulk-bar .cd-btn {
          background: transparent; color: #fff; border-color: rgba(255,255,255,0.3);
        }
        .cd-bulk-bar .cd-btn:hover { background: rgba(255,255,255,0.1); }
        .cd-bulk-bar .cd-bulk-danger { color: #f28b82; border-color: rgba(242,139,130,0.5); }
        .cd-bulk-bar .cd-bulk-danger:hover { background: rgba(242,139,130,0.12); }

        /* ── Detail drawer ── */
        .cd-drawer-scrim {
          position: absolute; inset: 0; z-index: 40;
          background: rgba(32, 33, 36, 0.4);
          animation: cdFadeIn .15s ease;
        }
        @keyframes cdFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .cd-drawer {
          position: absolute; top: 0; right: 0; bottom: 0; z-index: 41;
          width: 360px; max-width: 90vw;
          background: var(--gd-surface); color: var(--gd-text);
          border-left: 1px solid var(--gd-divider);
          box-shadow: var(--gd-shadow-2);
          display: flex; flex-direction: column; overflow-y: auto;
          animation: cdSlideInRight .2s ease;
        }
        @keyframes cdSlideInRight {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        .cd-drawer-header {
          display: flex; align-items: center; gap: 12px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--gd-divider);
          flex-shrink: 0;
        }
        .cd-drawer-icon {
          display: flex; align-items: center; justify-content: center;
          width: 44px; height: 44px; border-radius: 6px;
          background: var(--gd-surface-3); flex-shrink: 0;
        }
        .cd-drawer-title { flex: 1; min-width: 0; }
        .cd-drawer-name {
          font-size: 15px; font-weight: 500;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: var(--gd-text);
        }
        .cd-drawer-sub {
          font-size: 12px; color: var(--gd-text-secondary); margin-top: 2px;
        }
        .cd-drawer-actions {
          display: flex; gap: 8px;
          padding: 12px 20px;
          border-bottom: 1px solid var(--gd-divider);
        }
        .cd-drawer-section {
          padding: 16px 20px;
          border-bottom: 1px solid var(--gd-divider);
        }
        .cd-drawer-section:last-child { border-bottom: none; }
        .cd-drawer-section h3 {
          font-size: 12px; font-weight: 500;
          color: var(--gd-text-secondary);
          text-transform: uppercase; letter-spacing: 0.5px;
          margin: 0 0 12px;
        }
        .cd-drawer-meta {
          display: grid; grid-template-columns: 88px 1fr;
          gap: 6px 12px; margin: 0; font-size: 13px;
        }
        .cd-drawer-meta dt { color: var(--gd-text-secondary); }
        .cd-drawer-meta dd { color: var(--gd-text); margin: 0; word-break: break-word; }
        .cd-drawer-desc {
          margin: 0; font-size: 13px; color: var(--gd-text);
          line-height: 1.6; white-space: pre-wrap;
        }
        .cd-drawer-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .cd-drawer-tag {
          font-size: 12px; padding: 2px 10px; border-radius: 999px;
          background: var(--gd-primary-50); color: var(--gd-primary);
        }
        .cd-drawer-preview-text {
          margin: 0; font-size: 12.5px; line-height: 1.6;
          color: var(--gd-text); background: var(--gd-surface-2);
          padding: 12px; border-radius: 4px;
          max-height: 480px; overflow-y: auto;
          white-space: pre-wrap; word-break: break-word;
          font-family: "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .cd-drawer-preview-empty {
          margin: 0; font-size: 13px; color: var(--gd-text-muted);
        }
        .cd-drawer-preview-progress {
          font-weight: 400; font-size: 11px;
          color: var(--gd-text-muted);
          text-transform: none; letter-spacing: 0;
        }
        .cd-drawer-preview-more {
          margin-top: 8px; width: 100%;
          justify-content: center;
        }

        /* ── Dark mode (preserves Drive-like contrast) ── */
        html.dark .cd-panel {
          --gd-surface: #1f1f1f;
          --gd-surface-2: #181818;
          --gd-surface-3: #2a2a2a;
          --gd-border: #3c4043;
          --gd-divider: #303134;
          --gd-text: #e8eaed;
          --gd-text-secondary: #9aa0a6;
          --gd-text-muted: #80868b;
          --gd-primary: #8ab4f8;
          --gd-primary-hover: #aecbfa;
          --gd-primary-50: rgba(138, 180, 248, 0.12);
          --gd-primary-100: rgba(138, 180, 248, 0.20);
          --gd-on-primary: #202124;
          --gd-success: #81c995;
          --gd-success-50: rgba(129, 201, 149, 0.12);
          --gd-warning: #fdd663;
          --gd-warning-50: rgba(253, 214, 99, 0.12);
          --gd-danger: #f28b82;
          --gd-danger-50: rgba(242, 139, 130, 0.12);
          --gd-skip: #9aa0a6;
          --gd-skip-50: rgba(154, 160, 166, 0.12);
        }
        /* Dark-mode scrollbar — lighter thumb on darker track */
        html.dark .cd-panel *:hover::-webkit-scrollbar-thumb,
        html.dark .cd-panel *:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(232, 234, 237, 0.25);
        }
        html.dark .cd-panel *::-webkit-scrollbar-thumb:hover {
          background-color: rgba(232, 234, 237, 0.45);
        }
        html.dark .cd-panel *::-webkit-scrollbar-thumb:active {
          background-color: rgba(232, 234, 237, 0.65);
        }
        html.dark .cd-panel *:hover,
        html.dark .cd-panel *:focus-within {
          scrollbar-color: rgba(232, 234, 237, 0.35) transparent;
        }
    `}</style>
  );
}
