// 우리집 냉장고 — 앱 동작 코드
import { FIREBASE_CONFIG } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";
const SDK = name => `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-${name}.js`;

// ───── 분류 ─────
const CATS = [
  {id:"veg",    name:"채소",        icon:"🥬", subs:["양파","대파","당근","감자","고구마","배추","상추","오이","마늘","버섯","호박"]},
  {id:"fruit",  name:"과일",        icon:"🍎", subs:["사과","배","귤","바나나","포도","딸기","토마토","수박"]},
  {id:"meat",   name:"고기",        icon:"🥩", subs:["소고기","돼지고기","닭고기","햄·소시지"]},
  {id:"sea",    name:"수산물",      icon:"🐟", subs:["생선","새우","오징어","조개","어묵"]},
  {id:"dairy",  name:"유제품·달걀", icon:"🥛", subs:["우유","요거트","치즈","달걀","버터"]},
  {id:"bread",  name:"빵·떡",       icon:"🍞", subs:["식빵","케이크","떡"]},
  {id:"snack",  name:"과자",        icon:"🍪", subs:["과자","초콜릿","젤리","아이스크림"]},
  {id:"drink",  name:"음료",        icon:"🧃", subs:["주스","탄산음료","두유"]},
  {id:"side",   name:"반찬·김치",   icon:"🍱", subs:["김치","밑반찬","남은 음식"]},
  {id:"sauce",  name:"양념·소스",   icon:"🧂", subs:["장류","소스","드레싱"]},
  {id:"frozen", name:"냉동식품",    icon:"🧊", subs:["만두","냉동밥","너겟"]},
  {id:"etc",    name:"기타",        icon:"📦", subs:[]}
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));

