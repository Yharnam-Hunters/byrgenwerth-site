/* Byrgenwerth: page behaviour and motion. Settings come from window.WK (overrides/main.html).
   Every animation is skipped for readers who ask for reduced motion; the page is complete
   without this file (content is never hidden unless the html element carries .wk-js). */
(function () {
'use strict';

var WK = window.WK || {};
var root = document.documentElement;
var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Theme ───────────────────────────────────────────────────────────────────── */
var toggle = document.getElementById('wk-toggle');
function setTheme(t) {
  root.setAttribute('data-theme', t);
  try { localStorage.setItem('wk-theme', t); } catch (e) {}
  if (toggle) toggle.textContent = t === 'dark' ? '☀' : '☾';
}
setTheme(root.getAttribute('data-theme') || 'dark');
if (toggle) toggle.addEventListener('click', function () {
  var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  if (REDUCED) { setTheme(next); return; }
  if (document.startViewTransition) { document.startViewTransition(function () { setTheme(next); }); return; }
  root.classList.add('wk-theming');
  setTheme(next);
  setTimeout(function () { root.classList.remove('wk-theming'); }, 350);
});

/* ── Header: compact once the page scrolls ───────────────────────────────────── */
var header = document.getElementById('wk-header');
var topBtn = document.getElementById('wk-top');
var ticking = false;
function onScroll() {
  ticking = false;
  var y = window.scrollY;
  if (header) header.classList.toggle('is-compact', y > 80);
  if (topBtn) topBtn.classList.toggle('visible', y > 500);
}
window.addEventListener('scroll', function () {
  if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
}, {passive: true});
onScroll();
if (topBtn) topBtn.addEventListener('click', function () {
  window.scrollTo({top: 0, behavior: REDUCED ? 'auto' : 'smooth'});
});

/* ── Address map: a block opens its slice in a pop-up ────────────────────────── */
(function () {
  var map = document.querySelector('.wk-bankmap');
  if (!map) return;
  var modal = document.createElement('div');
  modal.className = 'wk-slice-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  document.body.appendChild(modal);
  var opener = null;
  function close() { modal.classList.remove('is-open'); if (opener) opener.focus(); }
  map.addEventListener('click', function (e) {
    var cell = e.target.closest('a.wk-bank-cell');
    if (!cell) return;
    var panel = document.getElementById(cell.getAttribute('href').slice(1));
    if (!panel) return;
    e.preventDefault();
    opener = cell;
    modal.innerHTML = '';
    modal.appendChild(panel.cloneNode(true));
    modal.firstChild.removeAttribute('id');
    requestAnimationFrame(function () {
      modal.classList.add('is-open');
      var x = modal.querySelector('.wk-slice-close');
      if (x) x.focus();
    });
  });
  modal.addEventListener('click', function (e) {
    if (e.target === modal || e.target.closest('.wk-slice-close')) { e.preventDefault(); close(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });
}());

/* ── Small screens: the navigation drawer ───────────────────────────────────── */
(function () {
  var navToggle = document.getElementById('wk-nav-toggle');
  var navEl = document.getElementById('wk-nav');
  var backdrop = document.getElementById('wk-nav-backdrop');
  var drawerQuery = WK.drawerQuery || window.matchMedia('(max-width: 900px)');
  if (!navToggle || !navEl || !backdrop) return;
  var outside = [document.querySelector('.wk-main'), document.querySelector('.wk-header-right'),
                 document.querySelector('.wk-wordmark')];
  function setInert(on) { outside.forEach(function (el) { if (el) el.inert = on; }); }
  function closeNav() {
    navEl.classList.remove('is-open');
    backdrop.hidden = true;
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Open navigation');
    navToggle.textContent = '☰';
    setInert(false);
    if (drawerQuery.matches) navEl.inert = true;
  }
  function openNav() {
    navEl.inert = false;
    setInert(true);
    navEl.classList.add('is-open');
    backdrop.hidden = false;
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Close navigation');
    navToggle.textContent = '×';
  }
  navEl.inert = drawerQuery.matches;
  navToggle.addEventListener('click', function () {
    if (navEl.classList.contains('is-open')) closeNav(); else openNav();
  });
  backdrop.addEventListener('click', function () { closeNav(); navToggle.focus(); });
  navEl.addEventListener('click', function (e) { if (e.target.closest('a')) closeNav(); });
  document.addEventListener('keydown', function (e) {
    if (!navEl.classList.contains('is-open') || !drawerQuery.matches) return;
    if (e.key === 'Escape') { closeNav(); navToggle.focus(); return; }
    if (e.key !== 'Tab') return;
    var focusable = [navToggle].concat(Array.prototype.slice.call(navEl.querySelectorAll('a[href], button:not([disabled])')));
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  window.addEventListener('resize', function () {
    if (!drawerQuery.matches) { navEl.inert = false; closeNav(); }
    else if (!navEl.classList.contains('is-open')) navEl.inert = true;
  });
}());

/* ── Search: the core search index, filtered in the page ────────────────────── */
(function () {
  var input = document.getElementById('wk-q');
  var results = document.getElementById('wk-results');
  var docs = null;
  if (!input || !results || !WK.searchIndex) return;
  function load() {
    if (docs) return;
    docs = [];
    fetch(WK.searchIndex).then(function (r) { return r.json(); }).then(function (d) { docs = d.docs; run(); });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function run() {
    var q = input.value.trim().toLowerCase();
    if (!docs || q.length < 2) { results.hidden = true; return; }
    var hits = docs.filter(function (d) { return (d.title + ' ' + d.text).toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
    if (!hits.length) { results.hidden = true; return; }
    results.innerHTML = hits.map(function (d) {
      var text = d.text || '';
      var i = text.toLowerCase().indexOf(q);
      var start = Math.max(0, i - 35), end = Math.min(text.length, i + q.length + 70);
      var snip = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      return '<a class="wk-result" href="' + esc(WK.base + '/' + d.location) + '" role="option">' +
             '<div class="wk-result-title">' + esc(d.title || d.location) + '</div>' +
             '<div class="wk-result-snip">' + esc(snip) + '</div></a>';
    }).join('');
    results.hidden = false;
  }
  input.addEventListener('focus', load, {once: true});
  input.addEventListener('input', function () { load(); run(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
    if (e.key === 'Enter' && !results.hidden) { var first = results.querySelector('.wk-result'); if (first) first.click(); }
  });
  document.addEventListener('click', function (e) {
    if (!results.contains(e.target) && e.target !== input) results.hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); input.focus(); input.select(); }
  });
}());

/* ── Code blocks: copy button, and long blocks start collapsed ──────────────── */
document.querySelectorAll('.highlight').forEach(function (block) {
  var btn = document.createElement('button');
  btn.className = 'wk-copy-btn';
  btn.type = 'button';
  btn.title = 'Copy code';
  btn.setAttribute('aria-label', 'Copy code');
  btn.textContent = '⎘';
  block.appendChild(btn);
  btn.addEventListener('click', function () {
    var pre = block.querySelector('pre');
    if (!pre || !navigator.clipboard) return;
    navigator.clipboard.writeText(pre.innerText).then(function () {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '⎘'; btn.classList.remove('copied'); }, 1500);
    });
  });
});
var COLLAPSE_THRESHOLD = 340;
document.querySelectorAll('.wk-article-body .highlight').forEach(function (block) {
  var pre = block.querySelector('pre');
  if (!pre || pre.scrollHeight <= COLLAPSE_THRESHOLD + 40) return;
  block.classList.add('wk-code-collapsed');
  var more = document.createElement('button');
  more.className = 'wk-code-toggle';
  more.type = 'button';
  more.textContent = 'Show more ▾';
  more.addEventListener('click', function () {
    var collapsed = block.classList.toggle('wk-code-collapsed');
    more.textContent = collapsed ? 'Show more ▾' : 'Show less ▴';
    if (collapsed) block.scrollIntoView({block: 'nearest'});
  });
  block.insertAdjacentElement('afterend', more);
});

/* ── On this page: highlight the section being read ──────────────────────────── */
(function () {
  var links = document.querySelectorAll('.wk-toc-link');
  if (!links.length || !('IntersectionObserver' in window)) return;
  var active = null;
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var link = document.querySelector('.wk-toc-link[href="#' + e.target.id + '"]');
      if (link && link !== active) {
        if (active) active.classList.remove('is-current');
        link.classList.add('is-current');
        active = link;
      }
    });
  }, {rootMargin: '-12% 0px -78% 0px'});
  document.querySelectorAll('.wk-article-body h2[id]').forEach(function (h) { spy.observe(h); });
}());

/* ── Motion: reveal on scroll, counters, progress ring and sparkline ─────────── */
var REVEAL = ['.wk-card', '.wk-ql-box', '.wk-stat-tile', '.wk-stat-ring', '.wk-glance', '.wk-milestone',
              '.wk-timeline-item', '.wk-technical-diagram', '.wk-diagram', '.wk-sparkline', '.wk-bankmap',
              '.wk-steps > li', '.wk-progress-card', '.wk-hero', '.wk-post-nav a'].join(',');

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/* Count up the leading whole number of a generated value. The last frame writes the generated
   text back exactly, so no number shown is ever computed here. Decimals and words are left as is. */
function countUp(el) {
  if (REDUCED || el.dataset.counted) return;
  el.dataset.counted = '1';
  var node = null;
  for (var i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 3 && /\d/.test(el.childNodes[i].nodeValue)) { node = el.childNodes[i]; break; }
  }
  if (!node) return;
  var original = node.nodeValue;
  var m = original.match(/\d[\d,]*/);
  if (!m || /[.\d]%|\d\.\d/.test(original.slice(m.index, m.index + m[0].length + 2))) return;
  var target = parseInt(m[0].replace(/,/g, ''), 10);
  if (!isFinite(target) || target < 2) return;
  var start = performance.now(), dur = 900;
  function frame(now) {
    var t = Math.min(1, (now - start) / dur);
    if (t < 1) {
      var v = Math.round(target * easeOut(t)).toLocaleString('en-US');
      node.nodeValue = original.slice(0, m.index) + v + original.slice(m.index + m[0].length);
      requestAnimationFrame(frame);
    } else {
      node.nodeValue = original;
    }
  }
  requestAnimationFrame(frame);
}

function prepareRing(ring) {
  var arc = ring.querySelector('.wk-stat-ring-arc');
  if (!arc || REDUCED) return;
  arc.dataset.offset = arc.style.strokeDashoffset || arc.getAttribute('stroke-dashoffset') || '0';
  arc.style.strokeDashoffset = arc.getAttribute('stroke-dasharray').split(/[ ,]+/)[0];
}

function arrive(el) {
  el.classList.add('is-in');
  el.querySelectorAll('.wk-stat-tile-val, .wk-progress-value, .wk-stat-ring-val').forEach(countUp);
  if (el.matches('.wk-stat-tile-val, .wk-progress-value')) countUp(el);
  var arc = el.querySelector('.wk-stat-ring-arc');
  if (arc && arc.dataset.offset !== undefined) arc.style.strokeDashoffset = arc.dataset.offset;
}

(function () {
  var items = Array.prototype.slice.call(document.querySelectorAll(REVEAL));
  document.querySelectorAll('.wk-sparkline .wk-spark-line').forEach(function (line) {
    try { line.closest('svg').style.setProperty('--len', Math.ceil(line.getTotalLength())); } catch (e) {}
  });
  document.querySelectorAll('.wk-stat-ring').forEach(prepareRing);
  if (REDUCED || !('IntersectionObserver' in window)) { items.forEach(arrive); return; }
  items.forEach(function (el) {
    var siblings = Array.prototype.filter.call(el.parentElement.children, function (s) { return s.matches(REVEAL); });
    el.style.setProperty('--i', siblings.indexOf(el));
    el.setAttribute('data-reveal', '');
  });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      arrive(e.target);
      io.unobserve(e.target);
    });
  }, {threshold: 0.12, rootMargin: '0px 0px -6% 0px'});
  items.forEach(function (el) { io.observe(el); });
}());

}());
