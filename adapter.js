/* Fish Tracker — Supabase adapter.
   Provides window.claude.use("db" | "user" | "downloads") with the same small API the app
   was written against, backed by Supabase (database, email login, live updates).
   Also handles sign-in, membership and an offline write queue. */
(function(){
"use strict";
const SB_URL = "https://xleqhjbrevfazjvramrj.supabase.co";
const SB_KEY = "sb_publishable_axr7UrlWIP3vi0gWJnbbUA_Ln-_FAd3";
const APP_BASE = location.origin + location.pathname;
// Cloudflare Turnstile "I'm not a robot" check on the sign-in page. Empty = off.
// The site key is public. Turn CAPTCHA on in Supabase (Authentication › Attack Protection) only AFTER this is filled in.
const TURNSTILE_SITE_KEY = "";

/* ---------- shared-computer mode ----------
   On a shared computer the sign-in and the offline copy of the data live in sessionStorage
   (wiped when the browser closes) instead of localStorage, and the app signs out after 30 min idle. */
const SHARED_KEY = "ft-shared", IDLE_MIN = 30;
const isShared = () => { try { return localStorage.getItem(SHARED_KEY) === "1"; } catch(e){ return false; } };
const store = () => { try { return isShared() ? sessionStorage : localStorage; } catch(e){ return null; } };
const authStorage = {
  getItem: k => { try { return store().getItem(k); } catch(e){ return null; } },
  setItem: (k, v) => { try { store().setItem(k, v); } catch(e){} },
  removeItem: k => { try { localStorage.removeItem(k); } catch(e){} try { sessionStorage.removeItem(k); } catch(e){} }
};
function setShared(on){
  const from = on ? localStorage : sessionStorage, to = on ? sessionStorage : localStorage;
  try {
    for (const k of Object.keys(from)) if (/^(sb-|ft-cache|ft-queue|ft-role|ft-email)/.test(k)) { to.setItem(k, from.getItem(k)); from.removeItem(k); }
    if (on) localStorage.setItem(SHARED_KEY, "1"); else localStorage.removeItem(SHARED_KEY);
  } catch(e){}
  if (on) startIdleTimer();
}
let idleTimer = null, lastActive = Date.now();
function startIdleTimer(){
  if (idleTimer) return;
  ["pointerdown","keydown","touchstart","scroll"].forEach(ev => window.addEventListener(ev, ()=>{ lastActive = Date.now(); }, { passive:true }));
  idleTimer = setInterval(()=>{ if (isShared() && me && Date.now() - lastActive > IDLE_MIN*60000) user.signOut(true); }, 30000);
}

const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:"implicit", storage:authStorage } });
window.__sb = sb;

/* ---------- field maps (app name → column) ---------- */
const MAPS = {
  fish: { table:"stocks", f:{ legacyId:"legacy_id", stock:"stock", line:"line", name:"name", category:"category", common:"common", generation:"generation", zygosity:"zygosity", parentId:"parent_id", parent2Id:"parent2_id", parentNote:"parent_note", fromCrossId:"from_cross_id", finClipped:"fin_clipped", finClipDate:"fin_clip_date", finClipN:"fin_clip_n", closedReason:"closed_reason", tankPlaces:"tank_places", mergedInto:"merged_into", pplProtocol:"ppl_protocol", genoboxSince:"genobox_since", labId:"lab_id", partnerLabs:"partner_labs", sharedFloor:"shared_floor", availability:"availability", shareContact:"share_contact", zfin:"zfin", background:"background", closedDate:"closed_date", closedNote:"closed_note", room:"room", location:"location", fertDate:"fert_date", pil:"pil", ppl:"ppl", severity:"severity", count:"count", females:"females", males:"males", keepers:"keepers", fluors:"fluors", fluorNote:"fluor_note", comments:"comments", status:"status", prevStatus:"prev_status", deletedAt:"deleted_at", deletedBy:"deleted_by", createdAt:"created_at", createdBy:"created_by", updatedAt:"updated_at" } },
  breedings: { table:"crosses", f:{ legacyId:"legacy_id", fishId:"stock_id", fishId2:"stock2_id", stock:"stock_label", stock2:"stock2_label", sameStock:"same_stock", partner:"partner", date:"date", crossType:"cross_type", success:"success", eggs:"eggs", fertRate:"fert_rate", quality:"quality", use:"use", notes:"notes", planId:"plan_id", labId:"lab_id", deleted:"deleted", deletedAt:"deleted_at", deletedBy:"deleted_by", by:"by", createdAt:"created_at" } },
  plans: { table:"plans", f:{ legacyId:"legacy_id", fishId:"stock_id", fishId2:"stock2_id", stock:"stock_label", stock2:"stock2_label", sameStock:"same_stock", partner:"partner", date:"date", crossType:"cross_type", note:"note", facility:"facility", labId:"lab_id", status:"status", doneDate:"done_date", doneBy:"done_by", cancelledBy:"cancelled_by", by:"by", createdAt:"created_at" } },
  events: { table:"events", f:{ legacyId:"legacy_id", fishId:"stock_id", stock:"stock_label", date:"date", type:"type", n:"n", sex:"sex", actualSeverity:"actual_severity", before:"before", after:"after", ppl:"ppl", note:"note", details:"details", labId:"lab_id", by:"by", createdAt:"created_at" } },
  licences: { table:"licences", f:{ ppl:"ppl", title:"title", holder:"holder", expires:"expires", labId:"lab_id", createdAt:"created_at" } },
  log: { table:"history", f:{ fishId:"stock_id", action:"action", changes:"changes", note:"note", at:"at", by:"by" } }
};
const COL2APP = {}; for (const k in MAPS){ COL2APP[k] = Object.fromEntries(Object.entries(MAPS[k].f).map(([a,c])=>[c,a])); }
const TABLE2COLL = Object.fromEntries(Object.entries(MAPS).map(([k,v])=>[v.table,k]));
const DATE_COLS = new Set(["genobox_since","expires","closed_date","fin_clip_date","fert_date","date","done_date","regen_date"]);
const UUID_COLS = new Set(["share_contact","merged_into","parent_id","parent2_id","from_cross_id","stock_id","stock2_id","plan_id","by","created_by","deleted_by","done_by","cancelled_by"]);
const INT_COLS = new Set(["tank_places","fin_clip_n","count","females","males","eggs","quality","n","before","after"]);
const isUuid = v => typeof v==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

