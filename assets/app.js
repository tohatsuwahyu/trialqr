// app.js (JP UI)
$("result").textContent = txt;
$("meta").textContent = '種類: ' + meta.type;
updateHistory(new Date().toLocaleString('ja-JP'), txt);


if($("autoSave").checked){ await saveToSheets(txt, meta.type) }
if($("vibrate").checked && 'vibrate' in navigator){ navigator.vibrate(80) }
}


async function getGeo(){
return new Promise((resolve)=>{
if(!navigator.geolocation) return resolve(null)
navigator.geolocation.getCurrentPosition(
pos=> resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}),
_=> resolve(null), {enableHighAccuracy:true, timeout:3000}
)
})
}


async function saveToSheets(txt, type){
const payload = {
exhibition: $("exhibition").value.trim() || '(名称なし)',
venue: $("venue").value.trim() || '',
client_ts: new Date().toISOString(),
data: txt,
data_type: type,
ua: navigator.userAgent,
};
const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng }


try{
setStatus('保存中…');
const res = await fetch(ENDPOINT, { method:'POST', mode:'cors', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
if(!res.ok) throw new Error('HTTP '+res.status)
const j = await res.json()
if(j && j.ok){ setStatus('保存しました', 'ok') }
else throw new Error('レスポンス不正')
}catch(e){
console.warn('save failed, queued', e)
state.queue.push(payload); saveQueue(); setQueueBadge(); setStatus('オフライン — キューに追加', 'warn')
}
}


async function syncQueue(){
if(state.queue.length===0) return setStatus('キューは空です')
setStatus('同期中…')
const batch = [...state.queue]
for(const item of batch){
try{
const r = await fetch(ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) })
if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge() }
}catch(_){ /* keep in queue */ }
}
setStatus('同期完了', 'ok')
}


$("btnStart").onclick = startCamera
$("btnStop").onclick = stopCamera
$("btnSave").onclick = ()=>{ const t=$("result").textContent; if(t&&t!=='— まだありません —') saveToSheets(t, detectType(t).type) }
$("btnCopy").onclick = async ()=>{
const t=$("result").textContent; if(!t||t==='— まだありません —') return
try{ await navigator.clipboard.writeText(t); setStatus('コピーしました', 'ok') }catch(_){ setStatus('コピー失敗', 'bad') }
}
$("btnSync").onclick = syncQueue


window.addEventListener('load', async()=>{
setQueueBadge(); await listCameras()
if(navigator.permissions && navigator.permissions.query){
try{ const p=await navigator.permissions.query({name:'camera'}); if(p.state==='granted'){ startCamera() } }catch(_){ }
}
})
