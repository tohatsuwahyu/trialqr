// app.js — fast camera start, autofocus/torch/zoom, QR + 1D barcodes, dashboard, JSONP fallback

const $ = (id) => document.getElementById(id);
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.ENDPOINT) || "";

const state = {
  stream: null,
  codeReader: null,
  lastText: null,
  scanning: false,
  queue: loadQueue(),
  chart: null
};

// ---------- queue helpers ----------
function loadQueue(){ try{ return JSON.parse(localStorage.getItem("qr_queue")||"[]") }catch(e){ return [] } }
function saveQueue(){ localStorage.setItem("qr_queue", JSON.stringify(state.queue)) }
function setStatus(text, cls){ const b=$("statusBadge"); if(!b) return; b.innerHTML=`ステータス: <strong>${text}</strong>`; b.className='badge '+(cls||''); }
function setQueueBadge(){ const el=$("queueBadge"); if(!el) return; el.innerText='キュー: '+state.queue.length; }

// ---------- ZXing formats & hints (QR + 1D) ----------
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
function makeHints(){ const h=new Map(); h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,BARCODE_FORMATS); h.set(ZXing.DecodeHintType.TRY_HARDER,true); return h; }

// ---------- camera device list ----------
async function listCameras(){
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  const sel = $("cameraSelect"); if(!sel) return;
  sel.innerHTML='';
  devices.forEach((d,i)=>{ const o=document.createElement('option'); o.value=d.deviceId; o.text=d.label||`カメラ ${i+1}`; sel.appendChild(o) });
  if(devices.length===0){ const o=document.createElement('option'); o.text='（カメラが見つかりません）'; sel.appendChild(o) }
}

// ---------- fast constraints & pipeline ----------
const BASE_CONSTRAINTS_ENV = {
  video: {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1280, max: 1920 },
    height: { ideal: 720,  max: 1080 },
    frameRate: { ideal: 30, max: 30 }
  }
};

async function startCamera(){
  stopCamera();
  setStatus(isMobile ? 'カメラ(背面)を起動中…' : 'カメラを起動中…');
  try{
    if(isMobile){
      try {
        await startScanLoopWithConstraints({ video: { ...BASE_CONSTRAINTS_ENV.video, facingMode:{ exact:'environment' } } });
      } catch(_) {
        await startScanLoopWithConstraints(BASE_CONSTRAINTS_ENV);
      }
    }else{
      const deviceId = $("cameraSelect")?.value || undefined;
      await startScanLoopWithDevice(deviceId);
    }
    await tuneTrackCapabilities(); // autofocus / torch / zoom if available
    setStatus('スキャン準備OK','ok');
    $("btnStart").disabled=true; $("btnStop").disabled=false;
  }catch(e){
    console.error(e);
    setStatus('カメラ起動に失敗','bad');
  }
}

function stopCamera(){
  if(state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null }
  if(state.scanning && state.codeReader){ try{ state.codeReader.reset() }catch(_){} }
  state.scanning=false;
  $("btnStart").disabled=false; $("btnStop").disabled=true;
  $("btnTorch").style.display='none';
  $("zoomWrap").style.display='none';
  setStatus('待機中');
}

async function startScanLoopWithConstraints(constraints){
  state.scanning=true;
  const reader = new ZXing.BrowserMultiFormatReader(makeHints());
  state.codeReader = reader;

  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $("video");
  if(video){ video.srcObject = state.stream; video.playsInline = true; if(video.paused) video.play().catch(()=>{}); }

  await reader.decodeFromConstraints(constraints,'video',(res)=>{ if(res){ onScan(res.getText(), getFormatName(res)); } });
}

async function startScanLoopWithDevice(deviceId){
  state.scanning=true;
  const reader = new ZXing.BrowserMultiFormatReader(makeHints());
  state.codeReader = reader;

  await reader.decodeFromVideoDevice(
    deviceId || undefined,
    'video',
    (res)=>{ if(res){ onScan(res.getText(), getFormatName(res)); } },
    { video:{
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width:{ ideal:1280 }, height:{ ideal:720 }, frameRate:{ ideal:30, max:30 }
      } }
  );
}

