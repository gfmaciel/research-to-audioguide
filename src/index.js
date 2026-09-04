import { unzipSync } from "fflate";

// Single-file Cloudflare Worker: upload a MASTER .docx audioguide, get one
// audio file per track. Gemini is primary TTS, OpenRouter is the fallback.
// Auth is one shared password; a long-lived HttpOnly cookie keeps the phone
// logged in for a year.
//
// Parsing mirrors the local chile-audioguia pipeline:
//   [[TRACK:NN]] ... [[/TRACK]] blocks, FAIXA NN title, OUVIR QUANDO cue
//   (display only, never narrated), [[NARRATION]] ... [[/NARRATION]] is the
//   only text sent to TTS, [[NOTES]] is always skipped. Inline expressive
//   tags like [curious] are kept verbatim (gemini-inline-en).

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const COOKIE_NAME = "auth";
const COOKIE_MAX_AGE = 31536000; // 1 year, sticks on the phone

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  const cookie = getCookie(req, COOKIE_NAME);
  if (!cookie) return false;
  return timingSafeEqual(cookie, await sha256hex(env.APP_PASSWORD));
}

function authCookieHeader(req, hash) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${hash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// docx -> paragraphs
// ---------------------------------------------------------------------------

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function docxToParagraphs(buf) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error("not a valid .docx (unzip failed)");
  }
  const xmlFile = files["word/document.xml"];
  if (!xmlFile) throw new Error("not a valid .docx (word/document.xml missing)");
  const xml = new TextDecoder().decode(xmlFile);
  const paras = [];
  const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(xml)) !== null) {
    const inner = pm[1]
      .replace(/<w:br(?:\s[^>]*)?\/>/g, "\n")
      .replace(/<w:tab(?:\s[^>]*)?\/>/g, " ");
    const parts = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm;
    while ((tm = tRe.exec(inner)) !== null) parts.push(xmlUnescape(tm[1]));
    paras.push(parts.join(""));
  }
  if (!paras.length) throw new Error("no paragraphs found in .docx");
  return paras;
}

// ---------------------------------------------------------------------------
// audioguide parsing (mirrors src/text.py ideas, extended for docx blocks)
// ---------------------------------------------------------------------------

const TRACK_MARKER_RE = /\[\[TRACK\s*:\s*(\d{1,3})\]\]/gi;
const NARRATION_RE = /\[\[NARRATION\]\]([\s\S]*?)\[\[\/NARRATION\]\]/i;
const TITLE_RE = /^(?:FAIXA|BLOCO|TRACK)\s*#?\s*\d{1,3}\s*[:.\-–—]?\s*(.+)$/i;
const CUE_RE = /^OUVIR QUANDO\s*:\s*(.+)$/i;
const MARKER_LINE_RE = /^\[\[.*\]\]$/;
const SEPARATOR_RE = /^-{3,}\s*pausa\s*\/\s*trocar\s+de\s+faixa\s*-{3,}$/i;
const LEGACY_MARKER_RE =
  /^\s*(?:#{1,6}\s*)?(?:\[\s*)?(?:faixa|track|bloco)\s*#?\s*(\d{1,3})(?:\s*(?:\]|[:.\-–—])\s*|\s+)(.*?)(?:\s*\])?\s*$/i;

function cleanBody(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function fallbackBodyText(body) {
  const lines = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) {
      lines.push("");
      continue;
    }
    if (MARKER_LINE_RE.test(t)) continue;
    if (SEPARATOR_RE.test(t)) continue;
    if (TITLE_RE.test(t)) continue;
    if (CUE_RE.test(t)) continue;
    lines.push(line);
  }
  return cleanBody(lines.join("\n"));
}

function stemOf(filename) {
  const base = String(filename || "audio").split(/[\\/]/).pop();
  return base.replace(/\.[^.]+$/, "") || "audio";
}

