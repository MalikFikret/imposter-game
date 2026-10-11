import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, get, set, update, remove, runTransaction, onDisconnect, query, orderByChild, limitToLast } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { CATS } from './words.js?v=1.0.2';
import { STR, LANGS } from './i18n.js?v=1.0.2';

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

const APP_VERSION = '1.0.2';
const REPO_URL = 'https://github.com/MalikFikret/imposter-game';
const guideUrl = () => `guide/${['tr', 'ar', 'en'].includes(S.ui) ? S.ui : 'en'}.html`;

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getDatabase(fb);

/*
 Data model (Realtime Database)
 rooms/{code}
   meta     {host: uid, hostSlot, mode: online|local, pinSet, createdAt}
   settings {lang, cats[], hint, imps}
   players/{slot} {name, uid, joinedAt, status: in|left|kicked, online, nameReq}
   members/{uid} = slot          (which seat a device sits in; used by the rules)
   game     {phase, round, cat, wi, word, lang, hint, roster[], imps[], order[], pass[], out[], vr, ...}
   votes/{slot}, judges/{slot}, history/r{n}, used/{cat}/{index}
 publicRooms/{code} {hostName, lang, players, phase, updatedAt}   listing of rooms marked public
 secrets/{code}  {hostPin, pins/{slot}}   never readable by anyone (except the admin)
 claims/{code}/{uid} {slot, pin, hostPin} write-only proof used to take over a seat or the host role
*/

// ---------- word bank ----------
const BANK = {};
for (const [key, c] of Object.entries(CATS)) {
  BANK[key] = {
    names: Object.fromEntries(LANGS.map(l => [l.code, (c.names && c.names[l.code]) || c.names.tr])),
    lists: Object.fromEntries(LANGS.map(l => [l.code, String((c.words && c.words[l.code]) || '').split(';').map(x => x.trim()).filter(Boolean)]))
  };
}
const CAT_KEYS = Object.keys(BANK);
// ---------- languages ----------
const LANG = Object.fromEntries(LANGS.map((l, i) => [l.code, { ...l, idx: i }]));
const normLang = c => (LANG[c] ? c : 'tr');
const isRTL = c => LANG[normLang(c)].dir === 'rtl';
const langName = c => LANG[normLang(c)].name;
const catName = (c, lang) => (BANK[c] ? BANK[c].names[normLang(lang)] : c);
// Each language has its own independent list per category
const listOf = (c, lang) => (BANK[c] ? (BANK[c].lists[normLang(lang)].length ? BANK[c].lists[normLang(lang)] : BANK[c].lists.tr) : []);
const wordOf = (c, i, lang) => listOf(c, lang)[i] || '?';
// Used-word bookkeeping is per category AND language (Turkish keeps the original key)
const usedKey = (c, lang) => (normLang(lang) === 'tr' ? c : `${c}_${normLang(lang)}`);
function detectLang() {
  const saved = ls.get('ui');
  if (LANG[saved]) return saved;
  const nav = (navigator.language || 'tr').slice(0, 2).toLowerCase();
  return LANG[nav] ? nav : 'tr';
}

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
const genSlot = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isPin = (v, n) => new RegExp(`^[0-9]{${n}}$`).test(String(v || ''));
const ACTIVE = ['play', 'cards', 'discuss', 'vote', 'tie', 'guess', 'judge'];
let offset = 0;
const now = () => Date.now() + offset;

const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : ''));
const t = (k, vars) => fmt((STR[S.ui] && STR[S.ui][k]) ?? STR.tr[k] ?? k, vars);
const sep = () => LANG[S.ui].sep;
const tl = (lang, k, vars) => fmt((STR[lang] && STR[lang][k]) ?? STR.tr[k] ?? k, vars);
const backArrow = () => (isRTL(S.ui) ? '→' : '←');

// ---------- state ----------
const S = {
  uid: null, booted: false, ui: 'tr', langOpen: false,
  view: 'home', code: null, room: null, unsub: null, tab: 'game',
  draft: null, editing: false, pick: null, cardOpen: false,
  local: { round: -1, idx: 0, shown: false }, lastKey: null,
  armed: null, toast: '', toastTimer: null, error: '',
  joinCode: '', form: { name: ls.get('name') || '', pin: '', hostPin: '', mode: 'new', slot: '', newName: '' },
  pub: [], pubUnsub: null, lastPublic: null,
  nameEdit: false, pending: false, attempted: {}, presence: null, connected: false, busy: false
};

S.ui = detectLang();

// ---------- auth & boot ----------
onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
onValue(ref(db, '.info/connected'), s => { S.connected = !!s.val(); if (S.connected) { S.presence = null; armPresence(); } });
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
  S.toastTimer = setTimeout(() => { S.toast = ''; render(); }, 3000);
}
const P = path => ref(db, `rooms/${S.code}/${path}`);

// ---------- room data helpers ----------
const isHost = () => !!S.room && S.room.meta && S.room.meta.host === S.uid;
const isOnline = () => !!S.room && S.room.meta && S.room.meta.mode === 'online';
const playersOf = r => Object.entries(r.players || {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
function mySlot() {
  const r = S.room;
  if (!r || !isOnline() || !r.members) return null;
  const s = r.members[S.uid];
  return s && r.players && r.players[s] && r.players[s].uid === S.uid ? s : null;
}
const meP = () => { const s = mySlot(); return s ? S.room.players[s] : null; };
// A player counts as "here" when they have not left and their device is connected
function isHere(r, slot) {
  const p = r.players && r.players[slot];
  if (!p) return false;
  if (r.meta.mode === 'local') return true;
  return (p.status || 'in') === 'in' && p.online === true;
}
const activeRoster = g => arr(g.roster).filter(p => !arr(g.out).includes(p));
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
    const imps = arr(h.imps), roster = arr(h.roster), out = arr(h.out);
    roster.forEach(p => { sc[p] = sc[p] || 0; });
    if (h.impWins) imps.forEach(p => { sc[p] = (sc[p] || 0) + 2; });
    else roster.filter(p => !imps.includes(p) && !out.includes(p)).forEach(p => { sc[p] = (sc[p] || 0) + 1; });
  }
  Object.keys(r.players || {}).forEach(p => { sc[p] = sc[p] || 0; });
  return Object.entries(sc).sort((a, b) => b[1] - a[1]);
}
const roomName = r => ((r && r.settings && r.settings.name) || '').trim();
function addRecent(code, mode, name) {
  const list = (ls.get('recent') || []).filter(x => x.code !== code);
  list.unshift({ code, mode, name: name || '', at: Date.now() });
  ls.set('recent', list.slice(0, 8));
}
function forgetRecent(code) { ls.set('recent', (ls.get('recent') || []).filter(x => x.code !== code)); }

// ---------- presence ----------
// Marks my seat online while this room is open; Firebase flips it to false if the connection drops.
function armPresence() {
  const slot = mySlot(), me = meP();
  if (!S.code || !slot || !S.connected || !me || (me.status || 'in') !== 'in') return;
  const key = S.code + '/' + slot;
  if (S.presence === key && me.online === true) return;
  S.presence = key;
  const r = P(`players/${slot}/online`);
  onDisconnect(r).set(false).then(() => set(r, true)).catch(() => { S.presence = null; });
}
function dropPresence() {
  if (!S.presence) return;
  const [code, slot] = S.presence.split('/');
  const r = ref(db, `rooms/${code}/players/${slot}/online`);
  onDisconnect(r).cancel().catch(() => {});
  set(r, false).catch(() => {});
  S.presence = null;
}

