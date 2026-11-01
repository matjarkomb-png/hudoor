/* حضور — تسجيل الدخول والخروج بالتعرف على الوجه
 * يعمل كاملاً على الجهاز: لا يرسل أي صورة أو بيانات إلى أي خادم.
 */
(() => {
'use strict';

// ===== إعدادات ثابتة =====
const CDN_LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js';
const CDN_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
const SAMPLES_NEEDED = 5;
const HITS_TO_CONFIRM = 3;       // عدد الإطارات المتتالية المطلوبة لتأكيد الهوية
const CARD_SECONDS = 10;         // مدة بقاء بطاقة الموظف قبل الإغلاق التلقائي
const ADMIN_IDLE_MS = 3 * 60 * 1000;
const MIN_FACE_RATIO = 0.16;     // أصغر حجم للوجه نسبة لعرض الصورة

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// ===== الحالة =====
const S = {
  employees: [],
  settings: { company: '', threshold: 0.48, dup: 5, pinHash: null, syncUrl: '', syncKey: '', device: '', lastSync: 0 },
  sync: { busy: false, error: '', dirty: false, pending: 0 },
  scan: null,
  stream: null,
  kioskTimer: null,
  detecting: false,
  match: { empId: null, hits: 0, unknown: 0 },
  card: null,           // { emp, timer, start }
  cooldown: {},         // empId -> timestamp حتى لا تظهر البطاقة مرة أخرى فوراً
  enroll: null,         // { editId, samples: [], thumb, running }
  recordsView: 'summary',
  adminIdle: null,
};

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');

function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function time12(ts) {
  const d = new Date(ts); let h = d.getHours(); const m = d.getMinutes();
  const suf = h < 12 ? 'ص' : 'م'; h = h % 12; if (h === 0) h = 12;
  return `${pad(h)}:${pad(m)} ${suf}`;
}
function longDate(ts) { const d = new Date(ts); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtDuration(ms) { const mins = Math.round(ms / 60000); return `${Math.floor(mins / 60)}:${pad(mins % 60)}`; }
function startOfDay(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); }
function endOfDay(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); }

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
  if (screenId === 'screen-kiosk') startKiosk(); else stopKiosk();
  if (screenId === 'screen-admin' || screenId === 'screen-enroll') armAdminIdle(); else clearTimeout(S.adminIdle);
}
function current() { const a = document.querySelector('.screen.active'); return a ? a.id : ''; }

// ===== تحميل مكتبة التعرف على الوجه =====
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
async function exists(url) {
  try { const r = await fetch(url, { method: 'GET', cache: 'no-store' }); return r.ok; } catch (e) { return false; }
}
async function loadFaceApi() {
  const msg = $('loading-text');
  if (!window.faceapi) {
    try { await loadScript('lib/face-api.js'); }
    catch (e) {
      msg.textContent = 'جاري تحميل المكتبة من الإنترنت…';
      await loadScript(CDN_LIB);
    }
  }
  try {
    if (faceapi.tf && faceapi.tf.setBackend) {
      await faceapi.tf.setBackend('webgl').catch(() => faceapi.tf.setBackend('cpu'));
      await faceapi.tf.ready();
    }
  } catch (e) { /* يستخدم الافتراضي */ }
  const base = (await exists('models/face_recognition_model-weights_manifest.json')) ? 'models' : CDN_MODELS;
  msg.textContent = 'جاري تجهيز نماذج التعرف…';
  await faceapi.nets.tinyFaceDetector.loadFromUri(base);
  await faceapi.nets.faceLandmark68Net.loadFromUri(base);
  await faceapi.nets.faceRecognitionNet.loadFromUri(base);
}

const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

async function detectFace(video) {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  const r = await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
  if (!r) return null;
  const box = r.detection.box;
  return { descriptor: Array.from(r.descriptor), score: r.detection.score, box, ratio: box.width / video.videoWidth };
}

function distance(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s);
}
function bestMatch(descriptor, excludeId) {
  let best = null;
  for (const emp of S.employees) {
    if (emp.id === excludeId || !emp.descriptors || !emp.descriptors.length) continue;
    let min = Infinity;
    for (const d of emp.descriptors) min = Math.min(min, distance(descriptor, d));
    if (!best || min < best.dist) best = { emp, dist: min };
  }
  return best;
}

// ===== الكاميرا =====
async function ensureCamera() {
  if (S.stream && S.stream.active) return S.stream;
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
  });
  return S.stream;
}
async function attachCamera(video) {
  const stream = await ensureCamera();
  if (video.srcObject !== stream) video.srcObject = stream;
  try { await video.play(); } catch (e) {}
}

// ===== شاشة الحضور =====
function tickClock() {
  const now = Date.now();
  $('kiosk-clock').textContent = time12(now);
  $('kiosk-date').textContent = longDate(now);
}

async function startKiosk() {
  $('kiosk-company').textContent = S.settings.company || 'تسجيل الحضور';
  tickClock();
  try { await attachCamera($('video')); }
  catch (e) { setStatus('لا يمكن تشغيل الكاميرا. تأكد من منح إذن الكاميرا للتطبيق.', 'warn'); return; }
  if (!S.employees.length) setStatus('لا يوجد موظفون بعد. اضغط ⚙ لإضافتهم', 'warn');
  if (!S.kioskTimer) loopKiosk();
}
function stopKiosk() { clearTimeout(S.kioskTimer); S.kioskTimer = null; closeCard(); }

