/* =============================================================
   Mono Planner - script.js
   개인용 주간/일간 To-Do 다이어리 웹앱
   Version: 1.1.0 | Data Version: 2
   저장: IndexedDB | 백업: JSON 파일 | PWA 지원

   ── 데이터 구조 ───────────────────────────────────────────────

   Week (IndexedDB 'weeks' store, keyPath: weekKey):
   {
     weekKey: "2026-W15",
     weeklyTodos: [ Todo, ... ],
     dailyTodos: { "2026-04-07": [ Todo, ... ] },
     weeklyNote: "",  weeklyNoteAt: null | "ISO",
     dailyNotes: {},  dailyNotesAt: {},
     drawings: {},
     createdAt, updatedAt
   }

   Todo:
   {
     id, text, completed, createdAt, updatedAt, completedAt,
     priority: "high"|"medium"|"low",
     tags: [], memo: "",
     linkedWeeklyTodoId: null | string,
     linkedMemoId: null | string,        ← NEW
     carriedOverFrom: null | {weekKey, id},
     carriedOverTo:   null | {weekKey, id},
     deletedAt: null
   }

   Memo (IndexedDB 'memos' store, keyPath: id):
   {
     id, linkedTodoId: null|string,
     type: "general"|"work"|"meeting"|"note",
     title: "", text: "",
     drawingData: null | "data:image/...",
     hasDrawing: boolean,
     createdAt, updatedAt,
     weekKey: string, date: null|string
   }

   AppMeta (IndexedDB 'meta' store, id = "app"):
   { id:"app", theme, lastBackupAt, lastRestoreAt, trash:[] }
   ─────────────────────────────────────────────────────────── */

'use strict';

/* ── 상수 ──────────────────────────────────────────────────── */
const APP_VERSION  = '1.1.0';
const DATA_VERSION = 2;
const DB_NAME      = 'mono-planner-db';
const DB_VER       = 3;
const TRASH_LIMIT  = 50;

/* ── 앱 상태 ────────────────────────────────────────────────── */
const S = {
  weekKey:      '',
  selectedDate: '',
  weeks:        {},
  memos:        {},     // id → Memo 캐시
  meta: {
    theme: 'light',
    lastBackupAt: null,
    lastRestoreAt: null,
    trash: []
  },
  filters: {
    query: ''
  },
  taskEdit: {
    type:   null,
    date:   null,
    id:     null
  },
  dailyTaskEdit: {
    weekKey: null,
    date:    null,
    id:      null
  },
  memoEdit: {
    id:    null,
    isNew: false
  },
  importPayload: null,
  importMode:    'overwrite',
  mobileTab:     'weekly',
  viewMode:      'weekly',   // 'weekly' | 'monthly'
  monthKey:      '',         // 'YYYY-MM'
  canvas: {
    tool: 'pen', color: 'auto', size: 3,
    drawing: false, lastX: 0, lastY: 0,
    ctx: null, el: null, dpr: 1
  },
  memoCanvas: {
    tool: 'pen', color: 'auto', size: 3,
    drawing: false, lastX: 0, lastY: 0,
    ctx: null, el: null, dpr: 1
  },
};

/* ── IndexedDB ────────────────────────────────────────────── */
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('weeks')) {
        db.createObjectStore('weeks', { keyPath: 'weekKey' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('memos')) {
        db.createObjectStore('memos', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/* ── 날짜 유틸 ──────────────────────────────────────────────── */

function fmtDate(d) { return d.toISOString().split('T')[0]; }
function todayStr()  {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function scheduleMidnightRefresh() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  const msUntil = nextMidnight.getTime() - now.getTime();
  setTimeout(() => {
    // 오늘 날짜가 바뀌면 주간이 바뀔 수도 있으므로 확인
    const newWeekKey = getWeekKey(new Date());
    if (S.weekKey !== newWeekKey) {
      S.weekKey = newWeekKey;
      S.selectedDate = todayStr();
      loadCurrentWeek().then(() => { renderAll(); renderDetailPanel(); });
    } else {
      renderDailyPanel();
      renderDashboard();
    }
    scheduleMidnightRefresh();
  }, msUntil);
}

function getWeekKey(date) {
  const d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wn = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;
}

function weekMonday(weekKey) {
  const [y, w] = weekKey.split('-W').map(Number);
  const jan4   = new Date(Date.UTC(y, 0, 4));
  const dow    = jan4.getUTCDay() || 7;
  const mon    = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - dow + 1 + (w - 1) * 7);
  return mon;
}

function weekDates(weekKey) {
  const mon = weekMonday(weekKey);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setUTCDate(mon.getUTCDate() + i);
    return fmtDate(d);
  });
}

function shiftWeek(weekKey, offset) {
  const mon = weekMonday(weekKey);
  mon.setUTCDate(mon.getUTCDate() + offset * 7);
  return getWeekKey(mon);
}

function fmtDateKo(dateStr) {
  const d    = new Date(dateStr + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]})`;
}

function fmtShort(iso) {
  if (!iso) return '-';
  const d  = new Date(iso);
  const mo = d.getMonth() + 1;
  const dy = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${dy} ${hh}:${mm}`;
}

function fmtLong(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fmtWeekLabel(weekKey) {
  const dates = weekDates(weekKey);
  const first = new Date(dates[0] + 'T00:00:00');
  const last  = new Date(dates[6] + 'T00:00:00');
  const wn    = weekKey.split('-W')[1];
  return `${weekKey.split('-W')[0]}-W${wn}  (${first.getMonth()+1}/${first.getDate()} ~ ${last.getMonth()+1}/${last.getDate()})`;
}

/* ── 월간 뷰 유틸 ───────────────────────────────────────────── */

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(monthKey, offset) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 달력 그리드용 42셀 반환 (Mon 시작, 앞뒤 달 포함)
function monthCalendarCells(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const first  = new Date(Date.UTC(y, m - 1, 1));
  const startDow = first.getUTCDay() || 7;  // 1=Mon … 7=Sun
  const start  = new Date(first);
  start.setUTCDate(first.getUTCDate() - (startDow - 1));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return {
      dateStr:  fmtDate(d),
      inMonth:  d.getUTCMonth() === m - 1,
      day:      d.getUTCDate(),
      dowIdx:   i % 7   // 0=Mon…6=Sun
    };
  });
}

async function loadMonthWeeks(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const first  = new Date(y, m - 1, 1);
  const last   = new Date(y, m, 0);
  let wk = getWeekKey(first);
  const limit = getWeekKey(last);
  let guard = 0;
  while (wk <= limit && guard++ < 10) {
    if (!S.weeks[wk]) {
      const data = await dbGet('weeks', wk);
      if (data) { S.weeks[wk] = data; await loadMemosForWeek(wk); }
    }
    wk = shiftWeek(wk, 1);
  }
}

/* ── 월간 뷰 렌더 ───────────────────────────────────────────── */

function renderMonthlyView() {
  const container = document.getElementById('view-monthly');
  const [y, m]    = S.monthKey.split('-').map(Number);
  const today     = todayStr();
  const curWeekSet = new Set(weekDates(S.weekKey));

  // 날짜별 할일 집계 (로드된 주차 기준)
  const schedules  = {};   // dateStr → [{ text, completed, color }, ...]
  const otherTasks = {};   // dateStr → [{ completed, color }, ...]
  for (const wd of Object.values(S.weeks)) {
    for (const [dateStr, todos] of Object.entries(wd.dailyTodos || {})) {
      const active = (todos || []).filter(t => !t.deletedAt);
      if (active.length === 0) continue;
      for (const t of active) {
        if (t.category === '일정') {
          if (!schedules[dateStr]) schedules[dateStr] = [];
          schedules[dateStr].push({ text: t.text, completed: t.completed, color: t.color || '' });
        } else {
          if (!otherTasks[dateStr]) otherTasks[dateStr] = [];
          otherTasks[dateStr].push({ completed: t.completed, color: t.color || '' });
        }
      }
    }
  }

  const DOW = ['월', '화', '수', '목', '금', '토', '일'];
  const cells = monthCalendarCells(S.monthKey);

  // 요일 헤더
  const dowHtml = DOW.map((d, i) => {
    const cls = i === 5 ? 'monthly-dow sat' : i === 6 ? 'monthly-dow sun' : 'monthly-dow';
    return `<div class="${cls}">${d}</div>`;
  }).join('');

  // 날짜 셀
  const cellsHtml = cells.map(({ dateStr, inMonth, day, dowIdx }) => {
    if (!inMonth) return `<div class="monthly-cell other-month"><div class="monthly-day-num">${day}</div></div>`;

    const isToday    = dateStr === today;
    const isCurWeek  = curWeekSet.has(dateStr);
    const others = otherTasks[dateStr] || [];
    const p = others.filter(t => !t.completed).length;
    const total = others.length;
    const isSat  = dowIdx === 5;
    const isSun  = dowIdx === 6;
    const wkKey  = getWeekKey(new Date(dateStr + 'T00:00:00'));

    let cls = 'monthly-cell';
    if (isToday)    cls += ' is-today';
    else if (isCurWeek) cls += ' is-cur-week';
    if (isSat) cls += ' sat';
    if (isSun) cls += ' sun';

    // [일정] 카테고리 항목 표시 (최대 3개)
    const schList = schedules[dateStr] || [];
    let schHtml = '';
    if (schList.length > 0) {
      const showSch = schList.slice(0, 3);
      schHtml = showSch.map(s => {
        const colorStyle = s.color && !s.completed ? ` style="background:${s.color}"` : '';
        return `<div class="monthly-event${s.completed ? ' done' : ''}"${colorStyle} title="${escHtml(s.text)}">${escHtml(s.text)}</div>`;
      }).join('');
      if (schList.length > 3) {
        schHtml += `<div class="monthly-event-more">+${schList.length - 3}개</div>`;
      }
    }

    // 기타 할일 점 표시 (최대 5개)
    let dotsHtml = '';
    if (total > 0) {
      const show = Math.min(total, 5);
      let dots = '';
      for (let i = 0; i < show; i++) {
        const t = others[i];
        const colorAttr = t.color ? ` style="background:${t.color}${t.completed ? ';opacity:0.4' : ''}"` : '';
        dots += `<span class="monthly-dot ${t.completed ? 'done' : 'pending'}"${colorAttr}></span>`;
      }
      dotsHtml = `<div class="monthly-dots">${dots}${total > 5 ? `<span class="monthly-dot-more">+${total - 5}</span>` : ''}</div>`;
    }

    // 월요일에만 주차 힌트 표시
    const weekHint = dowIdx === 0 ? `<span class="monthly-week-hint">W${wkKey.split('-W')[1]}</span>` : '';

    return `
      <div class="${cls}" data-date="${dateStr}" data-wk="${wkKey}">
        <div class="monthly-day-num">${day}</div>
        ${schHtml}
        ${dotsHtml}
        ${weekHint}
      </div>`;
  }).join('');

  container.innerHTML = `
    <nav class="monthly-nav">
      <button class="icon-btn" id="monthly-prev" aria-label="이전 달">&#8249;</button>
      <span class="monthly-title">${y}년 ${m}월</span>
      <button class="icon-btn" id="monthly-next" aria-label="다음 달">&#8250;</button>
    </nav>
    <div class="monthly-grid">
      ${dowHtml}
      ${cellsHtml}
    </div>`;

  // 이전/다음 달 버튼
  container.querySelector('#monthly-prev').addEventListener('click', async () => {
    S.monthKey = shiftMonth(S.monthKey, -1);
    renderWeekLabel();
    await loadMonthWeeks(S.monthKey);
    renderMonthlyView();
  });
  container.querySelector('#monthly-next').addEventListener('click', async () => {
    S.monthKey = shiftMonth(S.monthKey, 1);
    renderWeekLabel();
    await loadMonthWeeks(S.monthKey);
    renderMonthlyView();
  });

  // 날짜 셀 클릭 → 해당 주 주간 뷰로 이동
  container.querySelectorAll('.monthly-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', async () => {
      const dateStr = cell.dataset.date;
      const wk      = cell.dataset.wk;
      S.weekKey     = wk;
      S.selectedDate = dateStr;
      await loadCurrentWeek();
      await switchView('weekly');
    });
  });
}

/* ── 뷰 전환 ────────────────────────────────────────────────── */

async function switchView(mode) {
  S.viewMode = mode;
  const isMonthly = mode === 'monthly';

  document.getElementById('view-monthly').classList.toggle('hidden', !isMonthly);
  document.getElementById('main-layout').classList.toggle('hidden', isMonthly);
  document.getElementById('bottom-panels').classList.toggle('hidden', isMonthly);

  const btn = document.getElementById('btn-view-monthly');
  btn.textContent = isMonthly ? '주간' : '월간';
  btn.classList.toggle('active-view', isMonthly);

  if (isMonthly) {
    if (!S.monthKey) S.monthKey = getMonthKey(new Date());
    await loadMonthWeeks(S.monthKey);
    renderWeekLabel();
    renderMonthlyView();
  } else {
    renderAll();
    renderDetailPanel();
  }
}

