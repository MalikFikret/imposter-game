import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, update, remove } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { CATS } from './words.js?v=1.0.7';
import { LANGS } from './i18n.js?v=1.0.7';
const langName = c => (LANGS.find(l => l.code === c) || LANGS[0]).name;

// Same project as the game, but a separately named app instance so the admin's Google
// session never replaces the anonymous identity the game uses on this device.
const app = initializeApp({
  apiKey: 'AIzaSyCyBRkSve7IdHXwBrljQDOyiVCCRnrKucM',
  authDomain: 'imposter-malik.firebaseapp.com',
  databaseURL: 'https://imposter-malik-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'imposter-malik',
  storageBucket: 'imposter-malik.firebasestorage.app',
  messagingSenderId: '358335009293',
  appId: '1:358335009293:web:439ba4c30a8efa69787b44'
}, 'admin');
const auth = getAuth(app);
const db = getDatabase(app);

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = v => Array.isArray(v) ? v.filter(x => x != null) : (v && typeof v === 'object' ? Object.values(v) : []);
const DAY = 86400000;
const S = { user: null, state: 'loading', rooms: {}, stats: null, statsUnsub: null, sel: null, filter: '', armed: null, toast: '', unsub: null, pin: '', rename: null, renameVal: '' };

function flash(m) { S.toast = m; render(); setTimeout(() => { S.toast = ''; render(); }, 2800); }
const fail = e => flash('Hata: ' + esc(e && (e.code || e.message) || e));

onAuthStateChanged(auth, u => {
  S.user = u;
  if (S.unsub) { S.unsub(); S.unsub = null; }
  if (!u) { S.state = 'login'; render(); return; }
  S.state = 'loading'; render();
  if (S.statsUnsub) { S.statsUnsub(); S.statsUnsub = null; }
  S.statsUnsub = onValue(ref(db, 'stats'), snap => { S.stats = snap.val() || {}; render(); }, () => { S.stats = null; });
  S.unsub = onValue(ref(db, 'rooms'), snap => { S.rooms = snap.val() || {}; S.state = 'ok'; render(); },
    () => { S.state = 'denied'; render(); });
});

async function login() {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await signInWithRedirect(auth, p);
    else fail(e);
  }
}

