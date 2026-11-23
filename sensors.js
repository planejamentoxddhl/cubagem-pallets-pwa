const LevelSensor = {
  // ±5° garante distorção geométrica < 0.4% (cos 5° = 0.996) e alinhamento rápido em qualquer aparelho
  MAX_TILT_DEG: 5.0,
  EMA_ALPHA: 0.28,

  currentTilt: 0.0,
  currentPitch: 0.0,
  currentRoll: 0.0,
  isLevel: false,
  status: 'INIT', // 'ACTIVE' | 'NEEDS_PERMISSION' | 'DENIED' | 'NO_HARDWARE' | 'BYPASSED'
  hasMotionData: false,
  hasOrientationData: false,
  permissionGranted: false,
  permissionDenied: false,
  manualBypass: false,

  onChangeCallback: null,
  _started: false,
  _fallbackTimer: null,
  _boundMotion: null,
  _boundOrientation: null,

  needsPermission() {
    if (this.manualBypass || this.permissionGranted) return false;
    const needsMotion =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';
    const needsOrient =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
    return needsMotion || needsOrient;
  },

  /**
   * Deve ser chamado diretamente dentro de um clique (gesto do usuário) no iOS.
   */
  async requestPermissions() {
    if (!this.needsPermission()) {
      this.permissionGranted = true;
      return true;
    }

    let grantedAny = false;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res === 'granted') grantedAny = true;
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res === 'granted') grantedAny = true;
      }
    } catch (err) {
      console.warn('Falha ao solicitar permissão de sensores iOS:', err);
    }

    if (grantedAny) {
      this.permissionGranted = true;
      this.permissionDenied = false;
      this.manualBypass = false;
      this._attachListeners();
      return true;
    }

    this.permissionDenied = true;
    this.status = 'DENIED';
    this.isLevel = false;
    this._emit();
    return false;
  },

  /**
   * Garante portabilidade total: caso um aparelho/navegador específico bloqueie ou não exponha sensores,
   * permite continuar a operação sem travar o colaborador.
   */
  enableManualBypass() {
    this.manualBypass = true;
    this.status = 'BYPASSED';
    this.currentTilt = 0.0;
    this.currentPitch = 0.0;
    this.currentRoll = 0.0;
    this.isLevel = true;
    this._emit();
  },

  start(onChange) {
    this.onChangeCallback = onChange;

    if (this.manualBypass) {
      this.status = 'BYPASSED';
      this.isLevel = true;
      this._emit();
      return;
    }

    if (this.needsPermission()) {
      this.status = this.permissionDenied ? 'DENIED' : 'NEEDS_PERMISSION';
      this.isLevel = false;
      this._emit();
      return;
    }

    this._attachListeners();
  },

  _attachListeners() {
    if (!this._started) {
      this._boundMotion = (e) => this._handleMotion(e);
      this._boundOrientation = (e) => this._handleOrientation(e);
      window.addEventListener('devicemotion', this._boundMotion, true);
      window.addEventListener('deviceorientation', this._boundOrientation, true);
      this._started = true;
    }

    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      if (!this.hasMotionData && !this.hasOrientationData && !this.needsPermission()) {
        console.warn('Dispositivo sem acelerômetro/giroscópio ativo. Liberando modo universal.');
        this.status = 'NO_HARDWARE';
        this.currentTilt = 0.0;
        this.currentPitch = 0.0;
        this.currentRoll = 0.0;
        this.isLevel = true;
        this._emit();
      }
    }, 1500);
  },

  _isLandscape() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
      const a = Math.abs(window.screen.orientation.angle);
      return a === 90 || a === 270;
    }
    return window.innerWidth > window.innerHeight;
  },

  /**
   * Cálculo por vetor gravidade (devicemotion): imune a gimbal lock na vertical (90°),
   * compatível com convenções de sinal iOS/Android e orientação retrato ou paisagem.
   */
  _handleMotion(event) {
    if (this.manualBypass) return;
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const g = Math.hypot(acc.x, acc.y, acc.z);
    if (g < 2.0) return;

    const landscape = this._isLandscape();
    const verticalAxis = landscape ? acc.x : acc.y;
    const lateralAxis = landscape ? acc.y : acc.x;

    const vAbs = Math.max(Math.abs(verticalAxis), 0.001);
    const rawPitch = (Math.atan2(acc.z, Math.hypot(lateralAxis, verticalAxis)) * 180) / Math.PI;
    const rawRoll = (Math.atan2(lateralAxis, vAbs) * 180) / Math.PI;

    if (!this.hasMotionData) {
      this.currentPitch = rawPitch;
      this.currentRoll = rawRoll;
      this.hasMotionData = true;
    } else {
      this.currentPitch = this.currentPitch + this.EMA_ALPHA * (rawPitch - this.currentPitch);
      this.currentRoll = this.currentRoll + this.EMA_ALPHA * (rawRoll - this.currentRoll);
    }

    const maxDev = Math.max(Math.abs(this.currentPitch), Math.abs(this.currentRoll));
    this.currentTilt = Number(maxDev.toFixed(1));
    this.isLevel = maxDev <= this.MAX_TILT_DEG;
    this.status = 'ACTIVE';
    this._emit();
  },

  /**
   * Fallback secundário para aparelhos/navegadores que emitem apenas deviceorientation.
   */
  _handleOrientation(event) {
    if (this.manualBypass || this.hasMotionData) return;
    if (event.beta === null || event.gamma === null) return;

    const rawPitch = 90 - Math.abs(event.beta);
    const rawRoll = event.gamma;

    if (!this.hasOrientationData) {
      this.currentPitch = rawPitch;
      this.currentRoll = rawRoll;
      this.hasOrientationData = true;
    } else {
      this.currentPitch = this.currentPitch + this.EMA_ALPHA * (rawPitch - this.currentPitch);
      this.currentRoll = this.currentRoll + this.EMA_ALPHA * (rawRoll - this.currentRoll);
    }

    const maxDev = Math.max(Math.abs(this.currentPitch), Math.abs(this.currentRoll));
    this.currentTilt = Number(maxDev.toFixed(1));
    this.isLevel = maxDev <= this.MAX_TILT_DEG;
    this.status = 'ACTIVE';
    this._emit();
  },

  _emit() {
    if (!this.onChangeCallback) return;
    this.onChangeCallback({
      tilt: this.currentTilt,
      pitch: Number(this.currentPitch.toFixed(1)),
      roll: Number(this.currentRoll.toFixed(1)),
      isLevel: this.isLevel,
      status: this.status
    });
  }
};
