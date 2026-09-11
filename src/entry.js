import durable, { AudioguideBatchWorkflow } from "./background.js";
import { parseAudioguide } from "./index.js";

export { AudioguideBatchWorkflow };

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Keep the existing lightweight single-track retry/offline enhancement. It
// loads before the durable batch override, so only "Gerar todas" is replaced.
function injectExistingPerf(html) {
  if (!html.includes("audioguide_batch_job") || html.includes('src="/perf.js"')) return html;
  const marker = "const BATCH_KEY='audioguide_batch_job'";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return html;
  const scriptAt = html.lastIndexOf("<script>", markerAt);
  if (scriptAt < 0) return html;
  return html.slice(0, scriptAt) + '<script src="/perf.js"></script>' + html.slice(scriptAt);
}

function enablePdfUi(html) {
  return html
    .replace("<title>Audioguia — docx para áudio</title>", "<title>Audioguia — documento para áudio</title>")
    .replace("<h1>docx → áudio</h1>", "<h1>docx/pdf → áudio</h1>")
    .replace("Envie o .docx MASTER.", "Envie o .docx ou .pdf MASTER.")
    .replace('accept=".docx"', 'accept=".docx,.pdf,application/pdf"')
    .replace("Escolha um .docx primeiro.", "Escolha um .docx ou .pdf primeiro.")
    .replace(
      "const r=await fetch('/api/parse',{method:'POST',body:fd});",
      "const parseUrl=/\\.pdf$/i.test(f.name)?'/api/parse-pdf':'/api/parse';\n  const r=await fetch(parseUrl,{method:'POST',body:fd});",
    );
}

// The durable batch client stores the current Workflow id in localStorage so a
// reload can recover its manifest and R2 audio. Keep that pointer after a batch
// finishes (or partially errors); otherwise the generated files still exist in
// R2 but the refreshed page has no way to discover them. A successfully parsed
// new document intentionally starts a new session and clears the old pointer.
function preserveBatchProgress(html) {
  return html
    .replace(
      "document.getElementById('parse').onclick=async()=>{\n  const f=",
      "document.getElementById('parse').onclick=async()=>{\n  if(batchOn){status.textContent='Pare a geração atual antes de carregar outro documento.';return;}\n  const f=",
    )
    .replace(
      "TRACKS=data.tracks;\n  DOCNAME=",
      "TRACKS=data.tracks;\n  try{localStorage.removeItem('audioguide_batch_job');}catch(e){}\n  DOCNAME=",
    )
    .replace(
      "batchOn=false;batchJobId=null;try{localStorage.removeItem(BATCH_KEY);}catch(e){}\n        if(btn)btn.textContent='2. Gerar áudio de todas';return;\n      }\n      if(data.state==='errored'||data.state==='terminated')",
      "batchOn=false;batchJobId=null;\n        if(btn)btn.textContent='2. Gerar áudio de todas';return;\n      }\n      if(data.state==='errored'||data.state==='terminated')",
    )
    .replace(
      "batchOn=false;batchJobId=null;try{localStorage.removeItem(BATCH_KEY);}catch(e){}\n        if(btn)btn.textContent='2. Gerar áudio de todas';return;\n      }\n      status.textContent='Gerando no servidor:",
      "batchOn=false;batchJobId=null;if(data.state==='terminated'){try{localStorage.removeItem(BATCH_KEY);}catch(e){}}\n        if(btn)btn.textContent='2. Gerar áudio de todas';return;\n      }\n      status.textContent='Gerando no servidor:",
    );
}

async function recoverStartingJob(req, env, url, res) {
  if (req.method !== "GET" || res.status !== 404 || !env.AUDIO_BUCKET) return res;
  const match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,100})$/);
  if (!match) return res;

  // POST /api/jobs stores the manifest just before creating the Workflow. If
  // the phone disconnects in that tiny window, the first status poll can beat
  // Workflow creation. Treat an existing manifest as "starting" rather than
  // forgetting a job that may become durable milliseconds later.
  const stored = await env.AUDIO_BUCKET.get(`jobs/${match[1]}/manifest.json`);
  if (!stored) return res;
  const manifest = await stored.json().catch(() => null);
  if (!manifest) return res;

  const payload = {
    jobId: match[1],
    state: "starting",
    error: null,
    total: Array.isArray(manifest.tracks) ? manifest.tracks.length : 0,
    ready: [],
    failed: [],
  };
  if (url.searchParams.get("manifest") === "1") payload.manifest = manifest;
  return Response.json(payload, { status: 202 });
}

async function handlePdfParse(req, env, ctx) {
  // Reuse the existing app's authentication rather than maintaining a second
  // auth implementation here. An empty parse request reaches 400 when authed
  // and 401 when the cookie is missing/invalid.
  const probeHeaders = new Headers();
  const cookie = req.headers.get("Cookie");
  if (cookie) probeHeaders.set("Cookie", cookie);
  const authProbe = await durable.fetch(
    new Request(new URL("/api/parse", req.url), { method: "POST", headers: probeHeaders }),
    env,
    ctx,
  );
  if (authProbe.status === 401 || authProbe.status >= 500) return authProbe;

  if (!env.AI) return Response.json({ error: "PDF parsing is not configured (missing AI binding)" }, { status: 500 });

  let form;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form with a file field" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return Response.json({ error: "missing file field" }, { status: 400 });
  if (!/\.pdf$/i.test(file.name || "")) return Response.json({ error: "only .pdf files are accepted here" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "file too large (max 15 MB)" }, { status: 400 });

  try {
    const converted = await env.AI.toMarkdown(
      {
        name: file.name,
        blob: new Blob([file], { type: "application/pdf" }),
      },
      {
        conversionOptions: {
          pdf: { metadata: false },
          output: { format: "text" },
        },
      },
    );
    const result = Array.isArray(converted) ? converted[0] : converted;
    if (!result || result.format === "error") {
      return Response.json({ error: result?.error || "PDF text extraction failed" }, { status: 400 });
    }
    const text = String(result.data || "").trim();
    if (!text) {
      return Response.json(
        { error: "PDF has no selectable text. Scanned/image-only PDFs are not supported." },
        { status: 400 },
      );
    }
    const tracks = parseAudioguide(text.split(/\r?\n/), file.name);
    return Response.json({ filename: file.name, tracks });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message.replace(/\.docx/g, ".pdf") }, { status: 400 });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/parse-pdf") {
      return handlePdfParse(req, env, ctx);
    }

    let res = await durable.fetch(req, env, ctx);
    res = await recoverStartingJob(req, env, url, res);
    if (req.method !== "GET" || url.pathname !== "/" || !(res.headers.get("Content-Type") || "").includes("text/html")) {
      return res;
    }
    const html = await res.text();
    return new Response(preserveBatchProgress(enablePdfUi(injectExistingPerf(html))), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  },
};
