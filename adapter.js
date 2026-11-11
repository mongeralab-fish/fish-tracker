/* Fish Tracker — Supabase adapter.
   Provides window.claude.use("db" | "user" | "downloads") with the same small API the app
   was written against, backed by Supabase (database, email login, live updates).
   Also handles sign-in, membership and an offline write queue. */
(function(){
"use strict";
const SB_URL = "https://xleqhjbrevfazjvramrj.supabase.co";
const SB_KEY = "sb_publishable_axr7UrlWIP3vi0gWJnbbUA_Ln-_FAd3";
const APP_BASE = location.origin + location.pathname;

const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:"implicit" } });
window.__sb = sb;

/* ---------- field maps (app name → column) ---------- */
const MAPS = {
  fish: { table:"stocks", f:{ legacyId:"legacy_id", stock:"stock", line:"line", name:"name", category:"category", common:"common", generation:"generation", zygosity:"zygosity", parentId:"parent_id", parent2Id:"parent2_id", parentNote:"parent_note", fromCrossId:"from_cross_id", room:"room", location:"location", fertDate:"fert_date", pil:"pil", ppl:"ppl", severity:"severity", count:"count", females:"females", males:"males", keepers:"keepers", fluors:"fluors", fluorNote:"fluor_note", comments:"comments", status:"status", prevStatus:"prev_status", deletedAt:"deleted_at", deletedBy:"deleted_by", createdAt:"created_at", createdBy:"created_by", updatedAt:"updated_at" } },
  breedings: { table:"crosses", f:{ legacyId:"legacy_id", fishId:"stock_id", fishId2:"stock2_id", stock:"stock_label", stock2:"stock2_label", sameStock:"same_stock", partner:"partner", date:"date", crossType:"cross_type", success:"success", eggs:"eggs", fertRate:"fert_rate", quality:"quality", use:"use", notes:"notes", planId:"plan_id", deleted:"deleted", deletedAt:"deleted_at", deletedBy:"deleted_by", by:"by", createdAt:"created_at" } },
  plans: { table:"plans", f:{ legacyId:"legacy_id", fishId:"stock_id", fishId2:"stock2_id", stock:"stock_label", stock2:"stock2_label", sameStock:"same_stock", partner:"partner", date:"date", crossType:"cross_type", note:"note", status:"status", doneDate:"done_date", doneBy:"done_by", cancelledBy:"cancelled_by", by:"by", createdAt:"created_at" } },
  events: { table:"events", f:{ legacyId:"legacy_id", fishId:"stock_id", stock:"stock_label", date:"date", type:"type", n:"n", sex:"sex", before:"before", after:"after", ppl:"ppl", note:"note", by:"by", createdAt:"created_at" } },
  log: { table:"history", f:{ fishId:"stock_id", action:"action", changes:"changes", note:"note", at:"at", by:"by" } }
};
const COL2APP = {}; for (const k in MAPS){ COL2APP[k] = Object.fromEntries(Object.entries(MAPS[k].f).map(([a,c])=>[c,a])); }
const TABLE2COLL = Object.fromEntries(Object.entries(MAPS).map(([k,v])=>[v.table,k]));
const DATE_COLS = new Set(["fert_date","date","done_date","regen_date"]);
const UUID_COLS = new Set(["parent_id","parent2_id","from_cross_id","stock_id","stock2_id","plan_id","by","created_by","deleted_by","done_by","cancelled_by"]);
const INT_COLS = new Set(["count","females","males","eggs","quality","n","before","after"]);
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
    if (c==="keepers") val = (Array.isArray(val)?val:[]).filter(isUuid);
    if (c==="fluors") val = Array.isArray(val)?val:[];
    if (c==="sex" && val==null) val = "";
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
  if (c==="42501" || c==="PGRST301" || c==="denied") return { code:"invalid_argument", message:"Not allowed" };
  if (c==="23505") return { code:"invalid_argument", message:"Duplicate" };
  return { code:"unavailable", message:(e && e.message) || "Error" };
}

