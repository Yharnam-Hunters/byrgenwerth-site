/* Byrgenwerth: interactive enemy breakdowns. Our own code, no libraries.

   One silent clip drives everything. A clip player (figure.en-clip) owns a frame clock: the
   frame index of its video at data-fps (30), frame = floor(time × fps), and a seek to frame f lands
   on time (f + 0.5) / fps, the middle of that frame. Every diagram subscribes to one clip and
   redraws for its frame:

     .en-timeline  attack timeline: the playhead follows the clip; scrubbing seeks the clip;
                   tapping a phase loops it
     .en-states    AI state machine: the state the clip is in lights up, with the transition taken
     .en-ranges    perception and range map: the player's position and the active shapes for the
                   frame
     .en-choice    attack choice: the chosen branch lights up from its decision frame

   A diagram finds its clip by data-clip="<figure id>", else the clip of the .en-sync section it
   sits in; without one it gets its own clock (a clip with no video). Per-frame data (state
   intervals, positions, decisions) is in clip frames. A clip may hold two videos of the same
   moment, the plain run and the renderer's debug-overlay run (video[data-view]): they are kept on
   the same frame and shown alone or side by side.

   Each diagram's data is a JSON block inside it (usually a snippet include of
   docs/data/enemies/<slug>/*.json) or a file named by data-src. tools/check_enemy_data.py
   documents and checks every field; data marked "synthetic" carries a banner wherever it is drawn.
   Keys: ← / → or , / . step one frame, Space or K plays and pauses, L loops the current phase.
   Without JavaScript the page keeps its prose and each video keeps the browser's own controls. */
