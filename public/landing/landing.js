/* ABF Field Shift landing page (Stage A): simple fade-in reveals, header that hides on scroll down,
 * phone copies of the how-it-works pictures, and a 400 ms fade before opening the app. */
(function () {
  'use strict';

  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  // Reveal on entering the viewport (CSS does the fade and rise)
  const targets = document.querySelectorAll('.reveal, [data-split]');
  if (reduced || !('IntersectionObserver' in window)) targets.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    targets.forEach((el) => io.observe(el));
  }

  // Phones: each step gets a copy of its picture
  document.querySelectorAll('.step').forEach((step) => {
    const v = document.querySelector(`.how-visual [data-visual="${step.dataset.step}"]`);
    const slot = step.querySelector('.step-visual-inline');
    if (v && slot) { const c = v.cloneNode(true); c.classList.add('on'); slot.appendChild(c); }
  });

  // Header: hide on scroll down, show on scroll up
  const head = document.getElementById('siteHead');
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    head.classList.toggle('scrolled', y > 20);
    head.classList.toggle('hidden', y > 300 && y > lastY && !head.contains(document.activeElement));
    lastY = y;
  }, { passive: true });

  // "Open the app": 400 ms fade, then go
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-open-app]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add('leaving');
    setTimeout(() => { window.location.href = a.href; }, reduced ? 0 : 400);
  });
  window.addEventListener('pageshow', () => document.body.classList.remove('leaving')); // back button
})();