function setStatus(text, cls) {
  const el = $('kiosk-status'); el.textContent = text; el.className = 'status-pill' + (cls ? ' ' + cls : '');
}

async function loopKiosk() {
  S.kioskTimer = setTimeout(loopKiosk, 220);
  if (current() !== 'screen-kiosk' || S.card || S.detecting || !S.employees.length) return;
  S.detecting = true;
  try {
    const f = await detectFace($('video'));
    if (S.card || current() !== 'screen-kiosk') return;
    if (!f) { S.match = { empId: null, hits: 0, unknown: 0 }; setStatus('انظر إلى الكاميرا'); return; }
    if (f.ratio < MIN_FACE_RATIO) { setStatus('اقترب من الكاميرا قليلاً'); return; }
    const m = bestMatch(f.descriptor);
    if (m && m.dist < S.settings.threshold) {
      const until = S.cooldown[m.emp.id] || 0;
      if (Date.now() < until) return;
      S.match.hits = (S.match.empId === m.emp.id) ? S.match.hits + 1 : 1;
      S.match.empId = m.emp.id; S.match.unknown = 0;
      setStatus('جارٍ التحقق…', 'ok');
      if (S.match.hits >= HITS_TO_CONFIRM) { S.match = { empId: null, hits: 0, unknown: 0 }; openCard(m.emp); }
    } else {
      S.match.empId = null; S.match.hits = 0; S.match.unknown++;
      if (S.match.unknown >= 5) setStatus('لم يتم التعرف على الوجه', 'warn');
    }
  } catch (e) {
    console.error(e);
  } finally { S.detecting = false; }
}

async function lastRecordToday(empId) {
  const today = dayKey(Date.now());
  const recs = await DB.recordsBetween(startOfDay(today), endOfDay(today));
  const mine = recs.filter(r => r.empId === empId).sort((a, b) => a.ts - b.ts);
  return mine[mine.length - 1] || null;
}

async function openCard(emp) {
  const last = await lastRecordToday(emp.id);
  $('match-photo').src = emp.photo || '';
  $('match-name').textContent = emp.name;
  $('match-last').textContent = last
    ? `آخر حركة اليوم: ${last.type === 'in' ? 'دخول' : 'خروج'} ${time12(last.ts)}`
    : 'لا توجد حركات اليوم';
  const suggestOut = last && last.type === 'in';
  $('btn-in').classList.toggle('suggested', !suggestOut);
  $('btn-out').classList.toggle('suggested', !!suggestOut);
  $('match-card').classList.remove('hidden');
  setStatus(`مرحباً ${emp.name}`, 'ok');

  const bar = $('countdown-bar');
  bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${CARD_SECONDS}s linear`; bar.style.width = '0%';
  }));
  S.card = { emp, timer: setTimeout(() => { S.cooldown[emp.id] = Date.now() + 3000; closeCard(); }, CARD_SECONDS * 1000) };
}
function closeCard() {
  if (S.card) clearTimeout(S.card.timer);
  S.card = null;
  $('match-card').classList.add('hidden');
}

async function punch(type) {
  if (!S.card) return;
  const emp = S.card.emp;
  closeCard();
  S.cooldown[emp.id] = Date.now() + 6000;
  const now = Date.now();
  const last = await lastRecordToday(emp.id);
  const dupMs = (Number(S.settings.dup) || 0) * 60000;
  if (last && last.type === type && now - last.ts < dupMs) {
    toast('warn', 'مسجّل مسبقاً', `${emp.name}<br>سبق تسجيل ${type === 'in' ? 'دخولك' : 'خروجك'} الساعة ${time12(last.ts)}`);
    return;
  }
  await DB.put('records', { id: uid(), empId: emp.id, empName: emp.name, empCode: emp.code || '', type, ts: now, synced: false });
  toast(type, type === 'in' ? 'تم تسجيل الدخول ✓' : 'تم تسجيل الخروج ✓', `${esc(emp.name)}<br>${time12(now)}`);
  syncNow();
}

let toastTimer = null;
function toast(cls, title, html) {
  const t = $('toast');
  t.className = 'toast ' + cls;
  t.innerHTML = `<div class="big">${esc(title)}</div><div>${html}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  setStatus('انظر إلى الكاميرا');
}

// ===== رمز المدير =====
async function hashPin(pin) {
  const data = new TextEncoder().encode('hudoor:' + pin);
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0; for (const b of data) h = (h * 31 + b) >>> 0; return 'x' + h.toString(16);
}
function openPin() {
  $('pin-input').value = ''; $('pin-error').textContent = '';
  $('pin-modal').classList.remove('hidden');
  closeCard();
  setTimeout(() => $('pin-input').focus(), 50);
}
async function checkPin() {
  const h = await hashPin($('pin-input').value.trim());
  if (h === S.settings.pinHash) {
    $('pin-modal').classList.add('hidden');
    openAdmin();
  } else {
    $('pin-error').textContent = 'الرمز غير صحيح';
  }
}

// ===== الإدارة =====
function armAdminIdle() {
  clearTimeout(S.adminIdle);
  S.adminIdle = setTimeout(() => { if (current() === 'screen-admin') show('screen-kiosk'); }, ADMIN_IDLE_MS);
}
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => {
  const c = current(); if (c === 'screen-admin' || c === 'screen-enroll') armAdminIdle();
}, { passive: true }));