(function () {
'use strict';

var SVGNS = 'http://www.w3.org/2000/svg';
var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var EVIDENCE = { verified: 1, observed: 1, inferred: 1, hypothesis: 1, unknown: 1, synthetic: 1 };
var SPEEDS = [1, 0.5, 0.25];
var uid = 0;
var clips = {};

/* ── Small helpers ───────────────────────────────────────────────────────────── */
function el(tag, attrs, parent, text) {
  var n = document.createElement(tag);
  setAttrs(n, attrs);
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
function svgEl(tag, attrs, parent, text) {
  var n = document.createElementNS(SVGNS, tag);
  setAttrs(n, attrs);
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
function setAttrs(n, attrs) {
  for (var k in attrs || {}) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
}
function button(parent, label, text, cls) {
  return el('button', { type: 'button', 'class': 'en-btn' + (cls ? ' ' + cls : ''), 'aria-label': label }, parent, text);
}
function badge(evidence) {
  var word = EVIDENCE[evidence] ? evidence : 'unknown';
  return el('span', { 'class': 'wk-badge wk-badge--' + word }, null, word);
}
function evidenceOf(item, data) { return item.evidence || (data.synthetic ? 'synthetic' : 'unknown'); }
function seconds(frames, fps) { return (frames / fps).toFixed(3) + ' s'; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function svgPoint(svg, evt) {
  var pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function loadData(host, done) {
  var inline = host.querySelector('script[type="application/json"]');
  if (inline) {
    try { done(JSON.parse(inline.textContent)); } catch (e) { fail(host, 'data is not valid JSON: ' + e.message); }
    return;
  }
  var src = host.getAttribute('data-src');
  if (!src) { fail(host, 'no data'); return; }
  fetch(src).then(function (r) {
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    return r.json();
  }).then(done, function (e) { fail(host, 'could not load ' + src + ': ' + e.message); });
}
function fail(host, why) {
  host.innerHTML = '';
  el('p', { 'class': 'en-error' }, host, 'This diagram could not be drawn (' + why + ').');
}

/* The common frame: title, subtitle and, for synthetic data, a banner that cannot be missed. */
function frame(host, data, kind) {
  host.innerHTML = '';
  host.classList.add('en-widget');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', data.title || kind);
  var head = el('div', { 'class': 'en-head' }, host);
  el('span', { 'class': 'en-title' }, head, kind);
  if (data.title) el('span', { 'class': 'en-sub' }, head, data.title);
  if (data.synthetic) {
    el('p', { 'class': 'en-synthetic-banner' }, host,
       'Synthetic example data for testing this component. It does not describe any enemy in the game.');
  }
  return host;
}

/* A collapsible table of the same data, for screen readers and for reading exact numbers. */
function dataTable(host, caption, headers, rows) {
  var d = el('details', { 'class': 'en-table' }, host);
  el('summary', null, d, caption);
  var t = el('table', null, d);
  var tr = el('tr', null, el('thead', null, t));
  headers.forEach(function (h) { el('th', null, tr, h); });
  var tb = el('tbody', null, t);
  rows.forEach(function (r) {
    var row = el('tr', null, tb);
    r.forEach(function (c) {
      var td = el('td', null, row);
      if (c instanceof Node) td.appendChild(c); else td.textContent = c;
    });
  });
  return d;
}

/* The interval of a per-frame track that holds frame f ({start, end} with end exclusive). */
function intervalAt(list, f) {
  for (var i = 0; i < (list || []).length; i++) if (f >= list[i].start && f < list[i].end) return list[i];
  return null;
}

/* ── The clip controller ─────────────────────────────────────────────────────── */
/* One frame clock, shared. With videos, the first one ("plain" when there are two) is the clock
   and the others follow it; without a video (a diagram on its own) a timer is the clock. */
function Clip(id, opts) {
  this.id = id;
  this.fps = opts.fps || 30;
  this.videos = opts.videos || [];
  this.total = opts.frames || 0;        // frame count; from the video's length once known
  this.frame = 0;
  this.playing = false;
  this.rate = 1;
  this.loop = null;                     // {start, end, label}: frames [start, end) repeat
  this.suggested = null;                // a phase a diagram offers to loop (the L key, Loop button)
  this.listeners = [];
  this.ui = [];
  this.userPaused = false;
  var self = this;
  this.videos.forEach(function (v) {
    v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
    v.loop = false; v.playsInline = true; v.removeAttribute('controls');
    v.addEventListener('volumechange', function () { if (!v.muted) v.muted = true; });
  });
  var master = this.master = this.videos[0] || null;
  if (master) {
    master.addEventListener('loadedmetadata', function () {
      if (master.duration && isFinite(master.duration)) self.total = Math.round(master.duration * self.fps);
      self.emit();
    });
    /* The clip repeats: from the loop's start, else from frame 0. */
    master.addEventListener('ended', function () {
      if (!self.playing) return;
      self.seek(self.loop ? self.loop.start : 0, true);
      self.videos.forEach(function (v) { v.play().catch(function () {}); });
    });
    master.addEventListener('seeked', function () { self.tick(); });
    if (master.readyState >= 1 && master.duration) this.total = Math.round(master.duration * this.fps);
  }
}
Clip.prototype.subscribe = function (fn) { this.listeners.push(fn); fn(this.frame, this); };
Clip.prototype.emit = function () {
  var self = this;
  this.listeners.forEach(function (fn) { fn(self.frame, self); });
  this.ui.forEach(function (fn) { fn(); });
};
Clip.prototype.last = function () { return Math.max(0, (this.total || 1) - 1); };
/* Read the clock: the master video's current frame, kept inside a loop, the others kept on it. */
Clip.prototype.tick = function () {
  var m = this.master;
  if (!m) return;
  var f = Math.floor(m.currentTime * this.fps + 1e-6);
  if (this.loop && this.playing && (f >= this.loop.end || f < this.loop.start)) { this.seek(this.loop.start, true); return; }
  for (var i = 1; i < this.videos.length; i++) {
    var v = this.videos[i];
    if (Math.abs(v.currentTime - m.currentTime) > 0.5 / this.fps) v.currentTime = m.currentTime;
    if (v.playbackRate !== m.playbackRate) v.playbackRate = m.playbackRate;
  }
  if (f !== this.frame) { this.frame = clamp(f, 0, this.last()); this.emit(); }
};
Clip.prototype.seek = function (f, keepPlaying) {
  var self = this;
  f = clamp(Math.round(f), 0, this.last());
  if (!keepPlaying) this.pause();
  this.frame = f;
  if (this.master) {
    var t = (f + 0.5) / this.fps;
    this.videos.forEach(function (v) {
      if (v.readyState >= 1) v.currentTime = t;
      else {
        v.preload = 'auto';
        v.addEventListener('loadedmetadata', function () { v.currentTime = (self.frame + 0.5) / self.fps; }, { once: true });
      }
    });
  }
  this.emit();
};
Clip.prototype.step = function (d) { this.userPaused = true; this.seek(this.frame + d); };
Clip.prototype.play = function () {
  var self = this;
  if (this.playing) return;
  if (this.loop && (this.frame < this.loop.start || this.frame >= this.loop.end)) this.seek(this.loop.start, true);
  this.playing = true;
  this.userPaused = false;
  if (this.master) {
    this.videos.forEach(function (v) { v.playbackRate = self.rate; v.play().catch(function () {}); });
    var poll = function () {
      if (!self.playing) return;
      self.tick();
      if (self.master.requestVideoFrameCallback) self.master.requestVideoFrameCallback(poll);
      else requestAnimationFrame(poll);
    };
    poll();
  } else {
    var last = 0, acc = 0;
    var run = function (t) {
      if (!self.playing) return;
      if (last) acc += (t - last) / 1000 * self.fps * self.rate;
      last = t;
      if (acc >= 1) {
        var n = Math.floor(acc);
        acc -= n;
        var f = self.frame + n;
        var lo = self.loop ? self.loop.start : 0, hi = self.loop ? self.loop.end : self.last() + 1;
        if (f >= hi) f = lo + (f - hi) % Math.max(1, hi - lo);
        self.frame = f;
        self.emit();
      }
      requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }
  this.emit();
};
Clip.prototype.pause = function () {
  if (!this.playing) return;
  this.playing = false;
  this.videos.forEach(function (v) { v.pause(); });
  this.emit();
};
Clip.prototype.toggle = function () { if (this.playing) { this.userPaused = true; this.pause(); } else this.play(); };
Clip.prototype.setRate = function (r) {
  this.rate = r;
  this.videos.forEach(function (v) { v.playbackRate = r; });
  this.emit();
};
Clip.prototype.setLoop = function (range) {
  this.loop = range;
  if (range) { this.seek(range.start, true); this.play(); } else this.emit();
};
Clip.prototype.toggleLoop = function () {
  if (this.loop) this.setLoop(null);
  else if (this.suggested) this.setLoop(this.suggested);
};

/* Keys for one clip, on any element of its section: frame steps, play/pause, loop. */
function clipKeys(target, clip) {
  target.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'SELECT' || tag === 'INPUT' || e.altKey || e.ctrlKey || e.metaKey) return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === ',') clip.step(-1);
    else if (k === 'ArrowRight' || k === '.') clip.step(1);
    else if ((k === ' ' && tag !== 'BUTTON') || k === 'k' || k === 'K') clip.toggle();
    else if (k === 'l' || k === 'L') clip.toggleLoop();
    else return;
    e.preventDefault();
  });
}

/* The control bar every clock shows: big touch targets, wraps on a phone. In a phone's sticky
   player it keeps to one row (stylesheets/enemy.css): one speed button that cycles instead of the
   three, a bare loop icon and a short frame readout. */
function speedText(s) { return s === 1 ? '1×' : s === 0.5 ? '½×' : '¼×'; }
function controlBar(parent, clip) {
  var bar = el('div', { 'class': 'en-controls en-transport' }, parent);
  var bFirst = button(bar, 'First frame', '⏮', 'en-btn-first');
  var bBack = button(bar, 'Previous frame', '◀︎ 1');
  var bPlay = button(bar, 'Play', '▶︎', 'en-btn-play');
  var bNext = button(bar, 'Next frame', '1 ▶︎');
  var speeds = el('div', { 'class': 'en-seg en-speeds', role: 'group', 'aria-label': 'Playback speed' }, bar);
  var speedBtns = SPEEDS.map(function (s) {
    var b = button(speeds, 'Speed ' + s + ' times', speedText(s));
    b.addEventListener('click', function () { clip.setRate(s); });
    return { s: s, b: b };
  });
  var bSpeed = button(bar, 'Playback speed', '1×', 'en-speed-cycle');
  bSpeed.addEventListener('click', function () {
    clip.setRate(SPEEDS[(SPEEDS.indexOf(clip.rate) + 1) % SPEEDS.length]);
  });
  var bLoop = button(bar, 'Loop the current phase', '⟲', 'en-btn-loop');
  var loopLabel = el('span', { 'class': 'en-loop-label' }, bLoop);
  var readout = el('span', { 'class': 'en-readout', 'aria-live': 'off' }, bar);
  var roLong = el('span', { 'class': 'en-ro-long' }, readout);
  var roShort = el('span', { 'class': 'en-ro-short', 'aria-hidden': 'true' }, readout);
  bFirst.addEventListener('click', function () { clip.userPaused = true; clip.seek(clip.loop ? clip.loop.start : 0); });
  bBack.addEventListener('click', function () { clip.step(-1); });
  bNext.addEventListener('click', function () { clip.step(1); });
  bPlay.addEventListener('click', function () { clip.toggle(); });
  bLoop.addEventListener('click', function () { clip.toggleLoop(); });
  clip.ui.push(function () {
    bPlay.textContent = clip.playing ? '❚❚' : '▶︎';
    bPlay.setAttribute('aria-label', clip.playing ? 'Pause' : 'Play');
    bPlay.setAttribute('aria-pressed', clip.playing ? 'true' : 'false');
    speedBtns.forEach(function (o) { o.b.setAttribute('aria-pressed', o.s === clip.rate ? 'true' : 'false'); });
    bLoop.setAttribute('aria-pressed', clip.loop ? 'true' : 'false');
    bLoop.disabled = !clip.loop && !clip.suggested;
    bSpeed.textContent = speedText(clip.rate);
    bSpeed.setAttribute('aria-label', 'Playback speed ' + clip.rate + ' times, tap for the next');
    bLoop.setAttribute('aria-label', clip.loop ? 'Stop looping ' + clip.loop.label :
                       'Loop the current phase' + (clip.suggested ? ' (' + clip.suggested.label + ')' : ''));
    loopLabel.textContent = clip.loop ? ' ' + clip.loop.label : ' Loop' + (clip.suggested ? ' ' + clip.suggested.label : '');
    roLong.textContent = 'frame ' + clip.frame + ' / ' + clip.last() + ' · ' + seconds(clip.frame, clip.fps) +
                         (clip.rate !== 1 ? ' · ' + clip.rate + '×' : '');
    roShort.textContent = clip.frame + '/' + clip.last();
  });
  return bar;
}

/* figure.en-clip: one video, or two of the same moment (data-view="plain" and "overlay"). */
function initClip(fig) {
  var videos = Array.prototype.slice.call(fig.querySelectorAll('video'));
  if (!videos.length) return;
  videos.sort(function (a, b) { return (a.getAttribute('data-view') === 'overlay') - (b.getAttribute('data-view') === 'overlay'); });
  if (!fig.id) fig.id = 'en-clip-' + (++uid);
  var clip = new Clip(fig.id, { fps: +fig.getAttribute('data-fps') || 30, videos: videos,
                                frames: +fig.getAttribute('data-frames') || 0 });
  clips[fig.id] = clip;
  fig.classList.add('en-clip-ready');
  fig.setAttribute('tabindex', '0');
  var views = fig.querySelector('.en-clip-views');
  if (!views) {
    views = el('div', { 'class': 'en-clip-views' }, null);
    fig.insertBefore(views, videos[0]);
    videos.forEach(function (v) { views.appendChild(v); });
  }
  videos.forEach(function (v) {
    v.addEventListener('click', function () { clip.toggle(); });
    var view = v.getAttribute('data-view');
    if (view) v.setAttribute('aria-label', view === 'overlay' ? 'Debug overlay view' : 'Plain view');
  });
  var bar = controlBar(null, clip);
  fig.insertBefore(bar, views.nextSibling);
  if (videos.length > 1) {
    var seg = el('div', { 'class': 'en-seg en-views', role: 'group', 'aria-label': 'View' }, bar);
    var modes = [['plain', 'Plain'], ['overlay', 'Overlay'], ['both', 'Both']];
    var setView = function (mode) {
      views.setAttribute('data-show', mode);
      modes.forEach(function (m) { m.b.setAttribute('aria-pressed', m[0] === mode ? 'true' : 'false'); });
    };
    modes.forEach(function (m) { m.b = button(seg, m[1] + ' view', m[1]); m.b.addEventListener('click', function () { setView(m[0]); }); });
    /* A phone's one-row player swaps plain and overlay with one button instead of the three. */
    var bOverlay = button(bar, 'Show the debug overlay', 'Overlay', 'en-view-toggle');
    bOverlay.addEventListener('click', function () {
      setView(views.getAttribute('data-show') === 'overlay' ? 'plain' : 'overlay');
    });
    var setViewBase = setView;
    setView = function (mode) {
      setViewBase(mode);
      bOverlay.setAttribute('aria-pressed', mode === 'overlay' ? 'true' : 'false');
    };
    setView(window.innerWidth >= 700 ? 'both' : 'plain');
  }
  var src = videos[0].currentSrc || videos[0].getAttribute('src');
  if (src) el('a', { 'class': 'en-clip-full', href: src }, bar, 'Full size');
  /* In a synced section the videos and controls stay in view while the diagrams scroll past;
     the caption (with its credit) stays in place under them. */
  if (fig.parentElement && fig.parentElement.classList.contains('en-sync')) {
    var stick = el('div', { 'class': 'en-clip-stick' }, null);
    fig.parentElement.insertBefore(stick, fig);
    stick.appendChild(views);
    stick.appendChild(bar);
    /* Collapsing hides the videos and keeps the one control row, for reading the diagrams. */
    var bFold = button(bar, 'Hide the video', '▴', 'en-clip-fold');
    bFold.setAttribute('aria-expanded', 'true');
    bFold.addEventListener('click', function () {
      var folded = stick.classList.toggle('is-folded');
      bFold.textContent = folded ? '▾' : '▴';
      bFold.setAttribute('aria-expanded', folded ? 'false' : 'true');
      bFold.setAttribute('aria-label', folded ? 'Show the video' : 'Hide the video');
    });
    clipKeys(stick, clip);
  }
  clipKeys(fig, clip);
  /* Plays while on screen, never for readers who ask for reduced motion, never after a pause. */
  if (!REDUCED && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && e.intersectionRatio >= 0.5 && !clip.userPaused) clip.play();
        else if (!e.isIntersecting && clip.playing) { clip.pause(); }
      });
    }, { threshold: [0, 0.5] }).observe(fig);
  }
  clip.emit();
}

