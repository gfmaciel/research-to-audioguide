(() => {
  // This script is loaded before the durable batch client. It owns two pieces
  // of browser state that the base page used to keep only in memory:
  // 1) the parsed document/track list; 2) individual-track Workflow ids.
  const DB_NAME = 'audioguide-state';
  const DB_STORE = 'kv';
  const DOC_KEY = 'document';
  const SINGLE_KEY = 'audioguide_single_jobs_v1';
  const BATCH_KEY = 'audioguide_batch_job';

  if (typeof TRACKS === 'undefined' || typeof generateOne !== 'function' || typeof generateAll !== 'function') return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const activeSingles = new Map();
  let documentEpoch = 0;

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

  function terminateJob(jobId) {
    if (!jobId || typeof jobId !== 'string') return;
    fetch('/api/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' }).catch(() => {});
  }

  function cancelPreviousSession() {
    documentEpoch++;

    const jobs = new Set(Object.values(loadSingleJobs()).filter(id => typeof id === 'string' && id));
    for (const id of activeSingles.values()) jobs.add(id);
    activeSingles.clear();
    saveSingleJobs({});
    jobs.forEach(terminateJob);

    for (const t of TRACKS) {
      if (t?._url) URL.revokeObjectURL(t._url);
    }

    if (typeof window.cancelAudioguideBatch === 'function') {
      window.cancelAudioguideBatch().catch(() => {});
    } else {
      try {
        const oldBatch = localStorage.getItem(BATCH_KEY);
        localStorage.removeItem(BATCH_KEY);
        terminateJob(oldBatch);
      } catch (_) {}
      try {
        batchOn = false;
        stopBatch = true;
        if (CTRL.current) CTRL.current.abort();
      } catch (_) {}
    }
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

  async function installSingleAudio(index, jobId, meta, epoch = documentEpoch) {
    if (epoch !== documentEpoch) return false;
    const t = TRACKS[index];
    if (!t) return false;
    const r = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/audio/0');
    if (!r.ok) return false;

    const buf = await r.arrayBuffer();
    if (epoch !== documentEpoch || TRACKS[index] !== t) return false;
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

  async function monitorSingle(index, jobId, epoch = documentEpoch) {
    if (epoch !== documentEpoch) return;
    if (activeSingles.get(index) === jobId) return;
    activeSingles.set(index, jobId);
    const btn = document.querySelector('button[data-i="' + index + '"]');
    const out = document.querySelector('#card' + index + ' .out');
    if (btn) btn.textContent = 'Cancelar';
    if (out) out.innerHTML = '<p>Gerando no servidor… Pode atualizar/fechar a página.</p>';

    let missingChecks = 0;
    try {
      for (;;) {
        if (epoch !== documentEpoch || activeSingles.get(index) !== jobId) return;
        try {
          const r = await fetch('/api/jobs/' + encodeURIComponent(jobId));
          if (epoch !== documentEpoch || activeSingles.get(index) !== jobId) return;
          if (!r.ok) {
            if (r.status === 404 && ++missingChecks < 4) {
              await sleep(1000);
              continue;
            }
            if (r.status === 404) {
              setSingleJob(index, null);
              if (out) out.innerHTML = '<p style="color:#b00">A geração não foi encontrada no servidor.</p>';
              return;
            }
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || ('HTTP ' + r.status));
          }

          missingChecks = 0;
          const data = await r.json();
          if (epoch !== documentEpoch || activeSingles.get(index) !== jobId) return;
          if (data.state === 'complete') {
            if (data.ready && data.ready[0]) {
              if (await installSingleAudio(index, jobId, data.ready[0], epoch)) return;
            } else if (data.failed && data.failed[0]) {
              if (out) out.innerHTML = '<p style="color:#b00">Falhou: ' + esc(data.failed[0].error || 'erro desconhecido') + '</p>';
              setSingleJob(index, null);
              return;
            }
          } else if (data.state === 'errored' || data.state === 'terminated') {
            if (out) out.innerHTML = data.state === 'terminated'
              ? '<p>Cancelado.</p>'
              : '<p style="color:#b00">Falhou: ' + esc(data.error || 'erro desconhecido') + '</p>';
            setSingleJob(index, null);
            return;
          } else if (out) {
            out.innerHTML = '<p>Gerando no servidor… Pode atualizar/fechar a página.</p>';
          }
        } catch (_) {
          if (epoch !== documentEpoch || activeSingles.get(index) !== jobId) return;
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

  async function ensureSingleStarted(index, jobId, track, epoch = documentEpoch) {
    for (;;) {
      if (epoch !== documentEpoch) return false;
      try {
        const r = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, tracks: [track], voice: VOICE, docname: DOCNAME }),
        });
        if (epoch !== documentEpoch) {
          if (r.ok || r.status === 409) terminateJob(jobId);
          return false;
        }
        if (r.ok || r.status === 409) return true;
        const err = await r.json().catch(() => ({}));
        setSingleJob(index, null);
        const out = document.querySelector('#card' + index + ' .out');
        if (out) out.innerHTML = '<p style="color:#b00">Falhou ao iniciar: ' + esc(err.error || ('HTTP ' + r.status)) + '</p>';
        return false;
      } catch (_) {
        if (epoch !== documentEpoch) return false;
        const out = document.querySelector('#card' + index + ' .out');
        if (out) out.innerHTML = navigator.onLine
          ? '<p>Sem conseguir confirmar o início — tentando novamente…</p>'
          : '<p>Sem internet — aguardando para iniciar/retomar…</p>';
        await sleep(2000);
      }
    }
  }

  // Override the old page-bound /api/speak request. A one-track Workflow uses
  // the same synthesis code but survives navigation/reload and stores audio in R2.
  generateOne = async function(index) {
    const epoch = documentEpoch;
    const t = TRACKS[index];
    if (!t) return false;

    const active = activeSingles.get(index);
    if (active) {
      activeSingles.delete(index);
      setSingleJob(index, null);
      terminateJob(active);
      const out = document.querySelector('#card' + index + ' .out');
      if (out) out.innerHTML = '<p>Cancelado.</p>';
      return false;
    }

    const remembered = loadSingleJobs()[index];
    if (remembered && !t._buf) {
      await monitorSingle(index, remembered, epoch);
      return epoch === documentEpoch && !!TRACKS[index]?._buf;
    }
    if (remembered && t._buf) setSingleJob(index, null); // explicit click = regenerate

    const jobId = 's' + crypto.randomUUID().replace(/-/g, '');
    setSingleJob(index, jobId);
    const out = document.querySelector('#card' + index + ' .out');
    if (out) out.innerHTML = '<p>Iniciando geração no servidor…</p>';

    if (!(await ensureSingleStarted(index, jobId, t, epoch))) return false;
    if (epoch !== documentEpoch) {
      terminateJob(jobId);
      return false;
    }
    await monitorSingle(index, jobId, epoch);
    return epoch === documentEpoch && !!TRACKS[index]?._buf;
  };

  // Save the parsed document after the existing DOCX/PDF parser succeeds.
  // Starting a new document also invalidates and terminates every job from the
  // previous document so late responses can never populate the new track list.
  const parseBtn = document.getElementById('parse');
  if (parseBtn && typeof parseBtn.onclick === 'function') {
    const originalParse = parseBtn.onclick;
    parseBtn.onclick = async () => {
      const file = document.getElementById('file')?.files?.[0] || null;
      if (!file) {
        await originalParse();
        return;
      }

      cancelPreviousSession();
      await originalParse();
      if (TRACKS.length) {
        try {
          localStorage.removeItem(SINGLE_KEY);
          await saveDocument(file.name);
        } catch (_) {
          status.textContent += ' (Não consegui salvar o documento para restauração após atualização.)';
        }
      }
    };
  }

  async function restoreDocument() {
    // The all-tracks durable client restores from its R2 manifest when present.
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

  addEventListener('offline', () => {
    if (activeSingles.size || batchOn) status.textContent = 'Sem internet. A geração no servidor continua.';
  });

  // Let the following durable batch script initialize first, then restore.
  setTimeout(restoreDocument, 0);
})();
