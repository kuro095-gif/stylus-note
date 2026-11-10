/* 필기노트 — 휴대폰 필기 + Claude 처리 웹앱 */
'use strict';

const APP_VERSION = '1.0.2';
const PAGE_W = 800;          // 논리 좌표 폭
const LINE = 56;             // 줄 간격
const MARGIN = 40;           // 좌우 여백
const TOP = 28;              // 첫 줄 위치
const SLICE_PX_W = 900;      // Claude·드라이브용 페이지 이미지 폭
const SLICE_H = 1066;        // 이미지 한 장의 논리 높이 (약 900x1200px)

const PEN_COLORS = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7c3aed', '#ea580c'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd', '#fdba74'];
const PEN_WIDTHS = [3, 5, 8];
const HL_WIDTHS = [22, 34, 50];

const DEFAULT_NOTEBOOKS = [
  { name: '빠른 메모', sections: ['메모'] },
  { name: '업무', sections: ['일반', '학년부', '행사'] },
  { name: '수업', sections: ['일반'] },
  { name: '개인', sections: ['일반'] }
];

const TEMPLATES = {
  parent: { name: '학부모 상담', em: '👪', labels: ['상담 일시·방법', '학생 (학반·이름)', '보호자', '상담 내용', '후속 조치·할 일'] },
  meeting: { name: '회의', em: '🗣️', labels: ['회의명 · 일시 · 장소', '참석자', '안건', '결정 사항', '할 일 (담당·기한)'] },
  coop: { name: '업무 협조', em: '🤝', labels: ['요청 부서·담당자', '요청 내용', '기한', '진행 메모'] }
};

/* ───────── 작은 도우미 ───────── */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(d) { d = new Date(d); return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]})`; }
function fmtDateTime(t) { const d = new Date(t); return `${fmtDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtYmd(s) { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return fmtDate(new Date(y, m - 1, d)); }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ───────── 저장소 (IndexedDB) ───────── */
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('stylusnote', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('memos', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req ? req.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  return {
    get: (s, k) => run(s, 'readonly', st => st.get(k)),
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    all: (s) => run(s, 'readonly', st => st.getAll())
  };
})();

/* ───────── 설정 ───────── */
const settings = Object.assign({ url: '', pw: '', input: 'auto', bg: 'lines' }, JSON.parse(localStorage.getItem('sn.settings') || '{}'));
function saveSettings() { localStorage.setItem('sn.settings', JSON.stringify(settings)); }
let notebooks = JSON.parse(localStorage.getItem('sn.notebooks') || 'null') || DEFAULT_NOTEBOOKS;
function saveNotebooks() { localStorage.setItem('sn.notebooks', JSON.stringify(notebooks)); }
let penSeen = localStorage.getItem('sn.penSeen') === '1';

const tool = Object.assign({ t: 'pen', penColor: PEN_COLORS[0], hlColor: HL_COLORS[0], penW: 1, hlW: 1, peTool: 'pen' }, JSON.parse(localStorage.getItem('sn.tool') || '{}'));
function saveTool() { localStorage.setItem('sn.tool', JSON.stringify(tool)); }

/* ───────── 메모 모델 ───────── */
let memo = null;
let undoStack = [], redoStack = [];
let mode = 'draw';               // draw | text
let focusedBlock = null;

function newMemo(notebook, section) {
  return {
    id: uid(), title: '', notebook: notebook || '빠른 메모', section: section || '메모',
    created: Date.now(), updated: Date.now(), bg: settings.bg || 'lines',
    strokes: [], blocks: [], transcript: '', results: null, handled: [],
    status: 'draft', saved: false
  };
}
function isEmpty(m) { return !m.strokes.length && !m.blocks.some(b => b.type !== 'label' || b.edited) && !m.title; }
function contentBottom(m) {
  let b = 0;
  for (const s of m.strokes) b = Math.max(b, s.b[3]);
  for (const k of m.blocks) b = Math.max(b, k.y + k.h);
  return b;
}
function typedTexts(m) {
  const out = [];
  [...m.blocks].sort((a, b) => a.y - b.y).forEach(b => {
    if (b.type === 'text' && b.text.trim()) out.push(b.text.trim());
    if (b.type === 'label') out.push('■ ' + b.text);
    if (b.type === 'check') b.items.forEach(it => { if (it.t.trim()) out.push((it.d ? '☑ ' : '☐ ') + it.t.trim()); });
  });
  return out;
}

let saveTimer = null, syncTimer = null;
function markDirty() {
  if (!memo) return;
  memo.updated = Date.now();
  setDot('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveMemo(memo), 500);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { if (memo && !isEmpty(memo)) enqueue(memo.id, 'sync'); }, 30000);
}
async function saveMemo(m) {
  if (!m) return;
  if (isEmpty(m) && !m.saved) { setDot(''); return; }
  m.saved = true;
  await DB.put('memos', m);
  if (m === memo) setDot(statusDot(m));
}
function statusDot(m) {
  if (m.status === 'sending') return 'sending';
  if (m.status === 'queued') return 'queued';
  if (m.status === 'error') return 'error';
  return '';
}
function setDot(cls) {
  const d = $('#syncDot');
  d.className = 'sync-dot ' + (cls || '');
  d.title = { dirty: '저장 중', queued: '전송 대기', sending: '처리 중', error: '오류' }[cls] || '저장됨';
}

/* ───────── 사진 저장소 ───────── */
const imgCache = new Map();
async function getImg(pid) {
  if (imgCache.has(pid)) return imgCache.get(pid);
  const rec = await DB.get('photos', pid);
  if (!rec) return null;
  const img = new Image();
  img.src = rec.data;
  try { await img.decode(); } catch (e) { /* 무시 */ }
  imgCache.set(pid, img);
  return img;
}
async function photoData(pid) { const r = await DB.get('photos', pid); return r ? r.data : null; }

/* ───────── 필기 화면 배치 ───────── */
const scroller = $('#scroller'), page = $('#page'), ink = $('#ink');
const ctx = ink.getContext('2d');
const base = document.createElement('canvas'), bctx = base.getContext('2d');
let scale = 0.5, dpr = 1, viewH = 400, pageH = 2000;

let lastLayoutW = 0;
function layout() {
  const w = page.clientWidth || window.innerWidth;
  const widthChanged = w !== lastLayoutW;
  lastLayoutW = w;
  scale = w / PAGE_W;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  viewH = scroller.clientHeight;
  page.style.setProperty('--s', scale);
  document.documentElement.style.setProperty('--s', scale);
  ink.style.height = viewH + 'px';
  ink.width = Math.round(w * dpr);
  ink.height = Math.round(viewH * dpr);
  base.width = ink.width; base.height = ink.height;
  updatePageHeight(true);
  if (widthChanged || !page.querySelector('.blk')) renderBlocks();   // 키보드가 열려 높이만 바뀔 땐 다시 그리지 않음
  redraw();
}
function updatePageHeight(force) {
  if (!memo) return;
  const minH = viewH / scale + LINE * 4;
  const need = Math.max(minH, contentBottom(memo) + viewH / scale * 0.75);
  if (force || need > pageH || need < pageH - viewH / scale) {
    pageH = Math.ceil(need / LINE) * LINE;
    page.style.height = pageH * scale + 'px';
  }
}
function canvasOffset() {
  return (ink.getBoundingClientRect().top - page.getBoundingClientRect().top) / scale;
}
function setBg(bg) {
  page.classList.remove('bg-lines', 'bg-grid', 'bg-none');
  page.classList.add('bg-' + (bg || 'lines'));
}

/* ───────── 그리기 ───────── */
function pw(pr) { return 0.45 + 0.9 * pr; }
function drawStroke(c, s) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  c.strokeStyle = s.c; c.fillStyle = s.c; c.lineCap = 'round'; c.lineJoin = 'round';
  if (s.t === 'hl') {
    c.save();
    c.globalAlpha = 0.38;
    c.lineWidth = s.w;
    c.beginPath(); c.moveTo(p[0], p[1]);
    if (n === 1) c.lineTo(p[0] + 0.1, p[1]);
    for (let i = 1; i < n - 1; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], nx = p[i * 3 + 3], ny = p[i * 3 + 4];
      c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    if (n > 1) c.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    c.stroke(); c.restore();
    return;
  }
  if (n === 1) {
    c.beginPath(); c.arc(p[0], p[1], s.w * pw(p[2]) / 2, 0, Math.PI * 2); c.fill();
    return;
  }
  let sx = p[0], sy = p[1];
  for (let i = 1; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    const last = i === n - 1;
    const ex = last ? x : (x + p[i * 3 + 3]) / 2, ey = last ? y : (y + p[i * 3 + 4]) / 2;
    c.lineWidth = s.w * pw((p[i * 3 - 1] + p[i * 3 + 2]) / 2);
    c.beginPath(); c.moveTo(sx, sy); c.quadraticCurveTo(x, y, ex, ey); c.stroke();
    sx = ex; sy = ey;
  }
}
function drawStrokes(c, strokes, y0, y1, x0 = -1e9, x1 = 1e9) {
  for (const pass of ['hl', 'pen']) {
    for (const s of strokes) {
      if (s.t !== pass) continue;
      if (s.b[3] < y0 || s.b[1] > y1 || s.b[2] < x0 || s.b[0] > x1) continue;
      drawStroke(c, s);
    }
  }
}

let rafPending = false;
function redraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; paint(); });
}
function paint() {
  if (!memo) return;
  const k = dpr * scale, oy = canvasOffset();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.setTransform(k, 0, 0, k, 0, -oy * k);
  drawStrokes(ctx, memo.strokes, oy - 60, oy + viewH / scale + 60);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.clearRect(0, 0, base.width, base.height);
  bctx.drawImage(ink, 0, 0);
}
function paintLive() {
  if (!cur) return;
  const k = dpr * scale, oy = cur.oy;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(k, 0, 0, k, 0, -oy * k);
  drawStroke(ctx, cur.s);
}

function bbox(s) {
  const p = s.p; let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (let i = 0; i < p.length; i += 3) { a = Math.min(a, p[i]); b = Math.min(b, p[i + 1]); c = Math.max(c, p[i]); d = Math.max(d, p[i + 1]); }
  const h = s.w / 2 + 1;
  return [a - h, b - h, c + h, d + h];
}

