/* eslint-disable no-undef */
/**
 * 행사 입장 스캐너 - 클라이언트 로직
 *
 * 구조:
 *  - state.apiUrl    : Apps Script 웹앱 URL (localStorage 저장)
 *  - state.event     : 선택한 행사 시트명
 *  - state.facingMode: 'user' (전면) | 'environment' (후면)
 *
 * 스캔 엔진:
 *  - 가능하면 Native BarcodeDetector → 매우 빠름 (Android Chrome / iOS 17+ Safari 일부)
 *  - 미지원 시 jsQR로 폴백 → 모든 브라우저 동작
 *
 * 중복/멱등 처리:
 *  - 같은 토큰 3초 이내 재스캔은 무시 (클라 디바운스)
 *  - 서버는 LockService + entered=Y 체크로 멱등 보장 → 이미 입장이면 'already' 반환
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LS_KEY = 'eventScanner.config.v1';
const RESCAN_COOLDOWN_MS = 3000;

const state = {
  apiUrl: '',
  event: null,           // { name, total, entered }
  facingMode: 'user',    // 사용자 요청: 전면 카메라 기본
  scanning: false,
  scanPaused: false,     // 인라인 피드백 표시 중에는 스캔 일시정지
  lastScan: { token: '', at: 0 },
  pendingTokens: new Set(),
  charts: { gender: null, age: null },
  tokenMap: new Map(),   // 즉시 판정용 로컬 캐시 (스캔 진입 시 1회 프리페치)
  tokensLoaded: false,
  currentModalToken: '', // (모달은 카메라 에러 등 시스템 오류용으로만 남겨둠)
  lastEnteredToken: '',  // 가장 최근에 시트와 매칭된 스캔 (숨겨진 플래그용)
  feedbackTimer: 0
};
const FEEDBACK_MS = 700;

/* ────────────────────────────────────────────────────────── */
/* 초기화                                                     */
/* ────────────────────────────────────────────────────────── */
function init() {
  // 저장된 설정 로드
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (saved.apiUrl) state.apiUrl = saved.apiUrl;
    if (saved.facingMode) state.facingMode = saved.facingMode;
  } catch (_) { /* ignore */ }

  if (!state.apiUrl) {
    show('screen-config');
  } else {
    show('screen-events');
    loadEvents();
  }

  // 설정 화면
  $('#saveConfig').addEventListener('click', saveConfig);
  $('#apiUrl').value = state.apiUrl || '';

  // 메인 화면
  $('#openSettings').addEventListener('click', () => {
    $('#apiUrl').value = state.apiUrl || '';
    show('screen-config');
  });
  $('#reloadEvents').addEventListener('click', loadEvents);

  // 액션 화면
  $$('[data-go]').forEach(btn => btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-go');
    if (target === 'screen-scan') startScan();
    if (target === 'screen-stats') openStats();
  }));
  $$('[data-back]').forEach(btn => btn.addEventListener('click', () => {
    const back = btn.getAttribute('data-back');
    stopScan();
    show(back);
  }));

  // 스캐너
  $('#flipCamera').addEventListener('click', flipCamera);
  $('#resultClose').addEventListener('click', closeResult);

  // 숨겨진 기능: 카운터 카드 탭 → 직전 스캔 토큰을 시트에서 "블랙" 표시 (무반응)
  const counter = document.querySelector('.counter-card');
  if (counter) counter.addEventListener('click', silentBlackFlag);

  // 통계
  $('#reloadStats').addEventListener('click', loadStats);

  // 서비스워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

function saveConfig() {
  const url = ($('#apiUrl').value || '').trim();
  if (!url || !/^https?:\/\//.test(url)) {
    toast('올바른 URL을 입력해주세요.');
    return;
  }
  state.apiUrl = url;
  persist();
  show('screen-events');
  loadEvents();
}

function persist() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    apiUrl: state.apiUrl,
    facingMode: state.facingMode
  }));
}

function show(id) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}

function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ────────────────────────────────────────────────────────── */
/* API 호출                                                   */
/* ────────────────────────────────────────────────────────── */
async function api(action, params = {}) {
  if (!state.apiUrl) throw new Error('api_url_not_set');
  const url = new URL(state.apiUrl);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // GET + redirect: follow → GAS 응답 형태에 가장 호환적
  const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error('http_' + res.status);
  return await res.json();
}