/* ── 데이터 헬퍼 ────────────────────────────────────────────── */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function makeTask(overrides = {}) {
  return {
    id:                 uid(),
    text:               '',
    completed:          false,
    createdAt:          new Date().toISOString(),
    updatedAt:          new Date().toISOString(),
    completedAt:        null,
    category:           '',
    requester:          '',
    tags:               [],
    memo:               '',
    linkedWeeklyTodoId: null,
    linkedMemoId:       null,
    carriedOverFrom:    null,
    carriedOverTo:      null,
    deletedAt:          null,
    color:              '',
    ...overrides
  };
}

function makeLinkedMemo(overrides = {}) {
  return {
    id:          uid(),
    linkedTodoId: null,
    type:        'general',
    title:       '',
    text:        '',
    drawingData: null,
    hasDrawing:  false,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    weekKey:     S.weekKey,
    date:        null,
    ...overrides
  };
}

function makeWeekData(weekKey) {
  return {
    weekKey,
    weeklyTodos:  [],
    dailyTodos:   {},
    weeklyNote:   '',
    weeklyNoteAt: null,
    dailyNotes:   {},
    dailyNotesAt: {},
    drawings:     {},
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString()
  };
}

function getWeek(weekKey) {
  if (!S.weeks[weekKey]) S.weeks[weekKey] = makeWeekData(weekKey);
  return S.weeks[weekKey];
}

async function saveWeek(weekData) {
  weekData.updatedAt = new Date().toISOString();
  S.weeks[weekData.weekKey] = weekData;
  await dbPut('weeks', weekData);
}

async function saveMeta() {
  await dbPut('meta', { id: 'app', ...S.meta });
}

/* ── 메모 CRUD ──────────────────────────────────────────────── */

async function saveMemo(memo) {
  memo.updatedAt = new Date().toISOString();
  S.memos[memo.id] = memo;
  await dbPut('memos', memo);
}

async function getMemo(id) {
  if (S.memos[id]) return S.memos[id];
  const m = await dbGet('memos', id);
  if (m) S.memos[m.id] = m;
  return m || null;
}

async function deleteMemoById(id) {
  delete S.memos[id];
  await dbDelete('memos', id);
}

async function loadMemosForWeek(weekKey) {
  const all = await dbGetAll('memos');
  all.filter(m => m.weekKey === weekKey).forEach(m => { S.memos[m.id] = m; });
}

function memoTypeLabel(type) {
  const map = { general: '일반 메모', work: '업무 메모', meeting: '회의록', note: '필기 노트' };
  return map[type] || '메모';
}

/* ── 필터/정렬 ──────────────────────────────────────────────── */

function applyFilters(todos) {
  let list = todos.filter(t => !t.deletedAt);
  if (S.filters.query) {
    const q = S.filters.query.toLowerCase();
    list = list.filter(t =>
      t.text.toLowerCase().includes(q) ||
      (t.memo || '').toLowerCase().includes(q) ||
      t.tags.some(tag => tag.toLowerCase().includes(q))
    );
  }
  return list;
}


/* ── 통계 계산 ──────────────────────────────────────────────── */

function calcStats(weekKey) {
  const wd    = getWeek(weekKey);
  const today = todayStr();

  const todayTodos = (wd.dailyTodos[today] || []).filter(t => !t.deletedAt);
  const todayDone  = todayTodos.filter(t => t.completed).length;
  const todayTotal = todayTodos.length;

  const wkTodos      = wd.weeklyTodos.filter(t => !t.deletedAt);
  const wkIncomplete = wkTodos.filter(t => !t.completed).length;

  let dyIncomplete = 0;
  Object.values(wd.dailyTodos).forEach(arr => {
    arr.filter(t => !t.deletedAt).forEach(t => { if (!t.completed) dyIncomplete++; });
  });

  const allTodos  = [...wkTodos, ...Object.values(wd.dailyTodos).flat().filter(t => !t.deletedAt)];
  const weekTotal = allTodos.length;
  const weekDone  = allTodos.filter(t => t.completed).length;
  const pct       = weekTotal === 0 ? 0 : Math.round(weekDone / weekTotal * 100);
  const coCount   = wkIncomplete + dyIncomplete;

  return { todayDone, todayTotal, weekDone, weekTotal, pct, coCount };
}

/* ── 렌더 ───────────────────────────────────────────────────── */

function renderAll() {
  renderWeekLabel();
  renderDashboard();
  renderWeeklyPanel();
  renderDailyPanel();
  renderDetailPanel();
}

function renderWeekLabel() {
  if (S.viewMode === 'monthly' && S.monthKey) {
    const [y, m] = S.monthKey.split('-').map(Number);
    document.getElementById('current-week-label').textContent = `${y}년 ${m}월`;
  } else {
    document.getElementById('current-week-label').textContent = fmtWeekLabel(S.weekKey);
  }
}

function renderDashboard() {
  const { todayDone, todayTotal, weekDone, weekTotal, pct, coCount } = calcStats(S.weekKey);

  const now  = new Date();
  const DOW  = ['일', '월', '화', '수', '목', '금', '토'];
  document.getElementById('w-today-date').textContent = `${now.getMonth() + 1}/${now.getDate()}`;
  document.getElementById('w-today-dow').textContent  = DOW[now.getDay()] + '요일';

  document.getElementById('w-today-done').textContent  = `${todayDone} / ${todayTotal}`;
  document.getElementById('w-week-done').textContent   = `${weekDone} / ${weekTotal}`;
  document.getElementById('w-progress-fill').style.width = pct + '%';
  document.getElementById('w-co-num').textContent      = coCount;
  document.getElementById('w-backup-time').textContent = fmtShort(S.meta.lastBackupAt);
}


/* ── 주간 패널 렌더 ─── */
function renderWeeklyPanel() {
  const wd       = getWeek(S.weekKey);
  const list     = document.getElementById('weekly-todo-list');
  const filtered = applyFilters(wd.weeklyTodos);

  if (filtered.length === 0) {
    list.innerHTML = `<p class="empty-msg">주간 업무가 없습니다. 위 "+ 추가" 버튼을 눌러 추가하세요.</p>`;
  } else {
    list.innerHTML = '';
    filtered.forEach(task => list.appendChild(makeTodoEl(task, 'weekly', S.weekKey, null)));
  }

  const noteEl = document.getElementById('weekly-note');
  noteEl.value = wd.weeklyNote || '';
  document.getElementById('weekly-note-time').textContent =
    wd.weeklyNoteAt ? '저장: ' + fmtShort(wd.weeklyNoteAt) : '';
}

/* ── 일간 패널 렌더 ─── */
function renderDailyPanel() {
  const container = document.getElementById('daily-container');
  const dates     = weekDates(S.weekKey);
  const today     = todayStr();

  document.getElementById('daily-week-range').textContent =
    `${fmtDateKo(dates[0])} ~ ${fmtDateKo(dates[6])}`;

  container.innerHTML = '';
  dates.forEach(dateStr => {
    const wd             = getWeek(S.weekKey);
    const todos          = wd.dailyTodos[dateStr] || [];
    const filtered       = applyFilters(todos);
    const incompleteCount = todos.filter(t => !t.deletedAt && !t.completed).length;
    const isToday        = dateStr === today;
    const isSelected     = dateStr === S.selectedDate;

    const card   = document.createElement('div');
    card.className = `day-card${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`;
    card.dataset.date = dateStr;

    const header = document.createElement('div');
    header.className = 'day-card-header';
    header.innerHTML = `
      <span class="day-label">${fmtDateKo(dateStr)}</span>
      <span class="day-count">${incompleteCount > 0 ? incompleteCount + '개 미완료' : todos.filter(t=>!t.deletedAt).length > 0 ? '완료' : '없음'}</span>
      <button class="day-add-btn" data-date="${dateStr}">+ 추가</button>
    `;

    const body = document.createElement('div');
    body.className = 'day-card-body';

    if (filtered.length === 0) {
      body.innerHTML = `<p class="day-empty">업무 없음</p>`;
    } else {
      filtered.forEach(task => body.appendChild(makeTodoEl(task, 'daily', S.weekKey, dateStr)));
    }

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    header.addEventListener('click', (e) => {
      if (e.target.closest('.day-add-btn')) return;
      selectDate(dateStr);
    });

    header.querySelector('.day-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openDailyTaskModal(S.weekKey, dateStr, null);
    });
  });
}

/* ── 상세 패널 렌더 ─── */
function renderDetailPanel() {
  // ── 메모 뷰 모드 ──
  if (_panelMode === 'memo' && _panelMemoId) {
    _renderMemoPanelView();
    return;
  }

  // ── 날짜 뷰 모드 ──
  _setDateViewVisible(true);

  const heading  = document.getElementById('detail-heading');
  const noteEl   = document.getElementById('daily-note');
  const noteTime = document.getElementById('daily-note-time');

  if (!S.selectedDate) {
    heading.textContent  = '날짜를 선택하세요';
    noteEl.disabled      = true;
    noteEl.value         = '';
    noteTime.textContent = '';
    _renderTaskMemoSection();
    return;
  }

  const wd = getWeek(S.weekKey);
  heading.textContent = fmtDateKo(S.selectedDate) + (S.selectedDate === todayStr() ? ' (오늘)' : '');
  noteEl.disabled = false;
  noteEl.value    = wd.dailyNotes[S.selectedDate] || '';
  const noteAt    = wd.dailyNotesAt[S.selectedDate];
  noteTime.textContent = noteAt ? '저장: ' + fmtShort(noteAt) : '';

  _renderTaskMemoSection();
}

/** 날짜뷰 요소들 표시/숨김 */
function _setDateViewVisible(show) {
  const els = ['detail-body'];
  els.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
  const mpv = document.getElementById('memo-panel-view');
  if (mpv) mpv.style.display = show ? 'none' : 'block';
}

