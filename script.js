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
const DB_VER       = 4;
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
  notebooks:     {},   // id → Notebook
  nbPages:       {},   // id → NotebookPage
  activeNbPageId: null,
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
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('nb_pages')) {
        db.createObjectStore('nb_pages', { keyPath: 'id' });
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

/* ── 법정공휴일 ─────────────────────────────────────────────── */

function getKoreanHolidays(year) {
  const h = {};
  const add = (mmdd, name) => { h[`${year}-${mmdd}`] = name; };

  // 양력 고정 공휴일
  add('01-01', '신정');
  add('03-01', '삼일절');
  add('05-05', '어린이날');
  add('06-06', '현충일');
  add('08-15', '광복절');
  add('10-03', '개천절');
  add('10-09', '한글날');
  add('12-25', '성탄절');

  // 음력 기반 공휴일 (연도별 하드코딩, 연휴 포함)
  const lunar = {
    2024: {
      설날전날: '02-09', 설날: '02-10', 설날다음날: '02-11',
      부처님오신날: '05-15',
      추석전날: '09-16', 추석: '09-17', 추석다음날: '09-18',
    },
    2025: {
      설날전날: '01-28', 설날: '01-29', 설날다음날: '01-30',
      부처님오신날: '05-05',
      추석전날: '10-05', 추석: '10-06', 추석다음날: '10-07',
    },
    2026: {
      설날전날: '02-16', 설날: '02-17', 설날다음날: '02-18',
      부처님오신날: '05-24',
      추석전날: '09-24', 추석: '09-25', 추석다음날: '09-26',
    },
    2027: {
      설날전날: '02-06', 설날: '02-07', 설날다음날: '02-08',
      부처님오신날: '05-13',
      추석전날: '10-14', 추석: '10-15', 추석다음날: '10-16',
    },
    2028: {
      설날전날: '01-26', 설날: '01-27', 설날다음날: '01-28',
      부처님오신날: '05-02',
      추석전날: '10-02', 추석: '10-03', 추석다음날: '10-04',
    },
    2029: {
      설날전날: '02-12', 설날: '02-13', 설날다음날: '02-14',
      부처님오신날: '05-20',
      추석전날: '09-21', 추석: '09-22', 추석다음날: '09-23',
    },
    2030: {
      설날전날: '02-02', 설날: '02-03', 설날다음날: '02-04',
      부처님오신날: '05-09',
      추석전날: '09-11', 추석: '09-12', 추석다음날: '09-13',
    },
  };

  const ly = lunar[year];
  if (ly) {
    add(ly.설날전날,     '설날 전날');
    add(ly.설날,         '설날');
    add(ly.설날다음날,   '설날 다음날');
    add(ly.부처님오신날, '부처님오신날');
    add(ly.추석전날,     '추석 전날');
    add(ly.추석,         '추석');
    add(ly.추석다음날,   '추석 다음날');
  }

  return h;
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

// 달력 그리드용 42셀 반환 (Sun 시작, 앞뒤 달 포함)
function monthCalendarCells(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const first  = new Date(Date.UTC(y, m - 1, 1));
  const startDow = first.getUTCDay();  // 0=Sun … 6=Sat
  const start  = new Date(first);
  start.setUTCDate(first.getUTCDate() - startDow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return {
      dateStr:  fmtDate(d),
      inMonth:  d.getUTCMonth() === m - 1,
      day:      d.getUTCDate(),
      dowIdx:   i % 7   // 0=Sun…6=Sat
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
      const CATEGORY_DEFAULT_COLOR = { '일정': '#3182ce', '약속': '#d69e2e' };
      for (const t of active) {
        if (t.category === '일정' || t.category === '약속') {
          if (!schedules[dateStr]) schedules[dateStr] = [];
          const displayColor = t.color || CATEGORY_DEFAULT_COLOR[t.category];
          schedules[dateStr].push({ text: t.text, completed: t.completed, color: displayColor });
        } else {
          if (!otherTasks[dateStr]) otherTasks[dateStr] = [];
          otherTasks[dateStr].push({ completed: t.completed, color: t.color || '' });
        }
      }
    }
  }

  // 공휴일 맵 (당월 + 인접 연도 포함)
  const holidays = { ...getKoreanHolidays(y - 1), ...getKoreanHolidays(y), ...getKoreanHolidays(y + 1) };

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const cells = monthCalendarCells(S.monthKey);

  // 요일 헤더 (일=0 sun, 토=6 sat)
  const dowHtml = DOW.map((d, i) => {
    const cls = i === 0 ? 'monthly-dow sun' : i === 6 ? 'monthly-dow sat' : 'monthly-dow';
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
    const isSun  = dowIdx === 0;
    const isSat  = dowIdx === 6;
    const wkKey  = getWeekKey(new Date(dateStr + 'T00:00:00'));

    const holidayName = holidays[dateStr] || null;

    let cls = 'monthly-cell';
    if (isToday)    cls += ' is-today';
    else if (isCurWeek) cls += ' is-cur-week';
    if (isSat) cls += ' sat';
    if (isSun || holidayName) cls += ' sun';

    // [일정] 카테고리 항목 표시 (최대 3개)
    const schList = schedules[dateStr] || [];
    let schHtml = '';
    if (schList.length > 0) {
      const showSch = schList.slice(0, 3);
      schHtml = showSch.map(s => {
        const colorStyle = s.color ? ` style="background:${s.color}${s.completed ? ';opacity:0.45' : ''}"` : '';
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

    const holidayHtml = holidayName
      ? `<div class="monthly-holiday">${escHtml(holidayName)}</div>` : '';

    return `
      <div class="${cls}" data-date="${dateStr}" data-wk="${wkKey}">
        <div class="monthly-day-num">${day}</div>
        ${holidayHtml}
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

  // 날짜 셀 클릭 → 해당 주/일 뷰로 이동
  container.querySelectorAll('.monthly-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', async () => {
      const dateStr = cell.dataset.date;
      const wk      = cell.dataset.wk;
      S.weekKey     = wk;
      S.selectedDate = dateStr;
      await loadCurrentWeek();
      await switchView('weekly');
      // 모바일에서는 해당 날짜의 일간 탭으로 바로 이동
      if (window.matchMedia('(max-width: 600px)').matches) {
        switchMobileTab('daily');
      }
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

  // 모바일 바텀 탭 동기화
  if (isMonthly) {
    document.querySelectorAll('.mobile-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === 'monthly');
    });
  }

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


/* ── 주간 패널 렌더 → 노트북 트리 렌더 ─── */
function renderWeeklyPanel() {
  renderNotebookTree();
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
    noteEl.contentEditable = 'false';
    noteEl.innerHTML     = '';
    noteTime.textContent = '';
    _renderTaskMemoSection();
    return;
  }

  const wd = getWeek(S.weekKey);
  heading.textContent = fmtDateKo(S.selectedDate) + (S.selectedDate === todayStr() ? ' (오늘)' : '');
  noteEl.contentEditable = 'true';
  const savedNote = wd.dailyNotes[S.selectedDate] || '';
  const hasHtml = /<[a-z]/i.test(savedNote);
  noteEl.innerHTML = hasHtml
    ? savedNote
    : savedNote.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
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

  _setDateViewVisible(false);

  const heading = document.getElementById('detail-heading');
  const panel   = document.getElementById('panel-detail');

  let mpv = document.getElementById('memo-panel-view');
  if (!mpv) {
    mpv = document.createElement('div');
    mpv.id = 'memo-panel-view';
    mpv.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0';
    panel.appendChild(mpv);
  }
  mpv.style.display = 'flex';

  heading.textContent = memo.title || memoTypeLabel(memo.type);

  // 이전 형식 마이그레이션: text → boxes
  if (!Array.isArray(memo.boxes)) {
    if (memo.text) {
      const hasHtml = /<[a-z]/i.test(memo.text);
      const textContent = hasHtml ? memo.text
        : memo.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      memo.boxes = [makeBox('text', 20, 20, { content: textContent, w: 500, boxTitle: '내용' })];
    } else {
      memo.boxes = [];
    }
  }
  // 이전 필기(drawingData) → 이미지 박스로 변환
  if (memo.hasDrawing && memo.drawingData && !memo.boxes.find(b => b._fromDrawing)) {
    const yOff = memo.boxes.length > 0 ? 220 : 20;
    memo.boxes.push(makeBox('image', 20, yOff, { content: memo.drawingData, boxTitle: '필기', w: 400, _fromDrawing: true }));
    memo.hasDrawing = false;
  }

  const typeColors = {
    general: { bg:'var(--bg3)',  color:'var(--text2)',        border:'var(--border2)' },
    work:    { bg:'rgba(176,120,32,0.1)', color:'var(--c-medium)', border:'rgba(176,120,32,0.3)' },
    meeting: { bg:'rgba(85,102,170,0.1)',color:'var(--c-carryover)',border:'rgba(85,102,170,0.3)' },
    note:    { bg:'rgba(46,122,62,0.1)', color:'var(--c-low)',  border:'rgba(46,122,62,0.3)' }
  };
  const tc = typeColors[memo.type] || typeColors.general;

  mpv.innerHTML = `
    <div style="padding:0.4rem 1rem 0;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;flex-shrink:0">
      <span style="font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:4px;border:1px solid ${tc.border};background:${tc.bg};color:${tc.color}">${memoTypeLabel(memo.type)}</span>
      <button id="mpv-back-btn" style="margin-left:auto;font-size:0.78rem;padding:0.2rem 0.6rem;border-radius:var(--radius);background:var(--bg3);color:var(--text2);border:1px solid var(--border);cursor:pointer">← 날짜 보기</button>
    </div>
    <div style="padding:0.4rem 1rem 0;flex-shrink:0">
      <input id="mpv-title" type="text" value="${escHtml(memo.title||'')}" placeholder="메모 제목..." style="font-size:0.95rem;font-weight:600;border:none;border-bottom:1.5px solid transparent;border-radius:0;background:transparent;padding:0.2rem 0;width:100%;transition:border-color 0.15s">
    </div>
    <div class="nb-canvas-toolbar" id="mpv-cv-toolbar" style="flex-shrink:0">
      <button class="nb-tool-btn nb-btn-add-box" id="mpv-add-text" title="텍스트 박스 추가">📝 텍스트 박스</button>
      <button class="nb-tool-btn nb-btn-add-box" id="mpv-add-img" title="이미지 박스 추가">🖼 이미지 박스</button>
      <button class="nb-tool-btn nb-btn-add-box" id="mpv-add-table" title="표 추가">📊 표</button>
      <input type="file" id="mpv-cv-img" accept="image/*" style="display:none">
      <span class="toolbar-divider"></span>
      <button class="nb-tool-btn" data-cmd="insertLineBreak" title="줄바꿈 삽입">↵ 줄바꿈</button>
      <button class="nb-tool-btn" data-cmd="delete" title="한 글자 지우기">⌫ 지우기</button>
      <button class="nb-tool-btn" data-cmd="insertSpace" title="스페이스 삽입">␣ 스페이스</button>
      <span class="toolbar-divider"></span>
      <span class="nb-fmt-label">서식</span>
      <button class="nb-tool-btn" data-cmd="bold"><b>B</b></button>
      <button class="nb-tool-btn nb-tool-italic" data-cmd="italic">I</button>
      <button class="nb-tool-btn nb-tool-underline" data-cmd="underline">U</button>
      <button class="nb-tool-btn" data-cmd="block-h1">H1</button>
      <button class="nb-tool-btn" data-cmd="block-h2">H2</button>
      <button class="nb-tool-btn" data-cmd="block-h3">H3</button>
      <button class="nb-tool-btn" data-cmd="insertUnorderedList">•</button>
      <button class="nb-tool-btn" data-cmd="insertOrderedList">1.</button>
      <span class="toolbar-divider"></span>
      <span class="toolbar-label">글자색</span>
      <button class="nb-tool-btn" data-cmd="foreColor" data-val="#111111" style="color:#111111;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;line-height:22px;text-align:center;padding:0" title="검정">A</button>
      <button class="nb-tool-btn" data-cmd="foreColor" data-val="#cc3333" style="color:#cc3333;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;line-height:22px;text-align:center;padding:0" title="빨강">A</button>
      <button class="nb-tool-btn" data-cmd="foreColor" data-val="#3355cc" style="color:#3355cc;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;line-height:22px;text-align:center;padding:0" title="파랑">A</button>
      <button class="nb-tool-btn" data-cmd="foreColor" data-val="#339944" style="color:#339944;background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.75rem;font-weight:700;line-height:22px;text-align:center;padding:0" title="초록">A</button>
      <span class="toolbar-divider"></span>
      <span class="toolbar-label">형광펜</span>
      <button class="nb-tool-btn" data-cmd="hiliteColor" data-val="#ffff00" style="background:#ffff00;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;padding:0" title="노랑"></button>
      <button class="nb-tool-btn" data-cmd="hiliteColor" data-val="#90ee90" style="background:#90ee90;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;padding:0" title="연두"></button>
      <button class="nb-tool-btn" data-cmd="hiliteColor" data-val="#87ceeb" style="background:#87ceeb;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;padding:0" title="하늘"></button>
      <button class="nb-tool-btn" data-cmd="hiliteColor" data-val="#ffb6c1" style="background:#ffb6c1;border:1px solid #ccc;border-radius:3px;width:22px;height:22px;padding:0" title="분홍"></button>
      <button class="nb-tool-btn" data-cmd="hiliteColor" data-val="transparent" style="background:var(--bg3);border:1px solid var(--border);border-radius:3px;width:22px;height:22px;font-size:0.6rem;line-height:22px;text-align:center;padding:0" title="지우기">✕</button>
    </div>
    <div class="nb-canvas-hint">빈 공간을 클릭하면 새 텍스트 박스가 생성됩니다</div>
    <div class="nb-canvas" id="mpv-cv" style="flex:1;min-height:500px"></div>
    <div style="flex-shrink:0;padding:0.5rem 1rem;border-top:1px solid var(--border);display:flex;align-items:center;gap:0.5rem;background:var(--bg)">
      <button id="mpv-save" class="btn-primary">저장</button>
      <span id="mpv-save-time" style="font-size:0.75rem;color:var(--text3)">${memo.updatedAt ? '저장: ' + fmtShort(memo.updatedAt) : ''}</span>
    </div>
  `;

  // _cvCtx 설정 (메모 캔버스 모드)
  _cvCtx.page       = memo;
  _cvCtx.saveFn     = scheduleMpvSave;
  _cvCtx.canvasId   = 'mpv-cv';
  _cvCtx.imgInputId = 'mpv-cv-img';

  renderNbCanvas(memo.boxes || []);

  // 이벤트 바인딩
  document.getElementById('mpv-back-btn').addEventListener('click', () => {
    saveMpvContent();
    _panelMode = 'date'; _panelMemoId = null;
    _cvCtx.page = null; _cvCtx.saveFn = () => {};
    renderDetailPanel();
  });

  document.getElementById('mpv-title').addEventListener('focus', e => { e.target.style.borderBottomColor = 'var(--accent2)'; });
  document.getElementById('mpv-title').addEventListener('blur',  e => { e.target.style.borderBottomColor = 'transparent'; });
  document.getElementById('mpv-title').addEventListener('input', () => scheduleMpvSave());

  document.getElementById('mpv-save').addEventListener('click', () => saveMpvContent());

  // 툴바 mousedown (포커스 유지)
  document.getElementById('mpv-cv-toolbar').addEventListener('mousedown', e => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    nbExecCmd(btn.dataset.cmd, btn.dataset.val);
  });

  // 텍스트 박스 추가
  document.getElementById('mpv-add-text').addEventListener('click', () => {
    const cnt = (memo.boxes || []).length;
    addNbCanvasBox('text', 30 + (cnt % 6) * 25, 30 + cnt * 18);
  });

  // 이미지 박스 추가
  document.getElementById('mpv-add-img').addEventListener('click', () => {
    const inp = document.getElementById('mpv-cv-img');
    delete inp.dataset.boxId;
    inp.click();
  });

  // 표 박스 추가
  document.getElementById('mpv-add-table').addEventListener('click', () => {
    const cnt = (memo.boxes || []).length;
    addNbCanvasBox('table', 30 + (cnt % 4) * 30, 30 + cnt * 20);
  });

  document.getElementById('mpv-cv-img').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const targetBoxId = e.target.dataset.boxId;
    const reader = new FileReader();
    reader.onload = ev => {
      const src = ev.target.result;
      if (targetBoxId) {
        const box = memo.boxes?.find(b => b.id === targetBoxId);
        if (box) {
          box.content = src;
          const el = document.getElementById('nb-box-' + targetBoxId);
          if (el) {
            const body = el.querySelector('.nb-box-body');
            body.innerHTML = '';
            const img = document.createElement('img');
            img.src = src; img.className = 'nb-box-img';
            body.appendChild(img);
          }
          scheduleMpvSave();
        }
      } else {
        const cnt = (memo.boxes || []).length;
        addNbCanvasBox('image', 30 + (cnt % 4) * 40, 30 + cnt * 15, {
          content: src, boxTitle: file.name.replace(/.[^.]+$/, '') || '이미지', w: 320
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // 캔버스 클릭 → 텍스트 박스 생성
  document.getElementById('mpv-cv').addEventListener('click', e => {
    if (e.target.id !== 'mpv-cv') return;
    const rect = e.currentTarget.getBoundingClientRect();
    addNbCanvasBox('text', Math.max(10, e.clientX - rect.left - 10), Math.max(10, e.clientY - rect.top - 10));
  });
}

/* ── 필기노트 캔버스 저장 ─── */
let _mpvSaveTimer = null;
function scheduleMpvSave() {
  clearTimeout(_mpvSaveTimer);
  _mpvSaveTimer = setTimeout(saveMpvContent, 800);
}

async function saveMpvContent() {
  clearTimeout(_mpvSaveTimer);
  if (!_panelMemoId) return;
  const memo = S.memos[_panelMemoId] || await getMemo(_panelMemoId);
  if (!memo) return;

  const titleEl = document.getElementById('mpv-title');
  if (titleEl) memo.title = titleEl.value;

  if (Array.isArray(memo.boxes)) {
    memo.boxes.forEach(box => {
      const el = document.getElementById('nb-box-' + box.id);
      if (!el) return;
      box.x = parseInt(el.style.left)  || box.x;
      box.y = parseInt(el.style.top)   || box.y;
      box.w = parseInt(el.style.width) || box.w;
      const h = parseInt(el.style.height);
      box.h = isNaN(h) ? null : h;
      box.zIndex = parseInt(el.style.zIndex) || box.zIndex;
      const ts = el.querySelector('.nb-box-title');
      if (ts) box.boxTitle = ts.textContent.trim();
      const cd = el.querySelector('.nb-box-content');
      if (cd && box.type === 'text') box.content = cd.innerHTML;
      if (box.type === 'table') {
        const tbody = el.querySelector('.nb-table tbody');
        if (tbody) box.tableData = Array.from(tbody.rows).map(row => Array.from(row.cells).map(td => td.innerHTML));
      }
    });
  }

  memo.updatedAt = new Date().toISOString();
  await saveMemo(memo);

  const st = document.getElementById('mpv-save-time');
  if (st) st.textContent = '저장: ' + fmtShort(memo.updatedAt);
  const hd = document.getElementById('detail-heading');
  if (hd) hd.textContent = memo.title || memoTypeLabel(memo.type);
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

  const editBtn = `<button class="todo-action-btn edit" title="편집">✎</button>`;

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

  item.querySelector('.edit').addEventListener('click', e => {
    e.stopPropagation();
    if (type === 'daily') {
      openDailyTaskModal(weekKey, date, task.id);
    } else {
      openTaskModal(type, weekKey, date, task.id);
    }
  });

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

  // 날짜 변경 필드 (편집 시에만 표시)
  const dateInput = document.getElementById('dt-date-input');
  const dateGroup = document.getElementById('dt-date-group');
  dateInput.value = date || '';
  dateGroup.style.display = isNew ? 'none' : '';

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
  const CATEGORY_DEFAULT_COLOR = { '일정': '#3182ce', '약속': '#d69e2e' };
  const taskColor = (task && task.color) || (isNew ? (CATEGORY_DEFAULT_COLOR[document.getElementById('dt-category-select').value] || '') : '');
  colorChips.forEach(chip => {
    chip.classList.toggle('active', chip.dataset.color === taskColor);
  });

  // 분류 변경 시 색상 자동 세팅
  const categorySelect = document.getElementById('dt-category-select');
  const syncColorToCategory = () => {
    const defaultColor = CATEGORY_DEFAULT_COLOR[categorySelect.value];
    if (defaultColor) {
      colorChips.forEach(chip => chip.classList.toggle('active', chip.dataset.color === defaultColor));
    }
  };
  categorySelect.removeEventListener('change', categorySelect._colorSync);
  categorySelect._colorSync = syncColorToCategory;
  categorySelect.addEventListener('change', syncColorToCategory);

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

  const { weekKey, date: origDate, id } = S.dailyTaskEdit;
  const isNew = !id;

  // 날짜 변경 처리
  const dateInput = document.getElementById('dt-date-input');
  const newDate = (!isNew && dateInput.value) ? dateInput.value : origDate;
  const newWeekKey = getWeekKey(new Date(newDate + 'T00:00:00'));
  const dateChanged = !isNew && newDate !== origDate;

  let task;
  let linkedMemoId = null;

  if (!isNew) {
    const wd  = getWeek(weekKey);
    const src = (wd.dailyTodos[origDate] || []).find(t => t.id === id);
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
      weekKey:      newWeekKey,
      date:         newDate
    });
    await saveMemo(memo);
    task.linkedMemoId = memo.id;
    newMemoId = memo.id;
    linkedMemoId = memo.id;
  }

  hideModal('daily-task');

  // 날짜가 변경된 경우: 기존 날짜에서 삭제 후 새 날짜에 추가
  if (dateChanged) {
    if (!S.weeks[newWeekKey]) {
      const data = await dbGet('weeks', newWeekKey);
      S.weeks[newWeekKey] = data || makeWeekData(newWeekKey);
    }
    const oldWd = getWeek(weekKey);
    oldWd.dailyTodos[origDate] = (oldWd.dailyTodos[origDate] || []).filter(t => t.id !== id);
    await saveWeek(oldWd);
    await saveTask('daily', newWeekKey, newDate, task, true);
    showToast(`업무가 ${fmtDateKo(newDate)}로 이동되었습니다.`);
  } else {
    await saveTask('daily', newWeekKey, newDate, task, isNew);
    showToast(isNew ? '업무가 추가되었습니다.' : '업무가 수정되었습니다.');
  }

  if (openMemoAfter && newMemoId) {
    if (S.selectedDate !== newDate) selectDate(newDate);
    setTimeout(() => showMemoInPanel(newMemoId), 150);
  } else if (openMemoAfter && linkedMemoId) {
    if (S.selectedDate !== newDate) selectDate(newDate);
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
  const _wnt = document.getElementById('weekly-note-time');
  if (_wnt) _wnt.textContent = '저장: ' + fmtShort(wd.weeklyNoteAt);
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
  const reviewCount    = Object.keys(loadReviews()).length;
  const recordingCount = Object.keys(loadRecordings()).length;

  document.getElementById('export-info').innerHTML = `
    <div style="line-height:2; font-size:0.88rem;">
      <div><b>포함 주차:</b> ${allWeeks.length}주</div>
      <div><b>전체 업무 수:</b> ${totalTasks}개</div>
      <div><b>리뷰:</b> ${reviewCount}개</div>
      <div><b>녹음 기록:</b> ${recordingCount}개</div>
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
  const allWeeks     = await dbGetAll('weeks');
  const allMemos     = await dbGetAll('memos');
  const allNotebooks = await dbGetAll('notebooks');
  const allNbPages   = await dbGetAll('nb_pages');
  const payload  = {
    appVersion:  APP_VERSION,
    dataVersion: DATA_VERSION,
    exportedAt:  new Date().toISOString(),
    weeks:       allWeeks,
    memos:       allMemos,
    notebooks:   allNotebooks,
    nb_pages:    allNbPages,
    reviews:     loadReviews(),
    recordings:  loadRecordings(),
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

      const reviewCount    = data.reviews    ? Object.keys(data.reviews).length    : 0;
      const recordingCount = data.recordings ? Object.keys(data.recordings).length : 0;

      document.getElementById('import-preview').style.display = 'block';
      document.getElementById('import-preview').innerHTML = `
        <div style="line-height:1.9; color:var(--text);">
          <div>✅ 파일 유효성: 정상</div>
          <div><b>포함 주차:</b> ${data.weeks.length}주</div>
          <div><b>전체 업무 수:</b> ${totalTasks}개</div>
          <div><b>리뷰:</b> ${reviewCount}개</div>
          <div><b>녹음 기록:</b> ${recordingCount}개</div>
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

    // notebooks 지우고 재삽입
    await new Promise((res, rej) => { const tx = db.transaction('notebooks','readwrite'); tx.objectStore('notebooks').clear().onsuccess = res; tx.onerror = rej; });
    S.notebooks = {};
    if (Array.isArray(S.importPayload.notebooks)) {
      for (const nb of S.importPayload.notebooks) { await dbPut('notebooks', nb); S.notebooks[nb.id] = nb; }
    }
    // nb_pages 지우고 재삽입
    await new Promise((res, rej) => { const tx = db.transaction('nb_pages','readwrite'); tx.objectStore('nb_pages').clear().onsuccess = res; tx.onerror = rej; });
    S.nbPages = {};
    if (Array.isArray(S.importPayload.nb_pages)) {
      for (const p of S.importPayload.nb_pages) { await dbPut('nb_pages', p); S.nbPages[p.id] = p; }
    }

    // reviews 복원 (localStorage)
    saveReviews(S.importPayload.reviews || {});

    // recordings 복원 (localStorage)
    saveRecordings(S.importPayload.recordings || {});

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

    // 병합 — reviews (ID 충돌 없는 것만)
    if (S.importPayload.reviews && typeof S.importPayload.reviews === 'object') {
      const existingRv = loadReviews();
      let rvChanged = false;
      Object.entries(S.importPayload.reviews).forEach(([id, rv]) => {
        if (!existingRv[id]) { existingRv[id] = rv; rvChanged = true; }
      });
      if (rvChanged) saveReviews(existingRv);
    }

    // 병합 — recordings (ID 충돌 없는 것만)
    if (S.importPayload.recordings && typeof S.importPayload.recordings === 'object') {
      const existingRec = loadRecordings();
      let recChanged = false;
      Object.entries(S.importPayload.recordings).forEach(([id, rec]) => {
        if (!existingRec[id]) { existingRec[id] = rec; recChanged = true; }
      });
      if (recChanged) saveRecordings(existingRec);
    }

    // 병합 — notebooks (ID 충돌 없는 것만)
    if (Array.isArray(S.importPayload.notebooks)) {
      for (const nb of S.importPayload.notebooks) {
        if (!S.notebooks[nb.id] && !await dbGet('notebooks', nb.id)) {
          await dbPut('notebooks', nb); S.notebooks[nb.id] = nb;
        }
      }
    }
    // 병합 — nb_pages (ID 충돌 없는 것만)
    if (Array.isArray(S.importPayload.nb_pages)) {
      for (const p of S.importPayload.nb_pages) {
        if (!S.nbPages[p.id] && !await dbGet('nb_pages', p.id)) {
          await dbPut('nb_pages', p); S.nbPages[p.id] = p;
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
  if (RV.reviewPageVisible) renderReviewPage();
  if (REC.pageVisible) renderSavedRecList();
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
  // 월간 탭: switchView가 전환 및 탭 상태 동기화 담당
  if (tab === 'monthly') {
    switchView('monthly');
    return;
  }

  // 다른 탭으로 전환 시 월간 뷰에서 빠져나옴
  if (S.viewMode === 'monthly') {
    switchView('weekly');
  }

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

  // 주간 업무 모달 저장
  document.getElementById('btn-task-save').addEventListener('click', onTaskSave);
  document.getElementById('task-text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onTaskSave(); }
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
    if (e.key === 'Enter' && e.ctrlKey && !e.isComposing) { e.preventDefault(); onDailyTaskSave(false); }
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

  document.getElementById('btn-dt-space').addEventListener('click', () => {
    const ta = document.getElementById('dt-text-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + ' ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
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

  document.getElementById('btn-task-memo-space').addEventListener('click', () => {
    const ta = document.getElementById('task-memo-input');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + ' ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
    ta.focus();
  });

  // 우측 패널 일간 메모 툴바 버튼 (contenteditable)
  const dnFocus = () => document.getElementById('daily-note').focus();

  document.getElementById('btn-daily-note-newline').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('btn-daily-note-newline').addEventListener('click', () => {
    dnFocus(); document.execCommand('insertLineBreak');
  });
  document.getElementById('btn-daily-note-backspace').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('btn-daily-note-backspace').addEventListener('click', () => {
    dnFocus(); document.execCommand('delete');
  });
  document.getElementById('btn-daily-note-space').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('btn-daily-note-space').addEventListener('click', () => {
    dnFocus(); document.execCommand('insertText', false, ' ');
  });

  // 이미지 파일 삽입
  document.getElementById('btn-daily-note-img').addEventListener('click', () => {
    document.getElementById('daily-note-img-input').click();
  });
  document.getElementById('daily-note-img-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = document.createElement('img');
      img.src = ev.target.result;
      img.style.cssText = 'max-width:100%;height:auto;display:block;margin:0.5rem 0;border-radius:4px;';
      img.alt = file.name;
      const el = document.getElementById('daily-note');
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(img);
      }
      debounceNote('daily-' + S.selectedDate, () => saveDailyNote(S.selectedDate, el.innerHTML));
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // 글자색 / 형광펜
  document.querySelectorAll('.dn-fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      dnFocus();
      document.execCommand('styleWithCSS', false, true);
      if (btn.dataset.action === 'color') {
        document.execCommand('foreColor', false, btn.dataset.value);
      } else if (btn.dataset.action === 'highlight') {
        document.execCommand('hiliteColor', false, btn.dataset.value === 'transparent' ? 'transparent' : btn.dataset.value);
      }
    });
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

  document.getElementById('btn-memo-space').addEventListener('click', () => {
    const ta = document.getElementById('memo-modal-text');
    const s = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + ' ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = s + 1;
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

  // 주간 메모 자동 저장 (요소가 없으면 스킵)
  document.getElementById('weekly-note')?.addEventListener('input', e => {
    debounceNote('weekly', () => saveWeeklyNote(e.target.value));
  });

  // 일간 메모 자동 저장
  document.getElementById('daily-note').addEventListener('input', e => {
    debounceNote('daily-' + S.selectedDate, () => saveDailyNote(S.selectedDate, e.target.innerHTML));
  });

  // 일간 메모 이미지 붙여넣기 (Ctrl+V)
  document.getElementById('daily-note').addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = ev => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.cssText = 'max-width:100%;height:auto;display:block;margin:0.5rem 0;border-radius:4px;';
          img.alt = '붙여넣은 이미지';
          const el = document.getElementById('daily-note');
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
            range.setStartAfter(img);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            el.appendChild(img);
          }
          debounceNote('daily-' + S.selectedDate, () => saveDailyNote(S.selectedDate, el.innerHTML));
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  });


  // 테마 전환
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // 백업/복원 버튼
  document.getElementById('btn-export').addEventListener('click', openExportModal);
  document.getElementById('btn-export-confirm').addEventListener('click', doExport);
  document.getElementById('btn-import').addEventListener('click', openImportModal);
  document.getElementById('btn-import-confirm').addEventListener('click', doImport);
  document.getElementById('import-file-input').addEventListener('change', onImportFileChange);

  // 모바일 더보기 메뉴
  const moreBtn = document.getElementById('btn-mobile-more');
  const moreMenu = document.getElementById('mobile-more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      moreMenu.classList.toggle('hidden');
    });
    document.getElementById('mm-export').addEventListener('click', () => {
      moreMenu.classList.add('hidden');
      openExportModal();
    });
    document.getElementById('mm-import').addEventListener('click', () => {
      moreMenu.classList.add('hidden');
      openImportModal();
    });
    document.addEventListener('click', () => moreMenu.classList.add('hidden'));
  }

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
    if (e.isComposing) return;
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

  // 일간 메모 & 노트 패널: 이미지 클릭 → 리사이즈 바
  document.addEventListener('click', e => {
    if (e.target.tagName === 'IMG') {
      const container = e.target.closest('#daily-note, #mpv-text');
      if (container) {
        _showImgResizeBar(e.target, container);
        return;
      }
    }
    // 리사이즈 바 바깥 클릭 시 닫기
    if (_irb.el && !_irb.el.contains(e.target) && e.target !== _irb.img) {
      _hideImgResizeBar();
    }
  });
}

/* ── 이미지 리사이즈 바 ────────────────────────────────────────── */

let _irb = { el: null, img: null };

function _getImgWidthPct(img, container) {
  if (img.style.width && img.style.width.endsWith('%')) {
    return Math.min(100, Math.max(10, parseInt(img.style.width)));
  }
  const cw = container.clientWidth;
  const iw = img.offsetWidth;
  if (!cw || !iw) return 100;
  return Math.min(100, Math.max(10, Math.round((iw / cw) * 100)));
}

function _showImgResizeBar(img, container) {
  _hideImgResizeBar();
  _irb.img = img;
  img.classList.add('img-selected');

  const pct = _getImgWidthPct(img, container);

  const bar = document.createElement('div');
  bar.id = 'img-resize-bar';
  bar.className = 'img-resize-bar';
  bar.innerHTML = `
    <span class="irb-label">이미지 크기</span>
    <input type="range" min="10" max="100" step="5" value="${pct}" aria-label="이미지 크기">
    <span class="irb-pct">${pct}%</span>
    <span class="irb-sep"></span>
    <div class="irb-presets">
      <button class="irb-preset${pct <= 30 ? ' active' : ''}" data-pct="25">소</button>
      <button class="irb-preset${pct > 30 && pct <= 60 ? ' active' : ''}" data-pct="50">중</button>
      <button class="irb-preset${pct > 60 && pct < 95 ? ' active' : ''}" data-pct="75">대</button>
      <button class="irb-preset${pct >= 95 ? ' active' : ''}" data-pct="100">원본</button>
    </div>
    <span class="irb-sep"></span>
    <button class="irb-del">삭제</button>
  `;
  document.body.appendChild(bar);
  _irb.el = bar;

  const slider  = bar.querySelector('input[type="range"]');
  const pctEl   = bar.querySelector('.irb-pct');
  const presets = bar.querySelectorAll('.irb-preset');

  function applyPct(v) {
    const p = Math.min(100, Math.max(10, Number(v)));
    img.style.width    = p + '%';
    img.style.maxWidth = '100%';
    img.style.height   = 'auto';
    slider.value       = p;
    pctEl.textContent  = p + '%';
    presets.forEach(b => b.classList.toggle('active', Number(b.dataset.pct) === p));
    container.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  slider.addEventListener('input', () => applyPct(slider.value));
  presets.forEach(btn => btn.addEventListener('click', () => applyPct(btn.dataset.pct)));
  bar.querySelector('.irb-del').addEventListener('click', () => {
    img.remove();
    _hideImgResizeBar();
    container.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

function _hideImgResizeBar() {
  if (_irb.img) _irb.img.classList.remove('img-selected');
  if (_irb.el)  _irb.el.remove();
  _irb = { el: null, img: null };
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
    await loadNotebooks();

    bindEvents();
    bindNotebookEvents();

    if (window.innerWidth <= 900) switchMobileTab('weekly');

    renderAll();
    renderTrashPanel();

    // 첫 화면: 월간 달력
    S.monthKey = getMonthKey(new Date());
    await loadMonthWeeks(S.monthKey);
    await switchView('monthly');

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

/* =====================================================================
   REVIEW MODULE  ── localStorage key: "mono_reviews"
   ===================================================================== */

/* ── 리뷰 데이터 접근 ─────────────────────────────────────────────── */

const REVIEW_KEY = 'mono_reviews';

function loadReviews() {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}');
  } catch { return {}; }
}

function saveReviews(reviews) {
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews));
}

/* ── 상태 ────────────────────────────────────────────────────────── */

const RV = {
  filterType: 'all',          // 'all' | 'restaurant' | 'cafe' | 'travel' | 'book' | 'movie' | 'product'
  editId:     null,           // 편집 중인 리뷰 id, null = 신규
  starRating: 0,              // 현재 별점 (0.5 단위)
  images:     [],             // 첨부 이미지 base64 배열 (최대 3장, 식당 제외)
  reviewPageVisible: false,
};

/* ── 유틸 ────────────────────────────────────────────────────────── */

function rvTypeName(type) {
  const names = {
    restaurant: '🍽️ 식당', cafe: '☕ 카페', travel: '✈️ 여행',
    book: '📖 책', movie: '🎬 영화', product: '🛍️ 제품',
  };
  return names[type] || type;
}

function rvStarsFullHtml(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += rating >= i ? '★' : (rating >= i - 0.5 ? '★' : '☆');
  }
  return html;
}

/* ── 이미지 리사이즈 ─────────────────────────────────────────────── */

function _rvResizeImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function _rvSetImagesPreview() {
  const preview  = document.getElementById('rv-img-preview');
  const countEl  = document.getElementById('rv-img-count');
  const labelEl  = document.getElementById('rv-img-label');
  if (!preview) return;

  if (countEl) countEl.textContent = `${RV.images.length}/3`;
  if (labelEl) {
    labelEl.textContent = RV.images.length >= 3 ? '(최대 3장)' : '+ 사진 선택';
    labelEl.style.opacity = RV.images.length >= 3 ? '0.5' : '';
  }

  preview.innerHTML = '';
  RV.images.forEach((dataUrl, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'rv-img-thumb-wrap';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'rv-img-thumb';
    img.alt = `첨부 이미지 ${idx + 1}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rv-img-thumb-del';
    del.title = '삭제';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      RV.images.splice(idx, 1);
      _rvSetImagesPreview();
    });
    wrap.appendChild(img);
    wrap.appendChild(del);
    preview.appendChild(wrap);
  });
}

/* ── 리뷰 탭 전환 ────────────────────────────────────────────────── */

function showReviewPage() {
  // 노트 페이지가 열려 있으면 닫기 (NL은 이 함수보다 나중에 선언되지만 호출 시점엔 존재)
  if (typeof NL !== 'undefined' && NL.pageVisible) {
    document.getElementById('panel-notes-page').classList.add('hidden');
    document.getElementById('btn-notes-tab').classList.remove('active');
    NL.pageVisible = false;
  }
  RV.reviewPageVisible = true;
  document.getElementById('main-layout').classList.add('hidden');
  document.getElementById('bottom-panels').classList.add('hidden');
  document.getElementById('view-monthly').classList.add('hidden');
  document.getElementById('panel-review-page').classList.remove('hidden');
  document.getElementById('btn-review-tab').classList.add('active');
  renderReviewPage();
}

function hideReviewPage() {
  RV.reviewPageVisible = false;
  document.getElementById('panel-review-page').classList.add('hidden');
  document.getElementById('btn-review-tab').classList.remove('active');
  if (S.viewMode === 'monthly') {
    document.getElementById('view-monthly').classList.remove('hidden');
  } else {
    document.getElementById('main-layout').classList.remove('hidden');
    document.getElementById('bottom-panels').classList.remove('hidden');
  }
}

/* ── 리뷰 페이지 렌더 ────────────────────────────────────────────── */

function renderReviewPage() {
  const reviews = loadReviews();
  const grid    = document.getElementById('rv-card-grid');
  const empty   = document.getElementById('rv-empty');

  let list = Object.values(reviews);
  if (RV.filterType !== 'all') list = list.filter(r => r.type === RV.filterType);
  list.sort((a, b) => b.createdAt - a.createdAt);

  grid.innerHTML = '';
  if (list.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const TYPE_EMOJI = {
    restaurant: '🍽️', cafe: '☕', travel: '✈️',
    book: '📖', movie: '🎬', product: '🛍️',
  };

  list.forEach(r => {
    const card = document.createElement('div');
    card.className = 'rv-card';
    const thumb = r.images?.[0] || r.imageData || null;
    card.innerHTML = `
      <div class="rv-card-thumb-wrap">
        ${thumb
          ? `<img class="rv-card-thumb" src="${thumb}" alt="${escHtml(r.title)}">`
          : `<div class="rv-card-no-thumb">${TYPE_EMOJI[r.type] || '⭐'}</div>`}
        <div class="rv-card-thumb-badge">
          <span class="rv-badge rv-badge-${r.type}">${rvTypeName(r.type)}</span>
        </div>
      </div>
      <div class="rv-card-body">
        <div class="rv-card-title" title="${escHtml(r.title)}">${escHtml(r.title)}</div>
        <div class="rv-card-meta">
          ${r.rating > 0 ? `<span class="rv-card-stars">${rvStarsFullHtml(r.rating)}</span><span>${r.rating}</span>` : ''}
          <span>${escHtml(r.date || '')}</span>
        </div>
        ${r.shortReview ? `<div class="rv-card-short">"${escHtml(r.shortReview)}"</div>` : ''}
        <div class="rv-card-actions">
          <button class="rv-btn-edit" data-id="${r.id}">수정</button>
          <button class="rv-btn-delete" data-id="${r.id}">삭제</button>
        </div>
      </div>
    `;
    card.querySelector('.rv-btn-edit').addEventListener('click', () => openReviewModal(null, r.id));
    card.querySelector('.rv-btn-delete').addEventListener('click', () => deleteReview(r.id));
    grid.appendChild(card);
  });
}

/* ── 리뷰 모달 열기 ──────────────────────────────────────────────── */

function openReviewModal(prefillDate, editId) {
  RV.editId     = editId || null;
  RV.starRating = 0;
  RV.images     = [];

  const titleEl    = document.getElementById('rv-title-input');
  const dateEl     = document.getElementById('rv-date-input');
  const shortEl    = document.getElementById('rv-short-input');
  const contentEl  = document.getElementById('rv-content-input');
  const withEl     = document.getElementById('rv-with-input');
  const locationEl = document.getElementById('rv-location-input');
  const offRateEl  = document.getElementById('rv-official-rating-input');
  const heading    = document.getElementById('modal-rv-title');

  // 공통 필드 초기화
  titleEl.value    = '';
  shortEl.value    = '';
  contentEl.value  = '';
  withEl.value     = '';
  locationEl.value = '';
  offRateEl.value  = '';
  dateEl.value     = prefillDate || todayStr();
  heading.textContent = editId ? '리뷰 수정' : '리뷰 작성';

  // 여행 전용 필드 초기화
  document.getElementById('rv-travel-place-input').value  = '';
  document.getElementById('rv-travel-with-input').value   = '';
  document.getElementById('rv-travel-start-input').value  = '';
  document.getElementById('rv-travel-end-input').value    = '';

  // 제품 전용 필드 초기화
  document.getElementById('rv-product-brand-input').value = '';
  document.getElementById('rv-product-store-input').value = '';
  document.getElementById('rv-product-price-input').value = '';

  rvSetType('restaurant');  // 기본 타입 + 이미지 프리뷰 초기화

  if (editId) {
    const reviews = loadReviews();
    const r = reviews[editId];
    if (r) {
      rvSetType(r.type);
      titleEl.value   = r.title       || '';
      dateEl.value    = r.date        || todayStr();
      shortEl.value   = r.shortReview || '';
      contentEl.value = r.content     || '';
      RV.starRating   = r.rating      || 0;

      // 이미지 로드 (하위 호환: 구 imageData 필드도 지원)
      RV.images = Array.isArray(r.images) ? [...r.images]
                : (r.imageData ? [r.imageData] : []);
      _rvSetImagesPreview();

      // 식당/카페 공통 필드
      if (['restaurant', 'cafe'].includes(r.type)) {
        withEl.value     = (r.with || []).join(', ');
        locationEl.value = r.location || '';
        offRateEl.value  = r.officialRating != null ? r.officialRating : '';
      }

      // 여행 전용 필드
      if (r.type === 'travel') {
        document.getElementById('rv-travel-place-input').value  = r.location    || '';
        document.getElementById('rv-travel-with-input').value   = (r.with || []).join(', ');
        document.getElementById('rv-travel-start-input').value  = r.travelStart || r.date || '';
        document.getElementById('rv-travel-end-input').value    = r.travelEnd   || '';
      }

      // 제품 전용 필드
      if (r.type === 'product') {
        document.getElementById('rv-product-brand-input').value = r.brand || '';
        document.getElementById('rv-product-store-input').value = r.store || '';
        document.getElementById('rv-product-price-input').value = r.price != null ? r.price : '';
      }
    }
  }

  rvRenderStars(RV.starRating);
  showModal('review');
}

/* ── 타입 세그먼트 변경 ──────────────────────────────────────────── */

function rvSetType(type) {
  document.querySelectorAll('.rv-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  // 식당/카페 공통 필드
  const restCafeFields = document.getElementById('rv-rest-cafe-fields');
  if (restCafeFields) {
    restCafeFields.style.display = ['restaurant', 'cafe'].includes(type) ? '' : 'none';
    const lbl = restCafeFields.querySelector('.form-divider span');
    if (lbl) lbl.textContent = type === 'cafe' ? '카페 추가 정보' : '식당 추가 정보';
  }

  // 여행 전용 필드
  const travelFields = document.getElementById('rv-travel-fields');
  if (travelFields) travelFields.style.display = type === 'travel' ? '' : 'none';

  // 제품 전용 필드
  const productFields = document.getElementById('rv-product-fields');
  if (productFields) productFields.style.display = type === 'product' ? '' : 'none';

}

function rvCurrentType() {
  return document.querySelector('.rv-type-btn.active')?.dataset.type || 'restaurant';
}

/* ── 별점 렌더 & 인터랙션 ────────────────────────────────────────── */

// DOM은 한 번만 생성하고, 이후엔 _rvUpdateStarDisplay로만 상태 갱신
function rvRenderStars(initialRating) {
  RV.starRating = initialRating;
  const container = document.getElementById('rv-stars');
  container.innerHTML = '';

  function updateDisplay(displayRating) {
    container.querySelectorAll('span').forEach((s, idx) => {
      const full = idx + 1;
      const half = full - 0.5;
      s.textContent = displayRating >= full ? '★' : (displayRating >= half ? '★' : '☆');
      s.classList.toggle('lit', displayRating >= half);
    });
    document.getElementById('rv-star-num').textContent = displayRating > 0 ? displayRating : '0';
  }

  for (let i = 1; i <= 5; i++) {
    const half = i - 0.5;
    const star = document.createElement('span');
    star.textContent = '☆';

    star.addEventListener('mouseenter', e => {
      const rect   = star.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width / 2;
      updateDisplay(isLeft ? half : i);
    });

    star.addEventListener('click', e => {
      const rect   = star.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width / 2;
      RV.starRating = isLeft ? half : i;
      updateDisplay(RV.starRating);
    });

    container.appendChild(star);
  }

  container.addEventListener('mouseleave', () => updateDisplay(RV.starRating));
  updateDisplay(initialRating);
}

/* ── 리뷰 저장 ───────────────────────────────────────────────────── */

async function saveReview() {
  const titleEl = document.getElementById('rv-title-input');
  const dateEl  = document.getElementById('rv-date-input');
  const title   = titleEl.value.trim();
  const date    = dateEl.value.trim();

  if (!title) { titleEl.focus(); showToast('제목을 입력해주세요.'); return; }
  if (!date)  { dateEl.focus();  showToast('날짜를 입력해주세요.'); return; }

  const type       = rvCurrentType();
  const isRestCafe = ['restaurant', 'cafe'].includes(type);
  const now        = Date.now();
  const id         = RV.editId || `rev_${now}`;
  const reviews    = loadReviews();
  const existing   = reviews[id] || {};

  const r = {
    id,
    type,
    title,
    date,
    rating:      RV.starRating,
    shortReview: document.getElementById('rv-short-input').value.trim(),
    content:     document.getElementById('rv-content-input').value.trim(),
    images:      [...RV.images],
    with: isRestCafe
      ? document.getElementById('rv-with-input').value.split(',').map(s => s.trim()).filter(Boolean)
      : type === 'travel'
        ? document.getElementById('rv-travel-with-input').value.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    location: isRestCafe
      ? document.getElementById('rv-location-input').value.trim()
      : type === 'travel'
        ? document.getElementById('rv-travel-place-input').value.trim()
        : '',
    officialRating: isRestCafe && document.getElementById('rv-official-rating-input').value !== ''
      ? parseFloat(document.getElementById('rv-official-rating-input').value) : null,
    travelStart: type === 'travel' ? (document.getElementById('rv-travel-start-input').value || null) : null,
    travelEnd:   type === 'travel' ? (document.getElementById('rv-travel-end-input').value   || null) : null,
    brand: type === 'product' ? document.getElementById('rv-product-brand-input').value.trim() : '',
    store: type === 'product' ? document.getElementById('rv-product-store-input').value.trim() : '',
    price: type === 'product' && document.getElementById('rv-product-price-input').value !== ''
      ? parseInt(document.getElementById('rv-product-price-input').value, 10) : null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };

  reviews[id] = r;
  saveReviews(reviews);
  hideModal('review');
  showToast(RV.editId ? '리뷰가 수정되었습니다.' : '리뷰가 저장되었습니다.');

  if (RV.reviewPageVisible) renderReviewPage();
  _rvRefreshDailyPanel();
  if (S.viewMode === 'monthly') _rvRefreshMonthly();
}

/* ── 리뷰 삭제 ───────────────────────────────────────────────────── */

async function deleteReview(id) {
  const ok = await showConfirm('리뷰 삭제', '이 리뷰를 삭제하시겠습니까?');
  if (!ok) return;
  const reviews = loadReviews();
  delete reviews[id];
  saveReviews(reviews);
  showToast('리뷰가 삭제되었습니다.');
  if (RV.reviewPageVisible) renderReviewPage();
  _rvRefreshDailyPanel();
  if (S.viewMode === 'monthly') _rvRefreshMonthly();
}

/* ── 일간 패널: 날짜 헤더에 리뷰 버튼/뱃지 주입 ─────────────────── */

function _injectDayCardReviewUI() {
  const reviews = loadReviews();
  const byDate  = {};
  for (const r of Object.values(reviews)) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  document.querySelectorAll('.day-card').forEach(card => {
    const dateStr    = card.dataset.date;
    if (!dateStr) return;
    const header     = card.querySelector('.day-card-header');
    const body       = card.querySelector('.day-card-body');
    if (!header) return;

    /* ── 헤더: 리뷰 버튼 ── */
    if (!header.querySelector('.day-rv-btn')) {
      const btn = document.createElement('button');
      btn.className   = 'day-rv-btn';
      btn.textContent = '리뷰';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openReviewModal(dateStr, null);
      });
      header.appendChild(btn);
    }

    const dayReviews = byDate[dateStr];
    if (!dayReviews || dayReviews.length === 0) return;

    /* ── 헤더: ★N 뱃지 ── */
    if (!header.querySelector('.day-rv-badge')) {
      const badge = document.createElement('span');
      badge.className   = 'day-rv-badge';
      badge.title       = dayReviews.map(rv => rv.title).join(', ');
      badge.textContent = `★${dayReviews.length}`;
      header.appendChild(badge);
    }

    /* ── 본문: 리뷰 아이템 추가 ── */
    if (!body) return;

    // 투두가 있으면 구분선 추가
    const hasTodos = body.querySelector('.todo-item, [data-id]');
    if (hasTodos) {
      const sep = document.createElement('hr');
      sep.className = 'rv-daily-sep';
      body.appendChild(sep);
    } else {
      // "업무 없음" 메시지 제거
      const emptyMsg = body.querySelector('.day-empty');
      if (emptyMsg) emptyMsg.remove();
    }

    dayReviews.forEach(rv => {
      const el = document.createElement('div');
      el.className = 'rv-daily-item';
      el.innerHTML = `
        <span class="rv-badge rv-badge-${rv.type} rv-badge-sm">${rvTypeName(rv.type)}</span>
        <span class="rv-daily-title">${escHtml(rv.title)}</span>
        <span class="rv-daily-stars">${rv.rating > 0 ? '★' + rv.rating : ''}</span>
      `;
      el.addEventListener('click', () => openReviewModal(null, rv.id));
      body.appendChild(el);
    });
  });
}

function _rvRefreshDailyPanel() {
  // daily panel이 보이는 경우에만 재렌더
  if (!document.getElementById('panel-daily').classList.contains('hidden') ||
      window.innerWidth > 900) {
    renderDailyPanel();
  }
}

/* ── 월간 달력: 리뷰 별 표시 주입 ───────────────────────────────── */

function _injectMonthlyReviewStars() {
  const reviews = loadReviews();
  const byDate  = {};    // date → 리뷰 배열 (★ 바용)
  const imgByDate = {};  // date → { img, createdAt } (배경 이미지용)

  const TYPE_COLOR = {
    restaurant: '#dd6b20', cafe: '#8B5E3C', travel: '#3182ce',
    book: '#2c5282', movie: '#805ad5', product: '#38a169',
  };
  const TYPE_ICON = {
    restaurant: '🍽️', cafe: '☕', travel: '✈️',
    book: '📖', movie: '🎬', product: '🛍️',
  };
  const MAX_SHOW = 2;

  for (const r of Object.values(reviews)) {
    // ★ 바: 리뷰 날짜에만 표시
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);

    // 배경 이미지: 식당 제외
    if (r.type === 'restaurant') continue;
    const imgs = r.images?.length ? r.images : (r.imageData ? [r.imageData] : []);
    if (!imgs.length) continue;

    // 여행: travelStart~travelEnd 범위 전체에 배경 적용
    const imageDates = [];
    if (r.type === 'travel' && r.travelStart) {
      const start = new Date(r.travelStart + 'T00:00:00');
      const end   = r.travelEnd ? new Date(r.travelEnd + 'T00:00:00') : start;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        imageDates.push(d.toISOString().slice(0, 10));
      }
    } else {
      imageDates.push(r.date);
    }

    for (const date of imageDates) {
      if (!imgByDate[date] || r.createdAt > imgByDate[date].createdAt) {
        imgByDate[date] = { img: imgs[0], createdAt: r.createdAt };
      }
    }
  }

  document.querySelectorAll('#view-monthly .monthly-cell[data-date]').forEach(cell => {
    const dateStr = cell.dataset.date;

    // ── 배경 이미지 주입 ──
    const imgData = imgByDate[dateStr];
    if (imgData && !cell.querySelector('.rv-cell-bg')) {
      cell.classList.add('rv-has-image');
      const bgDiv = document.createElement('div');
      bgDiv.className = 'rv-cell-bg';
      bgDiv.style.backgroundImage = `url(${imgData.img})`;
      const overlayDiv = document.createElement('div');
      overlayDiv.className = 'rv-cell-overlay';
      cell.insertBefore(overlayDiv, cell.firstChild);
      cell.insertBefore(bgDiv, cell.firstChild);
    }

    // ── 리뷰 ★ 바 주입 ──
    const list = byDate[dateStr];
    if (!list || list.length === 0) return;
    if (cell.querySelector('.rv-monthly-event')) return;  // 이미 주입됨

    const anchor = cell.querySelector('.monthly-dots, .monthly-week-hint');

    list.slice(0, MAX_SHOW).forEach(rv => {
      const bar = document.createElement('div');
      bar.className        = 'monthly-event rv-monthly-event';
      bar.style.background = TYPE_COLOR[rv.type] || '#888';
      bar.title            = `${rvTypeName(rv.type)}: ${rv.title}${rv.rating ? ' ★' + rv.rating : ''}`;
      bar.textContent      = `${TYPE_ICON[rv.type] || ''} ${rv.title}`;
      cell.insertBefore(bar, anchor || null);
    });

    if (list.length > MAX_SHOW) {
      const more = document.createElement('div');
      more.className   = 'monthly-event-more rv-monthly-event';
      more.textContent = `+${list.length - MAX_SHOW}개 리뷰`;
      cell.insertBefore(more, anchor || null);
    }
  });
}

function _rvRefreshMonthly() {
  renderMonthlyView();
}

/* ── 백업/복원: reviews 포함 버전 ────────────────────────────────── */

async function rvDoExport() {
  const allWeeks = await dbGetAll('weeks');
  const allMemos = await dbGetAll('memos');
  const payload  = {
    appVersion:  APP_VERSION,
    dataVersion: DATA_VERSION,
    exportedAt:  new Date().toISOString(),
    weeks:       allWeeks,
    memos:       allMemos,
    reviews:     loadReviews(),
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

async function rvDoImport() {
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
    await new Promise((resolve, reject) => {
      const tx  = db.transaction('weeks', 'readwrite');
      const req = tx.objectStore('weeks').clear();
      req.onsuccess = resolve; req.onerror = reject;
    });
    for (const w of S.importPayload.weeks) await dbPut('weeks', w);
    S.weeks = {};
    S.importPayload.weeks.forEach(w => { S.weeks[w.weekKey] = w; });

    await new Promise((resolve, reject) => {
      const tx  = db.transaction('memos', 'readwrite');
      const req = tx.objectStore('memos').clear();
      req.onsuccess = resolve; req.onerror = reject;
    });
    S.memos = {};
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) { await dbPut('memos', m); S.memos[m.id] = m; }
    }

    if (S.importPayload.reviews && typeof S.importPayload.reviews === 'object') {
      saveReviews(S.importPayload.reviews);
    }

  } else {
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
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) {
        if (!S.memos[m.id] && !await dbGet('memos', m.id)) {
          await dbPut('memos', m);
          S.memos[m.id] = m;
        }
      }
    }
    if (S.importPayload.reviews && typeof S.importPayload.reviews === 'object') {
      const existing = loadReviews();
      saveReviews(Object.assign({}, S.importPayload.reviews, existing));
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

/* ── 이벤트 바인딩 & 기존 함수 패치 ─────────────────────────────── */

function bindReviewEvents() {
  // ① renderDailyPanel 패치 (함수 변수 재할당)
  const _origRDP = renderDailyPanel;
  renderDailyPanel = function() { _origRDP(); _injectDayCardReviewUI(); }; // eslint-disable-line no-func-assign

  // ② renderMonthlyView 패치
  const _origRMV = renderMonthlyView;
  renderMonthlyView = function() { _origRMV(); _injectMonthlyReviewStars(); }; // eslint-disable-line no-func-assign

  // ③-a switchView 패치: 뷰 전환 시 리뷰 페이지 자동 닫기
  const _origSwitchView = switchView;
  switchView = async function(mode) { // eslint-disable-line no-func-assign
    if (RV.reviewPageVisible) hideReviewPage();
    return _origSwitchView(mode);
  };

  // ③-b switchMobileTab 패치: 비-리뷰 탭 클릭 시 리뷰 페이지 닫기
  const _origSMT = switchMobileTab;
  switchMobileTab = function(tab) { // eslint-disable-line no-func-assign
    if (tab !== 'review' && RV.reviewPageVisible) hideReviewPage();
    _origSMT(tab);
  };

  // ③ 헤더 리뷰 탭 버튼
  document.getElementById('btn-review-tab').addEventListener('click', () => {
    if (RV.reviewPageVisible) hideReviewPage();
    else showReviewPage();
  });

  // ⑤ 모바일 탭
  const mobileReviewTab = document.querySelector('.mobile-tab[data-tab="review"]');
  if (mobileReviewTab) {
    mobileReviewTab.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
      mobileReviewTab.classList.add('active');
      showReviewPage();
    });
  }

  // ⑥ 리뷰 작성 버튼
  document.getElementById('btn-rv-new').addEventListener('click', () => openReviewModal(null, null));

  // ⑦ 필터 탭
  document.querySelectorAll('.rv-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rv-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      RV.filterType = btn.dataset.type;
      renderReviewPage();
    });
  });

  // ⑧ 타입 버튼
  document.querySelectorAll('.rv-type-btn').forEach(btn => {
    btn.addEventListener('click', () => rvSetType(btn.dataset.type));
  });

  // ⑨ 저장 버튼
  document.getElementById('btn-rv-save').addEventListener('click', saveReview);

  // ⑩ 별점 + 이미지 초기 렌더
  rvRenderStars(0);
  _rvSetImagesPreview();

  // ⑪ 본문 툴바
  function rvInsertAtCursor(ta, text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
  }
  function rvBackspaceAtCursor(ta) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s !== e) {
      ta.value = ta.value.slice(0, s) + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s;
    } else if (s > 0) {
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s - 1;
    }
    ta.focus();
  }
  const rvContentTA = document.getElementById('rv-content-input');
  document.getElementById('rv-content-newline').addEventListener('click',    () => rvInsertAtCursor(rvContentTA, '\n'));
  document.getElementById('rv-content-backspace').addEventListener('click',  () => rvBackspaceAtCursor(rvContentTA));
  document.getElementById('rv-content-space').addEventListener('click',      () => rvInsertAtCursor(rvContentTA, ' '));

  // ⑫ 이미지 첨부 (멀티, 최대 3장)
  document.getElementById('rv-img-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    if (RV.images.length + files.length > 3) {
      showToast('최대 3장까지 첨부 가능합니다.');
      e.target.value = '';
      return;
    }
    for (const file of files) {
      if (RV.images.length >= 3) break;
      try {
        const dataUrl = await _rvResizeImage(file);
        RV.images.push(dataUrl);
      } catch {
        showToast('이미지를 불러올 수 없습니다.');
      }
    }
    e.target.value = '';
    _rvSetImagesPreview();
  });

  // ⑪ 첫 렌더 시 일간 패널에도 리뷰 UI 주입
  _injectDayCardReviewUI();
}