/* The clock a diagram follows: its data-clip, its section's clip, else its own (no video). */
function clipFor(host, data, frames, fps) {
  var id = host.getAttribute('data-clip') || (data.clip && data.clip.player);
  if (!id) {
    var sync = host.closest('.en-sync');
    var fig = sync && sync.querySelector('figure.en-clip');
    if (fig) id = fig.id;
  }
  if (id && clips[id]) return { clip: clips[id], own: false };
  var own = new Clip('en-own-' + (++uid), { fps: fps || 30, frames: frames || 1 });
  return { clip: own, own: true };
}

/* ── Attack timeline ─────────────────────────────────────────────────────────── */
/* Phases: windup, active, recovery (the attack's own row), tracking (turns to follow the target),
   punish (an opening for the player), each [start, end) in attack frames; tracking-cut is one
   frame. An attack's clip.start_frame is the clip frame its frame 0 sits on. */
var TL_ROWS = [
  { label: 'Attack', kinds: ['windup', 'active', 'recovery'] },
  { label: 'Tracking', kinds: ['tracking', 'tracking-cut'] },
  { label: 'Opening', kinds: ['punish'] }
];
var TL_NAMES = { windup: 'wind-up', active: 'active (can hit)', recovery: 'recovery', tracking: 'tracking',
                 'tracking-cut': 'tracking stops', punish: 'punish window' };