// ───── 날짜 도우미 ─────
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => ymd(new Date());
function parse(s){ if(!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); }
function daysLeft(s){ const d = parse(s); if(!d) return null; return Math.round((d - parse(today())) / 86400000); }
function addDays(s, n){ const d = parse(s) || parse(today()); d.setDate(d.getDate() + n); return ymd(d); }
function shortDate(s){ const d = parse(s); return d ? (d.getMonth()+1) + "/" + d.getDate() : ""; }
function badge(s){
  const n = daysLeft(s);
  if(n === null) return '<span class="badge b-none">기한 없음</span>';
  if(n < 0)  return '<span class="badge b-red">' + (-n) + '일 지남</span>';
  if(n === 0) return '<span class="badge b-red">오늘까지</span>';
  if(n <= 3) return '<span class="badge b-orange">D-' + n + '</span>';
  return '<span class="badge b-green">D-' + n + '</span>';
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function hl(text, q){
  const s = String(text);
  if(!q) return esc(s);
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if(i < 0) return esc(s);
  return esc(s.slice(0,i)) + "<mark>" + esc(s.slice(i, i+q.length)) + "</mark>" + esc(s.slice(i+q.length));
}

// ───── 가족 코드 ─────
const FAMILY_KEY = "fridge-family-code";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0,O,1,I 빼고
function makeCode(){
  const a = new Uint32Array(12); crypto.getRandomValues(a);
  return Array.from(a, n => CODE_CHARS[n % CODE_CHARS.length]).join("");
}
function normCode(s){ return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function validCode(c){ return c.length === 12 && [...c].every(ch => CODE_CHARS.includes(ch)); }
function prettyCode(c){ return c.slice(0,4) + "-" + c.slice(4,8) + "-" + c.slice(8,12); }
function getSavedCode(){ try{ return localStorage.getItem(FAMILY_KEY) || ""; }catch(e){ return ""; } }
function saveCode(c){ try{ localStorage.setItem(FAMILY_KEY, c); }catch(e){} }

// ───── 저장소 ─────
// mode: loading | cloud (Firebase, 가족 공유) | local (이 기기에만)
let items = [];
let mode = "loading";
let online = true;
let fb = null;          // { fs, db, col }
let unsub = null;
let familyCode = "";
const LS_KEY = "fridge-items-local-v1";

const configured = Object.values(FIREBASE_CONFIG).every(v => typeof v === "string" && v.trim() !== "");

function clean(o){
  return {
    name: String(o.name || "").slice(0, 40),
    cat: CAT[o.cat] ? o.cat : "etc",
    sub: String(o.sub || "").slice(0, 30),
    qty: Math.max(0, Math.min(9999, Math.floor(Number(o.qty) || 0))),
    buy: String(o.buy || ""),
    exp: String(o.exp || ""),
    created: Math.floor(Number(o.created) || Date.now())
  };
}
function lsSave(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(items)); }catch(e){} }
function lsLoad(){
  try{
    const a = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(a) ? a.filter(x => x && x.id).map(x => Object.assign({id: x.id}, clean(x))) : [];
  }catch(e){ return []; }
}
const newId = () => "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ── 즐겨찾기 (자주 사는 음식) ──
let favs = [];
let unsubFav = null;
let favRulesMissing = false;
const FAV_RULES_MSG = "즐겨찾기를 쓰려면 Firebase 보안 규칙을 새것으로 바꿔 주세요. (firestore.rules)";
const LS_FAV = "fridge-favs-local-v1";
function cleanFav(o){
  return {
    name: String(o.name || "").trim().slice(0, 40),
    cat: CAT[o.cat] ? o.cat : "etc",
    sub: String(o.sub || "").trim().slice(0, 30),
    qty: Math.max(1, Math.min(9999, Math.floor(Number(o.qty) || 1))),
    days: (() => { const d = Math.floor(Number(o.days)); return Number.isFinite(d) ? Math.max(-1, Math.min(3650, d)) : -1; })(),
    created: Math.floor(Number(o.created) || Date.now())
  };
}
// 같은 분류·소분류·이름이면 같은 즐겨찾기로 봐요
function favIdOf(o){
  const key = [o.cat, String(o.sub || "").trim(), String(o.name || "").trim()].join("|");
  let h = 0x811c9dc5;
  for(const ch of key){ h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return "f" + h.toString(36);
}
function lsSaveFav(){ try{ localStorage.setItem(LS_FAV, JSON.stringify(favs)); }catch(e){} }
function lsLoadFav(){
  try{
    const a = JSON.parse(localStorage.getItem(LS_FAV) || "[]");
    return Array.isArray(a) ? a.filter(x => x && x.id).map(x => Object.assign({id: x.id}, cleanFav(x))) : [];
  }catch(e){ return []; }
}
const isFav = i => favs.some(f => f.id === favIdOf(i));
const stockOf = f => items.filter(i => favIdOf(i) === f.id).reduce((s, i) => s + i.qty, 0);
function saveFav(o){
  const body = cleanFav(o); const id = favIdOf(body);
  const k = favs.findIndex(f => f.id === id);
  if(k >= 0){ body.created = favs[k].created; favs[k] = Object.assign({id}, body); } else favs.push(Object.assign({id}, body));
  if(mode === "cloud") cloudWrite(id, body, fb && fb.favCol); else lsSaveFav();
  render();
}
function removeFav(id){
  if(!favs.some(f => f.id === id)) return;
  favs = favs.filter(f => f.id !== id);
  if(mode === "cloud") cloudWrite(id, null, fb && fb.favCol); else lsSaveFav();
  render();
}

function cloudWrite(id, body, colRef){
  if(!fb) return;
  const ref = fb.fs.doc(colRef || fb.col, id);
  const p = body ? fb.fs.setDoc(ref, body) : fb.fs.deleteDoc(ref);
  // 인터넷이 없으면 휴대폰에 먼저 저장되고, 연결되면 자동으로 올라가요.
  p.catch(err => {
    console.error(err);
    if(err && err.code === "permission-denied") toast("저장할 권한이 없어요. Firebase 규칙을 확인해 주세요");
    else toast("저장하지 못했어요");
  });
}

function saveItem(id, data){
  const body = clean(data);
  const i = items.findIndex(x => x.id === id);
  if(i >= 0) items[i] = Object.assign({id}, body); else items.push(Object.assign({id}, body));
  render();
  if(mode === "cloud") cloudWrite(id, body); else lsSave();
}
function removeItem(id){
  items = items.filter(x => x.id !== id);
  render();
  if(mode === "cloud") cloudWrite(id, null); else lsSave();
}

const qtyTimers = {};
function bumpQty(id, delta){
  const it = items.find(x => x.id === id); if(!it) return;
  const nq = Math.max(0, it.qty + delta);
  if(nq === 0 && it.qty > 0){
    ask("'" + (it.name || it.sub) + "' 다 먹었나요? 목록에서 지울게요.", "지우기", () => removeItem(id));
    return;
  }
  it.qty = nq; render();
  clearTimeout(qtyTimers[id]);
  qtyTimers[id] = setTimeout(() => {
    const cur = items.find(x => x.id === id); if(!cur) return;
    if(mode === "cloud") cloudWrite(id, clean(cur)); else lsSave();
  }, 600);
}

// ───── 시작 ─────
async function start(){
  // 초대 링크(?family=코드)로 들어왔으면 그 코드로 연결
  const urlCode = normCode(new URLSearchParams(location.search).get("family"));
  if(validCode(urlCode)){
    saveCode(urlCode);
    history.replaceState(null, "", location.pathname);
  }

  if(!configured){ startLocal("Firebase 설정 전이라 목록이 이 기기에만 저장돼요. (설정방법.md 참고)"); return; }

  familyCode = getSavedCode();
  if(!validCode(familyCode)){ showSetup(true); return; }
  showSetup(false);
  await connect(familyCode);
}

async function connect(code){
  mode = "loading"; items = []; render();
  setNotice("", "연결하는 중…");
  try{
    if(!fb){
      const [{ initializeApp }, fs, au] = await Promise.all([import(SDK("app")), import(SDK("firestore")), import(SDK("auth"))]);
      const app = initializeApp(FIREBASE_CONFIG);
      let db;
      try{
        db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
      }catch(e){
        db = fs.getFirestore(app);
      }
      const auth = au.getAuth(app);
      await new Promise((resolve, reject) => {
        const off = au.onAuthStateChanged(auth, user => {
          if(user){ off(); resolve(); }
          else au.signInAnonymously(auth).catch(err => { off(); reject(err); });
        });
      });
      fb = { fs, db, col: null };
    }
    if(unsub){ unsub(); unsub = null; }
    if(unsubFav){ unsubFav(); unsubFav = null; }
    fb.col = fb.fs.collection(fb.db, "families", code, "items");
    fb.favCol = fb.fs.collection(fb.db, "families", code, "favs");
    favs = [];
    unsubFav = fb.fs.onSnapshot(fb.favCol, snap => {
      favRulesMissing = false;
      favs = snap.docs.map(d => Object.assign({id: d.id}, cleanFav(d.data() || {})));
      render();
    }, err => {
      console.error(err);
      if(err && err.code === "permission-denied"){ favRulesMissing = true; setNotice("warn", FAV_RULES_MSG); }
    });
    mode = "cloud";
    let first = true;
    unsub = fb.fs.onSnapshot(fb.col, { includeMetadataChanges: true }, snap => {
      online = !snap.metadata.fromCache;
      items = snap.docs.map(d => Object.assign({id: d.id}, clean(d.data() || {})));
      if(online) favRulesMissing ? setNotice("warn", FAV_RULES_MSG) : setNotice();
      else setNotice("warn", "인터넷 연결이 없어요. 고친 내용은 휴대폰에 먼저 저장되고, 연결되면 가족에게 전달돼요.");
      first = false;
      render();
    }, err => {
      console.error(err);
      if(err && err.code === "permission-denied") setNotice("warn", "목록을 볼 권한이 없어요. Firebase 보안 규칙(설정방법.md 4단계)을 확인해 주세요.");
      else setNotice("warn", "목록을 불러오지 못했어요. 앱을 다시 열어 주세요.");
      render();
    });
  }catch(err){
    console.error(err);
    const offline = !navigator.onLine;
    startLocal(offline
      ? "인터넷이 연결되지 않아 가족 목록에 연결하지 못했어요. 연결 후 앱을 다시 열어 주세요."
      : "가족 목록에 연결하지 못했어요. (Firebase 설정과 익명 로그인 사용 설정을 확인해 주세요)");
  }
}

function startLocal(msg){
  mode = "local";
  items = lsLoad();
  favs = lsLoadFav();
  setNotice("warn", msg);
  render();
}

// ───── 화면 ─────
const $ = id => document.getElementById(id);
let filter = "all";
let query = "";

function setNotice(kind, text){
  $("notice").innerHTML = text ? '<div class="notice ' + (kind || "") + '">' + esc(text) + '</div>' : "";
}
function showSetup(on){
  $("setup").style.display = on ? "" : "none";
  $("main").style.display = on ? "none" : "";
  $("addBtn").style.display = on ? "none" : "";
}

function matches(it, q){
  if(!q) return true;
  q = q.toLowerCase();
  const c = CAT[it.cat];
  return [it.name, it.sub, c && c.name].some(v => v && String(v).toLowerCase().includes(q));
}
const isSoon = i => { const n = daysLeft(i.exp); return n !== null && n >= 0 && n <= 3; };
const isExpired = i => { const n = daysLeft(i.exp); return n !== null && n < 0; };
const isUrgent = i => isSoon(i) || isExpired(i);
function matchesFav(f, q){
  if(!q) return true;
  q = q.toLowerCase();
  const c = CAT[f.cat];
  return [f.name, f.sub, c && c.name].some(v => v && String(v).toLowerCase().includes(q));
}
function fmtDays(n){
  if(n >= 30 && n % 30 === 0) return (n / 30) + "달";
  if(n >= 7 && n % 7 === 0) return (n / 7) + "주";
  return n + "일";
}
const byExp = (a, b) => { const x = daysLeft(a.exp), y = daysLeft(b.exp); return (x === null ? 99999 : x) - (y === null ? 99999 : y) || (a.created - b.created); };

function render(){
  $("stats").innerHTML =
    '<button class="stat' + (filter==="all"?" on":"") + '" data-f="all"><b>' + items.length + '</b><span>전체 음식</span></button>' +
    '<button class="stat orange' + (filter==="soon"?" on":"") + '" data-f="soon"><b>' + items.filter(isSoon).length + '</b><span>3일 안에 먹기</span></button>' +
    '<button class="stat red' + (filter==="expired"?" on":"") + '" data-f="expired"><b>' + items.filter(isExpired).length + '</b><span>기한 지남</span></button>';

  const counts = {}; items.forEach(i => counts[i.cat] = (counts[i.cat] || 0) + 1);
  let chips = '<button class="chip' + (filter==="all"?" on":"") + '" data-f="all">전체</button>' +
    '<button class="chip' + (filter==="fav"?" on":"") + '" data-f="fav">⭐ 즐겨찾기<small>' + favs.length + '</small></button>';
  CATS.forEach(c => { if(counts[c.id]) chips += '<button class="chip' + (filter===c.id?" on":"") + '" data-f="' + c.id + '">' + c.icon + ' ' + esc(c.name) + '<small>' + counts[c.id] + '</small></button>'; });
  $("chips").innerHTML = chips;

  if(mode === "loading"){ $("list").innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
  if(filter === "fav"){ renderFavs(); return; }

  let list = items.filter(i => matches(i, query));
  if(filter === "soon") list = list.filter(isSoon);
  else if(filter === "expired") list = list.filter(isExpired);
  else if(filter !== "all") list = list.filter(i => i.cat === filter);

  if(!items.length){
    $("list").innerHTML = '<div class="empty"><div class="big">🥕</div><p>아직 냉장고가 비어 있어요.<br>아래 <b>＋ 음식 추가</b>를 눌러 산 음식을 적어보세요.</p></div>';
    return;
  }
  if(!list.length){
    $("list").innerHTML = query
      ? '<div class="empty"><div class="big">🤔</div><p>‘' + esc(query) + '’ 은(는) 냉장고에 없어요.</p></div>'
      : '<div class="empty"><p>해당하는 음식이 없어요.</p></div>';
    return;
  }

  let html = query ? '<div class="notice">‘' + esc(query) + '’ 검색 결과 ' + list.length + '개</div>' : "";

  // 기한 지났거나 3일 안에 먹어야 하는 건 맨 위로
  const showUrgent = filter === "all" || !!CAT[filter];
  const urgent = showUrgent ? list.filter(isUrgent).sort(byExp) : [];
  const rest = showUrgent ? list.filter(i => !isUrgent(i)) : list;
  if(urgent.length){
    const ex = urgent.filter(isExpired).length, so = urgent.length - ex;
    html += '<section class="cat urgent"><div class="cat-h"><h2>⚠️ 빨리 먹어야 해요</h2><span>' +
      [ex ? "기한 지남 " + ex + "개" : "", so ? "3일 이내 " + so + "개" : ""].filter(Boolean).join(" · ") + '</span></div><div class="sub">';
    urgent.forEach(i => html += itemRow(i, true));
    html += '</div></section>';
  }

  CATS.forEach(c => {
    const inCat = rest.filter(i => i.cat === c.id);
    if(!inCat.length) return;
    const total = inCat.reduce((s, i) => s + i.qty, 0);
    html += '<section class="cat"><div class="cat-h"><h2>' + c.icon + ' ' + esc(c.name) + '</h2><span>' + inCat.length + '종류 · 총 ' + total + '개</span></div>';

    // 소분류가 있으면 묶고, 없으면 그냥 나열
    const groups = {}, order = [], loose = [];
    inCat.forEach(i => {
      const k = i.sub.trim();
      if(!k){ loose.push(i); return; }
      if(!groups[k]){ groups[k] = []; order.push(k); }
      groups[k].push(i);
    });
    order.forEach(k => groups[k].sort(byExp));
    order.sort((a, b) => byExp(groups[a][0], groups[b][0]));
    order.forEach(k => {
      const g = groups[k];
      html += '<div class="sub"><div class="sub-h"><div>' + hl(k, query) + '</div><span>총 ' + g.reduce((s, i) => s + i.qty, 0) + '개</span></div>';
      g.forEach(i => html += itemRow(i));
      html += '</div>';
    });
    if(loose.length){
      html += '<div class="sub">';
      loose.sort(byExp).forEach(i => html += itemRow(i));
      html += '</div>';
    }
    html += '</section>';
  });
  $("list").innerHTML = html;
}

function renderFavs(){
  if(!favs.length){
    $("list").innerHTML = '<div class="empty"><div class="big">⭐</div><p>아직 즐겨찾기가 없어요.<br>자주 사는 음식을 눌러서 <b>☆ 즐겨찾기</b>를 켜면 여기에 모여요.<br>다음에 살 때 한 번에 넣을 수 있어요.</p></div>';
    return;
  }
  const fl = favs.filter(f => matchesFav(f, query))
    .map(f => Object.assign({stock: stockOf(f)}, f))
    .sort((a, b) => (a.stock > 0) - (b.stock > 0) || (a.name || a.sub).localeCompare(b.name || b.sub, "ko"));
  if(!fl.length){ $("list").innerHTML = '<div class="empty"><div class="big">🤔</div><p>‘' + esc(query) + '’ 은(는) 즐겨찾기에 없어요.</p></div>'; return; }
  const out = fl.filter(f => !f.stock).length;
  let html = '<div class="notice">' + (out ? '🛒 다 떨어진 음식 <b>' + out + '개</b>가 위에 있어요. 장 볼 때 보세요.' : '즐겨찾기한 음식이 다 냉장고에 있어요 👍') + '</div><div class="sub">';
  fl.forEach(f => {
    const c = CAT[f.cat];
    const title = f.name || f.sub;
    const meta = [c.icon + " " + c.name]; if(f.sub && f.name) meta.push(f.sub); if(f.days >= 0) meta.push("보통 " + fmtDays(f.days) + " 보관");
    html += '<div class="item"><div class="info" data-favbuy="' + esc(f.id) + '"><div class="name">' + hl(title, query) +
      (f.stock ? '<span class="badge b-green">' + f.stock + '개 있음</span>' : '<span class="badge b-red">다 떨어짐</span>') +
      '</div><div class="meta">' + esc(meta.join(" · ")) + '</div></div>' +
      '<div class="qty"><button class="buy" data-favbuy="' + esc(f.id) + '">＋ 샀어요</button><button class="star" data-unfav="' + esc(f.id) + '" aria-label="즐겨찾기 빼기">★</button></div></div>';
  });
  $("list").innerHTML = html + '</div>';
}

function itemRow(i, withCat){
  const title = i.name || i.sub || "(이름 없음)";
  const meta = [i.exp ? "유통기한 " + shortDate(i.exp) : "유통기한 미입력"];
  let catHtml = "";
  if(withCat){ const c = CAT[i.cat]; catHtml = esc(c.icon + " " + c.name) + (i.sub && i.name ? " · " + hl(i.sub, query) : "") + " · "; }
  if(i.buy) meta.push(shortDate(i.buy) + " 구입");
  return '<div class="item"><div class="info" data-edit="' + esc(i.id) + '"><div class="name">' + hl(title, query) + (isFav(i) ? '<span class="favmark" title="즐겨찾기">★</span>' : '') + badge(i.exp) + '</div><div class="meta">' + catHtml + esc(meta.join(" · ")) + '</div></div>' +
    '<div class="qty"><button data-q="-1" data-id="' + esc(i.id) + '" aria-label="하나 빼기">−</button><b>' + i.qty + '개</b><button data-q="1" data-id="' + esc(i.id) + '" aria-label="하나 더하기">＋</button></div></div>';
}

// ───── 창(모달) 관리 ─────
// 창을 열면 "뒤로 가기" 기록을 하나 넣어서, 휴대폰 뒤로 가기 버튼을 누르면 앱이 꺼지지 않고 창만 닫혀요.
const MODALS = ["formBg", "setBg", "askBg"];
let modalHistory = false;
const anyOpen = () => MODALS.some(id => $(id).classList.contains("open"));
function openModal(id){
  MODALS.forEach(m => { if(m !== id) $(m).classList.remove("open"); });
  $(id).classList.add("open");
  if(!modalHistory){ try{ history.pushState({fridgeModal: true}, ""); modalHistory = true; }catch(e){} }
}
function closeModal(id){
  $(id).classList.remove("open");
  if(id === "askBg") askFn = null;
  if(!anyOpen() && modalHistory){ modalHistory = false; try{ history.back(); }catch(e){} }
}
window.addEventListener("popstate", () => {
  modalHistory = false;
  MODALS.forEach(m => $(m).classList.remove("open"));
  askFn = null;
});

// ───── 입력 폼 ─────
let editingId = null;
let pickedCat = "fruit";
let favOn = false;
let origFavId = null;
function drawFavToggle(){
  $("favToggle").textContent = favOn ? "★ 즐겨찾기" : "☆ 즐겨찾기";
  $("favToggle").classList.toggle("on", favOn);
}
function drawFavPick(){
  const show = !editingId && favs.length;
  $("favField").style.display = show ? "" : "none";
  if(!show) return;
  const fl = favs.map(f => Object.assign({stock: stockOf(f)}, f))
    .sort((a, b) => (a.stock > 0) - (b.stock > 0) || (a.name || a.sub).localeCompare(b.name || b.sub, "ko")).slice(0, 16);
  $("favPick").innerHTML = fl.map(f => '<button type="button" data-fp="' + esc(f.id) + '">' + CAT[f.cat].icon + ' ' + esc(f.name || f.sub) + '</button>').join("");
}
function fillFromFav(f){
  pickedCat = f.cat;
  $("fSub").value = f.sub; $("fName").value = f.name; $("fQty").value = f.qty;
  if(!$("fBuy").value) $("fBuy").value = today();
  $("fExp").value = f.days >= 0 ? addDays($("fBuy").value, f.days) : "";
  favOn = true; drawFavToggle(); drawCatPick();
  $("fErr").textContent = "";
}

function drawCatPick(){
  $("catPick").innerHTML = CATS.map(c => '<button type="button" data-c="' + c.id + '" class="' + (pickedCat===c.id?"on":"") + '">' + c.icon + ' ' + esc(c.name) + '</button>').join("");
  drawSubPick();
}
// 소분류 추천: 기본 목록 + 이 분류에서 이미 쓴 소분류 (눌러서 바로 입력)
function drawSubPick(){
  const used = items.filter(i => i.cat === pickedCat && i.sub).map(i => i.sub.trim());
  const subs = Array.from(new Set(used.concat(CAT[pickedCat].subs))).slice(0, 14);
  const cur = $("fSub").value.trim();
  $("subPick").innerHTML = subs.map(s => '<button type="button" data-s="' + esc(s) + '" class="' + (cur===s?"on":"") + '">' + esc(s) + '</button>').join("");
}
function drawQuick(){
  $("quick").innerHTML = [["3일",3],["1주",7],["2주",14],["1달",30],["3달",90]]
    .map(([t, n]) => '<button type="button" data-d="' + n + '">산 날 + ' + t + '</button>').join("")
    + '<button type="button" data-d="clear">비우기</button>';
}
function openForm(id, favId){
  editingId = id || null;
  const it = id ? items.find(x => x.id === id) : null;
  $("formTitle").textContent = it ? "음식 정보 고치기" : "음식 추가";
  pickedCat = it ? it.cat : (CAT[filter] ? filter : pickedCat);
  $("fSub").value = it ? it.sub : "";
  $("fName").value = it ? it.name : "";
  $("fQty").value = it ? it.qty : 1;
  $("fBuy").value = it ? it.buy : today();
  $("fExp").value = it ? it.exp : "";
  $("fErr").textContent = "";
  $("delBtn").style.display = it ? "" : "none";
  origFavId = it && isFav(it) ? favIdOf(it) : null;
  favOn = !!origFavId;
  drawCatPick(); drawQuick(); drawFavToggle(); drawFavPick();
  const f = favId ? favs.find(x => x.id === favId) : null;
  if(f){ fillFromFav(f); $("favField").style.display = "none"; }
  $("form").scrollTop = 0;
  openModal("formBg");
}
const closeForm = () => closeModal("formBg");

$("form").addEventListener("submit", e => {
  e.preventDefault();
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur(); // 휴대폰 키보드 내리기
  const sub = $("fSub").value.trim();
  const name = $("fName").value.trim();
  const qty = Math.floor(Number($("fQty").value));
  const buy = $("fBuy").value;
  const exp = $("fExp").value;
  if(!sub && !name){ $("fErr").textContent = "소분류나 이름 중 하나는 적어주세요."; return; }
  if(!(qty >= 1)){ $("fErr").textContent = "개수는 1개 이상으로 적어주세요."; return; }
  const old = editingId ? items.find(x => x.id === editingId) : null;
  saveItem(editingId || newId(), {name, sub, cat: pickedCat, qty, buy, exp, created: old ? old.created : Date.now()});
  // 즐겨찾기 저장 / 빼기
  const nf = {name, sub, cat: pickedCat};
  if(favOn){
    let days = -1;
    if(exp){ const base = parse(buy) || parse(today()); days = Math.round((parse(exp) - base) / 86400000); if(days < 0) days = -1; }
    if(origFavId && origFavId !== favIdOf(nf)) removeFav(origFavId);
    saveFav(Object.assign({qty, days}, nf));
  } else if(origFavId){
    removeFav(origFavId);
  }
  closeForm();
  toast(old ? "고쳤어요" : "냉장고에 넣었어요 ✓");
});
$("cancelBtn").onclick = closeForm;
$("delBtn").onclick = () => {
  const id = editingId; const it = items.find(x => x.id === id); if(!it) return;
  ask("'" + (it.name || it.sub) + "' 을(를) 목록에서 지울까요?", "삭제", () => { removeItem(id); toast("지웠어요"); });
};
$("formBg").addEventListener("click", e => { if(e.target.id === "formBg") closeForm(); });
$("catPick").addEventListener("click", e => {
  const b = e.target.closest("[data-c]"); if(!b) return;
  pickedCat = b.dataset.c; drawCatPick();
});
$("subPick").addEventListener("click", e => {
  const b = e.target.closest("[data-s]"); if(!b) return;
  const v = b.dataset.s;
  $("fSub").value = ($("fSub").value.trim() === v) ? "" : v;  // 다시 누르면 지우기
  $("fErr").textContent = "";
  drawSubPick();
});
$("fSub").addEventListener("input", drawSubPick);
$("favToggle").onclick = () => { favOn = !favOn; drawFavToggle(); toast(favOn ? "저장하면 즐겨찾기에 들어가요" : "저장하면 즐겨찾기에서 빠져요"); };
$("favPick").addEventListener("click", e => {
  const b = e.target.closest("[data-fp]"); if(!b) return;
  const f = favs.find(x => x.id === b.dataset.fp); if(f) fillFromFav(f);
});
$("quick").addEventListener("click", e => {
  const b = e.target.closest("[data-d]"); if(!b) return;
  if(b.dataset.d === "clear"){ $("fExp").value = ""; return; }
  $("fExp").value = addDays($("fBuy").value || today(), Number(b.dataset.d));
});

// ───── 가족 코드 화면 ─────
$("newFamilyBtn").onclick = async () => {
  familyCode = makeCode(); saveCode(familyCode);
  showSetup(false);
  await connect(familyCode);
  openSettings();
  toast("새 냉장고를 만들었어요. 가족에게 링크를 보내주세요");
};
async function join(){
  const c = normCode($("joinInput").value);
  if(!validCode(c)){ $("joinErr").textContent = "코드가 맞지 않아요. 12글자인지 확인해 주세요."; return; }
  $("joinErr").textContent = "";
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
  familyCode = c; saveCode(c);
  showSetup(false);
  await connect(c);
  toast("가족 냉장고에 연결했어요 ✓");
}
$("joinBtn").onclick = join;
$("joinInput").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); join(); } });

