(() => {
  const DB_NAME = 'audioguide-state';
  const DB_STORE = 'kv';
  const DOC_KEY = 'document';
  const SINGLE_KEY = 'audioguide_single_jobs_v1';
  const BATCH_KEY = 'audioguide_batch_job';

  if (typeof TRACKS === 'undefined' || typeof generateOne !== 'function' || typeof generateAll !== 'function') return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const activeSingles = new Map();

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    });
  }

  async function dbGet(key) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function dbPut(key, value) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
      });
    } finally {
      db.close();
    }
  }

  function cleanTracks(tracks) {
    return (tracks || []).map(t => ({
      number: t.number,
      title: t.title,
      cue: t.cue || '',
      text: t.text,
      chars: t.chars || String(t.text || '').length,
      preview: t.preview || String(t.text || '').slice(0, 160),
    }));
  }

  async function saveDocument(sourceName) {
    if (!TRACKS.length) return;
    await dbPut(DOC_KEY, {
      version: 1,
      sourceName: sourceName || DOCNAME || 'documento',
      docname: DOCNAME || 'audioguia',
      voice: VOICE,
      tracks: cleanTracks(TRACKS),
      savedAt: Date.now(),
    });
  }

  function loadSingleJobs() {
    try {
      const value = JSON.parse(localStorage.getItem(SINGLE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function saveSingleJobs(jobs) {
    try { localStorage.setItem(SINGLE_KEY, JSON.stringify(jobs)); } catch (_) {}
  }

  function setSingleJob(index, jobId) {
    const jobs = loadSingleJobs();
    if (jobId) jobs[index] = jobId;
    else delete jobs[index];
    saveSingleJobs(jobs);
  }

  function addTrackControls(wrap) {
    const all = document.createElement('button');
    all.id = 'batchall';
    all.textContent = '2. Gerar áudio de todas';
    all.onclick = () => generateAll(all);
    wrap.appendChild(all);

    const zip = document.createElement('button');
    zip.id = 'zipall';
    zip.disabled = true;
    zip.textContent = '3. Baixar tudo (.zip)';
    zip.onclick = downloadAll;
    wrap.appendChild(zip);
  }

  function renderDocument(state) {
    TRACKS = cleanTracks(state.tracks);
    DOCNAME = state.docname || 'audioguia';
    if (state.voice && VOICES.includes(state.voice)) {
      VOICE = state.voice;
      renderVoices();
    }

    const wrap = document.getElementById('tracks');
    wrap.innerHTML = '';
    addTrackControls(wrap);
    TRACKS.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'card';
      d.id = 'card' + i;
      d.innerHTML = '<h3>' + String(t.number).padStart(2, '0') + ' — ' + esc(t.title) + '</h3>'
        + (t.cue ? '<p class="cue">Ouvir quando: ' + esc(t.cue) + '</p>' : '')
        + '<p class="muted">' + t.chars + ' caracteres</p>'
        + '<details><summary>ver texto</summary><p>' + esc(t.text).replace(/\n/g, '<br>') + '</p></details>'
        + '<button data-i="' + i + '">Gerar esta faixa</button><div class="out"></div>';
      wrap.appendChild(d);
    });
    wrap.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => generateOne(+b.dataset.i));
    refreshZipBtn();
  }

  async function installSingleAudio(index, jobId, meta) {
    const t = TRACKS[index];
    if (!t) return false;
    const r = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/audio/0');
    if (!r.ok) return false;

    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: r.headers.get('Content-Type') || 'audio/wav' });
    const url = URL.createObjectURL(blob);
    if (t._url) URL.revokeObjectURL(t._url);
    t._url = url;
    t._buf = buf;
    t._file = meta.file || (String(t.number).padStart(2, '0') + '_' + slug(t.title) + '.wav');

    const out = document.querySelector('#card' + index + ' .out');
    if (out) {
      out.innerHTML = '<p class="muted">via ' + esc(meta.provider || '?') + ' · ' + esc(meta.voice || VOICE) + '</p>'
        + '<audio controls src="' + url + '"></audio><br>'
        + '<a href="' + url + '" download="' + esc(t._file) + '">Baixar ' + esc(t._file) + '</a>';
    }
    refreshZipBtn();
    return true;
  }

  async function monitorSingle(index, jobId) {
    if (activeSingles.get(index) === jobId) return;
    activeSingles.set(index, jobId);
    const btn = document.querySelector('button[data-i="' + index + '"]');
    const out = document.querySelector('#card' + index + ' .out');
    if (btn) btn.textContent = 'Cancelar';
    if (out) out.innerHTML = '<p>Gerando no servidor…</p>';

    try {
      for (;;) {
        if (activeSingles.get(index) !== jobId) return;
        try {
          const r = await fetch('/api/jobs/' + encodeURIComponent(jobId));
          if (!r.ok) {
            if (r.status === 404) {
              setSingleJob(index, null);
              if (out) out.innerHTML = '<p style="color:#b00">A geração não foi encontrada no servidor.</p>';
              return;
            }
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || ('HTTP ' + r.status));
          }

          const data = await r.json();
          if (data.state === 'complete') {
            if (data.ready && data.ready[0]) {
              await installSingleAudio(index, jobId, data.ready[0]);
            } else if (data.failed && data.failed[0]) {
              if (out) out.innerHTML = '<p style="color:#b00">Falhou: ' + esc(data.failed[0].error || 'erro desconhecido') + '</p>';
              setSingleJob(index, null);
            }
            return;
          }
          if (data.state === 'errored' || data.state === 'terminated') {
            if (out) out.innerHTML = data.state === 'terminated'
              ? '<p>Cancelado.</p>'
              : '<p style="color:#b00">Falhou: ' + esc(data.error || 'erro desconhecido') + '</p>';
            setSingleJob(index, null);
            return;
          }
          if (out) out.innerHTML = '<p>Gerando no servidor… Pode atualizar/fechar a página.</p>';
        } catch (e) {
          if (out) out.innerHTML = navigator.onLine
            ? '<p>Sem conseguir consultar a geração — tentando novamente…</p>'
            : '<p>Sem internet. A geração continua no servidor.</p>';
        }
        await sleep(3000);
      }
    } finally {
      if (activeSingles.get(index) === jobId) activeSingles.delete(index);
      if (btn) btn.textContent = 'Gerar esta faixa';
      refreshZipBtn();
    }
  }

  generateOne = async function(index) {
    const t = TRACKS[index];
    if (!t) return false;

    const active = activeSingles.get(index);
    if (active) {
      activeSingles.delete(index);
      setSingleJob(index, null);
      try { await fetch('/api/jobs/' + encodeURIComponent(active), { method: 'DELETE' }); } catch (_) {}
      const out = document.querySelector('#card' + index + ' .out');
      if (out) out.innerHTML = '<p>Cancelado.</p>';
      return false;
    }

    const remembered = loadSingleJobs()[index];
    if (remembered) {
      await monitorSingle(index, remembered);
      return !!TRACKS[index]?._buf;
    }

    const jobId = 's' + crypto.randomUUID().replace(/-/g, '');
    setSingleJob(index, jobId);
    const out = document.querySelector('#card' + index + ' .out');
    if (out) out.innerHTML = '<p>Iniciando geração no servidor…</p>';

    try {
      const r = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, tracks: [t], voice: VOICE, docname: DOCNAME }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        // If the request response was lost after the server accepted it, the
        // following monitor will recover by the client-generated job id.
        if (r.status !== 409) throw new Error(err.error || ('HTTP ' + r.status));
      }
    } catch (e) {
      if (navigator.onLine) {
        // Do not immediately retry POST: that could duplicate an accepted TTS
        // request. Query the deterministic job id instead.
      }
    }

    await monitorSingle(index, jobId);
    return !!TRACKS[index]?._buf;
  };

  const parseBtn = document.getElementById('parse');
  if (parseBtn && typeof parseBtn.onclick === 'function') {
    const originalParse = parseBtn.onclick;
    parseBtn.onclick = async () => {
      const file = document.getElementById('file')?.files?.[0] || null;
      await originalParse();
      if (TRACKS.length && file) {
        try {
          localStorage.removeItem(SINGLE_KEY);
          await saveDocument(file.name);
        } catch (e) {
          status.textContent += ' (Não consegui salvar o estado para restauração após atualização.)';
        }
      }
    };
  }

  async function restore() {
    // A durable all-tracks job owns restoration when one exists; its manifest
    // is the authoritative copy of the document in that case.
    try {
      if (localStorage.getItem(BATCH_KEY)) return;
    } catch (_) {}

    let state;
    try { state = await dbGet(DOC_KEY); } catch (_) { return; }
    if (!state || !Array.isArray(state.tracks) || !state.tracks.length) return;

    renderDocument(state);
    status.textContent = 'Documento restaurado: ' + (state.sourceName || state.docname || 'audioguia') + '.';

    const jobs = loadSingleJobs();
    for (const [key, jobId] of Object.entries(jobs)) {
      const index = Number(key);
      if (Number.isInteger(index) && TRACKS[index] && typeof jobId === 'string') monitorSingle(index, jobId);
    }
  }

  restore();
})();
