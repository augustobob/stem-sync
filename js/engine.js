/*
  Stem Sync · motor de áudio
  WorkletEngine: todas as stems num só AudioWorklet (um relógio, sample-sync),
  velocidade sem mudar o tom e tom independente via Signalsmith Stretch.
  SimpleEngine: plano B (navegador sem AudioWorklet) = comportamento da v1.6,
  velocidade muda o tom e o controle de tom fica desligado.
*/
(function () {
  class WorkletEngine {
    constructor(ctx) {
      this.ctx = ctx;
      this.kind = "worklet";
      this.stretch = false;
      this.playing = false;
      this.offset = 0;
      this.seg = { input: 0, output: 0, rate: 1, semi: 0 };
      this.rate = 1;
      this.semi = 0;
    }
    async init() {
      await this.ctx.audioWorklet.addModule("js/stem-processor.js?v=" + encodeURIComponent(window.VERSION || ""));
      this.node = new AudioWorkletNode(this.ctx, "stem-sync", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      const info = await new Promise((resolve) => {
        const to = setTimeout(() => resolve({ stretch: false, error: "tempo esgotado" }), 6000);
        this.node.port.onmessage = (e) => {
          if (e.data && e.data.type === "ready") { clearTimeout(to); resolve(e.data); }
        };
      });
      this.stretch = !!info.stretch;
      this.latency = info.outLat || 0;
      this.initError = info.error || "";
      return this;
    }
    post(m, transfer) { this.node.port.postMessage(m, transfer || []); }
    add(track, buffer) {
      const ch = [];
      const n = Math.min(2, buffer.numberOfChannels);
      for (let c = 0; c < n; c++) ch.push(buffer.getChannelData(c).slice());
      this.post({ type: "add", id: track.id, ch, gain: track.gainNow || 0 }, ch.map((a) => a.buffer));
    }
    remove(track) { this.post({ type: "remove", id: track.id }); }
    clear() { this.stop(); this.offset = 0; this.post({ type: "clear" }); }
    setGain(track, g) {
      if (track.gainNow === g) return;
      track.gainNow = g;
      this.post({ type: "gain", id: track.id, gain: g });
    }
    pos() {
      if (!this.playing) return this.offset;
      const t = this.ctx.currentTime;
      return this.seg.input + Math.max(0, t - this.seg.output) * this.seg.rate;
    }
    play(from) {
      this.offset = from;
      this.seg = { input: from, output: this.ctx.currentTime + 0.05, rate: this.rate, semi: this.semi };
      this.playing = true;
      this.post(Object.assign({ type: "play" }, this.seg));
    }
    stop() {
      if (this.playing) this.offset = this.pos();
      this.playing = false;
      this.post({ type: "stop" });
    }
    seek(p) {
      this.offset = p;
      if (!this.playing) return;
      const t = this.ctx.currentTime;
      this.seg = { input: p, output: Math.max(t, this.seg.output), rate: this.rate, semi: this.semi };
      this.post(Object.assign({ type: "seg" }, this.seg));
    }
    setParams(rate, semi) {
      if (this.playing) {
        const t = this.ctx.currentTime;
        const p = this.pos();
        const out = Math.max(t, this.seg.output);
        this.seg = { input: t < this.seg.output ? this.seg.input : p, output: out, rate, semi };
        this.post(Object.assign({ type: "seg" }, this.seg));
      }
      this.rate = rate;
      this.semi = semi;
    }
  }

  class SimpleEngine {
    constructor(ctx) {
      this.ctx = ctx;
      this.kind = "simple";
      this.stretch = false;
      this.playing = false;
      this.offset = 0;
      this.rate = 1;
      this.semi = 0;
      this.items = new Map();
      this.sources = [];
    }
    async init() { return this; }
    add(track, buffer) {
      const gain = this.ctx.createGain();
      gain.gain.value = track.gainNow || 0;
      gain.connect(this.ctx.destination);
      this.items.set(track.id, { buffer, gain });
      if (this.playing) this.play(this.pos());
    }
    remove(track) {
      const it = this.items.get(track.id);
      if (it) it.gain.disconnect();
      this.items.delete(track.id);
      if (this.playing) this.play(this.pos());
    }
    clear() { this.stop(); this.offset = 0; for (const it of this.items.values()) it.gain.disconnect(); this.items.clear(); }
    setGain(track, g) {
      track.gainNow = g;
      const it = this.items.get(track.id);
      if (it) it.gain.gain.value = g;
    }
    pos() {
      if (!this.playing) return this.offset;
      return this.offset + Math.max(0, this.ctx.currentTime - this.startCtx) * this.rate;
    }
    killSources() { for (const s of this.sources) { try { s.stop(); } catch (e) {} } this.sources = []; }
    play(from) {
      this.killSources();
      this.offset = from;
      const when = this.ctx.currentTime + 0.03;
      this.startCtx = when;
      this.playing = true;
      for (const it of this.items.values()) {
        const src = this.ctx.createBufferSource();
        src.buffer = it.buffer;
        src.playbackRate.value = this.rate;
        src.connect(it.gain);
        try { src.start(when, Math.min(it.buffer.duration, from)); } catch (e) {}
        this.sources.push(src);
      }
    }
    stop() {
      if (this.playing) this.offset = this.pos();
      this.playing = false;
      this.killSources();
    }
    seek(p) { this.offset = p; if (this.playing) this.play(p); }
    setParams(rate, semi) {
      const p = this.pos();
      this.rate = rate;
      this.semi = 0;
      if (this.playing) this.play(p);
    }
  }

  async function createEngine(ctx) {
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        return await new WorkletEngine(ctx).init();
      } catch (e) {
        if (window.__log) window.__log("Aviso: AudioWorklet falhou (" + (e && e.message ? e.message : e) + "), usando modo simples");
      }
    }
    return new SimpleEngine(ctx).init();
  }
  window.createEngine = createEngine;
})();
