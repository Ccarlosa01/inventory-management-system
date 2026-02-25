
/* Warehouse Pallet Manager v1.5.2
 * - Search suggestions open below the description input (full width).
 * - Carries all features from v1.5.1.
 */

const DB_NAME = 'warehouseDB_v1_5_2';
const DB_VERSION = 12;
let db;
let adminUnlocked = false;
let updatedSession = new Set();
let isDirty = false;

// ---------- Crypto ----------
async function sha256Hex(text){
  const enc = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  const bytes = Array.from(new Uint8Array(hashBuf));
  return bytes.map(b => b.toString(16).padStart(2,'0')).join('');
}

// ---------- IndexedDB ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('catalog')) {
        const store = db.createObjectStore('catalog', { keyPath: 'itemNo' });
        store.createIndex('byDescription', 'description', { unique: false });
      }
      if (!db.objectStoreNames.contains('locations')) {
        db.createObjectStore('locations', { keyPath: 'pallet' });
      }
      if (!db.objectStoreNames.contains('bpc')) {
        db.createObjectStore('bpc', { keyPath: 'itemNo' });
      }

      if (!db.objectStoreNames.contains('breakers')) {
        const br = db.createObjectStore('breakers', { keyPath: 'id', autoIncrement: true });
        br.createIndex('byDate', 'whenIso', { unique: false });
        br.createIndex('byItemNo', 'itemNo', { unique: false });
      }

    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function tx(storeNames, mode='readonly') {
  const t = db.transaction(storeNames, mode);
  const stores = storeNames.map(n => t.objectStore(n));
  return { t, stores };
}

// ---------- Config ----------
async function getConfig(key){
  const { stores:[config] } = tx(['config']);
  return new Promise((resolve)=>{
    const req = config.get(key);
    req.onsuccess = ()=> resolve(req.result?.value ?? null);
  });
}
async function setConfig(key, value){
  const { stores:[config] } = tx(['config'],'readwrite');
  return new Promise((resolve,reject)=>{
    const req = config.put({ key, value });
    req.onsuccess = ()=>resolve(true);
    req.onerror = ()=>reject(req.error);
  });
}
async function getPalletCount(){ return getConfig('palletCount'); }
async function setPalletCount(v){
  const current = await getPalletCount();
  if (current !== null) throw new Error('Pallet count already set.');
  return setConfig('palletCount', v);
}
async function getAdminHash(){ return getConfig('adminPassHash'); }
async function setAdminHash(hash){ return setConfig('adminPassHash', hash); }

// ---------- Catalog ----------
async function clearCatalog() {
  const { stores:[catalog] } = tx(['catalog'], 'readwrite');
  return new Promise((resolve)=>{
    const req = catalog.clear(); req.onsuccess = ()=>resolve(true);
  });
}
async function importCatalog(rows) {
  const { t, stores:[catalog] } = tx(['catalog'], 'readwrite');
  return new Promise((resolve, reject) => {
    let imported = 0;
    rows.forEach(cols => {
      if (!cols || cols.length < 15) return;
      const itemNo = String(cols[1]).trim();
      const description = String(cols[2] ?? '').trim();
      const packSizeRaw = String(cols[4] ?? '').trim();
      const avgCostStr = String(cols[7] ?? '').trim();
      let avgCost = Number(avgCostStr.replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(avgCost)) avgCost = null;
      const vendor = String(cols[12] ?? '').trim();
      const salesRep = String(cols[14] ?? '').trim();
      const rec = { itemNo, description, packSizeRaw, avgCost, vendor, salesRep };
      const req = catalog.put(rec);
      req.onsuccess = ()=>{};
      imported++;
    });
    t.oncomplete = () => resolve(imported);
    t.onerror = () => reject(t.error);
  });
}
async function searchByDescription(q, limit=20) {
  const { stores:[catalog] } = tx(['catalog']);
  return new Promise((resolve) => {
    const results=[];
    const req = catalog.openCursor();
    const ll = q.toLowerCase();
    req.onsuccess = (e)=>{
      const c=e.target.result;
      if (c){
        const v=c.value;
        if (v.description && v.description.toLowerCase().includes(ll)) {
          results.push(v);
          if (results.length>=limit){ resolve(results); return; }
        }
        c.continue();
      } else resolve(results);
    };
  });
}
async function iterCatalogAll() {
  const { stores:[catalog] } = tx(['catalog']);
  return new Promise((resolve)=>{
    const arr=[]; const c=catalog.openCursor();
    c.onsuccess=(e)=>{ const cur=e.target.result; if(cur){ arr.push(cur.value); cur.continue(); } else resolve(arr); };
  });
}

// ---------- BPC store ----------
async function getBPC(itemNo) {
  const { stores:[bpc] } = tx(['bpc']);
  return new Promise((resolve)=>{
    const req = bpc.get(String(itemNo));
    req.onsuccess = ()=> resolve(req.result?.bpc ?? null);
  });
}
async function setBPC(itemNo, value) {
  const { stores:[bpc] } = tx(['bpc'], 'readwrite');
  return new Promise((resolve,reject)=>{
    const req = bpc.put({ itemNo:String(itemNo), bpc:Number(value) });
    req.onsuccess = ()=>resolve(true);
    req.onerror = ()=>reject(req.error);
  });
}
async function deleteBPC(itemNo) {
  const { stores:[bpc] } = tx(['bpc'], 'readwrite');
  return new Promise((resolve)=>{
    const req = bpc.delete(String(itemNo));
    req.onsuccess = ()=>resolve(true);
  });
}

// ---------- Locations ----------
async function loadLocation(pallet) {
  const { stores:[locations] } = tx(['locations']);
  return new Promise((resolve)=>{
    const req = locations.get(String(pallet));
    req.onsuccess = ()=> resolve(req.result?.items ?? []);
  });
}
async function saveLocation(pallet, items) {
  const { stores:[locations] } = tx(['locations'], 'readwrite');
  return new Promise((resolve,reject)=>{
    const req = locations.put({ pallet:String(pallet), items });
    req.onsuccess = ()=>resolve(true);
    req.onerror = ()=>reject(req.error);
  });
}
async function clearLocation(pallet){
  const { stores:[locations] } = tx(['locations'], 'readwrite');
  return new Promise((resolve)=>{
    const req = locations.delete(String(pallet));
    req.onsuccess = ()=>resolve(true);
  });
}
async function updateAllLocationsForItemNo(itemNo, newBpc){
  await new Promise((resolve, reject)=>{
    const t = db.transaction(['locations'],'readwrite');
    const store = t.objectStore('locations');
    const req = store.openCursor();
    req.onsuccess = (e)=>{
      const cur = e.target.result;
      if (cur){
        const rec = cur.value;
        let changed = false;
        if (Array.isArray(rec.items)){
          rec.items = rec.items.map(line => {
            if (line.itemNo === itemNo){
              changed = true;
              const cases = Number(line.cases || 0);
              const units = Number(newBpc) * cases;
              return { ...line, bpc: Number(newBpc), units };
            }
            return line;
          });
        }
        if (changed){
          cur.update(rec);
        }
        cur.continue();
      } else resolve();
    };
    req.onerror = ()=>reject(req.error);
  });
}

// Search saved pallets by description
async function searchSavedPalletsByDescription(q){
  const ll = (q || '').trim().toLowerCase();
  if (!ll) return [];
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['locations'],'readonly');
    const store = t.objectStore('locations');
    const req = store.openCursor();
    const rows = [];
    req.onsuccess = (e)=>{
      const cur = e.target.result;
      if (cur){
        const pallet = cur.value.pallet;
        const items = cur.value.items || [];
        items.forEach(line => {
          const desc = (line.description || '').toLowerCase();
          if (desc.includes(ll)){
            rows.push({
              pallet,
              itemNo: line.itemNo,
              description: line.description,
              bpc: line.bpc ?? '',
              cases: line.cases ?? '',
              units: line.units ?? ''
            });
          }
        });
        cur.continue();
      } else resolve(rows);
    };
    req.onerror = ()=>reject(req.error);
  });
}

// ---------- UI Refs ----------
const el = (id)=>document.getElementById(id);

const adminStatus = el('admin-status');
const btnAdminPanel = el('btn-admin-panel');

