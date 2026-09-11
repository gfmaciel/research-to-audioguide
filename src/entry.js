import durable, { AudioguideBatchWorkflow } from "./background.js";

export { AudioguideBatchWorkflow };

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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    let res = await durable.fetch(req, env, ctx);
    res = await recoverStartingJob(req, env, url, res);
    if (req.method !== "GET" || url.pathname !== "/" || !(res.headers.get("Content-Type") || "").includes("text/html")) {
      return res;
    }
    const html = await res.text();
    return new Response(injectExistingPerf(html), { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};