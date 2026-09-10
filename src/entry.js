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

export default {
  async fetch(req, env, ctx) {
    const res = await durable.fetch(req, env, ctx);
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/" || !(res.headers.get("Content-Type") || "").includes("text/html")) {
      return res;
    }
    const html = await res.text();
    return new Response(injectExistingPerf(html), { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};