/* ───────── 입력 처리 (펜·손가락·스크롤) ───────── */
const pointers = new Map();
let cur = null;     // 그리는 중인 획
let pan = null;     // 스크롤 중
let erasing = null; // 지우는 중
let momentum = null;

function inputMode() {
  if (settings.input === 'pen') return 'pen';
  if (settings.input === 'touch') return 'touch';
  return penSeen ? 'pen' : 'touch';
}
function toLogical(e) {
  const r = ink.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale + canvasOffset() };
}
function touchList() { return [...pointers.values()].filter(p => p.type === 'touch'); }
function avgY(list) { return list.reduce((a, p) => a + p.y, 0) / list.length; }

function startPan() {
  const list = touchList();
  if (!list.length) return;
  pan = { y: avgY(list), top: scroller.scrollTop, v: 0, lt: performance.now(), ly: avgY(list) };
}
function stopMomentum() { if (momentum) { cancelAnimationFrame(momentum); momentum = null; } }
function endPan() {
  if (!pan) return;
  let v = pan.v;
  pan = null;
  if (Math.abs(v) < 0.05) return;
  let last = performance.now();
  const step = (t) => {
    const dt = t - last; last = t;
    scroller.scrollTop -= v * dt;
    v *= Math.pow(0.95, dt / 16);
    if (Math.abs(v) > 0.02) momentum = requestAnimationFrame(step); else momentum = null;
  };
  momentum = requestAnimationFrame(step);
}

ink.addEventListener('pointerdown', (e) => {
  if (mode !== 'draw' || !memo) return;
  e.preventDefault();
  closePalette();
  try { ink.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  stopMomentum();
  if (e.pointerType === 'pen' && !penSeen) { penSeen = true; localStorage.setItem('sn.penSeen', '1'); }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  const im = inputMode();

  if (e.pointerType === 'touch') {
    if (im === 'pen') {
      if (cur && cur.type === 'pen') return;        // 펜으로 쓰는 중 손바닥 무시
      startPan();
      return;
    }
    if (touchList().length >= 2) {                   // 두 손가락 → 스크롤
      cancelStroke();
      erasing = null;
      startPan();
      return;
    }
  } else if (pan) {
    pan = null;                                      // 펜이 닿으면 스크롤 멈춤
  }
  if (pan) return;
  if (tool.t === 'eraser') { erasing = { id: e.pointerId, list: [] }; eraseAt(toLogical(e)); return; }
  beginStroke(e);
});

ink.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) { p.x = e.clientX; p.y = e.clientY; }
  if (pan && e.pointerType === 'touch') {
    const list = touchList();
    if (!list.length) return;
    const y = avgY(list), now = performance.now();
    const dt = Math.max(1, now - pan.lt);
    pan.v = 0.8 * pan.v + 0.2 * ((y - pan.ly) / dt);
    pan.lt = now; pan.ly = y;
    scroller.scrollTop = pan.top - (y - pan.y);
    return;
  }
  if (erasing && e.pointerId === erasing.id) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) eraseAt(toLogical(ev));
    return;
  }
  if (cur && e.pointerId === cur.id) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) addPoint(ev);
    if (!cur.raf) cur.raf = requestAnimationFrame(() => { if (cur) { cur.raf = 0; paintLive(); } });
  }
});

function pointerEnd(e, cancelled) {
  pointers.delete(e.pointerId);
  if (pan && e.pointerType === 'touch') {
    if (!touchList().length) endPan(); else startPan();
  }
  if (erasing && e.pointerId === erasing.id) {
    if (erasing.list.length) pushUndo({ t: 'erase', list: erasing.list });
    erasing = null;
    return;
  }
  if (cur && e.pointerId === cur.id) {
    if (cancelled) cancelStroke(); else endStroke();
  }
}
ink.addEventListener('pointerup', (e) => pointerEnd(e, false));
ink.addEventListener('pointercancel', (e) => pointerEnd(e, true));
ink.addEventListener('wheel', (e) => { scroller.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
ink.addEventListener('contextmenu', (e) => e.preventDefault());

function beginStroke(e) {
  const hl = tool.t === 'hl';
  const s = {
    id: uid(), t: hl ? 'hl' : 'pen',
    c: hl ? tool.hlColor : tool.penColor,
    w: hl ? HL_WIDTHS[tool.hlW] : PEN_WIDTHS[tool.penW],
    p: [], b: null
  };
  cur = { s, id: e.pointerId, type: e.pointerType, t0: performance.now(), oy: canvasOffset(), raf: 0 };
  paint();                       // base 갱신
  addPoint(e);
  paintLive();
}
function addPoint(e) {
  const { x, y } = toLogical(e);
  const p = cur.s.p, n = p.length;
  if (n) {
    const dx = x - p[n - 3], dy = y - p[n - 2];
    if (dx * dx + dy * dy < 0.6) return;
  }
  const pr = e.pointerType === 'pen' ? clamp(e.pressure || 0.5, 0.08, 1) : 0.5;
  p.push(+x.toFixed(1), +y.toFixed(1), +pr.toFixed(2));
  if (y > pageH - LINE * 3) { pageH += Math.round(viewH / scale); page.style.height = pageH * scale + 'px'; }
}
function cancelStroke() {
  if (!cur) return;
  if (cur.raf) cancelAnimationFrame(cur.raf);
  cur = null;
  redraw();
}
function endStroke() {
  const c = cur; cur = null;
  if (c.raf) cancelAnimationFrame(c.raf);
  const s = c.s;
  s.b = bbox(s);
  const dur = performance.now() - c.t0;
  const small = (s.b[2] - s.b[0]) < 14 && (s.b[3] - s.b[1]) < 14;
  if (small && dur < 300) {
    const hit = hitBlock(s.p[0], s.p[1]);
    if (hit && (hit.b.type === 'text' || hit.b.type === 'check' || hit.b.type === 'label')) {
      onBlockTap(hit, s.p[0], s.p[1]);
      redraw();
      return;
    }
  }
  memo.strokes.push(s);
  pushUndo({ t: 'add', s });
  updatePageHeight();
  redraw();
  markDirty();
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}
function eraseAt(pt, strokes = memo.strokes, onChange) {
  const r = 14 / scale;
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (pt.x < s.b[0] - r || pt.x > s.b[2] + r || pt.y < s.b[1] - r || pt.y > s.b[3] + r) continue;
    const rr = (r + s.w / 2) ** 2, p = s.p;
    let hit = false;
    if (p.length === 3) hit = (p[0] - pt.x) ** 2 + (p[1] - pt.y) ** 2 <= rr;
    for (let j = 3; j < p.length && !hit; j += 3) if (distSeg(pt.x, pt.y, p[j - 3], p[j - 2], p[j], p[j + 1]) <= rr) hit = true;
    if (hit) {
      strokes.splice(i, 1);
      const target = erasing || peErasing;
      if (target) target.list.push({ s, i });
      changed = true;
    }
  }
  if (changed) { (onChange || (() => { redraw(); markDirty(); }))(); }
}

/* ───────── 실행 취소 ───────── */
function pushUndo(a) { undoStack.push(a); if (undoStack.length > 200) undoStack.shift(); redoStack = []; updateUndoBtns(); }
function updateUndoBtns() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }
function applyAction(a, undo) {
  const S = memo.strokes;
  if (a.t === 'add') {
    if (undo) { const i = S.indexOf(a.s); if (i >= 0) S.splice(i, 1); } else S.push(a.s);
  } else if (a.t === 'erase') {
    if (undo) [...a.list].sort((x, y) => x.i - y.i).forEach(({ s, i }) => S.splice(Math.min(i, S.length), 0, s));
    else a.list.forEach(({ s }) => { const i = S.indexOf(s); if (i >= 0) S.splice(i, 1); });
  } else if (a.t === 'addBlock') {
    if (undo) removeBlock(a.b, true); else { memo.blocks.push(a.b); }
  } else if (a.t === 'delBlock') {
    if (undo) memo.blocks.push(a.b); else removeBlock(a.b, true);
  }
  renderBlocks(); updatePageHeight(); redraw(); markDirty();
}
function undo() { const a = undoStack.pop(); if (!a) return; applyAction(a, true); redoStack.push(a); updateUndoBtns(); }
function redo() { const a = redoStack.pop(); if (!a) return; applyAction(a, false); undoStack.push(a); updateUndoBtns(); }

/* ───────── 블록 (텍스트·체크박스·사진·양식) ───────── */
function snap(y) { return Math.ceil((y - TOP) / LINE) * LINE + TOP; }
function nextBlockY() {
  const b = contentBottom(memo);
  return b <= 0 ? TOP : snap(b + LINE * 0.4);
}
function hitBlock(x, y) {
  for (const b of memo.blocks) {
    const bx = b.type === 'photo' ? b.x : MARGIN, bw = b.type === 'photo' ? b.w : PAGE_W - MARGIN * 2;
    if (x >= bx && x <= bx + bw && y >= b.y && y <= b.y + b.h) return { b };
  }
  return null;
}
function onBlockTap(hit, x, y) {
  const b = hit.b;
  if (b.type === 'check') {
    const row = Math.floor((y - b.y) / LINE);
    if (x < MARGIN + 60 && b.items[row]) {
      b.items[row].d = !b.items[row].d;
      renderBlocks(); markDirty();
      return;
    }
  }
  if (b.type === 'label') return;
  setMode('text');
  const node = page.querySelector(`[data-bid="${b.id}"]`);
  if (!node) return;
  const row = b.type === 'check' ? clamp(Math.floor((y - b.y) / LINE), 0, b.items.length - 1) : 0;
  const input = b.type === 'check' ? $$('input', node)[row] : $('textarea', node);
  if (input) { input.focus(); }
}

