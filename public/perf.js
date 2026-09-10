(() => {
  // Loaded only on the authenticated app page. Keep this deliberately small:
  // the free Gemini TTS bucket has been observed at 3 requests/minute, so a
  // 3-wide pool gives useful parallelism without an uncontrolled request burst.
  const BATCH_PARALLEL = 3;
  const BATCH_WINDOW_MS = 60000;

  if (typeof TRACKS === 'undefined' || typeof generateOne !== 'function' || typeof generateAll !== 'function') return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const transientTtsError = message => /Gemini HTTP (429|500|502|503|504)|HTTP (429|500|502|503|504)/i.test(message || '');
  const retryDelay = (message, attempt) => /HTTP 429/i.test(message || '') ? 65000 : [2000, 5000][attempt];

  async function waitForOnline() {
    if (navigator.onLine) return;
    status.textContent = 'Sem internet — a geração retoma automaticamente quando a conexão voltar.';
    await new Promise(resolve => addEventListener('online', resolve, { once: true }));
  }

  async function sleepBatchWindow(ms) {
    const step = 250;
    for (let elapsed = 0; elapsed < ms && !stopBatch; elapsed += step) {
      await sleep(Math.min(step, ms - elapsed));
    }
  }

  async function sleepOrAbort(ms, signal) {
    const step = 250;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await sleep(Math.min(step, ms - elapsed));
    }
  }

  generateOne = async function(i) {
    const t = TRACKS[i];
    const out = document.querySelector('#card' + i + ' .out');
    const btn = document.querySelector('button[data-i="' + i + '"]');
    if (CTRL[i]) {
      CTRL[i].abort();
      return false;
    }

    const c = new AbortController();
    CTRL[i] = c;
    CTRL.current = c;
    if (btn) btn.textContent = 'Cancelar';
    out.innerHTML = '<p>Gerando… (gemini → openrouter)</p>';

    let retry = 0;
    try {
      for (;;) {
        await waitForOnline();
        if (c.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        let r;
        try {
          r = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: t.text, title: t.title, number: t.number, voice: VOICE }),
            signal: c.signal,
          });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (!navigator.onLine) {
            out.innerHTML = '<p>Sem internet — aguardando para retomar…</p>';
            continue;
          }
          throw e;
        }

        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          const message = e.error || ('HTTP ' + r.status);
          if (retry < 2 && transientTtsError(message)) {
            const delay = retryDelay(message, retry++);
            out.innerHTML = '<p>Limite/instabilidade temporária — tentando de novo automaticamente…</p>';
            await sleepOrAbort(delay, c.signal);
            continue;
          }
          throw new Error(message);
        }

        const ct = r.headers.get('Content-Type') || '';
        const ext = ct.includes('mpeg') ? 'mp3' : 'wav';
        const prov = r.headers.get('X-Provider') || '?';
        const vused = r.headers.get('X-Voice') || VOICE;
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const name = String(t.number).padStart(2, '0') + '_' + slug(t.title) + '.' + ext;

        if (t._url) URL.revokeObjectURL(t._url);
        t._url = url;
        t._buf = await blob.arrayBuffer();
        t._file = name;
        refreshZipBtn();
        out.innerHTML = '<p class="muted">via ' + esc(prov) + ' · ' + esc(vused) + '</p>'
          + '<audio controls src="' + url + '"></audio><br>'
          + '<a href="' + url + '" download="' + name + '">Baixar ' + name + '</a>';
        return true;
      }
    } catch (e) {
      out.innerHTML = e && e.name === 'AbortError'
        ? '<p>Cancelado.</p>'
        : '<p style="color:#b00">Falhou: ' + esc(e.message) + '</p>';
      return false;
    } finally {
      delete CTRL[i];
      if (CTRL.current === c) CTRL.current = null;
      if (btn) btn.textContent = 'Gerar esta faixa';
      refreshZipBtn();
    }
  };

  generateAll = async function(btn) {
    if (batchOn) {
      stopBatch = true;
      for (const key of Object.keys(CTRL)) {
        if (key !== 'current' && CTRL[key]) CTRL[key].abort();
      }
      return;
    }

    const pending = TRACKS.map((t, i) => ({ t, i })).filter(x => !x.t._buf && !CTRL[x.i]).map(x => x.i);
    if (!pending.length) {
      status.textContent = 'Todas as faixas já estão geradas.';
      return;
    }

    batchOn = true;
    stopBatch = false;
    btn.textContent = '■ Parar';
    let failed = 0;

    try {
      for (let start = 0; start < pending.length && !stopBatch; start += BATCH_PARALLEL) {
        const wave = pending.slice(start, start + BATCH_PARALLEL);
        const waveStartedAt = Date.now();
        const readyBefore = TRACKS.filter(t => t._buf).length;
        status.textContent = 'Gerando ' + wave.length + ' faixa(s) em paralelo — ' + readyBefore + '/' + TRACKS.length + ' prontas.';

        const results = await Promise.all(wave.map(i => generateOne(i)));
        if (stopBatch) break;
        failed += results.filter(ok => !ok).length;

        const ready = TRACKS.filter(t => t._buf).length;
        const hasMore = start + BATCH_PARALLEL < pending.length;
        if (hasMore) {
          const wait = Math.max(0, BATCH_WINDOW_MS - (Date.now() - waveStartedAt));
          if (wait) {
            status.textContent = ready + '/' + TRACKS.length + ' prontas — aguardando a próxima janela da API…';
            await sleepBatchWindow(wait);
          }
        }
      }

      const ready = TRACKS.filter(t => t._buf).length;
      if (stopBatch) {
        status.textContent = 'Parado — ' + ready + '/' + TRACKS.length + ' faixa(s) prontas.';
      } else if (failed) {
        status.textContent = 'Concluído: ' + ready + '/' + TRACKS.length + ' prontas; ' + failed + ' falharam.';
      } else {
        status.textContent = 'Pronto: ' + ready + '/' + TRACKS.length + ' faixa(s).';
      }
    } finally {
      batchOn = false;
      stopBatch = false;
      btn.textContent = '2. Gerar áudio de todas';
    }
  };

  addEventListener('offline', () => {
    if (batchOn) status.textContent = 'Sem internet — a geração retoma automaticamente quando a conexão voltar.';
  });
})();
