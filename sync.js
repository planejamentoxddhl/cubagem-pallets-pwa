const SyncWorker = {
  isSyncing: false,
  timerId: null,
  _started: false,
  authError: false,
  onAuthError: null,

  start(onAuthError) {
    if (onAuthError) this.onAuthError = onAuthError;

    if (!this._started) {
      window.addEventListener('online', () => this.processQueue());
      window.addEventListener('offline', () => this.updateBadge());
      this._started = true;
    }

    this.authError = false;
    this._scheduleNext(500);
  },

  resetAuthError() {
    this.authError = false;
    this.updateBadge();
  },

  _scheduleNext(delayMs) {
    if (this.timerId) clearTimeout(this.timerId);
    // Jitter aleatório entre 4s e 7s para evitar thundering herd nos 40 stages
    const nextDelay = typeof delayMs === 'number'
      ? delayMs
      : 4000 + Math.floor(Math.random() * 3000);
    this.timerId = setTimeout(async () => {
      await this.processQueue();
      this._scheduleNext();
    }, nextDelay);
  },

  async updateBadge() {
    const items = await CubagemDB.getAllPending();
    const quarantinedCount = items.filter((i) => i.quarantined).length;
    const pendingCount = items.length - quarantinedCount;

    const pill = document.getElementById('sync-status');
    const text = document.getElementById('sync-text');

    if (this.authError) {
      pill.className = 'sync-pill error';
      text.textContent = `TOKEN INVÁLIDO • ${pendingCount} na fila`;
    } else if (!navigator.onLine) {
      pill.className = 'sync-pill offline';
      text.textContent = `OFFLINE • ${pendingCount} na fila`;
    } else if (this.isSyncing && pendingCount > 0) {
      pill.className = 'sync-pill syncing';
      text.textContent = `${pendingCount} na fila — sincronizando...`;
    } else if (quarantinedCount > 0) {
      pill.className = 'sync-pill error';
      text.textContent = `${pendingCount} pend. • ${quarantinedCount} erro(s)`;
    } else {
      pill.className = 'sync-pill';
      text.textContent = pendingCount > 0 ? `${pendingCount} pendente(s)` : 'Sincronizado';
    }
  },

  _getSyncConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('cubagem_config') || '{}');
    } catch (_) {
      saved = {};
    }
    const defaults = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {};
    return {
      apiUrl: (defaults.apiUrl || saved.apiUrl || '').trim(),
      token: (defaults.token || saved.token || '').trim()
    };
  },

  async processQueue() {
    await this.updateBadge();
    if (!navigator.onLine || this.isSyncing || this.authError) return;

    const config = this._getSyncConfig();
    if (!config.apiUrl) return;

    const allItems = await CubagemDB.getAllPending();
    const items = allItems.filter((item) => !item.quarantined);
    if (items.length === 0) return;

    this.isSyncing = true;
    await this.updateBadge();

    for (const item of items) {
      if (!navigator.onLine) break;

      try {
        const { quarantined, retry_count, ...cleanItem } = item;
        const payload = { ...cleanItem, token: config.token };

        const response = await fetch(config.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          redirect: 'follow',
          body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        let result;
        try {
          result = JSON.parse(rawText);
        } catch (_) {
          console.warn(`Resposta não-JSON do Apps Script (HTTP ${response.status}):`, rawText.slice(0, 160));
          break;
        }

        if (result.status === 'ok') {
          await CubagemDB.remove(item.id_captura_local);
        } else if (result.status === 'unauthorized') {
          this.authError = true;
          console.error('Token rejeitado pelo servidor:', result.message);
          if (this.onAuthError) this.onAuthError(result.message || 'Token inválido.');
          break;
        } else if (result.status === 'invalid_payload') {
          // Evita head-of-line blocking sem apagar evidência local
          const attempts = (item.retry_count || 0) + 1;
          await CubagemDB.update({
            ...item,
            retry_count: attempts,
            quarantined: attempts >= 3
          });
          console.warn('Payload rejeitado pelo servidor:', result.message);
        } else {
          // Servidor ocupado (LockService) ou erro temporário -> tenta no próximo ciclo com jitter
          console.warn('Servidor ocupado ou erro temporário:', result.message);
          break;
        }
      } catch (err) {
        console.warn('Falha de rede durante sincronização:', err);
        break;
      }

      await this.updateBadge();
    }

    this.isSyncing = false;
    await this.updateBadge();
  }
};
