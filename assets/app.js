// app.js (JP UI, light theme, mobile back camera + auto-start, CORS-safe POST, dashboard, QR+Barcode)

// ---------- helpers & state ----------
const $ = (id) => document.getElementById(id);
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const state = {
  stream: null,
  codeReader: null,
  lastText: null,
  scanning: false,
  queue: loadQueue(),
  chart: null
};

const ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.ENDPOINT) || "";

// ---------- barcode formats & hints (QR + 1D) ----------
const BARCODE_FORMATS = [
  ZXing.BarcodeFormat.QR_CODE,
  ZXing.BarcodeFormat.CODE_128,
  ZXing.BarcodeFormat.CODE_39,
  ZXing.BarcodeFormat.CODE_93,
  ZXing.BarcodeFormat.EAN_13,
  ZXing.BarcodeFormat.EAN_8,
  ZXing.BarcodeFormat.UPC_A,
  ZXing.BarcodeFormat.UPC_E,
  ZXing.BarcodeFormat.ITF,
  ZXing.BarcodeFormat.CODABAR
];

function makeHints(){
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, BARCODE_FORMATS);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return hints;
}

// ---------- small utils ----------
function loadQueue(){ try{ return JSON.parse(localStorage.getItem("qr_queue")||"[]") }catch(e){ return [] } }
function saveQueue(){ localStorage.setItem("qr_queue", JSON.stringify(state.queue)) }

function setStatus(text, cls){
  const b = $("statusBadge"); if(!b) return;
  b.innerHTML = `ステータス: <strong>${text}</strong>`;
  b.className = 'badge ' + (cls || '');
}
function setQueueBadge(){
  const el = $("queueBadge"); if(!el) return;
  el.innerText = 'キュー: ' + state.queue.length;
}

async function listCameras(){
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  const sel = $("cameraSelect"); if(!sel) return;
  sel.innerHTML='';
  devices.forEach((d,i)=>{ const o=document.createElement('option'); o.value=d.deviceId; o.text=d.label||`カメラ ${i+1}`; sel.appendChild(o) });
  if(devices.length===0){ const o=document.createElement('option'); o.text='（カメラが見つかりません）'; sel.appendChild(o) }
}

// ---------- camera / scanning ----------
async function startCamera(){
  stopCamera();
  setStatus(isMobile ? 'カメラ(背面)を起動中…' : 'カメラを起動中…');

  try{
    if(isMobile){
      // prefer exact back camera, fallback to ideal
      try {
        await startScanLoopWithConstraints({ video: { facingMode: { exact: 'environment' } } });
      } catch(_) {
        await startScanLoopWithConstraints({ video: { facingMode: 'environment' } });
      }
    }else{
      const deviceId = $("cameraSelect") ? $("cameraSelect").value : undefined;
      await startScanLoopWithDevice(deviceId);
    }
    setStatus('スキャン準備OK', 'ok');
    if ($("btnStart")) $("btnStart").disabled = true;
    if ($("btnStop"))  $("btnStop").disabled  = false;
  }catch(e){
    console.error(e);
    setStatus('カメラ起動に失敗', 'bad');
  }
}

function stopCamera(){
  if(state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null }
  if(state.scanning && state.codeReader){ try{ state.codeReader.reset() }catch(_){} }
  state.scanning=false;
  if ($("btnStart")) $("btnStart").disabled=false;
  if ($("btnStop"))  $("btnStop").disabled=true;
  setStatus('待機中');
}

async function startScanLoopWithConstraints(constraints){
  state.scanning = true;
  const codeReader = new ZXing.BrowserMultiFormatReader(makeHints());
  state.codeReader = codeReader;

  // preview stream
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $("video");
  if(video){
    video.srcObject = state.stream;
    video.onloadedmetadata = ()=> video.play();
  }

  await codeReader.decodeFromConstraints(
    constraints, 'video',
    (res)=>{
      if(!res) return;
      const fmt = getFormatName(res);
      onScan(res.getText(), fmt);
    }
  );
}

async function startScanLoopWithDevice(deviceId){
  state.scanning = true;
  const codeReader = new ZXing.BrowserMultiFormatReader(makeHints());
  state.codeReader = codeReader;

  await codeReader.decodeFromVideoDevice(
    deviceId || undefined, 'video',
    (res)=>{
      if(!res) return;
      const fmt = getFormatName(res);
      onScan(res.getText(), fmt);
    }
  );
}

// robustly extract format name from ZXing result
function getFormatName(res){
  try{
    if (res.getBarcodeFormat) return String(res.getBarcodeFormat());
    if (res.getResultMetadata && ZXing.ResultMetadataType && res.getResultMetadata().has(ZXing.ResultMetadataType.BARCODE_FORMAT)){
      return String(res.getResultMetadata().get(ZXing.ResultMetadataType.BARCODE_FORMAT));
    }
  }catch(_){}
  return 'UNKNOWN';
}

// ---------- scan handling ----------
function updateHistory(now, txt){
  const h = $("history"); if(!h) return;
  const cur = h.textContent.trim()==='(空)'?[]:h.textContent.split('\n');
  cur.unshift(`[${now}] ${txt.substring(0,120)}${txt.length>120?'…':''}`);
  h.textContent = cur.slice(0,20).join('\n');
}