/* ────────────────────────────────────────────────────────── */
/* 행사 목록                                                  */
/* ────────────────────────────────────────────────────────── */
async function loadEvents() {
  const list = $('#eventList');
  list.innerHTML = '<div class="empty-state">불러오는 중…</div>';
  try {
    const r = await api('listEvents');
    if (!r.ok) throw new Error(r.error || 'unknown');
    const events = r.events || [];
    if (events.length === 0) {
      list.innerHTML = '<div class="empty-state">등록된 행사가 없습니다.<br/>구글 시트에 행사 탭을 만들어 주세요.</div>';
      return;
    }
    list.innerHTML = '';
    for (const ev of events) {
      const card = document.createElement('button');
      card.className = 'event-card';
      const ratio = ev.total > 0 ? Math.round((ev.entered / ev.total) * 100) : 0;
      card.innerHTML = `
        <div>
          <div class="name">${escapeHtml(ev.name)}</div>
          <div class="meta">총 ${ev.total}명 · 입장 ${ev.entered}명</div>
          <div class="progress">진행률 ${ratio}%</div>
        </div>
        <div class="arrow">›</div>
      `;
      card.addEventListener('click', () => selectEvent(ev));
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state">불러오기 실패<br/><small>${escapeHtml(String(e.message || e))}</small></div>`;
  }
}

function selectEvent(ev) {
  state.event = ev;
  $('#actionsTitle').textContent = ev.name;
  $('#actionsSummary').innerHTML = `
    <div><strong>${escapeHtml(ev.name)}</strong></div>
    <div>총 등록 ${ev.total}명 · 현재 입장 ${ev.entered}명</div>
  `;
  show('screen-actions');
}

/* ────────────────────────────────────────────────────────── */
/* 스캐너                                                     */
/* ────────────────────────────────────────────────────────── */
let stream = null;
let detector = null;
let rafId = 0;

async function startScan() {
  if (!state.event) { show('screen-events'); return; }
  $('#scanTitle').textContent = state.event.name;
  $('#counterEntered').textContent = state.event.entered || 0;
  $('#counterTotal').textContent = state.event.total || 0;
  show('screen-scan');

  try {
    await openCamera(state.facingMode);
  } catch (e) {
    showResult('error', '카메라를 열 수 없습니다', String(e.message || e));
    return;
  }

  // 토큰 캐시를 카메라 준비와 병렬로 프리페치 (블로킹 X).
  preloadTokens();

  // 가능하면 네이티브 디텍터 사용
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch (_) { detector = null; }
  } else {
    detector = null;
  }
  state.scanning = true;
  scanLoop();
}

async function preloadTokens() {
  state.tokensLoaded = false;
  state.tokenMap = new Map();
  try {
    const r = await api('listTokens', { event: state.event.name });
    if (r.ok && Array.isArray(r.tokens)) {
      for (const t of r.tokens) {
        state.tokenMap.set(String(t.token).trim().toUpperCase(), {
          phone: t.phone, age: t.age, gender: t.gender,
          entered: !!t.entered, enteredAt: t.enteredAt
        });
      }
      if (typeof r.entered === 'number') {
        state.event.entered = r.entered;
        $('#counterEntered').textContent = r.entered;
      }
      if (typeof r.total === 'number') {
        state.event.total = r.total;
        $('#counterTotal').textContent = r.total;
      }
      state.tokensLoaded = true;
    }
  } catch (_) {
    // 폴백: 캐시 없이 매 스캔마다 서버 확인 (이전 동작과 동일)
  }
}

async function openCamera(facingMode) {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    }
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $('#video');
  video.srcObject = stream;
  // 전면 카메라는 거울처럼 좌우 반전된 게 자연스럽지만,
  // QR은 좌우반전돼도 jsQR이 못 읽지는 않음. 사용자 시각 편의를 위해 반전.
  video.style.transform = (facingMode === 'user') ? 'scaleX(-1)' : 'none';
  await video.play();
}

async function flipCamera() {
  state.facingMode = (state.facingMode === 'user') ? 'environment' : 'user';
  persist();
  try {
    await openCamera(state.facingMode);
    toast(state.facingMode === 'user' ? '전면 카메라' : '후면 카메라');
  } catch (e) {
    toast('카메라 전환 실패');
  }
}

function stopScan() {
  state.scanning = false;
  state.scanPaused = false;
  clearTimeout(state.feedbackTimer);
  hideInlineFeedback();
  cancelAnimationFrame(rafId);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  detector = null;
}

