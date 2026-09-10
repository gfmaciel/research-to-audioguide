import { WorkflowEntrypoint } from "cloudflare:workers";
import app, { splitText, slugify } from "./index.js";

const JOB_PREFIX = "jobs/";
const MANIFEST_NAME = "manifest.json";
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}

async function sha256hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(req, name) {
  const header = req.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

async function isAuthed(req, env) {
  if (!env.APP_PASSWORD) return false;
  const cookie = getCookie(req, "auth");
  if (!cookie) return false;
  return cookie === (await sha256hex(env.APP_PASSWORD));
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function jobKey(jobId, suffix) {
  return `${JOB_PREFIX}${jobId}/${suffix}`;
}

function normalizeTracks(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("no tracks supplied");
  if (raw.length > 100) throw new Error("too many tracks (max 100)");
  return raw.map((track, index) => {
    const text = String(track?.text || "");
    if (!text.trim()) throw new Error(`track ${index + 1} is empty`);
    if (text.length > 60000) throw new Error(`track ${index + 1} is too long (max 60000 chars)`);
    return {
      number: Number.isFinite(Number(track?.number)) ? Number(track.number) : index + 1,
      title: String(track?.title || `Faixa ${index + 1}`).slice(0, 300),
      cue: String(track?.cue || "").slice(0, 1000),
      text,
      chars: text.length,
      preview: String(track?.preview || text.slice(0, 160)).slice(0, 160),
    };
  });
}

async function loadManifest(env, jobId) {
  const obj = await env.AUDIO_BUCKET.get(jobKey(jobId, MANIFEST_NAME));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    throw new Error("invalid stored job manifest");
  }
}

async function callExistingSpeak(env, track, voice) {
  const auth = await sha256hex(env.APP_PASSWORD || "");
  const req = new Request("https://internal/api/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `auth=${auth}`,
    },
    body: JSON.stringify({ text: track.text, title: track.title, number: track.number, voice }),
  });
  return app.fetch(req, env);
}

function buildRateGroups(costs, rpm) {
  const groups = [];
  let current = [];
  let used = 0;
  for (let i = 0; i < costs.length; i++) {
    const actualCost = Math.max(1, costs[i] || 1);
    // A single very long track can exceed the free RPM by itself because the
    // existing speaker splits it internally. Keep it alone; the normal
    // OpenRouter fallback still prevents the batch from getting stuck.
    const schedulingCost = Math.min(actualCost, rpm);
    if (current.length && used + schedulingCost > rpm) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(i);
    used += schedulingCost;
    if (used >= rpm) {
      groups.push(current);
      current = [];
      used = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

export class AudioguideBatchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { jobId, costs = [], rpm: requestedRpm } = event.payload || {};
    if (!JOB_ID_RE.test(String(jobId || ""))) throw new Error("invalid job id");

    const rpm = clampInt(requestedRpm, 3, 1, 10);
    const windowSeconds = clampInt(this.env.GEMINI_RATE_WINDOW_SECONDS, 61, 60, 120);
    const groups = buildRateGroups(costs, rpm);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const indices = groups[groupIndex];
      const groupHasSplitTrack = indices.some((i) => (costs[i] || 1) > 1);
      const startedAt = await step.do(`group-${groupIndex}-started`, async () => Date.now());

      const settled = await Promise.all(
        indices.map(async (index) => {
          try {
            const result = await step.do(
              `track-${index}`,
              { retries: { limit: 3, delay: "15 seconds", backoff: "linear" }, timeout: "30 minutes" },
              async () => {
                const manifest = await loadManifest(this.env, jobId);
                if (!manifest || !manifest.tracks?.[index]) throw new Error(`missing track ${index}`);
                const track = manifest.tracks[index];
                const res = await callExistingSpeak(this.env, track, manifest.voice);
                if (!res.ok) {
                  const body = await res.json().catch(() => ({}));
                  throw new Error(body.error || `synthesis HTTP ${res.status}`);
                }
                const contentType = res.headers.get("Content-Type") || "audio/wav";
                const format = contentType.includes("mpeg") ? "mp3" : "wav";
                const provider = res.headers.get("X-Provider") || "?";
                const voice = res.headers.get("X-Voice") || manifest.voice || "default";
                const file = `${String(track.number).padStart(2, "0")}_${slugify(track.title)}.${format}`;
                const bytes = await res.arrayBuffer();
                await this.env.AUDIO_BUCKET.put(jobKey(jobId, `audio/${index}`), bytes, {
                  httpMetadata: { contentType },
                  customMetadata: {
                    index: String(index),
                    file,
                    provider,
                    voice,
                    format,
                  },
                });
                return { index, ok: true, file, provider, voice, format };
              },
            );
            return result;
          } catch (e) {
            const message = errMsg(e).slice(0, 900);
            await step.do(`track-${index}-failed`, async () => {
              await this.env.AUDIO_BUCKET.put(jobKey(jobId, `errors/${index}`), "", {
                customMetadata: { index: String(index), error: message },
              });
              return { index, error: message };
            });
            return { index, ok: false, error: message };
          }
        }),
      );
      if (groupIndex + 1 < groups.length) {
        const endedAt = await step.do(`group-${groupIndex}-ended`, async () => Date.now());
        // If every track was one upstream request, measure the rate window from
        // group start. If any track split internally, wait a full window after
        // completion because those upstream requests were spread over time.
        const elapsedSeconds = groupHasSplitTrack ? 0 : Math.floor((endedAt - startedAt) / 1000);
        const sleepSeconds = Math.max(1, windowSeconds - elapsedSeconds);
        await step.sleep(`rate-window-${groupIndex}`, `${sleepSeconds} seconds`);
      }
    }

    return { jobId };
  }
}

