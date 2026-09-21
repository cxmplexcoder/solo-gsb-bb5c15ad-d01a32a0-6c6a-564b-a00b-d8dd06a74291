'use strict';

/* ABX 盲听测试前端
 *
 * 播放引擎基于 Web Audio API：
 * - A / B 解码一次，X 按题解码并缓存
 * - 切换音源 / 切换题目时保持播放位置与暂停状态
 * - 统一时间轴 = min(A 时长, B 时长)
 */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let session = null;          // { id, numTrials, recoveryToken }
let answers = [];            // 每题 'A' | 'B' | null
let currentTrial = 0;

// ---------------------------------------------------------------------------
// 恢复标识（仅存本机浏览器 localStorage，不会离开本机）
// ---------------------------------------------------------------------------

const RECOVERY_KEY = 'abx.recovery';
let pendingResume = null;    // 页面加载时探测到的可恢复会话

function saveRecovery() {
  if (!session || !session.recoveryToken) return;
  localStorage.setItem(RECOVERY_KEY, JSON.stringify({
    token: session.recoveryToken,
    trial: currentTrial,
  }));
}

function loadSavedRecovery() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY));
    if (saved && typeof saved.token === 'string') return saved;
  } catch (_) { /* 忽略损坏的本地数据 */ }
  return null;
}

function clearRecovery() {
  localStorage.removeItem(RECOVERY_KEY);
}

let actx = null;             // AudioContext
const buffers = { A: null, B: null, X: null };
const xCache = new Map();    // trialIndex -> AudioBuffer
let timeline = 0;            // 统一时间轴（较短时长，秒）

let currentSrc = 'A';        // 当前音源 'A' | 'B' | 'X'
let playing = false;
let sourceNode = null;
let startCtxTime = 0;        // 本次播放起点对应的 AudioContext 时间
let startOffset = 0;         // 本次播放起点对应的音频位置（秒）

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('#' + viewId).classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 播放引擎
// ---------------------------------------------------------------------------

function position() {
  if (!playing) return startOffset;
  return Math.min(startOffset + actx.currentTime - startCtxTime, timeline);
}

function stopSource() {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch (_) { /* 已停止 */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
}

function play() {
  if (playing || !buffers[currentSrc]) return;
  if (startOffset >= timeline) startOffset = 0;
  const buf = buffers[currentSrc];
  const remain = Math.max(0, Math.min(timeline, buf.duration) - startOffset);
  if (remain <= 0) return;

  sourceNode = actx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(actx.destination);
  sourceNode.onended = () => {
    // 自然播放到时间轴末尾
    sourceNode = null;
    playing = false;
    startOffset = 0;
    updatePlayBtn();
  };
  sourceNode.start(0, startOffset, remain);
  startCtxTime = actx.currentTime;
  playing = true;
  updatePlayBtn();
}

function pause() {
  if (!playing) return;
  startOffset = position();
  stopSource();
  playing = false;
  updatePlayBtn();
}

/** 切换 A / B / X，保持播放位置与暂停状态 */
function switchSource(which) {
  if (which === currentSrc || !buffers[which]) return;
  const pos = position();
  const wasPlaying = playing;
  stopSource();
  playing = false;
  currentSrc = which;
  startOffset = pos;
  if (wasPlaying) play();
  updateSrcButtons();
}

function seekTo(t) {
  const wasPlaying = playing;
  stopSource();
  playing = false;
  startOffset = Math.max(0, Math.min(t, timeline));
  if (wasPlaying) play();
  updateTransport();
}

// ---------------------------------------------------------------------------
// 音频加载
// ---------------------------------------------------------------------------

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('音频加载失败');
  const raw = await res.arrayBuffer();
  return actx.decodeAudioData(raw);
}

async function loadTrial(n) {
  currentTrial = n;
  saveRecovery(); // 记住当前题号，刷新后可回到本题
  if (!xCache.has(n)) {
    xCache.set(n, await fetchBuffer(`/api/session/${session.id}/trial/${n}/x`));
  }
  buffers.X = xCache.get(n);
  // 若当前正在听 X，无缝换成本题的 X（保持位置与播放状态）
  if (currentSrc === 'X') {
    const pos = position();
    const wasPlaying = playing;
    stopSource();
    playing = false;
    startOffset = pos;
    if (wasPlaying) play();
  }
  renderTrial();
}

