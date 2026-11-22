const LevelSensor = {
  MAX_TILT_DEG: 3.0,
  EMA_ALPHA: 0.25,

  currentTilt: 0.0,
  currentPitch: 0.0,
  currentRoll: 0.0,
  isLevel: false,
  status: 'INIT', // 'ACTIVE' | 'NEEDS_PERMISSION' | 'DENIED' | 'NO_HARDWARE'
  hasMotionData: false,
  hasOrientationData: false,
  permissionGranted: false,
  permissionDenied: false,

  onChangeCallback: null,
  _started: false,
  _fallbackTimer: null,
  _boundMotion: null,
  _boundOrientation: null,

  needsPermission() {
    const needsMotion =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';
    const needsOrient =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
    return (needsMotion || needsOrient) && !this.permissionGranted;
  },

  /**
   * Deve ser chamado diretamente dentro de um manipulador de clique (gesto do usuário) no iOS.
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
      this._attachListeners();
      return true;
    }

    this.permissionDenied = true;
    this.status = 'DENIED';
    this.isLevel = false;
    this._emit();
    return false;
  },

  start(onChange) {
    this.onChangeCallback = onChange;

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
        console.warn('Dispositivo sem acelerômetro/giroscópio ativo. Liberando modo coletor.');
        this.status = 'NO_HARDWARE';
        this.currentTilt = 0.0;
        this.currentPitch = 0.0;
        this.currentRoll = 0.0;
        this.isLevel = true;
        this._emit();
      }
    }, 1500);
  },

  /**
   * Cálculo por vetor gravidade (devicemotion): imune a gimbal lock quando o aparelho está vertical (90°)
   * e independente da convenção de sinal iOS vs Android.
   */
  _handleMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const g = Math.hypot(acc.x, acc.y, acc.z);
    if (g < 2.0) return;

    const ayAbs = Math.max(Math.abs(acc.y), 0.001);
    const rawPitch = (Math.atan2(acc.z, Math.hypot(acc.x, acc.y)) * 180) / Math.PI;
    const rawRoll = (Math.atan2(acc.x, ayAbs) * 180) / Math.PI;

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
   * Fallback secundário caso o navegador emita apenas deviceorientation.
   */
  _handleOrientation(event) {
    if (this.hasMotionData) return;
    if (event.beta === null || event.gamma === null) return;

    this.hasOrientationData = true;
    const rawPitch = 90 - Math.abs(event.beta);
    const rawRoll = event.gamma;

    this.currentPitch = this.currentPitch + this.EMA_ALPHA * (rawPitch - this.currentPitch);
    this.currentRoll = this.currentRoll + this.EMA_ALPHA * (rawRoll - this.currentRoll);

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
