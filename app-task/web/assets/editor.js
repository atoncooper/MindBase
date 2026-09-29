'use strict';
/* ============================================================
   Code editor bootstrap — CodeMirror 5 (vendored under
   assets/vendor/codemirror, MIT). Replaces the previous hand-rolled
   overlay editor: real Lua/JSON modes, bracket matching + auto-close,
   active-line highlight, comment toggle (Ctrl-/), native undo for
   every operation, and a Ln/Col status bar.

   Editable host:   <div class="code-editor cm-host" data-code-editor="lua|json"
                         [data-ctrl-s="1"] [data-required="1"] [style=height]>
                       <textarea name="...">value</textarea>
                     </div>
   Read-only view:  <div class="cm-view" data-code-view="lua|json|plain">text</div>

   Editable instances register into window.AppTaskEditors keyed by the
   textarea name, so page scripts can read/write live values before the
   automatic form-submit sync runs. If the vendored assets fail to load
   the plain textareas keep working (graceful degradation).
   ============================================================ */

(function () {
  if (typeof CodeMirror === 'undefined') return; // vendor assets missing

  var MODES = {
    lua: 'text/x-lua',
    json: { name: 'javascript', json: true },
    plain: 'text/plain',
  };
  var registry = {};

  window.AppTaskEditors = {
    get: function (name) { return registry[name] || null; },
  };

  function modeOf(lang) {
    return MODES[lang] || MODES.plain;
  }

  // Small right-bottom status bar: cursor position, line count, language.
  function makeStatus(host, cm, lang) {
    var bar = document.createElement('div');
    bar.className = 'cm-status';
    var pos = document.createElement('span');
    var meta = document.createElement('span');
    meta.textContent = lang.toUpperCase();
    bar.appendChild(pos);
    bar.appendChild(meta);
    host.appendChild(bar);
    function update() {
      var cur = cm.getCursor();
      pos.textContent = 'Ln ' + (cur.line + 1) + ', Col ' + (cur.ch + 1) +
        ' · ' + cm.lineCount() + ' 行';
    }
    cm.on('cursorActivity', update);
    cm.on('change', update);
    update();
  }

  // ── editable editors ────────────────────────────────────────────
  document.querySelectorAll('[data-code-editor]').forEach(function (host) {
    var ta = host.querySelector('textarea');
    if (!ta) return;
    var lang = host.dataset.codeEditor || 'lua';

    var extraKeys = {};
    if (lang === 'lua') {
      extraKeys['Ctrl-/'] = function (cm) { cm.toggleComment({ indent: true, lineComment: '--' }); };
      extraKeys['Cmd-/'] = function (cm) { cm.toggleComment({ indent: true, lineComment: '--' }); };
    }

    var cm = CodeMirror.fromTextArea(ta, {
      mode: modeOf(lang),
      theme: 'mindbase',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      indentUnit: 2,
      tabSize: 2,
      placeholder: ta.getAttribute('placeholder') || '',
      extraKeys: extraKeys,
    });

    // Ctrl/Cmd+S submits the enclosing form (script save page).
    // requestSubmit fires the submit event so CodeMirror's save hook, the
    // required check and the loading bar all run; form.submit() would skip
    // them and send a stale textarea value.
    if (host.dataset.ctrlS !== undefined && ta.form) {
      cm.addKeyMap({
        'Ctrl-S': function () {
          if (ta.form.requestSubmit) { ta.form.requestSubmit(); }
          else { cm.save(); ta.form.submit(); }
        },
        'Cmd-S': function () {
          if (ta.form.requestSubmit) { ta.form.requestSubmit(); }
          else { cm.save(); ta.form.submit(); }
        },
      });
    }

    // Client-side required check (the backing textarea is hidden, so the
    // HTML5 constraint would never fire). Registered before app.js's
    // submit handler, so a cancelled submit never shows the loading bar.
    if (host.dataset.required !== undefined && ta.form) {
      ta.form.addEventListener('submit', function (ev) {
        if (!cm.getValue().trim()) {
          ev.preventDefault();
          alert('源码不能为空');
          cm.focus();
        }
      });
    }

    if (ta.name) registry[ta.name] = cm;
    makeStatus(host, cm, lang);
  });

  // ── read-only views ─────────────────────────────────────────────
  document.querySelectorAll('[data-code-view]').forEach(function (el) {
    var lang = el.dataset.codeView || 'lua';
    var value = el.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    var cm = CodeMirror(function (node) {
      el.parentNode.replaceChild(node, el);
      node.classList.add('cm-view-host');
    }, {
      value: value,
      mode: modeOf(lang),
      theme: 'mindbase',
      readOnly: 'nocursor',
      lineNumbers: lang === 'lua',
      lineWrapping: lang !== 'lua',
      viewportMargin: Infinity,
    });
    cm.setSize('100%', 'auto');
  });
})();
