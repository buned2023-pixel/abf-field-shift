/*
 * ABF Field Shift landing page.
 *  - Intro: animated ABF logo + 0–100 % counter, at most 2.5 s, once per browser session, skippable.
 *  - With GSAP + ScrollTrigger + Lenis (CDN): smooth scroll, masked heading lines, fade-and-rise
 *    sections, gentle hero parallax (max 6 %), pinned "How it works" with a progress line, count-ups.
 *  - Without them (CDN failed) or with reduced motion: simple CSS fade-ins, no pinning, no parallax.
 *  - Header hides on scroll down; "Open the app" fades the page out in 400 ms.
 * One easing everywhere: cubic-bezier(0.22, 1, 0.36, 1). Only transform and opacity are animated.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  root.classList.add('js');

  // cubic-bezier(0.22, 1, 0.36, 1) as a function (GSAP's eases are named; this keeps one curve everywhere)
  const EASE = (function bezier(x1, y1, x2, y2) {
    const B = (a, b, t) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (B(x1, x2, m) < x) lo = m; else hi = m; }
      return B(y1, y2, (lo + hi) / 2);
    };
  })(0.22, 1, 0.36, 1);

  // ── Intro ──
  function intro() {
    let seen = false;
    try { seen = !!sessionStorage.getItem('abf.landing.intro'); sessionStorage.setItem('abf.landing.intro', '1'); } catch (_) { /* storage blocked */ }
    if (seen || reduced) return;
    const el = document.createElement('div');
    el.className = 'intro';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="abf-logo intro-logo">
        <svg class="abf-mark" viewBox="0 0 200 200">
          <defs><clipPath id="introClip"><circle cx="100" cy="100" r="62"/></clipPath></defs>
          <circle class="m-planet" cx="100" cy="100" r="62" fill="#2F4BFF"/>
          <g clip-path="url(#introClip)" fill="none" stroke="#D4F20C" stroke-width="6" stroke-linecap="round">
            <path class="m-row r1" pathLength="1" d="M30 112 Q100 84 170 112"/>
            <path class="m-row r2" pathLength="1" d="M30 132 Q100 104 170 132"/>
            <path class="m-row r3" pathLength="1" d="M30 152 Q100 124 170 152"/>
          </g>
          <g class="m-orbit">
            <ellipse class="m-ring" pathLength="1" cx="100" cy="100" rx="92" ry="30" transform="rotate(-24 100 100)" fill="none" stroke="#F2F5FB" stroke-width="4"/>
            <circle class="m-sat" cx="170.7" cy="54.4" r="9" fill="#D4F20C"/>
          </g>
        </svg>
        <div class="abf-words"><div class="abf-big"><span>A</span><span>B</span><span>F</span></div><div class="abf-small">Field Shift</div></div>
      </div>
      <p class="intro-count"><span>0</span>%</p>`;
    document.body.appendChild(el);
    const num = el.querySelector('.intro-count span');
    const TOTAL = 2100, t0 = performance.now();
    let done = false;
    const close = () => {
      if (done) return; done = true;
      el.classList.add('out'); // 400 ms fade: gone by 2.5 s
      setTimeout(() => el.remove(), 450);
    };
    (function tick(now) {
      if (done) return;
      const p = Math.min(1, (now - t0) / TOTAL);
      num.textContent = String(Math.round(EASE(p) * 100));
      if (p < 1) requestAnimationFrame(tick); else close();
    })(t0);
    setTimeout(close, 2100);                             // hard cap, even if frames are slow
    el.addEventListener('click', close);
    document.addEventListener('keydown', close, { once: true });
  }

  // ── Header: hide on scroll down, show on scroll up ──
  function header() {
    const head = document.getElementById('siteHead');
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      head.classList.toggle('scrolled', y > 20);
      head.classList.toggle('hidden', y > 300 && y > lastY + 2 && !head.contains(document.activeElement));
      if (y < lastY - 2) head.classList.remove('hidden');
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    head.addEventListener('focusin', () => head.classList.remove('hidden'));
  }

  // ── "Open the app": 400 ms fade, then go ──
  function pageTransition() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[data-open-app]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      document.body.classList.add('leaving');
      setTimeout(() => { window.location.href = a.href; }, reduced ? 0 : 400);
    });
    window.addEventListener('pageshow', () => document.body.classList.remove('leaving')); // back button / bfcache
  }

  // ── Phones: each step gets a copy of its picture ──
  function inlineVisuals() {
    document.querySelectorAll('.step').forEach((step) => {
      const v = document.querySelector(`.how-visual [data-visual="${step.dataset.step}"]`);
      const slot = step.querySelector('.step-visual-inline');
      if (v && slot && !slot.firstChild) { const c = v.cloneNode(true); c.classList.add('on'); slot.appendChild(c); }
    });
  }

  // ── How it works: which step is active ──
  const visuals = () => document.querySelectorAll('.how-visual .visual');
  const steps = () => document.querySelectorAll('.how-steps .step');
  let activeStep = -1;
  function setStep(i, progress) {
    const bar = document.getElementById('howBar');
    if (bar) bar.style.transform = `scaleY(${progress != null ? Math.max(0.04, progress) : (i + 1) / 4})`;
    if (i === activeStep) return;
    activeStep = i;
    visuals().forEach((v, k) => v.classList.toggle('on', k === i));
    steps().forEach((s, k) => s.classList.toggle('active', k === i));
  }

  // ── Count-ups ──
  function countUp(el, ms) {
    const to = +el.dataset.count;
    if (!to || reduced) { el.textContent = String(to); return; }
    const t0 = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = String(Math.round(EASE(p) * to));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }

  // ── Simple path (no GSAP, or reduced motion): CSS fade-ins via IntersectionObserver ──
  function simple() {
    const targets = document.querySelectorAll('.reveal, [data-split]');
    const counts = document.querySelectorAll('[data-count]');
    if (reduced || !('IntersectionObserver' in window)) {
      targets.forEach((el) => el.classList.add('in'));
      counts.forEach((el) => { el.textContent = el.dataset.count; });
    } else {
      const io = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        if (e.target.matches('.stat')) { const c = e.target.querySelector('[data-count]'); if (c) countUp(c, 1200); }
        io.unobserve(e.target);
      }), { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
      targets.forEach((el) => io.observe(el));
      counts.forEach((el) => { el.textContent = '0'; });
      // A fast jump (anchor link, scrollbar drag) can skip past elements: reveal anything already above the fold
      let queued = false;
      const sweep = () => {
        queued = false;
        targets.forEach((el) => {
          if (el.classList.contains('in') || el.getBoundingClientRect().top > window.innerHeight) return;
          el.classList.add('in');
          if (el.matches('.stat')) { const c = el.querySelector('[data-count]'); if (c) countUp(c, 1200); }
          io.unobserve(el);
        });
      };
      window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(sweep); } }, { passive: true });
    }
    // Steps: the one in the middle of the screen is active
    if ('IntersectionObserver' in window) {
      const so = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (e.isIntersecting) setStep(+e.target.dataset.step);
      }), { rootMargin: '-45% 0px -45% 0px' });
      steps().forEach((s) => so.observe(s));
    }
    setStep(0);
  }

  // ── Full path: GSAP + ScrollTrigger + Lenis ──
  function full() {
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    root.classList.add('gsap');

    // Smooth scroll (Lenis) driven by GSAP's ticker
    if (window.Lenis) {
      const lenis = new window.Lenis({ duration: 1.1, easing: EASE, smoothWheel: true });
      lenis.on('scroll', ST.update);
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
      document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href^="#"]');
        if (!a) return;
        const id = a.getAttribute('href');
        const target = id === '#top' ? 0 : document.querySelector(id);
        if (target === null) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: id === '#top' ? 0 : -80, duration: 1.2 });
        if (id === '#main' || id === '#top') { const m = document.querySelector(id === '#top' ? '#top' : '#main'); if (m) { m.setAttribute('tabindex', '-1'); m.focus({ preventScroll: true }); } }
      });
    }

    const D = 1;
    // Headings: each line slides up out of its mask, 60 ms apart
    document.querySelectorAll('[data-split]').forEach((h) => {
      const lines = h.querySelectorAll('.line > span');
      gsap.set(lines, { yPercent: 105, y: 0 }); // y: 0 drops the CSS starting offset GSAP would otherwise keep
      gsap.to(lines, { yPercent: 0, y: 0, duration: D, ease: EASE, stagger: 0.06,
        scrollTrigger: { trigger: h, start: 'top 88%', once: true } });
    });
    // Everything else: fade and rise 24 px
    document.querySelectorAll('.reveal').forEach((el) => {
      if (el.closest('.step-visual-inline')) return;
      gsap.fromTo(el, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D, ease: EASE,
        scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
    });
    // Problems: one by one
    // (each .problem is a .reveal with its own trigger, so they appear in order while scrolling)

    // Hero picture: gentle parallax, at most 6 %
    const par = document.querySelector('[data-parallax]');
    if (par) gsap.to(par, { yPercent: -6, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

    // Count-ups once when visible
    document.querySelectorAll('[data-count]').forEach((el) => {
      el.textContent = '0';
      ST.create({ trigger: el, start: 'top 90%', once: true, onEnter: () => countUp(el, 1200) });
    });

    // How it works: pinned on wide screens; the picture changes per step and the line fills
    const mm = gsap.matchMedia();
    mm.add('(min-width: 900px)', () => {
      const st = ST.create({
        trigger: '#howPin', start: 'center center', end: () => '+=' + Math.round(window.innerHeight * 2.4),
        pin: true, scrub: true, anticipatePin: 1,
        onUpdate: (self) => setStep(Math.min(3, Math.floor(self.progress * 4)), self.progress),
      });
      setStep(0, 0);
      return () => st.kill();
    });
    mm.add('(max-width: 899px)', () => {
      const so = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) setStep(+e.target.dataset.step); }), { rootMargin: '-45% 0px -45% 0px' });
      steps().forEach((s) => so.observe(s));
      return () => so.disconnect();
    });

    // Images that load late change heights: let ScrollTrigger re-measure
    window.addEventListener('load', () => ST.refresh());
  }

  intro();
  header();
  pageTransition();
  inlineVisuals();
  const canAnimate = !reduced && window.gsap && window.ScrollTrigger;
  try { if (canAnimate) full(); else simple(); }
  catch (err) {
    console.warn('[landing] animation setup failed, showing content without it', err);
    root.classList.remove('gsap');
    document.querySelectorAll('.reveal, [data-split]').forEach((el) => { el.classList.add('in'); el.style.opacity = ''; el.style.transform = ''; });
    document.querySelectorAll('[data-split] .line > span').forEach((s) => { s.style.transform = ''; });
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = el.dataset.count; });
  }
})();