export function parseAudioguide(paragraphs, filename) {
  const full = paragraphs.join("\n");
  const markers = [...full.matchAll(TRACK_MARKER_RE)];

  if (markers.length) {
    const tracks = [];
    for (let i = 0; i < markers.length; i++) {
      const number = parseInt(markers[i][1], 10);
      const bodyStart = markers[i].index + markers[i][0].length;
      const bodyEnd = i + 1 < markers.length ? markers[i + 1].index : full.length;
      const body = full.slice(bodyStart, bodyEnd);

      let title = `Faixa ${number}`;
      let cue = "";
      for (const line of body.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (MARKER_LINE_RE.test(t)) continue;
        let m = t.match(TITLE_RE);
        if (m && m[1].trim()) title = m[1].trim();
        m = t.match(CUE_RE);
        if (m && m[1].trim()) cue = m[1].trim();
        if (title !== `Faixa ${number}` && cue) break;
        if (t.startsWith("[[NARRATION")) break;
      }

      const narr = body.match(NARRATION_RE);
      const text = narr ? cleanBody(narr[1]) : fallbackBodyText(body);
      if (!text) continue;
      tracks.push({ number, title, cue, text, chars: text.length, preview: text.slice(0, 160) });
    }
    if (!tracks.length) throw new Error("no narratable tracks found in .docx");
    return tracks;
  }

  // Legacy fallback: FAIXA/TRACK/BLOCO line markers (like the .txt pipeline).
  const lines = full.split("\n");
  const positions = [];
  lines.forEach((line, idx) => {
    const m = line.match(LEGACY_MARKER_RE);
    if (m) positions.push({ idx, number: parseInt(m[1], 10), title: (m[2] || "").trim() || `Faixa ${m[1]}` });
  });
  if (positions.length) {
    const tracks = positions.map((pos, i) => {
      const end = i + 1 < positions.length ? positions[i + 1].idx : lines.length;
      const text = cleanBody(
        lines
          .slice(pos.idx + 1, end)
          .filter((l) => {
            const t = l.trim();
            return t && !MARKER_LINE_RE.test(t) && !SEPARATOR_RE.test(t) && !CUE_RE.test(t);
          })
          .join("\n"),
      );
      return { number: pos.number, title: pos.title, cue: "", text, chars: text.length, preview: text.slice(0, 160) };
    });
    const nonEmpty = tracks.filter((t) => t.text);
    if (!nonEmpty.length) throw new Error("markers found but no narratable text");
    return nonEmpty;
  }

  // No markers at all: whole doc minus [[...]] lines becomes one track.
  const text = cleanBody(
    lines
      .filter((l) => {
        const t = l.trim();
        return t && !MARKER_LINE_RE.test(t);
      })
      .join("\n"),
  );
  if (!text) throw new Error("no narratable text found in .docx");
  return [{ number: 1, title: stemOf(filename), cue: "", text, chars: text.length, preview: text.slice(0, 160) }];
}

// ---------------------------------------------------------------------------
// text utils
// ---------------------------------------------------------------------------

export function splitText(text, maxChars) {
  if (maxChars < 1) throw new Error("max_chars must be positive");
  if (text.length <= maxChars) return [text];
  const boundary = /\n\s*\n|\n|(?<=[.!?…])\s+|(?<=[;:])\s+|\s+/g;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const limit = Math.min(start + maxChars, text.length);
    if (limit === text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const window = text.slice(start, limit);
    let end = 0;
    for (const m of window.matchAll(boundary)) end = m.index + m[0].length;
    if (end <= 0) end = limit - start;
    chunks.push(text.slice(start, start + end));
    start += end;
  }
  return chunks;
}

export function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "faixa";
}

// ---------------------------------------------------------------------------
// audio utils (WAV wrap + concat, no ffmpeg needed)
// ---------------------------------------------------------------------------

function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bits = 16 } = {}) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const out = new Uint8Array(44 + bytes.length);
  const v = new DataView(out.buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + bytes.length, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, (sampleRate * channels * bits) / 8, true);
  v.setUint16(32, (channels * bits) / 8, true);
  v.setUint16(34, bits, true);
  writeStr(36, "data");
  v.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

function isWav(u8) {
  return (
    u8.length > 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x41 &&
    u8[10] === 0x56 &&
    u8[11] === 0x45
  );
}

function parseWav(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 12;
  let channels;
  let sampleRate;
  let bits;
  let pcmStart;
  let pcmLen;
  while (off + 8 <= u8.length) {
    const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 8, true);
      sampleRate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    }
    if (id === "data") {
      pcmStart = off + 8;
      pcmLen = Math.min(size, u8.length - pcmStart);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (pcmStart === undefined) throw new Error("invalid WAV (no data chunk)");
  return { channels, sampleRate, bits, pcm: u8.slice(pcmStart, pcmStart + pcmLen) };
}