async function scanLoop() {
  if (!state.scanning) return;
  if (state.scanPaused) {
    rafId = requestAnimationFrame(scanLoop);
    return;
  }
  const video = $('#video');
  if (video.readyState < 2) {
    rafId = requestAnimationFrame(scanLoop);
    return;
  }

  let token = null;
  try {
    if (detector) {
      const codes = await detector.detect(video);
      if (codes && codes.length > 0) {
        token = (codes[0].rawValue || '').trim();
      }
    } else {
      token = jsqrDetect(video);
    }
  } catch (_) { /* swallow per-frame errors */ }

  if (token) onScanned(token);

  rafId = requestAnimationFrame(scanLoop);
}

function jsqrDetect(video) {
  const canvas = $('#scanCanvas');
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  // 다운샘플링하여 처리속도↑ (긴 변 640 기준)
  const maxSide = 640;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);
  const code = jsQR(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
  return code ? (code.data || '').trim() : null;
}

/**
 * QR 인식 시 로컬 캐시로 즉시 판정 → 스캔 박스 안에 0.7초간 인라인 아이콘 표시.
 * 표시 동안 스캔은 일시정지. 입장 확정은 백그라운드로 서버에 fire-and-forget.
 */
function onScanned(token) {
  if (!token) return;
  const now = Date.now();
  if (token === state.lastScan.token && (now - state.lastScan.at) < RESCAN_COOLDOWN_MS) return;
  if (state.pendingTokens.has(token)) return;

  state.lastScan = { token, at: now };
  state.pendingTokens.add(token);
  feedback(); // 즉시 햅틱/사운드

  const upToken = String(token).trim().toUpperCase();
  const local = state.tokenMap.get(upToken);

  if (state.tokensLoaded && !local) {
    // 캐시 로드됨 + 토큰 없음 → 즉시 빨간 ×
    showInlineFeedback('error');
    state.pendingTokens.delete(token);
    return;
  }

  if (local && local.entered) {
    // 이미 사용 → 즉시 노란 !  (이 토큰을 마지막 스캔으로 기록)
    state.lastEnteredToken = upToken;
    showInlineFeedback('warn');
    state.pendingTokens.delete(token);
    return;
  }

  if (local && !local.entered) {
    // 신규 입장 → 낙관적으로 +1, 즉시 초록 ✓
    local.entered = true;
    local.enteredAt = new Date().toISOString();
    state.event.entered = (state.event.entered || 0) + 1;
    state.lastEnteredToken = upToken;
    $('#counterEntered').textContent = state.event.entered;
    showInlineFeedback('success');

    // 서버 입장 확정 (백그라운드)
    api('scan', { event: state.event.name, token: token })
      .then(r => reconcileScan(r, upToken, true, local))
      .catch(err => onScanNetworkError(err, true))
      .finally(() => state.pendingTokens.delete(token));
    return;
  }

  // 캐시 미로딩 상태 → 로딩 스피너 표시 후 서버 응답으로 결과 결정
  showInlineFeedback('loading');
  api('scan', { event: state.event.name, token: token })
    .then(r => reconcileScan(r, upToken, false, null))
    .catch(err => onScanNetworkError(err, false))
    .finally(() => state.pendingTokens.delete(token));
}

/**
 * 서버 응답으로 카운터/캐시 보정.
 *  - 낙관적 +1 후 서버가 'already' → 다른 기기가 먼저 처리. 토스트로 안내, 카운터 -1 롤백.
 *  - 캐시 없이 서버에만 의존한 경우 → 서버 응답에 따라 인라인 아이콘 갱신.
 */
function reconcileScan(r, upToken, optimistic, local) {
  if (r.ok && typeof r.enteredCount === 'number') {
    state.event.entered = r.enteredCount;
    $('#counterEntered').textContent = r.enteredCount;
    if (typeof r.total === 'number') {
      state.event.total = r.total;
      $('#counterTotal').textContent = r.total;
    }
  }

  if (!r.ok) {
    if (optimistic) {
      if (local) { local.entered = false; local.enteredAt = null; }
      state.event.entered = Math.max(0, (state.event.entered || 1) - 1);
      $('#counterEntered').textContent = state.event.entered;
      toast('직전 QR 처리 실패: ' + (r.error || ''));
    } else {
      // 서버 응답 대기 중이었음 → 인라인 아이콘 결과로 갱신
      showInlineFeedback('error');
    }
    return;
  }

  if (optimistic) {
    if (r.status === 'already') {
      // 동시 스캔으로 다른 기기가 먼저 처리. 카운터 보정.
      if (local && r.user && r.user.enteredAt) local.enteredAt = r.user.enteredAt;
      toast('직전 QR은 이미 사용된 QR이었습니다');
    }
    return;
  }

  // 캐시 미로딩 상태에서 서버에만 의존한 경로 → 서버 결과로 인라인 아이콘 갱신
  if (r.status === 'entered') {
    if (state.tokenMap.size > 0 && r.user) {
      state.tokenMap.set(upToken, Object.assign({}, r.user, { entered: true }));
    }
    state.lastEnteredToken = upToken;
    showInlineFeedback('success');
  } else if (r.status === 'already') {
    state.lastEnteredToken = upToken;
    showInlineFeedback('warn');
  }
}