function toRow(coll, data){
  const m = MAPS[coll].f, row = {};
  for (const [k,v] of Object.entries(data||{})){
    if (coll==="fish" && k==="regen"){ row.regen_date = (v && v.date) || null; row.regen_new_stock = (v && v.newStock) || null; continue; }
    const c = m[k]; if (!c) continue;
    let val = v;
    if (DATE_COLS.has(c) && !val) val = null;
    if (UUID_COLS.has(c) && !isUuid(val)) val = null;
    if (INT_COLS.has(c)) val = (val===""||val==null||isNaN(+val)) ? null : Math.round(+val);
    if (c==="fert_rate") val = (val===""||val==null||isNaN(+val)) ? null : +val;
    if (c==="keepers" || c==="partner_labs") val = (Array.isArray(val)?val:[]).filter(isUuid);
    if (c==="lab_id") continue;                       // set by the adapter on new records only
    if (c==="shared_floor") val = !!val;
    if (c==="fluors") val = Array.isArray(val)?val:[];
    if (c==="sex" && val==null) val = "";
    if (c==="fin_clipped") val = !!val;
    if (c==="details") val = (val && typeof val==="object") ? val : {};
    row[c] = val;
  }
  return row;
}
const FISH_C2A = Object.assign({}, COL2APP.fish, { regen_date:"regenDate", regen_new_stock:"regenNewStock" });
function fromRow(coll, r){
  const out = {};
  for (const [a,c] of Object.entries(MAPS[coll].f)) if (c in r) out[a] = r[c];
  if (coll==="fish") out.regen = r.regen_date ? { date:r.regen_date, newStock:r.regen_new_stock||"" } : null;
  if (coll==="log" && r.changes){ const ch={}; for (const [k,v] of Object.entries(r.changes)) ch[FISH_C2A[k]||k] = v; out.changes = ch; }
  return out;
}

/* ---------- errors ---------- */
const isNetErr = e => !!e && (e instanceof TypeError || /fetch|network|Failed to fetch|Load failed/i.test(String(e.message||e)));
function mapErr(e){
  if (isNetErr(e)) return { code:"unavailable", message:String(e.message||e) };
  const c = e && e.code;
  if (c==="42501" && e.message && !/permission denied|row-level security/i.test(e.message)) return { code:"rule", message:e.message };   // a lab rule, e.g. owner protection
  if (c==="42501" || c==="PGRST301" || c==="denied") return { code:"invalid_argument", message:"Not allowed" };
  if (c==="23505") return { code:"invalid_argument", message:"Duplicate" };
  return { code:"unavailable", message:(e && e.message) || "Error" };
}

/* ---------- local cache + offline queue ---------- */
const CACHE_KEY = "ft-cache-v1", Q_KEY = "ft-queue-v1";
const ls = { get(k){ try { return JSON.parse(store().getItem(k)||"null"); } catch(e){ return null; } }, set(k,v){ try { store().setItem(k, JSON.stringify(v)); } catch(e){} } };
const cache = ls.get(CACHE_KEY) || {};           // table -> rows
const subs = {};                                  // coll -> [cb]
let queue = ls.get(Q_KEY) || [];
function saveCache(){ ls.set(CACHE_KEY, cache); }

