import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, get, set, update, remove, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { CATS } from './words.js';
import { STR } from './i18n.js';

// Public web config. Not a secret: access is enforced by database.rules.json.
const firebaseConfig = {
  apiKey: 'AIzaSyCyBRkSve7IdHXwBrljQDOyiVCCRnrKucM',
  authDomain: 'imposter-malik.firebaseapp.com',
  databaseURL: 'https://imposter-malik-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'imposter-malik',
  storageBucket: 'imposter-malik.firebasestorage.app',
  messagingSenderId: '358335009293',
  appId: '1:358335009293:web:439ba4c30a8efa69787b44'
};

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getDatabase(fb);

// ---------- word bank ----------
const BANK = {};
for (const [key, c] of Object.entries(CATS)) {
  BANK[key] = {
    tr: c.tr, ar: c.ar,
    list: c.words.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split('|').map(x => x.trim()))
  };
}
const CAT_KEYS = Object.keys(BANK);

// ---------- helpers ----------
const $app = document.getElementById('app');
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem('imp_' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('imp_' + k, JSON.stringify(v)); } catch { /* storage blocked */ } }
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rnd = n => Math.floor(Math.random() * n);
const pickOne = a => a[rnd(a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// RTDB may return arrays as objects (or drop empty ones)
const arr = v => Array.isArray(v) ? v.filter(x => x != null) : (v && typeof v === 'object' ? Object.values(v) : []);
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const vkey = g => `${g.round}_${g.vr || 0}`;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 6 }, () => CODE_CHARS[rnd(CODE_CHARS.length)]).join('');
let offset = 0;
const now = () => Date.now() + offset;

const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : ''));
const t = (k, vars) => fmt((STR[S.ui] && STR[S.ui][k]) ?? STR.tr[k] ?? k, vars);
const sep = () => (S.ui === 'ar' ? '، ' : ', ');
const tl = (lang, k, vars) => fmt((STR[lang] && STR[lang][k]) ?? STR.tr[k] ?? k, vars);

// ---------- state ----------
const S = {
  uid: null, booted: false, ui: ls.get('ui') === 'ar' ? 'ar' : 'tr',
  view: 'home', code: null, room: null, unsub: null,
  draft: null, editing: false, pick: null, cardOpen: false,
  local: { round: -1, idx: 0, shown: false }, lastKey: null,
  armed: null, toast: '', toastTimer: null, error: '',
  joinCode: '', joinName: ls.get('name') || '', pending: false, attempted: {}
};

// ---------- auth & boot ----------
onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
onAuthStateChanged(auth, u => { if (u) { S.uid = u.uid; boot(); } });
signInAnonymously(auth).catch(e => { S.error = t('error', { m: esc(e.code || e.message) }); render(); });

function boot() {
  if (S.booted) return;
  S.booted = true;
  const h = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z2-9]{6}$/.test(h)) openRoom(h); else render();
}

function fail(e) { flash(t('error', { m: esc(e && (e.code || e.message) || e) })); }
function flash(msg) {
  S.toast = msg; render();
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { S.toast = ''; render(); }, 2800);
}

