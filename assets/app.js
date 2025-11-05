// app.js — ZXing (QR), Quagga2 (1D), ROI overlay, fast start, torch/zoom, dashboard, JSONP fallback

const $ = (id) => document.getElementById(id);
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.ENDPOINT) || "";

const state = {
  stream: null,
  codeReader: null,   // ZXing
  usingQuagga: false, // 1D mode flag
  lastText: null,
  scanning: false,
  queue: loadQueue(),
  chart: null
};

// ---------- queue & ui helpers ----------
function loadQueue(){ try{ return JSON.parse(localStorage.getItem("qr_queue")||"[]") }catch(e){ return [] } }
function saveQueue(){ localStorage.setItem("qr_queue", JSON.stringify(state.queue)) }
function setStatus(text, cls){ const b=$("statusBadge"); if(!b) return; b.innerHTML=`ステータス: <strong>${text}</strong>`; b.className='badge '+(cls||''); }
function setQueueBadge(){ const el=$("queueBadge"); if(!el) return; el.innerText='キュー: '+state.queue.length; }

// ---------- overlay (ROI/debug) ----------
function clearOverlay(){
  const c = $("overlay"); if(!c) return;
  const ctx = c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
}
function resizeOverlayToVideo(){
  const v = $("video"), c = $("overlay"); if(!v || !c) return;
  const rect = v.getBoundingClientRect(); c.width = rect.width; c.height = rect.height;
}
function drawBoxes(boxes, line){
  const c = $("overlay"); if(!c) return; const ctx = c.getContext('2d'); ctx.lineWidth=2;

  ctx.strokeStyle='rgba(255,200,0,0.85)';
  (boxes||[]).forEach(b=>{ ctx.beginPath(); b.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.stroke(); });

  if(line){
    ctx.strokeStyle='rgba(0,200,120,0.9)';
    ctx.beginPath(); ctx.moveTo(line[0].x,line[0].y); ctx.lineTo(line[1].x,line[1].y); ctx.stroke();
  }

  // visual ROI band (optional)
  const w=c.width,h=c.height; ctx.strokeStyle='rgba(255,0,0,0.35)'; ctx.lineWidth=1.5;
  const top = h*0.35, bottom=h*0.65, left=w*0.10, right=w*0.90;
  ctx.strokeRect(left, top, right-left, bottom-top);
}

// ---------- ZXing (QR) ----------
const ZX_FORMATS = [
  ZXing.BarcodeFormat.QR_CODE,
  ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.CODE_93,
  ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
  ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
  ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.CODABAR
];
function zxHints(){ const h=new Map(); h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS); h.set(ZXing.DecodeHintType.TRY_HARDER,true); return h; }
function getFormatNameZX(res){ try{ if(res.getBarcodeFormat) return String(res.getBarcodeFormat()); }catch(_){ } return 'UNKNOWN'; }

// ---------- Quagga (1D) ----------
const QG_READERS = [
  "code_128_reader","code_39_reader","code_39_vin_reader","code_93_reader",
  "ean_reader","ean_8_reader","upc_reader","upc_e_reader",
  "i2of5_reader","codabar_reader"
];
function getFormatNameQG(name){
  return (name||'').toUpperCase().replace('_READER','').replace('I2OF5','ITF').replace('EAN','EAN_').replace('UPC','UPC_');
}

// ---------- constraints ----------
const BASE_CONSTRAINTS_ENV = {
  video: {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1280, max: 1920 },
    height: { ideal: 720,  max: 1080 },
    frameRate: { ideal: 30, max: 30 }
  }
};

// ---------- device list ----------
async function listCameras(){
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  const sel = $("cameraSelect"); if(!sel) return;
  sel.innerHTML='';
  devs.forEach((d,i)=>{ const o=document.createElement('option'); o.value=d.deviceId; o.text=d.label||`カメラ ${i+1}`; sel.appendChild(o) });
  if(devs.length===0){ const o=document.createElement('option'); o.text='（カメラが見つかりません）'; sel.appendChild(o) }
}

