'use strict';

/* =============================================================
   GitHub Gist Sync Module for Mono Planner
   ─────────────────────────────────────────────────────────────
   localStorage keys:
     mp_gist_pat     — Personal Access Token
     mp_gist_id      — Gist ID (비어있으면 최초 동기화 시 자동 생성)
     mp_gist_last_sync — 마지막 동기화 ISO timestamp
     mp_gist_pending  — '1' : 오프라인 중 변경 발생
   ============================================================= */

const GIST_PAT_KEY     = 'mp_gist_pat';
const GIST_ID_KEY      = 'mp_gist_id';
const GIST_SYNC_KEY    = 'mp_gist_last_sync';
const GIST_PENDING_KEY = 'mp_gist_pending';
const GIST_FILENAME    = 'mono-planner-data.json';
const GIST_DEBOUNCE_MS = 3000;

const GistSync = {
  pat:       '',
  gistId:    '',
  lastSyncAt: null,
  isSyncing: false,
  _inPull:   false,
  _syncTimer: null,

  /* ── 초기화 ───────────────────────────────────────────────── */
  init() {
    this.pat        = localStorage.getItem(GIST_PAT_KEY)  || '';
    this.gistId     = localStorage.getItem(GIST_ID_KEY)   || '';
    this.lastSyncAt = localStorage.getItem(GIST_SYNC_KEY) || null;

    window.addEventListener('online',  () => this._onOnline());
    window.addEventListener('offline', () => this._renderBtn());

    this._renderBtn();
    this._renderLastSyncTime();

    if (this.isConfigured() && navigator.onLine) {
      this._pullOnLoad();
    }
  },

  isConfigured() {
    return !!(this.pat && this.gistId);
  },

  /* ── 설정 저장 ────────────────────────────────────────────── */
  saveConfig(pat, gistId) {
    this.pat    = pat.trim();
    this.gistId = gistId.trim();
    localStorage.setItem(GIST_PAT_KEY, this.pat);
    localStorage.setItem(GIST_ID_KEY,  this.gistId);
    this._renderBtn();
  },

  /* ── 변경 후 디바운스 동기화 예약 ─────────────────────────── */
  scheduleSync() {
    if (!this.pat) return;
    if (this._inPull) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.push(), GIST_DEBOUNCE_MS);
  },

  /* ── Gist에 데이터 업로드 ─────────────────────────────────── */
  async push() {
    if (!this.pat) return;
    if (this.isSyncing) { this._markPending(); return; }
    if (!navigator.onLine) { this._markPending(); return; }

    this.isSyncing = true;
    this._renderBtn('syncing');

    try {
      const payload = await this._buildPayload();
      const content = JSON.stringify(payload, null, 2);

      if (!this.gistId) {
        /* 새 Gist 생성 */
        const res = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify({
            description: 'Mono Planner 동기화 데이터',
            public: false,
            files: { [GIST_FILENAME]: { content } }
          })
        });
        if (!res.ok) throw new Error(`Gist 생성 실패 (HTTP ${res.status})`);
        const data = await res.json();
        this.gistId = data.id;
        localStorage.setItem(GIST_ID_KEY, this.gistId);
        /* 설정 모달에도 반영 */
        const el = document.getElementById('gist-id-input');
        if (el) el.value = this.gistId;
      } else {
        /* 기존 Gist 업데이트 */
        const res = await fetch(`https://api.github.com/gists/${this.gistId}`, {
          method: 'PATCH',
          headers: this._headers(),
          body: JSON.stringify({
            files: { [GIST_FILENAME]: { content } }
          })
        });
        if (!res.ok) throw new Error(`Gist 업데이트 실패 (HTTP ${res.status})`);
      }

      this.lastSyncAt = new Date().toISOString();
      localStorage.setItem(GIST_SYNC_KEY, this.lastSyncAt);
      localStorage.removeItem(GIST_PENDING_KEY);
      this._renderLastSyncTime();
      this._renderBtn('ok');
    } catch (err) {
      console.error('[GistSync] push 실패:', err);
      this._markPending();
      this._renderBtn('error');
      showToast('Gist 동기화 실패: ' + err.message);
    } finally {
      this.isSyncing = false;
    }
  },

  /* ── Gist에서 데이터 다운로드 ─────────────────────────────── */
  async _fetchFromGist() {
    const res = await fetch(`https://api.github.com/gists/${this.gistId}`, {
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Gist 조회 실패 (HTTP ${res.status})`);
    const gist = await res.json();
    const file = gist.files[GIST_FILENAME];
    if (!file) throw new Error('Gist에 플래너 파일이 없습니다');
    /* 1 MB 초과 시 raw URL로 재요청 */
    if (file.truncated) {
      const rawRes = await fetch(file.raw_url);
      if (!rawRes.ok) throw new Error('raw 파일 다운로드 실패');
      return JSON.parse(await rawRes.text());
    }
    return JSON.parse(file.content);
  },

  /* ── 앱 로드 시 자동 pull ─────────────────────────────────── */
  async _pullOnLoad() {
    try {
      const remote = await this._fetchFromGist();
      if (!remote) return;

      const remoteAt = remote.exportedAt ? new Date(remote.exportedAt).getTime() : 0;
      const localAt  = this.lastSyncAt   ? new Date(this.lastSyncAt).getTime()   : 0;

      if (remoteAt > localAt) {
        await applyImportPayload(remote, 'merge');
        this.lastSyncAt = new Date().toISOString();
        localStorage.setItem(GIST_SYNC_KEY, this.lastSyncAt);
        this._renderLastSyncTime();
        this._renderBtn('ok');
        await loadCurrentWeek();
        renderAll();
        renderHistoryWeekNav();
        showToast('Gist에서 최신 데이터를 불러왔습니다.');
      } else {
        this._renderBtn('ok');
      }
    } catch (err) {
      console.warn('[GistSync] pullOnLoad 실패:', err);
      this._renderBtn('error');
    }
  },

  /* ── 수동 pull (설정 모달 버튼) ───────────────────────────── */
  async manualPull() {
    if (!this.isConfigured()) {
      showToast('GitHub 설정을 먼저 저장하세요.');
      return;
    }
    this._renderBtn('syncing');
    try {
      const remote = await this._fetchFromGist();
      if (!remote) { showToast('Gist에 저장된 데이터가 없습니다.'); return; }
      await applyImportPayload(remote, 'merge');
      this.lastSyncAt = new Date().toISOString();
      localStorage.setItem(GIST_SYNC_KEY, this.lastSyncAt);
      this._renderLastSyncTime();
      this._renderBtn('ok');
      showToast('Gist에서 데이터를 가져왔습니다.');
    } catch (err) {
      console.error('[GistSync] manualPull 실패:', err);
      this._renderBtn('error');
      showToast('가져오기 실패: ' + err.message);
    }
  },

  /* ── 오프라인 → 온라인 복귀 시 자동 동기화 ─────────────────── */
  async _onOnline() {
    this._renderBtn();
    if (localStorage.getItem(GIST_PENDING_KEY) === '1' && this.isConfigured()) {
      await this.push();
    }
  },

  _markPending() {
    localStorage.setItem(GIST_PENDING_KEY, '1');
  },

  /* ── 공통 ─────────────────────────────────────────────────── */
  _headers() {
    return {
      'Authorization':        `Bearer ${this.pat}`,
      'Content-Type':         'application/json',
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  },

  async _buildPayload() {
    const [weeks, memos, notebooks, nb_pages] = await Promise.all([
      dbGetAll('weeks'),
      dbGetAll('memos'),
      dbGetAll('notebooks'),
      dbGetAll('nb_pages'),
    ]);
    return {
      appVersion:  APP_VERSION,
      dataVersion: DATA_VERSION,
      exportedAt:  new Date().toISOString(),
      weeks,
      memos,
      notebooks,
      nb_pages,
      reviews:    loadReviews(),
      recordings: loadRecordings(),
      meta: {
        lastBackupAt:  S.meta.lastBackupAt,
        lastRestoreAt: S.meta.lastRestoreAt,
      }
    };
  },

  /* ── UI 렌더링 ────────────────────────────────────────────── */
  _renderLastSyncTime() {
    const el = document.getElementById('w-sync-time');
    if (el) el.textContent = this.lastSyncAt ? fmtShort(this.lastSyncAt) : '-';
  },

  _renderBtn(state) {
    const btn = document.getElementById('btn-gist-sync');
    if (!btn) return;
    if (!navigator.onLine) {
      btn.textContent   = '오프라인';
      btn.dataset.gist  = 'offline';
    } else if (state === 'syncing') {
      btn.textContent   = '동기화 중...';
      btn.dataset.gist  = 'syncing';
    } else if (state === 'error') {
      btn.textContent   = '동기화 오류';
      btn.dataset.gist  = 'error';
    } else if (localStorage.getItem(GIST_PENDING_KEY) === '1') {
      btn.textContent   = '동기화 대기';
      btn.dataset.gist  = 'pending';
    } else if (!this.isConfigured()) {
      btn.textContent   = 'Gist 설정';
      btn.dataset.gist  = 'unconfigured';
    } else {
      btn.textContent   = '동기화됨';
      btn.dataset.gist  = 'ok';
    }
  }
};
