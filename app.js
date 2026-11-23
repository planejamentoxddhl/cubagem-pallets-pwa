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

  /**
   * Inicialização de câmera com fallback em 3 níveis para portabilidade total
   * (iPhones, Androids intermediários/antigos, coletores Zebra/Honeywell e desktops).
   */
  async initCamera() {
    if (this.videoStream) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Este navegador não suporta acesso à câmera. Use HTTPS no Chrome ou Safari.');
      return;
    }

    const attempts = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    ];

    let lastErr = null;
    for (const constraints of attempts) {
      try {
        this.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!this.videoStream) {
      alert('Erro ao acessar câmera. Verifique permissões HTTPS: ' + (lastErr ? lastErr.message : ''));
      return;
    }

    try {
      const video = document.getElementById('camera-video');
      video.srcObject = this.videoStream;
      await video.play();

      await this.configureCameraTrack();
      await this.initBarcodeReaders();
      this.startBarcodeLoop();
    } catch (err) {
      alert('Erro ao iniciar preview da câmera: ' + err.message);
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

    // 1. Motor universal em WebAssembly (iOS Safari, Android, Firefox, Samsung Internet, Desktop)
    if (typeof WebAssembly === 'object' && typeof ZXingWASM !== 'undefined') {
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

    // 2. Motor auxiliar nativo (Android Chrome)
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

          if (this.barcodeDetector) {
            try {
              const barcodes = await this.barcodeDetector.detect(video);
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                detected = barcodes[0].rawValue;
              }
            } catch (_) {}
          }

          if (!detected && this.zxingReady) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;

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

  acceptUC(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return false;

    this.activeUC = code;
    if (navigator.vibrate) navigator.vibrate(80);
    this.showToast(`Código lido: ${code}`);
    this.setState('CAPTURE_PALLET');
    return true;
  },

  setShutterState(enabled, label, icon = '📷') {
    const shutter = document.getElementById('btn-shutter');
    const lbl = document.getElementById('shutter-label');
    const ic = document.getElementById('shutter-icon');
    shutter.disabled = !enabled;
    shutter.classList.toggle('ready', enabled);
    lbl.textContent = label;
    ic.textContent = icon;
  },

  setState(newState) {
    this.state = newState;
    const overlayScanner = document.getElementById('overlay-scanner');
    const overlayCapture = document.getElementById('overlay-capture');
    const baseSelector = document.getElementById('base-selector');
    const frame = document.getElementById('camera-frame');

    if (newState === 'SCAN_UC') {
      this.activeUC = null;
      document.getElementById('input-uc-manual').value = '';
      overlayScanner.classList.remove('hidden');
      overlayCapture.classList.add('hidden');
      baseSelector.classList.add('hidden');
      frame.classList.remove('level-ok', 'level-bad');
      this.setShutterState(false, 'AGUARDANDO LEITURA DO CÓDIGO', '🔍');
    } else if (newState === 'CAPTURE_PALLET') {
      if (this.zoomHigh) this.setZoom(false);
      document.getElementById('active-uc-code').textContent = this.activeUC;
      overlayScanner.classList.add('hidden');
      overlayCapture.classList.remove('hidden');
      baseSelector.classList.remove('hidden');
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
    const angleLbl = document.getElementById('level-angle');
    const rollBubble = document.getElementById('level-bubble');
    const pitchBubble = document.getElementById('pitch-bubble');
    const levelAxes = document.getElementById('level-axes');
    const sensorActions = document.getElementById('sensor-actions');

    const rollOffset = Math.max(-55, Math.min(55, (roll || 0) * 3.5));
    const pitchOffset = Math.max(-55, Math.min(55, (pitch || 0) * 3.5));
    rollBubble.style.left = `calc(50% + ${rollOffset}px)`;
    pitchBubble.style.left = `calc(50% + ${pitchOffset}px)`;

    if (status === 'NEEDS_PERMISSION' || status === 'DENIED') {
      levelAxes.classList.add('hidden');
      sensorActions.classList.remove('hidden');
      angleLbl.textContent =
        status === 'DENIED'
          ? 'SENSOR BLOQUEADO PELO NAVEGADOR'
          : 'ATIVE O NÍVEL PARA GARANTIR ALINHAMENTO';
      frame.className = 'camera-wrapper level-bad';
      this.setShutterState(false, 'ATIVE O NÍVEL ACIMA PARA CAPTURAR', '⚠️');
      return;
    }

    sensorActions.classList.add('hidden');

    if (status === 'NO_HARDWARE' || status === 'BYPASSED') {
      levelAxes.classList.add('hidden');
      angleLbl.textContent =
        status === 'BYPASSED'
          ? 'MODO MANUAL • ALINHE VISUALMENTE'
          : 'MODO UNIVERSAL • ALINHE VISUALMENTE';
      frame.className = 'camera-wrapper level-ok';
      this.setShutterState(true, 'TIRAR FOTO DO PALLET', '📸');
      return;
    }

    levelAxes.classList.remove('hidden');

    if (isLevel) {
      angleLbl.textContent = `H:${Math.abs(roll).toFixed(1)}° V:${Math.abs(pitch).toFixed(1)}° • ALINHADO`;
      frame.className = 'camera-wrapper level-ok';
      this.setShutterState(true, 'TIRAR FOTO DO PALLET', '📸');
    } else {
      angleLbl.textContent = `H:${Math.abs(roll).toFixed(1)}° V:${Math.abs(pitch).toFixed(1)}° • ALINHE (±${LevelSensor.MAX_TILT_DEG}°)`;
      frame.className = 'camera-wrapper level-bad';
      this.setShutterState(false, 'ALINHE O CELULAR PARA LIBERAR A FOTO', '📐');
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
    this.setShutterState(false, 'SALVANDO FOTO...', '⏳');

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
      this.showToast(`Foto ${capturedUC} salva (${elapsedMs}ms)`);

      this.setState('SCAN_UC');
      SyncWorker.processQueue();
    } catch (err) {
      console.error('Erro ao capturar/salvar foto:', err);
      this.showToast('Erro ao salvar captura localmente.', true);
      this.updateLevelUI({
        tilt: LevelSensor.currentTilt,
        pitch: LevelSensor.currentPitch,
        roll: LevelSensor.currentRoll,
        isLevel: LevelSensor.isLevel,
        status: LevelSensor.status
      });
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
        this.showToast('Permissão negada. Você pode usar "Continuar sem sensor".', true);
      }
    });

    document.getElementById('btn-bypass-sensor').addEventListener('click', () => {
      LevelSensor.enableManualBypass();
      this.showToast('Modo manual liberado.');
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