// DOMContentLoaded 완료 후 bindReviewEvents 실행 (init 이후)
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(bindReviewEvents, 0);
});

/* =====================================================================
   NOTES LIST MODULE  ── 필기노트 & 일간 메모 통합 목록
   ===================================================================== */

const NL = {
  filterType:  'all',   // 'all' | 'memo' | 'daily'
  pageVisible: false,
};

/* ── 메모 타입 표시명 ────────────────────────────────────────────── */

function nlMemoTypeName(type) {
  const map = { general: '일반', work: '업무', meeting: '회의', note: '필기장' };
  return map[type] || '메모';
}

/* ── HTML → 평문 변환 ────────────────────────────────────────────── */

function nlStripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

/* ── 노트 페이지 전환 ────────────────────────────────────────────── */

function showNotesPage() {
  // 리뷰 페이지가 열려 있으면 닫기
  if (RV.reviewPageVisible) {
    document.getElementById('panel-review-page').classList.add('hidden');
    document.getElementById('btn-review-tab').classList.remove('active');
    RV.reviewPageVisible = false;
  }
  NL.pageVisible = true;
  document.getElementById('main-layout').classList.add('hidden');
  document.getElementById('bottom-panels').classList.add('hidden');
  document.getElementById('view-monthly').classList.add('hidden');
  document.getElementById('panel-notes-page').classList.remove('hidden');
  document.getElementById('btn-notes-tab').classList.add('active');
  renderNotesPage();
}

