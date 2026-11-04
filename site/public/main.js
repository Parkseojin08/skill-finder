// Landing page motion, in the spirit of animejs.com: staggered letters, a dot grid that ripples, the app window
// typing a search and showing its results, scroll-triggered reveals and an SVG line drawn as you scroll. Nothing
// here is needed to read the page: without this script (or with reduced motion) everything is simply shown. The
// download buttons and meta.json are page.js's.
import { animate, createDrawable, onScroll, splitText, stagger, utils } from '/vendor/anime-4.4.1.esm.min.js';

window.__animReady = true;
const motion = document.documentElement.classList.contains('anim');

if (motion) {
  /* ── hero: title letters rise in one after another ── */
  const title = splitText('.hero h1', { chars: true });
  utils.set('.hero h1', { opacity: 1 });
  animate(title.chars, {
    opacity: [0, 1],
    y: ['0.6em', '0em'],
    filter: ['blur(8px)', 'blur(0px)'],
    duration: 900,
    delay: stagger(26, { start: 150 }),
    ease: 'outExpo',
  });
  animate('.reveal-hero', { opacity: [0, 1], y: [24, 0], duration: 900, delay: stagger(120, { start: 650 }), ease: 'outExpo' });

  /* ── hero: dot grid, rippling out from the centre and from wherever you click ── */
  const grid = document.querySelector('.dots');
  const cols = Math.min(36, Math.floor(innerWidth / 34) + 8);
  const rows = 16;
  grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
  grid.append(...Array.from({ length: cols * rows }, () => document.createElement('i')));
  const dots = grid.querySelectorAll('i');
  utils.set(grid, { opacity: 1 });
  const ripple = (from) =>
    animate(dots, {
      scale: [{ to: 2.2, duration: 260 }, { to: 1, duration: 700 }],
      backgroundColor: [{ to: '#c23a49', duration: 260 }, { to: '#2c2c33', duration: 900 }],
      delay: stagger(42, { grid: [cols, rows], from }),
      ease: 'outQuad',
    });
  animate(dots, { opacity: [0, 1], scale: [0, 1], delay: stagger(30, { grid: [cols, rows], from: 'center' }), duration: 600, ease: 'outBack' });
  setTimeout(() => ripple('center'), 900);
  grid.addEventListener('click', (e) => {
    const i = [...dots].indexOf(e.target);
    if (i >= 0) ripple(i);
  });
  // a gentle ripple every few seconds while the hero is on screen
  let heroVisible = true;
  new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting)).observe(document.querySelector('.hero'));
  setInterval(() => heroVisible && ripple(utils.random(0, dots.length - 1)), 5200);

  /* ── hero: the app window rises, types the search, and the results and the install panel come in ── */
  animate('.app', { opacity: [0, 1], y: [40, 0], scale: [0.97, 1], duration: 1200, delay: 250, ease: 'outExpo' });
  const query = document.querySelector('.mk-q');
  const typed = query.textContent;
  query.textContent = '';
  const sheet = document.querySelector('.mk-sheet');
  const sheetHeight = sheet.scrollHeight;
  utils.set(sheet, { maxHeight: 0, paddingTop: 0, paddingBottom: 0 });
  let i = 0;
  setTimeout(function type() {
    query.textContent = typed.slice(0, ++i);
    if (i < typed.length) return void setTimeout(type, 38 + Math.random() * 40);
    animate('.mk-go', { scale: [1, 0.9, 1], duration: 300, ease: 'outQuad' });
    animate('.mk-meta', { opacity: [0, 1], duration: 400, delay: 250 });
    animate('.mk-res', { opacity: [0, 1], y: [16, 0], duration: 700, delay: stagger(160, { start: 350 }), ease: 'outExpo' });
    // the best result's install panel opens under it, as the app's does
    animate(sheet, { opacity: [0, 1], maxHeight: [0, sheetHeight], paddingTop: [0, 12], paddingBottom: [0, 12], duration: 800, delay: 1300, ease: 'outExpo' });
    animate('.mk-checks li', { opacity: [0, 1], x: [-6, 0], duration: 400, delay: stagger(180, { start: 1900 }) });
  }, 1100);

  /* ── download buttons: a soft pulse ring ── */
  animate('.ring', { scale: [1, 1.25], opacity: [0.7, 0], duration: 1800, loop: true, ease: 'outQuad', delay: 2000 });

  /* ── scroll: things appear once they come into view and always finish, however fast you scroll ── */
  // (anime.js's onScroll pauses a playing animation when its target leaves the screen, which left
  // late-staggered cards half transparent on a quick scroll; a plain IntersectionObserver only starts them)
  const whenSeen = (target, run) => {
    const io = new IntersectionObserver(
      (entries) => {
        // also run for things already scrolled past (a jump via a nav link skips over them)
        if (!entries.some((e) => e.isIntersecting || e.boundingClientRect.bottom < 0)) return;
        io.disconnect();
        run();
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(target);
  };

  for (const el of document.querySelectorAll('h2.reveal, .show-text.reveal, .warn.reveal, .final.reveal')) {
    whenSeen(el, () => animate(el, { opacity: [0, 1], y: [36, 0], duration: 900, ease: 'outExpo' }));
  }
  for (const group of document.querySelectorAll('.reveal-group')) {
    whenSeen(group, () =>
      animate(group.querySelectorAll('.reveal'), {
        opacity: [0, 1],
        y: [40, 0],
        scale: [0.96, 1],
        duration: 900,
        delay: stagger(110),
        ease: 'outExpo',
      }),
    );
  }

  /* ── features: each icon draws itself ── */
  const icons = createDrawable('.card .icon path, .card .icon circle');
  utils.set(icons, { draw: '0 0' });
  whenSeen(document.querySelector('.features .grid'), () =>
    animate(icons, { draw: ['0 0', '0 1'], duration: 1400, delay: stagger(90, { start: 200 }), ease: 'inOutQuad' }),
  );

  /* ── how it works: the line follows the scroll, the steps pop in along it ── */
  const pipe = document.querySelector('.pipe');
  const line = createDrawable('.pipe-line');
  animate(line, { draw: ['0 0', '0 1'], ease: 'linear', autoplay: onScroll({ target: pipe, enter: 'bottom top', leave: 'center center', sync: 0.4 }) });
  whenSeen(pipe, () => animate('.node', { opacity: [0, 1], y: [30, 0], duration: 800, delay: stagger(180), ease: 'outBack' }));

  /* ── screens: windows rise and straighten once as they come into view, then stay crisp ── */
  for (const el of document.querySelectorAll('.frame.rise')) {
    whenSeen(el, () => animate(el, { opacity: [0, 1], y: [90, 0], rotateX: [16, 0], scale: [0.92, 1], duration: 1300, ease: 'outExpo' }));
  }
}