function onScanNetworkError(err, optimistic) {
  if (optimistic) {
    toast('서버 동기화 실패. 시트에 반영되지 않았을 수 있습니다.', 4000);
  } else {
    showInlineFeedback('error');
    toast(String(err && err.message || err));
  }
}

function userBlock(u) {
  const phone = u.phone ? maskPhone(u.phone) : '-';
  const ageStr = formatAge(u.age);
  return `
    <div class="row"><span>전화번호</span><span>${escapeHtml(phone)}</span></div>
    ${u.gender ? `<div class="row"><span>성별</span><span>${escapeHtml(String(u.gender))}</span></div>` : ''}
    ${ageStr ? `<div class="row"><span>연령</span><span>${escapeHtml(ageStr)}</span></div>` : ''}
  `;
}

/** '25세' / 25 / ' 25 세 ' 등 입력 → '25세' 로 정규화. 무효면 빈 문자열. */
function formatAge(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const m = String(raw).trim().match(/^([0-9]{1,3})\s*세?\s*$/);
  return m ? `${parseInt(m[1], 10)}세` : '';
}

function showProcessing() {
  $('#scanStatus').classList.remove('hidden');
  $('#scanStatus').textContent = '처리 중…';
}

/**
 * 스캔 박스 안에 결과 아이콘을 0.7초간 표시. 표시 동안은 스캔이 일시정지된다.
 * kind: 'success' | 'warn' | 'error' | 'loading'
 *   - loading: 서버 응답 대기 (자동으로 사라지지 않음, 후속 호출이 갱신)
 */
function showInlineFeedback(kind) {
  const overlay = $('#scanFeedback');
  const icon = $('#scanFeedbackIcon');
  if (!overlay || !icon) return;

  state.scanPaused = true;
  clearTimeout(state.feedbackTimer);

  overlay.classList.remove('success', 'warn', 'error', 'loading', 'visible');
  // reflow 강제 → 애니메이션 재시작
  void overlay.offsetWidth;

  icon.textContent = (kind === 'success') ? '✓'
                   : (kind === 'warn')    ? '!'
                   : (kind === 'error')   ? '×'
                   : '';
  overlay.classList.add(kind, 'visible');

  if (kind === 'loading') return; // 후속 호출에서 success/warn/error 로 교체

  state.feedbackTimer = setTimeout(() => {
    overlay.classList.remove('visible');
    // fade-out (0.1s) 후 스캔 재개
    setTimeout(() => {
      overlay.classList.remove('success', 'warn', 'error', 'loading');
      state.scanPaused = false;
    }, 120);
  }, FEEDBACK_MS);
}

function hideInlineFeedback() {
  clearTimeout(state.feedbackTimer);
  const overlay = $('#scanFeedback');
  if (overlay) overlay.classList.remove('visible', 'success', 'warn', 'error', 'loading');
}

/**
 * 숨겨진 기능: 카운터 카드 탭 → 직전 매칭된 토큰의 시트 G열에 "블랙" 기록.
 * UI 반응 없음(시각/햅틱/사운드 모두 X). 실패도 조용히 무시.
 */
function silentBlackFlag() {
  if (!state.event || !state.lastEnteredToken) return;
  // fire-and-forget. 결과/에러 모두 사용자에게 노출하지 않는다.
  api('flag', {
    event: state.event.name,
    token: state.lastEnteredToken,
    value: '블랙'
  }).catch(() => {});
}