function hideNotesPage() {
  NL.pageVisible = false;
  document.getElementById('panel-notes-page').classList.add('hidden');
  document.getElementById('btn-notes-tab').classList.remove('active');
  if (S.viewMode === 'monthly') {
    document.getElementById('view-monthly').classList.remove('hidden');
  } else {
    document.getElementById('main-layout').classList.remove('hidden');
    document.getElementById('bottom-panels').classList.remove('hidden');
  }
}

/* ── 노트 페이지 렌더 (async — DB 전체 로드) ─────────────────────── */

async function renderNotesPage() {
  const listEl  = document.getElementById('nl-list');
  const emptyEl = document.getElementById('nl-empty');
  const countEl = document.getElementById('nl-count');

  listEl.innerHTML  = '<p class="nl-loading">불러오는 중...</p>';
  emptyEl.classList.add('hidden');
  countEl.textContent = '';

  // 모든 주차 + 메모 병렬 로드
  const [allWeeks, allMemos] = await Promise.all([
    dbGetAll('weeks'),
    dbGetAll('memos'),
  ]);

  const items = [];

  /* 필기노트 수집 */
  if (NL.filterType !== 'daily') {
    allMemos.forEach(m => {
      const textPreview = nlStripHtml(m.text || '');
      if (!textPreview && !m.hasDrawing) return; // 실제 내용(텍스트 또는 필기)이 없는 메모 제외
      items.push({
        kind:       'memo',
        id:         m.id,
        date:       m.date || '',
        weekKey:    m.weekKey || getWeekKey(new Date((m.date || todayStr()) + 'T00:00:00')),
        title:      m.title || '(제목 없음)',
        preview:    textPreview.slice(0, 120),
        memoType:   m.type || 'general',
        hasDrawing: !!m.hasDrawing,
        sortKey:    m.updatedAt || m.createdAt || m.date || '',
      });
    });
  }

  /* 일간 메모 수집 */
  if (NL.filterType !== 'memo') {
    allWeeks.forEach(wd => {
      const notes = wd.dailyNotes || {};
      Object.entries(notes).forEach(([dateStr, noteHtml]) => {
        if (!noteHtml || !noteHtml.trim()) return;
        const plain = nlStripHtml(noteHtml);
        if (!plain) return;
        items.push({
          kind:    'daily',
          date:    dateStr,
          weekKey: getWeekKey(new Date(dateStr + 'T00:00:00')),
          title:   fmtDateKo(dateStr) + ' 메모',
          preview: plain.slice(0, 120),
          sortKey: dateStr,
        });
      });
    });
  }

  /* 최신순 정렬 */
  items.sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || ''));

  listEl.innerHTML = '';

  if (items.length === 0) {
    emptyEl.classList.remove('hidden');
    countEl.textContent = '';
    return;
  }

  countEl.textContent = `총 ${items.length}개`;
  emptyEl.classList.add('hidden');

  const frag = document.createDocumentFragment();
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'nl-card';

    if (item.kind === 'memo') {
      card.innerHTML = `
        <div class="nl-card-icon">📝</div>
        <div class="nl-card-body">
          <div class="nl-card-top">
            <span class="nl-badge nl-badge-memo">${nlMemoTypeName(item.memoType)}</span>
            ${item.hasDrawing ? '<span class="nl-badge nl-badge-drawing">✏ 필기</span>' : ''}
            <span class="nl-card-title" title="${escHtml(item.title)}">${escHtml(item.title)}</span>
          </div>
          <div class="nl-card-meta">${escHtml(item.date)}</div>
          ${item.preview ? `<div class="nl-card-preview">${escHtml(item.preview)}</div>` : ''}
        </div>
        <span class="nl-card-arrow">›</span>
      `;
    } else {
      card.innerHTML = `
        <div class="nl-card-icon">🗓</div>
        <div class="nl-card-body">
          <div class="nl-card-top">
            <span class="nl-badge nl-badge-daily">일간 메모</span>
            <span class="nl-card-title">${escHtml(item.title)}</span>
          </div>
          <div class="nl-card-meta">${escHtml(item.date)}</div>
          ${item.preview ? `<div class="nl-card-preview">${escHtml(item.preview)}</div>` : ''}
        </div>
        <span class="nl-card-arrow">›</span>
      `;
    }

    card.addEventListener('click', () => nlGoToItem(item));
    frag.appendChild(card);
  });

  listEl.appendChild(frag);
}

