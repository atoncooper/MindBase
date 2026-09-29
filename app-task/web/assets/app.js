'use strict';
/* ============================================================
   Global console behaviors (loaded on every page, deferred).
   Form-submit loading feedback: on POST submissions, activate a top progress
   bar and turn submit buttons into spinners — the visuals stay in place
   while the PRG navigation runs. Inline confirm() cancellations
   (defaultPrevented) are respected, and pageshow/bfcache returns reset the
   state. GET filter forms are instant and skipped.
   ============================================================ */

(function () {
  function bar() {
    var el = document.querySelector('.page-progress');
    if (!el) {
      el = document.createElement('div');
      el.className = 'page-progress';
      document.body.appendChild(el);
    }
    return el;
  }

  function activate() {
    bar().classList.add('active');
    document.querySelectorAll('form button[type="submit"], form button:not([type])').forEach(function (b) {
      if (b.classList.contains('loading')) return;
      b.disabled = true;
      b.classList.add('loading');
      b.dataset.origDisabled = b.disabled ? '1' : '';
    });
  }

  function reset() {
    var el = document.querySelector('.page-progress');
    if (el) el.classList.remove('active');
    document.querySelectorAll('form button.loading').forEach(function (b) {
      b.classList.remove('loading');
      b.disabled = b.dataset.origDisabled === '1';
    });
  }

  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return; // inline confirm() cancelled the action
    var method = (e.target.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'post') return;  // GET filter forms are instant
    activate();
    // Failsafe: never leave the page stuck in the loading state.
    setTimeout(reset, 60000);
  });

  // Back/forward navigation may restore the page mid-loading — reset it.
  window.addEventListener('pageshow', reset);
})();

/* ── Bootstrap 3 modals without jQuery ──────────────────────────────── */
/* The markup is stock .modal/.modal-dialog (bootstrap.min.css provides the
   look); this shim only toggles .in + display and manages the backdrop, so
   the binary stays free of jQuery + bootstrap.js. */
(function () {
  var backdrop = null;

  function open(modal) {
    modal.classList.add('in');
    modal.style.display = 'block';
    modal.removeAttribute('aria-hidden');
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
    document.body.classList.add('modal-open');
    var first = modal.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first) first.focus();
  }

  function close(modal) {
    modal.classList.remove('in');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (backdrop) { backdrop.remove(); backdrop = null; }
    document.body.classList.remove('modal-open');
  }

  function closeTop() {
    var modal = document.querySelector('.modal.in');
    if (modal) close(modal);
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-modal-open]');
    if (opener) {
      var m = document.getElementById(opener.dataset.modalOpen);
      if (m) open(m);
      return;
    }
    if (e.target.closest('[data-modal-close]')) {
      var own = e.target.closest('.modal');
      if (own) close(own);
      return;
    }
    if (backdrop && e.target === backdrop) {
      closeTop(); // backdrop click
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeTop();
  });

  // Secret-update dialog: prefill from the row's data attributes. The update
  // targets the row by secret_id; the name is display-only (it is the
  // script-facing handle and may not change).
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-modal-open="secret-update-modal"]');
    if (!opener) return;
    var id = document.getElementById('secret-update-id');
    var title = document.getElementById('secret-update-title');
    var desc = document.getElementById('secret-update-desc');
    var value = document.querySelector('#secret-update-modal [name=value]');
    if (id) id.value = opener.dataset.secretId || '';
    if (title) title.value = opener.dataset.name || '';
    if (desc) desc.value = opener.dataset.desc || '';
    if (value) value.value = '';
  });
})();

/* ── Bootstrap 3 dropdowns without jQuery ───────────────────────────── */
(function () {
  function closeAll(except) {
    document.querySelectorAll('.dropdown.open').forEach(function (d) {
      if (d !== except) d.classList.remove('open');
    });
  }

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-toggle="dropdown"]');
    if (toggle) {
      var dd = toggle.closest('.dropdown');
      var willOpen = !dd.classList.contains('open');
      closeAll();
      if (willOpen) dd.classList.add('open');
      e.stopPropagation();
      return;
    }
    // Clicks outside any dropdown (including on menu items) close all menus.
    closeAll();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });
})();