function addTextBlock() {
  const b = { id: uid(), type: 'text', y: nextBlockY(), h: LINE, text: '' };
  memo.blocks.push(b); pushUndo({ t: 'addBlock', b });
  afterBlockAdded(b, 'textarea');
}
function addCheckBlock() {
  const b = { id: uid(), type: 'check', y: nextBlockY(), h: LINE, items: [{ t: '', d: false }] };
  memo.blocks.push(b); pushUndo({ t: 'addBlock', b });
  afterBlockAdded(b, 'input');
}
function afterBlockAdded(b, sel) {
  renderBlocks(); updatePageHeight(); markDirty();
  setMode('text');
  scroller.scrollTop = Math.max(0, b.y * scale - viewH * 0.3);
  const node = page.querySelector(`[data-bid="${b.id}"]`);
  const input = node && node.querySelector(sel);
  if (input) input.focus({ preventScroll: true });   // 바로 포커스해야 휴대폰 키보드가 열림
}
function insertTemplate(key) {
  const tpl = TEMPLATES[key];
  if (!tpl) return;
  let y = nextBlockY();
  const added = [];
  tpl.labels.forEach(text => {
    const b = { id: uid(), type: 'label', y, h: LINE, text };
    memo.blocks.push(b); added.push(b);
    y += LINE * 4;
  });
  added.forEach(b => pushUndo({ t: 'addBlock', b }));
  memo.template = key;
  renderBlocks(); updatePageHeight(); redraw(); markDirty();
}
function removeBlock(b, silent) {
  const i = memo.blocks.indexOf(b);
  if (i >= 0) memo.blocks.splice(i, 1);
  if (!silent) { pushUndo({ t: 'delBlock', b }); renderBlocks(); updatePageHeight(); redraw(); markDirty(); }
}

function renderBlocks() {
  if (!memo) return;
  $$('.blk, .photo-tools', page).forEach(n => n.remove());
  const s = scale;
  for (const b of memo.blocks) {
    let node;
    const left = (b.type === 'photo' ? b.x : MARGIN) * s, width = (b.type === 'photo' ? b.w : PAGE_W - MARGIN * 2) * s;
    if (b.type === 'label') {
      node = el(`<div class="blk label">${esc(b.text)}</div>`);
    } else if (b.type === 'text') {
      node = el(`<div class="blk text"><textarea rows="1" spellcheck="false" placeholder="입력하세요"></textarea><button class="del">삭제</button></div>`);
      const ta = $('textarea', node);
      ta.value = b.text;
      ta.addEventListener('input', () => { b.text = ta.value; fitText(b, ta); markDirty(); });
      ta.addEventListener('focus', () => { focusedBlock = b; node.classList.add('focused'); });
      ta.addEventListener('blur', () => {
        node.classList.remove('focused');
        setTimeout(() => {
          const a = document.activeElement;
          const stillHere = a && a.closest && a.closest(`[data-bid="${b.id}"]`);
          if (!b.text.trim() && memo && memo.blocks.includes(b) && !stillHere) removeBlock(b);
        }, 250);
      });
      $('.del', node).addEventListener('pointerdown', (e) => { e.preventDefault(); removeBlock(b); });
      requestAnimationFrame(() => fitText(b, ta));
    } else if (b.type === 'check') {
      node = el(`<div class="blk check"><button class="del">삭제</button></div>`);
      b.items.forEach((it, idx) => {
        const row = el(`<div class="row ${it.d ? 'done' : ''}"><button class="cb ${it.d ? 'on' : ''}" aria-label="체크"></button><input type="text" placeholder="할 일 입력" enterkeyhint="next"></div>`);
        const inp = $('input', row);
        inp.value = it.t;
        inp.addEventListener('input', () => { it.t = inp.value; markDirty(); });
        inp.addEventListener('focus', () => { focusedBlock = b; node.classList.add('focused'); });
        inp.addEventListener('blur', () => node.classList.remove('focused'));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            b.items.splice(idx + 1, 0, { t: '', d: false });
            b.h = b.items.length * LINE;
            renderBlocks(); updatePageHeight(); markDirty();
            const ins = $$(`[data-bid="${b.id}"] input`, page);
            if (ins[idx + 1]) ins[idx + 1].focus();
          } else if (e.key === 'Backspace' && !inp.value && b.items.length > 1) {
            e.preventDefault();
            b.items.splice(idx, 1);
            b.h = b.items.length * LINE;
            renderBlocks(); markDirty();
            const ins = $$(`[data-bid="${b.id}"] input`, page);
            if (ins[Math.max(0, idx - 1)]) ins[Math.max(0, idx - 1)].focus();
          }
        });
        $('.cb', row).addEventListener('click', () => { it.d = !it.d; renderBlocks(); markDirty(); });
        node.appendChild(row);
      });
      $('.del', node).addEventListener('pointerdown', (e) => { e.preventDefault(); removeBlock(b); });
    } else if (b.type === 'photo') {
      node = el(`<div class="blk photo"><img alt="사진"></div>`);
      const img = $('img', node);
      getImg(b.pid).then(im => { if (im) img.src = im.src; });
      const tools = el(`<div class="photo-tools">
        <button data-a="edit"><svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 012.8 0l.6.6a2 2 0 010 2.8L8.6 18.8z"/></svg>그리기</button>
        <button data-a="share"><svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/></svg>공유</button>
        <button data-a="del"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>
      </div>`);
      tools.style.top = (b.y * s + 8) + 'px';
      tools.style.right = (PAGE_W - b.x - b.w) * s + 8 + 'px';
      tools.addEventListener('click', (e) => {
        const a = e.target.closest('button'); if (!a) return;
        if (a.dataset.a === 'edit') openPhotoEditor(b);
        if (a.dataset.a === 'share') sharePhoto(b);
        if (a.dataset.a === 'del' && confirm('사진을 지울까요? (실행 취소로 되돌릴 수 있어요)')) removeBlock(b);
      });
      page.appendChild(tools);
    }
    node.dataset.bid = b.id;
    node.style.top = b.y * s + 'px';
    node.style.left = left + 'px';
    node.style.width = width + 'px';
    if (b.type === 'photo' || b.type === 'check' || b.type === 'label') node.style.height = b.h * s + 'px';
    page.appendChild(node);
  }
}
function fitText(b, ta) {
  ta.style.height = 'auto';
  const hpx = Math.max(ta.scrollHeight, LINE * scale);
  const h = Math.ceil(hpx / scale / LINE - 0.05) * LINE;
  ta.style.height = h * scale + 'px';
  if (h !== b.h) { b.h = h; updatePageHeight(); }
}

/* ───────── 사진 넣기 ───────── */
function pickPhoto() {
  openSheet(`<h3>사진 넣기</h3>
    <button class="opt" data-k="cam"><span class="em">📷</span><span>카메라로 찍기</span></button>
    <button class="opt" data-k="album"><span class="em">🖼️</span><span>앨범에서 고르기</span></button>`, (k) => {
    $(k === 'cam' ? '#fileCamera' : '#fileAlbum').click();
  });
}
async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await resizeImage(file, 1600, 0.85);
    const img = new Image(); img.src = data; await img.decode();
    const pid = uid();
    await DB.put('photos', { id: pid, memoId: memo.id, data });
    imgCache.set(pid, img);
    const w = PAGE_W - MARGIN * 2, h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const b = { id: uid(), type: 'photo', pid, x: MARGIN, y: nextBlockY(), w, h, iw: img.naturalWidth, ih: img.naturalHeight, uploaded: false };
    memo.blocks.push(b); pushUndo({ t: 'addBlock', b });
    renderBlocks(); updatePageHeight(); redraw(); markDirty();
    setMode('draw');
    scroller.scrollTop = Math.max(0, b.y * scale - 40);
    toast('사진 위에 바로 그리거나, [그리기]로 크게 열어보세요');
  } catch (err) {
    toast('사진을 불러오지 못했어요');
  }
}
async function resizeImage(file, max, q) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    const url = URL.createObjectURL(file);
    bmp = new Image(); bmp.src = url; await bmp.decode();
  }
  const iw = bmp.width || bmp.naturalWidth, ih = bmp.height || bmp.naturalHeight;
  const f = Math.min(1, max / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * f); c.height = Math.round(ih * f);
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
function strokesIn(m, R) { return m.strokes.filter(s => !(s.b[2] < R.x || s.b[0] > R.x + R.w || s.b[3] < R.y || s.b[1] > R.y + R.h)); }
async function mergedPhotoCanvas(m, b, maxSide, withImage = true) {
  const img = await getImg(b.pid);
  const iw = img ? img.naturalWidth : b.iw, ih = img ? img.naturalHeight : b.ih;
  const f0 = Math.min(1, maxSide / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * f0); c.height = Math.round(ih * f0);
  const x = c.getContext('2d');
  if (withImage && img) x.drawImage(img, 0, 0, c.width, c.height);
  const k = c.width / b.w;
  x.setTransform(k, 0, 0, k, -b.x * k, -b.y * k);
  x.beginPath(); x.rect(b.x, b.y, b.w, b.h); x.clip();
  const list = strokesIn(m, b);
  drawStrokes(x, list, -1e9, 1e9);
  return { canvas: c, count: list.length };
}
async function sharePhoto(b) {
  const { canvas } = await mergedPhotoCanvas(memo, b, 2000);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  const file = new File([blob], (memo.title || '메모') + ' 사진.jpg', { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: memo.title || '메모 사진' }); } catch (e) { /* 취소 */ }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    toast('이 기기에서는 공유 대신 사진을 저장했어요');
  }
}

