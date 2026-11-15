/*
 * Screen layout: panels collapse/expand with one click and remember their state.
 *   Desktop (900 px and wider): layers left, field overview right, climate charts at the bottom.
 *   Under 900 px: the same panels become bottom sheets; only one is open at a time.
 * Body classes drive the CSS (ui.css): tl-shown / tl-open (charts panel), sheet-open (phone sheet).
 */
(function () {
  'use strict';

  const KEY = 'fieldshift.ui.v1';
  const PANELS = ['layersPanel', 'overviewPanel', 'timeline'];
  const DEFAULT_OPEN = { layersPanel: false, overviewPanel: true, timeline: false };
  const small = () => window.matchMedia('(max-width: 899px)').matches;

  let saved = {};
  try { saved = JSON.parse(window.FSStore.getSetting(KEY)) || {}; } catch (_) { saved = {}; } // account or this browser
  const isOpen = (id) => (id in saved ? !!saved[id] : DEFAULT_OPEN[id]);
  const el = (id) => document.getElementById(id);
  const visible = (id) => el(id) && !el(id).hidden;

  function store() { window.FSStore.setSetting(KEY, JSON.stringify(saved)); }

  function apply(id, open) {
    const p = el(id);
    if (!p) return;
    p.classList.toggle('collapsed', !open);
    const head = p.querySelector('[data-toggle]');
    if (head) head.setAttribute('aria-expanded', String(open));
  }

  function updateBody() {
    const b = document.body;
    const tl = el('timeline');
    b.classList.toggle('tl-shown', visible('timeline'));
    b.classList.toggle('tl-open', visible('timeline') && !tl.classList.contains('collapsed'));
    b.classList.toggle('sheet-open', small() && PANELS.some((id) => visible(id) && !el(id).classList.contains('collapsed')));
  }

  function setOpen(id, open, remember = true) {
    if (open && small()) PANELS.forEach((other) => { if (other !== id) apply(other, false); }); // one sheet at a time
    apply(id, open);
    if (remember) { saved[id] = open; if (open && small()) PANELS.forEach((o) => { if (o !== id) saved[o] = false; }); store(); }
    updateBody();
    if (open && id === 'timeline') window.dispatchEvent(new Event('resize')); // charts measure their new size
  }

  function init() {
    PANELS.forEach((id) => apply(id, isOpen(id)));
    if (small()) { // on a phone start with at most one open sheet: the field overview wins
      const open = PANELS.filter((id) => isOpen(id));
      if (open.length > 1) PANELS.forEach((id) => apply(id, id === (open.includes('overviewPanel') ? 'overviewPanel' : open[0])));
    }
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-toggle]');
      if (!t || e.target.closest('.help')) return;
      const id = t.dataset.toggle;
      if (!PANELS.includes(id)) return;
      setOpen(id, el(id).classList.contains('collapsed'));
    });
    // The charts panel appears/disappears with field selection (climate.js): keep the layout in step
    const tl = el('timeline');
    if (tl) new MutationObserver(updateBody).observe(tl, { attributes: true, attributeFilter: ['hidden', 'class'] });
    window.matchMedia('(max-width: 899px)').addEventListener('change', () => {
      if (small()) { const open = PANELS.filter((id) => !el(id).classList.contains('collapsed')); open.slice(1).forEach((id) => apply(id, false)); }
      updateBody();
    });
    updateBody();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.FSLayout = { setOpen, updateBody };
})();