// ---------------------------------------------------------------------------
// UI 渲染
// ---------------------------------------------------------------------------

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function updatePlayBtn() {
  $('#btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 播放';
}

function updateTransport() {
  $('#seek').value = position();
  $('#timeLabel').textContent = `${fmt(position())} / ${fmt(timeline)}`;
}

function updateSrcButtons() {
  document.querySelectorAll('.src-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.src === currentSrc);
  });
}

function renderTrial() {
  $('#trialLabel').textContent = `第 ${currentTrial + 1} / ${session.numTrials} 题`;
  $('#btnPrev').disabled = currentTrial === 0;
  $('#btnNext').disabled = currentTrial === session.numTrials - 1;

  const ans = answers[currentTrial];
  $('#btnAnsA').classList.toggle('selected', ans === 'A');
  $('#btnAnsB').classList.toggle('selected', ans === 'B');

  // 进度圆点
  const progress = $('#progress');
  progress.innerHTML = '';
  for (let i = 0; i < session.numTrials; i++) {
    const dot = document.createElement('button');
    dot.className = 'dot';
    if (answers[i]) dot.classList.add('done');
    if (i === currentTrial) dot.classList.add('current');
    dot.textContent = i + 1;
    dot.addEventListener('click', () => loadTrial(i));
    progress.appendChild(dot);
  }

  const allAnswered = answers.every(Boolean);
  $('#btnSubmit').disabled = !allAnswered;
  $('#btnSubmit').textContent = allAnswered
    ? '提交并揭晓答案'
    : `提交并揭晓答案（还剩 ${answers.filter((a) => !a).length} 题未答）`;
}