/** 메모 내용을 우측 패널에 직접 표시 */
async function _renderMemoPanelView() {
  const memo = S.memos[_panelMemoId] || await getMemo(_panelMemoId);
  if (!memo) return;

  // 날짜뷰 숨기기
  _setDateViewVisible(false);

  const heading = document.getElementById('detail-heading');
  const panel   = document.getElementById('panel-detail');

  // 메모 뷰 컨테이너 생성 또는 재사용
  let mpv = document.getElementById('memo-panel-view');
  if (!mpv) {
    mpv = document.createElement('div');
    mpv.id = 'memo-panel-view';
    mpv.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0';
    panel.appendChild(mpv);
  }
  mpv.style.display = 'flex';

  const typeColors = {
    general: { bg:'var(--bg3)',  color:'var(--text2)',        border:'var(--border2)' },
    work:    { bg:'rgba(176,120,32,0.1)', color:'var(--c-medium)', border:'rgba(176,120,32,0.3)' },
    meeting: { bg:'rgba(85,102,170,0.1)',color:'var(--c-carryover)',border:'rgba(85,102,170,0.3)' },
    note:    { bg:'rgba(46,122,62,0.1)', color:'var(--c-low)',  border:'rgba(46,122,62,0.3)' }
  };
  const tc = typeColors[memo.type] || typeColors.general;

  // 연결된 업무 찾기
  let linkedTaskText = '';
  if (memo.linkedTodoId) {
    const wd = getWeek(memo.weekKey || S.weekKey);
    const all = [...wd.weeklyTodos, ...Object.values(wd.dailyTodos).flat()];
    const lt  = all.find(t => t.id === memo.linkedTodoId);
    if (lt) linkedTaskText = lt.text;
  }

  heading.textContent = memo.title || memoTypeLabel(memo.type);

  mpv.innerHTML = `
    <div style="padding:0.5rem 1rem 0;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;flex-shrink:0">
      <span id="mpv-type-badge" style="font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:4px;border:1px solid ${tc.border};background:${tc.bg};color:${tc.color}">${memoTypeLabel(memo.type)}</span>
      ${linkedTaskText ? `<span style="font-size:0.78rem;color:var(--text3)">↳ ${escHtml(linkedTaskText)}</span>` : ''}
      <button id="mpv-back-btn" style="margin-left:auto;font-size:0.78rem;padding:0.2rem 0.6rem;border-radius:var(--radius);background:var(--bg3);color:var(--text2);border:1px solid var(--border);cursor:pointer">← 날짜 보기</button>
    </div>
    <div style="padding:0.4rem 1rem 0;flex-shrink:0">
      <input id="mpv-title" type="text" value="${escHtml(memo.title || '')}" placeholder="메모 제목..." style="font-size:0.95rem;font-weight:600;border:none;border-bottom:1.5px solid transparent;border-radius:0;background:transparent;padding:0.2rem 0;width:100%;transition:border-color 0.15s">
    </div>
    <div style="flex-shrink:0;border-top:1px solid var(--border);padding:0.3rem 0.75rem;display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap;background:var(--bg2)">
      <button class="tool-btn" id="mpv-newline" title="줄바꿈 삽입">↵ 줄바꿈</button>
      <button class="tool-btn" id="mpv-backspace" title="한 글자 지우기">⌫ 지우기</button>
      <span style="width:1px;height:16px;background:var(--border);margin:0 2px;flex-shrink:0"></span>
      <span style="font-size:0.72rem;color:var(--text3);flex-shrink:0">글자색</span>
      <button class="mpv-fmt-btn" data-action="color" data-value="#111111" style="color:#111111;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;cursor:pointer;line-height:22px;text-align:center" title="검정">A</button>
      <button class="mpv-fmt-btn" data-action="color" data-value="#cc3333" style="color:#cc3333;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;cursor:pointer;line-height:22px;text-align:center" title="빨강">A</button>
      <button class="mpv-fmt-btn" data-action="color" data-value="#3355cc" style="color:#3355cc;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;cursor:pointer;line-height:22px;text-align:center" title="파랑">A</button>
      <button class="mpv-fmt-btn" data-action="color" data-value="#339944" style="color:#339944;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;cursor:pointer;line-height:22px;text-align:center" title="초록">A</button>
      <button class="mpv-fmt-btn" data-action="color" data-value="#888888" style="color:#888888;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;cursor:pointer;line-height:22px;text-align:center" title="회색">A</button>
      <span style="width:1px;height:16px;background:var(--border);margin:0 2px;flex-shrink:0"></span>
      <span style="font-size:0.72rem;color:var(--text3);flex-shrink:0">형광펜</span>
      <button class="mpv-fmt-btn" data-action="highlight" data-value="#ffff00" style="background:#ffff00;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;cursor:pointer" title="노랑"></button>
      <button class="mpv-fmt-btn" data-action="highlight" data-value="#90ee90" style="background:#90ee90;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;cursor:pointer" title="연두"></button>
      <button class="mpv-fmt-btn" data-action="highlight" data-value="#87ceeb" style="background:#87ceeb;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;cursor:pointer" title="하늘"></button>
      <button class="mpv-fmt-btn" data-action="highlight" data-value="#ffb6c1" style="background:#ffb6c1;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;cursor:pointer" title="분홍"></button>
      <button class="mpv-fmt-btn" data-action="highlight" data-value="transparent" style="background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;cursor:pointer;font-size:0.65rem;line-height:22px;text-align:center" title="형광펜 지우기">✕</button>
    </div>
    <div id="mpv-text" contenteditable="true" spellcheck="false" style="flex:1;min-height:120px;border:none;border-top:1px solid var(--border);padding:0.85rem 1rem;font-size:0.95rem;line-height:1.7;background:var(--bg);font-family:inherit;color:var(--text);outline:none;overflow-y:auto;word-break:break-word"></div>
    ${memo.hasDrawing ? `
    <div id="mpv-drawing-wrap" style="flex-shrink:0;border-top:1px solid var(--border);padding:0.6rem 1rem 0.75rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;flex-wrap:wrap;gap:0.3rem">
        <span style="font-size:0.8rem;font-weight:600;color:var(--text2)">필기</span>
        <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
          <button class="tool-btn active" id="mpv-pen">펜</button>
          <button class="tool-btn" id="mpv-eraser">지우개</button>
          <select id="mpv-color" style="font-size:0.78rem;padding:0.25rem 0.4rem;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius)">
            <option value="auto">자동</option><option value="#111111">검정</option>
            <option value="#666666">회색</option><option value="#ffffff">흰색</option>
            <option value="#cc3333">빨강</option><option value="#3355cc">파랑</option><option value="#339944">초록</option>
          </select>
          <select id="mpv-size" style="font-size:0.78rem;padding:0.25rem 0.4rem;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius)">
            <option value="1.5">얇게</option><option value="3" selected>보통</option>
            <option value="6">굵게</option><option value="12">아주 굵게</option>
          </select>
          <button class="tool-btn tool-btn-danger" id="mpv-clear">전체 지우기</button>
        </div>
      </div>
      <div id="mpv-canvas-wrap" style="position:relative;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);min-height:200px">
        <canvas id="mpv-canvas" style="display:block;width:100%;height:100%;touch-action:none;cursor:crosshair" aria-label="메모 필기"></canvas>
      </div>
    </div>` : ''}
    <div style="flex-shrink:0;padding:0.5rem 1rem;border-top:1px solid var(--border);display:flex;align-items:center;gap:0.5rem;background:var(--bg)">
      <button id="mpv-save" class="btn-primary">저장</button>
      <span id="mpv-save-time" style="font-size:0.75rem;color:var(--text3)">${memo.updatedAt ? '저장: ' + fmtShort(memo.updatedAt) : ''}</span>
    </div>
  `;

  // contenteditable 텍스트 내용 설정 (HTML 또는 plain text)
  const mpvTextEl = document.getElementById('mpv-text');
  if (memo.text) {
    const hasHtml = /<[a-z]/i.test(memo.text);
    mpvTextEl.innerHTML = hasHtml
      ? memo.text
      : memo.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  }

  // 이벤트 연결
  document.getElementById('mpv-back-btn').addEventListener('click', () => {
    _panelMode = 'date'; _panelMemoId = null;
    renderDetailPanel();
  });

  document.getElementById('mpv-title').addEventListener('focus', e => {
    e.target.style.borderBottomColor = 'var(--accent2)';
  });
  document.getElementById('mpv-title').addEventListener('blur', e => {
    e.target.style.borderBottomColor = 'transparent';
  });

  document.getElementById('mpv-save').addEventListener('click', () => _saveMemoPanel());

  // 자동 저장 (debounce)
  document.getElementById('mpv-text').addEventListener('input', () => {
    debounceNote('memo-panel-' + _panelMemoId, () => _saveMemoPanel(true), 800);
  });
  document.getElementById('mpv-title').addEventListener('input', () => {
    debounceNote('memo-panel-title-' + _panelMemoId, () => _saveMemoPanel(true), 800);
  });

  // 줄바꿈 / 지우기 버튼 (mousedown으로 선택 유지)
  document.getElementById('mpv-newline').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('mpv-newline').addEventListener('click', () => {
    document.getElementById('mpv-text').focus();
    document.execCommand('insertLineBreak');
  });
  document.getElementById('mpv-backspace').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('mpv-backspace').addEventListener('click', () => {
    document.getElementById('mpv-text').focus();
    document.execCommand('delete');
  });

  // 글자색 / 형광펜 버튼
  document.querySelectorAll('.mpv-fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // 선택 영역 유지
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const value  = btn.dataset.value;
      document.getElementById('mpv-text').focus();
      document.execCommand('styleWithCSS', false, true);
      if (action === 'color') {
        document.execCommand('foreColor', false, value);
      } else if (action === 'highlight') {
        if (value === 'transparent') {
          document.execCommand('hiliteColor', false, 'transparent');
        } else {
          document.execCommand('hiliteColor', false, value);
        }
      }
    });
  });

  // 필기 캔버스 초기화
  if (memo.hasDrawing) {
    setTimeout(() => _initMpvCanvas(memo), 60);

    document.getElementById('mpv-pen').addEventListener('click', () => {
      S.memoCanvas.tool = 'pen';
      document.getElementById('mpv-pen').classList.add('active');
      document.getElementById('mpv-eraser').classList.remove('active');
      document.getElementById('mpv-canvas').style.cursor = 'crosshair';
    });
    document.getElementById('mpv-eraser').addEventListener('click', () => {
      S.memoCanvas.tool = 'eraser';
      document.getElementById('mpv-eraser').classList.add('active');
      document.getElementById('mpv-pen').classList.remove('active');
      document.getElementById('mpv-canvas').style.cursor = 'cell';
    });
    document.getElementById('mpv-color').addEventListener('change', e => { S.memoCanvas.color = e.target.value; });
    document.getElementById('mpv-size').addEventListener('change', e => { S.memoCanvas.size = parseFloat(e.target.value); });
    document.getElementById('mpv-clear').addEventListener('click', () => {
      showConfirm('전체 지우기', '메모 필기를 모두 지울까요?').then(ok => { if (ok) clearMpvCanvas(); });
    });
  }
}

function _initMpvCanvas(memo) {
  const el = document.getElementById('mpv-canvas');
  if (!el) return;
  const wrap = document.getElementById('mpv-canvas-wrap');
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);
  const rect = wrap.getBoundingClientRect();
  const w    = Math.max(rect.width, 200);
  const h    = Math.max(wrap.offsetHeight || 200, 200);

  el.width  = w * dpr;
  el.height = h * dpr;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';

  const ctx = el.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // 저장된 필기 로드
  if (memo.drawingData) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, w, h);
    img.src = memo.drawingData;
  }

  // Pointer 이벤트
  let drawing = false, lastX = 0, lastY = 0;
  function getP(e) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function applyStyle() {
    const { tool, color, size } = S.memoCanvas;
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth  = size * 5;
      ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth   = size;
      const auto = document.documentElement.dataset.theme === 'dark' ? '#e8e8e8' : '#111111';
      ctx.strokeStyle = color === 'auto' ? auto : color;
      ctx.fillStyle   = ctx.strokeStyle;
    }
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    drawing = true; const p = getP(e); lastX = p.x; lastY = p.y;
    applyStyle(); ctx.beginPath(); ctx.arc(p.x, p.y, S.memoCanvas.size/2, 0, Math.PI*2); ctx.fill();
  }, { passive: false });
  el.addEventListener('pointermove', e => {
    if (!drawing) return; e.preventDefault();
    const p = getP(e);
    applyStyle(); ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
  }, { passive: false });
  el.addEventListener('pointerup', () => {
    if (!drawing) return; drawing = false;
    _saveMpvCanvas();
  });
  el.addEventListener('pointercancel', () => { drawing = false; });
}

function clearMpvCanvas() {
  const el = document.getElementById('mpv-canvas');
  if (!el) return;
  const ctx = el.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, el.width, el.height);
  _saveMpvCanvas();
}

async function _saveMpvCanvas() {
  const memo = S.memos[_panelMemoId] || await getMemo(_panelMemoId);
  if (!memo) return;
  const el = document.getElementById('mpv-canvas');
  if (!el) return;
  memo.drawingData = el.toDataURL('image/png');
  await saveMemo(memo);
}

async function _saveMemoPanel(silent = false) {
  const memo = S.memos[_panelMemoId] || await getMemo(_panelMemoId);
  if (!memo) return;
  const titleEl = document.getElementById('mpv-title');
  const textEl  = document.getElementById('mpv-text');
  if (titleEl) memo.title = titleEl.value.trim();
  if (textEl)  memo.text  = textEl.innerHTML || textEl.value || '';
  await saveMemo(memo);
  const timeEl = document.getElementById('mpv-save-time');
  if (timeEl) timeEl.textContent = '저장: ' + fmtShort(memo.updatedAt);
  // 헤더 제목 업데이트
  document.getElementById('detail-heading').textContent = memo.title || memoTypeLabel(memo.type);
  if (!silent) showToast('메모가 저장되었습니다.');
}

function _renderTaskMemoSection() {
  const detailBody = document.getElementById('detail-body');
  if (!detailBody) return;

  let section = document.getElementById('selected-task-memo-section');

  if (!_selectedTask) {
    if (section) section.style.display = 'none';
    return;
  }

  if (!section) {
    section = document.createElement('div');
    section.id = 'selected-task-memo-section';
    section.style.cssText = [
      'padding:0.65rem 1rem',
      'border-bottom:1px solid var(--border)',
      'background:var(--bg2)',
      'flex-shrink:0'
    ].join(';');
    detailBody.prepend(section);
  }

  const priColor = { high: 'var(--c-high)', medium: 'var(--c-medium)', low: 'var(--c-low)' };
  const priLabel = priorityLabel(_selectedTask.priority);
  const tags = (_selectedTask.tags || []).map(t =>
    `<span style="font-size:0.7rem;background:var(--bg3);color:var(--text3);border-radius:8px;padding:1px 6px">${escHtml(t)}</span>`
  ).join(' ');
  const memoHtml = _selectedTask.memo
    ? `<div style="font-size:0.85rem;color:var(--text2);white-space:pre-wrap;word-break:break-word;line-height:1.6;margin-top:0.4rem">${escHtml(_selectedTask.memo)}</div>`
    : `<div style="font-size:0.8rem;color:var(--text3);margin-top:0.3rem;font-style:italic">메모 없음</div>`;

  section.style.display = 'block';
  section.innerHTML = `
    <div style="font-size:0.7rem;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.4rem">선택된 업무</div>
    <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
      <span style="width:8px;height:8px;border-radius:50%;background:${priColor[_selectedTask.priority]};flex-shrink:0;display:inline-block" title="${priLabel}"></span>
      <span style="font-size:0.88rem;font-weight:600;color:var(--text)">${escHtml(_selectedTask.text)}</span>
      ${tags}
    </div>
    ${memoHtml}
  `;
}