/* ── 항목 클릭 → 해당 주/날짜로 이동 ────────────────────────────── */

async function nlGoToItem(item) {
  hideNotesPage();

  const needWeekChange = item.weekKey && item.weekKey !== S.weekKey;

  if (needWeekChange) {
    S.weekKey      = item.weekKey;
    S.selectedDate = item.date || '';
    await loadCurrentWeek();
  }

  if (S.viewMode === 'monthly') {
    await switchView('weekly');
  } else if (needWeekChange) {
    renderAll();
    renderDetailPanel();
  }

  if (item.kind === 'memo') {
    await showMemoInPanel(item.id);
    if (window.innerWidth <= 900) switchMobileTab('detail');
  } else {
    selectDate(item.date);
    if (window.innerWidth <= 900) switchMobileTab('detail');
  }
}

/* ── 이벤트 바인딩 ───────────────────────────────────────────────── */

function bindNotesEvents() {
  /* switchView 패치: 뷰 전환 시 노트 페이지 자동 닫기 */
  const _svBeforeNL = switchView;
  switchView = async function(mode) { // eslint-disable-line no-func-assign
    if (NL.pageVisible) hideNotesPage();
    return _svBeforeNL(mode);
  };

  /* switchMobileTab 패치 */
  const _smtBeforeNL = switchMobileTab;
  switchMobileTab = function(tab) { // eslint-disable-line no-func-assign
    if (tab !== 'notes' && NL.pageVisible) hideNotesPage();
    _smtBeforeNL(tab);
  };

  /* 헤더 버튼 */
  document.getElementById('btn-notes-tab').addEventListener('click', () => {
    if (NL.pageVisible) hideNotesPage();
    else showNotesPage();
  });

  /* 모바일 탭 */
  const mobileNotesTab = document.querySelector('.mobile-tab[data-tab="notes"]');
  if (mobileNotesTab) {
    mobileNotesTab.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
      mobileNotesTab.classList.add('active');
      showNotesPage();
    });
  }

  /* 필터 탭 */
  document.querySelectorAll('.nl-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nl-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      NL.filterType = btn.dataset.type;
      renderNotesPage();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(bindNotesEvents, 0);
});