/* ---------- local cache + offline queue ---------- */
const CACHE_KEY = "ft-cache-v1", Q_KEY = "ft-queue-v1";
const ls = { get(k){ try { return JSON.parse(localStorage.getItem(k)||"null"); } catch(e){ return null; } }, set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} } };
const cache = ls.get(CACHE_KEY) || {};           // table -> rows
const subs = {};                                  // coll -> [cb]
let queue = ls.get(Q_KEY) || [];
function saveCache(){ ls.set(CACHE_KEY, cache); }
function snapOf(coll, rows, fromCache){
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
    try { cache[t] = await fetchAll(t); saveCache(); notify(coll, false); setStatus(queue.length ? "Saving changes…" : null); }
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
    async set(d){ if (coll==="log") return; await write({ table:t, kind:"upsert", id, row:toRow(coll, d) }); },
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
    async add(d){ if (coll==="log") return { id:null }; const id = uuid(); await write({ table:MAPS[coll].table, kind:"insert", id, row:toRow(coll, d) }); return { id }; }
  });
}
/* settings: one row, stored as JSON */
const settingsSubs = [];
async function loadSettings(){
  try { const { data, error } = await sb.from("settings").select("data").eq("id",1).maybeSingle(); if (error) throw error; cache.__settings = (data && data.data) || {}; saveCache(); }
  catch(e){}
  settingsSubs.forEach(cb=>cb({ id:"settings", exists:true, data:()=>cache.__settings||{}, metadata:{fromCache:false} }));
}
const settingsDoc = {
  onSnapshot(cb){ settingsSubs.push(cb); if (cache.__settings) setTimeout(()=>cb({ id:"settings", exists:true, data:()=>cache.__settings, metadata:{fromCache:true} }),0); loadSettings(); ensureRealtime(); return ()=>{}; },
  async set(d){ const { data, error } = await sb.from("settings").update({ data:d, updated_at:new Date().toISOString() }).eq("id",1).select("id"); if (error) throw mapErr(error); if (!data || !data.length) throw { code:"invalid_argument", message:"Only lab admins can change the thresholds." }; cache.__settings = d; loadSettings(); },
  async get(){ await loadSettings(); return { exists:true, data:()=>cache.__settings||{} }; }
};
const db = {
  collection,
  isUuid, uuid,
  async bulk(coll, items, onProgress){            // items: [{id, data}] — upsert in chunks
    const t = MAPS[coll].table; let done = 0;
    for (let i=0; i<items.length; i+=200){
      const rows = items.slice(i, i+200).map(it=>({ ...toRow(coll, it.data), id:it.id }));
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
      if (p.table==="settings") return loadSettings();
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
async function loadMembers(){
  try { const { data, error } = await sb.from("members").select("*").order("created_at"); if (!error) { members = data; cache.__members = data; saveCache(); } }
  catch(e){ members = cache.__members || []; }
  window.dispatchEvent(new Event("ft-members"));
  return members;
}
function profile(id){
  const m = members.find(x=>x.user_id===id);
  const name = nameOfMember(m);
  return { id, name, avatarUrl: initialsAvatar(name || "?", id), color:"", email: m ? m.email : null, isMe: id===(me&&me.id), guest:false };
}
const user = {
  async id(){ return me ? me.id : null; },
  async me(){ const p = profile(me && me.id); return { ...p, isOwner: myRole==="owner", canEdit: myRole==="owner"||myRole==="admin" }; },
  async isOwner(){ return myRole==="owner"; },
  async canEdit(){ return myRole==="owner" || myRole==="admin"; },
  async can(c){ if (c==="data.write") return ["owner","admin","member"].includes(myRole); return false; },
  async profiles(ids){ if (!members.length) await loadMembers(); const out={}; for (const id of [].concat(ids)) out[id]=profile(id); return out; },
  async search(q){ if (!members.length) await loadMembers(); q=(q||"").toLowerCase(); return members.filter(m=>!q || (nameOfMember(m)+" "+m.email).toLowerCase().includes(q)).slice(0,8).map(m=>profile(m.user_id)); },
  async name(){ return profile(me && me.id).name; },
  // extras for the members screen
  role(){ return myRole; }, email(){ return me && me.email; }, list(){ return members; }, reload: loadMembers,
  async setMyName(n){ const { error } = await sb.rpc("set_my_name", { p_name:n }); if (error) throw mapErr(error); await loadMembers(); },
  async invites(){ const { data, error } = await sb.from("invites").select("*").order("created_at"); if (error) return []; return data; },
  async invite(email, role){ const { error } = await sb.from("invites").upsert({ email:String(email).trim().toLowerCase(), role }); if (error) throw mapErr(error); },
  async cancelInvite(email){ const { error } = await sb.from("invites").delete().eq("email", email); if (error) throw mapErr(error); },
  async setRole(uid, role){ const { data, error } = await sb.from("members").update({ role }).eq("user_id", uid).select("user_id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); await loadMembers(); },
  async remove(uid){ const { data, error } = await sb.from("members").delete().eq("user_id", uid).select("user_id"); if (error || !data.length) throw mapErr(error||{code:"denied"}); await loadMembers(); },
  async signOut(){ try { await sb.auth.signOut(); } catch(e){} try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(Q_KEY); } catch(e){} location.replace(APP_BASE); }
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
    <form id="g-email" class="gate-form"><label for="g-e">Email</label><input id="g-e" type="email" required autocomplete="email" placeholder="name@ucl.ac.uk" value="${escH(ls.get("ft-email")||"")}"><button class="btn primary" type="submit" id="g-send">Send me a code</button></form>
    <p class="gate-note">${msg ? escH(msg) : "Only people invited by the lab can see the fish records."}</p>`);
  el.querySelector("#g-e").focus();
  el.querySelector("#g-email").addEventListener("submit", async e=>{
    e.preventDefault(); const email = el.querySelector("#g-e").value.trim().toLowerCase(); const b = el.querySelector("#g-send"); b.disabled = true; b.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true, emailRedirectTo:APP_BASE } });
    if (error){ b.disabled=false; b.textContent="Send me a code"; el.querySelector(".gate-note").textContent = /rate|seconds/i.test(error.message) ? "Too many emails in a short time. Wait a minute and try again." : "Couldn't send the email: " + error.message; return; }
    ls.set("ft-email", email); showCode(email);
  });
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
  try { const { data, error } = await sb.rpc("claim_invite"); if (error) throw error; role = data; ls.set("ft-role", { id:me.id, role }); }
  catch(e){ const c = ls.get("ft-role"); if (isNetErr(e) && c && c.id===me.id) role = c.role; else if (isNetErr(e)) { gate(`<p class="gate-sub">No connection. Connect to the internet once to sign in on this device.</p>`); window.addEventListener("online", afterLogin, { once:true }); return; } }
  if (!role){
    gate(`<p class="gate-sub">You're signed in as <b>${escH(me.email)}</b>, but this email hasn't been added to the lab yet.</p><p class="gate-note">Ask the lab owner to invite this exact address (Settings › Lab members), then reload this page.</p><div class="gate-form"><button class="btn primary" type="button" onclick="location.reload()">I've been added: reload</button><button class="btn" type="button" id="g-out">Sign out</button></div>`).querySelector("#g-out").onclick = ()=>user.signOut();
    return;
  }
  myRole = role;
  await loadMembers();
  closeGate();
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
