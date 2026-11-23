/* Zebrafish Stock Tracker — import stocks from the facility database export (Excel / CSV).
   Loaded on demand (with vendor/xlsx.mini.min.js) from Settings › Import from the facility database.

   The facility export has one block per stock: the first row holds the stock's details and its first tank;
   the rows under it (empty stock number) are the stock's other tanks, each with its own fish count.
   The tracker keeps one entry per tank, so every tank becomes its own entry with the stock's details. */
(function(){
"use strict";
const { S, $, $$, esc, openModal, head, toast, fmt, pd, iso, today, roomsList, fluorChips, CATS, SEV, totalFish } = window.FT;

// column names in the facility export → our fields (matched case-insensitively, "LOCATIONS::" prefix ignored)
const COLS = {
  name:["linename","line name"], line:["rellineid","line number","lineid"], stock:["stocknumber","stock number","stock"],
  fert:["dof","date of fertilisation","fertilisation date","dob"], count:["calc total number fish","total number fish","number fish","count"],
  loc:["ablocation","location"], zyg:["d_zygosity","zygosity"], males:["d_qty_male","males","male"], females:["d_qty_female","females","female"],
  comments:["comments","comment","notes"], fName:["fatherslinename"], fLine:["fatherslinenumber"], fStock:["fathersstocknumber"],
  mName:["motherslinename"], mLine:["motherslinenumber"], mStock:["mothersstocknumber"], carer:["d_carer","carer","owner"],
  nursery:["nurserysuccessrate"], status:["status"]
};
const norm = s => String(s==null?"":s).trim().toLowerCase().replace(/^locations::/,"");

// fluorophores recognised in line names
const FL_RULES = [
  [/mscarlet-?i3/i,"mScarlet-I3"], [/mscarlet-?3|mscarlet3/i,"mScarlet3"], [/mscarlet(?!-?i?3)/i,"mScarlet"], [/mcherry/i,"mCherry"],
  [/td-?tomato/i,"tdTomato"], [/dsred/i,"DsRed"], [/mneongreen/i,"mNeonGreen"], [/staygold/i,"mStayGold"], [/\bm?gl\b|mgreenlantern/i,"mGreenLantern"],
  [/(^|[^a-z])e?gfp([^a-z]|$)/i,"EGFP / GFP"], [/venus|(^|[^a-z])yfp/i,"Venus / YFP"], [/citrine/i,"mCitrine"], [/(^|[^a-z])cfp|cerulean/i,"CFP / mCerulean"],
  [/(^|[^a-z])bfp|tagbfp/i,"mTagBFP / BFP"], [/mkate/i,"mKate2"], [/irfp/i,"iRFP"], [/kaede/i,"Kaede (green)"], [/halo/i,"HaloTag (dye)"]
];
const fluorsOf = name => [...new Set(FL_RULES.filter(([re])=>re.test(name||"")).map(r=>r[1]))];
const WT_RE = /^(ab|tl|tu|wik|sat|casper|nacre|roy|ekw?)(?![a-y])/i;   // AB, ABZ, TL45, AB-MPI, casper… (not "abc…" words)
const guessCategory = name => { const n=String(name||""); if (WT_RE.test(n) && !/[:]|tg\(|gal4|uas|ubi|^p\d{3}/i.test(n)) return "Wild type"; if (/mutant|-\/-|\bko\b|crispr/i.test(n)) return "Mutant"; return "Transgenic"; };
const guessBackground = name => { const n=String(name||""); const m=/\b(casper|nacre|roy)\b/i.exec(n); if (m) return m[1].toLowerCase(); if (/^AB/i.test(n) && /TL/.test(n)) return "AB/TL"; const w=/^(AB|TL|TU|WIK)/i.exec(n); return w && !/[:]/.test(n) ? w[1].toUpperCase() : ""; };
const zygOf = z => { const s=String(z||"").toLowerCase(); if (!s) return ""; if (/het/.test(s)) return "Heterozygous"; if (/hom/.test(s)) return "Homozygous"; if (/mix/.test(s)) return "Mixed het / hom"; return ""; };

function dateOf(v){
  if (v==null || v==="") return "";
  if (typeof v==="number" && v>20000 && v<80000){ const d=new Date(Math.round((v-25569)*86400000)); return d.toISOString().slice(0,10); }
  const s=String(v).trim(); let m;
  if ((m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  if ((m=/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s))) { const y=m[3].length===2?"20"+m[3]:m[3]; return `${y}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`; }   // UK day/month/year
  return "";
}
const numOf = v => { if (v==null || v==="") return null; const n=Number(String(v).replace(",",".")); return isFinite(n) ? n : null; };

// "D-T32" → Room D, tank T32 (Room A was renamed Room D)
function placeOf(loc, rooms){
  const s=String(loc||"").trim(); if (!s) return { room:"", location:"" };
  const m=/^([A-Za-z]{1,2})[-\s]+(.+)$/.exec(s); if (!m) return { room:"", location:s };
  let letter=m[1].toUpperCase(); if (letter==="A") letter="D";
  const room = rooms.find(r=>new RegExp(`(^|\\s)${letter}$`,"i").test(r.trim()));
  return room ? { room, location:m[2].trim() } : { room:"", location:s };
}

// "D-T32" → { pre:"D-T", n:32 }
const posOf = loc => { const m=/^(.*?)(\d+)$/.exec(String(loc||"").trim()); return m ? { pre:m[1].toUpperCase(), n:+m[2] } : null; };

function parse(rows, rooms){
  const hi = rows.findIndex(r=>Array.isArray(r) && r.some(c=>COLS.stock.includes(norm(c))) && r.some(c=>COLS.name.includes(norm(c))));
  if (hi<0) return { error:"This doesn't look like the facility export: no “stockNumber” and “linename” columns were found." };
  const H=rows[hi].map(norm), col={};
  for (const [k,names] of Object.entries(COLS)) { const i=H.findIndex(h=>names.includes(h)); if (i>=0) col[k]=i; }
  const get = (r,k) => col[k]!=null ? r[col[k]] : null;
  const stocks=[]; let cur=null; const notes={ frac:[] };
  for (const r of rows.slice(hi+1)){
    if (!Array.isArray(r) || r.every(c=>c==null || c==="")) continue;
    const stockNo = String(get(r,"stock")??"").trim();
    if (stockNo){
      const status=String(get(r,"status")||"").trim();
      cur={ stock:stockNo, line:String(get(r,"line")??"").trim(), name:String(get(r,"name")||"").trim(), fertDate:dateOf(get(r,"fert")),
            zygosity:zygOf(get(r,"zyg")), comments:String(get(r,"comments")||"").replace(/\r\n?/g,"\n").trim(),
            father:{ stock:String(get(r,"fStock")??"").trim(), line:String(get(r,"fLine")??"").trim(), name:String(get(r,"fName")||"").trim() },
            mother:{ stock:String(get(r,"mStock")??"").trim(), line:String(get(r,"mLine")??"").trim(), name:String(get(r,"mName")||"").trim() },
            carer:String(get(r,"carer")||"").trim(), nursery:numOf(get(r,"nursery")), status, dead:/deceased|dead|culled|closed/i.test(status), tanks:[] };
      stocks.push(cur);
    } else if (!cur) continue;
    const loc=String(get(r,"loc")||"").trim(), cnt=numOf(get(r,"count")), ml=numOf(get(r,"males")), fe=numOf(get(r,"females"));
    if (loc || cnt!=null || ml!=null || fe!=null){
      if (cnt!=null && !Number.isInteger(cnt)) notes.frac.push(`${cur.stock} (${cnt})`);
      // The facility records a double tank as two positions with the count on the first one:
      // a position with no count right after a counted position of the same stock (D-T32 38, D-T33 —) is the same tank.
      const prev = cur.tanks[cur.tanks.length-1], a = posOf(prev && prev.raw), b = posOf(loc);
      if (prev && !prev.merged && prev.count!=null && cnt==null && ml==null && fe==null && a && b && a.pre===b.pre && b.n===a.n+1){
        prev.merged=true; prev.places=2; prev.rawEnd=loc; prev.location = `${prev.location}+${b.n}`; notes.doubles=(notes.doubles||0)+1; continue;
      }
      cur.tanks.push({ raw:loc, ...placeOf(loc, rooms), places:1, count:cnt==null?null:Math.round(cnt), males:ml==null?null:Math.round(ml), females:fe==null?null:Math.round(fe) });
    }
  }
  stocks.forEach(s=>{ s.category=guessCategory(s.name); s.background=guessBackground(s.name); s.fluors=fluorsOf(s.name); });
  return { stocks, col, notes };
}

async function loadXLSX(){
  if (window.XLSX && window.XLSX.read) return window.XLSX;
  await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="vendor/xlsx.mini.min.js"; s.onload=res; s.onerror=()=>rej(new Error("Couldn't load the spreadsheet reader.")); document.head.appendChild(s); });
  return window.XLSX;
}

function matchMember(carer, mem){
  const c=String(carer||"").toLowerCase().trim(); if (!c) return "";
  const first=c.split(/\s+/)[0];
  const hit = mem.find(m=>(m.display_name||"").toLowerCase()===c) || mem.find(m=>(m.display_name||"").toLowerCase().split(/\s+/)[0]===first) || mem.find(m=>(m.email||"").toLowerCase().split(/[@.]/)[0]===first);
  return hit ? hit.user_id : "";
}

window.openFacilityImport = function(){
  if (!S.canWrite){ toast("You need member access to import stocks."); return; }
  openModal(`${head("Import from the facility database", "Excel export (.xlsx) or CSV from the facility's stock database")}
    <div class="sheet-body"><div id="im-step">
      <p style="margin-top:0">Choose the export file. Every person's export has the same columns, so it can be imported as it is. Nothing is added until you've checked the preview.</p>
      <label class="btn primary" for="im-file">Choose file…</label><input type="file" id="im-file" accept=".xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
      <p class="note" id="im-msg"></p></div></div>
    <div class="sheet-foot"><button class="btn" type="button" data-close>Close</button></div>`, body=>{
    $("#im-file",body).addEventListener("change", async e=>{
      const file=e.target.files[0]; if (!file) return; const msg=$("#im-msg",body); msg.textContent="Reading…";
      if (/\.xls$/i.test(file.name)){ msg.textContent="This is the old .xls format: open it in Excel and save it as .xlsx, then choose it again."; return; }
      try {
        const X=await loadXLSX();
        const wb=X.read(await file.arrayBuffer(), { type:"array" });
        const rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, raw:true, defval:null });
        const res=parse(rows, roomsList());
        if (res.error){ msg.textContent=res.error; return; }
        if (!res.stocks.length){ msg.textContent="No stocks found in this file."; return; }
        preview(body, file.name, res);
      } catch(err){ console.error(err); msg.textContent="Couldn't read this file. Is it the Excel export from the facility database?"; }
    });
  });
};