/* ── Todo 요소 생성 ─── */
function makeTodoEl(task, type, weekKey, date) {
  const item = document.createElement('div');
  item.className = `todo-item${task.completed ? ' completed' : ''}`;
  item.dataset.id = task.id;
  if (task.color) {
    item.style.background = hexToRgba(task.color, 0.12);
    item.style.borderLeft = `3px solid ${task.color}`;
  }

  const priorityDot = `<span class="priority-dot ${task.priority}" title="${priorityLabel(task.priority)}"></span>`;
  const categoryBadge = task.category
    ? `<span class="category-badge">[${escHtml(task.category)}]</span>` : '';
  const tags = task.tags.map(t => `<span class="tag-badge">${escHtml(t)}</span>`).join('');
  const coBadge = task.carriedOverFrom
    ? `<span class="carryover-badge" title="이월된 항목">이월</span>` : '';
  const linkedBadge = task.linkedWeeklyTodoId
    ? `<span class="linked-badge">주간연결</span>` : '';
  const memoPreview = task.memo
    ? `<div class="todo-memo-preview" title="${escHtml(task.memo)}">${escHtml(task.memo.slice(0, 40))}${task.memo.length > 40 ? '…' : ''}</div>` : '';

  // daily: 편집 버튼 없음 / weekly: 편집 버튼 유지
  const editBtn = type === 'daily'
    ? ''
    : `<button class="todo-action-btn edit" title="편집">✎</button>`;

  item.innerHTML = `
    <div class="todo-cb" role="checkbox" aria-checked="${task.completed}" tabindex="0" title="${task.completed ? '완료 취소' : '완료 표시'}"></div>
    <div class="todo-main">
      <div class="todo-text">${categoryBadge}${escHtml(task.text)}</div>
      <div class="todo-meta">
        ${priorityDot}${tags}${coBadge}${linkedBadge}
      </div>
      ${memoPreview}
    </div>
    <div class="todo-actions">
      ${editBtn}
      <button class="todo-action-btn delete" title="삭제">✕</button>
    </div>
  `;

  const cb = item.querySelector('.todo-cb');
  cb.addEventListener('click', () => toggleTask(type, weekKey, date, task.id));
  cb.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') toggleTask(type, weekKey, date, task.id); });

  if (type === 'weekly') {
    item.querySelector('.edit').addEventListener('click', e => {
      e.stopPropagation();
      openTaskModal(type, weekKey, date, task.id);
    });
  }

  item.querySelector('.delete').addEventListener('click', e => {
    e.stopPropagation();
    confirmDeleteTask(type, weekKey, date, task.id, task.text);
  });

  item.querySelector('.todo-main').addEventListener('click', () => {
    if (type === 'daily') {
      // 연결 메모가 있으면 메모 뷰, 없으면 날짜 뷰
      if (task.linkedMemoId) {
        showMemoInPanel(task.linkedMemoId);
      } else {
        _selectedTask = task;
        if (S.selectedDate !== date) {
          selectDate(date, task);
        } else {
          _renderTaskMemoSection();
        }
      }
    } else {
      openTaskModal(type, weekKey, date, task.id);
    }
  });

  return item;
}

function priorityLabel(p) {
  return p === 'high' ? '높음' : p === 'low' ? '낮음' : '보통';
}

/* ── 날짜 선택 / 패널 모드 ─── */
let _selectedTask = null;
let _panelMode    = 'date';   // 'date' | 'memo'
let _panelMemoId  = null;

function selectDate(dateStr, task = null) {
  S.selectedDate = dateStr;
  _selectedTask  = task;
  _panelMode     = 'date';
  _panelMemoId   = null;
  renderDailyPanel();
  renderDetailPanel();
  if (window.innerWidth <= 900) switchMobileTab('detail');
}

async function showMemoInPanel(memoId) {
  const memo = await getMemo(memoId);
  if (!memo) { showToast('메모를 불러올 수 없습니다.'); return; }
  _panelMode   = 'memo';
  _panelMemoId = memoId;
  renderDetailPanel();
  if (window.innerWidth <= 900) switchMobileTab('detail');
}

/* ── TASK CRUD ────────────────────────────────────────────── */

async function toggleTask(type, weekKey, date, id) {
  const wd   = getWeek(weekKey);
  const list = type === 'weekly' ? wd.weeklyTodos : (wd.dailyTodos[date] || []);
  const task = list.find(t => t.id === id);
  if (!task) return;
  task.completed   = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  task.updatedAt   = new Date().toISOString();
  await saveWeek(wd);
  renderAll();
}

async function saveTask(type, weekKey, date, taskData, isNew) {
  const wd = getWeek(weekKey);
  if (type === 'weekly') {
    if (isNew) { wd.weeklyTodos.push(taskData); }
    else {
      const idx = wd.weeklyTodos.findIndex(t => t.id === taskData.id);
      if (idx !== -1) wd.weeklyTodos[idx] = taskData;
    }
  } else {
    if (!wd.dailyTodos[date]) wd.dailyTodos[date] = [];
    if (isNew) { wd.dailyTodos[date].push(taskData); }
    else {
      const idx = wd.dailyTodos[date].findIndex(t => t.id === taskData.id);
      if (idx !== -1) wd.dailyTodos[date][idx] = taskData;
    }
  }
  await saveWeek(wd);
  renderAll();
}

function confirmDeleteTask(type, weekKey, date, id, text) {
  // 연결 메모 여부 확인
  const wd   = getWeek(weekKey);
  const list = type === 'weekly' ? wd.weeklyTodos : (wd.dailyTodos[date] || []);
  const task = list.find(t => t.id === id);
  const hasLinkedMemo = !!(task && task.linkedMemoId && S.memos[task.linkedMemoId]);

  const confirmMsg = hasLinkedMemo
    ? `"${text}" 항목을 삭제할까요?\n⚠️ 연결된 메모도 함께 삭제됩니다.`
    : `"${text}" 항목을 삭제할까요?\n(최근 삭제 항목에서 복원할 수 있습니다.)`;

  showConfirm('업무 삭제', confirmMsg)
    .then(ok => { if (ok) deleteTask(type, weekKey, date, id); });
}

async function deleteTask(type, weekKey, date, id) {
  const wd   = getWeek(weekKey);
  let task   = null;

  if (type === 'weekly') {
    const idx = wd.weeklyTodos.findIndex(t => t.id === id);
    if (idx === -1) return;
    task = wd.weeklyTodos.splice(idx, 1)[0];
  } else {
    const arr = wd.dailyTodos[date] || [];
    const idx = arr.findIndex(t => t.id === id);
    if (idx === -1) return;
    task = arr.splice(idx, 1)[0];
  }

  await saveWeek(wd);

  // 연결된 메모 삭제
  if (task.linkedMemoId) {
    await deleteMemoById(task.linkedMemoId);
  }

  S.meta.trash.unshift({
    id: uid(), task, taskType: type,
    weekKey, date: date || null,
    deletedAt: new Date().toISOString()
  });
  if (S.meta.trash.length > TRASH_LIMIT) S.meta.trash = S.meta.trash.slice(0, TRASH_LIMIT);
  await saveMeta();

  renderAll();
  renderTrashPanel();
  showToast('항목이 삭제되었습니다. 휴지통에서 복원할 수 있습니다.');
}

async function restoreFromTrash(trashId) {
  const idx = S.meta.trash.findIndex(t => t.id === trashId);
  if (idx === -1) return;

  const item = S.meta.trash[idx];
  const wd   = getWeek(item.weekKey);
  const task = { ...item.task, deletedAt: null, updatedAt: new Date().toISOString() };

  if (item.taskType === 'weekly') {
    wd.weeklyTodos.push(task);
  } else {
    if (!wd.dailyTodos[item.date]) wd.dailyTodos[item.date] = [];
    wd.dailyTodos[item.date].push(task);
  }

  await saveWeek(wd);
  S.meta.trash.splice(idx, 1);
  await saveMeta();

  renderAll();
  renderTrashPanel();
  showToast('항목이 복원되었습니다.');
}

/* ── TASK MODAL (주간 업무 전용) ────────────────────────────── */

function openTaskModal(type, weekKey, date, taskId) {
  S.taskEdit = { type, weekKey: weekKey || S.weekKey, date, id: taskId };

  const modal   = document.getElementById('modal-task');
  const title   = document.getElementById('modal-task-title');
  const textEl  = document.getElementById('task-text-input');
  const memoEl  = document.getElementById('task-memo-input');
  const linkGrp = document.getElementById('link-weekly-group');
  const linkSel = document.getElementById('link-weekly-select');

  const isNew = !taskId;
  title.textContent = isNew ? '업무 추가' : '업무 편집';

  let task = null;
  if (!isNew) {
    const wd = getWeek(S.taskEdit.weekKey);
    task = type === 'weekly'
      ? wd.weeklyTodos.find(t => t.id === taskId)
      : (wd.dailyTodos[date] || []).find(t => t.id === taskId);
  }

  textEl.value = task ? task.text : '';
  memoEl.value = task ? task.memo : '';
  document.getElementById('task-category-select').value    = task ? (task.category  || '') : '';
  document.getElementById('task-requester-input').value    = task ? (task.requester || '') : '';

  if (type === 'daily') {
    linkGrp.style.display = 'block';
    const wd = getWeek(S.taskEdit.weekKey);
    linkSel.innerHTML = '<option value="">연결 안함</option>' +
      wd.weeklyTodos.filter(t => !t.deletedAt).map(wt =>
        `<option value="${wt.id}" ${(task && task.linkedWeeklyTodoId === wt.id) ? 'selected' : ''}>${escHtml(wt.text)}</option>`
      ).join('');
  } else {
    linkGrp.style.display = 'none';
  }

  showModal('task');
  setTimeout(() => textEl.focus({ preventScroll: true }), 80);
}

async function onTaskSave() {
  const textEl = document.getElementById('task-text-input');
  const text   = textEl.value.trim();
  if (!text) { textEl.focus(); return; }

  const memo      = document.getElementById('task-memo-input').value.trim();
  const linkId    = (document.getElementById('link-weekly-select')?.value) || null;
  const category  = document.getElementById('task-category-select').value || '';
  const requester = document.getElementById('task-requester-input').value.trim();
  const { type, weekKey, date, id } = S.taskEdit;
  const isNew    = !id;

  let task;
  if (isNew) {
    task = makeTask({ text, category, requester, memo, linkedWeeklyTodoId: linkId || null });
  } else {
    const wd  = getWeek(weekKey);
    const src = type === 'weekly'
      ? wd.weeklyTodos.find(t => t.id === id)
      : (wd.dailyTodos[date] || []).find(t => t.id === id);
    if (!src) return;
    task = { ...src, text, category, requester, memo,
             linkedWeeklyTodoId: linkId || null,
             updatedAt: new Date().toISOString() };
  }

  hideModal('task');
  await saveTask(type, weekKey, date, task, isNew);
  showToast(isNew ? '업무가 추가되었습니다.' : '업무가 수정되었습니다.');
}

/* ── DAILY TASK MODAL ────────────────────────────────────────
   일간 업무 전용 확장 팝업 (메모 연결 옵션 포함)
   ─────────────────────────────────────────────────────────── */