/* ───────── 사진 편집 (전체 화면) ───────── */
const pe = { b: null, es: 1, ox: 0, oy: 0, cur: null, list: [], c: $('#peCanvas') };
let peErasing = null;
const pctx = pe.c.getContext('2d');
async function openPhotoEditor(b) {
  pe.b = b;
  pe.img = await getImg(b.pid);
  $('#photoEditor').classList.remove('hidden');
  history.pushState({ pe: 1 }, '');
  renderPeTools();
  requestAnimationFrame(peLayout);
}
function closePhotoEditor(fromPop) {
  if ($('#photoEditor').classList.contains('hidden')) return;
  $('#photoEditor').classList.add('hidden');
  pe.b = null;
  redraw();
  if (!fromPop && history.state && history.state.pe) history.back();
}
function peLayout() {
  if (!pe.b) return;
  const st = $('#peStage'), w = st.clientWidth, h = st.clientHeight;
  const d = Math.min(window.devicePixelRatio || 1, 3);
  pe.c.width = Math.round(w * d); pe.c.height = Math.round(h * d); pe.d = d;
  const b = pe.b, pad = 12;
  pe.es = Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h);
  pe.ox = (w - b.w * pe.es) / 2; pe.oy = (h - b.h * pe.es) / 2;
  pePaint();
}
function pePaint() {
  const b = pe.b; if (!b) return;
  const d = pe.d, k = pe.es * d;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, pe.c.width, pe.c.height);
  pctx.setTransform(k, 0, 0, k, (pe.ox - b.x * pe.es) * d, (pe.oy - b.y * pe.es) * d);
  if (pe.img) pctx.drawImage(pe.img, b.x, b.y, b.w, b.h);
  pctx.save(); pctx.beginPath(); pctx.rect(b.x, b.y, b.w, b.h); pctx.clip();
  drawStrokes(pctx, strokesIn(memo, b), -1e9, 1e9);
  if (pe.cur) drawStroke(pctx, pe.cur.s);
  pctx.restore();
}
function peLogical(e) {
  const r = pe.c.getBoundingClientRect();
  return { x: (e.clientX - r.left - pe.ox) / pe.es + pe.b.x, y: (e.clientY - r.top - pe.oy) / pe.es + pe.b.y };
}
pe.c.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (pe.cur || peErasing) return;
  try { pe.c.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  if (tool.peTool === 'eraser') {
    peErasing = { id: e.pointerId, list: [] };
    eraseAt(peLogical(e), memo.strokes, () => { pePaint(); markDirty(); });
    return;
  }
  const hl = tool.peTool === 'hl';
  pe.cur = { id: e.pointerId, s: { id: uid(), t: hl ? 'hl' : 'pen', c: hl ? tool.hlColor : tool.penColor, w: (hl ? HL_WIDTHS[tool.hlW] : PEN_WIDTHS[tool.penW]), p: [], b: null } };
  peAdd(e);
});
pe.c.addEventListener('pointermove', (e) => {
  if (peErasing && e.pointerId === peErasing.id) { eraseAt(peLogical(e), memo.strokes, () => { pePaint(); markDirty(); }); return; }
  if (!pe.cur || e.pointerId !== pe.cur.id) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  evs.forEach(peAdd);
  if (!pe.raf) pe.raf = requestAnimationFrame(() => { pe.raf = 0; pePaint(); });
});
function peEnd(e) {
  if (peErasing && e.pointerId === peErasing.id) {
    if (peErasing.list.length) pushUndo({ t: 'erase', list: peErasing.list });
    peErasing = null; return;
  }
  if (!pe.cur || e.pointerId !== pe.cur.id) return;
  const s = pe.cur.s; pe.cur = null;
  if (s.p.length) { s.b = bbox(s); memo.strokes.push(s); pushUndo({ t: 'add', s }); markDirty(); }
  pePaint();
}
pe.c.addEventListener('pointerup', peEnd);
pe.c.addEventListener('pointercancel', peEnd);
function peAdd(e) {
  const { x, y } = peLogical(e);
  const p = pe.cur.s.p, n = p.length;
  if (n && (x - p[n - 3]) ** 2 + (y - p[n - 2]) ** 2 < 0.3) return;
  const pr = e.pointerType === 'pen' ? clamp(e.pressure || 0.5, 0.08, 1) : 0.5;
  p.push(+x.toFixed(1), +y.toFixed(1), +pr.toFixed(2));
}
function renderPeTools() {
  $$('#peTools [data-petool]').forEach(b => b.classList.toggle('on', b.dataset.petool === tool.peTool));
  const hl = tool.peTool === 'hl';
  const colors = hl ? HL_COLORS : PEN_COLORS, curC = hl ? tool.hlColor : tool.penColor;
  $('#peColors').innerHTML = colors.map(c => `<button data-c="${c}" style="background:${c}" class="${c === curC ? 'on' : ''}"></button>`).join('');
}

/* ───────── 도구 모음 ───────── */
function setMode(m) {
  mode = m;
  document.body.classList.toggle('textmode', m === 'text');
  $('#btnText').classList.toggle('on', m === 'text');
  renderToolbar();
  if (m === 'draw' && document.activeElement && page.contains(document.activeElement)) document.activeElement.blur();
}
function renderToolbar() {
  $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', mode === 'draw' && b.dataset.tool === tool.t));
  const hl = tool.t === 'hl';
  $('#swatch').style.background = tool.t === 'eraser' ? '#e5e7eb' : (hl ? tool.hlColor : tool.penColor);
  const sw = (hl ? [12, 16, 20][tool.hlW] : [10, 15, 20][tool.penW]);
  $('#swatch').style.width = sw + 'px'; $('#swatch').style.height = sw + 'px';
  $('#btnColor').disabled = tool.t === 'eraser';
  updateUndoBtns();
}
function openPalette() {
  const p = $('#palette');
  if (!p.classList.contains('hidden')) return closePalette();
  const hl = tool.t === 'hl';
  const colors = hl ? HL_COLORS : PEN_COLORS, curC = hl ? tool.hlColor : tool.penColor;
  const curW = hl ? tool.hlW : tool.penW;
  const dots = hl ? [[16, 8], [24, 12], [34, 16]] : [[6, 6], [10, 10], [15, 15]];
  p.innerHTML = `<div class="pal-label">색상</div><div class="pal-row">` +
    colors.map(c => `<button data-c="${c}" style="background:${c}" class="${c === curC ? 'on' : ''}"></button>`).join('') +
    `</div><div class="pal-label">굵기</div><div class="pal-row">` +
    dots.map(([w, h], i) => `<button class="wbtn ${i === curW ? 'on' : ''}" data-w="${i}"><span style="width:${w}px;height:${h}px;background:${curC}"></span></button>`).join('') + `</div>`;
  const r = $('#toolbar').getBoundingClientRect();
  p.style.top = (r.bottom + 6) + 'px';
  p.classList.remove('hidden');
}
function closePalette() { $('#palette').classList.add('hidden'); }

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) {
    if (mode === 'draw' && tool.t === b.dataset.tool && b.dataset.tool !== 'eraser') { openPalette(); return; }
    tool.t = b.dataset.tool; saveTool(); closePalette(); setMode('draw'); return;
  }
  switch (b.id) {
    case 'btnColor': if (mode !== 'draw') setMode('draw'); openPalette(); break;
    case 'btnUndo': undo(); break;
    case 'btnRedo': redo(); break;
    case 'btnText': if (mode === 'text') setMode('draw'); else addTextBlock(); break;
    case 'btnCheck': addCheckBlock(); break;
    case 'btnPhoto': pickPhoto(); break;
  }
});
// 도구 버튼이 포커스를 가져가지 않게 (입력 중인 글자가 버튼으로 가는 것 방지)
['#toolbar', '#palette', '.actions'].forEach(sel => $$(sel).forEach(n => n.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); })));
$('#palette').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.c) { if (tool.t === 'hl') tool.hlColor = b.dataset.c; else tool.penColor = b.dataset.c; }
  if (b.dataset.w != null) { if (tool.t === 'hl') tool.hlW = +b.dataset.w; else tool.penW = +b.dataset.w; }
  saveTool(); renderToolbar(); closePalette();
});
function setMemoBg(bg) {
  memo.bg = bg; settings.bg = bg; saveSettings();
  setBg(bg); markDirty();
}
$('#peTools').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.petool) { tool.peTool = b.dataset.petool; saveTool(); renderPeTools(); return; }
  if (b.dataset.c) { if (tool.peTool === 'hl') tool.hlColor = b.dataset.c; else tool.penColor = b.dataset.c; saveTool(); renderPeTools(); renderToolbar(); return; }
  if (b.id === 'peUndo') { undo(); pePaint(); }
});
$('#peClose').addEventListener('click', () => closePhotoEditor());
$('#peDone').addEventListener('click', () => closePhotoEditor());
$('#peShare').addEventListener('click', () => pe.b && sharePhoto(pe.b));

/* ───────── 메모 열기·닫기 ───────── */
async function openMemo(m) {
  if (memo && memo !== m) await leaveMemo();
  memo = m;
  undoStack = []; redoStack = [];
  mode = 'draw';
  document.body.classList.remove('textmode');
  $('#title').value = m.title || '';
  setBg(m.bg);
  showView('memoView');
  scroller.scrollTop = 0;
  pageH = 0;
  lastLayoutW = 0;
  layout();
  renderResults();
  renderToolbar();
  setDot(statusDot(m));
}
async function leaveMemo() {
  const m = memo;
  if (!m) return;
  clearTimeout(saveTimer); clearTimeout(syncTimer);
  if (isEmpty(m)) {
    if (m.saved) { await DB.del('memos', m.id); }
    return;
  }
  await saveMemo(m);
  if (m.updated > (m.syncedAt || 0)) enqueue(m.id, 'sync');
}
function createAndOpen(nb, sec, tplKey) {
  const m = newMemo(nb, sec);
  openMemo(m).then(() => { if (tplKey) insertTemplate(tplKey); });
}

$('#title').addEventListener('input', () => { memo.title = $('#title').value; markDirty(); });
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
scroller.addEventListener('scroll', () => { if (!cur) redraw(); }, { passive: true });

/* ───────── 화면 전환 ───────── */
function showView(id) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== id));
  if (id !== 'memoView') closePalette();
}
$('#btnList').addEventListener('click', async () => { await leaveMemo(); await renderList(); showView('listView'); history.pushState({ v: 'list' }, ''); });
$('#btnListBack').addEventListener('click', () => { history.back(); });
$('#btnHistory').addEventListener('click', async () => { await renderHistory(); showView('historyView'); history.pushState({ v: 'history' }, ''); });
$('#btnHistoryBack').addEventListener('click', () => history.back());
$('#btnSettings').addEventListener('click', () => { renderSettings(); showView('settingsView'); history.pushState({ v: 'settings' }, ''); });
$('#btnSettingsBack').addEventListener('click', () => history.back());
window.addEventListener('popstate', (e) => {
  if (!$('#photoEditor').classList.contains('hidden')) { closePhotoEditor(true); return; }
  if (!$('#sheet').classList.contains('hidden')) { closeSheet(); }
  const st = e.state || {};
  if (st.v === 'list') { renderList(); showView('listView'); }
  else if (st.v === 'history') { renderHistory(); showView('historyView'); }
  else { if (memo) { showView('memoView'); requestAnimationFrame(layout); } }
});

/* ───────── 바텀시트 ───────── */
let sheetCb = null;
function openSheet(html, cb) {
  $('#sheet').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  $('#sheetBackdrop').classList.remove('hidden');
  sheetCb = cb;
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden'); sheetCb = null; }
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  const cb = sheetCb; closeSheet();
  if (cb) cb(b.dataset.k, b);
});

