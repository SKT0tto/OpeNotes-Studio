/** WebAudio: one looping BGM with cross-fade, single-shot SE, master suspend/resume. Autoplay-policy safe. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private current: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private token = 0;
  /** Id the engine wants right now (it may still be decoding). */
  private wanted: string | null = null;

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

  /** Must be called from a user gesture at least once. */
  async resume(): Promise<void> {
    await this.context().resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx) await this.ctx.suspend();
  }

  dispose(): void {
    this.token++;
    this.current?.src.stop();
    this.current = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