/* ---------- labs ----------
   MULTI = the database has labs (update 11). Each person works in one lab at a time (curLab);
   the database only returns what they may see, and the app shows the current lab's part of it. */
let MULTI = false, curLab = null, access = { floor_admin:false, labs:[] };
const LAB_TABLES = new Set(["stocks","crosses","plans","events","licences"]);
function labFilter(table, rows){
  if (!MULTI || !curLab) return rows;
  if (table==="stocks") return rows.filter(r=>r.lab_id===curLab || (r.partner_labs||[]).includes(curLab));
  if (table==="licences") return rows.filter(r=>r.lab_id===curLab);
  if (table==="crosses" || table==="plans" || table==="events"){
    const mine = new Set(labFilter("stocks", cache.stocks||[]).map(r=>r.id));
    return rows.filter(r=>r.lab_id===curLab || mine.has(r.stock_id) || mine.has(r.stock2_id));
  }
  return rows;
}
const withLab = (table, row) => (MULTI && curLab && LAB_TABLES.has(table)) ? { ...row, lab_id:curLab } : row;
function snapOf(coll, rows, fromCache){
  rows = labFilter(MAPS[coll].table, rows);
  const docs = rows.map(r=>{ const d = fromRow(coll, r); return { id:r.id, exists:true, data:()=>d, metadata:{fromCache, hasPendingWrites:false} }; });
  return { docs, size:docs.length, empty:!docs.length, docChanges:()=>[], metadata:{fromCache, hasPendingWrites:queue.length>0} };
}
function notify(coll, fromCache){ const t=MAPS[coll].table; (subs[coll]||[]).forEach(cb=>{ try { cb(snapOf(coll, cache[t]||[], fromCache)); } catch(e){ console.error(e); } }); }

async function fetchAll(table, filters){
  let all = [], from = 0, size = 1000;
  for (;;){
    let q = sb.from(table).select("*").range(from, from+size-1).order("id");
    for (const [c,v] of (filters||[])) q = q.eq(c, v);
    const { data, error } = await q;
    if (error) throw error;
    all = all.concat(data); if (data.length < size) break; from += size;
  }
  return all;
}
const timers = {};
function refresh(coll, delay=250){
  clearTimeout(timers[coll]);
  timers[coll] = setTimeout(async ()=>{
    const t = MAPS[coll].table;
    try { cache[t] = await fetchAll(t); saveCache(); notify(coll, false); if (t==="stocks") ["breedings","plans","events"].forEach(c=>{ if (subs[c] && cache[MAPS[c].table]) notify(c, false); }); setStatus(queue.length ? "Saving changes…" : null); }
    catch(e){ notify(coll, false); if (isNetErr(e)) setStatus("Offline: showing the last saved copy"); }
  }, delay);
}
function applyLocal(table, kind, id, row){
  const rows = cache[table] = cache[table] || [];
  const i = rows.findIndex(r=>r.id===id);
  if (kind==="insert" || kind==="upsert"){ if (i>=0) rows[i] = {...rows[i], ...row}; else rows.push({...row, id}); }
  else if (kind==="update"){ if (i>=0) rows[i] = {...rows[i], ...row}; }
  else if (kind==="delete"){ if (i>=0) rows.splice(i,1); }
  saveCache(); const coll = TABLE2COLL[table]; if (coll) notify(coll, false);
}
async function runOp(op){
  const q = sb.from(op.table);
  let res;
  if (op.kind==="insert") res = await q.insert({ ...op.row, id:op.id }).select("id");
  else if (op.kind==="upsert") res = await q.upsert({ ...op.row, id:op.id }).select("id");
  else if (op.kind==="update") res = await q.update(op.row).eq("id", op.id).select("id");
  else if (op.kind==="delete") res = await q.delete().eq("id", op.id).select("id");
  if (res.error) throw res.error;
  if ((op.kind==="update"||op.kind==="delete") && (!res.data || !res.data.length)) throw { code:"denied" };
}
async function write(op){
  try { await runOp(op); applyLocal(op.table, op.kind, op.id, op.row); refresh(TABLE2COLL[op.table]); }
  catch(e){
    if (isNetErr(e)){ queue.push(op); ls.set(Q_KEY, queue); applyLocal(op.table, op.kind, op.id, op.row); setStatus("Offline: changes saved on this device, they'll sync when you're back online"); return; }
    throw mapErr(e);
  }
}
let flushing = false;
async function flushQueue(){
  if (flushing || !queue.length) return; flushing = true;
  try {
    while (queue.length){
      const op = queue[0];
      try { await runOp(op); }
      catch(e){ if (isNetErr(e)) break; console.warn("Dropped a queued change that the server refused", op, e); }
      queue.shift(); ls.set(Q_KEY, queue);
    }
    if (!queue.length){ setStatus(null); Object.keys(MAPS).forEach(c=>{ if (subs[c]) refresh(c); }); }
  } finally { flushing = false; }
}
window.addEventListener("online", flushQueue);
setInterval(flushQueue, 30000);