function concatWavs(list) {
  const parsed = list.map((b) => parseWav(b));
  const first = parsed[0];
  for (const p of parsed.slice(1)) {
    if (p.channels !== first.channels || p.sampleRate !== first.sampleRate || p.bits !== first.bits) {
      throw new Error("cannot merge audio parts with different formats");
    }
  }
  const total = parsed.reduce((n, p) => n + p.pcm.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const p of parsed) {
    pcm.set(p.pcm, off);
    off += p.pcm.length;
  }
  return pcmToWav(pcm, { sampleRate: first.sampleRate, channels: first.channels, bits: first.bits });
}

function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function findAudioData(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.output_audio;
  if (direct && typeof direct === "object" && typeof direct.data === "string") return direct.data;
  const output = payload.output;
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i--) {
      const item = output[i];
      if (!item || typeof item !== "object") continue;
      if (typeof item.data === "string" && (item.type == null || ["audio", "output_audio"].includes(item.type))) {
        return item.data;
      }
      if (item.audio && typeof item.audio === "object" && typeof item.audio.data === "string") return item.audio.data;
    }
  }
  const candidates = payload.candidates;
  if (Array.isArray(candidates)) {
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      const parts = cand.content && cand.content.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const inline = part.inlineData || part.inline_data;
        if (inline && typeof inline === "object" && typeof inline.data === "string") return inline.data;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TTS providers: Gemini primary, OpenRouter fallback
// ---------------------------------------------------------------------------

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

async function geminiSynthesize(env, text) {
  const key = (env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("Gemini API key is not configured");
  const model = (env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts").trim();
  const voice = (env.GEMINI_TTS_VOICE || "").trim();
  const direction = (env.TTS_DIRECTION || "").trim();
  const prompt = direction
    ? `${direction}\n\nLeia e narre exatamente o texto a seguir, sem acrescentar, remover ou resumir palavras:\n\n${text}`
    : text;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } : {},
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const b64 = findAudioData(data);
  if (!b64) throw new Error("Gemini response did not contain output audio");
  let bytes;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    throw new Error("Gemini returned invalid base64 audio");
  }
  if (!isWav(bytes)) bytes = pcmToWav(bytes); // 24 kHz mono 16-bit PCM
  return { bytes, format: "wav" };
}

async function openrouterSynthesize(env, text) {
  const key = (env.OPENROUTER_API_KEY || "").trim();
  if (!key) throw new Error("OpenRouter API key is not configured");
  const model = (env.OPENROUTER_TTS_MODEL || "").trim();
  if (!model) throw new Error("OpenRouter model is not configured");
  const voice = (env.OPENROUTER_TTS_VOICE || "").trim();
  const upstream = model.toLowerCase().startsWith("google/gemini") ? "pcm" : "mp3";
  const payload = { model, input: text, response_format: upstream };
  if (voice) payload.voice = voice;
  const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "audio/*" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("OpenRouter returned empty audio");
  if (upstream === "pcm") return { bytes: isWav(bytes) ? bytes : pcmToWav(bytes), format: "wav" };
  return { bytes, format: "mp3" };
}

async function speakText(env, text) {
  const maxChars = Math.max(500, parseInt(env.TTS_MAX_CHARS || "4000", 10) || 4000);
  const chunks = splitText(text, maxChars);
  if (chunks.length === 1) {
    try {
      const r = await geminiSynthesize(env, text);
      return { ...r, provider: "gemini" };
    } catch (e1) {
      try {
        const r = await openrouterSynthesize(env, text);
        return { ...r, provider: "openrouter" };
      } catch (e2) {
        throw new Error(`all providers failed — gemini: ${errMsg(e1)}; openrouter: ${errMsg(e2)}`);
      }
    }
  }
  // Long track: synthesize parts and merge as WAV (no ffmpeg on Workers).
  const parts = [];
  const used = new Set();
  for (const chunk of chunks) {
    let r = null;
    try {
      r = { ...(await geminiSynthesize(env, chunk)), provider: "gemini" };
    } catch (e1) {
      try {
        const o = await openrouterSynthesize(env, chunk);
        if (o.format !== "wav") throw new Error("OpenRouter returned mp3; long tracks need a PCM/WAV fallback model");
        r = { ...o, provider: "openrouter" };
      } catch (e2) {
        throw new Error(`part failed — gemini: ${errMsg(e1)}; openrouter: ${errMsg(e2)}`);
      }
    }
    parts.push(r.bytes);
    used.add(r.provider);
  }
  return { bytes: concatWavs(parts), format: "wav", provider: [...used].join("+") };
}

// ---------------------------------------------------------------------------
// UI (deliberately plain; must work well on a phone)
// ---------------------------------------------------------------------------

const LOGIN_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audioguia — entrar</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}
input,button{font-size:1.1rem;padding:.6rem;width:100%;box-sizing:border-box;margin:.4rem 0}
button{cursor:pointer}#err{color:#b00;min-height:1.4em}</style></head><body>
<h1>Audioguia</h1>
<p>Digite a senha para continuar.</p>
<input id="pw" type="password" placeholder="Senha" autocomplete="current-password">
<button id="go">Entrar</button>
<p id="err"></p>
<script>
const pw=document.getElementById('pw'),err=document.getElementById('err');
async function login(){
  err.textContent='';
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:pw.value})});
  if(r.ok){location.href='/';}else{err.textContent='Senha incorreta.';}
}
document.getElementById('go').onclick=login;
pw.onkeydown=e=>{if(e.key==='Enter')login();};
pw.focus();
</script></body></html>`;

const APP_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audioguia — docx para áudio</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:1rem}
input,button{font-size:1rem;padding:.6rem;margin:.3rem 0}button{cursor:pointer}
.card{border:1px solid #ccc;border-radius:.5rem;padding:.8rem;margin:.8rem 0}
.cue{color:#555;font-style:italic}audio{width:100%;margin-top:.5rem}
.muted{color:#666;font-size:.9rem}#status{min-height:1.4em;font-weight:bold}
.top{display:flex;justify-content:space-between;align-items:center}</style></head><body>
<div class="top"><h1>docx → áudio</h1><a href="/api/logout">sair</a></div>
<p class="muted">Envie o .docx MASTER. Só o texto de [[NARRATION]] é narrado; OUVIR QUANDO e NOTAS ficam de fora.</p>
<input id="file" type="file" accept=".docx">
<button id="parse">1. Ler faixas</button>
<p id="status"></p>
<div id="tracks"></div>
<script>
let TRACKS=[];
const status=document.getElementById('status');
function slug(s){return (s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'faixa';}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
document.getElementById('parse').onclick=async()=>{
  const f=document.getElementById('file').files[0];
  if(!f){status.textContent='Escolha um .docx primeiro.';return;}
  status.textContent='Lendo '+f.name+'…';
  document.getElementById('tracks').innerHTML='';TRACKS=[];
  const fd=new FormData();fd.append('file',f,f.name);
  const r=await fetch('/api/parse',{method:'POST',body:fd});
  const data=await r.json();
  if(!r.ok){status.textContent='Erro: '+(data.error||r.status);return;}
  TRACKS=data.tracks;
  status.textContent=data.tracks.length+' faixa(s) encontrada(s).';
  const wrap=document.getElementById('tracks');
  const all=document.createElement('button');
  all.textContent='2. Gerar áudio de todas';
  all.onclick=()=>generateAll(all);
  wrap.appendChild(all);
  TRACKS.forEach((t,i)=>{
    const d=document.createElement('div');d.className='card';d.id='card'+i;
    d.innerHTML='<h3>'+String(t.number).padStart(2,'0')+' — '+esc(t.title)+'</h3>'
      +(t.cue?'<p class="cue">Ouvir quando: '+esc(t.cue)+'</p>':'')
      +'<p class="muted">'+t.chars+' caracteres</p>'
      +'<details><summary>ver texto</summary><p>'+esc(t.text).replace(/\\n/g,'<br>')+'</p></details>'
      +'<button data-i="'+i+'">Gerar esta faixa</button><div class="out"></div>';
    wrap.appendChild(d);
  });
  wrap.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>generateOne(+b.dataset.i));
};
const CTRL={current:null};let stopBatch=false,batchOn=false;
async function generateOne(i){
  const t=TRACKS[i];
  const out=document.querySelector('#card'+i+' .out');
  const btn=document.querySelector('button[data-i="'+i+'"]');
  if(CTRL[i]){CTRL[i].abort();return;}
  const c=new AbortController();CTRL[i]=c;CTRL.current=c;
  if(btn)btn.textContent='Cancelar';
  out.innerHTML='<p>Gerando… (gemini → openrouter)</p>';
  try{
    const r=await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:t.text,title:t.title,number:t.number}),signal:c.signal});
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||('HTTP '+r.status));}
    const ct=r.headers.get('Content-Type')||'';
    const ext=ct.includes('mpeg')?'mp3':'wav';
    const prov=r.headers.get('X-Provider')||'?';
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const name=String(t.number).padStart(2,'0')+'_'+slug(t.title)+'.'+ext;
    out.innerHTML='<p class="muted">via '+esc(prov)+'</p>'
      +'<audio controls src="'+url+'"></audio><br>'
      +'<a href="'+url+'" download="'+name+'">Baixar '+name+'</a>';
  }catch(e){out.innerHTML=e&&e.name==='AbortError'?'<p>Cancelado.</p>':'<p style="color:#b00">Falhou: '+esc(e.message)+'</p>';}
  finally{delete CTRL[i];if(CTRL.current===c)CTRL.current=null;if(btn)btn.textContent='Gerar esta faixa';}
}
async function generateAll(btn){
  if(batchOn){stopBatch=true;if(CTRL.current)CTRL.current.abort();return;}
  batchOn=true;stopBatch=false;btn.textContent='■ Parar';
  let done=0;
  for(let i=0;i<TRACKS.length;i++){
    if(stopBatch)break;
    status.textContent='Gerando '+(i+1)+'/'+TRACKS.length+'…';
    await generateOne(i);
    done++;
  }
  status.textContent=stopBatch?('Parado em '+done+'/'+TRACKS.length+'.'):('Pronto: '+TRACKS.length+' faixa(s).');
  batchOn=false;btn.textContent='2. Gerar áudio de todas';
}
</script></body></html>`;

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      if (!env.APP_PASSWORD) return new Response("server missing APP_PASSWORD secret", { status: 500 });
      return new Response((await isAuthed(req, env)) ? APP_HTML : LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!env.APP_PASSWORD) return json({ error: "server missing APP_PASSWORD" }, 500);
      let password = "";
      try {
        password = (await req.json()).password || "";
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      if (!timingSafeEqual(String(password), env.APP_PASSWORD)) {
        return json({ error: "wrong password" }, 401);
      }
      return json({ ok: true }, 200, { "Set-Cookie": authCookieHeader(req, await sha256hex(env.APP_PASSWORD)) });
    }

    if (url.pathname === "/api/logout") {
      return new Response('<a href="/">voltar</a>', {
        headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": clearCookieHeader() },
      });
    }

    // Everything below needs the cookie.
    if (url.pathname.startsWith("/api/")) {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);

      if (req.method === "POST" && url.pathname === "/api/parse") {
        let form;
        try {
          form = await req.formData();
        } catch {
          return json({ error: "expected multipart form with a file field" }, 400);
        }
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "missing file field" }, 400);
        if (!/\.docx$/i.test(file.name || "")) return json({ error: "only .docx files are accepted" }, 400);
        if (file.size > MAX_UPLOAD_BYTES) return json({ error: "file too large (max 15 MB)" }, 400);
        try {
          const paras = docxToParagraphs(await file.arrayBuffer());
          const tracks = parseAudioguide(paras, file.name);
          return json({ filename: file.name, tracks });
        } catch (e) {
          return json({ error: errMsg(e) }, 400);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/speak") {
        let body;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid JSON" }, 400);
        }
        const text = String(body.text || "");
        if (!text.trim()) return json({ error: "empty text" }, 400);
        if (text.length > 60000) return json({ error: "text too long (max 60000 chars)" }, 400);
        try {
          const r = await speakText(env, text);
          return new Response(r.bytes, {
            headers: {
              "Content-Type": r.format === "mp3" ? "audio/mpeg" : "audio/wav",
              "X-Provider": r.provider,
              "Cache-Control": "no-store",
            },
          });
        } catch (e) {
          return json({ error: errMsg(e) }, 502);
        }
      }

      return json({ error: "not found" }, 404);
    }

    return new Response("not found", { status: 404 });
  },
};