const BATCH_CLIENT = String.raw`<script>
(function(){
const BATCH_KEY='audioguide_batch_job';
let batchJobId=null,batchPollToken=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function addBatchControls(wrap){
  const all=document.createElement('button');
  all.id='batchall';all.textContent='2. Gerar áudio de todas';all.onclick=()=>generateAll(all);wrap.appendChild(all);
  const zip=document.createElement('button');
  zip.id='zipall';zip.disabled=true;zip.textContent='3. Baixar tudo (.zip)';zip.onclick=downloadAll;wrap.appendChild(zip);
}

function renderRecovered(manifest){
  TRACKS=manifest.tracks||[];DOCNAME=manifest.docname||'audioguia';
  if(manifest.voice&&VOICES.includes(manifest.voice)){VOICE=manifest.voice;renderVoices();}
  const wrap=document.getElementById('tracks');wrap.innerHTML='';addBatchControls(wrap);
  TRACKS.forEach((t,i)=>{
    const d=document.createElement('div');d.className='card';d.id='card'+i;
    d.innerHTML='<h3>'+String(t.number).padStart(2,'0')+' — '+esc(t.title)+'</h3>'
      +(t.cue?'<p class="cue">Ouvir quando: '+esc(t.cue)+'</p>':'')
      +'<p class="muted">'+t.chars+' caracteres</p>'
      +'<details><summary>ver texto</summary><p>'+esc(t.text).replace(/\n/g,'<br>')+'</p></details>'
      +'<button data-i="'+i+'">Gerar esta faixa</button><div class="out"></div>';
    wrap.appendChild(d);
  });
  wrap.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>generateOne(+b.dataset.i));
  refreshZipBtn();
}

async function installReady(jobId,meta){
  const i=Number(meta.index);const t=TRACKS[i];if(!t||t._buf)return;
  const r=await fetch('/api/jobs/'+encodeURIComponent(jobId)+'/audio/'+i);
  if(!r.ok)return;
  const buf=await r.arrayBuffer();
  const blob=new Blob([buf],{type:r.headers.get('Content-Type')||'audio/wav'});
  const url=URL.createObjectURL(blob);
  t._buf=buf;t._file=meta.file||String(t.number).padStart(2,'0')+'_'+slug(t.title)+'.wav';
  const out=document.querySelector('#card'+i+' .out');
  if(out)out.innerHTML='<p class="muted">via '+esc(meta.provider||'?')+' · '+esc(meta.voice||VOICE)+'</p>'
    +'<audio controls src="'+url+'"></audio><br><a href="'+url+'" download="'+esc(t._file)+'">Baixar '+esc(t._file)+'</a>';
  refreshZipBtn();
}

async function monitorBatch(jobId,btn){
  const token=++batchPollToken;batchJobId=jobId;batchOn=true;if(btn)btn.textContent='■ Parar';
  while(token===batchPollToken&&batchJobId===jobId){
    try{
      const r=await fetch('/api/jobs/'+encodeURIComponent(jobId));
      if(!r.ok){const e=await r.json().catch(()=>({}));if(r.status===404){batchOn=false;batchJobId=null;try{localStorage.removeItem(BATCH_KEY);}catch(x){}if(btn)btn.textContent='2. Gerar áudio de todas';status.textContent='O job não chegou a ser criado no servidor.';return;}throw new Error(e.error||('HTTP '+r.status));}
      const data=await r.json();
      await Promise.all((data.ready||[]).map(meta=>installReady(jobId,meta)));
      const ready=(data.ready||[]).length,failed=(data.failed||[]).length,total=data.total||TRACKS.length;
      if(data.state==='complete'){
        status.textContent=failed?('Concluído: '+ready+'/'+total+' prontas; '+failed+' falharam.'):('Pronto: '+ready+' faixa(s).');
        batchOn=false;batchJobId=null;try{localStorage.removeItem(BATCH_KEY);}catch(e){}
        if(btn)btn.textContent='2. Gerar áudio de todas';return;
      }
      if(data.state==='errored'||data.state==='terminated'){
        status.textContent=data.state==='terminated'?'Geração interrompida.':'O job falhou no servidor: '+(data.error||'erro desconhecido');
        batchOn=false;batchJobId=null;try{localStorage.removeItem(BATCH_KEY);}catch(e){}
        if(btn)btn.textContent='2. Gerar áudio de todas';return;
      }
      status.textContent='Gerando no servidor: '+ready+'/'+total+' prontas'+(failed?' · '+failed+' falharam':'')+'. Pode fechar a página; o job continua.';
    }catch(e){
      status.textContent=navigator.onLine?('Sem conseguir consultar o job: '+e.message+'. Tentando novamente…'):'Sem internet. A geração continua no servidor e será retomada aqui quando a conexão voltar.';
    }
    await sleep(4000);
  }
}

generateAll=async function(btn){
  if(batchOn){
    const id=batchJobId;batchPollToken++;batchOn=false;batchJobId=null;if(btn)btn.textContent='2. Gerar áudio de todas';
    if(id){try{await fetch('/api/jobs/'+encodeURIComponent(id),{method:'DELETE'});}catch(e){}try{localStorage.removeItem(BATCH_KEY);}catch(e){}}
    status.textContent='Solicitação para parar enviada.';return;
  }
  if(!TRACKS.length){status.textContent='Leia as faixas primeiro.';return;}
  batchOn=true;if(btn)btn.textContent='Iniciando…';status.textContent='Enviando job para o servidor…';
  const jobId='j'+crypto.randomUUID().replace(/-/g,'');batchJobId=jobId;
  try{localStorage.setItem(BATCH_KEY,jobId);}catch(e){}
  try{
    const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,tracks:TRACKS,voice:VOICE,docname:DOCNAME})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok){try{localStorage.removeItem(BATCH_KEY);}catch(e){}batchJobId=null;throw new Error(data.error||('HTTP '+r.status));}
    await monitorBatch(jobId,btn);
  }catch(e){
    if(batchJobId===jobId){status.textContent=navigator.onLine?('Não consegui confirmar o início: '+e.message+'. Vou verificar o job…'):'A conexão caiu ao iniciar. Se o servidor recebeu o pedido, a geração continuará; vou verificar quando a internet voltar.';await monitorBatch(jobId,btn);}
    else{batchOn=false;if(btn)btn.textContent='2. Gerar áudio de todas';status.textContent='Falhou ao iniciar: '+e.message;}
  }
};

async function resumePrevious(){
  let id=null;try{id=localStorage.getItem(BATCH_KEY);}catch(e){}if(!id)return;
  try{
    const r=await fetch('/api/jobs/'+encodeURIComponent(id)+'?manifest=1');
    if(!r.ok){try{localStorage.removeItem(BATCH_KEY);}catch(e){}return;}
    const data=await r.json();if(!TRACKS.length&&data.manifest)renderRecovered(data.manifest);
    const btn=document.getElementById('batchall')||document.querySelector('#tracks > button');
    monitorBatch(id,btn);
  }catch(e){status.textContent='Há uma geração anterior salva. Vou retomar quando houver conexão.';batchJobId=id;batchOn=true;setTimeout(resumePrevious,5000);}
}
setTimeout(resumePrevious,0);
})();
</script>`;