// ---------- room data helpers ----------
const isHost = () => !!S.room && S.room.meta && S.room.meta.host === S.uid;
const isOnline = () => S.room && S.room.meta && S.room.meta.mode === 'online';
const playersOf = r => Object.entries(r.players || {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
function nameOf(p) {
  const r = S.room;
  if (!r || !p) return '?';
  if (r.players && r.players[p] && r.players[p].name) return r.players[p].name;
  for (const h of Object.values(r.history || {})) if (h && h.names && h.names[p]) return h.names[p];
  return '?';
}
function scoresOf(r) {
  const sc = {};
  for (const h of Object.values(r.history || {})) {
    if (!h) continue;
    const imps = arr(h.imps), roster = arr(h.roster);
    roster.forEach(p => { sc[p] = sc[p] || 0; });
    if (h.impWins) imps.forEach(p => { sc[p] = (sc[p] || 0) + 2; });
    else roster.filter(p => !imps.includes(p)).forEach(p => { sc[p] = (sc[p] || 0) + 1; });
  }
  Object.keys(r.players || {}).forEach(p => { sc[p] = sc[p] || 0; });
  return Object.entries(sc).sort((a, b) => b[1] - a[1]);
}
function addRecent(code, mode) {
  const list = (ls.get('recent') || []).filter(x => x.code !== code);
  list.unshift({ code, mode, at: Date.now() });
  ls.set('recent', list.slice(0, 8));
}

// ---------- room lifecycle ----------
function openRoom(code) {
  if (S.unsub) S.unsub();
  Object.assign(S, { code, room: null, view: 'room', pick: null, cardOpen: false, editing: false, armed: null });
  history.replaceState(null, '', '#' + code);
  S.unsub = onValue(ref(db, 'rooms/' + code), snap => {
    const r = snap.val();
    if (!r || !r.meta) { leaveRoom(); flash(t('notFound')); return; }
    S.room = r;
    addRecent(code, r.meta.mode);
    onRoomChange();
  }, e => { leaveRoom(); fail(e); });
  render();
}
function leaveRoom() {
  if (S.unsub) { S.unsub(); S.unsub = null; }
  Object.assign(S, { code: null, room: null, view: 'home', editing: false, armed: null });
  history.replaceState(null, '', location.pathname + location.search);
  render();
}
const isTyping = () => { const a = document.activeElement; return !!a && $app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };

function onRoomChange() {
  const g = (S.room && S.room.game) || {};
  if (g.round !== S.local.round) { S.local = { round: g.round, idx: 0, shown: false }; S.pick = null; S.cardOpen = false; }
  const k = vkey(g) + g.phase;
  if (k !== S.lastKey) { S.lastKey = k; S.pick = null; }
  autoChecks();
  if (isTyping()) { S.pending = true; return; }
  render();
}

// Runs on every room change and timer tick. Each action is guarded so it fires once.
function autoChecks() {
  const r = S.room, g = r && r.game;
  if (!g) return;
  const member = isOnline() ? !!(r.players && r.players[S.uid]) : isHost();
  if (!member) return;
  const once = key => { if (S.attempted[key]) return false; S.attempted[key] = true; return true; };
  const roster = arr(g.roster);
  if (isOnline() && g.phase === 'vote') {
    const key = vkey(g), v = r.votes || {};
    if (roster.length && roster.every(p => v[p] && v[p].key === key) && once('v' + key)) resolveVotes();
  }
  if (isOnline() && g.phase === 'judge') {
    const j = r.judges || {};
    const judges = roster.filter(p => p !== g.caught);
    if (judges.every(p => j[p] && j[p].round === g.round) && once('j' + g.round)) resolveJudge();
  }
  if (g.phase === 'guess' && g.guessEnd && now() >= g.guessEnd && once('g' + g.round)) toJudge();
  if (g.phase === 'result' && !(r.history && r.history['r' + g.round]) && once('h' + g.round)) writeHistory();
}

// Atomic state change on the shared game node. guard(cur) must hold, patch(cur) is merged in.
async function tx(guard, patch) {
  try {
    await runTransaction(ref(db, `rooms/${S.code}/game`), cur => {
      if (!cur || !guard(cur)) return; // abort
      return Object.assign({}, cur, patch(cur));
    });
  } catch (e) { fail(e); }
}

function caughtPatch(g, pid) {
  if (arr(g.imps).includes(pid)) return { caught: pid, phase: 'guess', guessEnd: now() + 60000 };
  return { caught: pid, phase: 'result', impWins: true };
}

function resolveVotes() {
  const g = S.room.game, key = vkey(g), v = S.room.votes || {};
  const counts = {};
  arr(g.roster).forEach(p => { const x = v[p]; if (x && x.key === key && x.target) counts[x.target] = (counts[x.target] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  const guard = cur => cur.phase === 'vote' && cur.round === g.round && (cur.vr || 0) === (g.vr || 0);
  if (max === 0 || top.length !== 1) return tx(guard, () => ({ phase: 'tie', tied: top }));
  return tx(guard, () => caughtPatch(g, top[0]));
}
function resolveJudge() {
  const g = S.room.game, j = S.room.judges || {};
  let yes = 0, no = 0;
  arr(g.roster).filter(p => p !== g.caught).forEach(p => {
    const x = j[p];
    if (x && x.round === g.round) { if (x.yes) yes++; else no++; }
  });
  // Majority decides; a tie counts as "did not guess"
  return tx(cur => cur.phase === 'judge' && cur.round === g.round, () => ({ phase: 'result', impWins: yes > no }));
}
function toJudge() {
  const g = S.room.game;
  return tx(cur => cur.phase === 'guess' && cur.round === g.round, () => ({ phase: 'judge' }));
}
async function writeHistory() {
  const r = S.room, g = r.game;
  const names = {};
  arr(g.roster).forEach(p => { names[p] = (r.players && r.players[p] && r.players[p].name) || '?'; });
  const entry = {
    round: g.round, cat: g.cat, word: g.word, lang: g.lang || 'tr',
    roster: arr(g.roster), imps: arr(g.imps), caught: g.caught || null,
    impWins: !!g.impWins, names, at: now()
  };
  try { await set(ref(db, `rooms/${S.code}/history/r${g.round}`), entry); }
  catch { /* another player already saved this round */ }
}

async function startRound() {
  const r = S.room, st = r.settings || {}, g = r.game || {};
  const roster = playersOf(r).map(p => p.id);
  if (roster.length < 3) return flash(t('needMin'));
  const k = (st.imps === 2 && roster.length >= 5) ? 2 : 1;
  let cats = arr(st.cats).filter(c => BANK[c]);
  if (!cats.length) cats = CAT_KEYS.slice();
  const used = r.used || {};
  let avail = [];
  cats.forEach(c => BANK[c].list.forEach((w, i) => { if (!(used[c] && used[c][i])) avail.push([c, i]); }));
  const updates = {};
  let reset = false;
  if (!avail.length) {
    reset = true;
    cats.forEach(c => { BANK[c].list.forEach((w, i) => avail.push([c, i])); updates['used/' + c] = null; });
  }
  const [cat, wi] = pickOne(avail);
  const lang = st.lang === 'ar' ? 'ar' : 'tr';
  const word = BANK[cat].list[wi][lang === 'ar' ? 1 : 0];
  const imps = shuffle(roster).slice(0, k);
  const crew = roster.filter(p => !imps.includes(p));
  // First speaker: an imposter only ~5% of the time (per imposter), and not the same person as last round
  const prevFirst = arr(g.order)[0];
  let first;
  if (Math.random() < 0.05 * k) first = pickOne(imps);
  else { let pool = crew.filter(p => p !== prevFirst); if (!pool.length) pool = crew; first = pickOne(pool); }
  const order = [first, ...shuffle(roster.filter(p => p !== first))];
  const pass = shuffle(roster);
  if (pass.length > 1 && pass[0] === arr(g.pass)[0]) pass.push(pass.shift());
  updates.game = {
    phase: r.meta.mode === 'local' ? 'cards' : 'play',
    round: (g.round || 0) + 1, cat, wi, word, lang, hint: st.hint !== false,
    roster, imps, order, pass, vr: 0, startedAt: now()
  };
  if (reset) updates['used/' + cat] = { [wi]: true };
  else updates[`used/${cat}/${wi}`] = true;
  try {
    await update(ref(db, 'rooms/' + S.code), updates);
    if (reset) flash(t('wordsReset'));
  } catch (e) { fail(e); }
}

// ---------- create / join / rules ----------
function newDraft(mode) {
  return {
    mode, lang: S.ui, cats: CAT_KEYS.slice(), hint: true, imps: 1, name: S.joinName || '',
    players: [1, 2, 3, 4].map(i => ({ id: 'p' + i, name: t('playerN', { n: i }) }))
  };
}
function draftFromRoom() {
  const r = S.room, st = r.settings || {};
  return {
    mode: r.meta.mode, lang: st.lang || 'tr', cats: arr(st.cats).length ? arr(st.cats) : CAT_KEYS.slice(),
    hint: st.hint !== false, imps: st.imps === 2 ? 2 : 1,
    players: playersOf(r).map(p => ({ id: p.id, name: p.name }))
  };
}
const settingsOf = d => ({ lang: d.lang, cats: d.cats, hint: d.hint, imps: d.imps });
function localPlayersMap(d) {
  const m = {};
  d.players.forEach((p, i) => { m[p.id] = { name: (p.name.trim() || t('playerN', { n: i + 1 })).slice(0, 20), joinedAt: i }; });
  return m;
}

async function createRoom() {
  const d = S.draft;
  const name = (d.name || '').trim().slice(0, 20);
  if (d.mode === 'online' && !name) return flash(t('needName'));
  try {
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) break;
      code = genCode();
    }
    let players;
    if (d.mode === 'online') {
      players = { [S.uid]: { name, joinedAt: now() } };
      S.joinName = name; ls.set('name', name);
    } else players = localPlayersMap(d);
    await set(ref(db, 'rooms/' + code), {
      meta: { host: S.uid, mode: d.mode, createdAt: now() },
      settings: settingsOf(d), players, game: { phase: 'lobby', round: 0 }
    });
    openRoom(code);
  } catch (e) { fail(e); }
}

async function joinRoom(rawCode, rawName) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = String(rawName || '').trim().slice(0, 20);
  if (!/^[A-Z2-9]{6}$/.test(code)) return flash(t('badCode'));
  try {
    const m = await get(ref(db, `rooms/${code}/meta`));
    if (!m.exists()) return flash(t('notFound'));
    const meta = m.val();
    if (meta.mode === 'online') {
      const me = await get(ref(db, `rooms/${code}/players/${S.uid}`));
      if (!me.exists()) {
        if (!name) return flash(t('needName'));
        await set(ref(db, `rooms/${code}/players/${S.uid}`), { name, joinedAt: now() });
      }
      if (name) { S.joinName = name; ls.set('name', name); }
    }
    if (S.code !== code) openRoom(code); else render();
  } catch (e) { fail(e); }
}

async function saveRules() {
  const d = S.draft;
  const updates = { settings: settingsOf(d) };
  if (S.room.meta.mode === 'local') updates.players = localPlayersMap(d);
  try { await update(ref(db, 'rooms/' + S.code), updates); S.editing = false; render(); }
  catch (e) { fail(e); }
}

async function shareLink() {
  const url = location.origin + location.pathname + '#' + S.code;
  if (navigator.share) {
    try { await navigator.share({ title: t('appName'), text: t('shareText', { code: S.code }), url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); flash(t('copied')); }
  catch { flash(esc(url)); }
}

// ---------- views ----------
function render() {
  document.documentElement.lang = S.ui;
  document.documentElement.dir = S.ui === 'ar' ? 'rtl' : 'ltr';
  document.title = S.code ? `${S.code} · ${t('appName')}` : t('appName');
  let h = header();
  if (!S.uid) h += `<p class="panel muted">${S.error || t('connecting')}</p>`;
  else if (S.view === 'create') h += viewCreate();
  else if (S.view === 'room') h += viewRoom();
  else h += viewHome();
  if (S.toast) h += `<div class="toast" role="status">${S.toast}</div>`;
  $app.innerHTML = h;
}

function header() {
  return `<header class="top">
    <button class="brand" data-act="home" aria-label="${esc(t('appName'))}">${esc(t('appName'))}</button>
    <button class="chip-btn" data-act="lang" lang="${S.ui === 'ar' ? 'tr' : 'ar'}">${S.ui === 'ar' ? 'Türkçe' : 'العربية'}</button>
  </header>`;
}

function viewHome() {
  const recent = ls.get('recent') || [];
  return `
  <section class="hero">
    <h1 class="display"><span class="strike">${esc(t('appName'))}</span></h1>
    <p class="lede">${esc(t('tagline'))}</p>
  </section>
  <div class="choices">
    <button class="choice" data-act="newOnline"><span class="choice-t">${esc(t('createOnline'))}</span><span class="choice-s">${esc(t('createOnlineSub'))}</span></button>
    <button class="choice" data-act="newLocal"><span class="choice-t">${esc(t('createLocal'))}</span><span class="choice-s">${esc(t('createLocalSub'))}</span></button>
  </div>
  <section class="panel stack">
    <h2 class="h2">${esc(t('join'))}</h2>
    <label class="field"><span class="label">${esc(t('code'))}</span>
      <input id="jcode" class="code-in" data-field="joinCode" data-enter="join" value="${esc(S.joinCode)}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" dir="ltr"></label>
    <label class="field"><span class="label">${esc(t('yourName'))}</span>
      <input id="jname" data-field="joinName" data-enter="join" value="${esc(S.joinName)}" maxlength="20" autocomplete="nickname"></label>
    <button class="btn" data-act="join">${esc(t('joinBtn'))}</button>
  </section>
  ${recent.length ? `<section class="stack">
    <span class="label">${esc(t('recent'))}</span>
    <div class="list">${recent.map(x => `<button class="row-btn" data-act="open" data-code="${esc(x.code)}"><span class="mono" dir="ltr">${esc(x.code)}</span><span class="muted">${esc(x.mode === 'local' ? t('local') : t('online'))}</span></button>`).join('')}</div>
  </section>` : ''}
  <p class="foot">${esc(t('footer'))}</p>`;
}

function rulesForm(d) {
  let h = '';
  if (d.mode === 'local') {
    h += `<div class="stack"><span class="label">${esc(t('players'))} · ${d.players.length}</span>` +
      d.players.map((p, i) => `<div class="player"><span class="n">${i + 1}</span>
        <input id="pl-${esc(p.id)}" data-pname="${i}" value="${esc(p.name)}" maxlength="20" aria-label="${esc(t('playerN', { n: i + 1 }))}">
        <button class="x" data-act="delP" data-i="${i}" ${d.players.length <= 3 ? 'disabled' : ''} aria-label="${esc(t('remove'))}">×</button></div>`).join('') +
      (d.players.length < 10 ? `<button class="btn ghost small self-start" data-act="addP">${esc(t('addPlayer'))}</button>` : '') + `</div>`;
  }
  h += `<div class="stack"><span class="label">${esc(t('wordLang'))}</span><div class="seg">${['tr', 'ar'].map(l =>
    `<button data-act="dlang" data-v="${l}" aria-pressed="${d.lang === l}">${esc(t(l === 'tr' ? 'langTr' : 'langAr'))}</button>`).join('')}</div></div>`;
  const all = d.cats.length === CAT_KEYS.length;
  h += `<div class="stack"><span class="label">${esc(t('cats'))}</span><div class="chips">
    <button class="chip" data-act="dall" aria-pressed="${all}">${esc(t('all'))}</button>
    ${CAT_KEYS.map(c => `<button class="chip" data-act="dcat" data-c="${c}" aria-pressed="${d.cats.includes(c)}">${esc(BANK[c][S.ui])} <span class="cnt">${BANK[c].list.length}</span></button>`).join('')}
  </div></div>`;
  h += `<button class="toggle" data-act="dhint" aria-pressed="${d.hint}"><span class="toggle-txt"><b>${esc(t('hint'))}</b><span class="sub">${esc(t('hintSub'))}</span></span><span class="sw" aria-hidden="true"></span></button>`;
  h += `<div class="stack"><span class="label">${esc(t('imps'))}</span><div class="seg">${[1, 2].map(n =>
    `<button data-act="dimps" data-v="${n}" aria-pressed="${d.imps === n}">${n}</button>`).join('')}</div><span class="note">${esc(t('impsNote'))}</span></div>`;
  return h;
}

function viewCreate() {
  const d = S.draft;
  return `<div class="row"><button class="btn ghost small" data-act="home">${S.ui === 'ar' ? '→' : '←'} ${esc(t('back'))}</button></div>
  <h2 class="title">${esc(d.mode === 'local' ? t('createLocal') : t('createOnline'))}</h2>
  <div class="stack-lg">
    ${d.mode === 'online' ? `<label class="field"><span class="label">${esc(t('yourName'))}</span><input id="cname" data-draft="name" value="${esc(d.name)}" maxlength="20" autocomplete="nickname"></label>` : ''}
    ${rulesForm(d)}
    <button class="btn" data-act="create">${esc(t('create'))}</button>
  </div>`;
}

function roomBar(r, g) {
  return `<div class="roombar">
    <div class="rb-code"><span class="label">${esc(t('roomCode'))}</span><span class="code" dir="ltr">${esc(S.code)}</span></div>
    <div class="rb-meta">
      <span class="badge">${esc(r.meta.mode === 'local' ? t('local') : t('online'))}</span>
      ${g.round ? `<span class="badge">${esc(t('round', { n: g.round }))}</span>` : ''}
      ${r.meta.mode === 'online' ? `<button class="btn ghost small" data-act="share">${esc(t('shareLink'))}</button>` : ''}
    </div>
  </div>`;
}

function rulesSummary(r) {
  const st = r.settings || {};
  const n = arr(st.cats).length || CAT_KEYS.length;
  return `<div class="badges">
    <span class="badge">${esc(t(st.lang === 'ar' ? 'langAr' : 'langTr'))}</span>
    <span class="badge">${esc(t('catsN', { n }))}</span>
    <span class="badge">${esc(t('impsN', { n: st.imps === 2 ? 2 : 1 }))}</span>
    <span class="badge">${esc(t(st.hint === false ? 'hintOff' : 'hintOn'))}</span>
  </div>`;
}

function viewRoom() {
  const r = S.room;
  if (!r) return `<p class="panel muted">${esc(t('connecting'))}</p>`;
  const g = r.game || { phase: 'lobby' };
  const online = r.meta.mode === 'online';
  const host = isHost();
  let h = roomBar(r, g);
  if (S.editing) {
    return h + `<section class="panel stack-lg"><h2 class="h2">${esc(t('editRules'))}</h2>${rulesForm(S.draft)}
      <div class="row"><button class="btn" data-act="saveRules">${esc(t('save'))}</button><button class="btn ghost" data-act="cancelEdit">${esc(t('cancel'))}</button></div></section>`;
  }
  if (!online && !host) return h + `<p class="panel">${esc(t('localOnly'))}</p>`;
  if (online && !(r.players && r.players[S.uid])) return h + viewJoinHere(r, g);
  const active = !['lobby', 'result'].includes(g.phase);
  if (online && active && !arr(g.roster).includes(S.uid)) {
    return h + `<p class="panel">${esc(t('watching'))}</p>` + scoreSection(r);
  }
  const views = online
    ? { lobby: vLobby, play: vPlay, vote: vVote, tie: vTie, guess: vGuess, judge: vJudge, result: vResult }
    : { lobby: vLobby, cards: vCards, discuss: vDiscuss, vote: vLocalVote, guess: vGuess, judge: vLocalJudge, result: vResult };
  h += (views[g.phase] || vLobby)(r, g, host);
  if (host && active) h += `<button class="btn ghost small danger self-start" data-act="cancelRound">${esc(S.armed === 'cancelRound' ? t('sure') : t('cancelRound'))}</button>`;
  return h;
}

function viewJoinHere(r, g) {
  const ps = playersOf(r);
  return `<section class="panel stack">
    <h2 class="h2">${esc(t('joinTitle'))}</h2>
    ${!['lobby', 'result'].includes(g.phase) ? `<p class="note">${esc(t('lateJoin'))}</p>` : ''}
    <label class="field"><span class="label">${esc(t('yourName'))}</span>
      <input id="hname" data-field="joinName" data-enter="joinHere" value="${esc(S.joinName)}" maxlength="20" autocomplete="nickname"></label>
    <button class="btn" data-act="joinHere">${esc(t('joinBtn'))}</button>
  </section>
  ${ps.length ? `<section class="stack"><span class="label">${esc(t('players'))} · ${ps.length}</span><ul class="plist">${ps.map(p => `<li><span>${esc(p.name)}</span></li>`).join('')}</ul></section>` : ''}`;
}

function vLobby(r, g, host) {
  const online = isOnline();
  const ps = playersOf(r);
  let h = `<section class="stack"><span class="label">${esc(t('players'))} · ${ps.length}</span>
    <ul class="plist">${ps.map(p => `<li><span class="pname">${esc(p.name)}
      ${online && p.id === r.meta.host ? `<span class="tag">${esc(t('hostTag'))}</span>` : ''}
      ${online && p.id === S.uid ? `<span class="tag">${esc(t('you'))}</span>` : ''}</span>
      ${host && online && p.id !== S.uid ? `<button class="btn ghost small" data-act="kick" data-p="${esc(p.id)}">${esc(t('kick'))}</button>` : ''}</li>`).join('')}</ul>
    ${online ? `<p class="muted">${esc(t('waitPlayers'))}</p>` : ''}
  </section>`;
  h += rulesSummary(r);
  if (host) {
    h += `<button class="btn" data-act="start" ${ps.length < 3 ? 'disabled' : ''}>${esc(t('startRound'))}</button>`;
    if (ps.length < 3) h += `<p class="note">${esc(t('needMin'))}</p>`;
    h += `<button class="btn ghost" data-act="edit">${esc(t('editRules'))}</button>`;
  } else {
    h += `<p class="panel muted">${esc(t('waitHost'))}</p>
      <button class="btn ghost small self-start" data-act="leave">${esc(S.armed === 'leave' ? t('sure') : t('leave'))}</button>`;
  }
  return h + scoreSection(r);
}

function cardBlock(g, isImp, open) {
  const L = g.lang === 'ar' ? 'ar' : 'tr';
  const attrs = `dir="${L === 'ar' ? 'rtl' : 'ltr'}" lang="${L}"`;
  const catName = (isImp && g.hint === false) ? '???' : ((BANK[g.cat] && BANK[g.cat][L]) || g.cat);
  if (!open) {
    return `<div class="card" ${attrs}>
      <div class="card-cat"><span class="label">${esc(tl(L, 'category'))}</span><span class="cat-name">• • •</span></div>
      <div class="bars" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="card-note">${esc(tl(L, 'secret'))}</p></div>`;
  }
  return `<div class="card open" ${attrs}>
    <div class="card-cat"><span class="label">${esc(tl(L, 'category'))}</span><span class="cat-name">${esc(catName)}</span></div>
    <div class="word ${sizeClass(isImp ? tl(L, 'impWord') : g.word)}">${esc(isImp ? tl(L, 'impWord') : g.word)}</div>
    <p class="card-note">${esc(tl(L, isImp ? 'impNote' : 'crewNote'))}</p></div>`;
}
// Shrink long words so they fit on one or two lines instead of breaking mid-word
function sizeClass(w) {
  const longest = Math.max(...String(w).split(/\s+/).map(x => x.length));
  return longest > 11 ? 'xlong' : longest > 8 ? 'long' : '';
}
function myCard(g) {
  const isImp = arr(g.imps).includes(S.uid);
  return `<section class="stack">${cardBlock(g, isImp, S.cardOpen)}
    <button class="btn ghost" data-act="toggleCard">${esc(S.cardOpen ? t('hideCard') : t('showCard'))}</button></section>`;
}
function orderBlock(g) {
  const o = arr(g.order);
  return `<section class="stack"><span class="label">${esc(t('order'))}</span>
    <ol class="order">${o.map((p, i) => `<li class="${i === 0 ? 'first' : ''}"><span>${esc(nameOf(p))}</span>${i === 0 ? `<span class="tag">${esc(t('starts'))}</span>` : ''}</li>`).join('')}</ol>
    <p class="muted">${esc(t('orderHint'))}</p></section>`;
}

function vPlay(r, g) {
  return `<p class="muted">${esc(t('cardHint'))}</p>` + myCard(g) + orderBlock(g) +
    `<button class="btn" data-act="toVote">${esc(t('toVote'))}</button>`;
}

function vVote(r, g, host) {
  const key = vkey(g), votes = r.votes || {}, mine = votes[S.uid];
  const done = mine && mine.key === key;
  const roster = arr(g.roster);
  let h = `<section class="stack"><h2 class="h2">${esc(t('whoImp'))}</h2>${g.vr ? `<span class="badge self-start">${esc(t('revoteN', { n: g.vr + 1 }))}</span>` : ''}`;
  if (done) h += `<div class="verdict">${t('voted', { name: esc(nameOf(mine.target)) })}</div>`;
  else {
    h += `<p class="muted">${esc(t('pickOne'))}</p><div class="stack">${roster.filter(p => p !== S.uid).map(p =>
      `<button class="vote" data-act="pick" data-p="${esc(p)}" aria-pressed="${S.pick === p}"><span>${esc(nameOf(p))}</span><span class="tick" aria-hidden="true">${S.pick === p ? '✓' : ''}</span></button>`).join('')}</div>
      <button class="btn" data-act="confirmVote" ${S.pick ? '' : 'disabled'}>${esc(t('confirm'))}</button>`;
  }
  const waiting = roster.filter(p => !(votes[p] && votes[p].key === key));
  h += `<p class="muted">${waiting.length ? t('waitingFor', { names: waiting.map(p => esc(nameOf(p))).join(sep()) }) : esc(t('allIn'))}</p></section>`;
  if (host && waiting.length) h += `<button class="btn ghost small self-start" data-act="countNow">${esc(t('countNow'))}</button>`;
  return h + myCard(g);
}

function vTie(r, g) {
  const tied = arr(g.tied);
  return `<section class="verdict imp stack"><h2 class="h2">${esc(t('tie'))}</h2>
    <p>${t('tieText', { names: tied.map(p => esc(nameOf(p))).join(sep()) })}</p></section>
    <button class="btn" data-act="revote">${esc(t('revote'))}</button>` + orderBlock(g) + myCard(g);
}

function vGuess(r, g, host) {
  const left = Math.max(0, Math.ceil(((g.guessEnd || 0) - now()) / 1000));
  return `<section class="stack center">
    <span class="label">${esc(t('caughtLabel'))}</span>
    <h2 class="h2">${esc(t('caughtTitle', { name: nameOf(g.caught) }))}</h2>
    <div class="timer ${left <= 10 ? 'low' : ''}" id="cd" dir="ltr">${mmss(left)}</div>
    <p class="muted">${esc(t('guessText'))}</p></section>
    ${host ? `<button class="btn ghost small self-start" data-act="endGuess">${esc(t('endEarly'))}</button>` : ''}`;
}

function vJudge(r, g, host) {
  const j = r.judges || {};
  const judges = arr(g.roster).filter(p => p !== g.caught);
  const amJudge = judges.includes(S.uid);
  const answered = j[S.uid] && j[S.uid].round === g.round;
  let h = `<section class="stack"><h2 class="h2">${esc(t('judgeQ', { name: nameOf(g.caught) }))}</h2>`;
  if (amJudge && !answered) h += `<div class="row two"><button class="btn" data-act="judge" data-v="1">${esc(t('yes'))}</button><button class="btn ghost" data-act="judge" data-v="0">${esc(t('no'))}</button></div>`;
  else h += `<div class="verdict">${esc(amJudge ? t('answered') : t('othersDeciding'))}</div>`;
  const waiting = judges.filter(p => !(j[p] && j[p].round === g.round));
  if (waiting.length) h += `<p class="muted">${t('waitingFor', { names: waiting.map(p => esc(nameOf(p))).join(sep()) })}</p>`;
  h += `</section>`;
  if (host && waiting.length) h += `<button class="btn ghost small self-start" data-act="forceJudge">${esc(t('forceJudge'))}</button>`;
  return h;
}

function vResult(r, g, host) {
  const imps = arr(g.imps), impWin = !!g.impWins, caught = g.caught;
  let msg;
  if (!caught || !imps.includes(caught)) msg = t('resWrong', { name: esc(nameOf(caught)) });
  else msg = esc(impWin ? t('resGuessed') : t('resFailed'));
  const L = g.lang === 'ar' ? 'ar' : 'tr';
  let h = `<section class="verdict ${impWin ? 'imp' : 'crew'} stack">
      <span class="label">${esc(t('resultLabel'))}</span>
      <h2 class="h2">${esc(impWin ? t('impWin') : t('crewWin'))}</h2>
      <p>${msg}</p><p class="pts">${esc(impWin ? t('ptsImp') : t('ptsCrew'))}</p></section>
    <section class="facts">
      <div><span class="label">${esc(t('theWord'))}</span><b class="fact" lang="${L}">${esc(g.word)}</b><span class="muted">${esc((BANK[g.cat] && BANK[g.cat][L]) || '')}</span></div>
      <div><span class="label">${esc(imps.length > 1 ? t('impsWere') : t('impWas'))}</span><b class="fact">${imps.map(p => esc(nameOf(p))).join(sep())}</b></div>
    </section>`;
  if (isOnline()) {
    const key = vkey(g), votes = r.votes || {};
    h += `<section class="stack"><span class="label">${esc(t('votesTitle'))}</span><ul class="plist small">${arr(g.roster).map(p => {
      const v = votes[p];
      const target = v && v.key === key ? esc(nameOf(v.target)) : `<span class="muted">${esc(t('noVote'))}</span>`;
      return `<li><span>${esc(nameOf(p))}</span><span class="arrow">${S.ui === 'ar' ? '←' : '→'} ${target}</span></li>`;
    }).join('')}</ul></section>`;
  }
  if (host) h += `<button class="btn" data-act="start">${esc(t('newRound'))}</button><button class="btn ghost" data-act="edit">${esc(t('editRules'))}</button>`;
  else h += `<p class="panel muted">${esc(t('waitHost'))}</p>`;
  return h + scoreSection(r);
}

function scoreSection(r) {
  const hist = Object.values(r.history || {}).filter(Boolean).sort((a, b) => b.round - a.round);
  if (!hist.length) return '';
  const sc = scoresOf(r);
  return `<section class="stack">
    <span class="label">${esc(t('scores'))}</span>
    <div class="scores">${sc.map(([p, n], i) => `<div class="score ${i === 0 && n > 0 ? 'lead' : ''}"><span>${esc(nameOf(p))}</span><b>${n}</b></div>`).join('')}</div>
    <details class="hist"><summary>${esc(t('history'))} · ${hist.length}</summary>
      <ol class="hlist">${hist.map(x => `<li><span class="mono">#${x.round}</span>
        <b lang="${x.lang === 'ar' ? 'ar' : 'tr'}">${esc(x.word)}</b>
        <span class="muted">${esc(arr(x.imps).map(p => (x.names && x.names[p]) || nameOf(p)).join(sep()))}</span>
        <span class="pill ${x.impWins ? 'p-imp' : 'p-crew'}">${esc(x.impWins ? t('impWinShort') : t('crewWinShort'))}</span></li>`).join('')}</ol>
    </details>
    ${isHost() ? `<button class="btn ghost small danger self-start" data-act="reset">${esc(S.armed === 'reset' ? t('sure') : t('resetScores'))}</button>` : ''}
  </section>`;
}

// ----- single-phone views -----
function vCards(r, g) {
  const order = arr(g.pass);
  const i = Math.min(S.local.idx, order.length - 1);
  const pid = order[i], name = nameOf(pid), isImp = arr(g.imps).includes(pid);
  let h = `<div class="progress">${order.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>`;
  if (!S.local.shown) {
    h += `<section class="stack"><span class="label">${esc(t('pass'))}</span><div class="hand">${esc(name)}</div>
      <p class="muted">${esc(t('onlyLook', { name }))}</p></section>` + cardBlock(g, isImp, false) +
      `<button class="btn" data-act="lshow">${esc(t('openCard', { name }))}</button>`;
  } else {
    h += cardBlock(g, isImp, true) +
      `<button class="btn" data-act="lhide">${esc(i === order.length - 1 ? t('hideDone') : t('hideNext'))}</button>`;
  }
  if (i > 0 || S.local.shown) h += `<button class="btn ghost small self-start" data-act="lback">${S.ui === 'ar' ? '→' : '←'} ${esc(t('back'))}</button>`;
  return h;
}
function vDiscuss(r, g) {
  return (g.tieNote ? `<div class="verdict imp">${esc(t('tieNote'))}</div>` : '') + orderBlock(g) +
    `<button class="btn" data-act="toVote">${esc(t('toVote'))}</button>
     <button class="btn ghost small self-start" data-act="backCards">${S.ui === 'ar' ? '→' : '←'} ${esc(t('back'))}</button>`;
}
function vLocalVote(r, g) {
  return `<section class="stack"><h2 class="h2">${esc(t('whoImp'))}</h2><p class="muted">${esc(t('localVoteHint'))}</p>
    <div class="stack">${arr(g.roster).map(p => `<button class="vote" data-act="pick" data-p="${esc(p)}" aria-pressed="${S.pick === p}"><span>${esc(nameOf(p))}</span><span class="tick" aria-hidden="true">${S.pick === p ? '✓' : ''}</span></button>`).join('')}</div>
    <button class="btn" data-act="lconfirm" ${S.pick ? '' : 'disabled'}>${esc(t('confirmPick'))}</button>
    <button class="btn ghost" data-act="ltie">${esc(t('tieBtn'))}</button></section>
    <button class="btn ghost small self-start" data-act="backDiscuss">${S.ui === 'ar' ? '→' : '←'} ${esc(t('back'))}</button>`;
}
function vLocalJudge(r, g) {
  return `<section class="stack"><h2 class="h2">${esc(t('judgeQ', { name: nameOf(g.caught) }))}</h2>
    <div class="row two"><button class="btn" data-act="ljudge" data-v="1">${esc(t('yes'))}</button><button class="btn ghost" data-act="ljudge" data-v="0">${esc(t('no'))}</button></div></section>`;
}

// ---------- events ----------
$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  act(b.dataset.act, b.dataset);
});
$app.addEventListener('input', e => {
  const el = e.target, ds = el.dataset;
  if (ds.field) {
    let v = el.value;
    if (ds.field === 'joinCode') { v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); if (el.value !== v) el.value = v; }
    S[ds.field] = v;
  } else if (ds.draft && S.draft) S.draft[ds.draft] = el.value;
  else if (ds.pname != null && S.draft) S.draft.players[+ds.pname].name = el.value;
});
$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.enter) { e.preventDefault(); act(e.target.dataset.enter, {}); }
});
$app.addEventListener('focusout', () => {
  setTimeout(() => { if (S.pending && !isTyping()) { S.pending = false; render(); } }, 0);
});