$('#btnMore').addEventListener('click', () => {
  const drive = memo.folderUrl ? `<button class="opt" data-k="drive"><span class="em">📁</span><span>드라이브에서 보기</span></button>` : '';
  openSheet(`<h3>${esc(memo.title || '제목 없음')}</h3>
    <button class="opt" data-k="img"><span class="em">🖼️</span><span>이미지로 공유<small>쓴 그대로 JPG로 · 길면 여러 장</small></span></button>
    <button class="opt" data-k="new"><span class="em">📝</span><span>새 메모</span></button>
    <button class="opt" data-k="tpl"><span class="em">📋</span><span>양식 넣기<small>학부모 상담 · 회의 · 업무 협조</small></span></button>
    <button class="opt" data-k="bg"><span class="em">▦</span><span>배경 바꾸기<small>지금: ${{ lines: '줄 노트', grid: '모눈', none: '무지' }[memo.bg || 'lines']}</small></span></button>
    <button class="opt" data-k="move"><span class="em">📂</span><span>위치 옮기기<small>${esc(memo.notebook)} › ${esc(memo.section)}</small></span></button>
    ${drive}
    <button class="opt danger" data-k="del"><span class="em">🗑️</span><span>메모 삭제</span></button>`, async (k) => {
    if (k === 'img') { shareMemoImages(); return; }
    if (k === 'new') { await leaveMemo(); chooseTemplateAndCreate(memo.notebook, memo.section); }
    if (k === 'tpl') chooseTemplate(insertTemplate);
    if (k === 'bg') openSheet(`<h3>배경</h3>
      <button class="opt" data-k="lines"><span class="em">☰</span><span>줄 노트</span></button>
      <button class="opt" data-k="grid"><span class="em">▦</span><span>모눈</span></button>
      <button class="opt" data-k="none"><span class="em">▢</span><span>무지</span></button>`, setMemoBg);
    if (k === 'move') chooseLocation((nb, sec) => { memo.notebook = nb; memo.section = sec; markDirty(); toast(`${nb} › ${sec}(으)로 옮겼어요`); });
    if (k === 'drive') window.open(memo.folderUrl, '_blank');
    if (k === 'del') deleteMemo(memo);
  });
});
function chooseTemplate(cb, withBlank) {
  const opts = Object.entries(TEMPLATES).map(([k, t]) => `<button class="tpl" data-k="${k}"><span class="em">${t.em}</span>${t.name}</button>`).join('');
  openSheet(`<h3>${withBlank ? '어떤 메모를 쓰시나요?' : '양식 넣기'}</h3><div class="grid2">${withBlank ? '<button class="tpl" data-k="blank"><span class="em">📄</span>빈 메모</button>' : ''}${opts}</div>`, (k) => cb(k === 'blank' ? null : k));
}
function chooseTemplateAndCreate(nb, sec) { chooseTemplate((k) => createAndOpen(nb, sec, k), true); }
function chooseLocation(cb) {
  const html = notebooks.map(n => `<div class="nb-title">${esc(n.name)}</div>` +
    n.sections.map(s => `<button class="opt" data-k="${esc(n.name)}\u0001${esc(s)}"><span class="em">📂</span><span>${esc(s)}</span></button>`).join('')).join('');
  openSheet(`<h3>어디로 옮길까요?</h3>${html}`, (k) => { const [nb, sec] = k.split('\u0001'); cb(nb, sec); });
}
async function deleteMemo(m) {
  if (!confirm('이 메모를 지울까요?\n(드라이브에 저장된 사본은 남아 있어요)')) return;
  await DB.del('memos', m.id);
  const q = await DB.all('outbox');
  for (const j of q) if (j.memoId === m.id) await DB.del('outbox', j.id);
  for (const b of m.blocks) if (b.type === 'photo') await DB.del('photos', b.pid);
  memo = null;
  createAndOpen();
  toast('메모를 지웠어요');
}

/* ───────── 메모 → 이미지 (Claude·드라이브용) ───────── */
function wrapLines(c, text, maxW) {
  const out = [];
  String(text).split('\n').forEach(par => {
    let line = '';
    for (const ch of par) {
      if (c.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  });
  return out;
}
/* 자를 위치 찾기: 목표 높이 근처에서 글씨를 가장 적게 가로지르는 줄 */
function findCut(m, target, minY) {
  const crosses = (y) => {
    let n = 0;
    for (const s of m.strokes) if (s.b[1] < y && s.b[3] > y) n++;
    for (const b of m.blocks) if (b.y < y && b.y + b.h > y) n += (b.type === 'photo' ? 1000 : 3);
    return n;
  };
  let best = target, bestN = crosses(target);
  for (let y = target; y > Math.max(minY + LINE * 4, target - LINE * 4) && bestN > 0; y -= 4) {
    const n = crosses(y);
    if (n < bestN) { best = y; bestN = n; }
  }
  return best;
}
/* 메모를 이미지 여러 장으로: Claude·드라이브(PNG, 겹침)용과 공유(JPG, 자연스러운 위치에서 자름)용 */
async function renderMemoImages(m, o = {}) {
  const pxW = o.pxW || SLICE_PX_W, sliceH = o.sliceH || SLICE_H;
  const overlap = o.overlap == null ? LINE : o.overlap;
  const k = pxW / PAGE_W;
  const total = contentBottom(m) + LINE * 0.5;
  if (total <= LINE * 0.5) return [];
  const photos = {};
  for (const b of m.blocks) if (b.type === 'photo') photos[b.pid] = await getImg(b.pid);

  // 1) 자를 구간 정하기
  const ranges = [];
  let y0 = 0;
  while (y0 < total) {
    let y1 = Math.min(total, y0 + sliceH);
    if (o.smart && total - y1 < sliceH * 0.3) y1 = total;          // 짧은 꼬리는 앞 장에 붙임
    if (o.smart && y1 < total) y1 = findCut(m, y1, y0);
    const has = m.strokes.some(s => s.b[3] >= y0 && s.b[1] <= y1) || m.blocks.some(b => b.y + b.h >= y0 && b.y <= y1);
    if (has) ranges.push([y0, y1]);
    if (y1 >= total) break;
    y0 = y1 - overlap;
  }

  // 2) 그리기
  const out = [];
  ranges.forEach(([y0, y1], idx) => {
    const c = document.createElement('canvas');
    c.width = pxW; c.height = Math.ceil((y1 - y0) * k);
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.setTransform(k, 0, 0, k, 0, -y0 * k);
    if (m.bg !== 'none') {
      x.strokeStyle = '#e3e9f0'; x.lineWidth = 1;
      const step = m.bg === 'grid' ? LINE / 2 : LINE;
      for (let ly = Math.floor(y0 / step) * step + step; ly < y1; ly += step) { x.beginPath(); x.moveTo(0, ly - 0.5); x.lineTo(PAGE_W, ly - 0.5); x.stroke(); }
      if (m.bg === 'grid') for (let lx = step; lx < PAGE_W; lx += step) { x.beginPath(); x.moveTo(lx - 0.5, y0); x.lineTo(lx - 0.5, y1); x.stroke(); }
    }
    for (const b of m.blocks) {
      if (b.y > y1 || b.y + b.h < y0) continue;
      if (b.type === 'photo') {
        if (photos[b.pid]) x.drawImage(photos[b.pid], b.x, b.y, b.w, b.h);
      } else {
        x.fillStyle = b.type === 'label' ? '#2c5282' : '#1f2933';
        x.font = (b.type === 'label' ? '700 30px' : '32px') + ' sans-serif';
        x.textBaseline = 'alphabetic';
        let lines;
        if (b.type === 'text') lines = wrapLines(x, b.text, PAGE_W - MARGIN * 2 - 8);
        else if (b.type === 'label') lines = ['■ ' + b.text];
        else lines = b.items.map(it => (it.d ? '☑ ' : '☐ ') + it.t);
        lines.forEach((ln, i) => x.fillText(ln, MARGIN + 4, b.y + i * LINE + LINE * 0.7));
      }
    }
    drawStrokes(x, m.strokes, y0, y1);
    if (o.pageNo && ranges.length > 1) {
      x.setTransform(1, 0, 0, 1, 0, 0);
      const label = `${idx + 1} / ${ranges.length}`;
      x.font = `600 ${Math.round(26 * k)}px sans-serif`;
      const tw = x.measureText(label).width, pad = 10 * k;
      x.fillStyle = 'rgba(30, 58, 95, .78)';
      const bx = c.width - tw - pad * 3, by = c.height - 44 * k;
      x.beginPath(); x.roundRect ? x.roundRect(bx, by, tw + pad * 2, 34 * k, 17 * k) : x.rect(bx, by, tw + pad * 2, 34 * k); x.fill();
      x.fillStyle = '#fff'; x.textBaseline = 'middle';
      x.fillText(label, bx + pad, by + 17 * k);
    }
    out.push(o.mime === 'image/jpeg' ? c.toDataURL('image/jpeg', o.q || 0.9) : c.toDataURL('image/png'));
  });
  return out;
}
function renderSlices(m) { return renderMemoImages(m); }

/* ───────── 메모를 이미지로 공유 (폰 안에서 만들어 바로 공유 — 서버를 거치지 않음) ───────── */
function dataUrlToFile(d, name) {
  const [head, b64] = d.split(',');
  const mime = head.match(/data:([^;]+)/)[1];
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], name, { type: mime });
}
async function shareMemoImages() {
  if (!memo) return;
  if (document.activeElement && page.contains(document.activeElement)) document.activeElement.blur();
  const imgs = await renderMemoImages(memo, { pxW: 1080, sliceH: SLICE_H, overlap: 0, smart: true, mime: 'image/jpeg', q: 0.9, pageNo: true });
  if (!imgs.length) { toast('메모에 내용을 먼저 써주세요'); return; }
  const base = safeFileName(memo.title || '메모 ' + fmtDate(memo.updated).replace('/', '-'));
  const files = imgs.map((d, i) => dataUrlToFile(d, imgs.length > 1 ? `${base} (${i + 1}).jpg` : `${base}.jpg`));
  await shareFiles(files, memo.title || '메모');
}
function safeFileName(s) { return String(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '메모'; }
async function shareFiles(files, title) {
  const canFiles = navigator.canShare && navigator.canShare({ files });
  if (canFiles) {
    try { await navigator.share({ files, title }); return; }
    catch (e) {
      if (e.name === 'AbortError') return;
      // 이미지 만드는 동안 '누름' 효과가 끝나 공유가 막힌 경우 → 한 번 더 누르게 함
      openSheet(`<h3>이미지 ${files.length}장 준비됐어요</h3>
        <button class="opt" data-k="go"><span class="em">📤</span><span>공유하기</span></button>`, async () => {
        try { await navigator.share({ files, title }); } catch (err) { if (err.name !== 'AbortError') downloadFiles(files); }
      });
      return;
    }
  }
  downloadFiles(files);
}
function downloadFiles(files) {
  files.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, i * 350));
  toast(`이 기기에서는 공유 대신 사진 ${files.length}장을 저장했어요`);
}