function openDailyTaskModal(weekKey, date, taskId) {
  S.dailyTaskEdit = { weekKey: weekKey || S.weekKey, date, id: taskId };

  const isNew   = !taskId;
  const modal   = document.getElementById('modal-daily-task');
  const titleEl = document.getElementById('modal-dt-title');
  const dateEl  = document.getElementById('modal-dt-date');

  titleEl.textContent = isNew ? '일간 업무 추가' : '일간 업무 편집';
  dateEl.textContent  = fmtDateKo(date);

  // 기본 필드 초기화
  const textEl = document.getElementById('dt-text-input');
  const linkSel = document.getElementById('dt-link-weekly-select');

  let task = null;
  if (!isNew) {
    const wd = getWeek(S.dailyTaskEdit.weekKey);
    task = (wd.dailyTodos[date] || []).find(t => t.id === taskId);
  }

  textEl.value = task ? task.text : '';
  document.getElementById('dt-category-select').value  = task ? (task.category  || '') : '';
  document.getElementById('dt-requester-input').value  = task ? (task.requester || '') : '';

  // 주간 업무 연결 셀렉트
  const wd = getWeek(S.dailyTaskEdit.weekKey);
  linkSel.innerHTML = '<option value="">연결 안함</option>' +
    wd.weeklyTodos.filter(t => !t.deletedAt).map(wt =>
      `<option value="${wt.id}" ${(task && task.linkedWeeklyTodoId === wt.id) ? 'selected' : ''}>${escHtml(wt.text)}</option>`
    ).join('');

  // 메모 옵션 초기화
  const createMemoChk   = document.getElementById('dt-create-memo');
  const existingSection = document.getElementById('dt-existing-memo-section');
  const existingInfo    = document.getElementById('dt-existing-memo-info');

  createMemoChk.checked         = true;
  existingSection.style.display = 'none';

  // 색상 칩 초기화
  const colorChips = document.querySelectorAll('#dt-color-group .color-chip');
  const taskColor  = (task && task.color) || '';
  colorChips.forEach(chip => {
    chip.classList.toggle('active', chip.dataset.color === taskColor);
  });

  // 기존 연결 메모 표시 (편집 모드)
  if (!isNew && task && task.linkedMemoId && S.memos[task.linkedMemoId]) {
    const m = S.memos[task.linkedMemoId];
    existingSection.style.display = 'block';
    existingInfo.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:0.83rem">${escHtml(m.title || '필기 노트')}</div>
        <div style="font-size:0.75rem;color:var(--text3)">필기 노트</div>
      </div>
      <button class="memo-open-btn" data-memo-id="${m.id}">열기</button>
    `;
    existingInfo.querySelector('.memo-open-btn').addEventListener('click', () => {
      hideModal('daily-task');
      if (S.selectedDate !== (S.dailyTaskEdit.date)) selectDate(S.dailyTaskEdit.date);
      setTimeout(() => showMemoInPanel(m.id), 100);
    });
  }

  updateDtSaveOpenBtn();
  showModal('daily-task');
  setTimeout(() => textEl.focus({ preventScroll: true }), 80);
}

function updateDtSaveOpenBtn() {
  // 체크박스가 항상 checked이므로 버튼은 항상 활성화
  const saveOpenBtn = document.getElementById('btn-dt-save-open');
  if (saveOpenBtn) saveOpenBtn.disabled = false;
}

async function onDailyTaskSave(openMemoAfter = false) {
  const textEl = document.getElementById('dt-text-input');
  const text   = textEl.value.trim();
  if (!text) { textEl.focus(); return; }

  const linkId    = document.getElementById('dt-link-weekly-select').value || null;
  const category  = document.getElementById('dt-category-select').value || '';
  const requester = document.getElementById('dt-requester-input').value.trim();

  const createMemo = document.getElementById('dt-create-memo').checked;
  const activeChip = document.querySelector('#dt-color-group .color-chip.active');
  const color      = activeChip ? (activeChip.dataset.color || '') : '';

  const { weekKey, date, id } = S.dailyTaskEdit;
  const isNew = !id;

  let task;
  let linkedMemoId = null;

  if (!isNew) {
    const wd  = getWeek(weekKey);
    const src = (wd.dailyTodos[date] || []).find(t => t.id === id);
    if (!src) { hideModal('daily-task'); return; }
    linkedMemoId = src.linkedMemoId;
    task = { ...src, text, category, requester, color,
             linkedWeeklyTodoId: linkId || null,
             updatedAt: new Date().toISOString() };
  } else {
    task = makeTask({ text, category, requester, color, linkedWeeklyTodoId: linkId || null });
  }

  // 새 메모 생성 (isNew이거나 아직 메모 없을 때)
  let newMemoId = null;
  if (createMemo && (isNew || !linkedMemoId)) {
    const memo = makeLinkedMemo({
      linkedTodoId: task.id,
      type:         'note',
      title:        text,
      hasDrawing:   false,
      weekKey,
      date
    });
    await saveMemo(memo);
    task.linkedMemoId = memo.id;
    newMemoId = memo.id;
    linkedMemoId = memo.id;
  }

  hideModal('daily-task');
  await saveTask('daily', weekKey, date, task, isNew);
  showToast(isNew ? '업무가 추가되었습니다.' : '업무가 수정되었습니다.');

  if (openMemoAfter && newMemoId) {
    // 날짜 선택 후 메모를 우측 패널에 표시
    if (S.selectedDate !== date) selectDate(date);
    setTimeout(() => showMemoInPanel(newMemoId), 150);
  } else if (openMemoAfter && linkedMemoId) {
    // 기존 메모가 있으면 그것을 패널에 표시
    if (S.selectedDate !== date) selectDate(date);
    setTimeout(() => showMemoInPanel(linkedMemoId), 150);
  }
}

/* ── MEMO MODAL ──────────────────────────────────────────────
   메모 편집 팝업 (텍스트 + 선택적 드로잉 캔버스)
   ─────────────────────────────────────────────────────────── */

async function openMemoModal(memoId, isNew) {
  S.memoEdit = { id: memoId, isNew };

  const memo = await getMemo(memoId);
  if (!memo) { showToast('메모를 불러올 수 없습니다.'); return; }

  // 헤더
  const typeBadge    = document.getElementById('memo-modal-type-badge');
  const titleInput   = document.getElementById('memo-modal-title-input');
  const savedTimeEl  = document.getElementById('memo-modal-saved-time');

  typeBadge.textContent = memoTypeLabel(memo.type);
  typeBadge.className   = `memo-type-badge memo-type-badge-${memo.type}`;
  titleInput.value      = memo.title || '';
  savedTimeEl.textContent = memo.updatedAt ? '저장: ' + fmtShort(memo.updatedAt) : '';

  // 연결된 업무
  const linkedBar  = document.getElementById('memo-modal-linked-task');
  const linkedText = document.getElementById('memo-modal-linked-task-text');
  if (memo.linkedTodoId) {
    const wd = getWeek(memo.weekKey || S.weekKey);
    const allTodos = [
      ...wd.weeklyTodos,
      ...Object.values(wd.dailyTodos).flat()
    ];
    const linkedTask = allTodos.find(t => t.id === memo.linkedTodoId);
    if (linkedTask) {
      linkedText.textContent = linkedTask.text;
      linkedBar.style.display = 'flex';
    } else {
      linkedBar.style.display = 'none';
    }
  } else {
    linkedBar.style.display = 'none';
  }

  // 메모 본문
  document.getElementById('memo-modal-text').value = memo.text || '';

  // 필기 섹션
  const drawingSection = document.getElementById('memo-drawing-section');
  if (memo.hasDrawing) {
    drawingSection.style.display = 'block';
    showModal('memo');
    setTimeout(() => {
      initMemoCanvas();
      if (memo.drawingData) loadMemoDrawing(memo.drawingData);
    }, 50);
  } else {
    drawingSection.style.display = 'none';
    showModal('memo');
  }

  setTimeout(() => document.getElementById('memo-modal-text').focus({ preventScroll: true }), 80);
}

async function onMemoSave() {
  const memoId   = S.memoEdit.id;
  const memo     = await getMemo(memoId);
  if (!memo) return;

  memo.title = document.getElementById('memo-modal-title-input').value.trim();
  memo.text  = document.getElementById('memo-modal-text').value;

  // 필기 저장
  if (memo.hasDrawing && S.memoCanvas.el) {
    memo.drawingData = S.memoCanvas.el.toDataURL('image/png');
  }

  await saveMemo(memo);

  // 저장 시각 업데이트
  document.getElementById('memo-modal-saved-time').textContent = '저장: ' + fmtShort(memo.updatedAt);
  showToast('메모가 저장되었습니다.');
  hideModal('memo');
}

/* ── 메모 캔버스 ─────────────────────────────────────────────── */

function initMemoCanvas() {
  const el = document.getElementById('memo-drawing-canvas');
  if (!el) return;
  const ctx = el.getContext('2d');
  S.memoCanvas.el  = el;
  S.memoCanvas.ctx = ctx;
  S.memoCanvas.dpr = Math.min(window.devicePixelRatio || 1, 2);

  resizeMemoCanvas();
  if (!el._memoResizeObserver) {
    el._memoResizeObserver = new ResizeObserver(resizeMemoCanvas);
    el._memoResizeObserver.observe(el.parentElement);
  }

  if (!el._memoEventsAttached) {
    el.addEventListener('pointerdown', onMemoPointerDown, { passive: false });
    el.addEventListener('pointermove', onMemoPointerMove, { passive: false });
    el.addEventListener('pointerup',   onMemoPointerUp,   { passive: false });
    el.addEventListener('pointercancel', () => { S.memoCanvas.drawing = false; });
    el._memoEventsAttached = true;
  }
}

function resizeMemoCanvas() {
  const { el, ctx, dpr } = S.memoCanvas;
  if (!el) return;
  const wrap = el.parentElement;
  const rect = wrap.getBoundingClientRect();
  const w    = Math.max(rect.width, 200);
  const h    = Math.max(rect.height, 200);

  const saved = el.width > 0 && el.height > 0 ? el.toDataURL('image/png') : null;

  el.width  = w * dpr;
  el.height = h * dpr;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  if (saved && saved !== 'data:,') {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, w, h);
    img.src = saved;
  }
}

function getPosMemo(e) {
  const { el } = S.memoCanvas;
  const rect   = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onMemoPointerDown(e) {
  e.preventDefault();
  S.memoCanvas.el.setPointerCapture(e.pointerId);
  S.memoCanvas.drawing = true;
  const { x, y } = getPosMemo(e);
  S.memoCanvas.lastX = x;
  S.memoCanvas.lastY = y;
  const { ctx } = S.memoCanvas;
  applyMemoDrawStyle();
  ctx.beginPath();
  ctx.arc(x, y, S.memoCanvas.size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function onMemoPointerMove(e) {
  if (!S.memoCanvas.drawing) return;
  e.preventDefault();
  const { x, y } = getPosMemo(e);
  const { ctx, lastX, lastY } = S.memoCanvas;
  applyMemoDrawStyle();
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  S.memoCanvas.lastX = x;
  S.memoCanvas.lastY = y;
}

function onMemoPointerUp(e) {
  if (!S.memoCanvas.drawing) return;
  S.memoCanvas.drawing = false;
}

function applyMemoDrawStyle() {
  const { ctx, tool, color, size } = S.memoCanvas;
  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth  = size * 5;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle   = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth   = size;
    const autoColor = document.documentElement.dataset.theme === 'dark' ? '#e8e8e8' : '#111111';
    ctx.strokeStyle = color === 'auto' ? autoColor : color;
    ctx.fillStyle   = ctx.strokeStyle;
  }
}

function clearMemoCanvas() {
  const { ctx, el } = S.memoCanvas;
  if (!ctx) return;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, el.width, el.height);
}

function loadMemoDrawing(dataUrl) {
  if (!dataUrl || !S.memoCanvas.ctx) return;
  const { ctx, el, dpr } = S.memoCanvas;
  const w = el.width / dpr;
  const h = el.height / dpr;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, w, h);
  img.src = dataUrl;
}



/* ── NOTES ──────────────────────────────────────────────────── */

let _noteTimers = {};

function debounceNote(key, fn, delay = 800) {
  clearTimeout(_noteTimers[key]);
  _noteTimers[key] = setTimeout(fn, delay);
}

async function saveWeeklyNote(text) {
  const wd = getWeek(S.weekKey);
  wd.weeklyNote   = text;
  wd.weeklyNoteAt = new Date().toISOString();
  await saveWeek(wd);
  document.getElementById('weekly-note-time').textContent = '저장: ' + fmtShort(wd.weeklyNoteAt);
}

async function saveDailyNote(dateStr, text) {
  if (!dateStr) return;
  const wd = getWeek(S.weekKey);
  wd.dailyNotes[dateStr]   = text;
  wd.dailyNotesAt[dateStr] = new Date().toISOString();
  await saveWeek(wd);
  document.getElementById('daily-note-time').textContent = '저장: ' + fmtShort(wd.dailyNotesAt[dateStr]);
}

/* ── 드로잉 캔버스 (메인) ─────────────────────────────────────── */

function initCanvas() {
  const el  = document.getElementById('drawing-canvas');
  const ctx = el.getContext('2d');
  S.canvas.el  = el;
  S.canvas.ctx = ctx;
  S.canvas.dpr = Math.min(window.devicePixelRatio || 1, 2);

  resizeCanvas();
  new ResizeObserver(resizeCanvas).observe(el.parentElement);

  el.addEventListener('pointerdown', onPointerDown, { passive: false });
  el.addEventListener('pointermove', onPointerMove, { passive: false });
  el.addEventListener('pointerup',   onPointerUp,   { passive: false });
  el.addEventListener('pointercancel', () => {
    S.canvas.drawing = false;
    if (S.selectedDate) saveDrawing();
  });
}

function resizeCanvas() {
  const { el, ctx, dpr } = S.canvas;
  if (!el) return;
  const wrap = el.parentElement;
  const rect = wrap.getBoundingClientRect();
  const w    = Math.max(rect.width, 200);
  const h    = Math.max(rect.height, 200);

  const saved = el.width > 0 && el.height > 0 ? el.toDataURL('image/png') : null;

  el.width  = w * dpr;
  el.height = h * dpr;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  if (saved && saved !== 'data:,') {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, w, h);
    img.src = saved;
  }
}

function getPos(e) {
  const { el } = S.canvas;
  const rect   = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  if (!S.selectedDate) return;
  e.preventDefault();
  S.canvas.el.setPointerCapture(e.pointerId);
  S.canvas.drawing = true;
  const { x, y } = getPos(e);
  S.canvas.lastX = x;
  S.canvas.lastY = y;
  applyDrawStyle();
  const { ctx } = S.canvas;
  ctx.beginPath();
  ctx.arc(x, y, S.canvas.size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function onPointerMove(e) {
  if (!S.canvas.drawing) return;
  e.preventDefault();
  const { x, y } = getPos(e);
  const { ctx, lastX, lastY } = S.canvas;
  applyDrawStyle();
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  S.canvas.lastX = x;
  S.canvas.lastY = y;
}

function onPointerUp() {
  if (!S.canvas.drawing) return;
  S.canvas.drawing = false;
  if (S.selectedDate) saveDrawing();
}

function applyDrawStyle() {
  const { ctx, tool, color, size } = S.canvas;
  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth  = size * 5;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle   = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth   = size;
    const autoColor = document.documentElement.dataset.theme === 'dark' ? '#e8e8e8' : '#111111';
    ctx.strokeStyle = color === 'auto' ? autoColor : color;
    ctx.fillStyle   = ctx.strokeStyle;
  }
}

function clearCanvas() {
  const { ctx, el } = S.canvas;
  if (!ctx) return;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, el.width, el.height);
}

async function saveDrawing() {
  if (!S.selectedDate) return;
  const wd = getWeek(S.weekKey);
  wd.drawings[S.selectedDate] = S.canvas.el.toDataURL('image/png');
  await saveWeek(wd);
}

function loadDrawing(weekKey, dateStr) {
  clearCanvas();
  if (!dateStr) return;
  const wd  = getWeek(weekKey);
  const src = wd.drawings[dateStr];
  if (!src) return;
  const { ctx, el, dpr } = S.canvas;
  const w   = el.width  / dpr;
  const h   = el.height / dpr;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, w, h);
  img.src = src;
}

/* ── MODALS ─────────────────────────────────────────────────── */

function showModal(id) {
  const modal = document.getElementById('modal-' + id);
  modal.classList.remove('hidden');
  const box = modal.querySelector('.modal-box');
  if (box) {
    _wrapModalScrollArea(box);
    const area = box.querySelector('.modal-scroll-area');
    if (area) area.scrollTop = 0;
  }
  document.body.style.overflow = 'hidden';
}

function hideModal(id) {
  document.getElementById('modal-' + id).classList.add('hidden');
  // 열린 모달이 하나도 없을 때만 scroll 복원
  const anyOpen = document.querySelector('.modal:not(.hidden)');
  if (!anyOpen) document.body.style.overflow = '';
}

/**
 * modal-box 안의 header와 footer 사이 내용을
 * .modal-scroll-area div으로 감싸서 내부만 스크롤되게 함.
 * 이미 래핑된 경우 스킵.
 */
function _wrapModalScrollArea(box) {
  if (box.querySelector('.modal-scroll-area')) return;
  const header = box.querySelector('.modal-header, .memo-modal-header');
  const footer = box.querySelector('.modal-footer');
  if (!header || !footer) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'modal-scroll-area';

  // header 다음부터 footer 직전까지의 노드를 wrapper로 이동
  const nodes = [...box.childNodes];
  let inRange = false;
  for (const node of nodes) {
    if (node === header) { inRange = true; continue; }
    if (node === footer) break;
    if (inRange) wrapper.appendChild(node);
  }

  box.insertBefore(wrapper, footer);
}

function showConfirm(heading, message) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = heading;
    document.getElementById('confirm-body').textContent  = message;
    showModal('confirm');

    const ok     = document.getElementById('btn-confirm-ok');
    const cancel = document.getElementById('btn-confirm-cancel');

    function onOk()     { cleanup(); resolve(true);  }
    function onCancel() { cleanup(); resolve(false); }
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      hideModal('confirm');
    }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

/* ── 이월 ─────────────────────────────────────────────────────── */

function openCarryoverModal() {
  const nextKey   = shiftWeek(S.weekKey, 1);
  const wd        = getWeek(S.weekKey);
  const container = document.getElementById('carryover-items');
  document.getElementById('carryover-info').textContent =
    `현재 주(${S.weekKey})의 미완료 업무를 다음 주(${nextKey})로 이월합니다.`;

  const allIncomplete = [];
  wd.weeklyTodos.filter(t => !t.completed && !t.deletedAt)
    .forEach(t => allIncomplete.push({ task: t, type: 'weekly', date: null }));
  weekDates(S.weekKey).forEach(dateStr => {
    (wd.dailyTodos[dateStr] || []).filter(t => !t.completed && !t.deletedAt)
      .forEach(t => allIncomplete.push({ task: t, type: 'daily', date: dateStr }));
  });

  if (allIncomplete.length === 0) {
    container.innerHTML = '<p class="empty-msg" style="padding:1rem">미완료 업무가 없습니다.</p>';
    document.getElementById('btn-carryover-confirm').disabled = true;
  } else {
    document.getElementById('btn-carryover-confirm').disabled = false;
    container.innerHTML = allIncomplete.map((item, i) => `
      <div class="co-item">
        <input type="checkbox" id="co-${i}" value="${i}" checked>
        <label for="co-${i}" style="flex:1;cursor:pointer;font-size:0.85rem">
          ${escHtml(item.task.text)}
        </label>
        <span class="co-item-meta">${item.type === 'weekly' ? '주간' : fmtDateKo(item.date)}</span>
      </div>
    `).join('');
    container.dataset.items = JSON.stringify(allIncomplete.map(i => ({ id: i.task.id, type: i.type, date: i.date })));
  }

  showModal('carryover');
}

async function performCarryover() {
  const nextKey   = shiftWeek(S.weekKey, 1);
  const container = document.getElementById('carryover-items');
  const itemsMeta = JSON.parse(container.dataset.items || '[]');
  const checked   = [...container.querySelectorAll('input[type=checkbox]:checked')].map(cb => parseInt(cb.value));

  if (checked.length === 0) { showToast('선택된 항목이 없습니다.'); return; }

  const wd   = getWeek(S.weekKey);
  const next = getWeek(nextKey);
  let count  = 0;

  for (const idx of checked) {
    const meta = itemsMeta[idx];
    if (!meta) continue;

    const srcList = meta.type === 'weekly' ? wd.weeklyTodos : (wd.dailyTodos[meta.date] || []);
    const srcTask = srcList.find(t => t.id === meta.id);
    if (!srcTask) continue;

    const destList = meta.type === 'weekly' ? next.weeklyTodos
      : (next.dailyTodos[meta.date] || (next.dailyTodos[meta.date] = []));
    const alreadyCarried = destList.some(t => t.carriedOverFrom && t.carriedOverFrom.id === srcTask.id);
    if (alreadyCarried) continue;

    const newTask = makeTask({
      text:            srcTask.text,
      priority:        srcTask.priority,
      tags:            [...srcTask.tags],
      memo:            srcTask.memo,
      carriedOverFrom: { weekKey: S.weekKey, id: srcTask.id }
    });

    if (meta.type === 'weekly') next.weeklyTodos.push(newTask);
    else next.dailyTodos[meta.date].push(newTask);

    srcTask.carriedOverTo = { weekKey: nextKey, id: newTask.id };
    srcTask.updatedAt = new Date().toISOString();
    count++;
  }

  await saveWeek(wd);
  await saveWeek(next);
  hideModal('carryover');
  renderAll();
  showToast(`${count}개 업무가 ${nextKey}으로 이월되었습니다.`);
}

/* ── EXPORT / IMPORT ─────────────────────────────────────────── */

async function openExportModal() {
  const allWeeks = await dbGetAll('weeks');
  const totalTasks = allWeeks.reduce((sum, w) => {
    return sum
      + (w.weeklyTodos || []).filter(t => !t.deletedAt).length
      + Object.values(w.dailyTodos || {}).reduce((s, arr) => s + arr.filter(t => !t.deletedAt).length, 0);
  }, 0);
  const dates       = allWeeks.map(w => w.updatedAt).filter(Boolean).sort();
  const lastModified = dates.length > 0 ? fmtLong(dates[dates.length - 1]) : '-';

  document.getElementById('export-info').innerHTML = `
    <div style="line-height:2; font-size:0.88rem;">
      <div><b>포함 주차:</b> ${allWeeks.length}주</div>
      <div><b>전체 업무 수:</b> ${totalTasks}개</div>
      <div><b>최근 수정:</b> ${lastModified}</div>
      <div><b>앱 버전:</b> ${APP_VERSION}</div>
      <div style="margin-top:0.5rem; color:var(--text3); font-size:0.8rem;">
        파일명: planner-backup-${todayStr()}.json
      </div>
    </div>
  `;
  showModal('export');
}

async function doExport() {
  const allWeeks = await dbGetAll('weeks');
  const allMemos = await dbGetAll('memos');
  const payload  = {
    appVersion:  APP_VERSION,
    dataVersion: DATA_VERSION,
    exportedAt:  new Date().toISOString(),
    weeks:       allWeeks,
    memos:       allMemos,
    meta: {
      lastBackupAt:  S.meta.lastBackupAt,
      lastRestoreAt: S.meta.lastRestoreAt
    }
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `planner-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  S.meta.lastBackupAt = new Date().toISOString();
  await saveMeta();
  hideModal('export');
  renderDashboard();
  showToast('백업 파일이 다운로드되었습니다.');
}

function openImportModal() {
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-preview').style.display = 'none';
  document.getElementById('import-mode-group').style.display = 'none';
  document.getElementById('btn-import-confirm').disabled = true;
  S.importPayload = null;
  showModal('import');
}

function onImportFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.weeks || !Array.isArray(data.weeks)) throw new Error('Invalid format');

      S.importPayload = data;
      const totalTasks = data.weeks.reduce((sum, w) => {
        return sum
          + (w.weeklyTodos || []).length
          + Object.values(w.dailyTodos || {}).reduce((s, arr) => s + arr.length, 0);
      }, 0);

      document.getElementById('import-preview').style.display = 'block';
      document.getElementById('import-preview').innerHTML = `
        <div style="line-height:1.9; color:var(--text);">
          <div>✅ 파일 유효성: 정상</div>
          <div><b>포함 주차:</b> ${data.weeks.length}주</div>
          <div><b>전체 업무 수:</b> ${totalTasks}개</div>
          <div><b>내보낸 날짜:</b> ${fmtLong(data.exportedAt)}</div>
          <div><b>앱 버전:</b> ${data.appVersion || '알 수 없음'}</div>
        </div>
      `;
      document.getElementById('import-mode-group').style.display = 'block';
      document.getElementById('btn-import-confirm').disabled = false;
      updateImportModeHint();
    } catch {
      document.getElementById('import-preview').style.display = 'block';
      document.getElementById('import-preview').innerHTML =
        '<div style="color:var(--c-high)">❌ 파일 형식이 올바르지 않습니다.</div>';
      document.getElementById('import-mode-group').style.display = 'none';
      document.getElementById('btn-import-confirm').disabled = true;
      S.importPayload = null;
    }
  };
  reader.readAsText(file);
}