// ───── 설정 ─────
function inviteLink(){ return location.origin + location.pathname + "?family=" + familyCode; }
const inviteText = () => "우리집 냉장고 같이 써요 👉 " + inviteLink();
function openSettings(){
  if(!configured){
    $("setStatus").innerHTML = '<b class="off">● 이 기기에만 저장 중</b> — firebase-config.js 를 채우면 가족과 함께 쓸 수 있어요.';
    $("setFamily").style.display = "none";
  } else {
    $("setStatus").innerHTML = mode === "cloud"
      ? (online ? '<b class="ok">● 가족 목록에 연결됨</b>' : '<b class="off">● 오프라인</b> — 연결되면 자동으로 맞춰져요')
      : '<b class="off">● 연결 안 됨</b>';
    const has = validCode(familyCode);
    $("setFamily").style.display = has ? "" : "none";
    $("setCode").textContent = has ? prettyCode(familyCode) : "";
    $("linkBox").value = has ? inviteLink() : "";
  }
  // 휴대폰이면 "카톡 등으로 보내기" 버튼 보이기
  $("shareBtn").style.display = (navigator.share ? "" : "none");
  openModal("setBg");
}
async function copy(text, okMsg){
  try{ await navigator.clipboard.writeText(text); toast(okMsg); return; }catch(e){}
  // 예전 방식으로 한 번 더 시도
  try{
    const t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); document.body.removeChild(t);
    if(ok){ toast(okMsg); return; }
  }catch(e){}
  $("linkBox").focus(); $("linkBox").select();
  toast("복사가 안 돼요. 아래 링크를 길게 눌러 복사해 주세요");
}
$("gearBtn").onclick = openSettings;
$("setClose").onclick = () => closeModal("setBg");
$("setBg").addEventListener("click", e => { if(e.target.id === "setBg") closeModal("setBg"); });
$("shareBtn").onclick = async () => {
  try{ await navigator.share({ title: "우리집 냉장고", text: "우리집 냉장고 같이 써요 👉", url: inviteLink() }); }
  catch(e){ if(e && e.name !== "AbortError") copy(inviteText(), "초대 링크를 복사했어요"); }
};
$("copyLinkBtn").onclick = () => copy(inviteText(), "초대 링크를 복사했어요");
$("copyCodeBtn").onclick = () => copy(prettyCode(familyCode), "코드를 복사했어요");
$("linkBox").addEventListener("focus", e => e.target.select());
$("switchBtn").onclick = () => {
  ask("지금 냉장고 연결을 끊고 다른 가족 코드를 넣을까요? (지금 목록은 지워지지 않아요)", "바꾸기", () => {
    if(unsub){ unsub(); unsub = null; }
    if(unsubFav){ unsubFav(); unsubFav = null; }
    try{ localStorage.removeItem(FAMILY_KEY); }catch(e){}
    familyCode = ""; items = []; favs = []; mode = "loading";
    $("joinInput").value = ""; $("joinErr").textContent = "";
    showSetup(true);
  });
};

