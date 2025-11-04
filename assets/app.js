const $ = (id) => document.getElementById(id);
');
}


async function onScan(txt){
if(!txt || txt===state.lastText) return;
state.lastText = txt;
const meta = detectType(txt);
$('result').textContent = txt;
$('meta').textContent = 'Tipe: ' + meta.type;
updateHistory(new Date().toLocaleString(), txt);


if($('autoSave').checked){ await saveToSheets(txt, meta.type) }
if($('vibrate').checked && 'vibrate' in navigator){ navigator.vibrate(80) }
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
exhibition: $('exhibition').value.trim() || '(tanpa nama)',
venue: $('venue').value.trim() || '',
client_ts: new Date().toISOString(),
data: txt,
data_type: type,
ua: navigator.userAgent,
};
const geo = await getGeo(); if(geo){ payload.lat=geo.lat; payload.lng=geo.lng }


try{
setStatus('menyimpan…');
const res = await fetch(ENDPOINT, { method:'POST', mode:'cors', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
if(!res.ok) throw new Error('HTTP '+res.status);
const j = await res.json();
if(j && j.ok){ setStatus('tersimpan', 'ok') }
else throw new Error('Respon tidak valid');
}catch(e){
console.warn('save failed, queued', e);
state.queue.push(payload); saveQueue(); setQueueBadge(); setStatus('offline — masuk queue', 'warn');
}
}


async function syncQueue(){
if(state.queue.length===0) return setStatus('queue kosong');
setStatus('sync queue…');
const batch = [...state.queue];
for(const item of batch){
try{
const r = await fetch(ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
if(r.ok){ state.queue.shift(); saveQueue(); setQueueBadge() }
}catch(_){ /* keep in queue */ }
}
setStatus('sync selesai', 'ok');
}


$('btnStart').onclick = startCamera;
$('btnStop').onclick = stopCamera;
$('btnSave').onclick = ()=>{ const t=$('result').textContent; if(t&&t!=='— belum ada —') saveToSheets(t, detectType(t).type) };
$('btnCopy').onclick = async ()=>{
const t=$('result').textContent; if(!t||t==='— belum ada —') return;
try{ await navigator.clipboard.writeText(t); setStatus('tersalin', 'ok') }catch(_){ setStatus('gagal copy', 'bad') }
};
$('btnSync').onclick = syncQueue;


window.addEventListener('load', async()=>{
setQueueBadge(); await listCameras();
if(navigator.permissions && navigator.permissions.query){
try{ const p=await navigator.permissions.query({name:'camera'}); if(p.state==='granted'){ startCamera() } }catch(_){ }
}
});
