'use strict';
// Schermo della TV: segue lo stato del server (SSE). In «loop» mostra il video, in «show» le slide della libreria.
// Pubblicata come sito statico (meta showroom-mode = static) non c'è server: la pagina tiene lo stato da sola e si
// comanda con tocco, mouse e tastiera dal menu dei contenuti. Tutti i percorsi sono relativi.
const $ = (s) => document.querySelector(s);
const STATIC = document.querySelector('meta[name="showroom-mode"]')?.content === 'static';
const video = $('#loop');
const stage = $('#stage');
let LIB = null;
let INFO = null;
let STATE = null;
let shownKey = null;
let videoKey = null;
let manualHint = false;
let sweep = null;

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (t) => esc(t).replace(/\*([^*]+)\*/g, '<em>$1</em>');
const pad = (n) => String(n).padStart(2, '0');

async function boot() {
  LIB = await (await fetch('library.json')).json();
  if (LIB.poster) video.poster = LIB.poster;
  document.addEventListener('keydown', onKey);
  keepAwake();
  document.addEventListener('visibilitychange', keepAwake);
  video.addEventListener('error', () => setTimeout(() => { videoKey = null; if (STATE) apply(STATE); }, 5000));
  setInterval(nightlyReload, 60000);
  if (STATIC) { Local.start(); return; }
  try { INFO = await (await fetch('api/info')).json(); } catch { INFO = null; }
  const es = new EventSource('api/events');
  es.addEventListener('state', (e) => apply(JSON.parse(e.data)));
}

function send(body) {
  if (STATIC) { Local.command(body); return; }
  fetch('api/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── Video del loop ──
// Con Media Source Extensions i segmenti del master vengono riaccodati all'infinito in modalità «sequence»:
// alla ripartenza non c'è la pausa di 2–3 fotogrammi del loop nativo. Se MSE manca o fallisce: <video loop>.
let mse = null;

function setVideo(q) {
  const key = LIB.stream?.[q] ? `mse:${q}` : `mp4:${q}`;
  if (videoKey === key) return;
  videoKey = key;
  if (!startStream(q)) startNative(q);
}

function startNative(q) {
  stopStream();
  video.loop = true;
  const mp4 = LIB.video?.[q] || LIB.video?.['2160'] || LIB.video?.['1080'];
  const st = LIB.stream?.[q] || LIB.stream?.['1080'];
  // Safari senza MSE (iPhone): HLS nativo con gli stessi segmenti; altrimenti il file MP4 (solo col server locale)
  if (st && video.canPlayType('application/vnd.apple.mpegurl')) video.src = st.init.replace(/init\.mp4$/, 'index.m3u8');
  else if (mp4) video.src = mp4;
  else return;
  video.load();
}

function startStream(q) {
  const st = LIB.stream?.[q];
  if (!st || !('MediaSource' in window) || !MediaSource.isTypeSupported(st.mime)) return false;
  stopStream();
  const ms = new MediaSource();
  const s = { ms, st, sb: null, idx: 0, busy: false, dead: false, timer: 0 };
  mse = s;
  video.loop = false;
  video.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    try {
      s.sb = ms.addSourceBuffer(st.mime);
      s.sb.mode = 'sequence';
      await append(s, await getBytes(st.init));
      await pump(s);
      if (STATE && STATE.mode === 'loop' && !STATE.paused) video.play().catch(() => {});
      s.timer = setInterval(() => pump(s), 1000);
    } catch (e) { fallback(e); }
  }, { once: true });
  return true;
}

function stopStream() {
  if (!mse) return;
  mse.dead = true;
  clearInterval(mse.timer);
  mse = null;
}

function fallback(e) {
  console.warn('MSE non disponibile, loop nativo:', e);
  startNative(STATE?.settings?.video || '2160');
}

async function getBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

function sbOp(sb, fn) {
  return new Promise((res, rej) => {
    const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); res(); };
    const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); rej(new Error('SourceBuffer')); };
    sb.addEventListener('updateend', done);
    sb.addEventListener('error', fail);
    fn();
  });
}

async function append(s, data) {
  try {
    await sbOp(s.sb, () => s.sb.appendBuffer(data));
  } catch (e) {
    if (e.name !== 'QuotaExceededError') throw e;
    await sbOp(s.sb, () => s.sb.remove(0, Math.max(0, video.currentTime - 2)));
    await sbOp(s.sb, () => s.sb.appendBuffer(data));
  }
}