// ───── 확인 창 ─────
let askFn = null;
function ask(text, yesLabel, fn){
  $("askText").textContent = text; $("askYes").textContent = yesLabel || "확인";
  openModal("askBg");
  askFn = fn;
}
$("askNo").onclick = () => closeModal("askBg");
$("askYes").onclick = () => { const f = askFn; closeModal("askBg"); if(f) f(); };
$("askBg").addEventListener("click", e => { if(e.target.id === "askBg") closeModal("askBg"); });

// ───── 토스트 ─────
let tt = null;
function toast(t){ const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("show"), 2000); }

// ───── 공통 이벤트 ─────
$("addBtn").onclick = () => openForm(null);
$("q").addEventListener("input", e => { query = e.target.value.trim(); $("qx").style.display = query ? "block" : "none"; render(); });
$("q").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); e.target.blur(); } });
$("qx").onclick = () => { $("q").value = ""; query = ""; $("qx").style.display = "none"; render(); };
document.addEventListener("click", e => {
  const f = e.target.closest("[data-f]");
  if(f){ filter = (filter === f.dataset.f && f.dataset.f !== "all") ? "all" : f.dataset.f; render(); return; }
  const q = e.target.closest("[data-q]");
  if(q){ bumpQty(q.dataset.id, Number(q.dataset.q)); return; }
  const fb2 = e.target.closest("[data-favbuy]");
  if(fb2){ openForm(null, fb2.dataset.favbuy); return; }
  const uf = e.target.closest("[data-unfav]");
  if(uf){ const f = favs.find(x => x.id === uf.dataset.unfav); if(f) ask("'" + (f.name || f.sub) + "' 을(를) 즐겨찾기에서 뺄까요? (냉장고 목록은 그대로예요)", "빼기", () => { removeFav(f.id); toast("즐겨찾기에서 뺐어요"); }); return; }
  const ed = e.target.closest("[data-edit]");
  if(ed) openForm(ed.dataset.edit);
});
document.addEventListener("keydown", e => { if(e.key === "Escape"){ MODALS.forEach(m => { if($(m).classList.contains("open")) closeModal(m); }); } });
// 자정이 지나면 D-day 다시 계산
setInterval(render, 60 * 60 * 1000);

render();
start();