function showResult(kind, title, body, token) {
  $('#scanStatus').classList.add('hidden');
  const card = $('#resultCard');
  card.classList.remove('success', 'warn', 'error');
  card.classList.add(kind);
  $('#resultIcon').textContent = kind === 'success' ? '✓' : (kind === 'warn' ? '!' : '×');
  $('#resultTitle').textContent = title;
  $('#resultBody').innerHTML = body;
  $('#resultModal').classList.remove('hidden');
  state.currentModalToken = token || '';
}

function closeResult() {
  $('#resultModal').classList.add('hidden');
  state.currentModalToken = '';
}

function feedback() {
  if (navigator.vibrate) try { navigator.vibrate(35); } catch (_) {}
  // 짧은 비프음 (WebAudio)
  try {
    const ctx = feedback._ctx || (feedback._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1100;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  } catch (_) {}
}

/* ────────────────────────────────────────────────────────── */
/* 통계                                                       */
/* ────────────────────────────────────────────────────────── */
async function openStats() {
  if (!state.event) { show('screen-events'); return; }
  $('#statsTitle').textContent = state.event.name;
  show('screen-stats');
  await loadStats();
}

async function loadStats() {
  const summary = $('#statsSummary');
  summary.innerHTML = `<div class="empty-state" style="grid-column:1/-1">불러오는 중…</div>`;
  try {
    const r = await api('stats', { event: state.event.name });
    if (!r.ok) throw new Error(r.error || 'unknown');
    renderStats(r);
  } catch (e) {
    summary.innerHTML = `<div class="empty-state" style="grid-column:1/-1">실패: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderStats(r) {
  const total = r.total || 0;
  const entered = r.entered || 0;
  const ratio = total > 0 ? Math.round((entered / total) * 100) : 0;
  $('#statsSummary').innerHTML = `
    <div class="stat"><div class="label">총 등록</div><div class="value">${total}</div></div>
    <div class="stat"><div class="label">입장 완료</div><div class="value">${entered}</div></div>
    <div class="stat"><div class="label">진행률</div><div class="value">${ratio}%</div></div>
  `;

  // ── 성별 (원형) ──
  const gMale = r.gender['남'] || 0;
  const gFemale = r.gender['여'] || 0;
  const gOther = r.gender['기타'] || 0;
  drawGender(gMale, gFemale, gOther);

  // ── 연령 (막대) ── 데이터 있는 연령만 정렬 표시
  const ageEntries = Object.entries(r.age || {})
    .map(([a, c]) => [parseInt(a, 10), c])
    .filter(([a]) => !isNaN(a))
    .sort((a, b) => a[0] - b[0]);
  drawAge(ageEntries);
}

function drawGender(male, female, other) {
  const ctx = $('#genderChart').getContext('2d');
  if (state.charts.gender) state.charts.gender.destroy();
  const labels = ['남', '여'];
  const data = [male, female];
  const colors = ['#2563eb', '#ec4899'];
  if (other > 0) { labels.push('기타'); data.push(other); colors.push('#94a3b8'); }
  const total = data.reduce((a, b) => a + b, 0);

  state.charts.gender = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const v = item.parsed;
              const pct = total > 0 ? Math.round((v / total) * 100) : 0;
              return `${item.label}: ${v}명 (${pct}%)`;
            }
          }
        }
      }
    }
  });

  $('#genderLegend').innerHTML = labels.map((l, i) => {
    const v = data[i];
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    return `<span class="lg"><span class="dot" style="background:${colors[i]}"></span>${l} ${v}명 (${pct}%)</span>`;
  }).join('');
}

function drawAge(entries) {
  const ctx = $('#ageChart').getContext('2d');
  if (state.charts.age) state.charts.age.destroy();
  const labels = entries.map(([a]) => `${a}세`);
  const counts = entries.map(([, c]) => c);
  state.charts.age = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: counts,
        backgroundColor: '#10b981',
        borderRadius: 6,
        maxBarThickness: 38
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, stepSize: 1 },
          grid: { color: '#f1f5f9' }
        },
        x: { grid: { display: false } }
      }
    }
  });
}

/* ────────────────────────────────────────────────────────── */
/* 유틸                                                       */
/* ────────────────────────────────────────────────────────── */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function maskPhone(p) {
  const s = String(p).replace(/[^0-9]/g, '');
  if (s.length === 11) return `${s.substring(0,3)}-****-${s.substring(7)}`;
  if (s.length === 10) return `${s.substring(0,3)}-***-${s.substring(6)}`;
  return p;
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return iso; }
}

document.addEventListener('DOMContentLoaded', init);