async function act(a, ds) {
  const r = S.room, g = (r && r.game) || {};
  const armable = ['reset', 'cancelRound', 'leave'];
  if (armable.includes(a) && S.armed !== a) { S.armed = a; render(); return; }
  const wasArmed = S.armed; S.armed = null;
  const d = S.draft;
  switch (a) {
    case 'home': if (S.view === 'room') leaveRoom(); else { S.view = 'home'; render(); } break;
    case 'lang': S.ui = S.ui === 'ar' ? 'tr' : 'ar'; ls.set('ui', S.ui); render(); break;
    case 'newOnline': case 'newLocal':
      S.draft = newDraft(a === 'newLocal' ? 'local' : 'online'); S.view = 'create'; render(); break;
    case 'join': joinRoom(S.joinCode, S.joinName); break;
    case 'joinHere': joinRoom(S.code, S.joinName); break;
    case 'open': openRoom(ds.code); break;
    case 'addP': if (d.players.length < 10) { d.players.push({ id: 'p' + Date.now().toString(36) + rnd(1000), name: t('playerN', { n: d.players.length + 1 }) }); render(); } break;
    case 'delP': if (d.players.length > 3) { d.players.splice(+ds.i, 1); render(); } break;
    case 'dlang': d.lang = ds.v; render(); break;
    case 'dall': d.cats = CAT_KEYS.slice(); render(); break;
    case 'dcat': {
      const i = d.cats.indexOf(ds.c);
      if (i >= 0) { if (d.cats.length > 1) d.cats.splice(i, 1); } else d.cats.push(ds.c);
      render(); break;
    }
    case 'dhint': d.hint = !d.hint; render(); break;
    case 'dimps': d.imps = +ds.v; render(); break;
    case 'create': createRoom(); break;
    case 'share': shareLink(); break;
    case 'kick': remove(ref(db, `rooms/${S.code}/players/${ds.p}`)).catch(fail); break;
    case 'leave':
      try { await remove(ref(db, `rooms/${S.code}/players/${S.uid}`)); } catch (e) { fail(e); }
      leaveRoom(); break;
    case 'start': startRound(); break;
    case 'edit': S.draft = draftFromRoom(); S.editing = true; render(); break;
    case 'cancelEdit': S.editing = false; render(); break;
    case 'saveRules': saveRules(); break;
    case 'toggleCard': S.cardOpen = !S.cardOpen; render(); break;
    case 'toVote':
      tx(cur => cur.round === g.round && (cur.phase === 'play' || cur.phase === 'discuss'), () => ({ phase: 'vote', tieNote: null })); break;
    case 'pick': S.pick = ds.p; render(); break;
    case 'confirmVote':
      if (!S.pick) break;
      set(ref(db, `rooms/${S.code}/votes/${S.uid}`), { key: vkey(g), target: S.pick }).catch(fail); break;
    case 'countNow': resolveVotes(); break;
    case 'revote':
      tx(cur => cur.phase === 'tie' && cur.round === g.round, cur => ({ phase: 'vote', vr: (cur.vr || 0) + 1, tied: null })); break;
    case 'endGuess': toJudge(); break;
    case 'judge':
      set(ref(db, `rooms/${S.code}/judges/${S.uid}`), { round: g.round, yes: ds.v === '1' }).catch(fail); break;
    case 'forceJudge': resolveJudge(); break;
    case 'reset':
      update(ref(db, 'rooms/' + S.code), { history: null, 'game/phase': 'lobby' }).catch(fail); break;
    case 'cancelRound':
      tx(() => true, () => ({ phase: 'lobby' })); break;
    // single-phone flow
    case 'lshow': S.local.shown = true; render(); break;
    case 'lhide': {
      S.local.shown = false;
      const last = arr(g.pass).length - 1;
      if (S.local.idx < last) { S.local.idx++; render(); }
      else tx(cur => cur.phase === 'cards' && cur.round === g.round, () => ({ phase: 'discuss' }));
      break;
    }
    case 'lback':
      if (S.local.shown) S.local.shown = false; else if (S.local.idx > 0) S.local.idx--;
      render(); break;
    case 'backCards':
      S.local.idx = arr(g.pass).length - 1; S.local.shown = false;
      tx(cur => cur.phase === 'discuss' && cur.round === g.round, () => ({ phase: 'cards' })); break;
    case 'backDiscuss':
      tx(cur => cur.phase === 'vote' && cur.round === g.round, () => ({ phase: 'discuss' })); break;
    case 'lconfirm': {
      const pid = S.pick;
      if (!pid) break;
      tx(cur => cur.phase === 'vote' && cur.round === g.round, () => caughtPatch(g, pid)); break;
    }
    case 'ltie':
      tx(cur => cur.phase === 'vote' && cur.round === g.round, () => ({ phase: 'discuss', tieNote: true })); break;
    case 'ljudge':
      tx(cur => cur.phase === 'judge' && cur.round === g.round, () => ({ phase: 'result', impWins: ds.v === '1' })); break;
    default: if (wasArmed) render();
  }
}

// Countdown for the 1-minute guess
setInterval(() => {
  const g = S.room && S.room.game;
  if (S.view !== 'room' || !g || g.phase !== 'guess') return;
  const left = Math.max(0, Math.ceil(((g.guessEnd || 0) - now()) / 1000));
  const el = document.getElementById('cd');
  if (el) { el.textContent = mmss(left); el.classList.toggle('low', left <= 10); }
  if (left <= 0) autoChecks();
}, 250);

render();