// ---------- start/stop ----------
async function startCamera(){
  stopCamera();
  setStatus(isMobile ? 'カメラ(背面)を起動中…' : 'カメラを起動中…');

  const use1D = $("mode1D")?.checked;
  state.usingQuagga = !!use1D;

  try{
    if(use1D){
      await startQuagga();
    }else{
      if(isMobile){
        try { await startZXingWithConstraints({ video: { ...BASE_CONSTRAINTS_ENV.video, facingMode:{ exact:'environment' } } }); }
        catch(_) { await startZXingWithConstraints(BASE_CONSTRAINTS_ENV); }
      }else{
        const deviceId = $("cameraSelect")?.value || undefined;
        await startZXingWithDevice(deviceId);
      }
      await tuneTrackCapabilities(); // torch/zoom/AF
    }

    setTimeout(resizeOverlayToVideo, 150);
    window.addEventListener('resize', resizeOverlayToVideo);

    setStatus('スキャン準備OK','ok');
    $("btnStart").disabled = true; $("btnStop").disabled = false;
  }catch(e){
    console.error(e);
    setStatus('カメラ起動に失敗','bad');
  }
}

function stopCamera(){
  try{ if(state.usingQuagga) Quagga.stop(); }catch(_){}
  try{ if(state.stream) state.stream.getTracks().forEach(t=>t.stop()); }catch(_){}
  state.stream=null; state.scanning=false; state.usingQuagga=false;
  try{ if(state.codeReader) state.codeReader.reset(); }catch(_){}
  $("btnStart").disabled=false; $("btnStop").disabled=true;
  $("btnTorch").style.display='none'; $("zoomWrap").style.display='none';
  clearOverlay(); setStatus('待機中');
}

// ---------- ZXing paths ----------
async function startZXingWithConstraints(constraints){
  state.scanning = true;
  const reader = new ZXing.BrowserMultiFormatReader(zxHints());
  state.codeReader = reader;

  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $("video");
  if(video){
    video.srcObject = state.stream; video.playsInline = true;
    if(video.paused) video.play().catch(()=>{});
    setTimeout(resizeOverlayToVideo, 120);
  }

  await reader.decodeFromConstraints(constraints, 'video', (res)=>{
    if(res){ onScan(res.getText(), getFormatNameZX(res)); }
  });
}

async function startZXingWithDevice(deviceId){
  state.scanning = true;
  const reader = new ZXing.BrowserMultiFormatReader(zxHints());
  state.codeReader = reader;

  await reader.decodeFromVideoDevice(
    deviceId || undefined, 'video',
    (res)=>{ if(res){ onScan(res.getText(), getFormatNameZX(res)); } },
    { video:{ deviceId: deviceId ? { exact: deviceId } : undefined, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30,max:30} } }
  );

  setTimeout(resizeOverlayToVideo, 120);
}

// torch/zoom/AF (ZXing stream only)
async function tuneTrackCapabilities(){
  if(!state.stream) return;
  const track = state.stream.getVideoTracks()[0]; if(!track) return;
  const caps = track.getCapabilities?.() || {}; const settings = track.getSettings?.() || {};

  if(caps.focusMode && caps.focusMode.includes('continuous')){
    try{ await track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }); }catch(_){}
  }
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
  if('torch' in caps){
    const btn=$("btnTorch");
    if(btn){
      btn.style.display='inline-flex';
      let on=false;
      const setTorch = async (x)=>{ try{ await track.applyConstraints({ advanced:[{ torch:x }] }); on=x; btn.textContent = on?'ライト OFF':'ライト ON'; }catch(_){ } };
      btn.onclick = ()=> setTorch(!on);
    }
  }
}