function updateImportModeHint() {
  const hints = {
    overwrite: '현재 모든 데이터를 삭제하고 백업 파일로 교체합니다.',
    merge:     '현재 데이터에 백업 파일을 병합합니다. (겹치는 주차는 병합, 없는 주차는 추가)'
  };
  const hint = document.getElementById('import-mode-hint');
  if (hint) hint.textContent = hints[S.importMode] || '';
}

async function doImport() {
  if (!S.importPayload) return;
  const ok = await showConfirm(
    '불러오기 확인',
    S.importMode === 'overwrite'
      ? '현재 모든 데이터가 삭제되고 백업 파일로 교체됩니다. 계속하시겠습니까?'
      : '현재 데이터에 백업 파일을 병합합니다. 계속하시겠습니까?'
  );
  if (!ok) return;

  const db = await openDB();

  if (S.importMode === 'overwrite') {
    // weeks 지우고 재삽입
    await new Promise((resolve, reject) => {
      const tx  = db.transaction('weeks', 'readwrite');
      const req = tx.objectStore('weeks').clear();
      req.onsuccess = resolve; req.onerror = reject;
    });
    for (const w of S.importPayload.weeks) await dbPut('weeks', w);
    S.weeks = {};
    S.importPayload.weeks.forEach(w => { S.weeks[w.weekKey] = w; });

    // memos 지우고 재삽입
    await new Promise((resolve, reject) => {
      const tx  = db.transaction('memos', 'readwrite');
      const req = tx.objectStore('memos').clear();
      req.onsuccess = resolve; req.onerror = reject;
    });
    S.memos = {};
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) { await dbPut('memos', m); S.memos[m.id] = m; }
    }

  } else {
    // 병합 — weeks
    for (const importedWeek of S.importPayload.weeks) {
      const existing = await dbGet('weeks', importedWeek.weekKey);
      if (!existing) {
        await dbPut('weeks', importedWeek);
        S.weeks[importedWeek.weekKey] = importedWeek;
      } else {
        const existIds = new Set(existing.weeklyTodos.map(t => t.id));
        importedWeek.weeklyTodos.forEach(t => { if (!existIds.has(t.id)) existing.weeklyTodos.push(t); });
        Object.entries(importedWeek.dailyTodos).forEach(([date, arr]) => {
          if (!existing.dailyTodos[date]) existing.dailyTodos[date] = [];
          const dayIds = new Set(existing.dailyTodos[date].map(t => t.id));
          arr.forEach(t => { if (!dayIds.has(t.id)) existing.dailyTodos[date].push(t); });
        });
        Object.entries(importedWeek.dailyNotes || {}).forEach(([date, note]) => {
          if (!existing.dailyNotes[date] && note) existing.dailyNotes[date] = note;
        });
        Object.entries(importedWeek.drawings || {}).forEach(([date, drawing]) => {
          if (!existing.drawings[date] && drawing) existing.drawings[date] = drawing;
        });
        if (!existing.weeklyNote && importedWeek.weeklyNote) existing.weeklyNote = importedWeek.weeklyNote;
        existing.updatedAt = new Date().toISOString();
        await dbPut('weeks', existing);
        S.weeks[existing.weekKey] = existing;
      }
    }
    // 병합 — memos (ID 충돌 없는 것만)
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) {
        if (!S.memos[m.id] && !await dbGet('memos', m.id)) {
          await dbPut('memos', m);
          S.memos[m.id] = m;
        }
      }
    }
  }

  S.meta.lastRestoreAt = new Date().toISOString();
  await saveMeta();
  hideModal('import');
  S.importPayload = null;
  await loadCurrentWeek();
  renderAll();
  renderHistoryWeekNav();
  showToast('백업 데이터를 성공적으로 불러왔습니다.');
}

/* ── 히스토리 패널 ────────────────────────────────────────────── */

async function renderHistoryWeekNav() {
  const allWeeks = await dbGetAll('weeks');
  allWeeks.forEach(w => { S.weeks[w.weekKey] = w; });
  allWeeks.sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  const nav = document.getElementById('history-week-nav');
  if (allWeeks.length === 0) {
    nav.innerHTML = '<p class="empty-msg">저장된 주차가 없습니다.</p>';
    document.getElementById('history-viewer').innerHTML = '';
    return;
  }

  nav.innerHTML = allWeeks.map(w =>
    `<button class="hist-week-btn" data-wk="${w.weekKey}">${w.weekKey}</button>`
  ).join('');

  nav.querySelectorAll('.hist-week-btn').forEach(btn => {
    btn.addEventListener('click', () => showHistoryWeek(btn.dataset.wk));
  });
}