async function pump(s) {
  if (s.dead || s.busy || !s.sb) return;
  s.busy = true;
  try {
    const sb = s.sb;
    const t = video.currentTime;
    if (sb.buffered.length && t - sb.buffered.start(0) > 40) await sbOp(sb, () => sb.remove(0, t - 20));
    while (!s.dead) {
      const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
      if (end - video.currentTime > 24) break;
      const data = await getBytes(s.st.segments[s.idx]);
      if (s.dead) break;
      await append(s, data);
      s.idx = (s.idx + 1) % s.st.segments.length;
    }
  } catch (e) {
    if (!s.dead) fallback(e);
  } finally {
    s.busy = false;
  }
}

// dopo 12 ore di funzionamento, di notte e con il loop in onda, la pagina si ricarica (memoria del browser pulita)
function nightlyReload() {
  const h = new Date().getHours();
  if (performance.now() > 12 * 3600e3 && STATE?.mode === 'loop' && h >= 2 && h < 5) location.reload();
}

function apply(s) {
  STATE = s;
  setVideo(s.settings.video);
  document.body.classList.toggle('paused', !!s.paused);
  if (s.mode === 'loop') {
    document.body.classList.replace('is-show', 'is-loop') || document.body.classList.add('is-loop');
    if (s.paused) video.pause(); else video.play().catch(() => {});
    if (shownKey !== null) {
      shownKey = null;
      stopSweep();
      setTimeout(() => { if (STATE.mode === 'loop') stage.replaceChildren(); }, 1300);
    }
  } else {
    video.play().catch(() => {});
    document.body.classList.replace('is-loop', 'is-show') || document.body.classList.add('is-show');
    setTimeout(() => { if (STATE.mode === 'show') video.pause(); }, 1200);
    const cur = s.current;
    if (cur) {
      const key = `${s.deck}|${cur.deck}|${cur.index}`;
      if (key !== shownKey) {
        shownKey = key;
        show(cur.deck, cur.index);
      }
      chrome(s, cur);
    }
    const cmp = stage.querySelector('.slide:last-child.compare');
    if (cmp) compareTo(cmp, s.compare);
  }
  const showHint = (s.hint || manualHint) && INFO && INFO.pin;
  $('#hint').hidden = !showHint;
  if (showHint) {
    $('#hintUrl').textContent = `http://${INFO.host}:${INFO.port}`;
    $('#hintPin').textContent = `PIN ${INFO.pin}` + (INFO.ips.length ? `  ·  ${INFO.ips[0]}:${INFO.port}` : '');
  }
}

function chrome(s, cur) {
  const deck = LIB.decks[cur.deck];
  $('#deckTitle').textContent = s.deck === 'coda' ? `Consulenza · ${deck.title}` : deck.title;
  $('#count').textContent = `${pad(s.index + 1)} / ${pad(s.count)}`;
}

function photo(id) { return LIB.photos[id]; }

function bleed(id, extra = '') {
  const p = photo(id);
  return `<div class="bleed ${extra}"><img src="${p.src}" alt="${esc(p.title)}" decoding="async"></div>`;
}

function build(slide, deckId, index) {
  const el = document.createElement('section');
  el.className = 'slide' + (index % 2 ? ' alt' : '');
  const deck = LIB.decks[deckId];
  if (slide.type === 'cover') {
    el.innerHTML = bleed(slide.image, 'shade-bl') + `<div class="copy"><p class="kicker">${esc(slide.kicker)}</p>
      <h1 class="title">${md(slide.title)}</h1><span class="rule"></span><p class="text">${md(slide.text)}</p></div>`;
  } else if (slide.type === 'photo') {
    const p = photo(slide.photo);
    const kicker = slide.chapter || '';
    const title = slide.line ? `<h2 class="title small">${md(slide.line)}</h2>` : `<h2 class="title small">${esc(p.title)}</h2>`;
    const copy = `<div class="copy">${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ''}${title}<p class="keys">${esc(p.keys)}</p></div>`;
    if (p.w / p.h >= 1.2) {
      el.innerHTML = bleed(slide.photo, 'shade-bl') + copy;
    } else {
      el.innerHTML = `<div class="split">${copy}<div class="panel"><img src="${p.src}" alt="${esc(p.title)}" decoding="async"></div></div>`;
    }
  } else if (slide.type === 'compare') {
    el.classList.add('compare');
    const kicker = slide.chapter || 'Prima e dopo';
    const line = slide.line ? md(slide.line) : esc(photo(slide.after).title);
    el.innerHTML = bleed(slide.before, 'before') + bleed(slide.after, 'after shade-b') +
      `<span class="line"></span><span class="tag after">Dopo</span><span class="tag before">Prima</span>
       <div class="copy"><p class="kicker">${esc(kicker)}</p><h2 class="title small">${line}</h2></div>`;
  } else if (slide.type === 'service') {
    el.innerHTML = `<div class="service"><div class="copy"><p class="kicker">${esc(slide.number)}</p>
      <h1 class="title">${esc(slide.name)}</h1><p class="claim">${esc(slide.claim)}</p><span class="rule"></span>
      <p class="text">${esc(slide.line)}</p><ul>${slide.keys.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>
      <div class="panel"><img src="${photo(slide.image).src}" alt="" decoding="async"></div></div>`;
  } else if (slide.type === 'step') {
    el.classList.add('step');
    el.innerHTML = bleed(slide.image, 'shade-b') + `<div class="copy"><p class="kicker">${pad(slide.index + 1)} / ${esc(slide.name)}</p>
      <h2 class="title small">${esc(slide.line)}</h2></div><div class="steps">${deck.steps.map((n, k) =>
      `<span class="${k === slide.index ? 'on' : ''}">${pad(k + 1)}&ensp;${esc(n)}</span>`).join('')}</div>`;
  }
  return el;
}