async function buildPayload(m, forClaude) {
  const pages = await renderSlices(m);
  const photos = [], claudePhotos = [], uploadedNow = [];
  for (const b of m.blocks) {
    if (b.type !== 'photo') continue;
    const ph = { id: b.pid };
    if (!b.uploaded) { ph.jpg = await photoData(b.pid); uploadedNow.push(b); }
    const layer = await mergedPhotoCanvas(m, b, 1600, false);
    if (layer.count) ph.drawing = layer.canvas.toDataURL('image/png');
    photos.push(ph);
    if (forClaude) claudePhotos.push((await mergedPhotoCanvas(m, b, 1568, true)).canvas.toDataURL('image/jpeg', 0.85));
  }
  const doc = {
    version: 1, id: m.id, bg: m.bg, pageWidth: PAGE_W, lineHeight: LINE,
    strokes: m.strokes, blocks: m.blocks.map(b => b.type === 'photo' ? Object.assign({}, b, { file: 'photos/photo-' + b.pid + '.jpg' }) : b)
  };
  const payload = {
    memo: {
      id: m.id, title: m.title, notebook: m.notebook, section: m.section, created: m.created, updated: m.updated,
      transcript: m.transcript || '', typed: typedTexts(m),
      photoIds: m.blocks.filter(b => b.type === 'photo').map(b => b.pid),
      resultSummary: (m.handled || []).join('\n'),
      doc
    },
    pages, photos
  };
  if (forClaude) payload.claudePhotos = claudePhotos;
  return { payload, uploadedNow };
}

/* ───────── 서버 통신 ───────── */
async function api(body, timeout = 120000) {
  if (!settings.url || !settings.pw) throw Object.assign(new Error('설정에서 서버 주소와 비밀번호를 먼저 넣어주세요.'), { setup: true });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(settings.url, { method: 'POST', body: JSON.stringify(Object.assign({ password: settings.pw }, body)), signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { return { ok: false, error: '서버 응답을 읽지 못했어요. 서버 주소(…/exec)와 배포 설정(액세스: 모든 사용자)을 확인해주세요.' }; }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, timeout: true, error: '응답이 너무 늦어요. 잠시 후 다시 보내주세요.' };
    throw Object.assign(err, { network: true });
  } finally { clearTimeout(t); }
}

async function enqueue(memoId, kind, reqMode) {
  const q = await DB.all('outbox');
  const mine = q.filter(j => j.memoId === memoId);
  if (kind === 'process') { for (const j of mine) await DB.del('outbox', j.id); }
  else if (mine.length) { flush(); return; }
  await DB.put('outbox', { id: uid(), memoId, kind, mode: reqMode || '', ts: Date.now() });
  flush();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  if (!settings.url || !settings.pw || !navigator.onLine) return;
  flushing = true;
  try {
    const q = (await DB.all('outbox')).sort((a, b) => a.ts - b.ts);
    for (const job of q) {
      const m = (memo && memo.id === job.memoId) ? memo : await DB.get('memos', job.memoId);
      if (!m) { await DB.del('outbox', job.id); continue; }
      const isProc = job.kind === 'process';
      if (isProc) { m.status = 'sending'; m.reqMode = job.mode; await DB.put('memos', m); if (m === memo) { setDot('sending'); renderResults(); } }
      let res, built;
      try {
        built = await buildPayload(m, isProc);
        const body = Object.assign({ action: job.kind }, built.payload);
        if (isProc) {
          body.mode = job.mode;
          body.notebooks = notebooks;
          body.previous = { transcript: m.transcript || '', handled: m.handled || [] };
        }
        res = await api(body, isProc ? 330000 : 120000);
      } catch (err) {
        if (isProc) { m.status = 'queued'; await DB.put('memos', m); if (m === memo) { setDot('queued'); renderResults(); } }
        break;  // 인터넷이 다시 연결되면 이어서 보냄
      }
      if (!res.ok) {
        if (res.code === 'auth') { toast('비밀번호가 맞지 않아요. 설정을 확인해주세요.', 4000); if (isProc) { m.status = 'queued'; await DB.put('memos', m); } break; }
        if (isProc) { m.status = 'error'; m.error = res.error; }
        await DB.put('memos', m);
        await DB.del('outbox', job.id);
        if (m === memo) { setDot(statusDot(m)); renderResults(); }
        if (!isProc) toast('드라이브 저장 실패: ' + res.error, 4000);
        continue;
      }
      built.uploadedNow.forEach(b => { b.uploaded = true; });
      m.folderUrl = res.folderUrl || m.folderUrl;
      m.syncedAt = Date.now();
      if (isProc) applyResult(m, res.result);
      await DB.put('memos', m);
      await DB.del('outbox', job.id);
      if (m === memo) {
        setDot(statusDot(m)); renderResults();
        if (isProc) {
          if (!$('#title').value && m.title) $('#title').value = m.title;
          toast('Claude 처리 완료');
          setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
        }
      }
    }
  } finally {
    flushing = false;
    updateQueueInfo();
  }
}
window.addEventListener('online', flush);
setInterval(flush, 60000);

function itemSummary(it) {
  if (it.kind === 'event') return `📅 ${it.date || ''} ${it.start || ''} ${it.title}`.replace(/\s+/g, ' ');
  if (it.kind === 'task') return `✅ ${it.due || ''} ${it.title}`.replace(/\s+/g, ' ');
  if (it.kind === 'doc') return `📄 ${it.name || it.fileName}`;
  if (it.kind === 'answer') return `💬 ${it.title}`;
  return '';
}
function applyResult(m, r) {
  if (!r) return;
  if (r.transcript) m.transcript = r.transcript;
  if (!m.title && r.title) m.title = r.title;
  m.results = m.results || { items: [] };
  m.results.items = (m.results.items || []).concat(r.items || []);
  m.results.suggest = r.suggest;
  m.results.corrections = r.corrections || [];
  m.results.message = r.message || '';
  m.results.at = r.at || Date.now();
  m.results.mode = r.mode;
  m.handled = (m.handled || []).concat((r.items || []).map(itemSummary));
  m.status = 'done'; m.error = null;
}

async function sendMemo(reqMode) {
  if (!memo) return;
  if (isEmpty(memo) || (!memo.strokes.length && !typedTexts(memo).length && !memo.blocks.some(b => b.type === 'photo'))) { toast('메모에 내용을 먼저 써주세요'); return; }
  if (document.activeElement) document.activeElement.blur();
  if (!settings.url || !settings.pw) { toast('설정에서 서버 주소와 비밀번호를 먼저 넣어주세요', 3500); renderResults(); return; }
  memo.status = navigator.onLine ? 'sending' : 'queued';
  memo.reqMode = reqMode;
  await saveMemo(memo);
  setDot(statusDot(memo));
  renderResults();
  if (!navigator.onLine) toast('인터넷이 연결되면 자동으로 보낼게요');
  await enqueue(memo.id, 'process', reqMode);
}
$('#btnSend').addEventListener('click', () => sendMemo('send'));
$('#btnRequest').addEventListener('click', () => sendMemo('request'));

