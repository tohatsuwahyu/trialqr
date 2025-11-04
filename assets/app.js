// app.js (bersih, tanpa markdown/backticks)
const $ = (id) => document.getElementById(id);

const state = {
  stream: null,
  codeReader: null,
  lastText: null,
  scanning: false,
  queue: loadQueue(),
};

const ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.ENDPOINT) || "";

function loadQueue(){ try{ return JSON.parse(localStorage.getItem("qr_queue")||"[]"); }catch(e){ return []; } }
function saveQueue(){ localStorage.setItem("qr_queue", JSON.stringify(state.queue)); }
function setStatus(text, cls){ const b=$("statusBadge"); b.innerHTML=`Status: <strong>${text}</strong>`; b.className="badge "+(cls||""); }
function setQueueBadge(){ $("queueBadge").innerText = "Queue: " + state.queue.length; }

async function listCameras(){
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
  const sel = $("cameraSelect"); sel.innerHTML="";
  devices.forEach((d,i)=>{ const o=document.createElement("option"); o.value=d.deviceId; o.text=d.label||`Kamera ${i+1}`; sel.appendChild(o); });
  if(devices.length===0){ const o=document.createElement("option"); o.text="(kamera tidak ditemukan)"; sel.appendChild(o); }
}

async function startCamera(){
  stopCamera();
  const deviceId = $("cameraSelect").value || undefined;
  setStatus("membuka kamera…");
  const constraints = { video: deviceId?{deviceId:{exact:deviceId}}:{facingMode:"environment"} };
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  $("video").srcObject = state.stream;
  $("video").onloadedmetadata = ()=> $("video").play();
  setStatus("siap scan", "ok");
  startScanLoop();
  $("btnStart").disabled=true; $("btnStop").disabled=false;
}

function stopCamera(){
  if(state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; }
  if(state.scanning && state.codeReader){ state.codeReader.reset(); }
  state.scanning=false;
  $("btnStart").disabled=false; $("btnStop").disabled=true;
  setStatus("idle");
}

async function startScanLoop(){
  state.scanning=true;
  const codeReader = new ZXing.BrowserMultiFormatReader();
  state.codeReader = codeReader;
  try{
    await codeReader.decodeFromVideoDevice($("cameraSelect").value||undefined, "video", (res)=>{
      if(res){ onScan(res.getText()); }
    });
  }catch(e){ console.error(e); setStatus("gagal scanning", "bad"); }
}

function detectType(txt){
  try{ JSON.parse(txt); return {type:"json"}; }catch(_){/*not json*/}
  const urlp = /^(https?:\/\/|www\.)/i.test(txt);
  return {type: urlp?"url":"text"};
}

function updateHistory(now, txt){
  const h = $("history");
  const cur = h.textContent.trim()==="(kosong)"?[]:h.textContent.split("\n");
  cur.unshift(`[${now}] ${txt.substring(0,120)}${txt.length>120?"…":""}`);
  h.textContent = cur.slice(0,20).join("\n");
}

async function onScan(txt){
  if(!txt || txt===state.lastText) return;
  state.lastText = txt;
  const meta = detectType(txt);
  $("result").textContent = txt;
  $("meta").textContent = "Tipe: " + meta.type;
  updateHistory(new Date().toLocaleString(), txt);

  if($("autoSave").checked){ await saveToSheets(txt, meta.type); }
  if($("vibrate").checked && "vibrate" in navigator){ navigator.vibrate(80); }
}

async function getGeo(){
  return new Promise((resolve)=>{
    if(!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos=> resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}),
      _=> resolve(null),
      {enableHighAccuracy:true, timeout:3000}
    );
  });
}

async function saveToSheets(txt, type){
  const payload = {
    exhibition: $("exhibition").value.trim() || "(tanpa nama)",
    venue: $("venue").value.trim() || "",
    client_ts: new Date().toISOString(),
    data: txt,
    data_type: type,
    ua: navigator.userAgent,
  };
  const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng; }

  try{
    setStatus("menyimpan…");
    const res = await fetch(ENDPOINT, { method:"POST", mode:"cors", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    if(!res.ok) throw new Error("HTTP "+res.status);
    const j = await res.json();
    if(j && j.ok){ setStatus("tersimpan", "ok"); }
    else throw new Error("Respon tidak valid");
  }catch(e){
    console.warn("save failed, queued", e);
    state.queue.push(payload); saveQueue(); setQueueBadge(); setStatus("offline — masuk queue", "warn");
  }
}

async function syncQueue(){
  if(state.queue.length===0) return setStatus("queue kosong");
  setStatus("sync queue…");
  const batch = [...state.queue];
  for(const item of batch){
    try{
      const r = await fetch(ENDPOINT, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(item) });
      if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge(); }
    }catch(_){ /* keep in queue */ }
  }
  setStatus("sync selesai", "ok");
}

$("btnStart").onclick = startCamera;
$("btnStop").onclick = stopCamera;
$("btnSave").onclick = ()=>{
  const t=$("result").textContent;
  if(t && !/belum ada/i.test(t)) saveToSheets(t, detectType(t).type);
};
$("btnCopy").onclick = async ()=>{
  const t=$("result").textContent; if(!t||/belum ada/i.test(t)) return;
  try{ await navigator.clipboard.writeText(t); setStatus("tersalin", "ok"); }catch(_){ setStatus("gagal copy", "bad"); }
};
$("btnSync").onclick = syncQueue;

window.addEventListener("load", async()=>{
  setQueueBadge(); await listCameras();
  if(navigator.permissions && navigator.permissions.query){
    try{ const p=await navigator.permissions.query({name:"camera"}); if(p.state==="granted"){ startCamera(); } }catch(_){ }
  }
});