const securitySetup = el('security-setup');
const pw1 = el('pw1');
const pw2 = el('pw2');
const btnSetPassword = el('btn-set-password');

const adminLock = el('admin-lock');
const unlockPassword = el('unlock-password');
const btnUnlockAdmin = el('btn-unlock-admin');

const palletCountInput = el('pallet-count-input');
const palletCountStatus = el('pallet-count-status');
const savePalletCountBtn = el('save-pallet-count');

const catalogFile = el('catalog-file');
const catalogStatus = el('catalog-status');
const clearCatalogBtn = el('btn-clear-catalog');

const palletNumberInput = el('pallet-number');
const btnLoadPallet = el('btn-load-pallet');
const currentPalletLabel = el('current-pallet-label');

const searchDescInput = el('search-desc');
const searchResults = el('search-results');

const entryItemNo = el('entry-itemno');
const entryDesc = el('entry-desc');
const entryBPC = el('entry-bpc');
const entryCases = el('entry-cases');
const entryUnits = el('entry-units');
const btnAddLine = el('btn-add-line');
const btnClearLine = el('btn-clear-line');

const palletTableBody = document.querySelector('#pallet-table tbody');
const btnSave = el('btn-save');
const btnClearLocation = el('btn-clear-location');
const btnClearIndicators = el('btn-clear-indicators');
const saveIndicator = el('save-indicator');

const btnExport = el('btn-export');
const restoreFile = el('restore-file');

const adminSection = el('admin-bpc');
const adminSearch = el('admin-search');
const adminSearchBtn = el('admin-search-btn');
const adminClearBtn = el('admin-clear-btn');
const adminTableBody = document.querySelector('#admin-table tbody');
const btnLockAdmin = el('btn-lock-admin');

// Global search
const searchAllDesc = el('search-all-desc');
const btnSearchAll = el('btn-search-all');
const btnSearchAllClear = el('btn-search-all-clear');
const searchAllBody = document.querySelector('#search-all-table tbody');

const workbenchSection = document.getElementById('step-workbench');

let currentPallet = null;
let workingLines = [];

