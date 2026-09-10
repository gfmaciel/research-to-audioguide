import base from './index.js';

// Thin wrapper so performance/offline behavior stays isolated from the core
// parser/TTS implementation. Static assets continue to be handled by Workers
// Assets; we only inject the tiny browser-side enhancement into the app page.
export default {
  async fetch(req, env, ctx) {
    const res = await base.fetch(req, env, ctx);
    const url = new URL(req.url);
    const contentType = res.headers.get('Content-Type') || '';

    if (req.method === 'GET' && url.pathname === '/' && res.ok && contentType.includes('text/html')) {
      const html = await res.text();
      if (html.includes('docx → áudio')) {
        const headers = new Headers(res.headers);
        return new Response(html.replace('</body></html>', '<script src="/perf.js"></script></body></html>'), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
      return new Response(html, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    return res;
  },
};

export { docxToParagraphs, parseAudioguide, splitText, slugify } from './index.js';