function preview(body, fileName, res){
  const { stocks, col, notes } = res;
  const all=[...S.fish, ...(S.binFish||[])];
  const existing = new Set(all.map(f=>String(f.stock||"").trim()));
  const activeByStock = {}; S.fish.filter(f=>f._c.active).forEach(f=>{ (activeByStock[String(f.stock).trim()] ||= []).push(f); });
  stocks.forEach(s=>{ s.exists=existing.has(s.stock); s.take = !s.exists && !s.dead; });
  const fresh=stocks.filter(s=>!s.exists), dead=fresh.filter(s=>s.dead), have=stocks.filter(s=>s.exists);
  const goneHere = have.filter(s=>s.dead && activeByStock[s.stock]);
  const mem=(S.user.list()||[]);
  const carers=[...new Set(fresh.map(s=>s.carer).filter(Boolean))];
  const lic=(S.licences||[]);
  const noCount=fresh.filter(s=>!s.dead).reduce((n,s)=>n+s.tanks.filter(t=>t.count==null).length,0);
  const noTank=fresh.filter(s=>!s.dead && !s.tanks.length);
  const noRoom=fresh.filter(s=>!s.dead).reduce((n,s)=>n+s.tanks.filter(t=>t.raw && !t.room).length,0);
  const missing=[];
  if (col.zyg==null || !fresh.some(s=>s.zygosity)) missing.push("zygosity");
  if (col.males==null || !fresh.some(s=>s.tanks.some(t=>t.males!=null||t.females!=null))) missing.push("numbers of males and females");
  missing.push("PPL, PPL protocol, PIL and severity limit (not in the facility export)");

  const sevOpts = SEV.map(v=>`<option>${esc(v)}</option>`).join("");
  const row = (s,i) => {
    const nT=s.tanks.length, fish=s.tanks.reduce((a,t)=>a+(t.count||0),0);
    return `<tr class="${s.exists?"im-skip":""}"><td><input type="checkbox" data-imt="${i}" ${s.take?"checked":""} ${s.exists?"disabled":""} aria-label="Import ${esc(s.stock)}"></td>
      <td class="mono">${esc(s.stock)}</td><td><strong>${esc(s.name||"—")}</strong>${s.line?`<small> · line ${esc(s.line)}</small>`:""}${s.fluors.length?`<div>${fluorChips(s.fluors)}</div>`:""}</td>
      <td>${nT?s.tanks.map(t=>esc(t.room?t.room.replace(/^Room /,"")+"-"+t.location:t.raw||"?")+(t.places===2?` <small>double</small>`:"")+(t.count!=null?` <small>(${t.count})</small>`:"")).join(", "):"<small>no tank</small>"}</td>
      <td>${fish||"—"}</td><td>${esc(s.fertDate?fmt(pd(s.fertDate)):"—")}</td>
      <td><select data-imc="${i}" ${s.exists?"disabled":""} aria-label="Category">${CATS.map(c=>`<option ${s.category===c?"selected":""}>${c}</option>`).join("")}</select></td>
      <td><small>${s.exists?"Already in the tracker":esc(s.status||"")}</small></td></tr>`;
  };
  $("#im-step",body).innerHTML = `
    <p style="margin-top:0"><b>${esc(fileName)}</b>: ${stocks.length} stock${stocks.length===1?"":"s"}, ${stocks.reduce((n,s)=>n+s.tanks.length,0)} tanks.
      <b>${fresh.filter(s=>!s.dead).length}</b> new live stock${fresh.filter(s=>!s.dead).length===1?"":"s"} to add${have.length?`, ${have.length} already in the tracker (left unchanged)`:""}${dead.length?`, ${dead.length} marked deceased`:""}.</p>
    ${goneHere.length?`<div class="banner warn" style="margin:0 0 8px">Marked deceased in the file but still active here: ${goneHere.map(s=>`<b>${esc(s.stock)}</b> ${esc(s.name)}`).join(", ")}. Close those tanks in the tracker if they're gone.</div>`:""}
    <div class="banner" style="margin:0 0 10px"><b>Not in the file, please fill in:</b> ${esc(missing.join("; "))}. What you enter below is applied to every stock imported now; you can change single tanks afterwards.
      ${notes.frac.length?`<br>Fish counts that weren't whole numbers were rounded: ${esc(notes.frac.join(", "))}.`:""}
      ${notes.doubles?`<br>${notes.doubles} double tank${notes.doubles===1?"":"s"} recognised (two positions with one count, e.g. D-T32+33): imported as one double tank each.`:""}
      ${noCount?`<br>${noCount} tank${noCount===1?" has":"s have"} no fish count in the file: they're imported without a number.`:""}
      ${noTank.length?`<br>${noTank.length} live stock${noTank.length===1?" has":"s have"} no tank location: ${noTank.map(s=>esc(s.stock)).join(", ")}. They're imported without a location.`:""}
      ${noRoom?`<br>${noRoom} location${noRoom===1?"":"s"} didn't match a room in Settings and ${noRoom===1?"is":"are"} kept as written.`:""}</div>
    <div class="form">
      <div class="field"><label for="im-ppl">PPL</label><input id="im-ppl" list="im-ppls" maxlength="60" placeholder="Project licence number"><datalist id="im-ppls">${lic.map(l=>`<option value="${esc(l.ppl)}">${esc(l.title||"")}</option>`).join("")}</datalist></div>
      <div class="field"><label for="im-prot">PPL protocol number</label><input id="im-prot" maxlength="20" placeholder="e.g. 1"></div>
      <div class="field"><label for="im-pil">PIL</label><input id="im-pil" maxlength="60" placeholder="Personal licence number"></div>
      <div class="field"><label for="im-sev">Severity limit</label><select id="im-sev"><option value="">—</option>${sevOpts}</select></div>
      <div class="field"><label for="im-gen">Generation (if the same for all)</label><input id="im-gen" maxlength="10" placeholder="leave empty if it varies"></div>

      ${carers.length?`<div class="field full"><span class="lab">Responsible person</span>${carers.map((c,i)=>`<div class="mrow"><span class="who"><strong>“${esc(c)}”</strong><small>carer in the file · ${fresh.filter(s=>s.carer===c).length} stocks</small></span><select data-imp="${i}">${`<option value="">Nobody (lab stock)</option>`+mem.map(m=>`<option value="${esc(m.user_id)}" ${matchMember(c,mem)===m.user_id?"selected":""}>${esc(m.display_name||m.email)}</option>`).join("")}</select></div>`).join("")}<span class="hint">People need to have signed in once to appear here.</span></div>`:""}
      <div class="field full"><div class="seg"><label><input type="checkbox" id="im-dead">Also import deceased stocks (as closed, for the records)</label><label><input type="checkbox" id="im-fl" checked>Fill in fluorophores recognised in line names</label></div></div>
    </div>
    <div class="im-table"><table><thead><tr><th></th><th>Stock</th><th>Line</th><th>Tanks (fish)</th><th>Fish</th><th>Fertilised</th><th>Category</th><th>Status</th></tr></thead>
      <tbody>${stocks.map(row).join("")}</tbody></table></div>
    <p class="note">Each tank becomes its own entry with the stock's details, as everywhere in the tracker; double tanks are recognised automatically. Parents are linked when their stock is in the tracker (or in this file); otherwise their stock and line numbers are written in “Parent note”. The facility line number goes in “Line number”, the nursery survival rate in the comments. Stocks already in the tracker are never changed, so the same file (or a newer export) can be imported again safely.</p>
    <p class="note" id="im-msg"></p>`;
  $("#im-dead",body).addEventListener("change", e=>{ fresh.filter(s=>s.dead).forEach(s=>{ s.take=e.target.checked; const cb=body.querySelector(`[data-imt="${stocks.indexOf(s)}"]`); if (cb) cb.checked=e.target.checked; }); upd(); });
  body.addEventListener("change", e=>{ const t=e.target.closest("[data-imt]"); if (t){ stocks[+t.dataset.imt].take=t.checked; upd(); } const c=e.target.closest("[data-imc]"); if (c) stocks[+c.dataset.imc].category=c.value; });
  const foot=$(".sheet-foot",body); foot.innerHTML=`<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="im-go"></button>`;
  const upd=()=>{ const n=stocks.filter(s=>s.take), t=n.reduce((a,s)=>a+Math.max(1,s.tanks.length),0); $("#im-go",body).textContent=`Import ${n.length} stock${n.length===1?"":"s"} (${t} tank${t===1?"":"s"})`; $("#im-go",body).disabled=!n.length; };
  upd();
  $("#im-go",body).onclick=()=>run(body, fileName, stocks, carers);
}

async function run(body, fileName, stocks, carers){
  const go=$("#im-go",body), msg=$("#im-msg",body); go.disabled=true;
  const pick=stocks.filter(s=>s.take); if (!pick.length) return;
  const common={ ppl:$("#im-ppl",body).value.trim(), pplProtocol:$("#im-prot",body).value.trim(), pil:$("#im-pil",body).value.trim(), severity:$("#im-sev",body).value,
                 generation:$("#im-gen",body).value.trim() };
  if (!common.ppl && !confirm("No PPL entered. Import anyway? You can add it to each tank later.")){ go.disabled=false; return; }
  const who={}; $$("[data-imp]",body).forEach(sel=>{ who[carers[+sel.dataset.imp]]=sel.value||null; });
  const withFl=$("#im-fl",body).checked, now=new Date().toISOString(), uuid=S.db.uuid;
  const items=[], byStock={};
  for (const s of pick){
    const tanks = s.tanks.length ? s.tanks : [{ room:"", location:"", places:1, count:null, males:null, females:null }];
    const keeper = s.carer && who[s.carer] ? [who[s.carer]] : [];
    const extra = [s.comments, s.nursery!=null && s.nursery>0 ? `Nursery survival ${Math.round(s.nursery*100)}% (facility database).` : ""].filter(Boolean).join("\n");
    for (const t of tanks){
      const id=uuid();
      const data={ stock:s.stock, line:s.line, name:s.name, generation:common.generation, zygosity:s.zygosity, category:s.category, background:s.background,
        fluors: withFl ? s.fluors : [], fluorNote:"", comments:extra, room:t.room, location:t.location, tankPlaces:t.places||1, fertDate:s.fertDate,
        pil:common.pil, ppl:common.ppl, pplProtocol:common.pplProtocol, severity:common.severity,
        count:t.count, females:t.females, males:t.males, keepers:keeper, common:!keeper.length,
        parentId:null, parent2Id:null, parentNote:"", finClipped:false, status: s.dead ? "archived" : "active",
        createdAt:now, createdBy:S.me||"", updatedAt:now };
      if (s.dead){ data.closedReason="Deceased"; data.closedDate=iso(today()); data.closedNote=`Marked deceased in the facility database (${fileName})`; data.count=data.count||0; }
      items.push({ id, data, s }); (byStock[s.stock] ||= []).push(id);
    }
  }
  // parents: link to a tank of that stock (in the tracker or in this import), otherwise write them down
  const findTank = no => { if (!no) return null; if (byStock[no]) return byStock[no][0]; const f=[...S.fish].find(x=>String(x.stock).trim()===no && x._c.active) || [...S.fish,...(S.binFish||[])].find(x=>String(x.stock).trim()===no); return f ? f.id : null; };
  for (const it of items){
    const { mother, father } = it.s; const m=findTank(mother.stock), f=findTank(father.stock);
    it.data.parentId = m || null;                                  // ♀ parent
    it.data.parent2Id = f && f!==m ? f : (m && f===m ? null : null);  // ♂ parent (same tank = in-cross, kept once)
    const desc = p => [p.stock?`stock ${p.stock}`:"", p.line?`line ${p.line}`:"", p.name||""].filter(Boolean).join(", ");
    const unl = [ (mother.stock||mother.name) && !m ? `♀ ${desc(mother)}` : "", (father.stock||father.name) && !f ? `♂ ${desc(father)}` : "" ].filter(Boolean);
    if (mother.stock && father.stock && mother.stock===father.stock && !m) unl.splice(0, unl.length, `In-cross of ${desc(mother)}`);
    it.data.parentNote = unl.join(" × ");
  }
  let done=0; const prog=()=>{ go.textContent=`Importing… ${done}/${items.length}`; }; prog();
  try {
    await S.db.bulk("fish", items.map(({id,data})=>({ id, data })), n=>{ done=n; prog(); });
    const ev = items.filter(({data})=>totalFish(data)).map(({id,data})=>({ id:uuid(), data:{ fishId:id, stock:data.stock, name:data.name, ppl:data.ppl, date:iso(today()), type:"added", n:totalFish(data), sex:"", before:0, after:totalFish(data), actualSeverity:"", details:{ start:true, imported:fileName }, note:`Starting number (imported from ${fileName})`, by:S.me||"", createdAt:now } }));
    if (ev.length) await S.db.bulk("events", ev);
    msg.innerHTML=`<b>Done:</b> ${pick.length} stocks imported as ${items.length} tanks. Their QR labels are ready (Stocks › select › Labels).`;
    go.textContent="Imported"; toast(`${items.length} tanks imported from ${fileName}.`);
  } catch(e){ console.error(e); msg.textContent=`Stopped after ${done} of ${items.length} tanks: ${e && e.message ? e.message : "the database refused the import"}. Importing the same file again adds only what's missing.`; go.disabled=false; go.textContent="Try again"; }
}

window.__facilityImportTest = { parse, placeOf, dateOf, fluorsOf, guessCategory };
})();