// ---------- Admin status ----------
function showOnly(section){
  [securitySetup, adminLock, adminSection].forEach(s => { if (s) s.style.display='none'; });
  if (section) section.style.display = '';
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function updateAdminStatusChip(){
  const hash = await getAdminHash();
  if (!hash){
    adminStatus.textContent = 'Admin: setup needed';
    adminStatus.className = 'pill warn';
  } else if (adminUnlocked){
    adminStatus.textContent = 'Admin: unlocked';
    adminStatus.className = 'pill ok';
  } else {
    adminStatus.textContent = 'Admin: locked';
    adminStatus.className = 'pill';
  }
}
async function updateSecurityUI(){ await updateAdminStatusChip(); }
btnAdminPanel.addEventListener('click', async ()=>{
  const hash = await getAdminHash();
  if (!hash){ showOnly(securitySetup); }
  else if (!adminUnlocked){ showOnly(adminLock); }
  else { showOnly(adminSection); await runAdminSearch(); }
});
btnSetPassword.addEventListener('click', async ()=>{
  const a = pw1.value; const b = pw2.value;
  if (!a || !b){ alert('Enter and confirm the password.'); return; }
  if (a !== b){ alert('Passwords do not match.'); return; }
  if (a.length < 6){ alert('Use at least 6 characters.'); return; }
  const hash = await sha256Hex(a);
  await setAdminHash(hash);
  pw1.value=''; pw2.value='';
  alert('Admin password saved.');
  await updateSecurityUI();
  showOnly(adminLock);
});
btnUnlockAdmin.addEventListener('click', async ()=>{
  const hash = await getAdminHash();
  const attempt = await sha256Hex(unlockPassword.value || '');
  if (attempt === hash){
    adminUnlocked = true;
    unlockPassword.value='';
    await updateSecurityUI();
    showOnly(adminSection);
    await runAdminSearch();
  } else { alert('Incorrect password.'); }
});
btnLockAdmin.addEventListener('click', async ()=>{
  adminUnlocked = false;
  await updateSecurityUI();
  showOnly(adminLock);
});

// ---------- Save state indicator ----------
function markDirty(){
  isDirty = true;
  saveIndicator.textContent = 'Unsaved changes — press Save';
  saveIndicator.className = 'pill warn';
}
function markClean(){
  isDirty = false;
  saveIndicator.textContent = 'Saved';
  saveIndicator.className = 'pill ok';
}

// ---------- Workbench ----------
function renderWorkingTable(){
  palletTableBody.innerHTML='';
  workingLines.forEach((line, idx)=>{
    const updatedTag = updatedSession.has(line.itemNo) ? '<span class="badge updated">updated</span>' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge">${line.itemNo}</span></td>
      <td>${escapeHTML(line.description)} ${updatedTag}</td>
      <td>${line.bpc ?? ''}</td>
      <td>${line.cases ?? ''}</td>
      <td>${line.units ?? ''}</td>
      <td><button class="btn ghost" data-del="${idx}">✕</button></td>
    `;
    palletTableBody.appendChild(tr);
  });
  palletTableBody.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i = Number(btn.getAttribute('data-del'));
      if (workingLines[i]) updatedSession.delete(workingLines[i].itemNo);
      workingLines.splice(i,1);
      renderWorkingTable();
      markDirty();
    });
  });
}
function escapeHTML(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function clearEntry(){
  entryItemNo.value=''; entryDesc.value=''; entryBPC.value=''; entryCases.value=''; entryUnits.value='';
  entryBPC.disabled = true; searchDescInput.value=''; searchResults.classList.remove('show'); searchResults.innerHTML='';
}
function updateUnits(){
  const bpc = Number(entryBPC.value||0);
  const cases = Number(entryCases.value||0);
  entryUnits.value = (Number.isFinite(bpc) && Number.isFinite(cases)) ? (bpc * cases) : '';
}
entryCases.addEventListener('input', updateUnits);

// Ensure bpc exists
async function ensureBPCFor(itemNo){
  const existing = await getBPC(itemNo);
  if (existing !== null) return existing;
  while (true){
    const inp = window.prompt(`Enter bts/case for Item No. ${itemNo}`, '');
    if (inp === null) throw new Error('bpc required');
    const n = Number(inp);
    if (Number.isInteger(n) && n >= 1){
      await setBPC(itemNo, n);
      return n;
    }
    alert('Please enter a whole number ≥ 1.');
  }
}

// Prepopulate if already on pallet
async function selectCatalogRecord(rec){
  try {
    const bpc = await ensureBPCFor(rec.itemNo);
    entryItemNo.value = rec.itemNo || '';
    entryDesc.value = rec.description || '';
    entryBPC.value = bpc;
    entryBPC.disabled = true;

    const existing = workingLines.find(l => l.itemNo === rec.itemNo);
    if (existing){
      entryCases.value = existing.cases ?? '';
      entryUnits.value = (Number(bpc) * Number(existing.cases || 0)) || '';
    } else {
      entryCases.value=''; entryUnits.value='';
    }
  } catch (e) {}
}

async function handleLoadPallet(){
  const pc = await getPalletCount();
  const n = Number(palletNumberInput.value);
  if (!pc){ alert('Please set total pallets first.'); return; }
  if (!Number.isInteger(n) || n<1 || n>pc){ alert(`Pallet must be between 1 and ${pc}.`); return; }
  currentPallet = n;
  currentPalletLabel.textContent = String(n);
  workingLines = await loadLocation(n);
  updatedSession = new Set();
  renderWorkingTable();
  try{ const rec=await getLocationRecord(n); const meta=document.getElementById('pallet-meta'); if (meta){ meta.textContent = (rec&&rec.savedBy&&rec.savedAt) ? `Last saved by ${rec.savedBy} on ${formatUS_EST(rec.savedAt)}` : ''; } }catch{}
  markClean();
  workbenchSection.scrollIntoView({ behavior:'smooth', block:'start' });
}
document.getElementById('btn-load-pallet').addEventListener('click', handleLoadPallet);
document.getElementById('btn-clear-indicators').addEventListener('click', ()=>{
  updatedSession = new Set();
  renderWorkingTable();
});

// Add/Update line
btnAddLine.addEventListener('click', async ()=>{
  if (!currentPallet){ alert('Load a pallet location first.'); return; }
  const itemNo = entryItemNo.value.trim();
  const desc = entryDesc.value.trim();
  const bpc = Number(entryBPC.value);
  const cases = Number(entryCases.value);
  if (!itemNo || !desc){ alert('Select an item.'); return; }
  if (!Number.isInteger(bpc) || bpc < 1){ alert('bts/case missing.'); return; }
  if (!Number.isFinite(cases)){ alert('Enter total case qty.'); return; }
  const units = bpc * cases;

  const idx = workingLines.findIndex(l => l.itemNo === itemNo);
  if (idx >= 0){ workingLines[idx] = { itemNo, description: desc, bpc, cases, units }; }
  else { workingLines.push({ itemNo, description: desc, bpc, cases, units }); }
  renderWorkingTable();
  clearEntry();
  markDirty();
});
btnClearLine.addEventListener('click', clearEntry);

btnSave.addEventListener('click', async ()=>{
  if (!currentPallet){ alert('Load a pallet location first.'); return; }
  await saveLocation(currentPallet, workingLines);
  alert('Saved. Previous data for this pallet location has been overwritten.');
  markClean();
});
btnClearLocation.addEventListener('click', async ()=>{
  if (!currentPallet){ alert('Load a pallet location first.'); return; }
  const ok = confirm('Clear all items from this location? This cannot be undone.');
  if (!ok) return;
  await clearLocation(currentPallet);
  workingLines = [];
  updatedSession = new Set();
  renderWorkingTable();
  markDirty();
});

// Pallet count UI
async function refreshPalletCountStatus(){
  const n = await getPalletCount();
  const palletCountInput = document.getElementById('pallet-count-input');
  const palletCountStatus = document.getElementById('pallet-count-status');
  const savePalletCountBtn = document.getElementById('save-pallet-count');
  if (n){
    palletCountInput.value = n;
    palletCountStatus.textContent = `Locked at ${n} pallets.`;
    palletCountInput.disabled = true;
    savePalletCountBtn.disabled = true;
  } else {
    palletCountStatus.textContent = 'Not set yet.';
  }
}
document.getElementById('save-pallet-count').addEventListener('click', async ()=>{
  const palletCountInput = document.getElementById('pallet-count-input');
  const palletCountStatus = document.getElementById('pallet-count-status');
  const n = Number(palletCountInput.value);
  if (!Number.isInteger(n) || n<1){ alert('Enter a valid whole number ≥ 1.'); return; }
  try {
    await setPalletCount(n);
    palletCountStatus.textContent = `Locked at ${n} pallets.`;
    palletCountInput.disabled = true;
    document.getElementById('save-pallet-count').disabled = true;
  } catch {
    palletCountStatus.textContent = 'Pallet count already set. This cannot be changed.';
    palletCountInput.disabled = true;
    document.getElementById('save-pallet-count').disabled = true;
  }
});

// Catalog import (xls/xlsx/csv)
document.getElementById('catalog-file').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  let rows = [];
  try {
    if (name.endsWith('.xlsx') || name.endsWith('.xls')){
      if (window.XLSX){
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type:'array' });
        const first = wb.SheetNames[0];
        const sheet = wb.Sheets[first];
        rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:false });
      } else { alert('Excel parser not available. Use CSV or connect to the internet.'); return; }
    } else {
      const text = await file.text();
      rows = parseCSV(text);
    }
    if (rows.length && Array.isArray(rows[0])){
      const head = rows[0].map(s=>String(s||'').toLowerCase());
      if (head.includes('item no.') || head.includes('item no') || head.includes('description')) rows.shift();
    }
    const imported = await importCatalog(rows);
    document.getElementById('catalog-status').textContent = `Imported ${imported} rows.`;
  } catch (err){
    console.error(err);
    alert('Failed to import. If the .xls is very old or password-protected, try re-saving as .xlsx or CSV.');
  } finally { e.target.value=''; }
});
document.getElementById('btn-clear-catalog').addEventListener('click', async ()=>{
  await clearCatalog();
  document.getElementById('catalog-status').textContent = 'Catalog cleared.';
});

function parseCSV(text){
  const rows=[];
  let cur=[], field='', inQuotes=false;
  for (let i=0; i<text.length; i++){
    const c=text[i];
    if (c==='"'){
      if (inQuotes && text[i+1]==='"'){ field+='"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c===',' && !inQuotes){
      cur.push(field); field='';
    } else if ((c==='\n' || c==='\r') && !inQuotes){
      if (field!=='' || cur.length){ cur.push(field); rows.push(cur); cur=[]; field=''; }
      if (c==='\r' && text[i+1]==='\n') i++;
    } else { field += c; }
  }
  if (field!=='' || cur.length){ cur.push(field); rows.push(cur); }
  return rows;
}

// ---------- Admin (Edit BPC) ----------
async function runAdminSearch(){
  const q = (document.getElementById('admin-search').value || '').trim().toLowerCase();
  const rows = await iterCatalogAll();
  let results = rows;
  if (q){
    results = rows.filter(r => r.itemNo.toLowerCase().includes(q) || (r.description||'').toLowerCase().includes(q));
  }
  results = results.slice(0, 200);
  const tbody = document.querySelector('#admin-table tbody');
  tbody.innerHTML = '';
  for (const r of results){
    const currentBpc = await getBPC(r.itemNo);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge">${escapeHTML(r.itemNo)}</span></td>
      <td>${escapeHTML(r.description || '')}</td>
      <td>${escapeHTML(r.packSizeRaw || '-')}</td>
      <td><input type="number" min="1" step="1" value="${currentBpc ?? ''}" style="width:120px" data-bpc-for="${escapeHTML(r.itemNo)}"></td>
      <td>
        <button class="btn success" data-save="${escapeHTML(r.itemNo)}">Save & Cascade</button>
        <button class="btn danger" data-remove="${escapeHTML(r.itemNo)}">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  // Save & Cascade
  tbody.querySelectorAll('button[data-save]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const itemNo = btn.getAttribute('data-save');
      const input = tbody.querySelector(`input[data-bpc-for="${CSS.escape(itemNo)}"]`);
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 1){ alert('Enter a whole number ≥ 1'); return; }
      const ok = confirm(`Set bts/case = ${n} for Item No. ${itemNo}?
This will update all saved pallets.`);
      if (!ok) return;
      await setBPC(itemNo, n);
      // Update current workingLines instantly; mark rows updated for this session
      let changed=false;
      workingLines = workingLines.map(line => {
        if (line.itemNo === itemNo){
          changed = true;
          const cases = Number(line.cases||0);
          updatedSession.add(itemNo);
          return { ...line, bpc:n, units: n*cases };
        }
        return line;
      });
      if (changed) renderWorkingTable();
      await updateAllLocationsForItemNo(itemNo, n);
      alert('Saved and updated across pallets. Rows on this pallet are marked as "updated" for this session.');
    });
  });
  // Remove BPC
  tbody.querySelectorAll('button[data-remove]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const itemNo = btn.getAttribute('data-remove');
      const ok = confirm(`Remove stored bts/case for Item No. ${itemNo}? Users will be prompted next time.`);
      if (!ok) return;
      await deleteBPC(itemNo);
      const input = tbody.querySelector(`input[data-bpc-for="${CSS.escape(itemNo)}"]`);
      if (input) input.value='';
      alert('Removed. Next use will prompt for bts/case.');
    });
  });
}
document.getElementById('admin-search-btn').addEventListener('click', runAdminSearch);
document.getElementById('admin-clear-btn').addEventListener('click', ()=>{
  document.getElementById('admin-search').value='';
  document.querySelector('#admin-table tbody').innerHTML='';
});

// ---------- Global pallet search UI (with Jump from v1.5.1) ----------
document.getElementById('btn-search-all').addEventListener('click', async ()=>{
  const q = (searchAllDesc.value || '').trim();
  if (!q){ searchAllBody.innerHTML = ''; const _sumEl=document.getElementById('search-all-summary'); if (_sumEl) _sumEl.innerHTML=''; return; }
  const rows = await searchSavedPalletsByDescription(q);
  if (!rows.length){
    searchAllBody.innerHTML = '<tr><td colspan="7" class="muted">No matches in saved pallets.</td></tr>'; const _sumEl=document.getElementById('search-all-summary'); if (_sumEl) _sumEl.innerHTML='';
    return;
  }
  rows.sort((a,b)=> (String(a.pallet).localeCompare(String(b.pallet)) || (a.description||'').localeCompare(b.description||'')));
  searchAllBody.innerHTML = rows.map(r=>`
    <tr>
      <td><span class="badge">${escapeHTML(r.itemNo)}</span></td>
      <td>${escapeHTML(r.description || '')}</td>
      <td>${escapeHTML(String(r.pallet))}</td>
      <td>${escapeHTML(String(r.bpc))}</td>
      <td>${escapeHTML(String(r.cases))}</td>
      <td>${escapeHTML(String(r.units))}</td>
      <td><button class="btn" data-jumppallet="${escapeHTML(String(r.pallet))}">Jump to pallet</button></td>
    </tr>
  `).join('');

  
  // totals summary
  const totalUnits = rows.reduce((sum, r) => sum + (Number(r.units)||0), 0);
  const summaryEl = document.getElementById('search-all-summary');
  if (summaryEl) summaryEl.innerHTML = `<span class="total-summary">TOTAL UNITS: ${totalUnits.toLocaleString()}</span>`;
// bind jump buttons
  searchAllBody.querySelectorAll('button[data-jumppallet]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const target = Number(btn.getAttribute('data-jumppallet'));
      if (!Number.isInteger(target)) return;
      if (isDirty){
        const ok = confirm('You have unsaved changes on the current pallet. Continue without saving?');
        if (!ok) return;
      }
      palletNumberInput.value = String(target);
      await handleLoadPallet();
      workbenchSection.scrollIntoView({ behavior:'smooth', block:'start' });
    });
  });
});
document.getElementById('btn-search-all-clear').addEventListener('click', ()=>{
  searchAllDesc.value='';
  searchAllBody.innerHTML='';
});

// Hide dropdown when clicking outside
document.addEventListener('click', (e)=>{
  if (!searchResults.contains(e.target) && e.target !== searchDescInput){
    searchResults.classList.remove('show');
  }
});


// Show dropdown beneath input on typing + keyboard nav
let searchTimer=null;
let suggActiveIndex = -1; // -1 means none
function renderSuggestions(res){
  searchResults.innerHTML = res.map((r, i)=>`
    <div data-index="${i}" data-item='${JSON.stringify(r).replace(/'/g, "&apos;")}'>
      <div><strong>${escapeHTML(r.description || '')}</strong></div>
      <div class="muted small">Item No. ${escapeHTML(r.itemNo)}</div>
      <div class="muted small">Pack Size: ${escapeHTML(r.packSizeRaw || '-')}</div>
    </div>
  `).join('');
  searchResults.classList.add('show');
  suggActiveIndex = res.length ? 0 : -1;
  updateActiveSuggestion();
  // Bind mouse behaviors
  searchResults.querySelectorAll('div[data-item]').forEach(div=>{
    div.addEventListener('mouseenter', ()=>{
      const i = Number(div.getAttribute('data-index'));
      suggActiveIndex = i;
      updateActiveSuggestion();
    });
    div.addEventListener('click', async ()=>{
      await pickActiveSuggestion();
    });
  });
}
function updateActiveSuggestion(){
  const items = Array.from(searchResults.querySelectorAll('div[data-item]'));
  items.forEach((d, idx)=>{
    if (idx === suggActiveIndex) d.classList.add('active');
    else d.classList.remove('active');
  });
  // ensure visible
  const active = items[suggActiveIndex];
  if (active){
    const parent = searchResults;
    const aTop = active.offsetTop;
    const aBottom = aTop + active.offsetHeight;
    if (aTop < parent.scrollTop) parent.scrollTop = aTop;
    else if (aBottom > parent.scrollTop + parent.clientHeight) parent.scrollTop = aBottom - parent.clientHeight;
  }
}
async function pickActiveSuggestion(){
  const active = searchResults.querySelector('div[data-item].active');
  if (!active) return;
  const rec = JSON.parse(active.getAttribute('data-item').replace(/&apos;/g, "'"));
  await selectCatalogRecord(rec);
  searchResults.classList.remove('show');
}
searchDescInput.addEventListener('input', ()=>{
  const q = searchDescInput.value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (!q){ searchResults.classList.remove('show'); searchResults.innerHTML=''; return; }
  searchTimer = setTimeout(async ()=>{
    const res = await searchByDescription(q, 50);
    renderSuggestions(res);
  }, 200);
});
searchDescInput.addEventListener('keydown', async (e)=>{
  if (!searchResults.classList.contains('show')) return;
  const items = searchResults.querySelectorAll('div[data-item]');
  if (!items.length) return;
  if (e.key === 'ArrowDown'){
    e.preventDefault();
    suggActiveIndex = (suggActiveIndex + 1) % items.length;
    updateActiveSuggestion();
  } else if (e.key === 'ArrowUp'){
    e.preventDefault();
    suggActiveIndex = (suggActiveIndex - 1 + items.length) % items.length;
    updateActiveSuggestion();
  } else if (e.key === 'Enter'){
    e.preventDefault();
    await pickActiveSuggestion();
  } else if (e.key === 'Escape'){
    e.preventDefault();
    searchResults.classList.remove('show');
  }
});


// ---- Global search typeahead (catalog-based) ----
const searchAllInput = document.getElementById('search-all-desc');
const searchAllDrop = document.getElementById('search-all-results');
let searchAllTimer=null;
let searchAllActiveIndex = -1;
let searchAllLastResults = [];

function searchAllRenderSuggestions(res){
  searchAllLastResults = res;
  if (!res.length){ searchAllDrop.classList.remove('show'); searchAllDrop.innerHTML=''; return; }
  searchAllDrop.innerHTML = res.map((r,i)=>`
    <div data-index="${i}" data-desc="${(r.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}">
      <div><strong>${(r.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong></div>
      <div class="muted small">Item No. ${(r.itemNo||'')}</div>
      <div class="muted small">Pack Size: ${(r.packSizeRaw||'-')}</div>
    </div>
  `).join('');
  searchAllDrop.classList.add('show');
  searchAllActiveIndex = 0;
  searchAllUpdateActive();
  Array.from(searchAllDrop.querySelectorAll('div[data-index]')).forEach(div=>{
    div.addEventListener('mouseenter', ()=>{
      searchAllActiveIndex = Number(div.getAttribute('data-index'));
      searchAllUpdateActive();
    });
    div.addEventListener('click', async ()=>{ await searchAllPickActive(); });
  });
}
function searchAllUpdateActive(){
  const items = Array.from(searchAllDrop.querySelectorAll('div[data-index]'));
  items.forEach((d,idx)=>{
    if (idx===searchAllActiveIndex) d.classList.add('active'); else d.classList.remove('active');
  });
  const active = items[searchAllActiveIndex];
  if (active){
    const parent = searchAllDrop;
    const top = active.offsetTop, bottom = top + active.offsetHeight;
    if (top < parent.scrollTop) parent.scrollTop = top;
    else if (bottom > parent.scrollTop + parent.clientHeight) parent.scrollTop = bottom - parent.clientHeight;
  }
}
async function searchAllPickActive(){
  const active = searchAllDrop.querySelector('div.active');
  if (!active) return;
  const desc = active.getAttribute('data-desc');
  // Set the input to exact description and run exact search
  searchAllInput.value = desc;
  searchAllDrop.classList.remove('show');
  const rows = await searchSavedPalletsByExactDescription(desc);
  if (!rows.length){
    searchAllBody.innerHTML = '<tr><td colspan="7" class="muted">No matches in saved pallets.</td></tr>';
    const _sumEl=document.getElementById('search-all-summary'); if (_sumEl) _sumEl.innerHTML='';
    return;
  }
  rows.sort((a,b)=> (String(a.pallet).localeCompare(String(b.pallet)) || (a.description||'').localeCompare(b.description||'')));
  searchAllBody.innerHTML = rows.map(r=>`
    <tr>
      <td><span class="badge">${(r.itemNo||'')}</span></td>
      <td>${(r.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
      <td>${String(r.pallet)}</td>
      <td>${String(r.bpc)}</td>
      <td>${String(r.cases)}</td>
      <td>${String(r.units)}</td>
      <td><button class="btn" data-jumppallet="${String(r.pallet)}">Jump to pallet</button></td>
    </tr>
  `).join('');
  // totals summary
  const totalUnits = rows.reduce((sum, r) => sum + (Number(r.units)||0), 0);
  const summaryEl = document.getElementById('search-all-summary');
  if (summaryEl) summaryEl.innerHTML = `<span class="total-summary">TOTAL UNITS: ${totalUnits.toLocaleString()}</span>`;

  // bind jump buttons
  searchAllBody.querySelectorAll('button[data-jumppallet]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const target = Number(btn.getAttribute('data-jumppallet'));
      if (!Number.isInteger(target)) return;
      if (isDirty){
        const ok = confirm('You have unsaved changes on the current pallet. Continue without saving?');
        if (!ok) return;
      }
      palletNumberInput.value = String(target);
      await handleLoadPallet();
      workbenchSection.scrollIntoView({ behavior:'smooth', block:'start' });
    });
  });
}

searchAllInput.addEventListener('input', ()=>{
  const q = searchAllInput.value.trim();
  if (searchAllTimer) clearTimeout(searchAllTimer);
  if (!q){ searchAllDrop.classList.remove('show'); searchAllDrop.innerHTML=''; return; }
  searchAllTimer = setTimeout(async ()=>{
    const res = await searchByDescription(q, 50);
    searchAllRenderSuggestions(res);
  }, 200);
});
searchAllInput.addEventListener('keydown', async (e)=>{
  if (!searchAllDrop.classList.contains('show')) return;
  const items = searchAllDrop.querySelectorAll('div[data-index]');
  if (!items.length) return;
  if (e.key === 'ArrowDown'){
    e.preventDefault();
    searchAllActiveIndex = (searchAllActiveIndex + 1) % items.length;
    searchAllUpdateActive();
  } else if (e.key === 'ArrowUp'){
    e.preventDefault();
    searchAllActiveIndex = (searchAllActiveIndex - 1 + items.length) % items.length;
    searchAllUpdateActive();
  } else if (e.key === 'Enter'){
    e.preventDefault();
    await searchAllPickActive();
  } else if (e.key === 'Escape'){
    e.preventDefault();
    searchAllDrop.classList.remove('show');
  }
});
document.addEventListener('click', (e)=>{
  if (!searchAllDrop.contains(e.target) && e.target !== searchAllInput){
    searchAllDrop.classList.remove('show');
  }
});

// ---------- Backup/Restore ----------
document.getElementById('btn-export').addEventListener('click', exportAll);
document.getElementById('restore-file').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await restoreAll(data);
    alert('Restore complete.');
    workingLines = [];
    updatedSession = new Set();
    renderWorkingTable();
    markClean();
    await refreshPalletCountStatus();
    await updateSecurityUI();
  } catch (err){
    console.error(err);
    alert('Restore failed: invalid file.');
  } finally { e.target.value=''; }
});

async function exportAll() {
  const out = { config:{}, catalog:[], locations:[], bpc:[] };
  out.config.palletCount = await getPalletCount();
  out.config.adminPassHash = await getAdminHash();

  await new Promise((r)=>{
    const { stores:[catalog] } = tx(['catalog']);
    const arr=[]; const c = catalog.openCursor(); c.onsuccess=(e)=>{ const cur=e.target.result; if(cur){ arr.push(cur.value); cur.continue(); } else { out.catalog=arr; r(); } };
  });
  await new Promise((r)=>{
    const { stores:[locations] } = tx(['locations']);
    const arr=[]; const c = locations.openCursor(); c.onsuccess=(e)=>{ const cur=e.target.result; if(cur){ arr.push(cur.value); cur.continue(); } else { out.locations=arr; r(); } };
  });
  await new Promise((r)=>{
    const { stores:[bpc] } = tx(['bpc']);
    const arr=[]; const c = bpc.openCursor(); c.onsuccess=(e)=>{ const cur=e.target.result; if(cur){ arr.push(cur.value); cur.continue(); } else { out.bpc=arr; r(); } };
  });

  const blob = new Blob([JSON.stringify(out,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='warehouse_backup_v1_5_2.json'; a.click();
  URL.revokeObjectURL(url);
}
async function restoreAll(data){
  await new Promise((resolve,reject)=>{
    const t = db.transaction(['config','catalog','locations','bpc'],'readwrite');
    t.objectStore('config').clear();
    t.objectStore('catalog').clear();
    t.objectStore('locations').clear();
    t.objectStore('bpc').clear();
    t.oncomplete = resolve; t.onerror = ()=>reject(t.error);
  });
  if (data.config){
    if (data.config.palletCount !== undefined && data.config.palletCount !== null){
      await setConfig('palletCount', data.config.palletCount);
    }
    if (data.config.adminPassHash){
      await setConfig('adminPassHash', data.config.adminPassHash);
    }
  }
  if (Array.isArray(data.catalog)){
    await new Promise((r)=>{
      const t = db.transaction(['catalog'],'readwrite');
      const s = t.objectStore('catalog');
      data.catalog.forEach(v=>s.put(v));
      t.oncomplete = r;
    });
  }
  if (Array.isArray(data.locations)){
    await new Promise((r)=>{
      const t = db.transaction(['locations'],'readwrite');
      const s = t.objectStore('locations');
      data.locations.forEach(v=>s.put(v));
      t.oncomplete = r;
    });
  }
  if (Array.isArray(data.bpc)){
    await new Promise((r)=>{
      const t = db.transaction(['bpc'],'readwrite');
      const s = t.objectStore('bpc');
      data.bpc.forEach(v=>s.put(v));
      t.oncomplete = r;
    });
  }
}

// ---------- Init ----------
(async function init(){
  db = await openDB();
  await refreshPalletCountStatus();
  await updateSecurityUI();
  markClean();
})();

// Exact description search across saved pallets
async function searchSavedPalletsByExactDescription(desc){
  const target = (desc || '').trim();
  if (!target) return [];
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['locations'],'readonly');
    const store = t.objectStore('locations');
    const req = store.openCursor();
    const rows = [];
    req.onsuccess = (e)=>{
      const cur = e.target.result;
      if (cur){
        const pallet = cur.value.pallet;
        const items = cur.value.items || [];
        items.forEach(line => {
          if ((line.description || '') === target){
            rows.push({
              pallet,
              itemNo: line.itemNo,
              description: line.description,
              bpc: line.bpc ?? '',
              cases: line.cases ?? '',
              units: line.units ?? ''
            });
          }
        });
        cur.continue();
      } else resolve(rows);
    };
    req.onerror = ()=>reject(req.error);
  });
}

function formatUS_EST(iso){
  try{
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true
    }).formatToParts(d).reduce((a,p)=>{ a[p.type]=p.value; return a; }, {});
    return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  }catch(e){ return iso || ''; }
}

async function getLocationRecord(pallet){
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['locations'],'readonly');
    const s = t.objectStore('locations');
    const req = s.get(String(pallet));
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> reject(req.error);
  });
}
async function putLocationRecord(rec){
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['locations'],'readwrite');
    const s = t.objectStore('locations');
    const req = s.put(rec);
    req.onsuccess = ()=> resolve(true);
    req.onerror = ()=> reject(req.error);
  });
}

try {
  btnSave.addEventListener('click', async ()=>{
    if (!currentPallet){ alert('Load a pallet location first.'); return; }
    const employee = (prompt('Employee name for this save?') || '').trim();
    if (!employee){ alert('Employee name is required.'); return; }
    const nowIso = new Date().toISOString();
    let rec = await getLocationRecord(currentPallet);
    if (!rec) rec = { pallet:String(currentPallet), items:[] };
    if (!Array.isArray(rec.history)) rec.history = [];
    rec.items = workingLines;
    rec.savedBy = employee;
    rec.savedAt = nowIso;
    rec.history.push({ savedBy: employee, savedAt: nowIso });
    if (rec.history.length > 500) rec.history = rec.history.slice(-500);
    await putLocationRecord(rec);
    const meta = document.getElementById('pallet-meta');
    if (meta) meta.textContent = `Last saved by ${employee} on ${formatUS_EST(nowIso)}`;
    alert('Saved. Previous data for this pallet location has been overwritten.');
    markClean();
  });
} catch {}

async function getPastWeekHistory(pallet){
  const rec = await getLocationRecord(pallet);
  const hist = Array.isArray(rec?.history) ? rec.history.slice() : [];
  const now = Date.now();
  const week = 7*24*60*60*1000;
  return hist.filter(h=>{
    const t = Date.parse(h.savedAt || '');
    return Number.isFinite(t) && (now - t) <= week;
  }).sort((a,b)=> (Date.parse(b.savedAt||0) - Date.parse(a.savedAt||0)));
}
(function(){
  const btn = document.getElementById('btn-week-log');
  const modal = document.getElementById('week-log-modal');
  const closeBtn = document.getElementById('week-log-close');
  const box = document.getElementById('week-log-content');
  if (btn && modal && closeBtn && box){
    btn.addEventListener('click', async ()=>{
      if (!currentPallet){ alert('Load a pallet location first.'); return; }
      const rows = await getPastWeekHistory(currentPallet);
      if (!rows.length){
        box.innerHTML = '<div class="muted">No edits in the past 7 days.</div>';
      } else {
        box.innerHTML = rows.map(h=> `<div style="padding:.25rem 0;border-bottom:1px solid rgba(255,255,255,.08)"><strong>${formatUS_EST(h.savedAt)}</strong> — ${String(h.savedBy||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join('');
      }
      modal.style.display='flex';
    });
    closeBtn.addEventListener('click', ()=> modal.style.display='none');
    modal.addEventListener('click', (e)=>{ if (e.target===modal) modal.style.display='none'; });
  }
})();

// ---------- Breakers (Log & Report, units-based) ----------
function addBreakerEntry(entry){
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['breakers'],'readwrite');
    const store = t.objectStore('breakers');
    const req = store.add(entry);
    req.onsuccess = ()=> resolve(true);
    req.onerror = ()=> reject(req.error);
  });
}