// ---------- public room list ----------
const PUBLIC_MAX_AGE = 12 * 3600 * 1000;
function startPublicList() {
  if (S.pubUnsub || !S.uid) return;
  S.pubUnsub = onValue(query(ref(db, 'publicRooms'), orderByChild('updatedAt'), limitToLast(30)), snap => {
    const v = snap.val() || {};
    S.pub = Object.entries(v).map(([code, x]) => ({ code, ...x }))
      .filter(x => now() - (x.updatedAt || 0) < PUBLIC_MAX_AGE)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (S.view === 'home' && !isTyping()) render();
  }, () => { S.pub = []; });
}
function stopPublicList() { if (S.pubUnsub) { S.pubUnsub(); S.pubUnsub = null; } }
// The host's device keeps the public listing entry current
function syncPublic() {
  const r = S.room;
  if (!r || !isHost() || !isOnline() || !(r.settings && r.settings.public)) return;
  const ps = playersOf(r);
  const g = r.game || {};
  const hostP = r.meta.hostSlot && r.players && r.players[r.meta.hostSlot];
  const entry = {
    name: roomName(r), hostName: (hostP && hostP.name) || '?', lang: (r.settings && r.settings.lang) || 'tr',
    players: ps.filter(p => isHere(r, p.id)).length, phase: ACTIVE.includes(g.phase) ? 'playing' : 'lobby'
  };
  const key = JSON.stringify(entry);
  if (key === S.lastPublic) return;
  S.lastPublic = key;
  set(ref(db, 'publicRooms/' + S.code), { ...entry, updatedAt: now() }).catch(() => { S.lastPublic = null; });
}

// ---------- room lifecycle ----------
function openRoom(code) {
  if (S.unsub) S.unsub();
  dropPresence();
  Object.assign(S, { code, room: null, view: 'room', tab: 'game', pick: null, cardOpen: false, editing: false, armed: null, nameEdit: false });
  S.form.mode = 'new'; S.form.pin = ''; S.form.hostPin = ''; S.lastPublic = null;
  stopPublicList();
  history.replaceState(null, '', '#' + code);
  S.unsub = onValue(ref(db, 'rooms/' + code), snap => {
    const r = snap.val();
    if (!r || !r.meta) {
      const wasHere = !!S.room;
      forgetRecent(code); leaveRoom(); flash(t(wasHere ? 'roomDeleted' : 'notFound')); return;
    }
    S.room = r;
    addRecent(code, r.meta.mode, roomName(r));
    onRoomChange();
  }, e => { leaveRoom(); fail(e); });
  render();
}
function leaveRoom() {
  dropPresence();
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
  armPresence();
  syncPublic();
  autoChecks();
  if (isTyping()) { S.pending = true; return; }
  render();
}

// Runs on every room change and timer tick. Each action is guarded so it fires once.
function autoChecks() {
  const r = S.room, g = r && r.game;
  if (!g) return;
  const member = isOnline() ? !!mySlot() : isHost();
  if (!member) return;
  const once = key => { if (S.attempted[key]) return false; S.attempted[key] = true; return true; };
  const act = activeRoster(g);
  const outKey = arr(g.out).length;
  if (isOnline() && g.phase === 'vote') {
    const key = vkey(g), v = r.votes || {};
    if (act.length && act.every(p => v[p] && v[p].key === key) && once(`v${key}_${outKey}`)) resolveVotes();
  }
  if (isOnline() && g.phase === 'judge') {
    const j = r.judges || {};
    const judges = act.filter(p => p !== g.caught);
    if (judges.every(p => j[p] && j[p].round === g.round) && once(`j${g.round}_${outKey}`)) resolveJudge();
  }
  if (g.phase === 'guess' && g.guessEnd && now() >= g.guessEnd && once('g' + g.round)) toJudge();
  if (g.phase === 'result' && !(r.history && r.history['r' + g.round]) && once('h' + g.round)) writeHistory();
}

// Atomic state change on the shared game node. guard(cur) must hold, patch(cur) is merged in.
async function tx(guard, patch) {
  try {
    await runTransaction(P('game'), cur => {
      if (!cur || !guard(cur)) return; // abort
      return Object.assign({}, cur, patch(cur));
    });
  } catch (e) { fail(e); }
}

