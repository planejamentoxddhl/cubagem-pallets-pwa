const DEFAULT_UC_REGEX = '^UC\\d{9}$';

const App = {
  state: 'SCAN_UC',
  activeUC: null,
  selectedBase: 'PBR_100x120',
  videoStream: null,
  torchOn: false,
  barcodeDetector: null,
  html5Fallback: null,
  scanLoopActive: false,
  scanBusy: false,
  lastScanTs: 0,
  isCapturing: false,
  toastTimer: null,

  async init() {
    this.populateStageSelect();
    this.bindEvents();
    await CubagemDB.init();

    const cfg = this.getConfig();
    if (!cfg.apiUrl || !cfg.token || !cfg.operator || !cfg.stage) {
      this.showConfigScreen();
    } else {
      this.applyHeaderConfig(cfg);
      await this.startOperations();
    }
  },

  getConfig() {
    try {
      return JSON.parse(localStorage.getItem('cubagem_config') || '{}');
    } catch (_) {
      return {};
    }
  },

  buildUcRegex(rawPattern) {
    const source = (rawPattern || '').trim() || DEFAULT_UC_REGEX;
    try {
      return new RegExp(source);
    } catch (err) {
      console.warn('Regex inválida na configuração, usando padrão:', err);
      this.showToast('Regex inválida — usando padrão ^UC\\d{9}$', true);
      return new RegExp(DEFAULT_UC_REGEX);
    }
  },

  populateStageSelect() {
    const select = document.getElementById('cfg-stage');
    if (select.options.length > 0) return;
    for (let i = 1; i <= 40; i++) {
      const code = `STAGE_${String(i).padStart(2, '0')}`;
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      select.appendChild(opt);
    }
  },

  showConfigScreen() {
    const cfg = this.getConfig();
    if (cfg.apiUrl) document.getElementById('cfg-url').value = cfg.apiUrl;
    if (cfg.token) document.getElementById('cfg-token').value = cfg.token;
    if (cfg.operator) document.getElementById('cfg-operator').value = cfg.operator;
    if (cfg.stage) document.getElementById('cfg-stage').value = cfg.stage;
    document.getElementById('cfg-regex').value = cfg.regex || DEFAULT_UC_REGEX;

    document.getElementById('screen-config').classList.remove('hidden');
    document.getElementById('screen-main').classList.add('hidden');
  },

  applyHeaderConfig(cfg) {
    document.getElementById('lbl-stage').textContent = cfg.stage;
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
      this.showToast(`Erro de autenticação: ${msg} Verifique o Token.`, true);
    });
    this.setState('SCAN_UC');
  },

  async initCamera() {
    if (this.videoStream) return;
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      const video = document.getElementById('camera-video');
      video.srcObject = this.videoStream;
      await video.play();

      this.initBarcodeReaders();
      this.startBarcodeLoop();
    } catch (err) {
      alert('Erro ao acessar câmera. Verifique permissões HTTPS: ' + err.message);
    }
  },

  initBarcodeReaders() {
    if ('BarcodeDetector' in window) {
      try {
        this.barcodeDetector = new BarcodeDetector({
          formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'itf']
        });
      } catch (err) {
        console.warn('BarcodeDetector indisponível para estes formatos:', err);
        this.barcodeDetector = null;
      }
    }

    if (!this.barcodeDetector && typeof Html5Qrcode !== 'undefined') {
      try {
        const formats = typeof Html5QrcodeSupportedFormats !== 'undefined'
          ? [
              Html5QrcodeSupportedFormats.CODE_128,
              Html5QrcodeSupportedFormats.CODE_39,
              Html5QrcodeSupportedFormats.QR_CODE,
              Html5QrcodeSupportedFormats.EAN_13,
              Html5QrcodeSupportedFormats.ITF
            ]
          : undefined;
        this.html5Fallback = new Html5Qrcode('qr-fallback-reader', {
          formatsToSupport: formats,
          verbose: false
        });
      } catch (err) {
        console.warn('Falha ao inicializar fallback html5-qrcode:', err);
        this.html5Fallback = null;
      }
    }
  },

  startBarcodeLoop() {
    if (this.scanLoopActive) return;
    this.scanLoopActive = true;
    const video = document.getElementById('camera-video');
    const scanCanvas = document.getElementById('scan-canvas');
    const scanCtx = scanCanvas.getContext('2d');

    const tick = async (ts) => {
      const interval = this.barcodeDetector ? 120 : 350;
      if (
        this.state === 'SCAN_UC' &&
        !this.scanBusy &&
        ts - this.lastScanTs >= interval &&
        video.readyState === video.HAVE_ENOUGH_DATA &&
        video.videoWidth > 0
      ) {
        this.scanBusy = true;
        this.lastScanTs = ts;
        try {
          if (this.barcodeDetector) {
            const barcodes = await this.barcodeDetector.detect(video);
            for (const bc of barcodes) {
              if (this.validateAndAcceptUC(bc.rawValue)) break;
            }
          } else if (this.html5Fallback) {
            const targetW = Math.min(640, video.videoWidth);
            const scale = targetW / video.videoWidth;
            scanCanvas.width = Math.round(video.videoWidth * scale);
            scanCanvas.height = Math.round(video.videoHeight * scale);
            scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);

            const blob = await new Promise((resolve) =>
              scanCanvas.toBlob(resolve, 'image/jpeg', 0.7)
            );
            if (blob) {
              const file = new File([blob], 'frame.jpg', { type: 'image/jpeg' });
              const decodedText = await this.html5Fallback.scanFile(file, false);
              if (decodedText) this.validateAndAcceptUC(decodedText);
            }
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

  validateAndAcceptUC(rawCode) {
    const code = (rawCode || '').trim().toUpperCase();
    const cfg = this.getConfig();
    const pattern = this.buildUcRegex(cfg.regex);

    if (pattern.test(code)) {
      this.activeUC = code;
      if (navigator.vibrate) navigator.vibrate(80);
      this.setState('CAPTURE_PALLET');
      return true;
    }
    return false;
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
      shutter.textContent = 'AGUARDANDO LEITURA DA UC';
    } else if (newState === 'CAPTURE_PALLET') {
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

  updateLevelUI({ tilt, pitch, roll, isLevel, status }) {
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
      const idCapturaLocal = `${capturedUC}_${Date.now()}_${cfg.stage.replace('_', '')}`;

      const record = {
        id_captura_local: idCapturaLocal,
        uc: capturedUC,
        operador: cfg.operator,
        stage: cfg.stage,
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

  bindEvents() {
    document.getElementById('btn-open-config').addEventListener('click', () => {
      this.showConfigScreen();
    });

    document.getElementById('btn-save-config').addEventListener('click', async () => {
      const cfg = {
        apiUrl: document.getElementById('cfg-url').value.trim(),
        token: document.getElementById('cfg-token').value.trim(),
        operator: document.getElementById('cfg-operator').value.trim().toUpperCase(),
        stage: document.getElementById('cfg-stage').value,
        regex: document.getElementById('cfg-regex').value.trim() || DEFAULT_UC_REGEX
      };

      if (!cfg.apiUrl || !cfg.token || !cfg.operator) {
        alert('Preencha URL, Token e Matrícula.');
        return;
      }

      try {
        new RegExp(cfg.regex);
      } catch (_) {
        alert('A expressão regular (Regex) informada é inválida.');
        return;
      }

      // Solicita permissão de sensores no iOS ANTES de qualquer await de câmera (gesto ativo)
      if (LevelSensor.needsPermission()) {
        await LevelSensor.requestPermissions();
      }

      localStorage.setItem('cubagem_config', JSON.stringify(cfg));
      SyncWorker.resetAuthError();
      this.applyHeaderConfig(cfg);
      await this.startOperations();
    });

    document.getElementById('btn-enable-sensors').addEventListener('click', async () => {
      const ok = await LevelSensor.requestPermissions();
      if (!ok) {
        this.showToast('Permissão de movimento negada no Safari.', true);
      }
    });

    const confirmManualUC = () => {
      const val = document.getElementById('input-uc-manual').value;
      if (!this.validateAndAcceptUC(val)) {
        const cfg = this.getConfig();
        alert(`Formato inválido. Padrão esperado: ${cfg.regex || DEFAULT_UC_REGEX}`);
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
  }
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

window.addEventListener('DOMContentLoaded', () => App.init());
