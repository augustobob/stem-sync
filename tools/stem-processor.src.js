/*
  Stem Sync · processador de áudio (AudioWorklet)
  Mistura todas as stems numa única linha do tempo (um relógio só, sample a sample)
  e passa a mistura estéreo por UM time-stretch Signalsmith Stretch (MIT, ver
  lib/signalsmith-stretch/LICENSE.txt). Velocidade e tom são independentes.
  Com velocidade 1× e tom 0 o stretch é desligado (áudio original, sem custo de CPU).
  Partes da lógica de buffer/latência seguem o wrapper oficial do Signalsmith Stretch Web.
*/
class StemSyncProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = new Map();
    this.active = false;
    this.seg = { input: 0, output: 0, rate: 1, semi: 0 };
    this.env = 0;
    this.xf = 0;            // 0 = original, 1 = stretch
    this.m = null;
    this.bufLen = 0; this.inLat = 0; this.outLat = 0;
    this.forceStretch = false;
    this.setCap(16384);
    this.port.onmessage = (e) => this.onMsg(e.data);
    let mod = null;
    try { mod = SignalsmithStretch(); } catch (err) { this.port.postMessage({ type: "ready", stretch: false, error: String(err) }); }
    if (mod) mod.then((m) => {
      m._main();
      m._presetDefault(2, sampleRate);
      m._setFormantSemitones(0, false);
      m._setFormantBase(0);
      this.inLat = m._inputLatency() / sampleRate;
      this.outLat = m._outputLatency() / sampleRate;
      this.bufLen = m._inputLatency() + m._outputLatency();
      const p = m._setBuffers(2, this.bufLen);
      const bytes = this.bufLen * 4;
      this.ptrIn = [p, p + bytes];
      this.ptrOut = [p + bytes * 2, p + bytes * 3];
      let cap = 1024; while (cap < this.bufLen + 8192) cap *= 2;
      this.setCap(cap);
      this.m = m;
      this.port.postMessage({ type: "ready", stretch: true, outLat: this.outLat, inLat: this.inLat });
    }).catch((err) => this.port.postMessage({ type: "ready", stretch: false, error: String(err) }));
  }

  setCap(cap) {
    this.cap = cap; this.mask = cap - 1;
    this.ringL = new Float32Array(cap); this.ringR = new Float32Array(cap);
    this.invalidate();
  }
  invalidate() { this.cStart = -1e15; this.cEnd = -1e15; }

  onMsg(d) {
    switch (d.type) {
      case "add": this.stems.set(d.id, { ch: d.ch, g: d.gain, target: d.gain }); this.invalidate(); break;
      case "remove": this.stems.delete(d.id); this.invalidate(); break;
      case "clear": this.stems.clear(); this.invalidate(); this.active = false; break;
      case "gain": { const s = this.stems.get(d.id); if (s) s.target = d.gain; break; }
      case "play": this.seg = { input: d.input, output: d.output, rate: d.rate, semi: d.semi }; this.active = true; break;
      case "seg": this.seg = { input: d.input, output: d.output, rate: d.rate, semi: d.semi }; break;
      case "stop": this.active = false; break;
      case "force": this.forceStretch = !!d.on; break;
      case "ping": this.port.postMessage({ type: "pong", t: currentTime }); break;
    }
  }

  // garante que o anel tenha a mistura das amostras [a, b)
  ensure(a, b) {
    if (!(a >= this.cStart && a <= this.cEnd)) { this.cStart = a; this.cEnd = a; }
    if (b > this.cEnd) { this.mixInto(this.cEnd, b); this.cEnd = b; }
    if (this.cEnd - this.cStart > this.cap) this.cStart = this.cEnd - this.cap;
  }

  mixInto(s, e) {
    const L = this.ringL, R = this.ringR, mask = this.mask, n = e - s;
    if (n <= 0) return;
    for (let i = s; i < e; i++) { const k = i & mask; L[k] = 0; R[k] = 0; }
    const maxStep = n / 480;
    for (const st of this.stems.values()) {
      const g0 = st.g;
      let d = st.target - g0;
      if (d > maxStep) d = maxStep; else if (d < -maxStep) d = -maxStep;
      const g1 = g0 + d;
      st.g = g1;
      if (g0 === 0 && g1 === 0) continue;
      const cl = st.ch[0], cr = st.ch[1] || st.ch[0], len = cl.length;
      const lo = Math.max(s, 0), hi = Math.min(e, len);
      const dg = (g1 - g0) / n;
      let g = g0 + dg * (lo - s);
      for (let i = lo; i < hi; i++) {
        const k = i & mask;
        L[k] += cl[i] * g; R[k] += cr[i] * g;
        g += dg;
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    if (!this.active && this.env <= 0) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const sr = sampleRate, seg = this.seg, t = currentTime;
    const wantStretch = !!this.m && (this.forceStretch || Math.abs(seg.rate - 1) > 1e-4 || seg.semi !== 0);
    const target = wantStretch ? 1 : 0;
    const xf0 = this.xf;
    const xfStep = n / 2048;
    const xf1 = target > xf0 ? Math.min(1, xf0 + xfStep) : Math.max(0, xf0 - xfStep);
    this.xf = xf1;
    if (!this.tmpL || this.tmpL.length < n) { this.tmpL = new Float32Array(n); this.tmpR = new Float32Array(n); }
    const bL = this.tmpL, bR = this.tmpR;

    // caminho original (ou reamostragem simples se o stretch não carregou)
    if (xf0 < 1 || xf1 < 1) {
      const i0 = (seg.input + (t - seg.output) * seg.rate) * sr;
      if (Math.abs(seg.rate - 1) < 1e-4) {
        const a = Math.round(i0);
        this.ensure(a, a + n);
        for (let k = 0; k < n; k++) { const j = (a + k) & this.mask; bL[k] = this.ringL[j]; bR[k] = this.ringR[j]; }
      } else {
        const a = Math.floor(i0);
        this.ensure(a, a + Math.ceil(n * seg.rate) + 2);
        for (let k = 0; k < n; k++) {
          const p = i0 + k * seg.rate, f = Math.floor(p), fr = p - f;
          const j0 = f & this.mask, j1 = (f + 1) & this.mask;
          bL[k] = this.ringL[j0] + (this.ringL[j1] - this.ringL[j0]) * fr;
          bR[k] = this.ringR[j0] + (this.ringR[j1] - this.ringR[j0]) * fr;
        }
      }
    }

    let sL = null, sR = null;
    if (this.m && (xf0 > 0 || xf1 > 0)) {
      const m = this.m;
      const inT = seg.input + (t + this.outLat - seg.output) * seg.rate;
      const end = Math.round((inT + this.inLat) * sr);
      const start = end - this.bufLen;
      this.ensure(start, end);
      let mem = m.exports ? m.exports.memory.buffer : m.HEAP8.buffer;
      const inL = new Float32Array(mem, this.ptrIn[0], this.bufLen);
      const inR = new Float32Array(mem, this.ptrIn[1], this.bufLen);
      const mask = this.mask;
      for (let i = 0; i < this.bufLen; i++) { const j = (start + i) & mask; inL[i] = this.ringL[j]; inR[i] = this.ringR[j]; }
      m._setTransposeSemitones(seg.semi, 8000 / sr);
      m._seek(this.bufLen, seg.rate);
      m._process(0, n);
      mem = m.exports ? m.exports.memory.buffer : m.HEAP8.buffer;
      sL = new Float32Array(mem, this.ptrOut[0], n);
      sR = new Float32Array(mem, this.ptrOut[1], n);
    }

    // mistura original/stretch com crossfade e envelope de start/stop
    let env = this.env;
    const envStep = 1 / (0.006 * sr);
    const dxf = (xf1 - xf0) / n;
    let x = xf0;
    for (let k = 0; k < n; k++) {
      const ts = t + k / sr;
      const on = this.active && ts >= seg.output;
      if (on) { if (env < 1) env = Math.min(1, env + envStep); }
      else if (env > 0) env = Math.max(0, env - envStep);
      let l = 0, r = 0;
      if (x < 1) { l += bL[k] * (1 - x); r += bR[k] * (1 - x); }
      if (sL && x > 0) { l += sL[k] * x; r += sR[k] * x; }
      oL[k] = l * env;
      if (oR !== oL) oR[k] = r * env;
      x += dxf;
    }
    this.env = env;
    return true;
  }
}
registerProcessor("stem-sync", StemSyncProcessor);