function initTimeline(host, data) {
  frame(host, data, 'Attack timeline');
  var fps = data.fps || 30;
  var attacks = data.attacks || [];
  if (!attacks.length) { fail(host, 'no attacks'); return; }
  var longest = Math.max.apply(null, attacks.map(function (a) { return (a.clip && a.clip.start_frame || 0) + a.frames; }));
  var link = clipFor(host, data, longest, fps);
  var clip = link.clip;
  /* Drawn at the column's own width (360 to 720 units), so its text stays legible on a phone. */
  var W = clamp(host.clientWidth - 32, 360, 720), LEFT = 64, RIGHT = 12, ROW = 30, TOP = 8, AXIS = 24;
  var state = { attack: null, index: 0, f: 0 };

  var top = el('div', { 'class': 'en-controls' }, host);
  var select = null;
  if (attacks.length > 1) {
    select = el('select', { 'class': 'en-select', 'aria-label': 'Attack' }, top);
    attacks.forEach(function (a, i) { el('option', { value: i }, select, a.name || a.id); });
  }
  var meta = el('span', { 'class': 'en-readout' }, top);
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + (TOP + TL_ROWS.length * ROW + AXIS), role: 'img' }, host);
  var range = el('input', { type: 'range', 'class': 'en-range', min: 0, step: 1, 'aria-label': 'Attack frame' }, host);
  if (link.own) controlBar(host, clip);
  var now = el('div', { 'class': 'en-tl-now', 'aria-live': 'polite' }, host);
  var legend = el('div', { 'class': 'en-legend' }, host);
  var tableHost = el('div', null, host);
  if (!link.own) el('p', { 'class': 'en-sub en-hint' }, host, 'Follows the clip above: scrub here to move the clip, tap a phase to loop it.');
  if (data.note) el('p', { 'class': 'en-sub' }, host, data.note);

  var head, knob, bars = [];
  function x(f) { return LEFT + (W - LEFT - RIGHT) * f / state.attack.frames; }
  /* The clip frame the attack's frame 0 sits on; null for an attack that is not in the clip. */
  function start() {
    if (link.own) return 0;
    return state.attack.clip ? state.attack.clip.start_frame || 0 : null;
  }

  function draw() {
    var a = state.attack;
    svg.innerHTML = '';
    bars = [];
    svgEl('title', null, svg, (a.name || a.id) + ': ' + a.frames + ' frames at ' + fps + ' frames per second');
    var bottom = TOP + TL_ROWS.length * ROW;
    var step = a.frames > 120 || W < 520 ? 10 : 5;
    for (var f = 0; f <= a.frames; f += step) {
      var major = f % fps === 0 || f % (step * 2) === 0;
      svgEl('line', { 'class': 'en-tl-grid' + (major ? ' is-major' : ''), x1: x(f), x2: x(f), y1: TOP, y2: bottom }, svg);
      if (major) svgEl('text', { 'class': 'en-tl-tick', x: x(f), y: bottom + 14, 'text-anchor': 'middle' }, svg,
                       f % fps === 0 ? f + ' · ' + (f / fps) + ' s' : String(f));
    }
    TL_ROWS.forEach(function (row, r) {
      var y = TOP + r * ROW;
      svgEl('text', { 'class': 'en-tl-row-label', x: 0, y: y + ROW / 2 + 4 }, svg, row.label);
      (a.phases || []).forEach(function (p) {
        if (row.kinds.indexOf(p.kind) < 0) return;
        var g = svgEl('g', { 'class': 'en-k-' + p.kind }, svg);
        if (p.kind === 'tracking-cut') {
          svgEl('line', { 'class': 'en-tl-cut', x1: x(p.frame), x2: x(p.frame), y1: y + 3, y2: y + ROW - 3 }, g);
          bars.push({ p: p, node: null });
          return;
        }
        var rect = svgEl('rect', { 'class': 'en-tl-bar', x: x(p.start), y: y + 5, width: Math.max(1, x(p.end) - x(p.start)),
                                   height: ROW - 10, rx: 3, tabindex: 0, role: 'button',
                                   'aria-label': 'Loop ' + TL_NAMES[p.kind] + ', frames ' + p.start + ' to ' + (p.end - 1) }, g);
        svgEl('title', null, rect, TL_NAMES[p.kind] + ': frames ' + p.start + '–' + (p.end - 1) + ' (tap to loop)');
        var loop = function (e) {
          e.stopPropagation();
          if (start() === null) return;
          clip.setLoop({ start: start() + p.start, end: start() + p.end, label: TL_NAMES[p.kind] });
        };
        rect.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        rect.addEventListener('click', loop);
        rect.addEventListener('keydown', function (e) { if (e.key === 'Enter') loop(e); });
        bars.push({ p: p, node: rect });
      });
    });
    (a.events || []).forEach(function (e) {
      svgEl('path', { 'class': 'en-tl-event', d: 'M' + x(e.frame) + ' ' + (TOP - 1) + 'l-4 -6h8z' }, svg);
    });
    head = svgEl('line', { 'class': 'en-tl-head', y1: TOP - 4, y2: bottom + 2 }, svg);
    knob = svgEl('circle', { 'class': 'en-tl-knob', r: 7, cy: bottom + 2 }, svg);

    legend.innerHTML = '';
    var kinds = {};
    (a.phases || []).forEach(function (p) { kinds[p.kind] = 1; });
    Object.keys(TL_NAMES).forEach(function (k) {
      if (!kinds[k]) return;
      var s = el('span', { 'class': 'en-k-' + k }, legend);
      el('span', { 'class': 'en-swatch' }, s);
      s.appendChild(document.createTextNode(TL_NAMES[k]));
    });
    tableHost.innerHTML = '';
    dataTable(tableHost, 'Phases as a table', ['Phase', 'Frames', 'Clip frames', 'Length', 'Evidence', 'Note'],
      (a.phases || []).map(function (p) {
        var single = p.kind === 'tracking-cut';
        var s0 = start();
        return [TL_NAMES[p.kind], single ? String(p.frame) : p.start + '–' + (p.end - 1),
                s0 === null ? '—' : single ? String(s0 + p.frame) : (s0 + p.start) + '–' + (s0 + p.end - 1),
                single ? '—' : (p.end - p.start) + ' f · ' + seconds(p.end - p.start, fps),
                badge(evidenceOf(p, data)), p.note || ''];
      }));
    meta.textContent = a.frames + ' frames · ' + seconds(a.frames, fps) + ' at ' + fps + ' fps' +
                       (link.own ? '' : start() === null ? ' · not in this clip' : ' · clip frames ' + start() + '–' + (start() + a.frames - 1));
    range.max = a.frames - 1;
  }

  /* Draw attack frame f; inside is false when the clip is not in this attack. */
  function show(f, inside, clipFrame) {
    var a = state.attack;
    host.classList.toggle('is-outside', !inside);
    state.f = clamp(f, 0, a.frames - 1);
    var hx = x(state.f + 0.5);
    head.setAttribute('x1', hx); head.setAttribute('x2', hx); knob.setAttribute('cx', hx);
    range.value = state.f;
    var here = [];
    bars.forEach(function (b) {
      var on = inside && (b.p.kind === 'tracking-cut' ? b.p.frame === f : f >= b.p.start && f < b.p.end);
      if (b.node) b.node.classList.toggle('is-current', on);
      if (on) here.push(b.p);
    });
    now.innerHTML = '';
    var line = el('div', { 'class': 'en-readout' }, now,
                  inside ? 'attack frame ' + f + ' / ' + (a.frames - 1) + ' · ' + seconds(f, fps)
                         : 'clip frame ' + clipFrame + ': outside this attack');
    if (start() === null) line.textContent = 'attack frame ' + state.f + ' (this attack is not in the clip)';
    line.setAttribute('aria-hidden', 'true');
    here.forEach(function (p) {
      var row = el('div', null, now);
      el('strong', null, row, TL_NAMES[p.kind]);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(badge(evidenceOf(p, data)));
      if (p.note) row.appendChild(document.createTextNode(' ' + p.note));
    });
    (a.events || []).forEach(function (e) { if (inside && e.frame === f) el('div', null, now, '▾ ' + e.label); });
    /* Offer the phase under the playhead to the clip's Loop button. */
    var body = here.filter(function (p) { return p.kind === 'windup' || p.kind === 'active' || p.kind === 'recovery'; })[0];
    clip.suggested = body && start() !== null ? { start: start() + body.start, end: start() + body.end, label: TL_NAMES[body.kind] } : null;
  }
  function choose(i) {
    state.index = i;
    state.attack = attacks[i];
    if (select) select.value = i;
    draw();
  }
  /* The clip moved: switch to the attack it is in, then move the playhead. */
  clip.subscribe(function (f) {
    if (!state.attack) choose(0);
    var hit = -1;
    if (!link.own) attacks.forEach(function (a, i) {
      if (hit < 0 && a.clip && f >= (a.clip.start_frame || 0) && f < (a.clip.start_frame || 0) + a.frames) hit = i;
    });
    if (hit >= 0 && hit !== state.index) choose(hit);
    if (start() !== null) show(f - start(), f - start() >= 0 && f - start() < state.attack.frames, f);
  });

  var dragging = false;
  /* Scrubbing seeks the clip; an attack that is not in the clip is scrubbed on its own. */
  function goTo(f) {
    f = clamp(f, 0, state.attack.frames - 1);
    if (start() === null) { show(f, true, f); return; }
    clip.userPaused = true;
    clip.seek(start() + f);
  }
  function scrub(e) {
    var p = svgPoint(svg, e);
    goTo(Math.floor((p.x - LEFT) / (W - LEFT - RIGHT) * state.attack.frames));
  }
  svg.addEventListener('pointerdown', function (e) { dragging = true; svg.setPointerCapture(e.pointerId); scrub(e); });
  svg.addEventListener('pointermove', function (e) { if (dragging) scrub(e); });
  svg.addEventListener('pointerup', function () { dragging = false; });
  svg.addEventListener('pointercancel', function () { dragging = false; });
  range.addEventListener('input', function () { goTo(+range.value); });
  if (select) select.addEventListener('change', function () { choose(+select.value); goTo(0); });
  clipKeys(host, clip);
}

/* ── State machine ───────────────────────────────────────────────────────────── */
/* States sit on a grid (col, row) chosen by the page author, so the drawing reads in the order the
   text explains it. track: [{start, end, state}] in clip frames lights up the state the clip is in
   and the transition that led there. */