/* ───────── 결과 카드 ───────── */
function renderResults() {
  const box = $('#results');
  if (!memo) { box.innerHTML = ''; return; }
  const m = memo, r = m.results;
  let html = '';
  if (!settings.url || !settings.pw) {
    html += `<div class="banner">Claude로 보내려면 먼저 서버를 연결해야 해요. <button data-r="settings">설정 열기</button></div>`;
  }
  if (m.status === 'sending' || m.status === 'queued' || m.status === 'error' || r) {
    html += `<div class="rcard">`;
    html += `<div class="rhead">🤖 Claude 처리 결과<span class="time">${r && r.at ? fmtDateTime(r.at) : ''}</span></div>`;
    if (m.status === 'sending') html += `<div class="rsec"><div class="note info"><span class="spinner"></span> ${m.reqMode === 'request' ? '요청을 처리하는 중이에요… (문서는 1분 정도 걸려요)' : '메모를 읽는 중이에요…'}</div></div>`;
    if (m.status === 'queued') html += `<div class="rsec"><div class="note">⏳ 전송 대기 중 — 인터넷이 연결되면 자동으로 보내요.</div></div>`;
    if (m.status === 'error') html += `<div class="rsec"><div class="note err">⚠ ${esc(m.error || '처리하지 못했어요')}</div><div class="btns"><button class="btn small" data-r="retry">다시 보내기</button></div></div>`;
    if (r) {
      const sg = r.suggest;
      if (sg && sg.notebook && sg.section && (sg.notebook !== m.notebook || sg.section !== m.section) && notebooks.some(n => n.name === sg.notebook && n.sections.includes(sg.section))) {
        html += `<div class="rsec"><div class="note info">📂 '${esc(sg.notebook)} › ${esc(sg.section)}'(으)로 옮길까요? <button class="btn small" data-r="move" style="margin-left:6px">옮기기</button></div></div>`;
      }
      if (r.message) html += `<div class="rsec"><div class="note">${esc(r.message)}</div></div>`;
      if (m.transcript) {
        html += `<div class="rsec"><div class="rlabel">읽은 내용<button class="link" data-r="editTr">✏ 수정</button></div>`;
        html += m.editingTr ? `<textarea class="transcript-edit" id="trEdit">${esc(m.transcript)}</textarea><div class="btns"><button class="btn small primary" data-r="saveTr">저장</button><button class="btn small" data-r="cancelTr">취소</button></div>`
          : `<div class="transcript">${esc(m.transcript)}</div>`;
        if (r.corrections && r.corrections.length) html += `<div class="corr" style="margin-top:6px">이름 보정: ${r.corrections.map(c => `${esc(c.from)} → <b>${esc(c.to)}</b>`).join(', ')}</div>`;
        html += `</div>`;
      }
      const items = r.items || [];
      if (items.length) {
        html += `<div class="rsec"><div class="rlabel">처리 항목</div>`;
        items.forEach(it => { html += itemHtml(it); });
        html += `</div>`;
      } else if (m.status === 'done') {
        html += `<div class="rsec"><div class="corr">등록할 일정이나 할 일은 없었어요.</div></div>`;
      }
      html += `<div class="share-row btns"><button class="btn grow primary" data-r="shareImg">🖼️ 이미지로 공유</button>${m.transcript ? `<button class="btn grow" data-r="share">📝 글자로 공유</button>` : ''}</div>`;
    }
    html += `</div>`;
  } else if (!isEmpty(m)) {
    html += `<div class="empty-hint">다 쓰셨으면 📤 보내기, 시킬 일이 있으면 ⚡ 요청을 눌러주세요</div>`;
  }
  box.innerHTML = html;
}
function confText(c) {
  if (!c) return '';
  let s = '';
  if (c.classes && c.classes.length) s += `<div class="conf class">⚠ 빠지게 되는 수업: ${c.classes.map(x => `${esc(x.period)} ${esc(x.cls)} ${esc(x.subject)} (${esc(x.time)})`).join(', ')}</div>`;
  if (c.events && c.events.length) s += `<div class="conf ev">📌 겹치는 일정: ${c.events.map(x => `${esc(x.title)} (${esc(x.calendar)}, ${esc(x.time)})`).join(', ')}</div>`;
  if (!s) s = `<div class="conf ok">겹치는 수업·일정 없음</div>`;
  return s;
}
function itemHtml(it) {
  const id = esc(it.id);
  if (it.kind === 'event') {
    if (it.status === 'registered') return `<div class="item compact done" data-id="${id}"><span class="txt">✅ 등록됨 · ${fmtYmd(it.date)} ${it.allDay || !it.start ? '종일' : esc(it.start)} ${esc(it.title)} · ${it.calendar === 'school' ? '학교 일정' : '내 캘린더'}</span><button class="btn small" data-r="open">보기</button><button class="btn small" data-r="cancel">취소</button></div>`;
    if (it.status === 'skipped') return `<div class="item compact skipped" data-id="${id}"><span class="txt">건너뜀 · ${esc(it.title)}</span><button class="btn small" data-r="unskip">되돌리기</button></div>`;
    const allDay = it.allDay || !it.start;
    return `<div class="item" data-id="${id}">
      <div class="q">📅 이 내용으로 등록할까요?</div>
      <div class="fields">
        <input data-f="title" value="${esc(it.title)}" placeholder="일정 제목">
        <input type="date" data-f="date" value="${esc(it.date || '')}">
        <div class="times"><input type="time" data-f="start" value="${esc(it.start || '')}" ${allDay ? 'disabled' : ''}><span>~</span><input type="time" data-f="end" value="${esc(it.end || '')}" ${allDay ? 'disabled' : ''}><label class="allday"><input type="checkbox" data-f="allDay" ${allDay ? 'checked' : ''}>종일</label></div>
        <div class="two"><input data-f="location" value="${esc(it.location || '')}" placeholder="장소"><select data-f="calendar"><option value="school" ${it.calendar !== 'personal' ? 'selected' : ''}>학교 일정</option><option value="personal" ${it.calendar === 'personal' ? 'selected' : ''}>내 캘린더</option></select></div>
      </div>
      <div class="cf">${confText(it.conflicts)}</div>
      <div class="btns"><button class="btn primary grow" data-r="confirm">등록</button><button class="btn" data-r="skip">건너뛰기</button></div>
    </div>`;
  }
  if (it.kind === 'task') {
    if (it.status === 'registered') return `<div class="item compact done" data-id="${id}"><span class="txt">✅ 할 일 등록됨 · ${it.due ? fmtYmd(it.due) + ' ' : ''}${esc(it.title)}</span><button class="btn small" data-r="open">보기</button><button class="btn small" data-r="cancel">취소</button></div>`;
    if (it.status === 'skipped') return `<div class="item compact skipped" data-id="${id}"><span class="txt">건너뜀 · ${esc(it.title)}</span><button class="btn small" data-r="unskip">되돌리기</button></div>`;
    return `<div class="item" data-id="${id}">
      <div class="q">✅ 할 일로 등록할까요?</div>
      <div class="fields"><input data-f="title" value="${esc(it.title)}" placeholder="할 일"><input type="date" data-f="due" value="${esc(it.due || '')}"></div>
      <div class="btns"><button class="btn primary grow" data-r="confirm">등록</button><button class="btn" data-r="skip">건너뛰기</button></div>
    </div>`;
  }
  if (it.kind === 'doc') {
    if (it.status === 'error') return `<div class="item error" data-id="${id}"><div class="q">⚠ 문서를 만들지 못했어요</div><div class="corr">${esc(it.fileName)} — ${esc(it.error)}</div><div class="btns"><button class="btn small" data-r="retryDoc">다시 만들기</button></div></div>`;
    return `<div class="item compact done" data-id="${id}"><span class="txt">📄 <b>${esc(it.name || it.fileName)}</b><br><span class="corr">${esc(it.folderName || '')}에 저장됨${it.note ? ' · ' + esc(it.note) : ''}</span></span><button class="btn small primary" data-r="open">열기</button></div>`;
  }
  if (it.kind === 'answer') {
    return `<div class="item" data-id="${id}"><div class="q">💬 ${esc(it.title || '결과')}</div><div class="answer">${esc(it.text)}</div>
      <div class="btns"><button class="btn small" data-r="copy">복사</button><button class="btn small primary" data-r="shareAns">공유</button></div></div>`;
  }
  return '';
}
function findItem(id) { return memo && memo.results && (memo.results.items || []).find(x => x.id === id); }
function readFields(card, it) {
  $$('[data-f]', card).forEach(f => {
    const k = f.dataset.f;
    it[k] = f.type === 'checkbox' ? f.checked : f.value;
  });
  if (it.kind === 'event') { if (it.allDay) { it.start = null; it.end = null; } if (!it.end) it.end = null; }
}
$('#results').addEventListener('change', (e) => {
  const card = e.target.closest('.item'); if (!card) return;
  const it = findItem(card.dataset.id); if (!it) return;
  readFields(card, it);
  markDirty();
  if (it.kind === 'event') {
    if (e.target.dataset.f === 'allDay') {
      $$('[data-f="start"],[data-f="end"]', card).forEach(x => { x.disabled = it.allDay; });
    }
    if (['date', 'start', 'end', 'allDay'].includes(e.target.dataset.f)) recheckConflicts(it, card);
  }
});
let conflictTimer;
function recheckConflicts(it, card) {
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(async () => {
    if (!it.date || !navigator.onLine) return;
    $('.cf', card).innerHTML = `<div class="conf ev"><span class="spinner"></span> 겹치는 수업·일정 확인 중…</div>`;
    try {
      const res = await api({ action: 'conflicts', item: it }, 30000);
      if (res.ok) { it.conflicts = res.conflicts; markDirty(); }
    } catch (err) { /* 무시 */ }
    const c = $(`.item[data-id="${it.id}"] .cf`);
    if (c) c.innerHTML = confText(it.conflicts);
  }, 700);
}
$('#results').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  const r = b.dataset.r;
  const card = b.closest('.item');
  const it = card ? findItem(card.dataset.id) : null;
  switch (r) {
    case 'settings': renderSettings(); showView('settingsView'); history.pushState({ v: 'settings' }, ''); break;
    case 'retry': sendMemo(memo.reqMode || 'send'); break;
    case 'move': { const sg = memo.results.suggest; memo.notebook = sg.notebook; memo.section = sg.section; markDirty(); renderResults(); toast(`${sg.notebook} › ${sg.section}(으)로 옮겼어요`); break; }
    case 'editTr': memo.editingTr = true; renderResults(); break;
    case 'cancelTr': memo.editingTr = false; renderResults(); break;
    case 'saveTr': memo.transcript = $('#trEdit').value; memo.editingTr = false; markDirty(); renderResults(); toast('수정했어요'); break;
    case 'share': shareText(memo.title || '메모', memo.transcript); break;
    case 'shareImg': shareMemoImages(); break;
    case 'copy': copyText(it.text); break;
    case 'shareAns': shareText(it.title || '결과', it.text); break;
    case 'open': if (it.link || it.url) window.open(it.link || it.url, '_blank'); break;
    case 'skip': it.status = 'skipped'; markDirty(); renderResults(); break;
    case 'unskip': it.status = 'proposed'; markDirty(); renderResults(); break;
    case 'confirm': {
      readFields(card, it);
      if (!it.title || (it.kind === 'event' && !it.date)) { toast('제목과 날짜를 확인해주세요'); return; }
      b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await api({ action: 'confirm', item: it }, 60000);
        if (!res.ok) throw new Error(res.error);
        it.status = 'registered'; it.extId = res.extId; it.calendarId = res.calendarId; it.link = res.link; it.registeredAt = Date.now();
        markDirty(); renderResults(); toast(it.kind === 'event' ? '캘린더에 등록했어요' : '할 일에 등록했어요');
      } catch (err) {
        b.disabled = false; b.textContent = '등록';
        toast(err.network ? '인터넷 연결 후 다시 눌러주세요' : '등록 실패: ' + err.message, 3500);
      }
      break;
    }
    case 'cancel': {
      if (!confirm('등록을 취소할까요?')) return;
      try {
        const res = await api({ action: 'cancel', item: it }, 60000);
        if (!res.ok) throw new Error(res.error);
        it.status = 'proposed'; delete it.extId;
        markDirty(); renderResults(); toast('등록을 취소했어요');
      } catch (err) { toast(err.network ? '인터넷 연결 후 다시 눌러주세요' : '취소 실패: ' + err.message, 3500); }
      break;
    }
    case 'retryDoc': {
      b.disabled = true; b.innerHTML = '<span class="spinner"></span> 만드는 중';
      try {
        const res = await api({ action: 'retryDoc', item: it, transcript: memo.transcript }, 330000);
        if (!res.ok) throw new Error(res.error);
        Object.assign(it, res.item);
        markDirty(); renderResults();
      } catch (err) { b.disabled = false; b.textContent = '다시 만들기'; toast('실패: ' + err.message, 3500); }
      break;
    }
  }
});
async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(text);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했어요'); }
  catch (e) { toast('복사하지 못했어요'); }
}