// ---------- room helpers ----------
const playersOf = r => Object.entries(r.players || {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
const here = (r, p) => r.meta && r.meta.mode === 'local' ? true : (p.status || 'in') === 'in' && p.online === true;
function lastActive(r) {
  let t = (r.meta && r.meta.createdAt) || 0;
  if (r.game && r.game.startedAt) t = Math.max(t, r.game.startedAt);
  for (const h of Object.values(r.history || {})) if (h && h.at) t = Math.max(t, h.at);
  return t;
}
function ago(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'şimdi';
  if (m < 60) return `${m} dk önce`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} sa önce`;
  return `${Math.round(h / 24)} gün önce`;
}
function scores(r) {
  const sc = {};
  for (const h of Object.values(r.history || {})) {
    if (!h) continue;
    const imps = arr(h.imps), out = arr(h.out);
    arr(h.roster).forEach(p => { sc[p] = sc[p] || 0; });
    if (h.impWins) imps.forEach(p => { sc[p] += 2; });
    else arr(h.roster).filter(p => !imps.includes(p) && !out.includes(p)).forEach(p => { sc[p] += 1; });
  }
  return sc;
}
const roomName = r => ((r.settings && r.settings.name) || '').trim();
const hostName = r => { const p = r.meta && r.meta.hostSlot && r.players && r.players[r.meta.hostSlot]; return p ? p.name : (r.meta && r.meta.mode === 'local' ? 'Tek telefon' : '?'); };
const nameOf = (r, id) => (r.players && r.players[id] && r.players[id].name) || Object.values(r.history || {}).map(h => h && h.names && h.names[id]).find(Boolean) || '?';

// ---------- views ----------
function render() {
  let h = `<header class="top"><span class="brand">Sahtekâr · Yönetim</span>${S.user ? `<button class="chip-btn" data-act="logout">Çıkış</button>` : ''}</header>`;
  if (S.state === 'loading') h += `<p class="panel muted">Yükleniyor…</p>`;
  else if (S.state === 'login') h += `<section class="panel stack"><h2 class="h2">Yönetici girişi</h2><p class="muted">Bu sayfa sadece yöneticiler içindir. Google hesabınla giriş yap.</p><button class="btn" data-act="login">Google ile giriş yap</button><a class="muted" href="./">Oyuna dön</a></section>`;
  else if (S.state === 'denied') h += `<section class="panel stack attn"><h2 class="h2">Bu hesabın yetkisi yok</h2>
      <p class="muted">Hesap: ${esc(S.user.email || '')}. Bu hesabı yönetici yapmak için aşağıdaki kimliği (UID) Claude'a gönder.</p>
      <div class="uid">${esc(S.user.uid)}</div><button class="btn ghost small self-start" data-act="copyUid">Kopyala</button></section>`;
  else h += S.sel && S.rooms[S.sel] ? viewRoom(S.sel, S.rooms[S.sel]) : viewList();
  if (S.toast) h += `<div class="toast" role="status">${S.toast}</div>`;
  $app.innerHTML = h;
}

// Usage counters (stats/totals, stats/daily/YYYY-MM-DD), kept even when rooms are deleted
const nf = n => Number(n || 0).toLocaleString('tr-TR');
function viewStats() {
  const st = S.stats;
  if (!st) return '';
  const T = st.totals || {};
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() + 3 * 3600 * 1000 - i * DAY).toISOString().slice(0, 10));
  const D = st.daily || {};
  const max = Math.max(1, ...days.map(d => (D[d] && D[d].rounds) || 0));
  return `<section class="stack"><span class="label">Kullanım istatistikleri · tüm zamanlar</span>
    <section class="stats">
      <div class="stat"><span class="label">Ziyaret</span><b>${nf(T.visits)}</b></div>
      <div class="stat"><span class="label">Farklı cihaz</span><b>${nf(T.devices)}</b></div>
      <div class="stat"><span class="label">Kurulan oda</span><b>${nf(T.rooms)}</b><span class="muted">online ${nf(T.rooms_online)} · tek tel. ${nf(T.rooms_local)}</span></div>
      <div class="stat"><span class="label">Oynanan tur</span><b>${nf(T.rounds)}</b><span class="muted">TR ${nf(T.rounds_tr)} · AR ${nf(T.rounds_ar)} · EN ${nf(T.rounds_en)}</span></div>
      <div class="stat"><span class="label">Odaya katılım</span><b>${nf(T.players)}</b><span class="muted">online oyuncu girişi</span></div>
    </section>
    <span class="label">Son 14 gün</span>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Gün</th><th class="num">Ziyaret</th><th class="num">Cihaz</th><th class="num">Oda</th><th class="num">Katılım</th><th>Tur</th></tr></thead><tbody>
      ${days.slice().reverse().map(d => { const x = D[d] || {}; const r = x.rounds || 0; return `<tr><td class="mono">${d.slice(5)}</td><td class="num">${nf(x.visits)}</td><td class="num">${nf(x.devices)}</td><td class="num">${nf(x.rooms)}</td><td class="num">${nf(x.players)}</td><td><span class="bar"><i style="width:${Math.round(r / max * 100)}%"></i></span><span class="num">${r}</span></td></tr>`; }).join('')}
    </tbody></table></div>
    <p class="note">Sayaçlar 1.0.5 sürümüyle başladı; öncesindeki kullanım sayılmadı. "Farklı cihaz" tarayıcı başına bir kez sayılır.</p>
  </section>`;
}

function viewList() {
  const all = Object.entries(S.rooms).map(([code, r]) => ({ code, r, last: lastActive(r) })).sort((a, b) => b.last - a.last);
  const f = S.filter.trim().toLocaleLowerCase();
  const list = f ? all.filter(x => x.code.toLowerCase().includes(f) || roomName(x.r).toLocaleLowerCase().includes(f) || hostName(x.r).toLocaleLowerCase().includes(f) || playersOf(x.r).some(p => (p.name || '').toLocaleLowerCase().includes(f))) : all;
  const online = all.reduce((n, x) => n + playersOf(x.r).filter(p => x.r.meta && x.r.meta.mode === 'online' && here(x.r, p)).length, 0);
  const old = all.filter(x => Date.now() - x.last > 30 * DAY);
  return viewStats() + `<span class="label">Şu anki odalar</span><section class="stats">
      <div class="stat"><span class="label">Toplam oda</span><b>${all.length}</b></div>
      <div class="stat"><span class="label">Son 24 saat</span><b>${all.filter(x => Date.now() - x.last < DAY).length}</b></div>
      <div class="stat"><span class="label">Şu an çevrimiçi</span><b>${online}</b></div>
      <div class="stat"><span class="label">Açık oda</span><b>${all.filter(x => x.r.settings && x.r.settings.public).length}</b></div>
    </section>
    <input id="flt" data-field="filter" value="${esc(S.filter)}" placeholder="Kod ya da oyuncu adıyla ara" autocomplete="off">
    <div class="list">${list.map(({ code, r, last }) => {
      const ps = playersOf(r), live = ps.filter(p => here(r, p)).length;
      return `<button class="room-row" data-act="sel" data-c="${esc(code)}">
        <span class="code" dir="ltr">${esc(code)}</span>
        <b>${esc(roomName(r) || hostName(r))}</b>
        <span class="badge">${r.meta && r.meta.mode === 'local' ? 'Tek telefon' : (r.settings && r.settings.public ? 'Açık' : 'Özel')}</span>
        <span class="meta">${roomName(r) ? esc(hostName(r)) + ' · ' : ''}${r.meta && r.meta.mode === 'online' ? `${live}/${ps.length} odada` : `${ps.length} oyuncu`} · ${Object.keys(r.history || {}).length} tur · ${ago(last)}</span>
      </button>`;
    }).join('') || '<p class="muted">Oda yok.</p>'}</div>
    ${old.length ? `<button class="btn ghost small danger self-start" data-act="purge">${S.armed === 'purge' ? `Emin misin? ${old.length} oda silinecek` : `30 günden eski odaları sil (${old.length})`}</button>` : ''}`;
}

function viewRoom(code, r) {
  const online = r.meta && r.meta.mode === 'online';
  const ps = playersOf(r), sc = scores(r), g = r.game || {};
  const hist = Object.values(r.history || {}).filter(Boolean).sort((a, b) => b.round - a.round);
  const st = r.settings || {};
  return `<div class="row"><button class="btn ghost small" data-act="back">← Tüm odalar</button><a class="btn ghost small" href="./#${esc(code)}" target="_blank" rel="noopener">Oyunda aç</a></div>
    <h2 class="title" dir="ltr">${esc(code)}</h2>${roomName(r) ? `<p class="h2">${esc(roomName(r))}</p>` : ''}
    <dl class="kv">
      <dt>Tür</dt><dd>${online ? 'Online' : 'Tek telefon'}${online ? ` · ${st.public ? 'Açık' : 'Özel'}` : ''}</dd>
      <dt>Oda sahibi</dt><dd>${esc(hostName(r))}${r.meta && r.meta.pinSet === false ? ' · PIN belirlenmemiş' : ''}</dd>
      <dt>Kuruldu</dt><dd>${r.meta && r.meta.createdAt ? new Date(r.meta.createdAt).toLocaleString('tr-TR') : '—'}</dd>
      <dt>Son hareket</dt><dd>${ago(lastActive(r))}</dd>
      <dt>Durum</dt><dd>${esc(g.phase || 'lobby')}${g.round ? ` · tur ${g.round}` : ''}${g.word ? ` · kelime: <b>${esc(g.word)}</b>` : ''}</dd>
      <dt>Kurallar</dt><dd>${esc(langName(st.lang))} · ${arr(st.cats).map(c => CATS[c] ? CATS[c].names.tr : c).join(', ') || 'tüm kategoriler'} · ${st.imps === 2 ? 2 : 1} sahtekâr · ipucu ${st.hint === false ? 'kapalı' : 'açık'}</dd>
    </dl>

    <section class="stack"><span class="label">Oyuncular · ${ps.length}</span>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Ad</th><th>Durum</th><th class="num">Puan</th><th></th></tr></thead><tbody>
      ${ps.map(p => `<tr><td>${S.rename === p.id ? `<input id="rn" data-field="renameVal" value="${esc(S.renameVal)}" maxlength="20">` : `<b>${esc(p.name)}</b>${p.id === (r.meta && r.meta.hostSlot) ? ' <span class="tag">sahip</span>' : ''}${p.nameReq ? `<span class="sub-cell">istek: ${esc(p.nameReq)}</span>` : ''}`}</td>
        <td>${online ? (p.status === 'kicked' ? 'atıldı' : p.status === 'left' ? 'çıktı' : p.online ? '<span class="pres on"></span>çevrimiçi' : '<span class="pres"></span>bağlantı yok') : '—'}</td>
        <td class="num">${sc[p.id] || 0}</td>
        <td><span class="acts">${S.rename === p.id
          ? `<button class="btn small" data-act="saveRename" data-p="${esc(p.id)}">Kaydet</button><button class="btn ghost small" data-act="cancelRename">Vazgeç</button>`
          : `<button class="btn ghost small" data-act="rename" data-p="${esc(p.id)}">Adı değiştir</button>${online ? (p.status === 'kicked' ? `<button class="btn ghost small" data-act="unkick" data-p="${esc(p.id)}">Geri al</button>` : `<button class="btn ghost small" data-act="kick" data-p="${esc(p.id)}">At</button>`) : ''}`}</span></td></tr>`).join('')}
      </tbody></table></div></section>

    ${hist.length ? `<section class="stack"><span class="label">Tur geçmişi · ${hist.length}</span>
      <div class="table-wrap"><table class="tbl"><thead><tr><th class="num">Tur</th><th>Kelime</th><th>Sahtekâr</th><th>Kazanan</th><th>Zaman</th></tr></thead><tbody>
      ${hist.map(x => `<tr><td class="num">${x.round}</td><td><b>${esc(x.word)}</b><span class="sub-cell">${esc(CATS[x.cat] ? CATS[x.cat].names.tr : '')}</span></td><td>${esc(arr(x.imps).map(p => nameOf(r, p)).join(', '))}</td>
        <td><span class="pill ${x.impWins ? 'p-imp' : 'p-crew'}">${x.impWins ? 'sahtekâr' : 'ekip'}</span></td><td class="muted">${ago(x.at)}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}

    <section class="panel stack"><span class="label">İşlemler</span>
      ${online ? `<button class="btn ghost" data-act="togglePublic">${st.public ? 'Özel yap (listeden kaldır)' : 'Açık yap (listede göster)'}</button>` : ''}
      <label class="field"><span class="label">Yeni oda PIN'i (6 rakam)</span><input id="npin" class="pin-in" data-field="pin" inputmode="numeric" maxlength="6" autocomplete="off" dir="ltr" value="${esc(S.pin)}"></label>
      <button class="btn ghost" data-act="setPin">Oda PIN'ini sıfırla</button>
      ${g.phase && g.phase !== 'lobby' ? `<button class="btn ghost" data-act="endRound">Turu bitir (puan yazılmaz)</button>` : ''}
      ${hist.length ? `<button class="btn ghost danger" data-act="clearHist">${S.armed === 'clearHist' ? 'Emin misin? Tekrar bas' : 'Puanları ve geçmişi sil'}</button>` : ''}
      <button class="btn danger" data-act="del">${S.armed === 'del' ? 'Emin misin? Oda tamamen silinecek' : 'Odayı sil'}</button>
    </section>`;
}

// ---------- actions ----------
const R = p => ref(db, `rooms/${S.sel}/${p}`);
function delPaths(code) { return { [`rooms/${code}`]: null, [`secrets/${code}`]: null, [`publicRooms/${code}`]: null, [`claims/${code}`]: null }; }

$app.addEventListener('input', e => { const f = e.target.dataset.field; if (f) { S[f] = e.target.value; if (f === 'filter') { render(); const el = document.getElementById('flt'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } });
$app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, ds = b.dataset;
  if (['del', 'clearHist', 'purge'].includes(a) && S.armed !== a) { S.armed = a; render(); return; }
  S.armed = null;
  const r = S.sel && S.rooms[S.sel];
  try {
    switch (a) {
      case 'login': await login(); break;
      case 'logout': await signOut(auth); break;
      case 'copyUid': await navigator.clipboard.writeText(S.user.uid); flash('Kopyalandı'); break;
      case 'sel': S.sel = ds.c; S.pin = ''; S.rename = null; render(); window.scrollTo(0, 0); break;
      case 'back': S.sel = null; render(); break;
      case 'rename': S.rename = ds.p; S.renameVal = r.players[ds.p].name || ''; render(); break;
      case 'cancelRename': S.rename = null; render(); break;
      case 'saveRename': {
        const n = S.renameVal.trim().slice(0, 20);
        if (!n) break;
        await update(R(`players/${ds.p}`), { name: n, nameReq: null }); S.rename = null; flash('Ad değiştirildi'); break;
      }
      case 'kick': await set(R(`players/${ds.p}/status`), 'kicked'); break;
      case 'unkick': await set(R(`players/${ds.p}/status`), 'in'); break;
      case 'togglePublic': {
        const pub = !(r.settings && r.settings.public);
        await set(R('settings/public'), pub);
        if (pub) {
          const ps = playersOf(r);
          await set(ref(db, `publicRooms/${S.sel}`), { name: roomName(r), hostName: hostName(r), lang: (r.settings && r.settings.lang) || 'tr', players: ps.filter(p => here(r, p)).length, phase: 'lobby', updatedAt: Date.now() });
        } else await remove(ref(db, `publicRooms/${S.sel}`));
        flash(pub ? 'Oda açık yapıldı' : 'Oda özel yapıldı'); break;
      }
      case 'setPin':
        if (!/^[0-9]{6}$/.test(S.pin)) { flash('PIN 6 rakam olmalı'); break; }
        await set(ref(db, `secrets/${S.sel}/hostPin`), S.pin); await set(R('meta/pinSet'), true); S.pin = ''; flash('Oda PIN\'i sıfırlandı'); break;
      case 'endRound': await set(R('game/phase'), 'lobby'); flash('Tur bitirildi'); break;
      case 'clearHist': await remove(R('history')); flash('Geçmiş silindi'); break;
      case 'del': { const c = S.sel; S.sel = null; await update(ref(db), delPaths(c)); flash('Oda silindi'); break; }
      case 'purge': {
        const paths = {};
        Object.entries(S.rooms).forEach(([c, rr]) => { if (Date.now() - lastActive(rr) > 30 * DAY) Object.assign(paths, delPaths(c)); });
        await update(ref(db), paths); flash('Eski odalar silindi'); break;
      }
    }
  } catch (err) { fail(err); }
  render();
});

render();