// ===== RECORDING MODULE =====

/* ── 상수 ────────────────────────────────────────────────────────── */
const REC_KEY        = 'mono_recordings';
const REC_API_KEY    = 'mono_claude_api_key';
const REC_MODEL      = 'claude-sonnet-4-5';

/* ── 상태 ────────────────────────────────────────────────────────── */
const REC = {
  pageVisible:    false,
  mediaRecorder:  null,
  audioChunks:    [],
  audioBlob:      null,
  audioUrl:       null,
  stream:         null,    // 마이크 스트림 (권한 재요청 방지용 재사용)
  recognition:    null,
  transcript:     '',      // 확정된 STT 텍스트
  isRecording:    false,
  timerInterval:  null,
  elapsedSeconds: 0,
  analysis:       null,    // { summary, decisions, actions }
  editId:         null,    // 불러온 기록의 id (저장 시 덮어씀)
};

/* ── localStorage 헬퍼 ───────────────────────────────────────────── */
function loadRecordings() {
  try { return JSON.parse(localStorage.getItem(REC_KEY) || '{}'); }
  catch { return {}; }
}
function saveRecordings(data) {
  localStorage.setItem(REC_KEY, JSON.stringify(data));
}
function loadApiKey()     { return localStorage.getItem(REC_API_KEY) || ''; }
function saveApiKey(key)  { localStorage.setItem(REC_API_KEY, key); }

/* ── 페이지 전환 ─────────────────────────────────────────────────── */
function showRecordingPage() {
  if (typeof NL !== 'undefined' && NL.pageVisible) {
    document.getElementById('panel-notes-page').classList.add('hidden');
    document.getElementById('btn-notes-tab').classList.remove('active');
    NL.pageVisible = false;
  }
  if (RV.reviewPageVisible) {
    document.getElementById('panel-review-page').classList.add('hidden');
    document.getElementById('btn-review-tab').classList.remove('active');
    RV.reviewPageVisible = false;
  }
  REC.pageVisible = true;
  document.getElementById('main-layout').classList.add('hidden');
  document.getElementById('bottom-panels').classList.add('hidden');
  document.getElementById('view-monthly').classList.add('hidden');
  document.getElementById('panel-recording-page').classList.remove('hidden');
  document.getElementById('btn-recording-tab').classList.add('active');
  recInitPage();
}

function hideRecordingPage(force = false) {
  if (REC.isRecording && !force) {
    showToast('녹음 중에는 탭을 이동할 수 없습니다. 정지 후 이동해주세요.');
    return;
  }
  if (REC.isRecording) recStopRecording();
  // 페이지를 완전히 닫을 때 마이크 스트림 해제
  if (REC.stream) {
    REC.stream.getTracks().forEach(t => t.stop());
    REC.stream = null;
  }
  REC.pageVisible = false;
  document.getElementById('panel-recording-page').classList.add('hidden');
  document.getElementById('btn-recording-tab').classList.remove('active');
  if (S.viewMode === 'monthly') {
    document.getElementById('view-monthly').classList.remove('hidden');
  } else {
    document.getElementById('main-layout').classList.remove('hidden');
    document.getElementById('bottom-panels').classList.remove('hidden');
  }
}

/* ── 페이지 초기화 ───────────────────────────────────────────────── */
function recInitPage() {
  recRenderApiKeyUI();
  recRenderSavedList();
  // STT 지원 여부 체크
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.getElementById('rec-stt-notice').classList.toggle('hidden', !!SpeechRecognition);
  // 날짜 기본값
  if (!document.getElementById('rec-date-input').value) {
    document.getElementById('rec-date-input').value = todayStr();
  }
}

/* ── API 키 UI ───────────────────────────────────────────────────── */
function recRenderApiKeyUI() {
  const key = loadApiKey();
  const inputWrap = document.getElementById('rec-api-input-wrap');
  const savedWrap = document.getElementById('rec-api-saved-wrap');
  if (key) {
    const masked = '••••••••••••' + key.slice(-4);
    document.getElementById('rec-api-masked').textContent = masked;
    inputWrap.classList.add('hidden');
    savedWrap.classList.remove('hidden');
  } else {
    inputWrap.classList.remove('hidden');
    savedWrap.classList.add('hidden');
  }
}

/* ── 저장된 기록 렌더 ────────────────────────────────────────────── */
function recRenderSavedList() {
  const container = document.getElementById('rec-saved-list');
  const empty     = document.getElementById('rec-saved-empty');
  const recordings = loadRecordings();
  const list = Object.values(recordings).sort((a, b) => b.createdAt - a.createdAt);

  container.innerHTML = '';
  if (list.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.forEach(rec => {
    const card = document.createElement('div');
    card.className = 'rec-saved-card';
    const preview = rec.summary || rec.transcript || '';
    card.innerHTML = `
      <div class="rec-saved-card-top">
        <span class="rec-saved-card-title" title="${escHtml(rec.title || '(제목 없음)')}">${escHtml(rec.title || '(제목 없음)')}</span>
        <span class="rec-saved-card-date">${escHtml(rec.date || '')}</span>
      </div>
      ${preview ? `<div class="rec-saved-card-preview">${escHtml(preview.slice(0, 80))}</div>` : ''}
      <div class="rec-saved-card-actions">
        <button class="rec-btn-open">열기</button>
        <button class="rec-btn-del">삭제</button>
      </div>
    `;
    card.querySelector('.rec-btn-open').addEventListener('click', e => { e.stopPropagation(); recLoadSaved(rec.id); });
    card.querySelector('.rec-btn-del').addEventListener('click',  e => { e.stopPropagation(); recDeleteSaved(rec.id); });
    container.appendChild(card);
  });
}

/* ── 저장된 기록 불러오기 ────────────────────────────────────────── */
function recLoadSaved(id) {
  const rec = loadRecordings()[id];
  if (!rec) return;

  REC.editId = id;
  document.getElementById('rec-title-input').value   = rec.title    || '';
  document.getElementById('rec-date-input').value    = rec.date     || todayStr();
  document.getElementById('rec-transcript').value    = rec.transcript || '';

  // 분석 결과 복원
  if (rec.summary || (rec.decisions && rec.decisions.length) || (rec.actions && rec.actions.length)) {
    REC.analysis = { summary: rec.summary, decisions: rec.decisions || [], actions: rec.actions || [] };
    recRenderAnalysis(REC.analysis);
  } else {
    REC.analysis = null;
    document.getElementById('rec-analysis-result').classList.add('hidden');
  }

  showToast('기록을 불러왔습니다.');
}

/* ── 저장된 기록 삭제 ────────────────────────────────────────────── */
async function recDeleteSaved(id) {
  const ok = await showConfirm('기록 삭제', '이 녹음 기록을 삭제하시겠습니까?');
  if (!ok) return;
  const data = loadRecordings();
  delete data[id];
  saveRecordings(data);
  if (REC.editId === id) recReset();
  recRenderSavedList();
  showToast('삭제되었습니다.');
}

/* ── 녹음 시작 ───────────────────────────────────────────────────── */
async function recStartRecording() {
  try {
    // 스트림 재사용 (이미 활성 스트림이 있으면 권한 재요청 생략)
    if (!REC.stream || !REC.stream.active) {
      REC.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const stream = REC.stream;

    // MediaRecorder
    REC.audioChunks  = [];
    REC.mediaRecorder = new MediaRecorder(stream);
    REC.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) REC.audioChunks.push(e.data); };
    REC.mediaRecorder.onstop = () => {
      // 스트림은 여기서 해제하지 않음 (재사용을 위해 유지)
    };
    REC.mediaRecorder.start(500);

    // Web Speech API (STT)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      REC.transcript = document.getElementById('rec-transcript').value || '';
      REC.recognition = new SpeechRecognition();
      REC.recognition.lang = 'ko-KR';
      REC.recognition.continuous = true;
      REC.recognition.interimResults = true;

      REC.recognition.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) {
            REC.transcript += res[0].transcript + ' ';
          } else {
            interim += res[0].transcript;
          }
        }
        // 확정 텍스트를 textarea에 실시간 반영
        document.getElementById('rec-transcript').value = REC.transcript;
        document.getElementById('rec-stt-interim').textContent = interim;
      };
      REC.recognition.onend = () => {
        if (REC.isRecording && REC.recognition) {
          try { REC.recognition.start(); } catch {}
        } else if (!REC.isRecording) {
          document.getElementById('rec-stt-live').classList.add('hidden');
          document.getElementById('rec-transcript').value = REC.transcript.trim();
        }
      };
      REC.recognition.onerror = e => {
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.warn('STT error:', e.error);
        }
      };

      // isRecording을 start() 이전에 설정 (onend 콜백 타이밍 레이스 방지)
      REC.isRecording    = true;
      REC.elapsedSeconds = 0;
      REC.recognition.start();
      document.getElementById('rec-stt-live').classList.remove('hidden');
    } else {
      REC.isRecording    = true;
      REC.elapsedSeconds = 0;
    }

    // UI 상태
    document.getElementById('btn-rec-start').classList.add('hidden');
    document.getElementById('btn-rec-stop').classList.remove('hidden');
    document.getElementById('rec-status').classList.remove('hidden');
    document.getElementById('rec-audio-wrap').classList.add('hidden');
    document.getElementById('rec-timer').textContent = '00:00';

    REC.timerInterval = setInterval(() => {
      REC.elapsedSeconds++;
      const m = String(Math.floor(REC.elapsedSeconds / 60)).padStart(2, '0');
      const s = String(REC.elapsedSeconds % 60).padStart(2, '0');
      document.getElementById('rec-timer').textContent = `${m}:${s}`;
    }, 1000);

  } catch (err) {
    showToast('마이크 접근 권한이 필요합니다. 브라우저 설정을 확인해주세요.');
    console.error('Recording error:', err);
  }
}