function showHistoryWeek(weekKey) {
  document.querySelectorAll('.hist-week-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.wk === weekKey);
  });

  const wd = S.weeks[weekKey];
  if (!wd) {
    document.getElementById('history-viewer').innerHTML = '<p class="empty-msg">데이터 없음</p>';
    return;
  }

  const dates = weekDates(weekKey);
  let html    = '';

  if (wd.weeklyTodos.filter(t => !t.deletedAt).length > 0) {
    html += `<div class="hist-section">
      <h4>주간 To-Do (${weekKey})</h4>
      ${wd.weeklyTodos.filter(t => !t.deletedAt).map(t =>
        `<div class="hist-todo-item ${t.completed ? 'done' : ''}">
          <span class="priority-dot ${t.priority}"></span>
          ${escHtml(t.text)}
        </div>`
      ).join('')}
    </div>`;
  }

  if (wd.weeklyNote) {
    html += `<div class="hist-section">
      <h4>주간 메모</h4>
      <div class="hist-note-preview">${escHtml(wd.weeklyNote)}</div>
    </div>`;
  }

  dates.forEach(dateStr => {
    const dayTodos  = (wd.dailyTodos[dateStr] || []).filter(t => !t.deletedAt);
    const dayNote   = wd.dailyNotes[dateStr];
    const hasDrawing = !!wd.drawings[dateStr];
    if (dayTodos.length === 0 && !dayNote && !hasDrawing) return;

    html += `<div class="hist-section">
      <h4>${fmtDateKo(dateStr)}</h4>
      ${dayTodos.map(t =>
        `<div class="hist-todo-item ${t.completed ? 'done' : ''}">
          <span class="priority-dot ${t.priority}"></span>
          ${escHtml(t.text)}
        </div>`
      ).join('')}
      ${dayNote ? `<div class="hist-note-preview">${escHtml(dayNote.slice(0, 200))}${dayNote.length > 200 ? '…' : ''}</div>` : ''}
      ${hasDrawing ? `<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--text3)">📝 필기 있음</div>` : ''}
    </div>`;
  });

  document.getElementById('history-viewer').innerHTML = html || '<p class="empty-msg">데이터 없음</p>';
}

/* ── 휴지통 패널 ─────────────────────────────────────────────── */

function renderTrashPanel() {
  const list  = document.getElementById('trash-list');
  const empty = document.getElementById('trash-empty');
  const items = S.meta.trash;

  if (items.length === 0) {
    list.innerHTML  = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = items.map(item => `
    <div class="trash-item">
      <div class="trash-item-info">
        <div class="trash-item-text">${escHtml(item.task.text)}</div>
        <div class="trash-item-meta">${item.weekKey} · ${item.taskType === 'weekly' ? '주간' : (item.date ? fmtDateKo(item.date) : '-')} · ${fmtShort(item.deletedAt)} 삭제</div>
      </div>
      <div class="trash-item-actions">
        <button class="btn-restore" data-trash-id="${item.id}">복원</button>
        <button class="btn-trash-delete" data-trash-id="${item.id}">삭제</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', () => restoreFromTrash(btn.dataset.trashId));
  });
  list.querySelectorAll('.btn-trash-delete').forEach(btn => {
    btn.addEventListener('click', () => permanentDeleteFromTrash(btn.dataset.trashId));
  });
}

async function permanentDeleteFromTrash(trashId) {
  const idx = S.meta.trash.findIndex(t => t.id === trashId);
  if (idx === -1) return;
  const item = S.meta.trash[idx];
  const ok = await showConfirm('영구 삭제', `"${item.task.text}" 항목을 영구 삭제할까요? 복원할 수 없습니다.`);
  if (!ok) return;
  S.meta.trash.splice(idx, 1);
  await saveMeta();
  renderTrashPanel();
  showToast('항목이 영구 삭제되었습니다.');
}

/* ── 검색 ───────────────────────────────────────────────────── */

let _searchTimer = null;

async function performSearch(query) {
  S.filters.query = query.trim();
  const overlay  = document.getElementById('search-overlay');
  const clearBtn = document.getElementById('btn-search-clear');
  const info     = document.getElementById('search-result-info');
  const list     = document.getElementById('search-results-list');

  if (!S.filters.query) {
    overlay.classList.add('hidden');
    clearBtn.classList.add('hidden');
    return;
  }

  clearBtn.classList.remove('hidden');
  info.textContent = '검색 중...';
  list.innerHTML   = '';
  overlay.classList.remove('hidden');

  const allWeeks = await dbGetAll('weeks');
  allWeeks.forEach(w => { if (!S.weeks[w.weekKey]) S.weeks[w.weekKey] = w; });

  const q       = S.filters.query;
  const ql      = q.toLowerCase();
  const results = [];

  allWeeks.sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  allWeeks.forEach(wd => {
    (wd.weeklyTodos || []).filter(t => !t.deletedAt && matchTaskQuery(t, ql)).forEach(t => results.push({
      kind: 'weekly-todo', label: '주간업무', weekKey: wd.weekKey, date: null,
      text: t.text, sub: buildTaskSub(t), priority: t.priority, completed: t.completed, taskId: t.id
    }));

    Object.entries(wd.dailyTodos || {}).forEach(([date, arr]) => {
      (arr || []).filter(t => !t.deletedAt && matchTaskQuery(t, ql)).forEach(t => results.push({
        kind: 'daily-todo', label: '일간업무', weekKey: wd.weekKey, date,
        text: t.text, sub: buildTaskSub(t), priority: t.priority, completed: t.completed, taskId: t.id
      }));
    });

    const wNote = wd.weeklyNote || '';
    if (wNote.toLowerCase().includes(ql)) {
      results.push({
        kind: 'weekly-note', label: '주간메모', weekKey: wd.weekKey, date: null,
        text: extractSnippet(wNote, ql), sub: wd.weekKey, priority: null, completed: false, taskId: null
      });
    }

    Object.entries(wd.dailyNotes || {}).forEach(([date, note]) => {
      if (!note || !note.toLowerCase().includes(ql)) return;
      results.push({
        kind: 'daily-note', label: '일간메모', weekKey: wd.weekKey, date,
        text: extractSnippet(note, ql), sub: `${wd.weekKey} · ${fmtDateKo(date)}`,
        priority: null, completed: false, taskId: null
      });
    });
  });

  info.innerHTML = results.length > 0
    ? `<b>${escHtml(q)}</b> 검색 결과 <span class="search-count">${results.length}건</span>`
    : `<b>${escHtml(q)}</b> — 검색 결과 없음`;

  if (results.length === 0) {
    list.innerHTML = `<p class="search-empty">모든 주차를 검색했지만 일치하는 항목이 없습니다.</p>`;
    return;
  }

  list.innerHTML = '';
  results.forEach(r => {
    const el = document.createElement('div');
    el.className  = `search-result-item sri-${r.kind}`;
    el.dataset.wk   = r.weekKey;
    el.dataset.date = r.date || '';

    const kindBadge   = `<span class="sri-badge sri-badge-${r.kind}">${escHtml(r.label)}</span>`;
    const priDot      = r.priority ? `<span class="priority-dot ${r.priority}" title="${priorityLabel(r.priority)}"></span>` : '';
    const doneMark    = r.completed ? `<span class="sri-done">✓</span>` : '';
    const highlighted = highlight(r.text, q);
    const weekPart    = r.date ? `${r.weekKey} · ${fmtDateKo(r.date)}` : r.weekKey;

    el.innerHTML = `
      <div class="sri-top">
        ${kindBadge}
        <span class="sri-week">${escHtml(weekPart)}</span>
        ${doneMark}
      </div>
      <div class="sri-body">
        ${priDot}
        <div class="sri-text">${highlighted}</div>
      </div>
    `;

    el.addEventListener('click', () => {
      const wk   = el.dataset.wk;
      const date = el.dataset.date;
      closeSearch();
      if (wk !== S.weekKey) {
        S.weekKey = wk;
        loadCurrentWeek().then(() => {
          renderAll();
          if (date) selectDate(date);
          else if (r.kind === 'weekly-note') setTimeout(() => document.getElementById('weekly-note')?.focus(), 200);
        });
      } else {
        if (date) selectDate(date);
        else if (r.kind === 'weekly-note') document.getElementById('weekly-note')?.focus();
      }
    });

    list.appendChild(el);
  });
}

function matchTaskQuery(task, ql) {
  return (task.text || '').toLowerCase().includes(ql)
    ||   (task.memo || '').toLowerCase().includes(ql)
    ||   (task.tags || []).some(t => t.toLowerCase().includes(ql));
}

function buildTaskSub(task) {
  const parts = [];
  if (task.tags && task.tags.length > 0) parts.push(task.tags.map(t => '#' + t).join(' '));
  if (task.memo) parts.push(task.memo.slice(0, 40) + (task.memo.length > 40 ? '…' : ''));
  return parts.join(' · ');
}

function extractSnippet(text, ql) {
  const lower = text.toLowerCase();
  const idx   = lower.indexOf(ql);
  if (idx === -1) return text.slice(0, 80);
  const start = Math.max(0, idx - 30);
  const end   = Math.min(text.length, idx + ql.length + 30);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function highlight(text, query) {
  const escaped = escHtml(text);
  const eq      = escHtml(query);
  return escaped.replace(new RegExp(escRegex(eq), 'gi'), m => `<mark>${m}</mark>`);
}

function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function closeSearch() {
  S.filters.query = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-overlay').classList.add('hidden');
  document.getElementById('btn-search-clear').classList.add('hidden');
}

/* ── 모바일 탭 ──────────────────────────────────────────────── */

function switchMobileTab(tab) {
  S.mobileTab = tab;
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('mobile-active', p.dataset.tab === tab);
  });
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (tab === 'history') renderHistoryWeekNav();
}

/* ── 테마 ──────────────────────────────────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('meta-theme-color').content = theme === 'dark' ? '#1a1a1a' : '#ffffff';
}

async function toggleTheme() {
  S.meta.theme = S.meta.theme === 'dark' ? 'light' : 'dark';
  applyTheme(S.meta.theme);
  await saveMeta();
}

/* ── TOAST ──────────────────────────────────────────────────── */

let _toastTimer = null;

function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ── HTML 이스케이프 ─────────────────────────────────────────── */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── 현재 주차 데이터 로드 ─────────────────────────────────── */

async function loadCurrentWeek() {
  const wd = await dbGet('weeks', S.weekKey);
  S.weeks[S.weekKey] = wd || makeWeekData(S.weekKey);
  await loadMemosForWeek(S.weekKey);
}

/* ── 더미 데이터 생성 ─────────────────────────────────────── */

async function createDummyData() {
  const existing = await dbGetAll('weeks');
  if (existing.length > 0) return;

  const wk    = getWeekKey(new Date());
  const wd    = makeWeekData(wk);
  const today = todayStr();
  const dates = weekDates(wk);

  const wt1 = makeTask({ text: '월간 보고서 작성', priority: 'high', tags: ['보고서', '업무'], memo: '기획팀과 내용 확인 필요' });
  const wt2 = makeTask({ text: '팀 미팅 준비 (수요일)', priority: 'medium', tags: ['회의'] });
  const wt3 = makeTask({ text: '신규 프로젝트 기획안 검토', priority: 'high', tags: ['기획', '업무'] });
  const wt4 = makeTask({ text: '이번 주 독서 (1장 이상)', priority: 'low', tags: ['자기계발'], completed: true, completedAt: new Date().toISOString() });
  wd.weeklyTodos = [wt1, wt2, wt3, wt4];
  wd.weeklyNote  = '이번 주 목표: 보고서 완료 + 프로젝트 착수\n집중 시간대: 오전 9~11시';

  wd.dailyTodos[today] = [
    makeTask({ text: '이메일 확인 및 회신', priority: 'medium' }),
    makeTask({ text: '월간 보고서 초안 작성', priority: 'high', linkedWeeklyTodoId: wt1.id, tags: ['보고서'] }),
    makeTask({ text: '점심 약속 (홍길동)', priority: 'low' })
  ];
  wd.dailyNotes[today] = '오늘 집중 업무: 보고서 초안\n미팅 전에 자료 정리 필수';

  if (dates[1] && dates[1] !== today) {
    wd.dailyTodos[dates[1]] = [
      makeTask({ text: '기획안 검토 회의 참석', priority: 'high', tags: ['회의'] }),
      makeTask({ text: '주간 업무 정리', priority: 'medium' })
    ];
  }

  await saveWeek(wd);
  S.weeks[wk] = wd;

  const prevWk = shiftWeek(wk, -1);
  const prevWd = makeWeekData(prevWk);
  prevWd.weeklyTodos = [
    makeTask({ text: '분기 실적 정리', priority: 'high', tags: ['보고서'], completed: true, completedAt: new Date().toISOString() }),
    makeTask({ text: '팀 워크샵 준비', priority: 'medium', completed: true, completedAt: new Date().toISOString() }),
    makeTask({ text: '계약서 검토 (미완료 → 이번 주 이월)', priority: 'high' })
  ];
  prevWd.weeklyNote = '지난 주 회고: 분기 실적 정리 완료. 계약서 검토는 이번 주로 이월.';
  await saveWeek(prevWd);
  S.weeks[prevWk] = prevWd;
}