function injectBatchClient(html) {
  if (!html.includes('id="tracks"') || html.includes("audioguide_batch_job")) return html;
  return html.replace("</body>", `${BATCH_CLIENT}</body>`);
}

async function handleJobRoutes(req, env, url) {
  if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
  if (!env.AUDIO_BUCKET || !env.BATCH_WORKFLOW) return json({ error: "batch storage/workflow is not configured" }, 500);

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    let tracks;
    try {
      tracks = normalizeTracks(body.tracks);
    } catch (e) {
      return json({ error: errMsg(e) }, 400);
    }
    const docname = String(body.docname || "audioguia").slice(0, 300);
    const voice = String(body.voice || "").slice(0, 80);
    const maxChars = Math.max(500, parseInt(env.TTS_MAX_CHARS || "4000", 10) || 4000);
    const costs = tracks.map((t) => splitText(t.text, maxChars).length);
    const rpm = clampInt(env.GEMINI_FREE_RPM, 3, 1, 10);
    const suppliedId = String(body.jobId || "");
    const jobId = suppliedId ? suppliedId : `j${crypto.randomUUID().replace(/-/g, "")}`;
    if (!JOB_ID_RE.test(jobId)) return json({ error: "invalid job id" }, 400);
    if (await env.AUDIO_BUCKET.head(jobKey(jobId, MANIFEST_NAME))) return json({ error: "job already exists" }, 409);
    const manifest = { jobId, docname, voice, createdAt: new Date().toISOString(), tracks };
    try {
      await env.AUDIO_BUCKET.put(jobKey(jobId, MANIFEST_NAME), JSON.stringify(manifest), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      await env.BATCH_WORKFLOW.create({ id: jobId, params: { jobId, costs, rpm } });
      return json({ jobId, total: tracks.length, rpm, costs }, 202);
    } catch (e) {
      await env.AUDIO_BUCKET.delete(jobKey(jobId, MANIFEST_NAME)).catch(() => {});
      return json({ error: `could not start batch: ${errMsg(e)}` }, 500);
    }
  }

  const m = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(?:\/audio\/(\d+))?$/);
  if (!m || !JOB_ID_RE.test(m[1])) return json({ error: "not found" }, 404);
  const jobId = m[1];

  if (req.method === "GET" && m[2] !== undefined) {
    const index = Number(m[2]);
    const obj = await env.AUDIO_BUCKET.get(jobKey(jobId, `audio/${index}`));
    if (!obj) return json({ error: "audio not ready" }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("ETag", obj.httpEtag);
    headers.set("Cache-Control", "private, max-age=86400");
    if (obj.customMetadata?.file) headers.set("Content-Disposition", `inline; filename="${obj.customMetadata.file.replace(/["\\]/g, "_")}"`);
    return new Response(obj.body, { headers });
  }

  if (req.method === "DELETE") {
    try {
      const instance = await env.BATCH_WORKFLOW.get(jobId);
      const details = await instance.status();
      if (!["complete", "errored", "terminated"].includes(details.status)) await instance.terminate();
      return json({ ok: true });
    } catch (e) {
      return json({ error: errMsg(e) }, 400);
    }
  }

  if (req.method === "GET") {
    const manifest = await loadManifest(env, jobId);
    if (!manifest) return json({ error: "job not found" }, 404);
    let details;
    try {
      details = await (await env.BATCH_WORKFLOW.get(jobId)).status();
    } catch (e) {
      return json({ error: errMsg(e) }, 404);
    }
    const [readyList, failedList] = await Promise.all([
      env.AUDIO_BUCKET.list({ prefix: jobKey(jobId, "audio/"), include: ["customMetadata"] }),
      env.AUDIO_BUCKET.list({ prefix: jobKey(jobId, "errors/"), include: ["customMetadata"] }),
    ]);
    const ready = readyList.objects
      .map((o) => ({ ...o.customMetadata, index: Number(o.customMetadata?.index) }))
      .filter((x) => Number.isInteger(x.index))
      .sort((a, b) => a.index - b.index);
    const failed = failedList.objects
      .map((o) => ({ index: Number(o.customMetadata?.index), error: o.customMetadata?.error || "failed" }))
      .filter((x) => Number.isInteger(x.index))
      .sort((a, b) => a.index - b.index);
    const payload = {
      jobId,
      state: details.status,
      error: details.error?.message || null,
      total: manifest.tracks.length,
      ready,
      failed,
    };
    if (url.searchParams.get("manifest") === "1") payload.manifest = manifest;
    return json(payload);
  }

  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/jobs" || url.pathname.startsWith("/api/jobs/")) {
      return handleJobRoutes(req, env, url);
    }

    const res = await app.fetch(req, env, ctx);
    if (req.method === "GET" && url.pathname === "/" && (res.headers.get("Content-Type") || "").includes("text/html")) {
      const html = await res.text();
      return new Response(injectBatchClient(html), { status: res.status, headers: res.headers });
    }
    return res;
  },
};