/* ---------- db API ---------- */
function docRef(coll, id){
  const t = MAPS[coll].table;
  return {
    id, path: coll+"/"+id,
    async get(){ const { data, error } = await sb.from(t).select("*").eq("id", id).maybeSingle(); if (error) throw mapErr(error); return { id, exists:!!data, data:()=>data?fromRow(coll,data):undefined, metadata:{fromCache:false} }; },
    async set(d){ if (coll==="log") return; const ex = (cache[t]||[]).some(r=>r.id===id); await write({ table:t, kind:"upsert", id, row: ex ? toRow(coll, d) : withLab(t, toRow(coll, d)) }); },
    async update(d){ if (coll==="log") return; await write({ table:t, kind:"update", id, row:toRow(coll, d) }); },
    async delete(){ if (coll==="log") return; await write({ table:t, kind:"delete", id }); },
    onSnapshot(cb){ return collection(coll).onSnapshot(s=>{ const d=s.docs.find(x=>x.id===id); cb(d || {id, exists:false, data:()=>undefined, metadata:s.metadata}); }); }
  };
}
function query(coll, filters){
  const m = MAPS[coll], t = m.table;
  return {
    where(f, op, v){ return query(coll, [...filters, [m.f[f]||f, v]]); },
    orderBy(){ return this; }, limit(){ return this; },
    async get(){ try { return snapOf(coll, await fetchAll(t, filters), false); } catch(e){ const rows=(cache[t]||[]).filter(r=>filters.every(([c,v])=>r[c]===v)); if (isNetErr(e)) return snapOf(coll, rows, true); throw mapErr(e); } },
    onSnapshot(cb, err){
      (subs[coll] = subs[coll] || []).push(cb);
      if (cache[t]) setTimeout(()=>{ try { cb(snapOf(coll, cache[t], true)); } catch(e){} }, 0);
      refresh(coll, 0); ensureRealtime();
      return ()=>{ subs[coll] = (subs[coll]||[]).filter(x=>x!==cb); };
    }
  };
}
function collection(coll){
  if (!MAPS[coll]) throw new TypeError("Unknown collection "+coll);
  const q = query(coll, []);
  return Object.assign(q, {
    path: coll,
    doc(id){ return docRef(coll, id || uuid()); },
    async add(d){ if (coll==="log") return { id:null }; const id = uuid(); await write({ table:MAPS[coll].table, kind:"insert", id, row:withLab(MAPS[coll].table, toRow(coll, d)) }); return { id }; }
  });
}
/* settings: one row, stored as JSON */
const settingsSubs = [];
const settingsQ = () => MULTI ? sb.from("lab_settings").select("data").eq("lab_id", curLab) : sb.from("settings").select("data").eq("id",1);
async function loadSettings(){
  try { const { data, error } = await settingsQ().maybeSingle(); if (error) throw error; cache.__settings = (data && data.data) || {}; saveCache(); }
  catch(e){}
  settingsSubs.forEach(cb=>cb({ id:"settings", exists:true, data:()=>cache.__settings||{}, metadata:{fromCache:false} }));
}
const settingsDoc = {
  onSnapshot(cb){ settingsSubs.push(cb); if (cache.__settings) setTimeout(()=>cb({ id:"settings", exists:true, data:()=>cache.__settings, metadata:{fromCache:true} }),0); loadSettings(); ensureRealtime(); return ()=>{}; },
  async set(d){ const upd = { data:d, updated_at:new Date().toISOString() }; const { data, error } = await (MULTI ? sb.from("lab_settings").update(upd).eq("lab_id", curLab).select("lab_id") : sb.from("settings").update(upd).eq("id",1).select("id")); if (error) throw mapErr(error); if (!data || !data.length) throw { code:"invalid_argument", message:"Only lab admins can change the thresholds." }; cache.__settings = d; loadSettings(); },
  async get(){ await loadSettings(); return { exists:true, data:()=>cache.__settings||{} }; }
};
const db = {
  collection,
  isUuid, uuid,
  async bulk(coll, items, onProgress){            // items: [{id, data}] — upsert in chunks
    const t = MAPS[coll].table; let done = 0;
    for (let i=0; i<items.length; i+=200){
      const rows = items.slice(i, i+200).map(it=>({ ...withLab(t, toRow(coll, it.data)), id:it.id }));
      const { error } = await sb.from(t).upsert(rows);
      if (error) throw mapErr(error);
      done += rows.length; onProgress && onProgress(done);
    }
    refresh(coll, 100);
  },
  doc(path){ if (path==="config/settings") return settingsDoc; const [c,id] = path.split("/"); return docRef(c, id); }
};
let rt = null;
function ensureRealtime(){
  if (rt) return;
  rt = sb.channel("lab-db")
    .on("postgres_changes", { event:"*", schema:"public" }, p=>{
      if (p.table==="settings" || p.table==="lab_settings") return loadSettings();
      if (p.table==="requests" || p.table==="labs"){ window.dispatchEvent(new Event("ft-floor")); return; }
      if (p.table==="members"){ loadMembers(); return; }
      const coll = TABLE2COLL[p.table]; if (coll && subs[coll] && subs[coll].length) refresh(coll, 400);
    })
    .subscribe();
  setInterval(()=>{ Object.keys(subs).forEach(c=>{ if (subs[c].length) refresh(c); }); loadSettings(); }, 120000);
}