function openAdmin(tab) {
  show('screen-admin');
  selectTab(tab || document.querySelector('.tab.active').dataset.tab);
}
function selectTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'employees') renderEmployees();
  if (name === 'records') { fillEmpFilter(); renderRecords(); }
  if (name === 'settings') fillSettings();
}

async function reloadEmployees() {
  S.employees = (await DB.all('employees')).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

function renderEmployees() {
  $('emp-count').textContent = `عدد الموظفين: ${S.employees.length}`;
  const list = $('emp-list');
  if (!S.employees.length) {
    list.innerHTML = '<div class="empty">لا يوجد موظفون بعد.<br>اضغط "إضافة موظف" لتسجيل أول موظف ووجهه.</div>';
    return;
  }
  list.innerHTML = S.employees.map(e => `
    <div class="emp">
      <img src="${esc(e.photo || '')}" alt="">
      <div class="info">
        <div class="name">${esc(e.name)}</div>
        <div class="muted small">${e.code ? 'رقم ' + esc(e.code) + ' · ' : ''}${(e.descriptors || []).length} صور للوجه</div>
      </div>
      <div class="actions">
        <button class="btn ghost small-btn" data-edit="${esc(e.id)}">تعديل</button>
        <button class="btn danger small-btn" data-del="${esc(e.id)}">حذف</button>
      </div>
    </div>`).join('');
}

$('emp-list').addEventListener('click', async ev => {
  const editId = ev.target.dataset.edit, delId = ev.target.dataset.del;
  if (editId) openEnroll(editId);
  if (delId) {
    const emp = S.employees.find(e => e.id === delId);
    if (await confirmBox(`حذف الموظف "${emp.name}"؟ ستبقى سجلاته السابقة محفوظة.`)) {
      await DB.del('employees', delId); await reloadEmployees(); renderEmployees();
      S.sync.dirty = true; syncNow();
    }
  }
});

// ===== إضافة / تعديل موظف =====
const PROMPTS = ['انظر مباشرة إلى الكاميرا', 'أمِل رأسك قليلاً لليمين', 'أمِل رأسك قليلاً لليسار', 'ارفع ذقنك قليلاً', 'انظر مباشرة مرة أخرى'];

async function openEnroll(editId) {
  const emp = editId ? S.employees.find(e => e.id === editId) : null;
  S.enroll = { editId: editId || null, samples: [], thumb: null, running: false };
  $('enroll-title').textContent = emp ? 'تعديل موظف' : 'إضافة موظف';
  $('e-name').value = emp ? emp.name : '';
  $('e-code').value = emp ? (emp.code || '') : '';
  $('enroll-thumbs').innerHTML = '';
  $('enroll-progress').style.width = '0%';
  $('enroll-error').textContent = '';
  $('enroll-start').textContent = emp ? 'إعادة التقاط الوجه' : 'بدء التقاط الوجه';
  $('enroll-start').disabled = false;
  $('enroll-status').textContent = emp ? 'يمكنك تعديل الاسم فقط، أو إعادة التقاط الوجه' : 'اكتب الاسم ثم اضغط "بدء التقاط الوجه"';
  updateEnrollSave();
  show('screen-enroll');
  try { await attachCamera($('enroll-video')); }
  catch (e) { $('enroll-error').textContent = 'لا يمكن تشغيل الكاميرا. تأكد من منح الإذن للتطبيق.'; }
}

function updateEnrollSave() {
  const e = S.enroll; if (!e) return;
  const hasName = $('e-name').value.trim().length > 0;
  const hasFace = e.samples.length >= SAMPLES_NEEDED || (e.editId && e.samples.length === 0);
  $('enroll-save').disabled = !(hasName && hasFace && !e.running);
}

function cropFace(video, box) {
  const c = document.createElement('canvas'); c.width = 160; c.height = 160;
  const pad = box.width * 0.35;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const w = Math.min(video.videoWidth - x, box.width + pad * 2), h = Math.min(video.videoHeight - y, box.height + pad * 2);
  const size = Math.min(w, h);
  c.getContext('2d').drawImage(video, x + (w - size) / 2, y + (h - size) / 2, size, size, 0, 0, 160, 160);
  return c.toDataURL('image/jpeg', 0.8);
}

async function runEnroll() {
  const e = S.enroll; if (!e || e.running) return;
  e.running = true; e.samples = []; e.thumb = null;
  $('enroll-thumbs').innerHTML = ''; $('enroll-error').textContent = '';
  $('enroll-start').disabled = true; updateEnrollSave();
  const video = $('enroll-video');
  let lastAt = 0;
  const deadline = Date.now() + 60000;
  while (e.samples.length < SAMPLES_NEEDED && current() === 'screen-enroll' && S.enroll === e) {
    if (Date.now() > deadline) { $('enroll-error').textContent = 'انتهى الوقت. تأكد من الإضاءة الجيدة وحاول مرة أخرى.'; break; }
    $('enroll-status').textContent = `(${e.samples.length + 1}/${SAMPLES_NEEDED}) ${PROMPTS[e.samples.length]}`;
    let f = null;
    try { f = await detectFace(video); } catch (err) { console.error(err); }
    if (f && f.score >= 0.7 && f.ratio >= MIN_FACE_RATIO + 0.04 && Date.now() - lastAt > 700) {
      if (e.samples.length && distance(f.descriptor, e.samples[0]) > 0.62) {
        $('enroll-status').textContent = 'تم رصد وجه مختلف! يجب أن يقف شخص واحد أمام الكاميرا';
      } else {
        e.samples.push(f.descriptor);
        const img = cropFace(video, f.box);
        if (!e.thumb) e.thumb = img;
        $('enroll-thumbs').insertAdjacentHTML('beforeend', `<img src="${img}" alt="">`);
        $('enroll-progress').style.width = (e.samples.length / SAMPLES_NEEDED * 100) + '%';
        lastAt = Date.now();
      }
    } else if (f && f.ratio < MIN_FACE_RATIO + 0.04) {
      $('enroll-status').textContent = 'اقترب من الكاميرا قليلاً';
    }
    await new Promise(r => setTimeout(r, 150));
  }
  e.running = false;
  $('enroll-start').disabled = false;
  if (e.samples.length >= SAMPLES_NEEDED) {
    // تأكد أن الوجه غير مسجل باسم موظف آخر
    let worst = null;
    for (const s of e.samples) {
      const m = bestMatch(s, e.editId);
      if (m && m.dist < S.settings.threshold && (!worst || m.dist < worst.dist)) worst = m;
    }
    if (worst) {
      $('enroll-error').textContent = `هذا الوجه يشبه الموظف المسجل "${worst.emp.name}". إذا كان هو نفسه فعدّل بياناته بدل إضافته مرة ثانية.`;
      e.samples = [];
      $('enroll-progress').style.width = '0%';
      $('enroll-status').textContent = 'لم يتم الحفظ';
    } else {
      $('enroll-status').textContent = 'تم التقاط الوجه بنجاح ✓ اضغط "حفظ الموظف"';
    }
  } else if (e.samples.length) {
    e.samples = [];
  }
  updateEnrollSave();
}

async function saveEnroll() {
  const e = S.enroll; if (!e) return;
  const name = $('e-name').value.trim();
  if (!name) { $('enroll-error').textContent = 'اكتب اسم الموظف'; return; }
  const existing = e.editId ? S.employees.find(x => x.id === e.editId) : null;
  const emp = existing ? Object.assign({}, existing) : { id: uid(), createdAt: Date.now() };
  emp.name = name;
  emp.code = $('e-code').value.trim();
  if (e.samples.length >= SAMPLES_NEEDED) { emp.descriptors = e.samples; emp.photo = e.thumb; }
  if (!emp.descriptors || !emp.descriptors.length) { $('enroll-error').textContent = 'التقط الوجه أولاً'; return; }
  await DB.put('employees', emp);
  await reloadEmployees();
  S.enroll = null;
  S.sync.dirty = true; syncNow();
  openAdmin('employees');
}

// ===== السجلات =====
function fillEmpFilter() {
  const sel = $('f-emp'); const v = sel.value;
  sel.innerHTML = '<option value="">الكل</option>' + S.employees.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  sel.value = v;
}
function setRange(kind) {
  const now = new Date();
  const today = dayKey(now.getTime());
  $('f-to').value = today;
  $('f-from').value = kind === 'month' ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01` : today;
  renderRecords();
}

async function loadFilteredRecords() {
  const from = $('f-from').value, to = $('f-to').value;
  if (!from || !to) return [];
  let recs = await DB.recordsBetween(startOfDay(from), endOfDay(to));
  const empId = $('f-emp').value;
  if (empId) recs = recs.filter(r => r.empId === empId);
  return recs.sort((a, b) => a.ts - b.ts);
}

function empLabel(r) {
  const emp = S.employees.find(e => e.id === r.empId);
  return { name: emp ? emp.name : (r.empName || '—'), code: emp ? (emp.code || '') : (r.empCode || '') };
}

function buildSummary(recs) {
  const groups = new Map();
  for (const r of recs) {
    const k = r.empId + '|' + dayKey(r.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rows = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const { name, code } = empLabel(list[0]);
    const ins = list.filter(r => r.type === 'in'), outs = list.filter(r => r.type === 'out');
    let worked = 0, openIn = null, missing = false;
    for (const r of list) {
      if (r.type === 'in') { if (openIn !== null) missing = true; openIn = r.ts; }
      else { if (openIn !== null) { worked += r.ts - openIn; openIn = null; } else missing = true; }
    }
    if (openIn !== null) missing = true;
    rows.push({
      empId: list[0].empId, name, code, day: dayKey(list[0].ts), ts: list[0].ts,
      firstIn: ins.length ? ins[0].ts : null, lastOut: outs.length ? outs[outs.length - 1].ts : null,
      worked, missing
    });
  }
  rows.sort((a, b) => a.day === b.day ? a.name.localeCompare(b.name, 'ar') : (a.day < b.day ? -1 : 1));
  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.empId) || { name: r.name, code: r.code, days: 0, worked: 0 };
    t.days++; t.worked += r.worked; totals.set(r.empId, t);
  }
  return { rows, totals: Array.from(totals.values()).sort((a, b) => a.name.localeCompare(b.name, 'ar')) };
}

async function renderRecords() {
  const recs = await loadFilteredRecords();
  const box = $('records-table');
  if (!recs.length) { box.innerHTML = '<div class="empty">لا توجد سجلات في هذه الفترة</div>'; return; }
  if (S.recordsView === 'summary') {
    const { rows, totals } = buildSummary(recs);
    box.innerHTML = `<table>
      <thead><tr><th>الموظف</th><th>التاريخ</th><th>أول دخول</th><th>آخر خروج</th><th>ساعات العمل</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.name)}</td>
        <td>${DAYS[new Date(r.ts).getDay()]} <span class="num">${r.day}</span></td>
        <td>${r.firstIn ? time12(r.firstIn) : '—'}</td>
        <td>${r.lastOut ? time12(r.lastOut) : '—'}</td>
        <td class="num">${fmtDuration(r.worked)}</td>
        <td>${r.missing ? '<span class="tag miss">حركة ناقصة</span>' : ''}</td>
      </tr>`).join('')}</tbody>
      <thead><tr><th>الإجمالي</th><th>أيام الحضور</th><th colspan="2"></th><th>مجموع الساعات</th><th></th></tr></thead>
      <tbody>${totals.map(t => `<tr><td>${esc(t.name)}</td><td>${t.days}</td><td colspan="2"></td><td class="num">${fmtDuration(t.worked)}</td><td></td></tr>`).join('')}</tbody>
    </table>`;
  } else {
    box.innerHTML = `<table>
      <thead><tr><th>الموظف</th><th>التاريخ</th><th>الوقت</th><th>الحركة</th><th></th></tr></thead>
      <tbody>${recs.slice().reverse().map(r => `<tr>
        <td>${esc(empLabel(r).name)}</td>
        <td>${DAYS[new Date(r.ts).getDay()]} <span class="num">${dayKey(r.ts)}</span></td>
        <td>${time12(r.ts)}</td>
        <td><span class="tag ${r.type}">${r.type === 'in' ? 'دخول' : 'خروج'}</span></td>
        <td><button class="del-rec" data-rec="${esc(r.id)}" title="حذف">✕</button></td>
      </tr>`).join('')}</tbody></table>`;
  }
}