function initStates(host, data) {
  frame(host, data, 'AI state machine');
  var states = data.states || [], edges = data.transitions || [], track = data.track || [];
  var byId = {};
  states.forEach(function (s) { byId[s.id] = s; });
  var NW = 132, NH = 40, CW = 190, RH = 104, PAD = 24, LOOP = 90;
  var cols = 1, rows = 1;
  states.forEach(function (s) { cols = Math.max(cols, (s.col || 0) + 1); rows = Math.max(rows, (s.row || 0) + 1); });
  var hasLoop = edges.some(function (t) { return t.from === t.to; });
  var W = PAD * 2 + (cols - 1) * CW + NW + (hasLoop ? LOOP : 0), H = PAD * 2 + (rows - 1) * RH + NH + 20;
  function cx(s) { return PAD + 18 + (s.col || 0) * CW + NW / 2; }
  function cy(s) { return PAD + 20 + (s.row || 0) * RH + NH / 2; }
  W += 18;
  var last = track.reduce(function (m, t) { return Math.max(m, t.end); }, 1);
  var link = clipFor(host, data, last, data.fps);
  var clip = link.clip;

  var id = 'en-sm-' + (++uid);
  var nowLine = el('div', { 'class': 'en-sm-now', 'aria-live': 'polite' }, host);
  /* Never drawn narrower than 560 px: on a phone the diagram scrolls sideways inside its frame. */
  var scroller = el('div', { 'class': 'en-scroll' }, host);
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'en-sm', role: 'group',
                           'aria-label': 'State diagram: select a state or a transition' }, scroller);
  svg.style.minWidth = Math.min(W, 560) + 'px';
  var defs = svgEl('defs', null, svg);
  ['', '-out', '-taken'].forEach(function (suffix) {
    var m = svgEl('marker', { id: id + '-arrow' + suffix, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7,
                              markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M0 0L10 5L0 10z', 'class': 'en-sm-arrow' + suffix }, m);
  });
  if (link.own && track.length) controlBar(host, clip);
  var detail = el('div', { 'class': 'en-detail', 'aria-live': 'polite' }, host,
                  'Select a state or a transition to see what it does and what supports it.');

  function border(s, tx, ty) {
    var x0 = cx(s), y0 = cy(s), dx = tx - x0, dy = ty - y0;
    var k = 1 / Math.max(Math.abs(dx) / (NW / 2 + 4), Math.abs(dy) / (NH / 2 + 4), 1e-6);
    return [x0 + dx * k, y0 + dy * k];
  }
  var edgeNodes = [], nodeEls = {};
  var layer = svgEl('g', null, svg);
  edges.forEach(function (t, i) {
    var a = byId[t.from], b = byId[t.to];
    if (!a || !b) return;
    var g = svgEl('g', { 'class': 'en-sm-edge', tabindex: 0, role: 'button',
                         'aria-label': (a.label || a.id) + ' to ' + (b.label || b.id) + (t.label ? ': ' + t.label : '') }, layer);
    var d, lx, ly, nx = 0, ny = 0, back = false;
    if (a === b) {
      /* A transition back into the same state: a loop on the state's right-hand side. */
      var x0 = cx(a) + NW / 2, y0 = cy(a);
      d = 'M' + x0 + ' ' + (y0 - 10) + 'C' + (x0 + 44) + ' ' + (y0 - 34) + ' ' + (x0 + 44) + ' ' + (y0 + 34) + ' ' + x0 + ' ' + (y0 + 10);
      lx = x0 + 36; ly = y0; nx = 1;
    } else {
      /* Two transitions between the same pair bend apart instead of overlapping. */
      back = edges.some(function (o) { return o.from === t.to && o.to === t.from; });
      var mx = (cx(a) + cx(b)) / 2, my = (cy(a) + cy(b)) / 2;
      var dx = cx(b) - cx(a), dy = cy(b) - cy(a), len = Math.sqrt(dx * dx + dy * dy) || 1;
      var bend = back ? 22 : 0;
      var qx = mx - dy / len * bend, qy = my + dx / len * bend;
      var p0 = border(a, qx, qy), p1 = border(b, qx, qy);
      d = 'M' + p0[0] + ' ' + p0[1] + 'Q' + qx + ' ' + qy + ' ' + p1[0] + ' ' + p1[1];
      lx = (p0[0] + 2 * qx + p1[0]) / 4; ly = (p0[1] + 2 * qy + p1[1]) / 4;
      nx = -dy / len; ny = dx / len;
    }
    var line = svgEl('path', { d: d, 'marker-end': 'url(#' + id + '-arrow)' }, g);
    svgEl('path', { d: d, 'class': 'en-sm-hit' }, g);
    if (t.label) {
      var bg = svgEl('rect', { 'class': 'en-sm-label-bg', rx: 3 }, g);
      var txt = svgEl('text', { x: lx, y: ly }, g, t.label);
      requestAnimationFrame(function () {
        var bb = txt.getBBox();
        /* A loop's label, and the labels of a pair of opposite transitions, move off the line to
           their own side by half their size, so neither covers the other. */
        if (a === b || back) {
          var shift = Math.abs(nx) * (bb.width / 2 + 4) + Math.abs(ny) * (bb.height / 2 + 2);
          setAttrs(txt, { x: lx + nx * shift, y: ly + ny * shift });
          bb = txt.getBBox();
        }
        setAttrs(bg, { x: bb.x - 3, y: bb.y - 1, width: bb.width + 6, height: bb.height + 2 });
      });
    }
    edgeNodes.push({ t: t, g: g, line: line, i: i });
    g.addEventListener('click', function (e) { e.stopPropagation(); selectEdge(i); });
    g.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); selectEdge(i); } });
  });
  states.forEach(function (s) {
    var g = svgEl('g', { 'class': 'en-sm-node' + (s.initial ? ' is-initial' : ''), tabindex: 0, role: 'button',
                         'aria-label': (s.label || s.id) + (s.initial ? ' (starting state)' : '') }, svg);
    svgEl('rect', { 'class': 'en-sm-glow', x: cx(s) - NW / 2 - 5, y: cy(s) - NH / 2 - 5, width: NW + 10, height: NH + 10, rx: 12 }, g);
    svgEl('rect', { 'class': 'en-sm-box', x: cx(s) - NW / 2, y: cy(s) - NH / 2, width: NW, height: NH, rx: 8 }, g);
    svgEl('text', { x: cx(s), y: cy(s) }, g, s.label || s.id);
    if (s.initial) {
      svgEl('circle', { 'class': 'en-sm-start', cx: cx(s) - NW / 2 - 16, cy: cy(s), r: 5 }, svg);
      svgEl('path', { d: 'M' + (cx(s) - NW / 2 - 11) + ' ' + cy(s) + 'H' + (cx(s) - NW / 2 - 2),
                      'class': 'en-sm-start-line', 'marker-end': 'url(#' + id + '-arrow)' }, svg);
    }
    nodeEls[s.id] = g;
    g.addEventListener('click', function (e) { e.stopPropagation(); selectState(s.id); });
    g.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); selectState(s.id); } });
  });
  svg.addEventListener('click', clear);

  function clear() {
    svg.classList.remove('has-selection');
    Object.keys(nodeEls).forEach(function (k) { nodeEls[k].classList.remove('is-selected', 'is-near'); });
    edgeNodes.forEach(function (e) { e.g.classList.remove('is-out', 'is-in', 'is-selected'); });
    markTaken();
  }
  function evidenceLine(parent, item, source) {
    var p = el('p', null, parent);
    p.appendChild(badge(evidenceOf(item, data)));
    if (source) p.appendChild(document.createTextNode(' ' + source));
  }
  function edgeButton(parent, t, i, text) {
    var li = el('li', null, parent);
    var b = el('button', { type: 'button', 'class': 'en-linkbtn' }, li, text);
    b.addEventListener('click', function () { selectEdge(i); });
    if (t.label) li.appendChild(document.createTextNode(': ' + t.label));
  }
  /* "Jump to frame N" for each interval of the clip spent in a state. */
  function jumps(parent, sid) {
    var spans = track.filter(function (t) { return t.state === sid; });
    if (!spans.length) return;
    var p = el('p', { 'class': 'en-jumps' }, parent, 'In the clip: ');
    spans.forEach(function (t) {
      var b = el('button', { type: 'button', 'class': 'en-chip' }, p, 'frames ' + t.start + '–' + (t.end - 1));
      b.addEventListener('click', function () { clip.setLoop({ start: t.start, end: t.end, label: byId[sid].label || sid }); });
    });
  }
  function selectState(sid) {
    clear();
    var s = byId[sid];
    svg.classList.add('has-selection');
    nodeEls[sid].classList.add('is-selected');
    detail.innerHTML = '';
    el('h4', null, detail, s.label || s.id);
    evidenceLine(detail, s, s.source);
    if (s.summary) el('p', null, detail, s.summary);
    jumps(detail, sid);
    var outs = el('ul', null, null), ins = el('ul', null, null);
    edgeNodes.forEach(function (e) {
      var t = e.t;
      if (t.from === sid) {
        e.g.classList.add('is-out');
        if (nodeEls[t.to]) nodeEls[t.to].classList.add('is-near');
        edgeButton(outs, t, e.i, '→ ' + (byId[t.to].label || t.to));
      } else if (t.to === sid) {
        e.g.classList.add('is-in');
        if (nodeEls[t.from]) nodeEls[t.from].classList.add('is-near');
        edgeButton(ins, t, e.i, '← ' + (byId[t.from].label || t.from));
      }
    });
    if (outs.children.length) { el('p', null, detail, 'Leaves to:'); detail.appendChild(outs); }
    if (ins.children.length) { el('p', null, detail, 'Entered from:'); detail.appendChild(ins); }
  }
  function selectEdge(i) {
    clear();
    var t = edges[i], e = edgeNodes.filter(function (n) { return n.i === i; })[0];
    svg.classList.add('has-selection');
    e.g.classList.add('is-selected');
    nodeEls[t.from].classList.add('is-near');
    nodeEls[t.to].classList.add('is-near');
    detail.innerHTML = '';
    el('h4', null, detail, (byId[t.from].label || t.from) + ' → ' + (byId[t.to].label || t.to));
    evidenceLine(detail, t, t.source);
    if (t.condition) el('p', null, detail, 'When: ' + t.condition);
    else if (t.label) el('p', null, detail, t.label);
    var taken = track.filter(function (s, k) { return k > 0 && track[k - 1].state === t.from && s.state === t.to; });
    if (taken.length) {
      var p = el('p', { 'class': 'en-jumps' }, detail, 'Taken in the clip at: ');
      taken.forEach(function (s) {
        var b = el('button', { type: 'button', 'class': 'en-chip' }, p, 'frame ' + s.start);
        b.addEventListener('click', function () { clip.userPaused = true; clip.seek(s.start); });
      });
    }
  }

  /* The clip's frame: light the state it is in, and the transition taken into it. */
  var takenEdge = null;
  function markTaken() {
    edgeNodes.forEach(function (e) {
      var on = e === takenEdge;
      e.g.classList.toggle('is-taken', on);
      e.line.setAttribute('marker-end', 'url(#' + id + (on ? '-arrow-taken' : '-arrow') + ')');
    });
  }
  clip.subscribe(function (f) {
    if (!track.length) return;
    var k = -1;
    for (var i = 0; i < track.length; i++) if (f >= track[i].start && f < track[i].end) { k = i; break; }
    var sid = k >= 0 ? track[k].state : null;
    Object.keys(nodeEls).forEach(function (n) { nodeEls[n].classList.toggle('is-current', n === sid); });
    takenEdge = null;
    if (k > 0 && track[k - 1].end === track[k].start) {
      var from = track[k - 1].state;
      takenEdge = edgeNodes.filter(function (e) { return e.t.from === from && e.t.to === sid; })[0] || null;
    }
    markTaken();
    nowLine.innerHTML = '';
    if (sid) {
      el('span', { 'class': 'en-readout' }, nowLine, 'frame ' + f + ' · ');
      el('strong', null, nowLine, byId[sid] ? byId[sid].label || sid : sid);
      nowLine.appendChild(document.createTextNode(' since frame ' + track[k].start +
        (takenEdge && takenEdge.t.label ? ' (' + takenEdge.t.label + ')' : '')));
    } else {
      el('span', { 'class': 'en-readout' }, nowLine, 'frame ' + f + ': no state recorded for this frame');
    }
  });

  dataTable(host, 'Transitions as a table', ['From', 'To', 'When', 'Evidence'], edges.map(function (t) {
    return [(byId[t.from] || {}).label || t.from, (byId[t.to] || {}).label || t.to, t.condition || t.label || '',
            badge(evidenceOf(t, data))];
  }));
  if (track.length) dataTable(host, 'States in the clip', ['Frames', 'State'], track.map(function (t) {
    return [t.start + '–' + (t.end - 1), (byId[t.state] || {}).label || t.state];
  }));
  if (data.note) el('p', { 'class': 'en-sub' }, host, data.note);
  clipKeys(host, clip);
}