function getBreakersInRange(startDateStr, endDateStr){
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['breakers'],'readonly');
    const store = t.objectStore('breakers');
    const req = store.openCursor();
    const rows = [];
    const startTime = startDateStr ? Date.parse(startDateStr + 'T00:00:00') : null;
    const endTime = endDateStr ? Date.parse(endDateStr + 'T23:59:59') : null;
    req.onsuccess = (e)=>{
      const cur = e.target.result;
      if (cur){
        const val = cur.value || {};
        const raw = val.whenIso || '';
        if (!raw){ cur.continue(); return; }
        const tms = Date.parse(raw.length > 10 ? raw : raw + 'T12:00:00');
        if (!Number.isFinite(tms) ||
            (startTime !== null && tms < startTime) ||
            (endTime !== null && tms > endTime)){
          cur.continue();
          return;
        }
        rows.push(val);
        cur.continue();
      } else {
        rows.sort((a,b)=> (Date.parse(b.whenIso||0) - Date.parse(a.whenIso||0)));
        resolve(rows);
      }
    };
    req.onerror = ()=> reject(req.error);
  });
}

function getRecentBreakers(limit){
  return new Promise((resolve, reject)=>{
    const t = db.transaction(['breakers'],'readonly');
    const store = t.objectStore('breakers');
    const req = store.openCursor();
    const rows = [];
    req.onsuccess = (e)=>{
      const cur = e.target.result;
      if (cur){
        rows.push(cur.value);
        cur.continue();
      } else {
        const max = limit || 20;
        const len = rows.length;
        const trimmed = len > max ? rows.slice(len - max) : rows;
        resolve(trimmed);
      }
    };
    req.onerror = ()=> reject(req.error);
  });
}