function tick() {
  if (playing) updateTransport();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

/** 进入测试视图：解码 A/B、初始化播放状态并加载当前题（新建与恢复共用） */
async function enterTest() {
  // AudioContext 需在用户手势中创建
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  await actx.resume();

  buffers.A = await fetchBuffer(`/api/session/${session.id}/audio/A`);
  buffers.B = await fetchBuffer(`/api/session/${session.id}/audio/B`);
  // 统一时间轴：以较短时长为准
  timeline = Math.min(buffers.A.duration, buffers.B.duration);
  $('#seek').max = timeline;

  currentSrc = 'A';
  playing = false;
  startOffset = 0;
  updateSrcButtons();
  updatePlayBtn();
  updateTransport();

  await loadTrial(currentTrial);
  show('view-test');
}

$('#btnStart').addEventListener('click', async () => {
  const errEl = $('#uploadError');
  errEl.textContent = '';
  const fa = $('#fileA').files[0];
  const fb = $('#fileB').files[0];
  if (!fa || !fb) {
    errEl.textContent = '请同时选择音频 A 和音频 B';
    return;
  }

  const btn = $('#btnStart');
  btn.disabled = true;
  btn.textContent = '上传并解码中…';
  try {
    // 开始新测试即放弃旧的待恢复会话（主动删除，恢复标识随之失效）
    if (pendingResume) {
      await fetch(`/api/session/${pendingResume.id}`, { method: 'DELETE' }).catch(() => {});
      pendingResume = null;
      $('#view-resume').classList.add('hidden');
    }

    const fd = new FormData();
    fd.append('a', fa);
    fd.append('b', fb);
    fd.append('numTrials', $('#numTrials').value);
    const res = await fetch('/api/session', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建会话失败');

    session = data;
    answers = Array(data.numTrials).fill(null);
    currentTrial = 0;
    xCache.clear();
    saveRecovery(); // 保存恢复标识，刷新/重开页面可找回本会话

    await enterTest();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始测试';
  }
});

// ---------------------------------------------------------------------------
// 会话恢复（刷新 / 重新打开页面后找回未提交的测试）
// ---------------------------------------------------------------------------

async function initRecovery() {
  const saved = loadSavedRecovery();
  if (!saved) return;
  try {
    const res = await fetch('/api/session/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: saved.token }),
    });
    if (!res.ok) throw new Error('recover failed');
    const data = await res.json();
    pendingResume = {
      ...data,
      token: saved.token,
      trial: Math.min(Math.max(0, saved.trial | 0), data.numTrials - 1),
    };
    const answered = data.answers.filter(Boolean).length;
    $('#resumeInfo').textContent =
      `检测到本机有未提交的测试：共 ${data.numTrials} 题，已答 ${answered} 题，` +
      `上次进行到第 ${pendingResume.trial + 1} 题。`;
    $('#view-resume').classList.remove('hidden');
  } catch (_) {
    clearRecovery(); // 会话已提交、删除或过期，恢复标识不再有效
  }
}

$('#btnResume').addEventListener('click', async () => {
  if (!pendingResume) return;
  const btn = $('#btnResume');
  btn.disabled = true;
  btn.textContent = '正在恢复…';
  const resume = pendingResume;
  try {
    session = {
      id: resume.id,
      numTrials: resume.numTrials,
      recoveryToken: resume.token,
    };
    answers = resume.answers.slice();
    currentTrial = resume.trial;
    xCache.clear();
    await enterTest();
    pendingResume = null;
    $('#view-resume').classList.add('hidden');
  } catch (e) {
    alert(e.message || '恢复失败');
    btn.disabled = false;
    btn.textContent = '继续上次测试';
  }
});

$('#btnDiscardResume').addEventListener('click', async () => {
  if (pendingResume) {
    await fetch(`/api/session/${pendingResume.id}`, { method: 'DELETE' }).catch(() => {});
  }
  pendingResume = null;
  clearRecovery();
  $('#view-resume').classList.add('hidden');
});

$('#btnPlay').addEventListener('click', async () => {
  await actx.resume();
  if (playing) pause();
  else play();
});

document.querySelectorAll('.src-btn').forEach((b) => {
  b.addEventListener('click', () => switchSource(b.dataset.src));
});

$('#seek').addEventListener('input', (e) => seekTo(parseFloat(e.target.value)));

$('#btnPrev').addEventListener('click', () => { if (currentTrial > 0) loadTrial(currentTrial - 1); });
$('#btnNext').addEventListener('click', () => { if (currentTrial < session.numTrials - 1) loadTrial(currentTrial + 1); });

async function sendAnswer(val) {
  answers[currentTrial] = val;
  renderTrial();
  const res = await fetch(`/api/session/${session.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trial: currentTrial, answer: val }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '答案保存失败');
  }
}

$('#btnAnsA').addEventListener('click', () => sendAnswer('A'));
$('#btnAnsB').addEventListener('click', () => sendAnswer('B'));

$('#btnSubmit').addEventListener('click', async () => {
  if (!confirm('提交后将一次性揭晓全部答案，且不可再修改。确定提交？')) return;
  const res = await fetch(`/api/session/${session.id}/submit`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '提交失败');
    return;
  }
  pause();
  clearRecovery(); // 提交后恢复标识立即失效（服务端同步作废）
  showResults(data.results);
});

$('#btnAgain').addEventListener('click', async () => {
  pause();
  if (session) {
    await fetch(`/api/session/${session.id}`, { method: 'DELETE' }).catch(() => {});
  }
  session = null;
  answers = [];
  xCache.clear();
  clearRecovery();
  buffers.A = buffers.B = buffers.X = null;
  currentSrc = 'A';
  startOffset = 0;
  $('#fileA').value = '';
  $('#fileB').value = '';
  show('view-upload');
});

// ---------------------------------------------------------------------------
// 结果展示
// ---------------------------------------------------------------------------

function showResults(results) {
  const pct = (results.accuracy * 100).toFixed(1);
  $('#scoreLabel').textContent =
    `答对 ${results.correct} / ${results.total} 题，正确率 ${pct}%`;

  const tbody = $('#resultTable tbody');
  tbody.innerHTML = '';
  for (const d of results.detail) {
    const tr = document.createElement('tr');
    tr.className = d.correct ? 'right' : 'wrong';
    tr.innerHTML =
      `<td>${d.trial}</td><td>${d.x}</td><td>${d.answer}</td>` +
      `<td>${d.correct ? '✓ 正确' : '✗ 错误'}</td>`;
    tbody.appendChild(tr);
  }
  show('view-result');
}

// 启动 UI 刷新循环，并探测本机是否有可恢复的未提交会话
tick();
initRecovery();