$('records-table').addEventListener('click', async ev => {
  const id = ev.target.dataset.rec; if (!id) return;
  if (await confirmBox('حذف هذه الحركة؟')) { await DB.del('records', id); renderRecords(); }
});

function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) { return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

async function exportRecords() {
  const recs = await loadFilteredRecords();
  if (!recs.length) { alert('لا توجد سجلات للتصدير في هذه الفترة'); return; }
  let rows;
  if (S.recordsView === 'summary') {
    const { rows: days, totals } = buildSummary(recs);
    rows = [['الموظف', 'الرقم الوظيفي', 'اليوم', 'التاريخ', 'أول دخول', 'آخر خروج', 'ساعات العمل', 'ملاحظة']];
    days.forEach(r => rows.push([r.name, r.code, DAYS[new Date(r.ts).getDay()], r.day,
      r.firstIn ? time12(r.firstIn) : '', r.lastOut ? time12(r.lastOut) : '', fmtDuration(r.worked), r.missing ? 'حركة ناقصة' : '']));
    rows.push([]);
    rows.push(['الإجمالي', 'الرقم الوظيفي', 'أيام الحضور', '', '', '', 'مجموع الساعات', '']);
    totals.forEach(t => rows.push([t.name, t.code, t.days, '', '', '', fmtDuration(t.worked), '']));
  } else {
    rows = [['الموظف', 'الرقم الوظيفي', 'اليوم', 'التاريخ', 'الوقت', 'الحركة']];
    recs.forEach(r => { const l = empLabel(r); rows.push([l.name, l.code, DAYS[new Date(r.ts).getDay()], dayKey(r.ts), time12(r.ts), r.type === 'in' ? 'دخول' : 'خروج']); });
  }
  const name = `حضور_${$('f-from').value}_${$('f-to').value}.csv`;
  saveFile(name, 'text/csv', toCsv(rows));
}

function saveFile(name, mime, text) {
  if (window.AndroidBridge && AndroidBridge.saveFile) {
    const res = AndroidBridge.saveFile(name, mime, text);
    if (res) alert(res);
    return;
  }
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ===== الإعدادات =====
function fillSettings() {
  $('s-company').value = S.settings.company || '';
  $('s-threshold').value = String(S.settings.threshold);
  if (!$('s-threshold').value) $('s-threshold').value = '0.48';
  $('s-dup').value = S.settings.dup;
  $('s-pin').value = ''; $('s-pin2').value = '';
  fillSyncFields();
  updateSyncUI();
}
async function saveSettings() {
  S.settings.company = $('s-company').value.trim();
  S.settings.threshold = parseFloat($('s-threshold').value) || 0.48;
  S.settings.dup = Math.max(0, parseInt($('s-dup').value, 10) || 0);
  await DB.setSetting('company', S.settings.company);
  await DB.setSetting('threshold', S.settings.threshold);
  await DB.setSetting('dup', S.settings.dup);
  alert('تم الحفظ');
}
async function savePin() {
  const p = $('s-pin').value.trim(), p2 = $('s-pin2').value.trim();
  if (p.length < 4) { alert('الرمز يجب أن يكون ٤ أرقام على الأقل'); return; }
  if (p !== p2) { alert('الرمزان غير متطابقين'); return; }
  S.settings.pinHash = await hashPin(p);
  await DB.setSetting('pinHash', S.settings.pinHash);
  $('s-pin').value = ''; $('s-pin2').value = '';
  alert('تم تغيير الرمز');
}

async function exportBackup() {
  const data = {
    app: 'hudoor', version: 1, exportedAt: new Date().toISOString(),
    employees: await DB.all('employees'),
    records: await DB.all('records'),
    settings: await DB.all('settings'),
  };
  saveFile(`حضور_نسخة_احتياطية_${dayKey(Date.now())}.json`, 'application/json', JSON.stringify(data));
}
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { alert('الملف غير صالح'); return; }
  if (!data || data.app !== 'hudoor' || !Array.isArray(data.employees) || !Array.isArray(data.records)) { alert('هذا الملف ليس نسخة احتياطية من تطبيق حضور'); return; }
  if (!await confirmBox(`استعادة ${data.employees.length} موظف و ${data.records.length} حركة؟ سيتم استبدال كل البيانات الحالية.`)) return;
  await DB.clear('employees'); await DB.clear('records');
  await DB.putMany('employees', data.employees);
  await DB.putMany('records', data.records);
  if (Array.isArray(data.settings) && data.settings.length) await DB.putMany('settings', data.settings);
  await loadAll();
  alert('تمت الاستعادة بنجاح');
  openAdmin('employees');
}

// ===== الربط مع موقع OpenCart =====
const DEFAULT_SITE = 'https://www.matjarkom.com/';
const SYNC_BATCH = 200;
const SYNC_EVERY_MS = 60 * 1000;

function syncConfigured() { return !!(S.settings.syncUrl && S.settings.syncKey); }
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/index\.php.*$/i, '');
  return u.replace(/\/+$/, '') + '/';
}
function localStamp(ts) {
  const d = new Date(ts);
  return `${dayKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function siteHost(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return u; } }

async function apiCall(base, key, route, extra) {
  const url = base + 'index.php?route=extension/hudoor/api/' + route;
  const body = Object.assign({ key }, extra || {});
  let res, text;
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
  try {
    // text/plain يجعل الطلب "بسيطاً" فلا يحتاج الموقع إعدادات CORS إضافية
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    text = await res.text();
  } catch (e) {
    throw new Error(navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذّر الوصول إلى الموقع. تحقق من الرابط والإنترنت');
  } finally { if (timer) clearTimeout(timer); }
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!json) {
    if (res.status === 404 || /<html/i.test(text)) throw new Error('الإضافة غير مثبتة على الموقع، أو الموقع يحجب الطلب');
    throw new Error('رد غير متوقع من الموقع (' + res.status + ')');
  }
  if (!json.ok) throw new Error(json.message || json.error || ('خطأ ' + res.status));
  return json;
}

async function countPending() {
  const all = await DB.all('records');
  return all.filter(r => r.synced !== true).length;
}

let syncPromise = null;
function syncNow(manual) {
  if (!syncConfigured()) { updateSyncUI(); return Promise.resolve(false); }
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    S.sync.busy = true; updateSyncUI();
    let contacted = false;
    try {
      for (let round = 0; round < 50; round++) {
        const pending = (await DB.all('records')).filter(r => r.synced !== true).sort((a, b) => a.ts - b.ts);
        if (!pending.length && !S.sync.dirty && !manual) break;
        contacted = true;
        const batch = pending.slice(0, SYNC_BATCH);
        const res = await apiCall(S.settings.syncUrl, S.settings.syncKey, 'push', {
          device: S.settings.device || 'جهاز المكتب',
          employees: S.employees.map(e => ({ id: e.id, name: e.name, code: e.code || '' })),
          employees_full: true,
          records: batch.map(r => ({ id: r.id, empId: r.empId, empName: r.empName, empCode: r.empCode || '', type: r.type, ts: r.ts, local: localStamp(r.ts) }))
        });
        S.sync.dirty = false; manual = false;
        const saved = new Set(res.saved || []);
        const done = batch.filter(r => saved.has(r.id)).map(r => Object.assign({}, r, { synced: true }));
        if (done.length) await DB.putMany('records', done);
        if (done.length < batch.length) throw new Error('رفض الموقع بعض الحركات');
        if (pending.length <= SYNC_BATCH) break;
      }
      if (contacted) {
        S.settings.lastSync = Date.now();
        await DB.setSetting('lastSync', S.settings.lastSync);
        S.sync.error = '';
      }
      return true;
    } catch (e) {
      S.sync.error = e.message || String(e);
      return false;
    } finally {
      S.sync.busy = false; syncPromise = null;
      updateSyncUI();
    }
  })();
  return syncPromise;
}

async function updateSyncUI() {
  S.sync.pending = await countPending();
  const ks = $('kiosk-sync'), st = $('sync-status');
  if (!syncConfigured()) {
    ks.classList.add('hidden');
    st.className = 'sync-status'; st.textContent = 'غير مربوط بموقع. السجلات محفوظة على هذا الجهاز فقط.';
    return;
  }
  const host = siteHost(S.settings.syncUrl);
  const last = S.settings.lastSync ? `${dayKey(S.settings.lastSync) === dayKey(Date.now()) ? 'اليوم' : dayKey(S.settings.lastSync)} ${time12(S.settings.lastSync)}` : '—';
  let cls = 'ok', line;
  if (S.sync.busy) { line = 'جاري الإرسال…'; cls = 'warn'; }
  else if (S.sync.error) { line = 'خطأ: ' + S.sync.error; cls = 'err'; }
  else if (S.sync.pending) { line = `${S.sync.pending} حركة بانتظار الإرسال`; cls = 'warn'; }
  else line = 'كل الحركات وصلت ✓';
  st.className = 'sync-status ' + cls;
  st.innerHTML = `مربوط بـ <b dir="ltr">${esc(host)}</b><br>${esc(line)}<br><span class="small">آخر إرسال ناجح: ${esc(last)}</span>`;
  ks.classList.remove('hidden', 'pending', 'error');
  if (S.sync.error) { ks.classList.add('error'); ks.textContent = 'تعذّر الإرسال للموقع' + (S.sync.pending ? ` (${S.sync.pending} بالانتظار)` : ''); }
  else if (S.sync.pending) { ks.classList.add('pending'); ks.textContent = `${S.sync.pending} حركة بانتظار الإرسال`; }
  else ks.textContent = 'متصل بالموقع';
}

async function connectSite(url, key, device) {
  url = normalizeUrl(url); key = String(key || '').trim().toUpperCase();
  if (!url || !key) { alert('أدخل رابط الموقع ومفتاح الربط'); return false; }
  const st = $('sync-status'); st.className = 'sync-status warn'; st.textContent = 'جاري الاتصال بالموقع…';
  try {
    const res = await apiCall(url, key, 'ping');
    S.settings.syncUrl = url; S.settings.syncKey = key;
    S.settings.device = (device || '').trim() || S.settings.device || 'جهاز المكتب';
    await DB.setSetting('syncUrl', url); await DB.setSetting('syncKey', key); await DB.setSetting('device', S.settings.device);
    S.sync.error = ''; S.sync.dirty = true;
    fillSyncFields();
    const pending = await countPending();
    await syncNow(true);
    alert(`تم الربط بنجاح مع ${res.store || siteHost(url)} ✓` + (pending ? `\nتم إرسال ${pending} حركة سابقة إلى الموقع.` : ''));
    return true;
  } catch (e) {
    st.className = 'sync-status err'; st.textContent = 'فشل الربط: ' + e.message;
    return false;
  }
}

async function disconnectSite() {
  if (!await confirmBox('إلغاء الربط مع الموقع؟ ستبقى السجلات على هذا الجهاز ولن تُرسل حركات جديدة.')) return;
  S.settings.syncUrl = ''; S.settings.syncKey = ''; S.sync.error = '';
  await DB.setSetting('syncUrl', ''); await DB.setSetting('syncKey', '');
  fillSyncFields(); updateSyncUI();
}

function fillSyncFields() {
  $('sync-url').value = S.settings.syncUrl || DEFAULT_SITE;
  $('sync-key').value = S.settings.syncKey || '';
  $('sync-device').value = S.settings.device || '';
  $('sync-now').disabled = !syncConfigured();
  $('sync-off').disabled = !syncConfigured();
}

// ===== مسح رمز الربط (QR) =====
async function loadJsQR() {
  if (window.jsQR) return;
  try { await loadScript('lib/jsQR.js'); }
  catch (e) { await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'); }
}

async function openScanner() {
  $('scan-modal').classList.remove('hidden');
  $('scan-status').textContent = 'جاري تشغيل الكاميرا…';
  // أوقف كاميرا الحضور مؤقتاً وشغّل الكاميرا الخلفية إن وجدت
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  try {
    await loadJsQR();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const video = $('scan-video');
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    S.scan = { stream, timer: null };
    $('scan-status').textContent = 'وجّه الكاميرا إلى الرمز في لوحة تحكم الموقع';
    const tick = () => {
      if (!S.scan) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          const parts = code.data.split('|');
          if (parts[0] === 'HUDOOR' && parts.length >= 3) {
            closeScanner();
            connectSite(parts[1], parts[2], $('sync-device').value);
            return;
          }
          $('scan-status').textContent = 'هذا ليس رمز ربط تطبيق حضور';
        }
      }
      S.scan.timer = setTimeout(tick, 200);
    };
    tick();
  } catch (e) {
    console.error(e);
    $('scan-status').textContent = 'تعذّر تشغيل الماسح. استخدم الإدخال اليدوي.';
  }
}

function closeScanner() {
  if (S.scan) { clearTimeout(S.scan.timer); S.scan.stream.getTracks().forEach(t => t.stop()); S.scan = null; }
  $('scan-video').srcObject = null;
  $('scan-modal').classList.add('hidden');
}

// ===== نافذة التأكيد =====
function confirmBox(text) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    $('confirm-modal').classList.remove('hidden');
    const done = v => { $('confirm-modal').classList.add('hidden'); $('confirm-yes').onclick = $('confirm-no').onclick = null; resolve(v); };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

// ===== زر الرجوع في أندرويد =====
window.onAndroidBack = function () {
  if (!$('scan-modal').classList.contains('hidden')) { closeScanner(); return true; }
  if (!$('confirm-modal').classList.contains('hidden')) { $('confirm-no').click(); return true; }
  if (!$('pin-modal').classList.contains('hidden')) { $('pin-modal').classList.add('hidden'); return true; }
  const c = current();
  if (c === 'screen-enroll') { S.enroll = null; openAdmin('employees'); return true; }
  if (c === 'screen-admin') { show('screen-kiosk'); return true; }
  if (S.card) { closeCard(); return true; }
  return false;
};

// ===== ربط الأحداث =====
function bind() {
  $('setup-save').onclick = async () => {
    const p = $('setup-pin').value.trim(), p2 = $('setup-pin2').value.trim();
    if (p.length < 4) { $('setup-error').textContent = 'الرمز يجب أن يكون ٤ أرقام على الأقل'; return; }
    if (p !== p2) { $('setup-error').textContent = 'الرمزان غير متطابقين'; return; }
    S.settings.company = $('setup-company').value.trim();
    S.settings.pinHash = await hashPin(p);
    await DB.setSetting('company', S.settings.company);
    await DB.setSetting('pinHash', S.settings.pinHash);
    await DB.setSetting('threshold', S.settings.threshold);
    await DB.setSetting('dup', S.settings.dup);
    openAdmin('employees');
  };
  $('btn-admin').onclick = openPin;
  $('pin-ok').onclick = checkPin;
  $('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') checkPin(); });
  $('pin-cancel').onclick = () => $('pin-modal').classList.add('hidden');
  $('btn-in').onclick = () => punch('in');
  $('btn-out').onclick = () => punch('out');
  $('btn-not-me').onclick = () => { if (S.card) S.cooldown[S.card.emp.id] = Date.now() + 4000; closeCard(); setStatus('انظر إلى الكاميرا'); };
  $('btn-back-kiosk').onclick = () => show('screen-kiosk');
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => selectTab(t.dataset.tab));
  $('btn-add-emp').onclick = () => openEnroll(null);
  $('enroll-cancel').onclick = () => { S.enroll = null; openAdmin('employees'); };
  $('enroll-start').onclick = () => {
    if (!$('e-name').value.trim()) { $('enroll-error').textContent = 'اكتب اسم الموظف أولاً'; $('e-name').focus(); return; }
    runEnroll();
  };
  $('enroll-save').onclick = saveEnroll;
  $('e-name').addEventListener('input', updateEnrollSave);
  ['f-from', 'f-to', 'f-emp'].forEach(id => $(id).addEventListener('change', renderRecords));
  $('f-today').onclick = () => setRange('today');
  $('f-month').onclick = () => setRange('month');
  document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    S.recordsView = b.dataset.view; renderRecords();
  });
  $('btn-export').onclick = exportRecords;
  $('s-save').onclick = saveSettings;
  $('s-pin-save').onclick = savePin;
  $('b-export').onclick = exportBackup;
  $('b-import').onclick = () => { $('b-file').value = ''; $('b-file').click(); };
  $('b-file').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f); };
  $('b-clear').onclick = async () => {
    if (await confirmBox('حذف كل سجلات الدخول والخروج نهائياً؟ لا يمكن التراجع.')) { await DB.clear('records'); renderRecords(); alert('تم الحذف'); }
  };
  $('sync-scan').onclick = openScanner;
  $('scan-cancel').onclick = closeScanner;
  $('sync-test').onclick = () => connectSite($('sync-url').value, $('sync-key').value, $('sync-device').value);
  $('sync-now').onclick = async () => {
    const ok = await syncNow(true);
    alert(ok ? 'تم الإرسال إلى الموقع ✓' : 'تعذّر الإرسال: ' + S.sync.error);
  };
  $('sync-off').onclick = disconnectSite;
  setInterval(() => syncNow(), SYNC_EVERY_MS);
  window.addEventListener('online', () => syncNow());
  setInterval(() => { if (current() === 'screen-kiosk') tickClock(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; } }
    else if (current() === 'screen-kiosk') startKiosk();
    else if (current() === 'screen-enroll') attachCamera($('enroll-video')).catch(() => {});
  });
}

async function loadAll() {
  await reloadEmployees();
  S.settings.company = await DB.getSetting('company', '');
  S.settings.threshold = await DB.getSetting('threshold', 0.48);
  S.settings.dup = await DB.getSetting('dup', 5);
  S.settings.pinHash = await DB.getSetting('pinHash', null);
  S.settings.syncUrl = await DB.getSetting('syncUrl', '');
  S.settings.syncKey = await DB.getSetting('syncKey', '');
  S.settings.device = await DB.getSetting('device', '');
  S.settings.lastSync = await DB.getSetting('lastSync', 0);
}

async function init() {
  bind();
  DB.persist();
  const today = dayKey(Date.now());
  $('f-from').value = today; $('f-to').value = today;
  try {
    await loadAll();
    await loadFaceApi();
  } catch (e) {
    console.error(e);
    $('loading-text').innerHTML = 'تعذّر تحميل نظام التعرف على الوجه.<br>تأكد من اتصال الإنترنت في أول تشغيل ثم أعد فتح التطبيق.';
    document.querySelector('#screen-loading .spinner').style.display = 'none';
    return;
  }
  if (!S.settings.pinHash) show('screen-setup');
  else show('screen-kiosk');
  updateSyncUI();
  setTimeout(() => syncNow(), 3000);
}

window.__hudoor = { S, DB, buildSummary }; // للاختبار
init();
})();
