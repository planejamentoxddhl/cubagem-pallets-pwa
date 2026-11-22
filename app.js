const App = {
  state: 'SCAN_UC',
  activeUC: null,
  selectedBase: 'PBR_100x120',
  videoStream: null,
  torchOn: false,
  zoomHigh: false,
  zoomCaps: null,
  zxingReady: false,
  barcodeDetector: null,
  scanLoopActive: false,
  scanBusy: false,
  scanFrameCounter: 0,
  lastScanTs: 0,
  isCapturing: false,
  toastTimer: null,

  async init() {
    this.bindEvents();
    await CubagemDB.init();

    const cfg = this.getConfig();
    if (!cfg.operator || !cfg.apiUrl) {
      this.showConfigScreen();
    } else {
      this.applyHeaderConfig(cfg);
      await this.startOperations();
    }
  },

  getConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('cubagem_config') || '{}');
    } catch (_) {
      saved = {};
    }

    const defaults = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {};
    return {
      apiUrl: (defaults.apiUrl || saved.apiUrl || '').trim(),
      token: (defaults.token || saved.token || '').trim(),
      operator: (saved.operator || '').trim()
    };
  },

  showConfigScreen() {
    const cfg = this.getConfig();
    const defaults = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {};
    const hasHardcodedUrl = Boolean((defaults.apiUrl || '').trim());

    document.getElementById('cfg-operator').value = cfg.operator || '';
    document.getElementById('cfg-url').value = cfg.apiUrl || '';

    const techBox = document.getElementById('tech-config-box');
    if (hasHardcodedUrl) {
      techBox.classList.add('hidden');
      techBox.open = false;
    } else {
      techBox.classList.remove('hidden');
      techBox.open = !cfg.apiUrl;
    }

    document.getElementById('screen-config').classList.remove('hidden');
    document.getElementById('screen-main').classList.add('hidden');
    document.getElementById('cfg-operator').focus();
  },

  applyHeaderConfig(cfg) {
    document.getElementById('lbl-operator').textContent = cfg.operator;
  },

  async startOperations() {
    document.getElementById('screen-config').classList.add('hidden');
    document.getElementById('screen-main').classList.remove('hidden');

    await this.initCamera();
    LevelSensor.start((sensorData) => {
      this.updateLevelUI(sensorData);
    });
    SyncWorker.start((msg) => {
      this.showToast(`Erro de autenticação: ${msg}`, true);
    });
    this.setState('SCAN_UC');
  },

  async initCamera() {
    if (this.videoStream) return;
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      const video = document.getElementById('camera-video');
      video.srcObject = this.videoStream;
      await video.play();

      await this.configureCameraTrack();
      await this.initBarcodeReaders();
      this.startBarcodeLoop();
    } catch (err) {
      alert('Erro ao acessar câmera. Verifique permissões HTTPS: ' + err.message);
    }
  },

  async configureCameraTrack() {
    const track = this.videoStream && this.videoStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;

    try {
      const caps = track.getCapabilities();
      const advanced = [];

      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        advanced.push({ focusMode: 'continuous' });
      }

      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        this.zoomCaps = caps.zoom;
        document.getElementById('btn-zoom').classList.remove('hidden');
      }

      if (advanced.length > 0) {
        await track.applyConstraints({ advanced });
      }
    } catch (err) {
      console.warn('Ajuste opcional de foco/zoom não suportado:', err);
    }
  },

  async initBarcodeReaders() {
    const hint = document.getElementById('scan-hint');

    // 1. Motor principal universal (iOS Safari, Android e Desktop): ZXing-C++ WebAssembly
    if (typeof ZXingWASM !== 'undefined') {
      try {
        await ZXingWASM.prepareZXingModule({
          overrides: {
            locateFile: (path) =>
              path.endsWith('.wasm') ? './vendor/zxing_reader.wasm' : path
          },
          fireImmediately: true
        });
        this.zxingReady = true;
      } catch (err) {
        console.warn('Falha ao inicializar ZXingWASM:', err);
        this.zxingReady = false;
      }
    }

    // 2. Motor auxiliar nativo (Android Chrome) caso disponível
    if ('BarcodeDetector' in window) {
      try {
        const supported = typeof BarcodeDetector.getSupportedFormats === 'function'
          ? await BarcodeDetector.getSupportedFormats()
          : ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix'];
        this.barcodeDetector = new BarcodeDetector({ formats: supported });
      } catch (err) {
        console.warn('BarcodeDetector nativo indisponível:', err);
        this.barcodeDetector = null;
      }
    }

    if (hint) {
      if (this.zxingReady || this.barcodeDetector) {
        hint.innerHTML = 'Scanner ativo • Aponte para o código <strong>(~20 cm de distância)</strong>';
      } else {
        hint.innerHTML = 'Scanner indisponível neste navegador — <strong>digite o código abaixo</strong>';
      }
    }
  },

  startBarcodeLoop() {
    if (this.scanLoopActive) return;
    this.scanLoopActive = true;
    const video = document.getElementById('camera-video');
    const scanCanvas = document.getElementById('scan-canvas');
    const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

    const tick = async (ts) => {
      if (
        this.state === 'SCAN_UC' &&
        !this.scanBusy &&
        ts - this.lastScanTs >= 140 &&
        video.readyState === video.HAVE_ENOUGH_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        this.scanBusy = true;
        this.lastScanTs = ts;
        this.scanFrameCounter++;

        try {
          let detected = null;

          // Tenta BarcodeDetector nativo primeiro se existir (muito rápido no Android)
          if (this.barcodeDetector) {
            try {
              const barcodes = await this.barcodeDetector.detect(video);
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                detected = barcodes[0].rawValue;
              }
            } catch (_) {}
          }

          // ZXing-C++ WASM (funciona no iPhone 14 Pro / iOS Safari + 1D/2D de alta precisão)
          if (!detected && this.zxingReady) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;

            // Alterna entre recorte central em resolução nativa (ideal p/ 1D fino: EAN-13/Code128)
            // e quadro inteiro a cada 3 frames (pega códigos fora do retângulo central)
            const scanFullFrame = this.scanFrameCounter % 3 === 0;
            if (scanFullFrame) {
              const maxSide = 1080;
              const scale = Math.min(1, maxSide / Math.max(vw, vh));
              scanCanvas.width = Math.round(vw * scale);
              scanCanvas.height = Math.round(vh * scale);
              scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
            } else {
              const cropW = Math.round(vw * 0.88);
              const cropH = Math.round(vh * 0.45);
              const sx = Math.round((vw - cropW) / 2);
              const sy = Math.round((vh - cropH) / 2);
              scanCanvas.width = cropW;
              scanCanvas.height = cropH;
              scanCtx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
            }

            const imgData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
            const results = await ZXingWASM.readBarcodes(imgData, {
              tryHarder: true,
              tryRotate: true,
              tryInvert: true,
              tryDownscale: true,
              maxNumberOfSymbols: 1
            });

            if (results && results.length > 0 && results[0].text) {
              detected = results[0].text;
            }
          }

          if (detected) {
            this.acceptUC(detected);
          }
        } catch (_) {
          // Nenhum código detectado no frame atual
        } finally {
          this.scanBusy = false;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },

  /**
   * Aceita qualquer código bipado ou digitado (sem bloqueio por regex).
   */
  acceptUC(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return false;

    this.activeUC = code;
    if (navigator.vibrate) navigator.vibrate(80);
    this.showToast(`Código lido: ${code}`);
    this.setState('CAPTURE_PALLET');
    return true;
  },

  setState(newState) {
    this.state = newState;
    const overlayScanner = document.getElementById('overlay-scanner');
    const overlayCapture = document.getElementById('overlay-capture');
    const shutter = document.getElementById('btn-shutter');
    const frame = document.getElementById('camera-frame');

    if (newState === 'SCAN_UC') {
      this.activeUC = null;
      document.getElementById('input-uc-manual').value = '';
      overlayScanner.classList.remove('hidden');
      overlayCapture.classList.add('hidden');
      frame.classList.remove('level-ok', 'level-bad');
      shutter.disabled = true;
      shutter.classList.remove('ready');
      shutter.textContent = 'AGUARDANDO LEITURA DO CÓDIGO';
    } else if (newState === 'CAPTURE_PALLET') {
      // Ao entrar na captura do pallet, volta o zoom para 1x automaticamente para enquadrar tudo
      if (this.zoomHigh) this.setZoom(false);
      document.getElementById('active-uc-code').textContent = this.activeUC;
      overlayScanner.classList.add('hidden');
      overlayCapture.classList.remove('hidden');
      this.updateLevelUI({
        tilt: LevelSensor.currentTilt,
        pitch: LevelSensor.currentPitch,
        roll: LevelSensor.currentRoll,
        isLevel: LevelSensor.isLevel,
        status: LevelSensor.status
      });
    }
  },

  updateLevelUI({ pitch, roll, isLevel, status }) {
    if (this.state !== 'CAPTURE_PALLET') return;

    const frame = document.getElementById('camera-frame');
    const shutter = document.getElementById('btn-shutter');
    const angleLbl = document.getElementById('level-angle');
    const rollBubble = document.getElementById('level-bubble');
    const pitchBubble = document.getElementById('pitch-bubble');
    const permBtn = document.getElementById('btn-enable-sensors');

    const rollOffset = Math.max(-55, Math.min(55, (roll || 0) * 4));
    const pitchOffset = Math.max(-55, Math.min(55, (pitch || 0) * 4));
    rollBubble.style.left = `calc(50% + ${rollOffset}px)`;
    pitchBubble.style.left = `calc(50% + ${pitchOffset}px)`;

    if (status === 'NEEDS_PERMISSION' || status === 'DENIED') {
      permBtn.classList.remove('hidden');
      angleLbl.textContent =
        status === 'DENIED'
          ? 'PERMISSÃO NEGADA • REATIVE NOS AJUSTES'
          : 'GIROSCÓPIO PENDENTE DE AUTORIZAÇÃO';
      frame.className = 'camera-wrapper level-bad';
      shutter.disabled = true;
      shutter.classList.remove('ready');
      shutter.textContent = 'ATIVE O GIROSCÓPIO ACIMA';
      return;
    }

    permBtn.classList.add('hidden');

    if (status === 'NO_HARDWARE') {
      angleLbl.textContent = 'MODO COLETOR (SEM GIROSCÓPIO)';
      frame.className = 'camera-wrapper level-ok';
      shutter.disabled = false;
      shutter.classList.add('ready');
      shutter.textContent = `CAPTURAR CUBAGEM (${this.activeUC})`;
      return;
    }

    if (isLevel) {
      angleLbl.textContent = `H:${Math.abs(roll).toFixed(1)}° V:${Math.abs(pitch).toFixed(1)}° • NIVELADO`;
      frame.className = 'camera-wrapper level-ok';
      shutter.disabled = false;
      shutter.classList.add('ready');
      shutter.textContent = `CAPTURAR CUBAGEM (${this.activeUC})`;
    } else {
      angleLbl.textContent = `H:${Math.abs(roll).toFixed(1)}° V:${Math.abs(pitch).toFixed(1)}° • MÁX ±3°`;
      frame.className = 'camera-wrapper level-bad';
      shutter.disabled = true;
      shutter.classList.remove('ready');
      shutter.textContent = 'NIVELAR APARELHO PARA FOTOGRAFAR';
    }
  },

  async captureAndEnqueue() {
    if (this.isCapturing || this.state !== 'CAPTURE_PALLET' || !this.activeUC) return;

    const video = document.getElementById('camera-video');
    if (!video.videoWidth || !video.videoHeight) {
      this.showToast('Câmera ainda inicializando. Tente novamente.', true);
      return;
    }

    this.isCapturing = true;
    const shutter = document.getElementById('btn-shutter');
    shutter.disabled = true;

    try {
      const t0 = performance.now();
      const canvas = document.getElementById('capture-canvas');
      const ctx = canvas.getContext('2d');

      const MAX_WIDTH = 800;
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64Image = canvas.toDataURL('image/jpeg', 0.75);

      const cfg = this.getConfig();
      const nowIso = new Date().toISOString();
      const capturedUC = this.activeUC;
      const opTag = cfg.operator.replace(/[^A-Z0-9]/gi, '') || 'OP';
      const idCapturaLocal = `${capturedUC}_${Date.now()}_${opTag}`;

      const record = {
        id_captura_local: idCapturaLocal,
        uc: capturedUC,
        operador: cfg.operator,
        stage: '',
        tipo_base: this.selectedBase,
        angulo_inclinacao: LevelSensor.currentTilt,
        timestamp_captura: nowIso,
        imagem_base64: base64Image
      };

      await CubagemDB.enqueue(record);

      const elapsedMs = Math.round(performance.now() - t0);
      this.showToast(`UC ${capturedUC} salva (${elapsedMs}ms)`);

      this.setState('SCAN_UC');
      SyncWorker.processQueue();
    } catch (err) {
      console.error('Erro ao capturar/salvar foto:', err);
      this.showToast('Erro ao salvar captura localmente.', true);
      shutter.disabled = false;
    } finally {
      this.isCapturing = false;
    }
  },

  showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.toggle('error', isError);
    toast.classList.remove('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.add('hidden'), isError ? 3500 : 2200);
  },

  async toggleTorch() {
    if (!this.videoStream) return;
    const track = this.videoStream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) {
      this.showToast('Lanterna indisponível neste dispositivo', true);
      return;
    }
    const nextState = !this.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: nextState }] });
      this.torchOn = nextState;
      document.getElementById('btn-torch').classList.toggle('active', this.torchOn);
    } catch (err) {
      console.warn('Falha ao acionar lanterna:', err);
      this.showToast('Não foi possível alternar a lanterna.', true);
    }
  },

  async setZoom(high) {
    if (!this.videoStream || !this.zoomCaps) return;
    const track = this.videoStream.getVideoTracks()[0];
    const target = high
      ? Math.min(this.zoomCaps.max, Math.max(this.zoomCaps.min, 2.0))
      : this.zoomCaps.min;
    try {
      await track.applyConstraints({ advanced: [{ zoom: target }] });
      this.zoomHigh = high;
      const btn = document.getElementById('btn-zoom');
      btn.textContent = high ? `${target.toFixed(0)}x` : '1x';
      btn.classList.toggle('active', high);
    } catch (err) {
      console.warn('Zoom não suportado:', err);
    }
  },

  async saveConfigAndStart() {
    const defaults = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {};
    const operator = document.getElementById('cfg-operator').value.trim().toUpperCase();
    const apiUrl = (defaults.apiUrl || document.getElementById('cfg-url').value || '').trim();

    if (!operator) {
      alert('Informe sua matrícula para continuar.');
      document.getElementById('cfg-operator').focus();
      return;
    }

    if (!apiUrl) {
      const techBox = document.getElementById('tech-config-box');
      techBox.classList.remove('hidden');
      techBox.open = true;
      alert('Informe a URL do Apps Script (ou configure-a em config.js).');
      return;
    }

    // Solicita permissão de sensores no iOS ANTES de qualquer await de câmera (gesto ativo)
    if (LevelSensor.needsPermission()) {
      await LevelSensor.requestPermissions();
    }

    const cfg = {
      operator,
      apiUrl,
      token: (defaults.token || '').trim()
    };

    localStorage.setItem('cubagem_config', JSON.stringify(cfg));
    SyncWorker.resetAuthError();
    this.applyHeaderConfig(cfg);
    await this.startOperations();
  },

  bindEvents() {
    document.getElementById('btn-open-config').addEventListener('click', () => {
      this.showConfigScreen();
    });

    document.getElementById('btn-save-config').addEventListener('click', () => {
      this.saveConfigAndStart();
    });

    document.getElementById('cfg-operator').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveConfigAndStart();
    });

    document.getElementById('btn-enable-sensors').addEventListener('click', async () => {
      const ok = await LevelSensor.requestPermissions();
      if (!ok) {
        this.showToast('Permissão de movimento negada no Safari.', true);
      }
    });

    const confirmManualUC = () => {
      const val = document.getElementById('input-uc-manual').value;
      if (!this.acceptUC(val)) {
        this.showToast('Digite um código antes de confirmar.', true);
      }
    };

    document.getElementById('btn-confirm-uc-manual').addEventListener('click', confirmManualUC);
    document.getElementById('input-uc-manual').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmManualUC();
    });

    document.getElementById('btn-cancel-uc').addEventListener('click', () => {
      this.setState('SCAN_UC');
    });

    document.querySelectorAll('.base-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.base-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedBase = btn.dataset.base;
      });
    });

    document.getElementById('btn-shutter').addEventListener('click', () => {
      this.captureAndEnqueue();
    });

    document.getElementById('btn-torch').addEventListener('click', () => {
      this.toggleTorch();
    });

    document.getElementById('btn-zoom').addEventListener('click', () => {
      this.setZoom(!this.zoomHigh);
    });
  }
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

window.addEventListener('DOMContentLoaded', () => App.init());