/* ───────── 목록 화면 ───────── */
const listState = { nb: null, sec: null, q: '' };
async function allMemos() {
  const list = await DB.all('memos');
  if (memo && !list.some(m => m.id === memo.id) && !isEmpty(memo)) list.push(memo);
  return list.sort((a, b) => b.updated - a.updated);
}
function memoStatusHtml(m) {
  const items = (m.results && m.results.items) || [];
  const ev = items.filter(i => i.kind === 'event' && i.status === 'registered').length;
  const tk = items.filter(i => i.kind === 'task' && i.status === 'registered').length;
  const dc = items.filter(i => i.kind === 'doc' && i.status === 'done').length;
  let st = '<span class="st-draft">📝 미전송</span>';
  if (m.status === 'done') st = '<span class="st-done">✅ 처리완료</span>';
  if (m.status === 'queued' || m.status === 'sending') st = '<span class="st-queued">⏳ 전송 대기</span>';
  if (m.status === 'error') st = '<span class="st-error">⚠ 오류</span>';
  return st + (ev ? `<span>📅${ev}</span>` : '') + (tk ? `<span>✅${tk}</span>` : '') + (dc ? `<span>📄${dc}</span>` : '');
}
async function renderList() {
  const list = await allMemos();
  // 필기장 칩
  $('#nbChips').innerHTML = `<button class="chip ${!listState.nb ? 'on' : ''}" data-nb="">전체</button>` +
    notebooks.map(n => `<button class="chip ${listState.nb === n.name ? 'on' : ''}" data-nb="${esc(n.name)}">${esc(n.name)}</button>`).join('') +
    `<button class="chip add" data-add="nb">＋ 필기장</button>`;
  const nb = notebooks.find(n => n.name === listState.nb);
  $('#secChips').innerHTML = nb ? (`<button class="chip ${!listState.sec ? 'on' : ''}" data-sec="">전체</button>` +
    nb.sections.map(s => `<button class="chip ${listState.sec === s ? 'on' : ''}" data-sec="${esc(s)}">${esc(s)}</button>`).join('') +
    `<button class="chip add" data-add="sec">＋ 섹션</button>`) : '';
  const q = listState.q.trim().toLowerCase();
  const shown = list.filter(m => {
    if (q) {
      const hay = [m.title, m.transcript, typedTexts(m).join(' '), m.notebook, m.section].join(' ').toLowerCase();
      return hay.includes(q);
    }
    if (listState.nb && m.notebook !== listState.nb) return false;
    if (listState.sec && m.section !== listState.sec) return false;
    return true;
  });
  $('#memoList').innerHTML = shown.length ? shown.map(m => {
    const preview = (m.transcript || typedTexts(m).join(' ') || '').replace(/\s+/g, ' ').slice(0, 80);
    return `<button class="mcard" data-id="${esc(m.id)}">
      <div class="t"><span>${esc(m.title || '제목 없음')}</span><span class="d">${fmtDate(m.updated)}</span></div>
      <div class="p">${esc(preview || (m.strokes.length ? '손글씨 메모' : ''))}${q || !listState.nb ? ` · ${esc(m.notebook)} › ${esc(m.section)}` : ''}</div>
      <div class="s">${memoStatusHtml(m)}</div></button>`;
  }).join('') : `<div class="list-empty">${q ? '검색 결과가 없어요' : '아직 메모가 없어요'}</div>`;
}
$('#search').addEventListener('input', (e) => { listState.q = e.target.value; renderList(); });
$('#nbChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.add) {
    const name = (prompt('새 필기장 이름') || '').trim();
    if (name && !notebooks.some(n => n.name === name)) { notebooks.push({ name, sections: ['일반'] }); saveNotebooks(); listState.nb = name; listState.sec = null; }
  } else { listState.nb = b.dataset.nb || null; listState.sec = null; }
  renderList();
});
$('#secChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const nb = notebooks.find(n => n.name === listState.nb);
  if (b.dataset.add && nb) {
    const name = (prompt(`'${nb.name}'에 만들 섹션 이름`) || '').trim();
    if (name && !nb.sections.includes(name)) { nb.sections.push(name); saveNotebooks(); listState.sec = name; }
  } else listState.sec = b.dataset.sec || null;
  renderList();
});
$('#memoList').addEventListener('click', async (e) => {
  const b = e.target.closest('.mcard'); if (!b) return;
  const m = (memo && memo.id === b.dataset.id) ? memo : await DB.get('memos', b.dataset.id);
  if (!m) return;
  history.back();
  setTimeout(() => openMemo(m), 30);
});
$('#btnNewMemo').addEventListener('click', () => {
  const nb = listState.nb || '빠른 메모';
  const n = notebooks.find(x => x.name === nb);
  const sec = listState.sec || (n ? n.sections[0] : '메모');
  chooseTemplate((k) => { history.back(); setTimeout(() => createAndOpen(nb, sec, k), 30); }, true);
});

/* ───────── 처리 내역 ───────── */
let historyFilter = 'all';
async function renderHistory() {
  const list = await allMemos();
  const rows = [];
  list.forEach(m => ((m.results && m.results.items) || []).forEach(it => {
    const ok = (it.kind === 'event' || it.kind === 'task') ? it.status === 'registered' : (it.kind === 'doc' ? it.status === 'done' : it.kind === 'answer');
    if (!ok) return;
    if (historyFilter !== 'all' && it.kind !== historyFilter) return;
    rows.push({ m, it, t: it.registeredAt || (m.results && m.results.at) || m.updated });
  }));
  rows.sort((a, b) => b.t - a.t);
  const now = new Date(); const day = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime();
  const groups = { '이번 주': [], '지난 주': [], '그 이전': [] };
  rows.forEach(r => {
    if (r.t >= weekStart) groups['이번 주'].push(r);
    else if (r.t >= weekStart - 7 * 86400000) groups['지난 주'].push(r);
    else groups['그 이전'].push(r);
  });
  const icon = { event: '📅', task: '✅', doc: '📄', answer: '💬' };
  let html = '';
  for (const [g, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    html += `<div class="hgroup">${g}</div>`;
    html += arr.map(({ m, it }) => {
      let sub = '';
      if (it.kind === 'event') sub = `${fmtYmd(it.date)} ${it.allDay || !it.start ? '종일' : it.start} · ${it.calendar === 'school' ? '학교 일정' : '내 캘린더'}`;
      if (it.kind === 'task') sub = it.due ? `마감 ${fmtYmd(it.due)}` : '마감 없음';
      if (it.kind === 'doc') sub = it.folderName || '';
      if (it.kind === 'answer') sub = (it.text || '').slice(0, 40);
      return `<button class="hitem" data-id="${esc(m.id)}"><span class="ic">${icon[it.kind]}</span><span class="body"><div class="ti">${esc(it.name || it.title || it.fileName)}</div><div class="sub">${esc(sub)} · ${esc(m.title || '제목 없음')}</div></span><span class="go">메모 ›</span></button>`;
    }).join('');
  }
  $('#historyList').innerHTML = html || `<div class="list-empty">아직 처리한 내역이 없어요</div>`;
}
$('#historyTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  historyFilter = b.dataset.f;
  $$('#historyTabs button').forEach(x => x.classList.toggle('on', x === b));
  renderHistory();
});
$('#historyList').addEventListener('click', async (e) => {
  const b = e.target.closest('.hitem'); if (!b) return;
  const m = (memo && memo.id === b.dataset.id) ? memo : await DB.get('memos', b.dataset.id);
  if (!m) return;
  history.go(-2);
  setTimeout(() => openMemo(m), 60);
});

/* ───────── 설정 ───────── */
async function updateQueueInfo() {
  const q = await DB.all('outbox');
  const el2 = $('#queueInfo');
  if (el2) el2.textContent = q.length ? `보낼 항목 ${q.length}건이 기다리고 있어요.` : '기다리는 항목이 없어요.';
}
async function renderSettings() {
  $('#setUrl').value = settings.url;
  $('#setPw').value = settings.pw;
  $$('#inputModes input').forEach(r => { r.checked = r.value === (settings.input || 'auto'); });
  updateQueueInfo();
  const count = (await DB.all('memos')).length;
  $('#aboutInfo').textContent = `필기노트 v${APP_VERSION}\n저장된 메모 ${count}개 · 펜 감지: ${penSeen ? '예' : '아니오'}`;
}
$('#btnSaveConn').addEventListener('click', async () => {
  settings.url = $('#setUrl').value.trim();
  settings.pw = $('#setPw').value;
  saveSettings();
  const st = $('#connStatus');
  st.className = 'hint'; st.textContent = '연결 확인 중…';
  try {
    const res = await api({ action: 'ping' }, 30000);
    if (!res.ok) throw new Error(res.error);
    st.className = 'hint ok'; st.textContent = `✅ 연결됐어요 (서버 v${res.version})`;
    flush(); renderResults();
  } catch (err) {
    st.className = 'hint err'; st.textContent = '❌ ' + (err.network ? '서버에 닿지 않아요. 주소를 확인해주세요.' : err.message);
  }
});
$('#inputModes').addEventListener('change', (e) => { settings.input = e.target.value; saveSettings(); toast('입력 방식을 바꿨어요'); });
$('#btnFlush').addEventListener('click', () => { flush(); toast('보내는 중…'); });
$('#btnSyncAll').addEventListener('click', async () => {
  const list = await DB.all('memos');
  for (const m of list) if (!isEmpty(m)) await enqueue(m.id, 'sync');
  toast(`${list.length}개 메모를 드라이브에 저장할게요`);
});

/* ───────── 시작 ───────── */
$('#fileCamera').addEventListener('change', onFilePicked);
$('#fileAlbum').addEventListener('change', onFilePicked);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('#memoView').classList.contains('hidden')) layout(); if (pe.b) peLayout(); }, 120);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (memo && !isEmpty(memo)) { clearTimeout(saveTimer); saveMemo(memo).then(() => { if (memo.updated > (memo.syncedAt || 0)) enqueue(memo.id, 'sync'); }); }
  } else flush();
});

history.replaceState({ v: 'memo' }, '');
memo = null;
createAndOpen();
renderToolbar();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
setTimeout(flush, 1500);