/* ---------- people ---------- */
let me = null, myRole = null, members = [];
const COLORS = ["#1d5fa6","#2a7348","#9a5c00","#8e1b3f","#5a3fa0","#0f7b8a","#b83226","#4b6cff"];
function initialsAvatar(name, id){
  const ini = (name||"?").split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(s=>s[0].toUpperCase()).join("") || "?";
  let h=0; for (const ch of String(id||name)) h=(h*31+ch.charCodeAt(0))>>>0; const col = COLORS[h%COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${col}"/><text x="32" y="41" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${ini.replace(/[<&>]/g,"")}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
const nameOfMember = m => (m && (m.display_name || (m.email||"").split("@")[0])) || "";
const extraNames = {};
async function loadMembers(){
  try { let q = sb.from("members").select("*").order("created_at"); if (MULTI) q = q.eq("lab_id", curLab); const { data, error } = await q; if (!error) { members = data; cache.__members = data; saveCache(); } }
  catch(e){ members = cache.__members || []; }
  window.dispatchEvent(new Event("ft-members"));
  return members;
}
function profile(id){
  const m = members.find(x=>x.user_id===id);
  const name = nameOfMember(m) || extraNames[id] || "";
  return { id, name, avatarUrl: initialsAvatar(name || "?", id), color:"", email: m ? m.email : null, isMe: id===(me&&me.id), guest:false };
}
const user = {
  async id(){ return me ? me.id : null; },
  async me(){ const p = profile(me && me.id); return { ...p, isOwner: myRole==="owner", canEdit: myRole==="owner"||myRole==="admin" }; },
  async isOwner(){ return myRole==="owner"; },
  async canEdit(){ return myRole==="owner" || myRole==="admin"; },
  async can(c){ if (c==="data.write") return ["owner","admin","member"].includes(myRole); return false; },
  async profiles(ids){ if (!members.length) await loadMembers();
    const miss = [].concat(ids).filter(id=>isUuid(id) && !members.some(m=>m.user_id===id) && !(id in extraNames));
    if (MULTI && miss.length){ try { const { data } = await sb.rpc("people_names", { p_ids:miss }); (data||[]).forEach(r=>{ extraNames[r.user_id] = r.name; }); miss.forEach(id=>{ if (!(id in extraNames)) extraNames[id] = ""; }); } catch(e){} }
    const out={}; for (const id of [].concat(ids)) out[id]=profile(id); return out; },
  async search(q){ if (!members.length) await loadMembers(); q=(q||"").toLowerCase(); return members.filter(m=>!q || (nameOfMember(m)+" "+m.email).toLowerCase().includes(q)).slice(0,8).map(m=>profile(m.user_id)); },
  async name(){ return profile(me && me.id).name; },
  // extras for the members screen
  role(){ return myRole; }, email(){ return me && me.email; }, list(){ return members; }, reload: loadMembers,
  me_row(){ return members.find(m=>m.user_id===(me&&me.id)) || {}; },
  async setMyPrefs(email, push, all){ const { error } = await sb.rpc("set_my_prefs", MULTI ? { p_email:!!email, p_push:!!push, p_all:!!all, p_lab:curLab } : { p_email:!!email, p_push:!!push, p_all:!!all }); if (error) throw mapErr(error); await loadMembers(); },
  async setDigestAll(uid, on){ let q = sb.from("members").update({ digest_all:!!on }).eq("user_id", uid); if (MULTI) q = q.eq("lab_id", curLab); const { data, error } = await q.select("user_id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); await loadMembers(); },
  async savePush(sub){ const j = sub.toJSON(); const { error } = await sb.from("push_subscriptions").upsert({ endpoint:j.endpoint, keys:j.keys, user_id:me.id }); if (error) throw mapErr(error); },
  async removePush(endpoint){ await sb.from("push_subscriptions").delete().eq("endpoint", endpoint); },
  vapidKey: "BEZh01vmDTiZ9GyrN25P48Ojqn3HMPUH0ynIt-hylvROMu3QO2XARkBES5M4TAOWDciF9vmEQd4PiIG_IuJiMdU",
  async setMyName(n){ const { error } = await sb.rpc("set_my_name", { p_name:n }); if (error) throw mapErr(error); await loadMembers(); },
  async invites(lab){ let q = sb.from("invites").select("*").order("created_at"); if (MULTI) q = q.eq("lab_id", lab||curLab); const { data, error } = await q; if (error) return []; return data; },
  async invite(email, role, lab){ const row = { email:String(email).trim().toLowerCase(), role }; if (MULTI) row.lab_id = lab||curLab; const { error } = await sb.from("invites").upsert(row); if (error) throw mapErr(error); },
  async cancelInvite(email, lab){ let q = sb.from("invites").delete().eq("email", email); if (MULTI) q = q.eq("lab_id", lab||curLab); const { error } = await q; if (error) throw mapErr(error); },
  async setRole(uid, role, lab){ let q = sb.from("members").update({ role }).eq("user_id", uid); if (MULTI) q = q.eq("lab_id", lab||curLab); const { data, error } = await q.select("user_id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); await loadMembers(); },
  async remove(uid, lab){ let q = sb.from("members").delete().eq("user_id", uid); if (MULTI) q = q.eq("lab_id", lab||curLab); const { data, error } = await q.select("user_id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); await loadMembers(); },
  // ----- labs & the fish floor -----
  multi(){ return MULTI; },
  labs(){ return access.labs; },
  lab(){ return access.labs.find(l=>l.id===curLab) || null; },
  isFloorAdmin(){ return !!access.floor_admin; },
  switchLab(id){ if (!access.labs.some(l=>l.id===id)) return; ls.set("ft-lab", id); delete cache.__settings; delete cache.__members; saveCache(); location.replace(APP_BASE); },
  async allLabs(){ const { data, error } = await sb.from("labs").select("*").order("name"); if (error) throw mapErr(error); return data; },
  async createLab(name){ const { data, error } = await sb.from("labs").insert({ name:String(name).trim().slice(0,60) }).select("id"); if (error) throw mapErr(error); return data[0].id; },
  async renameLab(id, name){ const { error } = await sb.from("labs").update({ name:String(name).trim().slice(0,60) }).eq("id", id); if (error) throw mapErr(error); },
  async floorMembers(){ const { data, error } = await sb.from("members").select("lab_id,user_id,email,display_name,role,created_at").order("created_at"); if (error) throw mapErr(error); return data; },
  async floorInvites(){ const { data, error } = await sb.from("invites").select("*").order("created_at"); if (error) throw mapErr(error); return data; },
  async library(){ const { data, error } = await sb.rpc("floor_library"); if (error) throw mapErr(error); return data||[]; },
  async requests(){ const { data, error } = await sb.from("requests").select("*").order("created_at", { ascending:false }).limit(500); if (error) throw mapErr(error); return (data||[]).filter(r=>r.from_lab===curLab || r.to_lab===curLab); },
  async request(r){ const { error } = await sb.from("requests").insert({ from_lab:curLab, to_lab:r.toLab, stock_id:isUuid(r.stockId)?r.stockId:null, line_name:r.line, wants:r.wants||"", message:r.message||"" }); if (error) throw mapErr(error); },
  async answerRequest(id, status, reply){ const { data, error } = await sb.from("requests").update({ status, reply:reply||null }).eq("id", id).select("id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); },
  async cancelRequest(id){ const { data, error } = await sb.from("requests").update({ status:"cancelled" }).eq("id", id).select("id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); },
  isShared, setShared,
  async labLog(limit){ let q = sb.from("history").select("*").is("stock_id", null); if (MULTI) q = q.eq("lab_id", curLab); const { data, error } = await q.order("at", { ascending:false }).limit(limit||200); if (error) throw mapErr(error); return data; },
  async allHistory(){ const out=[]; for (let from=0; from<50000; from+=1000){ let q = sb.from("history").select("*"); if (MULTI) q = q.eq("lab_id", curLab); const { data, error } = await q.order("at", { ascending:false }).range(from, from+999); if (error) throw mapErr(error); out.push(...data); if (data.length<1000) break; } return out; },
  async signOut(idle){
    if (!idle && queue.length && !confirm(`${queue.length} change${queue.length>1?"s":""} made offline haven't reached the database yet. Signing out now deletes ${queue.length>1?"them":"it"}. Sign out anyway?`)) return;
    try { await sb.auth.signOut({ scope:"local" }); } catch(e){}
    const wipe = st => { try { for (const k of Object.keys(st)) if (/^(sb-|ft-cache|ft-queue|ft-role)/.test(k) || (isShared() && k==="ft-email")) st.removeItem(k); } catch(e){} };
    wipe(localStorage); wipe(sessionStorage);
    location.replace(APP_BASE + (idle ? "#signed-out-idle" : ""));
  }
};

/* ---------- downloads (real browser download) ---------- */
const MIME = { csv:"text/csv;charset=utf-8", json:"application/json", pdf:"application/pdf" };
const downloads = {
  async save({ filename, data }){
    const ext = (filename.split(".").pop()||"").toLowerCase();
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || "application/octet-stream" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return { status:"saved" };
  }
};

/* ---------- status line ---------- */
function setStatus(t){ const el = document.getElementById("sync"); if (!el) return; if (t) el.textContent = t; else if (/Offline|Saving/.test(el.textContent)) el.textContent = "Shared with your lab · live"; }

/* ---------- sign-in gate ---------- */
let resolveReady; const ready = new Promise(r=>resolveReady=r);
window.claude = { use: async (name)=>{ await ready; return name==="db" ? db : name==="user" ? user : name==="downloads" ? downloads : null; } };

function gate(html){
  let el = document.getElementById("gate");
  if (!el){ el = document.createElement("div"); el.id = "gate"; document.body.appendChild(el); document.body.classList.add("locked"); }
  el.innerHTML = `<div class="gate-card"><div class="gate-brand"><svg width="40" height="40" viewBox="0 0 34 34" aria-hidden="true"><defs><clipPath id="gc"><path d="M3 17c5-8 15-10 22-5l6-5v20l-6-5c-7 5-17 3-22-5z"/></clipPath></defs><g clip-path="url(#gc)"><rect width="34" height="34" fill="#e9eef5"/><rect y="11.5" width="34" height="2.2" fill="#1d5fa6"/><rect y="15.9" width="34" height="2.2" fill="#1d5fa6"/><rect y="20.3" width="34" height="2.2" fill="#1d5fa6"/></g><circle cx="8.5" cy="15.5" r="1.3" fill="#15202b"/></svg><h1>Zebrafish Stock Tracker</h1></div>${html}</div>`;
  return el;
}
function closeGate(){ const el = document.getElementById("gate"); if (el) el.remove(); document.body.classList.remove("locked"); }
const escH = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function showLogin(msg){
  const el = gate(`<p class="gate-sub">Sign in with your email. We'll send you a code — no password needed.</p>
    <form id="g-email" class="gate-form"><label for="g-e">Email</label><input id="g-e" type="email" required autocomplete="email" placeholder="name@ucl.ac.uk" value="${escH(ls.get("ft-email")||"")}">
      <label class="gate-check"><input type="checkbox" id="g-shared" ${isShared()?"checked":""}> This is a shared computer <small>(signs out when the browser closes or after ${IDLE_MIN} min without use; keeps no copy of the data)</small></label>
      ${TURNSTILE_SITE_KEY ? `<div id="g-cap"></div>` : ""}
      <button class="btn primary" type="submit" id="g-send">Send me a code</button></form>
    <p class="gate-note">${msg ? escH(msg) : location.hash==="#signed-out-idle" ? "You were signed out after "+IDLE_MIN+" minutes without use (shared computer)." : "Only people invited by the lab can see the fish records."}</p>`);
  let capToken = "";
  if (TURNSTILE_SITE_KEY) loadTurnstile().then(ts => { if (ts) ts.render(el.querySelector("#g-cap"), { sitekey:TURNSTILE_SITE_KEY, callback:t=>{ capToken=t; }, "expired-callback":()=>{ capToken=""; } }); });
  el.querySelector("#g-e").focus();
  el.querySelector("#g-email").addEventListener("submit", async e=>{
    e.preventDefault(); const email = el.querySelector("#g-e").value.trim().toLowerCase(); const b = el.querySelector("#g-send");
    if (TURNSTILE_SITE_KEY && !capToken){ el.querySelector(".gate-note").textContent = "Please tick the “I'm not a robot” check first."; return; }
    setShared(el.querySelector("#g-shared").checked);
    b.disabled = true; b.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true, emailRedirectTo:APP_BASE, ...(capToken ? { captchaToken:capToken } : {}) } });
    if (TURNSTILE_SITE_KEY && window.turnstile){ try { window.turnstile.reset(); } catch(err){} capToken = ""; }
    if (error){ b.disabled=false; b.textContent="Send me a code"; el.querySelector(".gate-note").textContent = /rate|seconds/i.test(error.message) ? "Too many emails in a short time. Wait a minute and try again." : "Couldn't send the email: " + error.message; return; }
    ls.set("ft-email", email); showCode(email);
  });
}
let tsPromise = null;
function loadTurnstile(){
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return tsPromise || (tsPromise = new Promise(res => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.onload = ()=>res(window.turnstile); s.onerror = ()=>res(null); document.head.appendChild(s); }));
}
function showCode(email){
  const el = gate(`<p class="gate-sub">We sent an email to <b>${escH(email)}</b>. Type the code from it below.</p>
    <form id="g-code" class="gate-form"><label for="g-c">Code</label><input id="g-c" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required placeholder="123456"><button class="btn primary" type="submit" id="g-ok">Sign in</button></form>
    <p class="gate-note"><button class="linkbtn" type="button" id="g-back">Use another email</button> · Nothing arrived? Check Junk, then try again in a minute.</p>`);
  el.querySelector("#g-c").focus();
  el.querySelector("#g-back").onclick = ()=>showLogin();
  el.querySelector("#g-code").addEventListener("submit", async e=>{
    e.preventDefault(); const token = el.querySelector("#g-c").value.trim(); const b = el.querySelector("#g-ok"); b.disabled = true;
    const { error } = await sb.auth.verifyOtp({ email, token, type:"email" });
    if (error){ b.disabled=false; el.querySelector(".gate-note").textContent = "That code didn't work (it may have expired). Check it or go back and send a new one."; return; }
    afterLogin();
  });
}
async function afterLogin(){
  const { data:{ session } } = await sb.auth.getSession();
  if (!session){ showLogin(); return; }
  me = { id: session.user.id, email: session.user.email };
  let role = null;
  try {
    const r = await sb.rpc("claim_invites");
    if (r.error && (r.error.code==="PGRST202" || /claim_invites/.test(r.error.message||""))) {     // database without labs yet
      const { data, error } = await sb.rpc("claim_invite"); if (error) throw error; role = data;
    } else {
      if (r.error) throw r.error;
      MULTI = true; access = r.data || { floor_admin:false, labs:[] };
      const want = ls.get("ft-lab"); const pick = access.labs.find(l=>l.id===want) || access.labs[0];
      curLab = pick ? pick.id : null; role = pick ? pick.role : null;
    }
    ls.set("ft-role", { id:me.id, role, multi:MULTI, access, curLab });
  }
  catch(e){ const c = ls.get("ft-role"); if (isNetErr(e) && c && c.id===me.id){ role = c.role; MULTI = !!c.multi; access = c.access || access; curLab = c.curLab || null; } else if (isNetErr(e)) { gate(`<p class="gate-sub">No connection. Connect to the internet once to sign in on this device.</p>`); window.addEventListener("online", afterLogin, { once:true }); return; } }
  if (!role){
    gate(`<p class="gate-sub">You're signed in as <b>${escH(me.email)}</b>, but this email hasn't been added to a lab yet.</p><p class="gate-note">Ask your lab's admin to invite this exact address (Settings › Lab members), then reload this page.${access.floor_admin?" You're a Fish-floor admin: add yourself to a lab first, in Supabase or by asking another floor admin.":""}</p><div class="gate-form"><button class="btn primary" type="button" id="g-reload">I've been added: reload</button><button class="btn" type="button" id="g-out">Sign out</button></div>`);
    document.getElementById("g-reload").onclick = ()=>location.reload();
    document.getElementById("g-out").onclick = ()=>user.signOut();
    return;
  }
  myRole = role;
  await loadMembers();
  closeGate();
  if (location.hash === "#signed-out-idle") history.replaceState(null, "", APP_BASE);
  if (isShared()){ startIdleTimer(); const bar = document.querySelector(".top-actions"); if (bar && !document.getElementById("btn-out")){ const b = document.createElement("button"); b.className = "btn"; b.id = "btn-out"; b.type = "button"; b.title = "Shared computer: sign out when you're done"; b.textContent = "Sign out"; b.onclick = ()=>user.signOut(); bar.appendChild(b); } }
  flushQueue();
  resolveReady();
}
sb.auth.onAuthStateChange((ev)=>{ if (ev==="SIGNED_IN" && !me) afterLogin(); if (ev==="SIGNED_OUT" && me) location.replace(APP_BASE); });
const start = async ()=>{
  const { data:{ session } } = await sb.auth.getSession();
  if (session) afterLogin(); else if (!/access_token=/.test(location.hash)) showLogin();
};
if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
