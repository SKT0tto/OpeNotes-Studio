/** WebAudio: one looping BGM with cross-fade, single-shot SE, one voice-over line at a time (with a level meter for lip sync), master suspend/resume. Autoplay-policy safe. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private current: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private token = 0;
  /** Id the engine wants right now (it may still be decoding). */
  private wanted: string | null = null;
  /** The voice-over line that is playing (at most one). */
  private voice: { src: AudioBufferSourceNode; gain: GainNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> } | null = null;
  private voiceVolume = 1;
  private level = 0;

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  private buffer(url: string): Promise<AudioBuffer> {
    let b = this.buffers.get(url);
    if (!b) {
      b = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`audio ${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((d) => this.context().decodeAudioData(d));
      this.buffers.set(url, b);
      b.catch(() => this.buffers.delete(url));
    }
    return b;
  }

  get bgmId(): string | null {
    return this.wanted;
  }

  /** Cross-fade to `assetId` (null = fade out). A call with the same id only adjusts the volume. */
  async setBgm(assetId: string | null, url: string | null, volume: number, fadeSeconds = 1.5): Promise<void> {
    const ctx = this.context();
    if (assetId === this.wanted) {
      if (this.current) this.current.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.1);
      return;
    }
    this.wanted = assetId;
    const token = ++this.token;
    const old = this.current;
    this.current = null;
    if (old) {
      old.gain.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.gain.setValueAtTime(old.gain.gain.value, ctx.currentTime);
      old.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSeconds);
      old.src.stop(ctx.currentTime + fadeSeconds + 0.05);
    }
    if (!assetId || !url) return;
    const buf = await this.buffer(url);
    if (token !== this.token) return; // superseded while decoding
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + fadeSeconds);
    src.connect(gain).connect(ctx.destination);
    src.start();
    this.current = { id: assetId, src, gain };
  }

  async playSe(url: string, volume: number): Promise<void> {
    const ctx = this.context();
    const src = ctx.createBufferSource();
    src.buffer = await this.buffer(url);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }

  /** Fetches and decodes a voice-over file ahead of time (the promise is cached; a failure is forgotten so a later try can succeed). */
  loadVoice(url: string): Promise<AudioBuffer> {
    return this.buffer(url);
  }

  /** Plays a decoded voice-over line from `offset` seconds, at `rate`, replacing the one that is playing. */
  startVoice(buf: AudioBuffer, offset: number, rate: number): void {
    this.stopVoice();
    if (offset >= buf.duration) return;
    const ctx = this.context();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = this.voiceVolume;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    const v = { src, gain, analyser, samples: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)) };
    this.voice = v;
    src.onended = () => {
      if (this.voice === v) this.voice = null;
    };
    src.start(0, Math.max(0, offset));
  }

  stopVoice(): void {
    const v = this.voice;
    this.voice = null;
    this.level = 0;
    if (!v) return;
    v.src.onended = null;
    try {
      v.src.stop();
    } catch { /* already stopped */ }
    v.src.disconnect();
  }

  get voicePlaying(): boolean {
    return this.voice !== null;
  }

  setVoiceRate(rate: number): void {
    if (this.voice) this.voice.src.playbackRate.value = rate;
  }

  setVoiceVolume(volume: number): void {
    this.voiceVolume = Math.min(1, Math.max(0, volume));
    if (this.voice) this.voice.gain.gain.value = this.voiceVolume;
  }

  /**
   * How loud the voice is right now, as a mouth opening 0..1 (smoothed RMS of the output: opens fast, closes a little slower),
   * or null when no voice is playing (the caller then keeps the text-based mouth).
   */
  voiceMouth(): number | null {
    const v = this.voice;
    if (!v) return null;
    v.analyser.getFloatTimeDomainData(v.samples);
    let sum = 0;
    for (const x of v.samples) sum += x * x;
    const rms = Math.sqrt(sum / v.samples.length) / Math.max(0.05, this.voiceVolume);
    const target = Math.min(1, Math.max(0, (rms - 0.015) * 7));
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.3);
    return this.level;
  }

  /** Must be called from a user gesture at least once. */
  async resume(): Promise<void> {
    await this.context().resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx) await this.ctx.suspend();
  }

  dispose(): void {
    this.token++;
    this.stopVoice();
    this.current?.src.stop();
    this.current = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