(function(){
  const breakersSearchInput = document.getElementById('breakers-search');
  const breakersSearchDrop = document.getElementById('breakers-search-results');
  const breakersItemNo = document.getElementById('breakers-itemno');
  const breakersDesc = document.getElementById('breakers-desc');
  const breakersBpc = null;
  const breakersUnits = document.getElementById('breakers-units');
  const breakersCategory = document.getElementById('breakers-category');
  const breakersEmployee = document.getElementById('breakers-employee');
  const breakersDate = document.getElementById('breakers-date');
  const btnBreakersSave = document.getElementById('btn-breakers-save');
  const breakersRecentBody = document.getElementById('breakers-recent-body');
  const breakersFrom = document.getElementById('breakers-from');
  const breakersTo = document.getElementById('breakers-to');
  const btnBreakersRun = document.getElementById('btn-breakers-run');
  const btnBreakersExport = document.getElementById('btn-breakers-export');
  const btnBreakersClear = document.getElementById('btn-breakers-clear');
  const breakersReportBody = document.getElementById('breakers-report-body');
  const breakersReportSummary = document.getElementById('breakers-report-summary');
  const breakersTotalBroken = document.getElementById('breakers-total-broken');
  const breakersTotalSpoiled = document.getElementById('breakers-total-spoiled');
  const breakersTotalUnsellable = document.getElementById('breakers-total-unsellable');
  const btnBreakersTotalsSave = document.getElementById('btn-breakers-totals-save');

  if (!breakersSearchInput) return; // breakers UI not present

  // default dates (today)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  const todayStr = yyyy + "-" + mm + "-" + dd;
  if (breakersDate && !breakersDate.value) breakersDate.value = todayStr;
  if (breakersFrom && !breakersFrom.value) breakersFrom.value = todayStr;
  if (breakersTo && !breakersTo.value) breakersTo.value = todayStr;

  let totalsItemNo = null;
  let totalsPrevBroken = 0;
  let totalsPrevSpoiled = 0;
  let totalsPrevUnsellable = 0;

  async function refreshItemTotals(itemNo){
    if (!breakersTotalBroken || !breakersTotalSpoiled || !breakersTotalUnsellable){
      return;
    }
    totalsItemNo = itemNo || null;
    totalsPrevBroken = 0;
    totalsPrevSpoiled = 0;
    totalsPrevUnsellable = 0;
    if (!itemNo){
      breakersTotalBroken.value = "";
      breakersTotalSpoiled.value = "";
      breakersTotalUnsellable.value = "";
      return;
    }
    try{
      const rows = await getBreakersInRange("", "");
      let b = 0, s = 0, u = 0;
      rows.forEach(r=>{
        if ((r.itemNo || "") !== itemNo) return;
        const units = Number(r.units) || 0;
        const cat = (r.category || "").toLowerCase();
        if (cat === 'broken') b += units;
        else if (cat === 'spoiled') s += units;
        else u += units;
      });
      totalsPrevBroken = b;
      totalsPrevSpoiled = s;
      totalsPrevUnsellable = u;
      breakersTotalBroken.value = b;
      breakersTotalSpoiled.value = s;
      breakersTotalUnsellable.value = u;
    } catch(e){
      // ignore errors for totals
    }
  }

  let timer = null;
  let activeIndex = -1;

  function renderBreakersSuggestions(res){
    if (!res.length){
      breakersSearchDrop.classList.remove('show');
      breakersSearchDrop.innerHTML = "";
      activeIndex = -1;
      return;
    }
    breakersSearchDrop.innerHTML = res.map((r,i)=>{
      const esc = s => (s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
      const data = JSON.stringify({ itemNo: r.itemNo, description: r.description, packSizeRaw: r.packSizeRaw }).replace(/'/g,"&apos;");
      return "<div data-index=\"" + i + "\" data-item='" + data + "'>" +
        "<div><strong>" + esc(r.description||"") + "</strong></div>" +
        "<div class=\"muted small\">Item No. " + esc(r.itemNo||"") + "</div>" +
        "<div class=\"muted small\">Pack Size: " + esc(r.packSizeRaw||"-") + "</div>" +
      "</div>";
    }).join("");
    breakersSearchDrop.classList.add('show');
    activeIndex = 0;
    updateActive();
    Array.from(breakersSearchDrop.querySelectorAll('div[data-item]')).forEach(div=>{
      div.addEventListener('mouseenter', ()=>{
        activeIndex = Number(div.getAttribute('data-index'));
        updateActive();
      });
      div.addEventListener('click', ()=>{ pickActive(); });
    });
  }

  function updateActive(){
    const items = Array.from(breakersSearchDrop.querySelectorAll('div[data-item]'));
    items.forEach((d,idx)=>{
      if (idx===activeIndex) d.classList.add('active'); else d.classList.remove('active');
    });
    const active = items[activeIndex];
    if (active){
      const parent = breakersSearchDrop;
      const top = active.offsetTop, bottom = top+active.offsetHeight;
      if (top < parent.scrollTop) parent.scrollTop = top;
      else if (bottom > parent.scrollTop + parent.clientHeight) parent.scrollTop = bottom - parent.clientHeight;
    }
  }

  function pickActive(){
    const active = breakersSearchDrop.querySelector('div[data-item].active');
    if (!active) return;
    const rec = JSON.parse(active.getAttribute('data-item').replace(/&apos;/g,"'"));
    if (breakersItemNo) breakersItemNo.value = rec.itemNo || "";
    if (breakersDesc) breakersDesc.value = rec.description || "";
    breakersSearchDrop.classList.remove('show');
    // refresh admin totals for this item
    refreshItemTotals(rec.itemNo || "").catch(()=>{});
  }

  breakersSearchInput.addEventListener('input', ()=>{
    const q = breakersSearchInput.value.trim();
    if (timer) clearTimeout(timer);
    if (!q){
      breakersSearchDrop.classList.remove('show');
      breakersSearchDrop.innerHTML = "";
      return;
    }
    timer = setTimeout(async ()=>{
      const res = await searchByDescription(q, 50);
      renderBreakersSuggestions(res);
    }, 200);
  });

  breakersSearchInput.addEventListener('keydown', (e)=>{
    if (!breakersSearchDrop.classList.contains('show')) return;
    const items = breakersSearchDrop.querySelectorAll('div[data-item]');
    if (!items.length) return;
    if (e.key === 'ArrowDown'){
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActive();
    } else if (e.key === 'ArrowUp'){
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActive();
    } else if (e.key === 'Enter'){
      e.preventDefault();
      pickActive();
    } else if (e.key === 'Escape'){
      e.preventDefault();
      breakersSearchDrop.classList.remove('show');
    }
  });

  document.addEventListener('click', (e)=>{
    if (!breakersSearchDrop.contains(e.target) && e.target !== breakersSearchInput){
      breakersSearchDrop.classList.remove('show');
    }
  });

  if (btnBreakersSave){
    btnBreakersSave.addEventListener('click', async ()=>{
      const itemNo = (breakersItemNo && breakersItemNo.value || "").trim();
      const desc = (breakersDesc && breakersDesc.value || "").trim();
      const units = breakersUnits ? Number(breakersUnits.value || 0) : 0;
      const category = breakersCategory ? breakersCategory.value : "";
      const employee = (breakersEmployee && breakersEmployee.value || "").trim();
      const dateStr = breakersDate ? breakersDate.value : "";

      if (!itemNo || !desc){
        alert("Select an item from the catalog first.");
        return;
      }
      if (!Number.isInteger(units) || units <= 0){
        alert("Enter a whole number of units (bottles) greater than 0.");
        return;
      }
      if (!category){
        alert("Select a category.");
        return;
      }
      if (!employee){
        alert("Enter the employee responsible.");
        return;
      }
      if (!dateStr){
        alert("Select a date.");
        return;
      }

      const whenIso = dateStr; // store date only (YYYY-MM-DD)

      await addBreakerEntry({
        itemNo,
        description: desc,
        units,
        category,
        employee,
        whenIso
      });

      alert("Breaker entry saved.");
      if (breakersSearchInput) breakersSearchInput.value = "";
      if (breakersSearchDrop){ breakersSearchDrop.classList.remove('show'); breakersSearchDrop.innerHTML = ""; }
      if (breakersItemNo) breakersItemNo.value = "";
      if (breakersDesc) breakersDesc.value = "";
      if (breakersUnits) breakersUnits.value = "";
      if (breakersEmployee) breakersEmployee.value = "";
      if (breakersTotalBroken) breakersTotalBroken.value = "";
      if (breakersTotalSpoiled) breakersTotalSpoiled.value = "";
      if (breakersTotalUnsellable) breakersTotalUnsellable.value = "";
      if (breakersCategory) breakersCategory.value = "";
      if (breakersDate) breakersDate.value = "";
      refreshRecent().catch(()=>{});
    });
  }

  async function refreshRecent(){
    if (!breakersRecentBody) return;
    let rows = await getRecentBreakers(15);
    if (!rows.length){
      breakersRecentBody.innerHTML = '<tr><td colspan="6" class="muted">No breaker entries yet.</td></tr>';
      return;
    }
    // show newest to oldest while preserving consecutive insertion order
    rows = rows.slice().reverse();
    breakersRecentBody.innerHTML = rows.map(r=>{
      const esc = s => (s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;","&gt;":"&gt;"}[c]));
      const whenStr = r.whenIso ? new Date((r.whenIso.length > 10 ? r.whenIso : r.whenIso + "T00:00:00")).toLocaleDateString("en-US") : "";
      return "<tr>" +
        "<td><span class=\"badge\">" + esc(r.itemNo||"") + "</span></td>" +
        "<td>" + esc(r.description||"") + "</td>" +
        "<td>" + esc(r.category||"") + "</td>" +
        "<td>" + String(r.units||"") + "</td>" +
        "<td>" + esc(r.employee||"") + "</td>" +
        "<td>" + esc(whenStr) + "</td>" +
        "</tr>";
    }).join("");
  }

  if (btnBreakersRun){
    btnBreakersRun.addEventListener('click', async ()=>{
      const from = breakersFrom ? breakersFrom.value : "";
      const to = breakersTo ? breakersTo.value : "";
      const rows = await getBreakersInRange(from, to);
      if (!rows.length){
        if (breakersReportBody) breakersReportBody.innerHTML = '<tr><td colspan="10" class="muted">No breaker entries in this range.</td></tr>';
        if (breakersReportSummary) breakersReportSummary.textContent = "";
        return;
      }

      // Aggregate by itemNo + category
      const groups = {};
      rows.forEach(r=>{
        const key = r.itemNo || '(unknown)';
        if (!groups[key]){
          groups[key] = {
            itemNo: r.itemNo || '',
            description: r.description || '',
            broken: 0,
            spoiled: 0,
            unsellable: 0
          };
        }
        const g = groups[key];
        const u = Number(r.units) || 0;
        const cat = (r.category || '').toLowerCase();
        if (cat === 'broken') g.broken += u;
        else if (cat === 'spoiled') g.spoiled += u;
        else g.unsellable += u;
      });

      // Build catalog map for cost/ea, vendor, sales rep
      const catalogRows = await iterCatalogAll();
      const catalogMap = {};
      catalogRows.forEach(rec=>{
        if (rec && rec.itemNo) catalogMap[rec.itemNo] = rec;
      });

      const esc = s => (s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;","&gt;":"&gt;"}[c]));

      let totalBroken = 0;
      let totalSpoiled = 0;
      let totalUnsellable = 0;
      let grandTotalQty = 0;
      let grandTotalCost = 0;

      // Only include items with total quantity > 0
      const groupList = Object.values(groups).filter(g => {
        const tq = (g.broken || 0) + (g.spoiled || 0) + (g.unsellable || 0);
        return tq > 0;
      });

      if (!groupList.length){
        if (breakersReportBody) breakersReportBody.innerHTML = '<tr><td colspan="10" class="muted">No breaker entries with quantity &gt; 0 in this range.</td></tr>';
        if (breakersReportSummary) breakersReportSummary.textContent = "";
        return;
      }

      const rowsHtml = groupList.map(g=>{
        const catRec = catalogMap[g.itemNo] || {};
        let avgCost = catRec.avgCost;
        if (typeof avgCost !== 'number' || !Number.isFinite(avgCost)) avgCost = null;
        const vendor = catRec.vendor || '';
        const salesRep = catRec.salesRep || '';
        const totalQty = g.broken + g.spoiled + g.unsellable;
        const totalCost = avgCost != null ? avgCost * totalQty : null;

        totalBroken += g.broken;
        totalSpoiled += g.spoiled;
        totalUnsellable += g.unsellable;
        grandTotalQty += totalQty;
        if (totalCost != null) grandTotalCost += totalCost;

        return "<tr>" +
          "<td><span class=\"badge\">" + esc(g.itemNo||"") + "</span></td>" +
          "<td>" + esc(g.description||"") + "</td>" +
          "<td>" + (g.broken || 0) + "</td>" +
          "<td>" + (g.spoiled || 0) + "</td>" +
          "<td>" + (g.unsellable || 0) + "</td>" +
          "<td>" + totalQty + "</td>" +
          "<td>" + (avgCost != null ? avgCost.toFixed(2) : "") + "</td>" +
          "<td>" + (totalCost != null ? totalCost.toFixed(2) : "") + "</td>" +
          "<td>" + esc(salesRep) + "</td>" +
          "<td>" + esc(vendor) + "</td>" +
        "</tr>";
      }).join("");

      if (breakersReportBody) breakersReportBody.innerHTML = rowsHtml;

      if (breakersReportSummary){
        const parts = [
          "Broken: " + totalBroken + " units",
          "Spoiled: " + totalSpoiled + " units",
          "Unsellable: " + totalUnsellable + " units",
          "Total units: " + grandTotalQty
        ];
        const costPart = grandTotalCost ? "Estimated total cost: " + grandTotalCost.toFixed(2) : "";
        breakersReportSummary.textContent = "Totals — " + parts.join(" · ") + (costPart ? " · " + costPart : "");
      }
    });
  }

  if (btnBreakersClear){
    btnBreakersClear.addEventListener('click', ()=>{
      if (breakersFrom) breakersFrom.value = "";
      if (breakersTo) breakersTo.value = "";
      if (breakersReportBody) breakersReportBody.innerHTML = "";
      if (breakersReportSummary) breakersReportSummary.textContent = "";
    });
  }


  if (btnBreakersTotalsSave){
    btnBreakersTotalsSave.addEventListener('click', async ()=>{
      const itemNo = (breakersItemNo && breakersItemNo.value || "").trim();
      const desc = (breakersDesc && breakersDesc.value || "").trim();
      if (!itemNo || !desc){
        alert("Select an item from the catalog first.");
        return;
      }
      if (!adminUnlocked){
        alert("Admin must be unlocked to adjust totals.");
        return;
      }
      const newBroken = breakersTotalBroken ? Number(breakersTotalBroken.value || 0) : 0;
      const newSpoiled = breakersTotalSpoiled ? Number(breakersTotalSpoiled.value || 0) : 0;
      const newUnsellable = breakersTotalUnsellable ? Number(breakersTotalUnsellable.value || 0) : 0;
      const nums = [newBroken, newSpoiled, newUnsellable];
      if (!nums.every(n => Number.isInteger(n) && n >= 0)){
        alert("Totals must be whole numbers greater than or equal to 0.");
        return;
      }
      // If we never computed previous totals for this item, compute them now
      if (totalsItemNo !== itemNo){
        await refreshItemTotals(itemNo);
      }
      const deltaBroken = newBroken - totalsPrevBroken;
      const deltaSpoiled = newSpoiled - totalsPrevSpoiled;
      const deltaUnsellable = newUnsellable - totalsPrevUnsellable;
      if (deltaBroken === 0 && deltaSpoiled === 0 && deltaUnsellable === 0){
        alert("No changes to save.");
        return;
      }
      const employee = (breakersEmployee && breakersEmployee.value || "Admin adjustment").trim() || "Admin adjustment";
      const dateStr = breakersDate && breakersDate.value ? breakersDate.value : todayStr;
      const whenIso = dateStr;

      const tasks = [];
      function addDelta(units, category){
        if (!units) return;
        const entry = {
          itemNo,
          description: desc,
          units,
          category,
          employee,
          whenIso
        };
        tasks.push(addBreakerEntry(entry));
      }
      if (deltaBroken !== 0) addDelta(deltaBroken, 'broken');
      if (deltaSpoiled !== 0) addDelta(deltaSpoiled, 'spoiled');
      if (deltaUnsellable !== 0) addDelta(deltaUnsellable, 'unsellable');

      await Promise.all(tasks);
      await refreshItemTotals(itemNo);
      await refreshRecent();
      alert("Adjusted totals saved. Recent breaker entries include the adjustments.");
      if (breakersSearchInput) breakersSearchInput.value = "";
      if (breakersSearchDrop){ breakersSearchDrop.classList.remove('show'); breakersSearchDrop.innerHTML = ""; }
      if (breakersItemNo) breakersItemNo.value = "";
      if (breakersDesc) breakersDesc.value = "";
      if (breakersUnits) breakersUnits.value = "";
      if (breakersEmployee) breakersEmployee.value = "";
      if (breakersCategory) breakersCategory.value = "";
      if (breakersDate) breakersDate.value = "";
      if (breakersTotalBroken) breakersTotalBroken.value = "";
      if (breakersTotalSpoiled) breakersTotalSpoiled.value = "";
      if (breakersTotalUnsellable) breakersTotalUnsellable.value = "";
    });
  }


  refreshRecent().catch(()=>{});

  if (btnBreakersExport){
    btnBreakersExport.addEventListener('click', async ()=>{
      const from = breakersFrom ? breakersFrom.value : "";
      const to = breakersTo ? breakersTo.value : "";
      const rows = await getBreakersInRange(from, to);
      if (!rows.length){
        alert("No breaker entries in this range to export.");
        return;
      }

      // Aggregate by itemNo
      const groups = {};
      rows.forEach(r=>{
        const key = r.itemNo || '(unknown)';
        if (!groups[key]){
          groups[key] = {
            itemNo: r.itemNo || '',
            description: r.description || '',
            broken: 0,
            spoiled: 0,
            unsellable: 0
          };
        }
        const g = groups[key];
        const u = Number(r.units) || 0;
        const cat = (r.category || '').toLowerCase();
        if (cat === 'broken') g.broken += u;
        else if (cat === 'spoiled') g.spoiled += u;
        else g.unsellable += u;
      });

      // Catalog map for cost/vendor/salesRep
      const catalogRows = await iterCatalogAll();
      const catalogMap = {};
      catalogRows.forEach(rec=>{
        if (rec && rec.itemNo) catalogMap[rec.itemNo] = rec;
      });

      const header = ["Item No.", "Description", "Broken", "Spoiled", "Unsellable", "Total Qty", "Cost / Ea", "Total Cost", "Sales Rep", "Vendor"];
      const body = [];

      Object.values(groups).forEach(g=>{
        const catRec = catalogMap[g.itemNo] || {};
        let avgCost = catRec.avgCost;
        if (typeof avgCost !== 'number' || !Number.isFinite(avgCost)) avgCost = null;
        const vendor = catRec.vendor || '';
        const salesRep = catRec.salesRep || '';
        const totalQty = g.broken + g.spoiled + g.unsellable;
        const totalCost = avgCost != null ? avgCost * totalQty : null;

        body.push([
          g.itemNo || "",
          g.description || "",
          g.broken || 0,
          g.spoiled || 0,
          g.unsellable || 0,
          totalQty,
          avgCost != null ? Number(avgCost.toFixed(2)) : "",
          totalCost != null ? Number(totalCost.toFixed(2)) : "",
          salesRep,
          vendor
        ]);
      });

      const aoa = [header, ...body];
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // Auto-fit columns based on max content length
      const colWidths = [];
      aoa.forEach(row=>{
        row.forEach((val, idx)=>{
          const str = String(val ?? "");
          const len = str.length;
          colWidths[idx] = Math.max(colWidths[idx] || 10, len + 2);
        });
      });
      ws['!cols'] = colWidths.map(w => ({ wch: w }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Breakers Report");
      const safeFrom = from || "all";
      const safeTo = to || "all";
      const filename = "breakers_report_" + safeFrom.replace(/[^0-9A-Za-z_-]/g, '') + "_to_" + safeTo.replace(/[^0-9A-Za-z_-]/g, '') + ".xlsx";
      XLSX.writeFile(wb, filename);
    });
  }
})();