/* ── Perception and range map ────────────────────────────────────────────────── */
/* Top-down, in metres, the enemy at the centre facing up. Shapes: circle {radius}, ring {inner,
   outer}, cone {radius, angle, facing} (degrees, clockwise from straight ahead) and leash {radius,
   home: [x, y]} (round the home point; +y is ahead). track: [{frame, player: [x, y], home?}] key
   frames, in the enemy's own frame of reference, interpolated between; active: [{start, end,
   shapes: [ids]}] the shapes in force over those clip frames. The gold marker can also be dragged
   (or moved with the arrow keys when focused) to test any point. */
function initRanges(host, data) {
  frame(host, data, 'Perception and range');
  var shapes = data.shapes || [], track = data.track || [], active = data.active || [];
  var unit = data.unit || 'm';
  var reach = 1;
  shapes.forEach(function (s) {
    var r = s.radius || s.outer || 0;
    if (s.kind === 'leash' && s.home) r += Math.sqrt(s.home[0] * s.home[0] + s.home[1] * s.home[1]);
    reach = Math.max(reach, r);
  });
  track.forEach(function (k) { reach = Math.max(reach, Math.sqrt(k.player[0] * k.player[0] + k.player[1] * k.player[1])); });
  reach *= 1.08;
  var last = track.reduce(function (m, k) { return Math.max(m, k.frame + 1); }, 1);
  var link = clipFor(host, data, last, data.fps);
  var clip = link.clip;
  var S = 200 / reach;
  var svg = svgEl('svg', { viewBox: '-210 -210 420 420', role: 'group', 'class': 'en-rm',
                           'aria-label': 'Top-down range map, the enemy at the centre facing up' }, host);
  var grid = data.grid || niceStep(reach);
  for (var r = grid; r <= reach; r += grid) {
    svgEl('circle', { 'class': 'en-rm-grid', r: r * S }, svg);
    svgEl('text', { 'class': 'en-rm-grid-label', x: 3, y: -r * S - 3 }, svg, +r.toFixed(2) + ' ' + unit);
  }
  svgEl('line', { 'class': 'en-rm-grid', x1: 0, y1: -reach * S, x2: 0, y2: reach * S }, svg);
  svgEl('line', { 'class': 'en-rm-grid', x1: -reach * S, y1: 0, x2: reach * S, y2: 0 }, svg);

  function P(x, y) { return [x * S, -y * S]; }
  function polar(deg, rad) { var a = deg * Math.PI / 180; return [Math.sin(a) * rad, Math.cos(a) * rad]; }
  var nodes = [], homeMark = null;
  shapes.forEach(function (s, i) {
    var cls = 'en-rm-shape en-rm-c-' + ((i % 6) + 1) + (s.kind === 'leash' ? ' is-leash' : '');
    var n;
    if (s.kind === 'circle') n = svgEl('circle', { 'class': cls, r: s.radius * S }, svg);
    else if (s.kind === 'ring') {
      n = svgEl('path', { 'class': cls, 'fill-rule': 'evenodd', d: circlePath(s.outer * S) + circlePath(s.inner * S) }, svg);
    } else if (s.kind === 'cone') {
      var half = s.angle / 2, f = s.facing || 0;
      if (s.angle >= 360) n = svgEl('circle', { 'class': cls, r: s.radius * S }, svg);
      else {
        var a0 = polar(f - half, s.radius), a1 = polar(f + half, s.radius);
        var p0 = P(a0[0], a0[1]), p1 = P(a1[0], a1[1]);
        n = svgEl('path', { 'class': cls, d: 'M0 0L' + p0[0] + ' ' + p0[1] + 'A' + s.radius * S + ' ' + s.radius * S +
                            ' 0 ' + (s.angle > 180 ? 1 : 0) + ' 1 ' + p1[0] + ' ' + p1[1] + 'Z' }, svg);
      }
    } else if (s.kind === 'leash') {
      var h = P(s.home[0], s.home[1]);
      n = svgEl('circle', { 'class': cls, cx: h[0], cy: h[1], r: s.radius * S }, svg);
      homeMark = svgEl('path', { 'class': 'en-rm-home', d: 'M-5 -5l10 10m0 -10l-10 10', transform: 'translate(' + h[0] + ' ' + h[1] + ')' }, svg);
    }
    if (n) { svgEl('title', null, n, s.label || s.id); nodes.push({ s: s, n: n, home: s.home }); }
  });
  svgEl('path', { 'class': 'en-rm-enemy', d: 'M0 -11L8 7L0 3L-8 7Z' }, svg);
  var probeLine = svgEl('line', { 'class': 'en-rm-probe-line', x1: 0, y1: 0 }, svg);
  var probe = svgEl('circle', { 'class': 'en-rm-probe', r: 9, tabindex: 0, role: 'slider',
                                'aria-label': 'Player position: drag, or use the arrow keys' }, svg);
  if (link.own && track.length) controlBar(host, clip);
  var readout = el('div', { 'class': 'en-readout', 'aria-live': 'off' }, host);
  var legend = el('div', { 'class': 'en-legend' }, host);
  nodes.forEach(function (o, i) {
    var lab = el('label', { 'class': 'en-rm-c-' + ((i % 6) + 1) }, legend);
    var box = el('input', { type: 'checkbox', checked: 'checked' }, lab);
    el('span', { 'class': 'en-swatch' }, lab);
    lab.appendChild(document.createTextNode(o.s.label || o.s.id));
    box.addEventListener('change', function () { o.n.classList.toggle('is-hidden', !box.checked); place(pos[0], pos[1]); });
  });

  function inside(o, x, y) {
    var s = o.s, d = Math.sqrt(x * x + y * y);
    if (s.kind === 'circle') return d <= s.radius;
    if (s.kind === 'ring') return d >= s.inner && d <= s.outer;
    if (s.kind === 'leash') { var hx = x - o.home[0], hy = y - o.home[1]; return Math.sqrt(hx * hx + hy * hy) <= s.radius; }
    if (s.kind === 'cone') {
      if (d > s.radius) return false;
      if (s.angle >= 360 || d === 0) return true;
      var a = Math.atan2(x, y) * 180 / Math.PI - (s.facing || 0);
      a = ((a + 540) % 360) - 180;
      return Math.abs(a) <= s.angle / 2;
    }
    return false;
  }
  var pos = data.probe || [reach * 0.35, reach * 0.45], activeNow = null, frameNow = null;
  function place(x, y) {
    x = clamp(x, -reach, reach); y = clamp(y, -reach, reach);
    pos = [x, y];
    var p = P(x, y);
    setAttrs(probe, { cx: p[0], cy: p[1] });
    setAttrs(probeLine, { x2: p[0], y2: p[1] });
    var hits = [];
    nodes.forEach(function (o) {
      var on = !activeNow || activeNow.indexOf(o.s.id) >= 0;
      o.n.classList.toggle('is-dim', !on);
      o.n.classList.toggle('is-active', !!activeNow && on);
      var hit = on && inside(o, x, y) && !o.n.classList.contains('is-hidden');
      o.n.classList.toggle('is-hit', hit);
      if (hit) hits.push(o.s.label || o.s.id);
    });
    var ang = Math.round(Math.atan2(x, y) * 180 / Math.PI), dist = Math.sqrt(x * x + y * y);
    probe.setAttribute('aria-valuetext', dist.toFixed(1) + ' ' + unit + ', ' + ang + ' degrees');
    readout.textContent = (frameNow != null ? 'frame ' + frameNow + ' · ' : '') + 'player ' + dist.toFixed(2) + ' ' + unit +
      ' away, ' + ang + '° from straight ahead · inside: ' + (hits.length ? hits.join(', ') : 'nothing shown') +
      (activeNow ? ' · in force: ' + (activeNow.length ? activeNow.join(', ') : 'none') : '');
  }
  /* The clip's frame: the player's interpolated position, the home point, the shapes in force. */
  clip.subscribe(function (f) {
    if (!track.length) return;
    var a = track[0], b = track[track.length - 1];
    for (var i = 0; i + 1 < track.length; i++) if (f >= track[i].frame && f <= track[i + 1].frame) { a = track[i]; b = track[i + 1]; break; }
    if (f < track[0].frame) b = a; else if (f > b.frame) a = b;
    var t = b.frame > a.frame ? (f - a.frame) / (b.frame - a.frame) : 0;
    var lerp = function (u, v) { return [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t]; };
    var home = a.home && b.home ? lerp(a.home, b.home) : null;
    if (home) nodes.forEach(function (o) {
      if (o.s.kind !== 'leash') return;
      o.home = home;
      var h = P(home[0], home[1]);
      setAttrs(o.n, { cx: h[0], cy: h[1] });
      if (homeMark) homeMark.setAttribute('transform', 'translate(' + h[0] + ' ' + h[1] + ')');
    });
    var span = intervalAt(active, f);
    activeNow = active.length ? (span ? span.shapes : []) : null;
    frameNow = f;
    var p = lerp(a.player, b.player);
    place(p[0], p[1]);
  });
  var dragging = false;
  probe.addEventListener('pointerdown', function (e) { dragging = true; probe.setPointerCapture(e.pointerId); e.preventDefault(); clip.pause(); });
  probe.addEventListener('pointermove', function (e) { if (dragging) { var p = svgPoint(svg, e); place(p.x / S, -p.y / S); } });
  probe.addEventListener('pointerup', function () { dragging = false; });
  probe.addEventListener('pointercancel', function () { dragging = false; });
  probe.addEventListener('keydown', function (e) {
    var step = reach / 50;
    var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); e.stopPropagation(); place(pos[0] + moves[e.key][0], pos[1] + moves[e.key][1]); }
  });
  if (!track.length) place(pos[0], pos[1]);

  dataTable(host, 'Shapes as a table', ['Shape', 'Kind', 'Size', 'Evidence', 'Note'], shapes.map(function (s) {
    var size = s.kind === 'ring' ? s.inner + '–' + s.outer + ' ' + unit
             : s.kind === 'cone' ? s.radius + ' ' + unit + ', ' + s.angle + '°' + (s.facing ? ' facing ' + s.facing + '°' : '')
             : s.kind === 'leash' ? s.radius + ' ' + unit + ' round home (' + s.home.join(', ') + ')'
             : s.radius + ' ' + unit;
    return [s.label || s.id, s.kind, size, badge(evidenceOf(s, data)), s.note || ''];
  }));
  if (data.note) el('p', { 'class': 'en-sub' }, host, data.note);
  clipKeys(host, clip);
}
function circlePath(r) { return 'M' + r + ' 0A' + r + ' ' + r + ' 0 1 0 ' + (-r) + ' 0A' + r + ' ' + r + ' 0 1 0 ' + r + ' 0Z'; }
function niceStep(span) {
  var raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  var n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

/* ── Attack choice chart ─────────────────────────────────────────────────────── */
/* One bar per situation (a distance band, an angle, a phase), split by each attack's share of that
   situation's weights. decisions: [{frame, band, attack, hold?}] in clip frames: from its frame
   (for hold frames, else until the next decision) the chosen branch is lit. */
function initChoice(host, data) {
  frame(host, data, 'How it picks an attack');
  var bands = data.bands || [], attacks = data.attacks || [], decisions = (data.decisions || []).slice();
  decisions.sort(function (a, b) { return a.frame - b.frame; });
  var last = decisions.reduce(function (m, d) { return Math.max(m, d.frame + (d.hold || 30)); }, 1);
  var link = clipFor(host, data, last, data.fps);
  var clip = link.clip;
  var W = clamp(host.clientWidth - 32, 360, 720), LEFT = 76, BAR = 30, GAP = 14, TOP = 4;
  var H = TOP + bands.length * (BAR + GAP);
  var nowLine = el('div', { 'class': 'en-sm-now', 'aria-live': 'polite' }, host);
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'en-ch', role: 'group',
                           'aria-label': 'Attack choice by situation: select a segment' }, host);
  if (link.own && decisions.length) controlBar(host, clip);
  var detail = el('div', { 'class': 'en-detail', 'aria-live': 'polite' }, host, 'Select a segment for its weight and condition.');
  var segs = [], bandLabels = {};
  bands.forEach(function (b, bi) {
    var y = TOP + bi * (BAR + GAP);
    bandLabels[b.id] = svgEl('text', { 'class': 'en-ch-band', x: 0, y: y + BAR / 2 + 4 }, svg, b.label || b.id);
    var total = 0;
    attacks.forEach(function (a) { total += (a.weights || {})[b.id] || 0; });
    var x = LEFT;
    attacks.forEach(function (a, ai) {
      var w = (a.weights || {})[b.id] || 0;
      if (!w || !total) return;
      var width = (W - LEFT) * w / total, pct = Math.round(100 * w / total);
      var r = svgEl('rect', { 'class': 'en-ch-seg', x: x, y: y, width: width, height: BAR, tabindex: 0, role: 'button',
                              style: '--c: var(--en-cat-' + ((ai % 6) + 1) + ')',
                              'aria-label': (a.label || a.id) + ', ' + (b.label || b.id) + ': ' + pct + ' percent' }, svg);
      if (width > 34) svgEl('text', { 'class': 'en-ch-pct', x: x + width / 2, y: y + BAR / 2 }, svg, pct + '%');
      var info = { a: a, b: b, w: w, pct: pct, r: r };
      segs.push(info);
      r.addEventListener('click', function () { pick(info); });
      r.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick(info); } });
      x += width;
    });
  });
  function pick(info) {
    svg.classList.add('has-selection');
    segs.forEach(function (s) { s.r.classList.toggle('is-selected', s === info); });
    detail.innerHTML = '';
    el('h4', null, detail, (info.a.label || info.a.id) + ' · ' + (info.b.label || info.b.id));
    var p = el('p', null, detail);
    p.appendChild(badge(evidenceOf(info.a, data)));
    p.appendChild(document.createTextNode(' weight ' + info.w + ', ' + info.pct + '% of this situation'));
    if (info.a.condition) el('p', null, detail, 'Only when: ' + info.a.condition);
    if (info.a.source) el('p', null, detail, info.a.source);
    var at = decisions.filter(function (d) { return d.band === info.b.id && d.attack === info.a.id; });
    if (at.length) {
      var j = el('p', { 'class': 'en-jumps' }, detail, 'Chosen in the clip at: ');
      at.forEach(function (d) {
        var b = el('button', { type: 'button', 'class': 'en-chip' }, j, 'frame ' + d.frame);
        b.addEventListener('click', function () { clip.userPaused = true; clip.seek(d.frame); });
      });
    }
  }
  /* The clip's frame: the decision in force, if any, lights its branch and its situation. */
  clip.subscribe(function (f) {
    if (!decisions.length) return;
    var d = null;
    decisions.forEach(function (c, i) {
      var end = c.hold ? c.frame + c.hold : (decisions[i + 1] ? decisions[i + 1].frame : c.frame + 30);
      if (f >= c.frame && f < end) d = c;
    });
    segs.forEach(function (s) { s.r.classList.toggle('is-chosen', !!d && s.a.id === d.attack && s.b.id === d.band); });
    Object.keys(bandLabels).forEach(function (k) { bandLabels[k].classList.toggle('is-chosen', !!d && k === d.band); });
    svg.classList.toggle('has-choice', !!d);
    nowLine.innerHTML = '';
    if (d) {
      var a = attacks.filter(function (x) { return x.id === d.attack; })[0] || {};
      var b = bands.filter(function (x) { return x.id === d.band; })[0] || {};
      el('span', { 'class': 'en-readout' }, nowLine, 'frame ' + f + ' · decision at frame ' + d.frame + ': ');
      el('strong', null, nowLine, (b.label || d.band) + ' → ' + (a.label || d.attack));
    } else {
      var next = decisions.filter(function (c) { return c.frame > f; })[0];
      el('span', { 'class': 'en-readout' }, nowLine, 'frame ' + f + (next ? ' · next decision at frame ' + next.frame : ' · no decision now'));
    }
  });
  var legend = el('div', { 'class': 'en-legend' }, host);
  attacks.forEach(function (a, ai) {
    var s = el('span', { style: '--c: var(--en-cat-' + ((ai % 6) + 1) + ')' }, legend);
    el('span', { 'class': 'en-swatch' }, s);
    s.appendChild(document.createTextNode(a.label || a.id));
  });
  dataTable(host, 'Weights as a table', ['Attack'].concat(bands.map(function (b) { return b.label || b.id; })).concat(['Evidence']),
    attacks.map(function (a) {
      return [a.label || a.id].concat(bands.map(function (b) { return String((a.weights || {})[b.id] || 0); }))
        .concat([badge(evidenceOf(a, data))]);
    }));
  if (data.note) el('p', { 'class': 'en-sub' }, host, data.note);
  clipKeys(host, clip);
}

/* ── Start ───────────────────────────────────────────────────────────────────── */
function start() {
  document.querySelectorAll('figure.en-clip').forEach(initClip);
  var kinds = { 'en-timeline': initTimeline, 'en-states': initStates, 'en-ranges': initRanges, 'en-choice': initChoice };
  Object.keys(kinds).forEach(function (cls) {
    document.querySelectorAll('div.' + cls).forEach(function (host) {
      loadData(host, function (data) {
        try { kinds[cls](host, data); } catch (e) { fail(host, e.message); }
      });
    });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
})();