// autofocus / torch / zoom if device supports
async function tuneTrackCapabilities(){
  if(!state.stream) return;
  const track = state.stream.getVideoTracks()[0]; if(!track) return;

  const caps = track.getCapabilities?.() || {};
  const settings = track.getSettings?.() || {};

  // Continuous autofocus
  if(caps.focusMode && caps.focusMode.includes('continuous')){
    try{ await track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }); }catch(_){}
  }

  // Zoom slider
  if(typeof caps.zoom === 'number' || (caps.zoom && typeof caps.zoom.min === 'number')){
    const min=caps.zoom.min ?? 1, max=caps.zoom.max ?? 1, step=caps.zoom.step ?? 0.1;
    const wrap=$("zoomWrap"), slider=$("zoomSlider");
    if(wrap && slider){
      slider.min=String(min||1); slider.max=String(max||1); slider.step=String(step||0.1);
      slider.value=String(settings.zoom || min || 1);
      wrap.style.display = (Number(slider.max)>Number(slider.min)) ? 'flex' : 'none';
      slider.oninput = async (e)=>{ try{ await track.applyConstraints({ advanced:[{ zoom:Number(e.target.value) }] }); }catch(_){ } };
    }
  }

  // Torch button
  if('torch' in caps){
    const btn=$("btnTorch");
    if(btn){
      btn.style.display='inline-flex';
      let on=false;
      const setTorch = async (x)=>{
        try{ await track.applyConstraints({ advanced:[{ torch:x }] }); on=x; btn.textContent = on? 'ライト OFF' : 'ライト ON'; }catch(_){}
      };
      btn.onclick = ()=> setTorch(!on);
    }
  }
}

// ---------- scanning ----------
function getFormatName(res){
  try{ if(res.getBarcodeFormat) return String(res.getBarcodeFormat()); }catch(_){}
  return 'UNKNOWN';
}

function updateHistory(now, txt){
  const h=$("history"); if(!h) return;
  const cur = h.textContent.trim()==='(空)'?[]:h.textContent.split('\n');
  cur.unshift(`[${now}] ${txt.substring(0,120)}${txt.length>120?'…':''}`);
  h.textContent = cur.slice(0,20).join('\n');
}

async function onScan(txt, formatName){
  if(!txt || txt===state.lastText) return;
  state.lastText = txt;

  $("result").textContent = txt;
  $("meta").textContent   = '種類: ' + (formatName || 'UNKNOWN');
  updateHistory(new Date().toLocaleString('ja-JP'), txt);

  if($("autoSave")?.checked){ await saveToSheets(txt, formatName || 'UNKNOWN') }
  if($("vibrate")?.checked && 'vibrate' in navigator){ navigator.vibrate(60) }

  try{ await refreshDashboard(); }catch(_){}
}

// ---------- backend I/O (fetch + JSONP fallback) ----------
async function getGeo(){
  return new Promise((resolve)=>{
    if(!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos=>resolve({lat:pos.coords.latitude,lng:pos.coords.longitude}),
      _=>resolve(null),
      {enableHighAccuracy:true, timeout:3000}
    );
  });
}

async function saveToSheets(txt, type){
  const payload = {
    exhibition: $("exhibition")?.value.trim() || '(名称なし)',
    venue: $("venue")?.value.trim() || '',
    client_ts: new Date().toISOString(),
    data: txt,
    data_type: type, // QR_CODE / CODE_128 / ...
    ua: navigator.userAgent
  };
  const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng }

  // Try normal POST (will fail if CORS blocked)
  try{
    setStatus('保存中…');
    const res = await fetch(ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const raw = await res.text(); let j=null; try{ j=JSON.parse(raw) }catch(_){}
    if(res.ok && j && j.ok){ setStatus('保存しました','ok'); return; }
    throw new Error('fetch-not-ok');
  }catch(_){
    // Fallback JSONP (no CORS)
    await saveViaJSONP(payload);
  }
}