/* ── 이벤트 바인딩 ─────────────────────────────────────────── */

function bindEvents() {

  // 주/월 네비게이션
  document.getElementById('btn-prev-week').addEventListener('click', async () => {
    if (S.viewMode === 'monthly') {
      S.monthKey = shiftMonth(S.monthKey, -1);
      renderWeekLabel();
      await loadMonthWeeks(S.monthKey);
      renderMonthlyView();
    } else {
      S.weekKey = shiftWeek(S.weekKey, -1);
      S.selectedDate = '';
      await loadCurrentWeek();
      renderAll(); renderDetailPanel();
    }
  });
  document.getElementById('btn-next-week').addEventListener('click', async () => {
    if (S.viewMode === 'monthly') {
      S.monthKey = shiftMonth(S.monthKey, 1);
      renderWeekLabel();
      await loadMonthWeeks(S.monthKey);
      renderMonthlyView();
    } else {
      S.weekKey = shiftWeek(S.weekKey, 1);
      S.selectedDate = '';
      await loadCurrentWeek();
      renderAll(); renderDetailPanel();
    }
  });
  document.getElementById('btn-today').addEventListener('click', async () => {
    S.weekKey      = getWeekKey(new Date());
    S.selectedDate = todayStr();
    await loadCurrentWeek();
    if (S.viewMode === 'monthly') await switchView('weekly');
    renderAll(); renderDetailPanel();
  });

  // 월간 뷰 토글 버튼
  document.getElementById('btn-view-monthly').addEventListener('click', async () => {
    if (S.viewMode === 'monthly') {
      await switchView('weekly');
    } else {
      // 현재 주의 달로 초기화
      const dates = weekDates(S.weekKey);
      const d = new Date(dates[0] + 'T00:00:00');
      S.monthKey = getMonthKey(d);
      await switchView('monthly');
    }
  });

  // 주간 업무 추가
  document.getElementById('btn-add-weekly').addEventListener('click', () => {
    openTaskModal('weekly', S.weekKey, null, null);
  });

  // 주간 업무 모달 저장
  document.getElementById('btn-task-save').addEventListener('click', onTaskSave);
  document.getElementById('task-text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onTaskSave(); }
  });

  // 주간 업무 우선순위 버튼
  document.querySelectorAll('#task-priority-group .priority-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#task-priority-group .priority-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── 일간 업무 모달 이벤트 ──

  // 색상 칩 선택
  document.querySelectorAll('#dt-color-group .color-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#dt-color-group .color-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  // 메모 같이 만들기 체크박스
  document.getElementById('dt-create-memo').addEventListener('change', () => {
    updateDtSaveOpenBtn();
  });

  // 일간 업무 저장 버튼
  document.getElementById('btn-dt-save').addEventListener('click', () => onDailyTaskSave(false));
  document.getElementById('btn-dt-save-open').addEventListener('click', () => onDailyTaskSave(true));

  // 일간 업무 텍스트 Ctrl+Enter 저장 (textarea이므로 Enter는 줄바꿈)
  document.getElementById('dt-text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); onDailyTaskSave(false); }
  });

  // 일간 업무 모달 줄바꿈/지우기 버튼
  document.getElementById('btn-dt-newline').addEventListener('click', () => {
    const ta = document.getElementById('dt-text-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
    ta.focus();
  });
  document.getElementById('btn-dt-backspace').addEventListener('click', () => {
    const ta = document.getElementById('dt-text-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s !== end) {
      ta.value = ta.value.slice(0, s) + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s;
    } else if (s > 0) {
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - 1;
    }
    ta.focus();
  });

  // 주간 업무 모달 메모 줄바꿈/지우기 버튼
  document.getElementById('btn-task-memo-newline').addEventListener('click', () => {
    const ta = document.getElementById('task-memo-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
    ta.focus();
  });
  document.getElementById('btn-task-memo-backspace').addEventListener('click', () => {
    const ta = document.getElementById('task-memo-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s !== end) {
      ta.value = ta.value.slice(0, s) + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s;
    } else if (s > 0) {
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - 1;
    }
    ta.focus();
  });

  // 우측 패널 일간 메모 줄바꿈/지우기 버튼
  document.getElementById('btn-daily-note-newline').addEventListener('click', () => {
    const ta = document.getElementById('daily-note');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });
  document.getElementById('btn-daily-note-backspace').addEventListener('click', () => {
    const ta = document.getElementById('daily-note');
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s !== end) {
      ta.value = ta.value.slice(0, s) + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s;
    } else if (s > 0) {
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - 1;
    }
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });

  // ── 메모 모달 이벤트 ──
  document.getElementById('btn-memo-save').addEventListener('click', onMemoSave);

  // 줄바꿈 버튼
  document.getElementById('btn-memo-newline').addEventListener('click', () => {
    const ta = document.getElementById('memo-modal-text');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
    ta.focus();
  });
  document.getElementById('btn-memo-backspace').addEventListener('click', () => {
    const ta = document.getElementById('memo-modal-text');
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s !== end) {
      ta.value = ta.value.slice(0, s) + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s;
    } else if (s > 0) {
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - 1;
    }
    ta.focus();
  });

  // 메모 캔버스 도구
  document.getElementById('memo-tool-pen').addEventListener('click', () => {
    S.memoCanvas.tool = 'pen';
    document.getElementById('memo-tool-pen').classList.add('active');
    document.getElementById('memo-tool-eraser').classList.remove('active');
    if (S.memoCanvas.el) S.memoCanvas.el.style.cursor = 'crosshair';
  });
  document.getElementById('memo-tool-eraser').addEventListener('click', () => {
    S.memoCanvas.tool = 'eraser';
    document.getElementById('memo-tool-eraser').classList.add('active');
    document.getElementById('memo-tool-pen').classList.remove('active');
    if (S.memoCanvas.el) S.memoCanvas.el.style.cursor = 'cell';
  });
  document.getElementById('memo-pen-color').addEventListener('change', e => {
    S.memoCanvas.color = e.target.value;
  });
  document.getElementById('memo-pen-size').addEventListener('change', e => {
    S.memoCanvas.size = parseFloat(e.target.value);
  });
  document.getElementById('memo-tool-clear').addEventListener('click', () => {
    showConfirm('전체 지우기', '메모 필기를 모두 지울까요?').then(ok => {
      if (ok) clearMemoCanvas();
    });
  });

  // 주간 메모 자동 저장
  document.getElementById('weekly-note').addEventListener('input', e => {
    debounceNote('weekly', () => saveWeeklyNote(e.target.value));
  });

  // 일간 메모 자동 저장
  document.getElementById('daily-note').addEventListener('input', e => {
    debounceNote('daily-' + S.selectedDate, () => saveDailyNote(S.selectedDate, e.target.value));
  });


  // 테마 전환
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // 백업/복원 버튼
  document.getElementById('btn-export').addEventListener('click', openExportModal);
  document.getElementById('btn-export-confirm').addEventListener('click', doExport);
  document.getElementById('btn-import').addEventListener('click', openImportModal);
  document.getElementById('btn-import-confirm').addEventListener('click', doImport);
  document.getElementById('import-file-input').addEventListener('change', onImportFileChange);

  // 불러오기 방식 선택
  document.querySelectorAll('.import-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.import-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.importMode = btn.dataset.mode;
      updateImportModeHint();
    });
  });

  // 이월 버튼
  document.getElementById('btn-carryover').addEventListener('click', openCarryoverModal);
  document.getElementById('btn-carryover-confirm').addEventListener('click', performCarryover);

  // 대시보드 위젯 클릭
  document.getElementById('w-today-widget').addEventListener('click', () => {
    const today = todayStr();
    if (S.weekKey !== getWeekKey(new Date())) {
      S.weekKey = getWeekKey(new Date());
      loadCurrentWeek().then(() => renderAll());
    }
    selectDate(today);
  });
  document.getElementById('w-co-widget').addEventListener('click', openCarryoverModal);

  // 낙서장

  // 검색
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => performSearch(e.target.value), 350);
  });
  document.getElementById('btn-search-clear').addEventListener('click', () => {
    document.getElementById('search-input').value = '';
    closeSearch(); renderAll();
  });
  document.getElementById('btn-close-search').addEventListener('click', () => {
    document.getElementById('search-input').value = '';
    closeSearch(); renderAll();
  });

  // 모달 닫기 (data-modal-close 속성)
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-modal-close]');
    if (closer) hideModal(closer.dataset.modalClose);
  });

  // 히스토리 / 휴지통 토글
  document.getElementById('btn-toggle-history').addEventListener('click', () => {
    const body   = document.getElementById('history-body');
    const header = document.getElementById('btn-toggle-history');
    const collapsed = body.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', !collapsed);
    if (!collapsed) renderHistoryWeekNav();
  });
  document.getElementById('btn-toggle-history').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
  });

  document.getElementById('btn-toggle-trash').addEventListener('click', () => {
    const body   = document.getElementById('trash-body');
    const header = document.getElementById('btn-toggle-trash');
    const collapsed = body.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', !collapsed);
  });
  document.getElementById('btn-toggle-trash').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
  });

  // 모바일 탭
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMobileTab(btn.dataset.tab));
  });

  // 새로고침/종료 전 경고
  window.addEventListener('beforeunload', e => {
    if (S.canvas.drawing || S.memoCanvas.drawing) {
      e.preventDefault();
      return (e.returnValue = '필기 중인 데이터가 있습니다.');
    }
  });

  // ESC 키로 모달/검색 닫기
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['task', 'daily-task', 'memo', 'confirm', 'export', 'import', 'carryover'].forEach(id => {
        const modal = document.getElementById('modal-' + id);
        if (modal && !modal.classList.contains('hidden')) hideModal(id);
      });
      if (!document.getElementById('search-overlay').classList.contains('hidden')) {
        document.getElementById('search-input').value = '';
        closeSearch(); renderAll();
      }
    }
  });
}

/* ── 앱 초기화 ──────────────────────────────────────────────── */

async function init() {
  try {
    await openDB();

    const metaData = await dbGet('meta', 'app');
    if (metaData) {
      S.meta.theme         = metaData.theme         || 'light';
      S.meta.lastBackupAt  = metaData.lastBackupAt  || null;
      S.meta.lastRestoreAt = metaData.lastRestoreAt || null;
      S.meta.trash         = metaData.trash          || [];
    }

    applyTheme(S.meta.theme);

    S.weekKey      = getWeekKey(new Date());
    S.selectedDate = '';

    await createDummyData();
    await loadCurrentWeek();

    bindEvents();

    if (window.innerWidth <= 900) switchMobileTab('weekly');

    renderAll();
    renderTrashPanel();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .catch(err => console.warn('SW registration failed:', err));
    }

    scheduleMidnightRefresh();

    console.log(`✅ Mono Planner v${APP_VERSION} initialized`);

  } catch (err) {
    console.error('Initialization error:', err);

    let hint = '';
    const msg = err.message || '';
    if (msg.includes('addEventListener') || msg.includes('null') || msg.includes('undefined')) {
      hint = '⚠️ DOM 요소를 찾지 못했습니다. 파일이 완전히 로드되었는지 확인하세요.<br>브라우저 캐시를 초기화(Ctrl+Shift+R) 후 다시 시도해보세요.';
    } else if (msg.includes('IndexedDB') || msg.includes('IDBDatabase') || err.name === 'SecurityError') {
      hint = '⚠️ IndexedDB를 사용할 수 없습니다.<br>시크릿 모드를 종료하거나, 브라우저 설정에서 사이트 데이터 저장을 허용해주세요.<br>Safari: 설정 → Safari → 고급 → 웹 사이트 데이터';
    } else if (msg.includes('JSON') || msg.includes('parse')) {
      hint = '⚠️ 데이터 파일 형식이 잘못되었습니다.<br>가장 최근 백업 파일로 복원을 시도해보세요.';
    } else {
      hint = '⚠️ 브라우저 설정에서 IndexedDB가 허용되어 있는지 확인하세요.<br>시크릿 모드에서는 데이터가 저장되지 않습니다.';
    }

    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;padding:2rem;text-align:center;background:#f7f7f7;">
        <div style="background:#fff;border-radius:10px;padding:2rem 2.5rem;max-width:480px;box-shadow:0 4px 16px rgba(0,0,0,0.1);">
          <div style="font-size:2rem;margin-bottom:1rem;">■</div>
          <h2 style="margin-bottom:0.75rem;font-size:1.1rem;">Mono Planner 초기화 오류</h2>
          <p style="color:#cc3333;font-size:0.88rem;background:#fff5f5;border:1px solid #fcc;border-radius:6px;padding:0.75rem;margin:0.75rem 0;font-family:monospace;word-break:break-all;">${escHtml(msg || '알 수 없는 오류')}</p>
          <p style="color:#666;font-size:0.85rem;line-height:1.8;">${hint}</p>
          <button onclick="location.reload()" style="margin-top:1.5rem;padding:0.5rem 1.5rem;background:#222;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">다시 시도</button>
        </div>
      </div>
    `;
  }
}

// DOM 로드 완료 후 초기화
document.addEventListener('DOMContentLoaded', init);