/* ── 녹음 정지 ───────────────────────────────────────────────────── */
function recStopRecording() {
  REC.isRecording = false;

  if (REC.timerInterval) { clearInterval(REC.timerInterval); REC.timerInterval = null; }
  if (REC.mediaRecorder && REC.mediaRecorder.state !== 'inactive') REC.mediaRecorder.stop();

  // recognition null로 먼저 교체해 onend 재시작 루프 차단 후 stop
  // (abort 대신 stop: 미확정 interim 결과를 final로 처리해줌 → 빠른 말 누락 방지)
  if (REC.recognition) {
    const rec = REC.recognition;
    REC.recognition = null;
    // interim 텍스트를 먼저 transcript에 병합 (stop()이 final을 보장하지 못할 경우 대비)
    const interimEl = document.getElementById('rec-stt-interim');
    if (interimEl && interimEl.textContent.trim()) {
      REC.transcript += interimEl.textContent.trim() + ' ';
      interimEl.textContent = '';
    }
    try { rec.stop(); } catch {}
    document.getElementById('rec-stt-live').classList.add('hidden');
    document.getElementById('rec-transcript').value = REC.transcript.trim();
  }

  document.getElementById('btn-rec-start').classList.remove('hidden');
  document.getElementById('btn-rec-stop').classList.add('hidden');
  document.getElementById('rec-status').classList.add('hidden');
}

/* ── 텍스트 정리 (구두점 + 화자 구분) ───────────────────────────── */
async function recRefineText() {
  const ta = document.getElementById('rec-transcript');
  const raw = ta.value.trim();
  if (!raw) { showToast('정리할 텍스트가 없습니다.'); return; }

  const apiKey = loadApiKey();
  if (!apiKey) { showToast('Claude API 키를 먼저 저장해주세요.'); return; }

  const btn = document.getElementById('btn-rec-refine');
  btn.disabled = true;
  btn.textContent = '✏️ 정리 중...';

  const prompt = `아래는 음성 인식으로 받아쓴 날 텍스트야. 구두점(쉼표, 마침표, 물음표 등)을 추가하고, 대화 흐름을 분석해서 화자가 바뀌는 지점을 [A], [B] 형태로 구분해줘.

규칙:
- 화자 구분이 명확하지 않은 경우 억지로 나누지 말고 자연스러운 문단으로만 구분
- 원문 내용은 절대 수정하거나 요약하지 말고 그대로 유지
- 응답은 정리된 텍스트만 출력 (설명 없이)

원문:
${raw}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: REC_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `API 오류 (${res.status})`);
    }

    const data    = await res.json();
    const refined = data.content?.[0]?.text?.trim() || '';
    if (refined) {
      ta.value = refined;
      REC.transcript = refined;
      showToast('텍스트 정리가 완료되었습니다.');
    }
  } catch (err) {
    console.error('텍스트 정리 오류:', err);
    showToast(`텍스트 정리 실패: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '✏️ 텍스트 정리';
  }
}