async function show(deckId, index) {
  const slide = LIB.decks[deckId].slides[index];
  const el = build(slide, deckId, index);
  const imgs = [...el.querySelectorAll('img')];
  await Promise.race([Promise.all(imgs.map((i) => { const pre = new Image(); pre.src = i.src; return pre.decode().catch(() => {}); })),
    new Promise((r) => setTimeout(r, 4000))]);
  if (`${STATE.deck}|${deckId}|${index}` !== shownKey) return; // nel frattempo è cambiata slide
  stopSweep();
  const old = [...stage.children];
  stage.appendChild(el);
  void el.offsetWidth;
  el.classList.add('in');
  old.forEach((o) => { o.classList.add('out'); o.classList.remove('in'); setTimeout(() => o.remove(), 1100); });
  if (el.classList.contains('compare')) compareTo(el, STATE.compare);
  preloadNext(deckId, index);
}

function preloadNext(deckId, index) {
  const deck = LIB.decks[deckId];
  const nxt = deck.slides[index + 1];
  if (!nxt) return;
  for (const id of [nxt.photo, nxt.image, nxt.before, nxt.after]) if (id && photo(id)) { const i = new Image(); i.src = photo(id).src; }
}

function compareTo(el, pos) {
  if (pos === null || pos === undefined) {
    if (!sweep) {
      const t0 = performance.now();
      const step = (t) => {
        const x = 50 - 36 * Math.cos(((t - t0) / 11000) * 2 * Math.PI);
        el.style.setProperty('--x', x.toFixed(2) + '%');
        sweep = requestAnimationFrame(step);
      };
      sweep = requestAnimationFrame(step);
    }
  } else {
    stopSweep();
    el.style.setProperty('--x', (pos * 100).toFixed(2) + '%');
  }
}

function stopSweep() { if (sweep) cancelAnimationFrame(sweep); sweep = null; }

function onKey(e) {
  const map = { Escape: 'loop', Home: 'loop', l: 'loop', ' ': 'toggle', ArrowRight: 'next', PageDown: 'next', ArrowLeft: 'prev', PageUp: 'prev' };
  if (e.key === 'i' && !STATIC) { manualHint = !manualHint; if (STATE) apply(STATE); return; }
  if (e.key === 'f') { document.documentElement.requestFullscreen?.().catch(() => {}); return; }
  if (STATIC && (e.key === 'm' || e.key === 'Enter')) { e.preventDefault(); toggleMenu(); return; }
  if (STATIC && e.key === 'Escape' && !$('#menu').hidden) { toggleMenu(false); return; }
  const cmd = map[e.key];
  if (!cmd) return;
  e.preventDefault();
  send({ cmd });
}