function saveViaJSONP(payload){
  return new Promise((resolve)=>{
    const cbName='__qr_cb_'+Date.now();
    window[cbName]=(resp)=>{ try{ delete window[cbName]; }catch(_){ } setStatus(resp&&resp.ok?'保存しました(JSONP)':'保存失敗(JSONP)', resp&&resp.ok?'ok':'bad'); resolve(); };
    const src=`${ENDPOINT}?mode=jsonp&cb=${cbName}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const s=document.createElement('script'); s.src=src; s.async=true;
    s.onerror=()=>{ setStatus('JSONP送信エラー','bad'); resolve(); };
    document.body.appendChild(s);
    setTimeout(()=>{ try{ document.body.removeChild(s); }catch(_){} },10000);
  });
}

async function syncQueue(){
  if(state.queue.length===0) return setStatus('キューは空です');
  setStatus('同期中…');
  const batch=[...state.queue];
  for(const item of batch){
    try{
      const r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(item)});
      if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge(); }
    }catch(_){ /* keep */ }
  }
  setStatus('同期完了','ok');
}

// ---------- dashboard ----------
function ymd(d){ return d.toISOString().slice(0,10); }
async function fetchStats(days){
  const end=new Date(); const start=new Date(); start.setDate(end.getDate()-(days-1));
  const qs=new URLSearchParams({stats:'1',start:ymd(start),end:ymd(end),group:'daily',_:(Date.now())});
  const r=await fetch(`${ENDPOINT}?${qs.toString()}`,{method:'GET',cache:'no-store'}); return r.json();
}
function renderChart(labels,data){
  const ctx=$("trendChart").getContext('2d');
  if(state.chart) state.chart.destroy();
  state.chart=new Chart(ctx,{type:'line',data:{labels,datasets:[{label:'Leads',data,tension:.35,borderWidth:2,pointRadius:3,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,ticks:{precision:0}}},plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}}}});
}
async function refreshDashboard(){
  const days=parseInt(($("rangeSelect")?.value)||'30',10);
  const res=await fetchStats(days); if(!res||!res.ok) return;
  $("totalLeads").textContent=res.total||0; $("uniqueLeads").textContent=res.unique||0;
  renderChart((res.series||[]).map(i=>i.date),(res.series||[]).map(i=>i.count));
}

// ---------- events ----------
$("btnStart").onclick=startCamera;
$("btnStop").onclick=stopCamera;
$("btnSave").onclick=()=>{ const t=$("result")?.textContent; if(t&&t!=='— まだありません —') saveToSheets(t,'MANUAL'); };
$("btnCopy").onclick=async()=>{ const t=$("result")?.textContent; if(!t||t==='— まだありません —') return; try{ await navigator.clipboard.writeText(t); setStatus('コピーしました','ok'); }catch(_){ setStatus('コピー失敗','bad'); } };
$("btnSync").onclick=syncQueue;
$("rangeSelect").onchange=()=>refreshDashboard();
$("btnDownload").onclick=()=>{ const days=parseInt(($("rangeSelect")?.value)||'30',10); const end=new Date(); const start=new Date(); start.setDate(end.getDate()-(days-1)); const qs=new URLSearchParams({download:'csv',start:ymd(start),end:ymd(end)}); window.open(`${ENDPOINT}?${qs.toString()}`,'_blank'); };

// Auto-start
window.addEventListener('load',()=>{ (async()=>{
  setQueueBadge(); await listCameras(); try{ await refreshDashboard(); }catch(_){}
  if(isMobile){ startCamera(); }
  else{
    try{ if(navigator.permissions && navigator.permissions.query){ const p=await navigator.permissions.query({name:'camera'}); if(p.state==='granted'){ startCamera(); } } }catch(_){}
  }
})();});
