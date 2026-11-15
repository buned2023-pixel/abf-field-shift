/*
 * In-app confirm / prompt dialogs. Native window.confirm() and prompt() are
 * blocked in some embedded browsers and webviews (they return false/null
 * instantly), which silently cancelled every delete. These always work.
 */
(function () {
  'use strict';

  function open({ title, message, okText = window.FSi18n.t('dlg.ok'), cancelText = window.FSi18n.t('dlg.cancel'), danger = false, input = null }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 id="modalTitle"></h3>
          <p class="modal-msg"></p>
          ${input !== null ? '<input class="modal-input" maxlength="60" />' : ''}
          <div class="modal-actions">
            <button type="button" class="btn-sm" data-act="cancel"></button>
            <button type="button" class="btn-sm ${danger ? 'btn-danger' : 'btn-ok'}" data-act="ok"></button>
          </div>
        </div>`;
      back.querySelector('h3').textContent = title;
      const msg = back.querySelector('.modal-msg');
      if (message) msg.textContent = message; else msg.remove();
      back.querySelector('[data-act="cancel"]').textContent = cancelText;
      back.querySelector('[data-act="ok"]').textContent = okText;
      const field = back.querySelector('.modal-input');
      if (field) field.value = input;
      const prevFocus = document.activeElement;

      const close = (result) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(result);
      };
      const ok = () => close(field ? (field.value.trim() || null) : true);
      const cancel = () => close(field ? null : false);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act;
          (focused === 'cancel' ? cancel : ok)();
        }
        else e.stopPropagation(); // keep Delete/Backspace etc. away from the map while open
      };
      back.addEventListener('click', (e) => {
        if (e.target === back) cancel();
        const act = e.target.closest && e.target.closest('[data-act]');
        if (act) (act.dataset.act === 'ok' ? ok : cancel)();
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      (field || back.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]')).focus();
      if (field) field.select();
    });
  }

  window.FSDialog = {
    confirm: (opts) => open(opts),
    prompt: (opts) => open({ ...opts, input: opts.value || '' }),
  };
})();