// ---------- Quagga (1D専用, ROI band) ----------
async function startQuagga(){
  return new Promise((resolve, reject)=>{
    try{
      const area = { top: "35%", right: "10%", left: "10%", bottom: "35%" }; // ROI tengah

      Quagga.init({
        inputStream: {
          type: "LiveStream",
          target: $("video"),
          constraints: { facingMode: "environment", width:{ideal:1280}, height:{ideal:720} },
          area
        },
        locator: { patchSize: "large", halfSample: false },
        locate: true,
        numOfWorkers: navigator.hardwareConcurrency ? Math.max(1, Math.min(4, navigator.hardwareConcurrency-1)) : 2,
        frequency: 15,
        decoder: { readers: QG_READERS, multiple: false }
      }, (err)=>{
        if(err){ console.error(err); reject(err); return; }
        state.usingQuagga = true;
        Quagga.start();
        setTimeout(()=>{ resizeOverlayToVideo(); resolve(); }, 150);
      });

      Quagga.onProcessed((result)=>{
        clearOverlay(); if(!result) return;
        const v=$("video"), c=$("overlay"); if(!v || !c) return;
        const rect=v.getBoundingClientRect();

        const norm = (pts)=> pts.map(p=>({ x: p.x / v.videoWidth * rect.width, y: p.y / v.videoHeight * rect.height }));

        const boxes = (result.boxes||[])
          .filter(b => result.box ? b !== result.box : true)
          .map(b => norm(b));

        const line = result.line ? norm(result.line) : null;
        drawBoxes(boxes, line);
      });

      Quagga.onDetected((data)=>{
        if(!data || !data.codeResult) return;
        const txt = data.codeResult.code;
        const fmt = getFormatNameQG(data.codeResult.format);
        if(txt && txt !== state.lastText){ onScan(txt, fmt); }
      });

    }catch(e){ reject(e); }
  });
}

// ---------- scan handling ----------
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

  if($("autoSave")?.checked){ await saveToSheets(txt, formatName || 'UNKNOWN'); }
  if($("vibrate")?.checked && 'vibrate' in navigator){ navigator.vibrate(60); }

  try{ await refreshDashboard(); }catch(_){}
}

// ---------- backend I/O (fetch + JSONP fallback) ----------
async function getGeo(){
  return new Promise((resolve)=>{
    if(!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos=>resolve({lat:pos.coords.latitude, lng:pos.coords.longitude}),
      _=>resolve(null),
      { enableHighAccuracy:true, timeout:3000 }
    );
  });
}

async function saveToSheets(txt, type){
  const payload = {
    exhibition: $("exhibition")?.value.trim() || '(名称なし)',
    venue: $("venue")?.value.trim() || '',
    client_ts: new Date().toISOString(),
    data: txt,
    data_type: type,
    ua: navigator.userAgent
  };
  const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng }

  try{
    setStatus('保存中…');
    const res = await fetch(ENDPOINT, { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const raw = await res.text(); let j=null; try{ j=JSON.parse(raw) }catch(_){}
    if(res.ok && j && j.ok){ setStatus('保存しました','ok'); return; }
    throw new Error('fetch-not-ok');
  }catch(_){
    await saveViaJSONP(payload);
  }
}

function saveViaJSONP(payload){
  return new Promise((resolve)=>{
    const cb='__qr_cb_'+Date.now();
    window[cb]=(resp)=>{ try{ delete window[cb]; }catch(_){ } setStatus(resp&&resp.ok?'保存しました(JSONP)':'保存失敗(JSONP)', resp&&resp.ok?'ok':'bad'); resolve(); };
    const src=`${ENDPOINT}?mode=jsonp&cb=${cb}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const s=document.createElement('script'); s.src=src; s.async=true; s.onerror=()=>{ setStatus('JSONP送信エラー','bad'); resolve(); };
    document.body.appendChild(s); setTimeout(()=>{ try{ document.body.removeChild(s); }catch(_){ } },10000);
  });
}

async function syncQueue(){
  if(state.queue.length===0) return setStatus('キューは空です');
  setStatus('同期中…');
  const batch=[...state.queue];
  for(const item of batch){
    try{ const r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(item)}); if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge(); } }
    catch(_){ }
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
$("mode1D").onchange=()=>{ stopCamera(); startCamera(); };

// Auto-start mobile
window.addEventListener('load',()=>{ (async()=>{
  setQueueBadge(); await listCameras(); try{ await refreshDashboard(); }catch(_){}
  if(isMobile){ startCamera(); }
})();});