async function onScan(txt, formatName){
  if(!txt || txt===state.lastText) return;
  state.lastText = txt;

  const resultEl = $("result"); if(resultEl) resultEl.textContent = txt;
  const metaEl = $("meta"); if(metaEl) metaEl.textContent = '種類: ' + (formatName || 'UNKNOWN');

  updateHistory(new Date().toLocaleString('ja-JP'), txt);

  if($("autoSave") && $("autoSave").checked){ await saveToSheets(txt, formatName || 'UNKNOWN') }
  if($("vibrate") && $("vibrate").checked && 'vibrate' in navigator){ navigator.vibrate(60) }

  try { await refreshDashboard(); } catch(_) {}
}

// ---------- backend I/O ----------
async function getGeo(){
  return new Promise((resolve)=>{
    if(!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      pos=> resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}),
      _=> resolve(null), {enableHighAccuracy:true, timeout:3000}
    )
  })
}

// POST using text/plain to avoid preflight CORS
async function saveToSheets(txt, type){
  const payload = {
    exhibition: $("exhibition")?.value.trim() || '(名称なし)',
    venue: $("venue")?.value.trim() || '',
    client_ts: new Date().toISOString(),
    data: txt,
    data_type: type, // e.g. QR_CODE, CODE_128, ...
    ua: navigator.userAgent,
  };
  const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng }

  try{
    setStatus('保存中…');
    const res = await fetch(ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const raw = await res.text();
    let j=null; try{ j=JSON.parse(raw) }catch(_){}
    if(res.ok && j && j.ok){ setStatus('保存しました', 'ok') }
    else { console.warn('backend response', res.status, raw); throw new Error('レスポンス不正') }
  }catch(e){
    console.warn('save failed, queued', e);
    state.queue.push(payload); saveQueue(); setQueueBadge(); setStatus('オフライン — キューに追加', 'warn');
  }
}

async function syncQueue(){
  if(state.queue.length===0) return setStatus('キューは空です')
  setStatus('同期中…')
  const batch = [...state.queue]
  for(const item of batch){
    try{
      const r = await fetch(ENDPOINT, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(item) })
      if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge() }
    }catch(_){ /* keep in queue */ }
  }
  setStatus('同期完了', 'ok')
}

// ---------- dashboard ----------
function ymd(d){ return d.toISOString().slice(0,10) }

async function fetchStats(days){
  const end = new Date();
  const start = new Date(); start.setDate(end.getDate() - (days-1));
  const qs = new URLSearchParams({ stats:'1', start: ymd(start), end: ymd(end), group:'daily' });
  const r = await fetch(`${ENDPOINT}?${qs.toString()}`, { method:'GET' });
  return r.json();
}

function renderChart(labels, data){
  const canvas = $("trendChart"); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  if(state.chart){ state.chart.destroy(); }
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Leads',
        data,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 3,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks:{ precision:0 } } },
      plugins: { legend: { display: false }, tooltip: { mode:'index', intersect:false } }
    }
  });
}

async function refreshDashboard(){
  const sel = $("rangeSelect");
  const days = parseInt((sel?.value)||'30',10);
  const res = await fetchStats(days);
  if(!res || !res.ok){ return; }

  if ($("totalLeads"))  $("totalLeads").textContent  = res.total || 0;
  if ($("uniqueLeads")) $("uniqueLeads").textContent = res.unique || 0;

  const labels = (res.series||[]).map(i=>i.date);
  const data   = (res.series||[]).map(i=>i.count);
  renderChart(labels, data);
}

// ---------- events ----------
if ($("btnStart")) $("btnStart").onclick = startCamera;
if ($("btnStop"))  $("btnStop").onclick  = stopCamera;
if ($("btnSave"))  $("btnSave").onclick  = ()=>{ const t=$("result")?.textContent; if(t&&t!=='— まだありません —') saveToSheets(t, 'MANUAL') };
if ($("btnCopy"))  $("btnCopy").onclick  = async ()=>{
  const t=$("result")?.textContent; if(!t||t==='— まだありません —') return;
  try{ await navigator.clipboard.writeText(t); setStatus('コピーしました', 'ok') }catch(_){ setStatus('コピー失敗', 'bad') }
};
if ($("btnSync"))  $("btnSync").onclick  = syncQueue;
if ($("rangeSelect")) $("rangeSelect").onchange = ()=> refreshDashboard();
if ($("btnDownload")) $("btnDownload").onclick = ()=>{
  const sel = $("rangeSelect");
  const days = parseInt((sel?.value)||'30',10);
  const end = new Date();
  const start = new Date(); start.setDate(end.getDate() - (days-1));
  const qs = new URLSearchParams({ download:'csv', start: ymd(start), end: ymd(end) });
  window.open(`${ENDPOINT}?${qs.toString()}`, '_blank');
};

// Auto-start: mobile always, desktop only if permission was granted
window.addEventListener('load', ()=>{
  (async ()=>{
    setQueueBadge();
    await listCameras();
    try{ await refreshDashboard(); }catch(_){}

    if(isMobile){
      startCamera();
    }else{
      try{
        if(navigator.permissions && navigator.permissions.query){
          const p = await navigator.permissions.query({name:'camera'});
          if(p.state==='granted'){ startCamera(); }
        }
      }catch(_){}
    }
  })();
});