function caughtPatch(g, slot) {
  if (arr(g.imps).includes(slot)) return { caught: slot, phase: 'guess', guessEnd: now() + 60000 };
  return { caught: slot, phase: 'result', impWins: true };
}
function resolveVotes() {
  const g = S.room.game, key = vkey(g), v = S.room.votes || {};
  const act = activeRoster(g);
  const counts = {};
  act.forEach(p => { const x = v[p]; if (x && x.key === key && x.target && act.includes(x.target)) counts[x.target] = (counts[x.target] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  const guard = cur => cur.phase === 'vote' && cur.round === g.round && (cur.vr || 0) === (g.vr || 0);
  if (max === 0 || top.length !== 1) return tx(guard, () => ({ phase: 'tie', tied: top }));
  return tx(guard, () => caughtPatch(g, top[0]));
}
function resolveJudge() {
  const g = S.room.game, j = S.room.judges || {};
  let yes = 0, no = 0;
  activeRoster(g).filter(p => p !== g.caught).forEach(p => {
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
// Host confirmed that an absent player is out of this round
function continueWithout(slot) {
  const g = S.room.game;
  return tx(cur => ACTIVE.includes(cur.phase) && cur.round === g.round, cur => {
    const out = [...new Set([...arr(cur.out), slot])];
    if (arr(cur.imps).includes(slot)) return { out, phase: 'result', impWins: false, caught: null, impLeft: slot };
    if (arr(cur.roster).filter(p => !out.includes(p)).length < 3) return { out, phase: 'lobby' };
    const patch = { out };
    if (cur.phase === 'tie') { patch.phase = 'vote'; patch.vr = (cur.vr || 0) + 1; patch.tied = null; }
    return patch;
  });
}
async function writeHistory() {
  const r = S.room, g = r.game;
  const names = {};
  arr(g.roster).forEach(p => { names[p] = nameOf(p); });
  const entry = {
    round: g.round, cat: g.cat, word: g.word, lang: g.lang || 'tr',
    roster: arr(g.roster), imps: arr(g.imps), out: arr(g.out), caught: g.caught || null,
    impWins: !!g.impWins, names, at: now()
  };
  try { await set(P(`history/r${g.round}`), entry); }
  catch { /* another player already saved this round */ }
}

async function startRound() {
  const r = S.room, st = r.settings || {}, g = r.game || {};
  const roster = playersOf(r).filter(p => isHere(r, p.id)).map(p => p.id);
  if (roster.length < 3) return flash(t('needMin'));
  const k = (st.imps === 2 && roster.length >= 5) ? 2 : 1;
  const lang = normLang(st.lang);
  let cats = arr(st.cats).filter(c => BANK[c]);
  if (!cats.length) cats = CAT_KEYS.slice();
  const used = r.used || {};
  const avail = [];
  cats.forEach(c => { const u = used[usedKey(c, lang)]; listOf(c, lang).forEach((w, i) => { if (!(u && u[i])) avail.push([c, i]); }); });
  const updates = {};
  let reset = false;
  if (!avail.length) {
    reset = true;
    cats.forEach(c => { listOf(c, lang).forEach((w, i) => avail.push([c, i])); updates['used/' + usedKey(c, lang)] = null; });
  }
  const [cat, wi] = pickOne(avail);
  const word = wordOf(cat, wi, lang);
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
  if (reset) updates['used/' + usedKey(cat, lang)] = { [wi]: true };
  else updates[`used/${usedKey(cat, lang)}/${wi}`] = true;
  try {
    await update(ref(db, 'rooms/' + S.code), updates);
    S.tab = 'game';
    if (reset) flash(t('wordsReset'));
  } catch (e) { fail(e); }
}

// ---------- create / join / rules ----------
function newDraft(mode) {
  return {
    mode, lang: S.ui, cats: CAT_KEYS.slice(), hint: true, imps: 1, public: false, roomName: '', name: S.form.name || '', pin: '', hostPin: '',
    players: [1, 2, 3, 4].map(i => ({ id: 'p' + i, name: t('playerN', { n: i }) }))
  };
}
function draftFromRoom() {
  const r = S.room, st = r.settings || {};
  return {
    mode: r.meta.mode, lang: st.lang || 'tr', cats: arr(st.cats).length ? arr(st.cats) : CAT_KEYS.slice(),
    hint: st.hint !== false, imps: st.imps === 2 ? 2 : 1, public: !!st.public, roomName: st.name || '',
    players: playersOf(r).map(p => ({ id: p.id, name: p.name }))
  };
}
const settingsOf = d => ({ name: (d.roomName || '').trim().slice(0, 30) || null, lang: d.lang, cats: d.cats, hint: d.hint, imps: d.imps, public: d.mode === 'online' && !!d.public });
function localPlayersMap(d) {
  const m = {};
  d.players.forEach((p, i) => { m[p.id] = { name: (p.name.trim() || t('playerN', { n: i + 1 })).slice(0, 20), joinedAt: i }; });
  return m;
}

async function guarded(fn) {
  if (S.busy) return;
  S.busy = true; render();
  try { await fn(); } catch (e) { fail(e); } finally { S.busy = false; render(); }
}

function createRoom() {
  const d = S.draft;
  const name = (d.name || '').trim().slice(0, 20);
  if (d.mode === 'online' && !name) return flash(t('needName'));
  if (d.mode === 'online' && !isPin(d.pin, 4)) return flash(t('badMyPin'));
  if (!isPin(d.hostPin, 6)) return flash(t('badHostPin'));
  return guarded(async () => {
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) break;
      code = genCode();
    }
    const room = { settings: settingsOf(d), game: { phase: 'lobby', round: 0 } };
    let slot = null;
    if (d.mode === 'online') {
      slot = genSlot();
      room.meta = { host: S.uid, hostSlot: slot, mode: 'online', pinSet: true, createdAt: now() };
      room.players = { [slot]: { name, uid: S.uid, joinedAt: now(), status: 'in', online: true } };
      room.members = { [S.uid]: slot };
      S.form.name = name; ls.set('name', name);
    } else {
      room.meta = { host: S.uid, mode: 'local', pinSet: true, createdAt: now() };
      room.players = localPlayersMap(d);
    }
    await set(ref(db, 'rooms/' + code), room);
    await set(ref(db, `secrets/${code}/hostPin`), d.hostPin);
    if (slot) await set(ref(db, `secrets/${code}/pins/${slot}`), d.pin);
    openRoom(code);
    if (S.code === code) stopPublicList();
  });
}

function joinNew() {
  const f = S.form, r = S.room;
  const name = f.name.trim().slice(0, 20);
  if (!name) return flash(t('needName'));
  if (!isPin(f.pin, 4)) return flash(t('badMyPin'));
  const taken = playersOf(r).some(p => (p.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  if (taken) return flash(t('nameTaken'));
  return guarded(async () => {
    const slot = genSlot();
    await set(P(`players/${slot}`), { name, uid: S.uid, joinedAt: now(), status: 'in', online: true });
    await set(P(`members/${S.uid}`), slot);
    await set(ref(db, `secrets/${S.code}/pins/${slot}`), f.pin);
    S.form.name = name; ls.set('name', name); S.form.pin = '';
  });
}

// Take over an existing seat from another device by proving its PIN (and optionally the host PIN)
function joinReturning() {
  const f = S.form;
  if (!f.slot) return flash(t('pickPlayer'));
  if (!isPin(f.pin, 4)) return flash(t('badMyPin'));
  return guarded(async () => {
    const claimRef = ref(db, `claims/${S.code}/${S.uid}`);
    await set(claimRef, { slot: f.slot, pin: f.pin });
    try { await set(P(`players/${f.slot}/uid`), S.uid); }
    catch { await remove(claimRef).catch(() => {}); flash(t('wrongPin')); return; }
    await set(P(`members/${S.uid}`), f.slot);
    await update(P(`players/${f.slot}`), { status: 'in', online: true });
    await remove(claimRef).catch(() => {});
    S.form.pin = '';
  });
}

// Host role only (single-phone rooms)
function claimHost() {
  const f = S.form;
  if (!isPin(f.hostPin, 6)) return flash(t('badHostPin'));
  return guarded(async () => {
    const claimRef = ref(db, `claims/${S.code}/${S.uid}`);
    await set(claimRef, { hostPin: f.hostPin });
    try { await set(P('meta/host'), S.uid); }
    catch { await remove(claimRef).catch(() => {}); flash(t('wrongPin')); return; }
    const slot = S.room.meta.mode === 'online' && S.room.meta.hostSlot;
    if (slot && S.room.players && S.room.players[slot]) {
      await set(P(`players/${slot}/uid`), S.uid);
      await set(P(`members/${S.uid}`), slot);
      await update(P(`players/${slot}`), { status: 'in', online: true });
    }
    await remove(claimRef).catch(() => {});
    S.form.hostPin = '';
  });
}

async function saveRules() {
  const d = S.draft;
  const updates = { settings: settingsOf(d) };
  if (S.room.meta.mode === 'local') updates.players = localPlayersMap(d);
  try {
    await update(ref(db, 'rooms/' + S.code), updates);
    if (S.room.meta.mode === 'online' && !d.public) await remove(ref(db, 'publicRooms/' + S.code));
    S.lastPublic = null; S.editing = false; render();
  } catch (e) { fail(e); }
}

async function transferHost(slot) {
  const p = S.room.players[slot];
  if (!p || !p.uid) return;
  try {
    await remove(ref(db, `secrets/${S.code}/hostPin`));
    await update(P('meta'), { host: p.uid, hostSlot: slot, pinSet: false });
    flash(t('transferred'));
  } catch (e) { fail(e); }
}

function saveNewHostPin() {
  if (!isPin(S.form.hostPin, 6)) return flash(t('badHostPin'));
  return guarded(async () => {
    await set(ref(db, `secrets/${S.code}/hostPin`), S.form.hostPin);
    await update(P('meta'), { pinSet: true });
    S.form.hostPin = '';
    flash(t('pinSaved'));
  });
}

async function leaveSeat() {
  const slot = mySlot();
  if (!slot) return leaveRoom();
  if (isHost()) return flash(t('hostMustTransfer'));
  dropPresence();
  try { await update(P(`players/${slot}`), { status: 'left', online: false }); } catch (e) { fail(e); }
  leaveRoom();
}

// Host deletes the whole room: room data, PIN secrets and the public listing
async function deleteRoom() {
  const code = S.code, online = isOnline();
  const paths = { [`rooms/${code}`]: null, [`secrets/${code}`]: null };
  if (online) paths[`publicRooms/${code}`] = null;
  try {
    dropPresence();
    if (S.unsub) { S.unsub(); S.unsub = null; }
    await update(ref(db), paths);
    forgetRecent(code);
    leaveRoom();
    flash(t('roomDeleted'));
  } catch (e) { fail(e); openRoom(code); }
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
  document.documentElement.dir = isRTL(S.ui) ? 'rtl' : 'ltr';
  document.title = S.code ? `${roomName(S.room) || S.code} · ${t('appName')}` : t('appName');
  let h;
  if (!S.uid) h = header() + `<p class="panel muted">${S.error || t('connecting')}</p>`;
  else if (S.view === 'create') h = header() + viewCreate();
  else if (S.view === 'about') h = header() + viewAbout();
  else if (S.view === 'room') h = viewRoom();
  else { h = header() + viewHome(); startPublicList(); }
  if (S.toast) h += `<div class="toast" role="status">${S.toast}</div>`;
  $app.innerHTML = h;
}

// Compact language picker: shows the current language code, opens a small menu
const langBtn = () => `<div class="lang-menu">
  <button class="lang-btn" data-act="langMenu" aria-expanded="${S.langOpen}" aria-label="Language">${esc(LANG[S.ui].short)}<span aria-hidden="true">▾</span></button>
  ${S.langOpen ? `<div class="lang-pop" role="menu">${LANGS.map(l => `<button role="menuitemradio" aria-checked="${l.code === S.ui}" data-act="setLang" data-v="${l.code}"><span lang="${l.code}">${esc(l.name)}</span><span class="mono">${l.short}</span></button>`).join('')}</div>` : ''}
</div>`;
function header() {
  return `<header class="top"><button class="brand" data-act="home" aria-label="${esc(t('appName'))}">${logo(t('appName'))}</button>${langBtn()}</header>`;
}

function pinInput(id, field, n, label, help) {
  return `<label class="field"><span class="label">${esc(label)}</span>
    <input id="${id}" class="pin-in" ${field} type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${n}" autocomplete="off" dir="ltr">
    ${help ? `<span class="note">${esc(help)}</span>` : ''}</label>`;
}

function viewHome() {
  const recent = ls.get('recent') || [];
  return `
  <section class="hero">
    <h1 class="display" aria-label="${esc(t('appName'))}">${logo(t('appName'))}</h1>
    <p class="lede">${esc(t('tagline'))}</p>
  </section>
  <div class="choices">
    <button class="choice" data-act="newOnline"><span class="choice-t">${esc(t('createOnline'))}</span><span class="choice-s">${esc(t('createOnlineSub'))}</span></button>
    <button class="choice" data-act="newLocal"><span class="choice-t">${esc(t('createLocal'))}</span><span class="choice-s">${esc(t('createLocalSub'))}</span></button>
  </div>
  <section class="panel stack">
    <h2 class="h2">${esc(t('join'))}</h2>
    <div class="row nowrap">
      <input id="jcode" class="code-in" data-field="joinCode" data-enter="go" value="${esc(S.joinCode)}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" dir="ltr" aria-label="${esc(t('code'))}">
      <button class="btn auto" data-act="go">${esc(t('goRoom'))}</button>
    </div>
  </section>
  ${S.pub.length ? `<section class="stack">
    <span class="label">${esc(t('publicRooms'))}</span>
    <div class="list">${S.pub.map(x => `<button class="row-btn pub" data-act="open" data-code="${esc(x.code)}">
      <span class="pub-main"><b>${esc(x.name || x.hostName || '?')}</b>${x.name ? `<span class="muted">${esc(x.hostName || '')}</span>` : ''}<span class="muted mono" dir="ltr">${esc(x.code)}</span></span>
      <span class="pub-meta"><span class="badge">${esc(langName(x.lang))}</span><span class="badge">${esc(t('playersN', { n: x.players || 0 }))}</span><span class="badge ${x.phase === 'playing' ? 'b-live' : ''}">${esc(x.phase === 'playing' ? t('phasePlaying') : t('phaseLobby'))}</span></span>
    </button>`).join('')}</div>
  </section>` : ''}
  ${recent.length ? `<section class="stack">
    <span class="label">${esc(t('recent'))}</span>
    <div class="list">${recent.map(x => `<button class="row-btn" data-act="open" data-code="${esc(x.code)}"><span class="pub-main">${x.name ? `<b>${esc(x.name)}</b>` : ''}<span class="mono ${x.name ? 'muted' : ''}" dir="ltr">${esc(x.code)}</span></span><span class="muted">${esc(x.mode === 'local' ? t('local') : t('online'))}</span></button>`).join('')}</div>
  </section>` : ''}
  <footer class="foot">
    <nav class="foot-links"><a href="${guideUrl()}">${esc(t('howToPlay'))}</a><button data-act="about">${esc(t('about'))}</button></nav>
    <p>${esc(t('rightsLine'))}</p>
  </footer>`;
}

// Logo: one random letter of the name is "the imposter" (picked once per page load).
// Arabic letters connect to each other, so there the letter only changes colour and
// zero-width joiners keep the connected shapes intact around the coloured span.
const AR_NO_LEFT_JOIN = new Set([...'اأإآدذرزوؤةىء']);
const isArabicLetter = ch => /[\u0621-\u064A]/.test(ch);
const logoPick = {};
function logo(text) {
  const chars = Array.from(text);
  const idxs = chars.map((c, i) => (/\s/.test(c) ? -1 : i)).filter(i => i >= 0);
  if (!idxs.length) return esc(text);
  if (logoPick[text] == null) logoPick[text] = idxs[rnd(idxs.length)];
  const i = logoPick[text], ch = chars[i];
  const before = chars.slice(0, i).join(''), after = chars.slice(i + 1).join('');
  if (!isArabicLetter(ch)) return `${esc(before)}<span class="imp-letter">${esc(ch)}</span>${esc(after)}`;
  const prev = chars[i - 1], next = chars[i + 1];
  const joinPrev = prev && isArabicLetter(prev) && !AR_NO_LEFT_JOIN.has(prev) && ch !== 'ء';
  const joinNext = next && isArabicLetter(next) && next !== 'ء' && !AR_NO_LEFT_JOIN.has(ch);
  const Z = '\u200D';
  return `${esc(before)}${joinPrev ? Z : ''}<span class="imp-letter ar">${joinPrev ? Z : ''}${esc(ch)}${joinNext ? Z : ''}</span>${joinNext ? Z : ''}${esc(after)}`;
}

function viewAbout() {
  return `<div class="row"><button class="btn ghost small" data-act="home">${backArrow()} ${esc(t('back'))}</button></div>
  <section class="hero">
    <h1 class="title" aria-label="${esc(t('appName'))}">${logo(t('appName'))}</h1>
    <p class="lede">${esc(t('aboutLead'))}</p>
  </section>
  <dl class="kv about-kv">
    <dt>${esc(t('version'))}</dt><dd dir="ltr">${APP_VERSION}</dd>
    <dt>${esc(t('developer'))}</dt><dd><b>Malik Fikret</b></dd>
    <dt>${esc(t('languages'))}</dt><dd>${LANGS.map(l => `<span lang="${l.code}">${esc(l.name)}</span>`).join(sep())}</dd>
  </dl>
  <div class="row two"><a class="btn" href="${guideUrl()}">${esc(t('howToPlay'))}</a><a class="btn ghost" href="${REPO_URL}" target="_blank" rel="noopener">${esc(t('sourceCode'))}</a></div>
  <section class="stack"><h2 class="h2">${esc(t('privacyTitle'))}</h2><p class="muted">${esc(t('privacyText'))}</p></section>
  <section class="panel stack rights"><b>${esc(t('rightsLine'))}</b><p class="muted">${esc(t('rightsText'))}</p></section>`;
}

function rulesForm(d) {
  let h = `<label class="field"><span class="label">${esc(t('roomNameLabel'))}</span>
    <input id="rname" data-draft="roomName" value="${esc(d.roomName || '')}" maxlength="30" placeholder="${esc(t('roomNamePh'))}" autocomplete="off">
    <span class="note">${esc(t('roomNameHelp'))}</span></label>`;
  if (d.mode === 'local') {
    h += `<div class="stack"><span class="label">${esc(t('players'))} · ${d.players.length}</span>` +
      d.players.map((p, i) => `<div class="player"><span class="n">${i + 1}</span>
        <input id="pl-${esc(p.id)}" data-pname="${i}" value="${esc(p.name)}" maxlength="20" aria-label="${esc(t('playerN', { n: i + 1 }))}">
        <button class="x" data-act="delP" data-i="${i}" ${d.players.length <= 3 ? 'disabled' : ''} aria-label="${esc(t('remove'))}">×</button></div>`).join('') +
      (d.players.length < 10 ? `<button class="btn ghost small self-start" data-act="addP">${esc(t('addPlayer'))}</button>` : '') + `</div>`;
  }
  if (d.mode === 'online') {
    h += `<button class="toggle" data-act="dpublic" aria-pressed="${!!d.public}"><span class="toggle-txt"><b>${esc(t('publicRoom'))}</b><span class="sub">${esc(t('publicRoomSub'))}</span></span><span class="sw" aria-hidden="true"></span></button>`;
  }
  h += `<div class="stack"><span class="label">${esc(t('wordLang'))}</span><div class="lang-opts">${LANGS.map(l =>
    `<button data-act="dlang" data-v="${l.code}" aria-pressed="${normLang(d.lang) === l.code}"><span class="lo-name" lang="${l.code}">${esc(l.name)}</span><span class="lo-ex" lang="${l.code}">${esc(wordOf('animals', 0, l.code))} · ${esc(wordOf('food', 0, l.code))}</span></button>`).join('')}</div></div>`;
  const all = d.cats.length === CAT_KEYS.length;
  h += `<div class="stack"><span class="label">${esc(t('cats'))}</span><div class="chips">
    <button class="chip" data-act="dall" aria-pressed="${all}">${esc(t('all'))}</button>
    ${CAT_KEYS.map(c => `<button class="chip" data-act="dcat" data-c="${c}" aria-pressed="${d.cats.includes(c)}">${esc(catName(c, S.ui))} <span class="cnt">${listOf(c, d.lang).length}</span></button>`).join('')}
  </div></div>`;
  h += `<button class="toggle" data-act="dhint" aria-pressed="${d.hint}"><span class="toggle-txt"><b>${esc(t('hint'))}</b><span class="sub">${esc(t('hintSub'))}</span></span><span class="sw" aria-hidden="true"></span></button>`;
  h += `<div class="stack"><span class="label">${esc(t('imps'))}</span><div class="seg">${[1, 2].map(n =>
    `<button data-act="dimps" data-v="${n}" aria-pressed="${d.imps === n}">${n}</button>`).join('')}</div><span class="note">${esc(t('impsNote'))}</span></div>`;
  return h;
}

function viewCreate() {
  const d = S.draft;
  return `<div class="row"><button class="btn ghost small" data-act="home">${backArrow()} ${esc(t('back'))}</button></div>
  <h2 class="title">${esc(d.mode === 'local' ? t('createLocal') : t('createOnline'))}</h2>
  <div class="stack-lg">
    ${d.mode === 'online' ? `<label class="field"><span class="label">${esc(t('yourName'))}</span><input id="cname" data-draft="name" value="${esc(d.name)}" maxlength="20" autocomplete="nickname"></label>
      ${pinInput('cpin', 'data-draft="pin"', 4, t('myPin'), t('myPinHelp'))}` : ''}
    ${pinInput('chpin', 'data-draft="hostPin"', 6, t('hostPin'), t('hostPinHelp'))}
    ${rulesForm(d)}
    <button class="btn" data-act="create" ${S.busy ? 'disabled' : ''}>${esc(t('create'))}</button>
  </div>`;
}

// ----- room shell: compact header + tabs -----
function viewRoom() {
  const r = S.room;
  const top = `<header class="room-top">
      <button class="btn ghost small" data-act="home">${backArrow()} ${esc(t('mainMenu'))}</button>
      <button class="code-chip" data-act="share" dir="ltr" aria-label="${esc(t('shareLink'))}">${esc(S.code)}</button>
      ${langBtn()}
    </header>`;
  if (!r) return top + `<p class="panel muted">${esc(t('connecting'))}</p>`;
  const g = r.game || { phase: 'lobby' };
  const online = r.meta.mode === 'online';
  const host = isHost();
  const rn = roomName(r);
  const sub = (rn ? `<h1 class="room-name">${esc(rn)}</h1>` : '') + `<p class="room-sub">${esc(online ? t('online') : t('local'))}${g.round ? ' · ' + esc(t('round', { n: g.round })) : ''}${host ? ' · ' + esc(t('hostTag')) : ''}</p>`;

  // Not seated yet: join / claim screens
  if (!online && !host) return top + sub + viewLocalClaim();
  if (online && !mySlot()) return top + sub + viewJoin(r, g);
  const me = meP();
  if (online && me && me.status && me.status !== 'in') {
    return top + sub + `<section class="panel stack"><p>${esc(me.status === 'kicked' ? t('youKicked') : t('youLeft'))}</p>
      <button class="btn" data-act="comeBack">${esc(t('comeBack'))}</button></section>`;
  }

  const ps = playersOf(r);
  const hereCount = ps.filter(p => isHere(r, p.id)).length;
  const reqs = host && online ? ps.filter(p => p.nameReq).length : 0;
  const tabs = `<nav class="tabs" role="tablist">
    ${[['game', t('tabGame')], ['players', `${t('tabPlayers')} <span class="cnt">${online ? hereCount + '/' : ''}${ps.length}</span>${reqs ? '<span class="dot-badge"></span>' : ''}`], ['scores', t('tabScores')]]
      .map(([k, label]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${S.tab === k}">${k === 'players' ? label : esc(label)}</button>`).join('')}
  </nav>`;

  let body;
  if (S.editing) {
    body = `<section class="stack-lg"><h2 class="h2">${esc(t('editRules'))}</h2>${rulesForm(S.draft)}
      <div class="row two"><button class="btn" data-act="saveRules">${esc(t('save'))}</button><button class="btn ghost" data-act="cancelEdit">${esc(t('cancel'))}</button></div></section>`;
  } else if (S.tab === 'players') body = viewPlayers(r, g, host);
  else if (S.tab === 'scores') body = viewScores(r, host);
  else body = viewGame(r, g, host);
  return top + sub + tabs + `<main class="stack-lg">${body}</main>`;
}

function viewLocalClaim() {
  return `<section class="panel stack"><p>${esc(t('localClaim'))}</p>
    ${pinInput('lhpin', 'data-form="hostPin"', 6, t('hostPin'))}
    <button class="btn" data-act="claimHost" ${S.busy ? 'disabled' : ''}>${esc(t('claimHost'))}</button></section>`;
}

function viewJoin(r, g) {
  const f = S.form, ps = playersOf(r);
  let h = `<div class="seg seg3">
    <button data-act="jmode" data-v="new" aria-pressed="${f.mode === 'new'}">${esc(t('newPlayer'))}</button>
    <button data-act="jmode" data-v="back" aria-pressed="${f.mode === 'back'}">${esc(t('returning'))}</button>
    <button data-act="jmode" data-v="host" aria-pressed="${f.mode === 'host'}">${esc(t('iAmHost'))}</button></div>`;
  if (ACTIVE.includes(g.phase) && f.mode === 'new') h += `<p class="note">${esc(t('lateJoin'))}</p>`;
  if (f.mode === 'new') {
    h += `<section class="stack">
      <label class="field"><span class="label">${esc(t('yourName'))}</span><input id="jname" data-form="name" data-enter="joinNew" value="${esc(f.name)}" maxlength="20" autocomplete="nickname"></label>
      ${pinInput('jpin', 'data-form="pin" data-enter="joinNew"', 4, t('myPin'), t('myPinHelp'))}
      <button class="btn" data-act="joinNew" ${S.busy ? 'disabled' : ''}>${esc(t('joinBtn'))}</button></section>`;
  } else if (f.mode === 'back') {
    h += `<section class="stack"><span class="label">${esc(t('whoAreYou'))}</span>
      <div class="stack">${ps.map(p => `<button class="vote" data-act="jslot" data-p="${esc(p.id)}" aria-pressed="${f.slot === p.id}"><span>${esc(p.name)}</span><span class="tick" aria-hidden="true">${f.slot === p.id ? '✓' : ''}</span></button>`).join('')}</div>
      ${pinInput('rpin', 'data-form="pin" data-enter="joinBack"', 4, t('myPin'))}
      <button class="btn" data-act="joinBack" ${S.busy ? 'disabled' : ''}>${esc(t('joinBtn'))}</button></section>`;
  } else {
    h += `<section class="stack"><p class="muted">${esc(t('hostReturnText'))}</p>
      ${pinInput('hpin', 'data-form="hostPin" data-enter="claimHost"', 6, t('hostPin'))}
      <button class="btn" data-act="claimHost" ${S.busy ? 'disabled' : ''}>${esc(t('claimHost'))}</button></section>`;
  }
  return h;
}

// ----- Players tab -----
function statusLabel(r, p) {
  if (r.meta.mode === 'local') return '';
  const st = p.status || 'in';
  if (st === 'kicked') return `<span class="st st-out">${esc(t('statusKicked'))}</span>`;
  if (st === 'left') return `<span class="st st-out">${esc(t('statusLeft'))}</span>`;
  if (p.online !== true) return `<span class="st">${esc(t('statusOffline'))}</span>`;
  return '';
}
function viewPlayers(r, g, host) {
  const online = isOnline(), ps = playersOf(r), mine = mySlot();
  let h = '';
  if (host && online) {
    const reqs = ps.filter(p => p.nameReq);
    if (reqs.length) {
      h += `<section class="panel stack"><span class="label">${esc(t('nameReqs'))}</span>${reqs.map(p => `<div class="req">
        <span><span class="muted">${esc(p.name)}</span> ${backArrow() === '←' ? '→' : '←'} <b>${esc(p.nameReq)}</b></span>
        <span class="row"><button class="btn small" data-act="approveName" data-p="${esc(p.id)}">${esc(t('approve'))}</button>
        <button class="btn ghost small" data-act="rejectName" data-p="${esc(p.id)}">${esc(t('reject'))}</button></span></div>`).join('')}</section>`;
    }
  }
  h += `<ul class="plist">${ps.map(p => {
    const here = isHere(r, p.id);
    const st = p.status || 'in';
    const isMe = p.id === mine;
    const acts = [];
    if (host && online && !isMe && st === 'in') {
      acts.push(`<button class="btn ghost small" data-act="kick" data-p="${esc(p.id)}">${esc(S.armed === 'kick:' + p.id ? t('sure') : t('kick'))}</button>`);
      if (p.online === true) acts.push(`<button class="btn ghost small" data-act="transfer" data-p="${esc(p.id)}">${esc(S.armed === 'transfer:' + p.id ? t('sure') : t('transfer'))}</button>`);
    }
    return `<li class="${here ? '' : 'away'}">
      <span class="pname">${online ? `<span class="pres ${here ? 'on' : ''}" aria-hidden="true"></span>` : ''}${esc(p.name)}
        ${online && p.id === r.meta.hostSlot ? `<span class="tag">${esc(t('hostTag'))}</span>` : ''}
        ${isMe ? `<span class="tag">${esc(t('you'))}</span>` : ''}
        ${statusLabel(r, p)}</span>
      ${acts.length ? `<span class="row acts">${acts.join('')}</span>` : ''}</li>`;
  }).join('')}</ul>`;
  if (online && mine) {
    const me = r.players[mine];
    if (me.nameReq && !host) h += `<p class="note">${t('reqSent', { name: `<b>${esc(me.nameReq)}</b>` })}</p>`;
    if (S.nameEdit) {
      h += `<section class="stack"><label class="field"><span class="label">${esc(t('newName'))}</span>
        <input id="nname" data-form="newName" data-enter="saveName" value="${esc(S.form.newName)}" maxlength="20"></label>
        <div class="row two"><button class="btn" data-act="saveName">${esc(host ? t('save') : t('sendReq'))}</button><button class="btn ghost" data-act="cancelName">${esc(t('cancel'))}</button></div></section>`;
    } else h += `<button class="btn ghost small self-start" data-act="editName">${esc(t('changeName'))}</button>`;
    h += `<button class="btn ghost small danger self-start" data-act="leave">${esc(S.armed === 'leave' ? t('sure') : t('leave'))}</button>`;
  }
  if (!online && host) h += `<button class="btn ghost" data-act="edit">${esc(t('editRules'))}</button>`;
  if (host) {
    h += `<section class="panel stack danger-zone"><b>${esc(t('deleteRoom'))}</b><p class="muted">${esc(t('deleteRoomNote'))}</p>
      <button class="btn danger self-start" data-act="deleteRoom">${esc(S.armed === 'deleteRoom' ? t('sure') : t('deleteRoom'))}</button></section>`;
  }
  return h;
}

// ----- Scores tab -----
function statsOf(r) {
  const st = {};
  for (const h of Object.values(r.history || {})) {
    if (!h) continue;
    const imps = arr(h.imps), out = arr(h.out);
    arr(h.roster).forEach(p => {
      const x = st[p] || (st[p] = { played: 0, won: 0, imp: 0 });
      if (out.includes(p) && !imps.includes(p)) return;
      x.played++;
      if (imps.includes(p)) x.imp++;
      if (imps.includes(p) ? h.impWins : !h.impWins) x.won++;
    });
  }
  return st;
}
function viewScores(r, host) {
  const hist = Object.values(r.history || {}).filter(Boolean).sort((a, b) => b.round - a.round);
  if (!hist.length) return `<p class="panel muted">${esc(t('noHistory'))}</p>`;
  const sc = scoresOf(r), st = statsOf(r);
  return `<section class="stack"><span class="label">${esc(t('scores'))}</span>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>${esc(t('colPlayer'))}</th><th class="num">${esc(t('colPoints'))}</th><th class="num">${esc(t('colWon'))}</th><th class="num">${esc(t('colPlayed'))}</th><th class="num">${esc(t('colImp'))}</th></tr></thead>
      <tbody>${sc.map(([p, n], i) => { const x = st[p] || { played: 0, won: 0, imp: 0 }; return `<tr class="${i === 0 && n > 0 ? 'lead' : ''}"><td>${esc(nameOf(p))}</td><td class="num"><b>${n}</b></td><td class="num">${x.won}</td><td class="num">${x.played}</td><td class="num">${x.imp}</td></tr>`; }).join('')}</tbody>
    </table></div></section>
    <section class="stack"><span class="label">${esc(t('history'))} · ${hist.length}</span>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th class="num">${esc(t('colRound'))}</th><th>${esc(t('colWord'))}</th><th>${esc(t('colImposter'))}</th><th>${esc(t('colWinner'))}</th></tr></thead>
      <tbody>${hist.map(x => `<tr><td class="num">${x.round}</td>
        <td><b lang="${normLang(x.lang)}">${esc(x.word)}</b><span class="sub-cell">${esc(catName(x.cat, S.ui))}</span></td>
        <td>${esc(arr(x.imps).map(p => nameOf(p)).join(sep()))}</td>
        <td><span class="pill ${x.impWins ? 'p-imp' : 'p-crew'}">${esc(x.impWins ? t('impWinShort') : t('crewWinShort'))}</span></td></tr>`).join('')}</tbody>
    </table></div></section>
    ${host ? `<button class="btn ghost small danger self-start" data-act="reset">${esc(S.armed === 'reset' ? t('sure') : t('resetScores'))}</button>` : ''}`;
}

// ----- Game tab -----
function viewGame(r, g, host) {
  const online = isOnline();
  let h = '';
  if (host && r.meta.pinSet === false) {
    h += `<section class="panel stack attn"><h2 class="h2">${esc(t('setPinTitle'))}</h2><p class="muted">${esc(t('setPinText'))}</p>
      ${pinInput('nhpin', 'data-form="hostPin" data-enter="saveHostPin"', 6, t('hostPin'))}
      <button class="btn" data-act="saveHostPin">${esc(t('save'))}</button></section>`;
  }
  // Host decides what happens when someone in the round is gone
  const absent = online && ACTIVE.includes(g.phase) ? activeRoster(g).filter(p => !isHere(r, p)) : [];
  if (host) {
    absent.forEach(p => {
      h += `<section class="panel stack attn"><b>${esc(t('absentTitle', { name: nameOf(p) }))}</b><p class="muted">${esc(t('absentText'))}</p>
        <div class="row two"><button class="btn small" data-act="without" data-p="${esc(p)}">${esc(t('continueWithout'))}</button>
        <button class="btn ghost small danger" data-act="cancelRound">${esc(S.armed === 'cancelRound' ? t('sure') : t('cancelRound'))}</button></div></section>`;
    });
  }
  if (online && ACTIVE.includes(g.phase) && !activeRoster(g).includes(mySlot())) {
    return h + `<p class="panel">${esc(t('watching'))}</p>`;
  }
  const views = online
    ? { lobby: vLobby, play: vPlay, vote: vVote, tie: vTie, guess: vGuess, judge: vJudge, result: vResult }
    : { lobby: vLobby, cards: vCards, discuss: vDiscuss, vote: vLocalVote, guess: vGuess, judge: vLocalJudge, result: vResult };
  h += (views[g.phase] || vLobby)(r, g, host);
  if (host && ACTIVE.includes(g.phase) && !absent.length) h += `<button class="btn ghost small danger self-start" data-act="cancelRound">${esc(S.armed === 'cancelRound' ? t('sure') : t('cancelRound'))}</button>`;
  return h;
}

function rulesSummary(r) {
  const st = r.settings || {};
  const n = arr(st.cats).length || CAT_KEYS.length;
  return `<div class="badges">
    <span class="badge">${esc(langName(st.lang))}</span>
    <span class="badge">${esc(t('catsN', { n }))}</span>
    <span class="badge">${esc(t('impsN', { n: st.imps === 2 ? 2 : 1 }))}</span>
    <span class="badge">${esc(t(st.hint === false ? 'hintOff' : 'hintOn'))}</span>
  </div>`;
}

function vLobby(r, g, host) {
  const online = isOnline();
  const here = playersOf(r).filter(p => isHere(r, p.id));
  let h = `<section class="stack"><span class="label">${esc(t('playersIn'))} · ${here.length}</span>
    <div class="namechips">${here.map(p => `<span class="namechip">${esc(p.name)}</span>`).join('')}</div>
    ${online ? `<p class="muted">${esc(t('waitPlayers'))}</p>` : ''}</section>`;
  h += rulesSummary(r);
  if (host) {
    h += `<button class="btn" data-act="start" ${here.length < 3 ? 'disabled' : ''}>${esc(t('startRound'))}</button>`;
    if (here.length < 3) h += `<p class="note">${esc(t('needMin'))}</p>`;
    h += `<div class="row two">${online ? `<button class="btn ghost" data-act="share">${esc(t('shareLink'))}</button>` : ''}<button class="btn ghost" data-act="edit">${esc(t('editRules'))}</button></div>`;
  } else {
    h += `<p class="panel muted">${esc(t('waitHost'))}</p>`;
  }
  return h;
}

function cardBlock(g, isImp, open) {
  const L = normLang(g.lang);
  const attrs = `dir="${isRTL(L) ? 'rtl' : 'ltr'}" lang="${L}"`;
  const cName = (isImp && g.hint === false) ? '???' : catName(g.cat, L);
  if (!open) {
    return `<div class="card" ${attrs}>
      <div class="card-cat"><span class="label">${esc(tl(L, 'category'))}</span><span class="cat-name">• • •</span></div>
      <div class="bars" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="card-note">${esc(tl(L, 'secret'))}</p></div>`;
  }
  const w = isImp ? tl(L, 'impWord') : g.word;
  return `<div class="card open" ${attrs}>
    <div class="card-cat"><span class="label">${esc(tl(L, 'category'))}</span><span class="cat-name">${esc(cName)}</span></div>
    <div class="word ${sizeClass(w)}">${esc(w)}</div>
    <p class="card-note">${esc(tl(L, isImp ? 'impNote' : 'crewNote'))}</p></div>`;
}
// Shrink long words so they fit on one or two lines instead of breaking mid-word
function sizeClass(w) {
  const longest = Math.max(...String(w).split(/\s+/).map(x => x.length));
  return longest > 11 ? 'xlong' : longest > 8 ? 'long' : '';
}
function myCard(g) {
  const isImp = arr(g.imps).includes(mySlot());
  return `<section class="stack">${cardBlock(g, isImp, S.cardOpen)}
    <button class="btn ghost" data-act="toggleCard">${esc(S.cardOpen ? t('hideCard') : t('showCard'))}</button></section>`;
}
function orderBlock(g) {
  const o = arr(g.order), out = arr(g.out);
  return `<section class="stack"><span class="label">${esc(t('order'))}</span>
    <ol class="order">${o.map((p, i) => {
      const gone = out.includes(p), away = !gone && !isHere(S.room, p);
      const extra = gone ? `<span class="st st-out">${esc(t('outTag'))}</span>` : away ? `<span class="st">${esc(t('statusOffline'))}</span>` : i === 0 ? `<span class="tag">${esc(t('starts'))}</span>` : '';
      return `<li class="${i === 0 ? 'first' : ''} ${gone ? 'gone' : ''}"><span>${esc(nameOf(p))}</span>${extra}</li>`;
    }).join('')}</ol>
    <p class="muted">${esc(t('orderHint'))}</p></section>`;
}

function vPlay(r, g) {
  return myCard(g) + orderBlock(g) + `<button class="btn" data-act="toVote">${esc(t('toVote'))}</button>`;
}

function vVote(r, g, host) {
  const key = vkey(g), votes = r.votes || {}, me = mySlot(), mine = votes[me];
  const done = mine && mine.key === key;
  const act = activeRoster(g);
  let h = `<section class="stack"><h2 class="h2">${esc(t('whoImp'))}</h2>${g.vr ? `<span class="badge self-start">${esc(t('revoteN', { n: g.vr + 1 }))}</span>` : ''}`;
  if (done) h += `<div class="verdict">${t('voted', { name: esc(nameOf(mine.target)) })}</div>`;
  else {
    h += `<p class="muted">${esc(t('pickOne'))}</p><div class="stack">${act.filter(p => p !== me).map(p =>
      `<button class="vote" data-act="pick" data-p="${esc(p)}" aria-pressed="${S.pick === p}"><span>${esc(nameOf(p))}</span><span class="tick" aria-hidden="true">${S.pick === p ? '✓' : ''}</span></button>`).join('')}</div>
      <button class="btn" data-act="confirmVote" ${S.pick ? '' : 'disabled'}>${esc(t('confirm'))}</button>`;
  }
  const waiting = act.filter(p => !(votes[p] && votes[p].key === key));
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
  const j = r.judges || {}, me = mySlot();
  const judges = activeRoster(g).filter(p => p !== g.caught);
  const amJudge = judges.includes(me);
  const answered = j[me] && j[me].round === g.round;
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
  if (g.impLeft) msg = esc(t('resImpLeft', { name: nameOf(g.impLeft) }));
  else if (!caught || !imps.includes(caught)) msg = t('resWrong', { name: esc(nameOf(caught)) });
  else msg = esc(impWin ? t('resGuessed') : t('resFailed'));
  const L = normLang(g.lang);
  let h = `<section class="verdict ${impWin ? 'imp' : 'crew'} stack">
      <span class="label">${esc(t('resultLabel'))}</span>
      <h2 class="h2">${esc(impWin ? t('impWin') : t('crewWin'))}</h2>
      <p>${msg}</p><p class="pts">${esc(impWin ? t('ptsImp') : t('ptsCrew'))}</p></section>
    <section class="facts">
      <div><span class="label">${esc(t('theWord'))}</span><b class="fact" lang="${L}">${esc(g.word)}</b><span class="muted">${esc(catName(g.cat, S.ui))}</span></div>
      <div><span class="label">${esc(imps.length > 1 ? t('impsWere') : t('impWas'))}</span><b class="fact">${imps.map(p => esc(nameOf(p))).join(sep())}</b></div>
    </section>`;
  if (isOnline()) {
    const key = vkey(g), votes = r.votes || {};
    h += `<details class="hist"><summary>${esc(t('votesTitle'))}</summary><ul class="plist small">${activeRoster(g).map(p => {
      const v = votes[p];
      const target = v && v.key === key ? esc(nameOf(v.target)) : `<span class="muted">${esc(t('noVote'))}</span>`;
      return `<li><span>${esc(nameOf(p))}</span><span class="arrow">${isRTL(S.ui) ? '←' : '→'} ${target}</span></li>`;
    }).join('')}</ul></details>`;
  }
  if (host) h += `<button class="btn" data-act="start">${esc(t('newRound'))}</button><button class="btn ghost" data-act="edit">${esc(t('editRules'))}</button>`;
  else h += `<p class="panel muted">${esc(t('waitHost'))}</p>`;
  return h;
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
  if (i > 0 || S.local.shown) h += `<button class="btn ghost small self-start" data-act="lback">${backArrow()} ${esc(t('back'))}</button>`;
  return h;
}
function vDiscuss(r, g) {
  return (g.tieNote ? `<div class="verdict imp">${esc(t('tieNote'))}</div>` : '') + orderBlock(g) +
    `<button class="btn" data-act="toVote">${esc(t('toVote'))}</button>
     <button class="btn ghost small self-start" data-act="backCards">${backArrow()} ${esc(t('back'))}</button>`;
}
function vLocalVote(r, g) {
  return `<section class="stack"><h2 class="h2">${esc(t('whoImp'))}</h2><p class="muted">${esc(t('localVoteHint'))}</p>
    <div class="stack">${arr(g.roster).map(p => `<button class="vote" data-act="pick" data-p="${esc(p)}" aria-pressed="${S.pick === p}"><span>${esc(nameOf(p))}</span><span class="tick" aria-hidden="true">${S.pick === p ? '✓' : ''}</span></button>`).join('')}</div>
    <button class="btn" data-act="lconfirm" ${S.pick ? '' : 'disabled'}>${esc(t('confirmPick'))}</button>
    <button class="btn ghost" data-act="ltie">${esc(t('tieBtn'))}</button></section>
    <button class="btn ghost small self-start" data-act="backDiscuss">${backArrow()} ${esc(t('back'))}</button>`;
}
function vLocalJudge(r, g) {
  return `<section class="stack"><h2 class="h2">${esc(t('judgeQ', { name: nameOf(g.caught) }))}</h2>
    <div class="row two"><button class="btn" data-act="ljudge" data-v="1">${esc(t('yes'))}</button><button class="btn ghost" data-act="ljudge" data-v="0">${esc(t('no'))}</button></div></section>`;
}

// ---------- events ----------
$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (S.langOpen && !e.target.closest('.lang-menu')) { S.langOpen = false; render(); } return; }
  if (b.disabled) return;
  act(b.dataset.act, b.dataset);
});
$app.addEventListener('input', e => {
  const el = e.target, ds = el.dataset;
  if (ds.field === 'joinCode') {
    const v = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (el.value !== v) el.value = v;
    S.joinCode = v;
  } else if (ds.form) S.form[ds.form] = el.value;
  else if (ds.draft && S.draft) S.draft[ds.draft] = el.value;
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
  // Two-tap confirmation for destructive actions
  const armKey = ['kick', 'transfer'].includes(a) ? `${a}:${ds.p}` : a;
  if (['reset', 'cancelRound', 'leave', 'kick', 'transfer', 'deleteRoom'].includes(a) && S.armed !== armKey) { S.armed = armKey; render(); return; }
  const wasArmed = S.armed; S.armed = null;
  if (a !== 'langMenu' && a !== 'setLang') S.langOpen = false;
  const d = S.draft;
  switch (a) {
    case 'home': if (S.view === 'room') leaveRoom(); else { S.view = 'home'; render(); } break;
    case 'langMenu': S.langOpen = !S.langOpen; render(); break;
    case 'about': S.view = 'about'; render(); window.scrollTo(0, 0); break;
    case 'deleteRoom': deleteRoom(); break;
    case 'setLang': S.ui = normLang(ds.v); S.langOpen = false; ls.set('ui', S.ui); render(); break;
    case 'tab': S.tab = ds.v; S.editing = false; render(); break;
    case 'newOnline': case 'newLocal':
      S.draft = newDraft(a === 'newLocal' ? 'local' : 'online'); S.view = 'create'; render(); break;
    case 'go':
      if (!/^[A-Z2-9]{6}$/.test(S.joinCode)) flash(t('badCode')); else openRoom(S.joinCode);
      break;
    case 'open': openRoom(ds.code); break;
    case 'jmode': S.form.mode = ds.v; S.form.pin = ''; S.form.hostPin = ''; render(); break;
    case 'jslot': S.form.slot = ds.p; render(); break;
    case 'dpublic': d.public = !d.public; render(); break;
    case 'joinNew': joinNew(); break;
    case 'joinBack': joinReturning(); break;
    case 'claimHost': claimHost(); break;
    case 'comeBack': {
      const slot = mySlot();
      if (slot) update(P(`players/${slot}`), { status: 'in', online: true }).catch(fail);
      break;
    }
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
    case 'kick': update(P(`players/${ds.p}`), { status: 'kicked' }).catch(fail); break;
    case 'transfer': transferHost(ds.p); break;
    case 'saveHostPin': saveNewHostPin(); break;
    case 'leave': leaveSeat(); break;
    case 'editName': S.nameEdit = true; S.form.newName = (meP() && meP().name) || ''; render(); break;
    case 'cancelName': S.nameEdit = false; render(); break;
    case 'saveName': {
      const n = S.form.newName.trim().slice(0, 20), slot = mySlot();
      if (!n || !slot) break;
      const req = isHost() ? update(P(`players/${slot}`), { name: n, nameReq: null }) : set(P(`players/${slot}/nameReq`), n);
      req.then(() => { S.nameEdit = false; render(); }).catch(fail);
      break;
    }
    case 'approveName': {
      const p = r.players[ds.p];
      if (p && p.nameReq) update(P(`players/${ds.p}`), { name: p.nameReq, nameReq: null }).catch(fail);
      break;
    }
    case 'rejectName': set(P(`players/${ds.p}/nameReq`), null).catch(fail); break;
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
      set(P(`votes/${mySlot()}`), { key: vkey(g), target: S.pick }).catch(fail); break;
    case 'countNow': resolveVotes(); break;
    case 'revote':
      tx(cur => cur.phase === 'tie' && cur.round === g.round, cur => ({ phase: 'vote', vr: (cur.vr || 0) + 1, tied: null })); break;
    case 'endGuess': toJudge(); break;
    case 'judge':
      set(P(`judges/${mySlot()}`), { round: g.round, yes: ds.v === '1' }).catch(fail); break;
    case 'forceJudge': resolveJudge(); break;
    case 'without': continueWithout(ds.p); break;
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

window.addEventListener('pagehide', dropPresence);
render();