// ── Modalità autonoma (sito statico): stato locale, menu dei contenuti, tocco e trascinamento ──
const Local = {
  s: null,
  last: 0,
  start() {
    // online parte in Full HD (banda contenuta); la TV dell'ufficio usa ?video=2160
    const q = new URLSearchParams(location.search).get('video');
    this.s = { rev: 1, mode: 'loop', paused: false, deck: null, index: 0, compare: null, queue: [], hint: false,
      settings: { video: q === '2160' ? '2160' : '1080' } };
    this.last = Date.now();
    document.body.classList.add('static');
    buildMenu();
    wirePointer();
    setInterval(() => { if (this.s.mode === 'show' && Date.now() - this.last > 15 * 60e3) this.command({ cmd: 'loop', auto: true }); }, 5000);
    this.publish();
  },
  publish() {
    const s = this.s;
    s.rev += 1;
    s.count = s.deck ? LIB.decks[s.deck].slides.length : 0;
    s.current = s.mode === 'show' ? { deck: s.deck, index: s.index } : null;
    apply({ ...s });
  },
  command(c) {
    const s = this.s;
    if (!c.auto) this.last = Date.now();
    if (c.cmd === 'loop') Object.assign(s, { mode: 'loop', paused: false, compare: null });
    else if (c.cmd === 'toggle') s.paused = !s.paused;
    else if (c.cmd === 'open' && LIB.decks[c.deck]) Object.assign(s, { mode: 'show', deck: c.deck, index: c.index || 0, paused: false, compare: null });
    else if ((c.cmd === 'next' || c.cmd === 'prev') && s.mode === 'show') {
      s.index = Math.max(0, Math.min(s.index + (c.cmd === 'next' ? 1 : -1), LIB.decks[s.deck].slides.length - 1));
      s.compare = null;
    } else if (c.cmd === 'compare') s.compare = c.pos;
    else return;
    this.publish();
  },
};

function buildMenu() {
  const groups = [['Progetti', 'progetti'], ['Categorie', 'categorie'], ['Servizi', 'servizi'], ['Metodo', 'metodo']];
  const nav = document.createElement('nav');
  nav.id = 'menu';
  nav.className = 'menu';
  nav.hidden = true;
  nav.setAttribute('aria-label', 'Contenuti dello showroom');
  nav.innerHTML = `<header class="menu-top"><img src="static/marchio.svg" alt="G&amp;C" width="75" height="44">
      <button type="button" class="menu-close" data-act="close">Chiudi</button></header>` +
    groups.map(([label, key]) => `<section><h2>${label}</h2><div class="menu-grid">${LIB.order[key].map((id) => {
      const d = LIB.decks[id];
      return `<button type="button" class="menu-card" data-open="${id}"><img src="${LIB.photos[d.cover].thumb}" alt="" loading="lazy">
        <span><strong>${esc(d.title)}</strong><em>${md(d.claim)}</em></span></button>`;
    }).join('')}</div></section>`).join('') +
    `<footer class="menu-foot"><button type="button" class="menu-home" data-act="loop">Torna allo showroom</button></footer>`;
  document.body.appendChild(nav);
  const open = document.createElement('button');
  open.type = 'button';
  open.id = 'explore';
  open.textContent = 'Esplora';
  document.body.appendChild(open);
  open.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(true); });
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.open) { Local.command({ cmd: 'open', deck: b.dataset.open }); toggleMenu(false); }
    else if (b.dataset.act === 'loop') { Local.command({ cmd: 'loop' }); toggleMenu(false); }
    else if (b.dataset.act === 'close') toggleMenu(false);
  });
}

function toggleMenu(force) {
  const nav = $('#menu');
  const show = force === undefined ? nav.hidden : force;
  nav.hidden = !show;
  document.body.classList.toggle('menu-open', show);
  if (show) nav.querySelector('button')?.focus();
}

function wirePointer() {
  let down = null;
  let idle = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  wake();
  ['pointermove', 'pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, wake));
  stage.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, drag: false }; });
  stage.addEventListener('pointermove', (e) => {
    if (!down) return;
    const cmp = STATE?.mode === 'show' && stage.querySelector('.slide:last-child.compare');
    if (cmp && Math.abs(e.clientX - down.x) > 8) {
      down.drag = true;
      Local.command({ cmd: 'compare', pos: Math.max(0, Math.min(1, e.clientX / innerWidth)) });
    }
  });
  stage.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const wasDrag = down.drag;
    down = null;
    if (wasDrag) return;
    if (STATE.mode !== 'show') { toggleMenu(true); return; }
    if (Math.abs(dx) > 60) { Local.command({ cmd: dx < 0 ? 'next' : 'prev' }); return; }
    const x = e.clientX / innerWidth;
    if (x < 0.25) Local.command({ cmd: 'prev' });
    else if (x > 0.75) Local.command({ cmd: 'next' });
    else toggleMenu(true);
  });
}

let lock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { lock = null; }
}

boot();