/* ── Claude API 호출 ─────────────────────────────────────────────── */
async function recAnalyze() {
  const transcript = document.getElementById('rec-transcript').value.trim();
  if (!transcript) { showToast('변환된 텍스트가 없습니다. 녹음하거나 직접 입력해주세요.'); return; }

  const apiKey = loadApiKey();
  if (!apiKey) { showToast('Claude API 키를 먼저 저장해주세요.'); return; }

  // 로딩 표시
  const resultEl = document.getElementById('rec-analysis-result');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `
    <div class="rec-analyzing-overlay">
      <span class="rec-spinner"></span>
      <span>AI가 분석 중입니다...</span>
    </div>`;

  const prompt = `다음 회의/통화 내용을 분석해줘:\n\n${transcript}\n\n응답 형식:\n{\n  "summary": "핵심 요약 (3~5줄)",\n  "decisions": ["결정 사항1", "결정 사항2"],\n  "actions": ["액션 아이템1", "액션 아이템2"]\n}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: REC_MODEL,
        max_tokens: 1024,
        system: '당신은 회의/통화 내용을 분석하는 전문 어시스턴트입니다. 반드시 아래 JSON 형식으로만 응답하세요.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `API 오류 (${res.status})`);
    }

    const data    = await res.json();
    const rawText = data.content?.[0]?.text || '';

    // JSON 파싱 (코드블록 제거 후)
    const jsonStr = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(jsonStr);

    REC.analysis = {
      summary:   parsed.summary   || '',
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      actions:   Array.isArray(parsed.actions)   ? parsed.actions   : [],
    };

    recRenderAnalysis(REC.analysis);

  } catch (err) {
    resultEl.innerHTML = '';
    resultEl.classList.add('hidden');
    console.error('AI 분석 오류:', err);
    showToast(`AI 분석 실패: ${err.message}`);
  }
}

/* ── 분석 결과 렌더 ──────────────────────────────────────────────── */
function recRenderAnalysis({ summary, decisions, actions }) {
  const resultEl = document.getElementById('rec-analysis-result');

  const decisionItems = (decisions || []).map(d =>
    `<li>${escHtml(d)}</li>`
  ).join('');

  const actionItems = (actions || []).map((a, i) =>
    `<li><input type="checkbox" id="rec-action-${i}" checked><label for="rec-action-${i}">${escHtml(a)}</label></li>`
  ).join('');

  resultEl.innerHTML = `
    <div class="rec-analysis-card">
      <h4 class="rec-analysis-h">📋 핵심 요약</h4>
      <p id="rec-summary-text" class="rec-summary-text">${escHtml(summary || '')}</p>
    </div>
    ${decisionItems ? `
    <div class="rec-analysis-card">
      <h4 class="rec-analysis-h">✅ 결정 사항</h4>
      <ul class="rec-analysis-list">${decisionItems}</ul>
    </div>` : ''}
    ${actionItems ? `
    <div class="rec-analysis-card">
      <h4 class="rec-analysis-h">📌 액션 아이템 <span class="hint">(추가할 항목 선택)</span></h4>
      <ul class="rec-analysis-list rec-actions-list">${actionItems}</ul>
      <div class="rec-add-todo-row">
        <select id="rec-todo-type" class="rec-todo-type">
          <option value="daily">일간 To-Do로 추가</option>
          <option value="weekly">주간 To-Do로 추가</option>
        </select>
        <button id="btn-rec-add-todo" class="btn-primary">선택 항목 추가</button>
      </div>
    </div>` : ''}
  `;
  resultEl.classList.remove('hidden');

  // 추가 버튼 이벤트 재바인딩
  const addBtn = document.getElementById('btn-rec-add-todo');
  if (addBtn) addBtn.addEventListener('click', recAddTodosFromActions);
}

/* ── 액션 아이템 → To-Do 추가 ───────────────────────────────────── */
async function recAddTodosFromActions() {
  const checkboxes = document.querySelectorAll('#rec-actions-list input[type="checkbox"]:checked');
  if (checkboxes.length === 0) { showToast('추가할 항목을 선택해주세요.'); return; }

  const todoType = document.getElementById('rec-todo-type')?.value || 'daily';
  const date     = document.getElementById('rec-date-input').value || todayStr();
  const weekKey  = getWeekKey(new Date(date + 'T00:00:00'));

  // 해당 주 데이터 확보
  if (!S.weeks[weekKey]) await dbGet('weeks', weekKey);
  if (!S.weeks[weekKey]) {
    S.weeks[weekKey] = {
      weekKey,
      weeklyTodos: [], dailyTodos: {},
      weeklyNote: '', weeklyNoteAt: null,
      dailyNotes: {}, dailyNotesAt: {}, drawings: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  }

  let addedCount = 0;
  for (const cb of checkboxes) {
    const label = cb.nextElementSibling?.textContent?.trim() || cb.id;
    const task  = makeTask({ text: label, category: '회의' });

    if (todoType === 'weekly') {
      await saveTask('weekly', weekKey, null, task, true);
    } else {
      await saveTask('daily', weekKey, date, task, true);
    }
    addedCount++;
  }

  showToast(`${addedCount}개 항목이 ${todoType === 'weekly' ? '주간' : '일간'} To-Do에 추가되었습니다.`);
}

/* ── 현재 작업 저장 ──────────────────────────────────────────────── */
function recSaveRecording() {
  const title      = document.getElementById('rec-title-input').value.trim();
  const date       = document.getElementById('rec-date-input').value || todayStr();
  const transcript = document.getElementById('rec-transcript').value.trim();

  if (!title && !transcript) { showToast('회의명 또는 텍스트를 입력해주세요.'); return; }

  const now  = Date.now();
  const id   = REC.editId || `rec_${now}`;
  const data = loadRecordings();
  const existing = data[id] || {};

  data[id] = {
    id,
    title:      title || '(제목 없음)',
    date,
    transcript,
    summary:    REC.analysis?.summary    || existing.summary    || '',
    decisions:  REC.analysis?.decisions  || existing.decisions  || [],
    actions:    REC.analysis?.actions    || existing.actions    || [],
    duration:   REC.elapsedSeconds       || existing.duration   || 0,
    createdAt:  existing.createdAt       || now,
  };

  saveRecordings(data);
  REC.editId = id;
  recRenderSavedList();
  showToast('저장되었습니다.');
}

/* ── 초기화 ──────────────────────────────────────────────────────── */
function recReset() {
  if (REC.isRecording) recStopRecording();
  REC.transcript   = '';
  REC.analysis     = null;
  REC.editId       = null;
  REC.elapsedSeconds = 0;
  REC.audioBlob = null;
  REC.audioUrl  = null;

  document.getElementById('rec-title-input').value  = '';
  document.getElementById('rec-date-input').value   = todayStr();
  document.getElementById('rec-transcript').value   = '';
  document.getElementById('rec-audio-wrap').classList.add('hidden');
  document.getElementById('rec-stt-live').classList.add('hidden');
  document.getElementById('rec-analysis-result').classList.add('hidden');
  document.getElementById('rec-analysis-result').innerHTML = '';
  document.getElementById('rec-stt-interim').textContent   = '';
  document.getElementById('btn-rec-start').classList.remove('hidden');
  document.getElementById('btn-rec-stop').classList.add('hidden');
  document.getElementById('rec-status').classList.add('hidden');
  document.getElementById('rec-timer').textContent = '00:00';
}

/* ── 백업/복원 연동: rvDoExport / rvDoImport 패치 ───────────────── */
// rvDoExport와 rvDoImport는 review 모듈에 정의되어 있으며,
// bindRecordingEvents에서 이벤트 리스너를 교체하여 recordings 포함 버전으로 대체합니다.

async function recDoExport() {
  const allWeeks = await dbGetAll('weeks');
  const allMemos = await dbGetAll('memos');
  const payload  = {
    appVersion:  APP_VERSION,
    dataVersion: DATA_VERSION,
    exportedAt:  new Date().toISOString(),
    weeks:       allWeeks,
    memos:       allMemos,
    reviews:     loadReviews(),
    recordings:  loadRecordings(),   // API 키는 제외
    meta: {
      lastBackupAt:  S.meta.lastBackupAt,
      lastRestoreAt: S.meta.lastRestoreAt
    }
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `planner-backup-${todayStr()}.json`;
  a.click(); URL.revokeObjectURL(url);

  S.meta.lastBackupAt = new Date().toISOString();
  await saveMeta();
  hideModal('export');
  renderDashboard();
  showToast('백업 파일이 다운로드되었습니다.');
}

async function recDoImport() {
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
    await new Promise((resolve, reject) => { const tx = db.transaction('weeks','readwrite'); const req = tx.objectStore('weeks').clear(); req.onsuccess = resolve; req.onerror = reject; });
    for (const w of S.importPayload.weeks) await dbPut('weeks', w);
    S.weeks = {}; S.importPayload.weeks.forEach(w => { S.weeks[w.weekKey] = w; });

    await new Promise((resolve, reject) => { const tx = db.transaction('memos','readwrite'); const req = tx.objectStore('memos').clear(); req.onsuccess = resolve; req.onerror = reject; });
    S.memos = {};
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) { await dbPut('memos', m); S.memos[m.id] = m; }
    }
    if (S.importPayload.reviews) saveReviews(S.importPayload.reviews);
    if (S.importPayload.recordings) saveRecordings(S.importPayload.recordings);

  } else {
    for (const iw of S.importPayload.weeks) {
      const ex = await dbGet('weeks', iw.weekKey);
      if (!ex) { await dbPut('weeks', iw); S.weeks[iw.weekKey] = iw; }
      else {
        const eIds = new Set(ex.weeklyTodos.map(t => t.id));
        iw.weeklyTodos.forEach(t => { if (!eIds.has(t.id)) ex.weeklyTodos.push(t); });
        Object.entries(iw.dailyTodos).forEach(([d, arr]) => {
          if (!ex.dailyTodos[d]) ex.dailyTodos[d] = [];
          const dIds = new Set(ex.dailyTodos[d].map(t => t.id));
          arr.forEach(t => { if (!dIds.has(t.id)) ex.dailyTodos[d].push(t); });
        });
        Object.entries(iw.dailyNotes || {}).forEach(([d, n]) => { if (!ex.dailyNotes[d] && n) ex.dailyNotes[d] = n; });
        Object.entries(iw.drawings || {}).forEach(([d, dr]) => { if (!ex.drawings[d] && dr) ex.drawings[d] = dr; });
        if (!ex.weeklyNote && iw.weeklyNote) ex.weeklyNote = iw.weeklyNote;
        ex.updatedAt = new Date().toISOString();
        await dbPut('weeks', ex); S.weeks[ex.weekKey] = ex;
      }
    }
    if (Array.isArray(S.importPayload.memos)) {
      for (const m of S.importPayload.memos) {
        if (!S.memos[m.id] && !await dbGet('memos', m.id)) { await dbPut('memos', m); S.memos[m.id] = m; }
      }
    }
    if (S.importPayload.reviews) saveReviews(Object.assign({}, S.importPayload.reviews, loadReviews()));
    if (S.importPayload.recordings) saveRecordings(Object.assign({}, S.importPayload.recordings, loadRecordings()));
    if (Array.isArray(S.importPayload.notebooks)) {
      for (const nb of S.importPayload.notebooks) { await dbPut('notebooks', nb); S.notebooks[nb.id] = nb; }
    }
    if (Array.isArray(S.importPayload.nb_pages)) {
      for (const p of S.importPayload.nb_pages) { await dbPut('nb_pages', p); S.nbPages[p.id] = p; }
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

/* ── 이벤트 바인딩 ───────────────────────────────────────────────── */
function bindRecordingEvents() {
  /* switchView 패치 */
  const _svBeforeRec = switchView;
  switchView = async function(mode) { // eslint-disable-line no-func-assign
    if (REC.pageVisible) hideRecordingPage();
    return _svBeforeRec(mode);
  };

  /* switchMobileTab 패치 */
  const _smtBeforeRec = switchMobileTab;
  switchMobileTab = function(tab) { // eslint-disable-line no-func-assign
    if (tab !== 'recording' && REC.pageVisible) hideRecordingPage();
    _smtBeforeRec(tab);
  };

  /* 헤더 버튼 */
  document.getElementById('btn-recording-tab').addEventListener('click', () => {
    if (REC.pageVisible) hideRecordingPage(false); else showRecordingPage();
  });

  /* 모바일 탭 */
  const mobileRecTab = document.querySelector('.mobile-tab[data-tab="recording"]');
  if (mobileRecTab) {
    mobileRecTab.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
      mobileRecTab.classList.add('active');
      showRecordingPage();
    });
  }

  /* API 키 저장/변경 */
  document.getElementById('btn-rec-api-save').addEventListener('click', () => {
    const key = document.getElementById('rec-api-key-input').value.trim();
    if (!key) { showToast('API 키를 입력해주세요.'); return; }
    saveApiKey(key);
    document.getElementById('rec-api-key-input').value = '';
    recRenderApiKeyUI();
    showToast('API 키가 저장되었습니다.');
  });
  document.getElementById('btn-rec-api-change').addEventListener('click', () => {
    document.getElementById('rec-api-input-wrap').classList.remove('hidden');
    document.getElementById('rec-api-saved-wrap').classList.add('hidden');
    document.getElementById('rec-api-key-input').focus();
  });

  /* 녹음 시작/정지 */
  document.getElementById('btn-rec-start').addEventListener('click', recStartRecording);
  document.getElementById('btn-rec-stop').addEventListener('click', recStopRecording);

  /* 텍스트 정리 / AI 분석 / 저장 / 초기화 */
  document.getElementById('btn-rec-refine').addEventListener('click', recRefineText);
  document.getElementById('btn-rec-analyze').addEventListener('click', recAnalyze);
  document.getElementById('btn-rec-save').addEventListener('click', recSaveRecording);
  document.getElementById('btn-rec-reset').addEventListener('click', recReset);

}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(bindRecordingEvents, 0);
});

/* =====================================================================
   NOTEBOOK MODULE
   카테고리(notebook) + 페이지(nb_page) 기반 주요 정보 기록 기능
   캔버스 기반 자유 배치 에디터
   ===================================================================== */

/* ── 데이터 팩토리 ─── */
function makeNotebook(overrides) {
  return {
    id: 'nb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title: '새 카테고리',
    icon: '📁',
    color: '#555555',
    collapsed: false,
    sortOrder: Object.keys(S.notebooks).length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeNbPage(notebookId, overrides) {
  const pages = Object.values(S.nbPages).filter(p => p.notebookId === notebookId);
  return {
    id: 'nbp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    notebookId,
    title: '제목 없음',
    boxes: [],
    sortOrder: pages.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeBox(type, x, y, overrides) {
  const typeDefaults = {
    text:  { w: 280, boxTitle: '텍스트', content: '' },
    image: { w: 320, boxTitle: '이미지', content: '' },
    table: { w: 400, boxTitle: '표', tableData: [['','',''],['','',''],['','','']] },
  };
  return {
    id: 'box_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    type,
    x: Math.round(x),
    y: Math.round(y),
    h: null,
    collapsed: false,
    zIndex: 1,
    ...(typeDefaults[type] || typeDefaults.text),
    ...overrides
  };
}

/* ── DB CRUD ─── */
async function saveNotebook(nb) {
  nb.updatedAt = new Date().toISOString();
  S.notebooks[nb.id] = nb;
  await dbPut('notebooks', nb);
}

async function saveNbPage(page) {
  page.updatedAt = new Date().toISOString();
  S.nbPages[page.id] = page;
  await dbPut('nb_pages', page);
}

async function deleteNotebook(nbId) {
  delete S.notebooks[nbId];
  await dbDelete('notebooks', nbId);
  const pages = Object.values(S.nbPages).filter(p => p.notebookId === nbId);
  for (const p of pages) { delete S.nbPages[p.id]; await dbDelete('nb_pages', p.id); }
}

async function deleteNbPage(pageId) {
  delete S.nbPages[pageId];
  await dbDelete('nb_pages', pageId);
}

async function loadNotebooks() {
  const nbs = await dbGetAll('notebooks');
  nbs.forEach(nb => { S.notebooks[nb.id] = nb; });
  const pages = await dbGetAll('nb_pages');
  pages.forEach(p => { S.nbPages[p.id] = p; });
}

/* ── 트리 렌더 ─── */
function renderNotebookTree() {
  const tree = document.getElementById('notebook-tree');
  if (!tree) return;
  const nbs = Object.values(S.notebooks).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  if (nbs.length === 0) {
    tree.innerHTML = '<div class="nb-tree-empty">카테고리가 없습니다.<br>"+ 카테고리" 버튼을 눌러<br>추가하세요.</div>';
    return;
  }
  tree.innerHTML = '';
  nbs.forEach(nb => tree.appendChild(makeNotebookEl(nb)));
}

function makeNotebookEl(nb) {
  const pages = Object.values(S.nbPages)
    .filter(p => p.notebookId === nb.id)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const wrap = document.createElement('div');
  wrap.className = 'nb-notebook' + (nb.collapsed ? ' nb-collapsed' : '');
  wrap.dataset.nbId = nb.id;

  const hdr = document.createElement('div');
  hdr.className = 'nb-notebook-header';
  hdr.innerHTML = `
    <span class="nb-nb-chevron">▾</span>
    <span class="nb-nb-icon">${nb.icon || '📁'}</span>
    <span class="nb-nb-title" style="color:${nb.color || 'var(--text)'}">${escHtml(nb.title)}</span>
    <div class="nb-nb-order-btns">
      <button class="nb-nb-order-btn" data-dir="up" title="위로">▲</button>
      <button class="nb-nb-order-btn" data-dir="down" title="아래로">▼</button>
    </div>
    <button class="nb-nb-menu-btn" title="메뉴">•••</button>`;

  hdr.addEventListener('click', e => {
    if (e.target.closest('.nb-nb-menu-btn')) return;
    if (e.target.closest('.nb-nb-order-btns')) return;
    nb.collapsed = !nb.collapsed;
    wrap.classList.toggle('nb-collapsed', nb.collapsed);
    saveNotebook(nb);
  });
  hdr.querySelector('.nb-nb-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    showNbCtxMenu(e, nb.id);
  });
  hdr.querySelector('.nb-nb-order-btns').addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.target.closest('.nb-nb-order-btn');
    if (!btn) return;
    reorderNotebook(nb.id, btn.dataset.dir);
  });

  const pagesDiv = document.createElement('div');
  pagesDiv.className = 'nb-pages';
  pages.forEach(p => {
    const item = document.createElement('div');
    item.className = 'nb-page-item' + (S.activeNbPageId === p.id ? ' active' : '');
    item.dataset.pageId = p.id;
    item.innerHTML = `
      <span class="nb-page-icon-sm">📄</span>
      <span class="nb-page-title-sm">${escHtml(p.title || '제목 없음')}</span>
      <button class="nb-page-del-btn" title="삭제">✕</button>`;
    item.addEventListener('click', e => {
      if (e.target.closest('.nb-page-del-btn')) return;
      openNbPage(p.id);
    });
    item.querySelector('.nb-page-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      confirmDeleteNbPage(p.id);
    });
    pagesDiv.appendChild(item);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'nb-add-page-btn';
  addBtn.textContent = '+ 페이지 추가';
  addBtn.addEventListener('click', () => addNbPage(nb.id));
  pagesDiv.appendChild(addBtn);

  wrap.appendChild(hdr);
  wrap.appendChild(pagesDiv);
  return wrap;
}

/* ── 컨텍스트 메뉴 ─── */
let _nbCtxMenu = null;

function showNbCtxMenu(e, nbId) {
  closeNbCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'nb-ctx-menu';
  menu.innerHTML = `
    <button class="nb-ctx-menu-item" data-action="rename">이름 / 아이콘 변경</button>
    <button class="nb-ctx-menu-item danger" data-action="delete">카테고리 삭제</button>`;
  const rect = e.target.getBoundingClientRect();
  menu.style.left = Math.min(rect.right, window.innerWidth - 170) + 'px';
  menu.style.top  = rect.top + 'px';
  document.body.appendChild(menu);
  _nbCtxMenu = menu;
  menu.addEventListener('click', ev => {
    const btn = ev.target.closest('.nb-ctx-menu-item');
    if (!btn) return;
    closeNbCtxMenu();
    if (btn.dataset.action === 'rename') openNotebookModal(S.notebooks[nbId]);
    if (btn.dataset.action === 'delete') confirmDeleteNotebook(nbId);
  });
  setTimeout(() => document.addEventListener('click', closeNbCtxMenu, { once: true }), 10);
}

function closeNbCtxMenu() {
  if (_nbCtxMenu) { _nbCtxMenu.remove(); _nbCtxMenu = null; }
}

async function reorderNotebook(nbId, dir) {
  const sorted = Object.values(S.notebooks).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const idx = sorted.findIndex(nb => nb.id === nbId);
  if (idx < 0) return;
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= sorted.length) return;
  const a = sorted[idx];
  const b = sorted[swapIdx];
  const tmpOrder = a.sortOrder ?? idx;
  a.sortOrder = b.sortOrder ?? swapIdx;
  b.sortOrder = tmpOrder;
  await Promise.all([saveNotebook(a), saveNotebook(b)]);
  renderNotebookTree();
}

/* ── CRUD 확인 ─── */
async function confirmDeleteNotebook(nbId) {
  const nb = S.notebooks[nbId];
  if (!nb) return;
  const cnt = Object.values(S.nbPages).filter(p => p.notebookId === nbId).length;
  const msg = cnt > 0
    ? `"${nb.title}" 카테고리와 ${cnt}개의 페이지를 모두 삭제할까요?`
    : `"${nb.title}" 카테고리를 삭제할까요?`;
  const ok = await showConfirm('카테고리 삭제', msg);
  if (!ok) return;
  if (S.activeNbPageId) {
    const ap = S.nbPages[S.activeNbPageId];
    if (ap && ap.notebookId === nbId) closeNbPage();
  }
  await deleteNotebook(nbId);
  renderNotebookTree();
  showToast('카테고리가 삭제되었습니다.');
}

async function confirmDeleteNbPage(pageId) {
  const p = S.nbPages[pageId];
  if (!p) return;
  const ok = await showConfirm('페이지 삭제', `"${p.title || '제목 없음'}" 페이지를 삭제할까요?`);
  if (!ok) return;
  if (S.activeNbPageId === pageId) closeNbPage();
  await deleteNbPage(pageId);
  renderNotebookTree();
  showToast('페이지가 삭제되었습니다.');
}

/* ── 페이지 열기/닫기 ─── */
async function addNbPage(nbId) {
  const page = makeNbPage(nbId);
  await saveNbPage(page);
  renderNotebookTree();
  openNbPage(page.id);
}

function openNbPage(pageId) {
  if (S.activeNbPageId && S.activeNbPageId !== pageId) saveNbPageContent();
  const page = S.nbPages[pageId];
  if (!page) return;
  // 이전 형식 호환: content 문자열이 있으면 하나의 텍스트 박스로 마이그레이션
  if (!Array.isArray(page.boxes)) {
    if (page.content) {
      page.boxes = [makeBox('text', 20, 20, { content: page.content, w: 600, boxTitle: '내용' })];
    } else {
      page.boxes = [];
    }
    delete page.content;
  }
  S.activeNbPageId = pageId;
  _cvCtx.page = page;
  _cvCtx.saveFn = scheduleNbPageSave;
  _cvCtx.canvasId = 'nb-canvas';
  _cvCtx.imgInputId = 'nb-img-input';
  document.getElementById('main-layout').classList.add('nb-page-mode');
  renderNotebookTree();
  _renderNbPageEditor(page);
}

function closeNbPage() {
  saveNbPageContent();
  S.activeNbPageId = null;
  document.getElementById('main-layout').classList.remove('nb-page-mode');
  renderNotebookTree();
}

/* ── 에디터 렌더 ─── */
function _renderNbPageEditor(page) {
  const nb = S.notebooks[page.notebookId] || {};
  const bc = document.getElementById('nb-breadcrumb');
  if (bc) bc.textContent = (nb.icon ? nb.icon + ' ' : '') + (nb.title || '') + ' › ' + (page.title || '제목 없음');
  const titleEl = document.getElementById('nb-page-title-input');
  if (titleEl) titleEl.textContent = page.title || '';
  renderNbCanvas(page.boxes || []);
  const st = document.getElementById('nb-page-savetime');
  if (st) st.textContent = page.updatedAt ? '저장: ' + fmtShort(page.updatedAt) : '';
}

/* ── 캔버스 렌더 ─── */
function renderNbCanvas(boxes) {
  const canvas = document.getElementById(_cvCtx.canvasId || 'nb-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  (boxes || []).forEach(box => canvas.appendChild(makeBoxEl(box)));
}

function makeBoxEl(box) {
  const el = document.createElement('div');
  el.className = 'nb-box' + (box.collapsed ? ' nb-box-collapsed' : '');
  el.id = 'nb-box-' + box.id;
  el.dataset.boxId = box.id;
  el.style.left   = box.x + 'px';
  el.style.top    = box.y + 'px';
  el.style.width  = box.w + 'px';
  el.style.zIndex = box.zIndex || 1;
  if (box.h) el.style.height = box.h + 'px';

  // Header
  const header = document.createElement('div');
  header.className = 'nb-box-header';
  header.innerHTML = `
    <span class="nb-box-drag-icon" title="드래그하여 이동">⣿</span>
    <span class="nb-box-title" contenteditable="true" spellcheck="false">${escHtml(box.boxTitle || '')}</span>
    <div class="nb-box-actions">
      <button class="nb-box-collapse-btn" title="${box.collapsed ? '펼치기' : '접기'}">${box.collapsed ? '▸' : '▾'}</button>
      <button class="nb-box-del-btn" title="박스 삭제">✕</button>
    </div>`;

  // Body
  const body = document.createElement('div');
  body.className = 'nb-box-body';

  if (box.type === 'text') {
    const content = document.createElement('div');
    content.className = 'nb-box-content';
    content.contentEditable = 'true';
    content.spellcheck = false;
    content.dataset.placeholder = '클릭하여 텍스트 입력...';
    content.innerHTML = box.content || '';
    body.appendChild(content);
  } else if (box.type === 'image') {
    if (box.content) {
      const img = document.createElement('img');
      img.src = box.content;
      img.className = 'nb-box-img';
      body.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.style.cssText = 'min-height:80px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:0.85rem;cursor:pointer;';
      ph.textContent = '클릭하여 이미지 선택';
      ph.addEventListener('click', () => {
        const inp = document.getElementById(_cvCtx.imgInputId || 'nb-img-input');
        if (inp) { inp.dataset.boxId = box.id; inp.click(); }
      });
      body.appendChild(ph);
    }
  } else if (box.type === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'nb-table-wrap';
    const table = document.createElement('table');
    table.className = 'nb-table';
    const tbody = document.createElement('tbody');
    const data = (box.tableData && box.tableData.length) ? box.tableData : [['','',''],['','',''],['','','']];
    data.forEach(row => {
      const tr = document.createElement('tr');
      (Array.isArray(row) ? row : []).forEach(cell => {
        const td = document.createElement('td');
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.innerHTML = cell || '';
        td.addEventListener('input', () => _cvCtx.saveFn());
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const controls = document.createElement('div');
    controls.className = 'nb-table-controls';
    controls.innerHTML = '<button class="nb-tbl-btn" data-tbl-action="add-row">+ 행</button>' +
      '<button class="nb-tbl-btn" data-tbl-action="add-col">+ 열</button>' +
      '<button class="nb-tbl-btn" data-tbl-action="del-row">− 행</button>' +
      '<button class="nb-tbl-btn" data-tbl-action="del-col">− 열</button>';
    wrap.appendChild(table);
    wrap.appendChild(controls);
    body.appendChild(wrap);
  }

  // Resize handle
  const resize = document.createElement('div');
  resize.className = 'nb-box-resize-handle';
  resize.title = '드래그하여 크기 조절';
  resize.textContent = '⌟';

  el.appendChild(header);
  el.appendChild(body);
  el.appendChild(resize);
  setupBoxEvents(el, box);
  return el;
}

/* ── 박스 이벤트 ─── */
function setupBoxEvents(el, box) {
  const boxId = box.id;

  // 박스 선택 → 최상위
  el.addEventListener('mousedown', () => bringBoxToFront(boxId), true);

  // 헤더 드래그 → 이동
  const header = el.querySelector('.nb-box-header');
  header.addEventListener('mousedown', e => {
    if (e.target.closest('.nb-box-title, .nb-box-actions')) return;
    e.preventDefault();
    nbStartDrag(e, 'move', boxId, el);
  });

  // 드래그 아이콘
  el.querySelector('.nb-box-drag-icon').addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    nbStartDrag(e, 'move', boxId, el);
  });

  // 리사이즈
  el.querySelector('.nb-box-resize-handle').addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    nbStartDrag(e, 'resize', boxId, el);
  });

  // 접기/펼치기
  el.querySelector('.nb-box-collapse-btn').addEventListener('click', e => {
    e.stopPropagation();
    nbToggleBoxCollapse(boxId, el);
  });

  // 삭제
  el.querySelector('.nb-box-del-btn').addEventListener('click', e => {
    e.stopPropagation();
    nbDeleteBox(boxId);
  });

  // 제목 / 내용 자동 저장
  el.querySelector('.nb-box-title')?.addEventListener('input', () => _cvCtx.saveFn());
  el.querySelector('.nb-box-content')?.addEventListener('input', () => _cvCtx.saveFn());

  // 표 행/열 컨트롤
  el.querySelector('.nb-table-controls')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tbl-action]');
    if (!btn) return;
    const tbody = el.querySelector('.nb-table tbody');
    if (!tbody) return;
    const action = btn.dataset.tblAction;
    const makeTd = () => {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.spellcheck = false;
      td.addEventListener('input', () => _cvCtx.saveFn());
      return td;
    };
    if (action === 'add-row') {
      const colCount = tbody.rows[0]?.cells.length || 3;
      const tr = document.createElement('tr');
      for (let i = 0; i < colCount; i++) tr.appendChild(makeTd());
      tbody.appendChild(tr);
    } else if (action === 'add-col') {
      Array.from(tbody.rows).forEach(row => row.appendChild(makeTd()));
    } else if (action === 'del-row') {
      if (tbody.rows.length > 1) tbody.deleteRow(tbody.rows.length - 1);
    } else if (action === 'del-col') {
      Array.from(tbody.rows).forEach(row => { if (row.cells.length > 1) row.deleteCell(row.cells.length - 1); });
    }
    _cvCtx.saveFn();
  });
}

function bringBoxToFront(boxId) {
  const page = _cvCtx.page;
  if (!page || !page.boxes) return;
  const maxZ = page.boxes.reduce((m, b) => Math.max(m, b.zIndex || 1), 1);
  const box = page.boxes.find(b => b.id === boxId);
  if (!box || box.zIndex === maxZ) return;
  box.zIndex = maxZ + 1;
  const el = document.getElementById('nb-box-' + boxId);
  if (el) el.style.zIndex = box.zIndex;
}

function nbToggleBoxCollapse(boxId, el) {
  const page = _cvCtx.page;
  if (!page) return;
  const box = page.boxes?.find(b => b.id === boxId);
  if (!box) return;
  box.collapsed = !box.collapsed;
  el.classList.toggle('nb-box-collapsed', box.collapsed);
  const btn = el.querySelector('.nb-box-collapse-btn');
  btn.textContent = box.collapsed ? '▸' : '▾';
  btn.title       = box.collapsed ? '펼치기' : '접기';
  _cvCtx.saveFn();
}

function nbDeleteBox(boxId) {
  const page = _cvCtx.page;
  if (!page) return;
  page.boxes = (page.boxes || []).filter(b => b.id !== boxId);
  document.getElementById('nb-box-' + boxId)?.remove();
  _cvCtx.saveFn();
}

/* ── 캔버스 컨텍스트 (노트북 페이지 / 필기노트 공용) ─── */
const _cvCtx = { page: null, saveFn: () => {}, canvasId: 'nb-canvas', imgInputId: 'nb-img-input' };

/* ── 드래그 / 리사이즈 ─── */
const _nbDrag = {
  active: false, type: null, boxId: null, el: null,
  startX: 0, startY: 0, origX: 0, origY: 0, origW: 0, origH: 0
};

function nbStartDrag(e, type, boxId, el) {
  const page = _cvCtx.page;
  if (!page) return;
  const box = page.boxes?.find(b => b.id === boxId);
  if (!box) return;
  Object.assign(_nbDrag, {
    active: true, type, boxId, el,
    startX: e.clientX, startY: e.clientY,
    origX: box.x, origY: box.y,
    origW: box.w, origH: box.h || el.offsetHeight
  });
  document.body.style.userSelect = 'none';
  document.body.style.cursor = type === 'resize' ? 'se-resize' : 'grabbing';
}

document.addEventListener('mousemove', e => {
  if (!_nbDrag.active) return;
  const dx = e.clientX - _nbDrag.startX;
  const dy = e.clientY - _nbDrag.startY;
  if (_nbDrag.type === 'move') {
    _nbDrag.el.style.left = Math.max(0, _nbDrag.origX + dx) + 'px';
    _nbDrag.el.style.top  = Math.max(0, _nbDrag.origY + dy) + 'px';
  } else {
    _nbDrag.el.style.width  = Math.max(150, _nbDrag.origW + dx) + 'px';
    _nbDrag.el.style.height = Math.max(60,  _nbDrag.origH + dy) + 'px';
  }
});

document.addEventListener('mouseup', () => {
  if (!_nbDrag.active) return;
  const page = _cvCtx.page;
  if (page && page.boxes) {
    const box = page.boxes.find(b => b.id === _nbDrag.boxId);
    if (box) {
      if (_nbDrag.type === 'move') {
        box.x = parseInt(_nbDrag.el.style.left)  || box.x;
        box.y = parseInt(_nbDrag.el.style.top)   || box.y;
      } else {
        box.w = parseInt(_nbDrag.el.style.width)  || box.w;
        const h = parseInt(_nbDrag.el.style.height);
        box.h = isNaN(h) ? null : h;
      }
    }
  }
  _nbDrag.active = false;
  _nbDrag.el = null;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  _cvCtx.saveFn();
});

/* ── 박스 추가 ─── */
function addNbCanvasBox(type, x, y, extraData) {
  const page = _cvCtx.page;
  if (!page) return null;
  if (!page.boxes) page.boxes = [];
  const maxZ = page.boxes.reduce((m, b) => Math.max(m, b.zIndex || 1), 1);
  const box = makeBox(type, x, y, { zIndex: maxZ + 1, ...(extraData || {}) });
  page.boxes.push(box);
  const canvas = document.getElementById(_cvCtx.canvasId || 'nb-canvas');
  if (canvas) {
    const el = makeBoxEl(box);
    canvas.appendChild(el);
    setTimeout(() => el.querySelector('.nb-box-content')?.focus(), 50);
  }
  _cvCtx.saveFn();
  return box;
}

/* ── 자동 저장 ─── */
let _nbSaveTimer = null;

function scheduleNbPageSave() {
  clearTimeout(_nbSaveTimer);
  _nbSaveTimer = setTimeout(saveNbPageContent, 1000);
}

async function saveNbPageContent() {
  clearTimeout(_nbSaveTimer);
  if (!S.activeNbPageId) return;
  const page = S.nbPages[S.activeNbPageId];
  if (!page) return;

  const titleEl = document.getElementById('nb-page-title-input');
  if (titleEl) page.title = titleEl.textContent.trim() || '제목 없음';

  if (page.boxes) {
    page.boxes.forEach(box => {
      const el = document.getElementById('nb-box-' + box.id);
      if (!el) return;
      box.x = parseInt(el.style.left)  || box.x;
      box.y = parseInt(el.style.top)   || box.y;
      box.w = parseInt(el.style.width) || box.w;
      const h = parseInt(el.style.height);
      box.h = isNaN(h) ? null : h;
      box.zIndex = parseInt(el.style.zIndex) || box.zIndex;
      const ts = el.querySelector('.nb-box-title');
      if (ts) box.boxTitle = ts.textContent.trim();
      const cd = el.querySelector('.nb-box-content');
      if (cd && box.type === 'text') box.content = cd.innerHTML;
      if (box.type === 'table') {
        const tbody = el.querySelector('.nb-table tbody');
        if (tbody) box.tableData = Array.from(tbody.rows).map(row => Array.from(row.cells).map(td => td.innerHTML));
      }
    });
  }

  await saveNbPage(page);

  const nb = S.notebooks[page.notebookId] || {};
  const bc = document.getElementById('nb-breadcrumb');
  if (bc) bc.textContent = (nb.icon ? nb.icon + ' ' : '') + (nb.title || '') + ' › ' + page.title;
  const st = document.getElementById('nb-page-savetime');
  if (st) st.textContent = '저장: ' + fmtShort(page.updatedAt);
  document.querySelectorAll(`.nb-page-item[data-page-id="${page.id}"] .nb-page-title-sm`).forEach(el => {
    el.textContent = page.title;
  });
}

/* ── 노트북 모달 ─── */
let _nbModalEditId = null;

function openNotebookModal(nbToEdit) {
  _nbModalEditId = nbToEdit ? nbToEdit.id : null;
  const titleEl = document.getElementById('modal-notebook-title');
  if (titleEl) titleEl.textContent = nbToEdit ? '카테고리 편집' : '카테고리 추가';
  const input = document.getElementById('nb-modal-title-input');
  if (input) input.value = nbToEdit ? nbToEdit.title : '';
  document.querySelectorAll('#nb-icon-picker .nb-icon-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.icon === (nbToEdit ? nbToEdit.icon : '📁'));
  });
  document.querySelectorAll('#nb-color-picker .nb-color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === (nbToEdit ? nbToEdit.color : '#555555'));
  });
  showModal('notebook');
  setTimeout(() => input && input.focus(), 60);
}

async function saveNotebookModal() {
  const title = document.getElementById('nb-modal-title-input')?.value.trim();
  if (!title) { showToast('카테고리 이름을 입력하세요.'); return; }
  const icon  = document.querySelector('#nb-icon-picker .nb-icon-opt.active')?.dataset.icon  || '📁';
  const color = document.querySelector('#nb-color-picker .nb-color-dot.active')?.dataset.color || '#555555';
  let nb;
  if (_nbModalEditId && S.notebooks[_nbModalEditId]) {
    nb = S.notebooks[_nbModalEditId];
    Object.assign(nb, { title, icon, color });
  } else {
    nb = makeNotebook({ title, icon, color });
  }
  await saveNotebook(nb);
  hideModal('notebook');
  renderNotebookTree();
  showToast(_nbModalEditId ? '카테고리가 수정되었습니다.' : '카테고리가 추가되었습니다.');
  _nbModalEditId = null;
}

/* ── 툴바 서식 명령 ─── */
function nbExecCmd(cmd, val) {
  if      (cmd === 'block-h1')    document.execCommand('formatBlock', false, 'h1');
  else if (cmd === 'block-h2')    document.execCommand('formatBlock', false, 'h2');
  else if (cmd === 'block-h3')    document.execCommand('formatBlock', false, 'h3');
  else if (cmd === 'block-p')     document.execCommand('formatBlock', false, 'p');
  else if (cmd === 'insertSpace') document.execCommand('insertText', false, ' ');
  else                            document.execCommand(cmd, false, val || null);
  _cvCtx.saveFn();
}

/* ── 이벤트 바인딩 ─── */
function bindNotebookEvents() {
  // 카테고리 추가
  document.getElementById('btn-add-notebook')?.addEventListener('click', () => openNotebookModal(null));

  // 모달 저장
  document.getElementById('btn-nb-modal-save')?.addEventListener('click', saveNotebookModal);
  document.getElementById('nb-modal-title-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveNotebookModal();
  });

  // 아이콘 피커
  document.getElementById('nb-icon-picker')?.addEventListener('click', e => {
    const opt = e.target.closest('.nb-icon-opt');
    if (!opt) return;
    document.querySelectorAll('#nb-icon-picker .nb-icon-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
  });

  // 색상 피커
  document.getElementById('nb-color-picker')?.addEventListener('click', e => {
    const dot = e.target.closest('.nb-color-dot');
    if (!dot) return;
    document.querySelectorAll('#nb-color-picker .nb-color-dot').forEach(d => d.classList.remove('active'));
    dot.classList.add('active');
  });

  // 뒤로가기
  document.getElementById('btn-nb-back')?.addEventListener('click', () => closeNbPage());

  // 페이지 삭제
  document.getElementById('btn-nb-page-del')?.addEventListener('click', () => {
    if (S.activeNbPageId) confirmDeleteNbPage(S.activeNbPageId);
  });

  // 페이지 제목 저장
  document.getElementById('nb-page-title-input')?.addEventListener('input', scheduleNbPageSave);
  document.getElementById('nb-page-title-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('nb-canvas')?.focus(); }
  });

  // 캔버스 클릭 → 텍스트 박스 생성
  document.getElementById('nb-canvas')?.addEventListener('click', e => {
    if (e.target.id !== 'nb-canvas') return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const body = document.getElementById('nb-page-body');
    const scrollTop = body ? body.scrollTop : 0;
    const x = Math.max(10, e.clientX - rect.left - 10);
    const y = Math.max(10, e.clientY - rect.top + scrollTop - 20);
    addNbCanvasBox('text', x, y);
  });

  // 텍스트 박스 추가 버튼
  document.getElementById('btn-nb-add-text')?.addEventListener('click', () => {
    const page = S.nbPages[S.activeNbPageId];
    const cnt = page?.boxes?.length || 0;
    addNbCanvasBox('text', 30 + (cnt % 6) * 25, 30 + cnt * 18);
  });

  // 이미지 박스 추가 버튼
  document.getElementById('btn-nb-add-img-box')?.addEventListener('click', () => {
    const inp = document.getElementById('nb-img-input');
    delete inp.dataset.boxId;
    inp.click();
  });

  // 표 박스 추가 버튼
  document.getElementById('btn-nb-add-table')?.addEventListener('click', () => {
    const page = _cvCtx.page;
    const cnt = page?.boxes?.length || 0;
    addNbCanvasBox('table', 30 + (cnt % 4) * 30, 30 + cnt * 20);
  });

  // 이미지 파일 선택
  document.getElementById('nb-img-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const targetBoxId = e.target.dataset.boxId;
    const reader = new FileReader();
    reader.onload = ev => {
      const src = ev.target.result;
      if (targetBoxId) {
        // 기존 박스에 이미지 설정
        const page = S.nbPages[S.activeNbPageId];
        const box = page?.boxes?.find(b => b.id === targetBoxId);
        if (box) {
          box.content = src;
          const el = document.getElementById('nb-box-' + targetBoxId);
          if (el) {
            const body = el.querySelector('.nb-box-body');
            body.innerHTML = '';
            const img = document.createElement('img');
            img.src = src;
            img.className = 'nb-box-img';
            body.appendChild(img);
          }
          scheduleNbPageSave();
        }
      } else {
        // 새 이미지 박스
        const page = S.nbPages[S.activeNbPageId];
        const cnt = page?.boxes?.length || 0;
        addNbCanvasBox('image', 30 + (cnt % 4) * 40, 30 + cnt * 15, {
          content: src,
          boxTitle: file.name.replace(/\.[^.]+$/, '') || '이미지',
          w: 320,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // 서식 툴바 (포커스 유지를 위해 mousedown 사용)
  document.getElementById('nb-canvas-toolbar')?.addEventListener('mousedown', e => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    nbExecCmd(btn.dataset.cmd, btn.dataset.val);
  });
}