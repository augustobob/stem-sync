/* Stem Sync · interface */
(function () {
  const PALETTE = ["#f472b6", "#fbbf24", "#38bdf8", "#fb923c", "#34d399", "#a78bfa", "#2dd4bf", "#94a3b8"];
  const $ = (id) => document.getElementById(id);
  const fileInput = $("file");
  const fileInput2 = $("file2");
  const drop = $("drop");
  const list = $("list");
  const errorBox = $("error");
  const ICON = (document.querySelector("link[rel=apple-touch-icon]") || {}).href || "";

  const state = {
    ctx: null,
    engine: null,
    enginePromise: null,
    tracks: [],
    duration: 0,
    rate: 1,
    semi: 0,
    raf: 0,
    loading: false,
    songId: null,
    songName: "",
    songCreated: 0
  };
  window.__state = state;

  function nextColor() {
    const used = new Set(state.tracks.map((t) => t.color));
    const free = PALETTE.filter((c) => !used.has(c));
    const pool = free.length ? free : PALETTE;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function fmt(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return m + ":" + s.toFixed(1).padStart(4, "0");
  }
  function fmtShort(t) {
    t = Math.max(0, t || 0);
    return Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
  }
  function fmtBytes(b) {
    if (!b) return "0 MB";
    if (b < 1e9) return Math.max(1, Math.round(b / 1e6)) + " MB";
    return (b / 1e9).toFixed(1).replace(".", ",") + " GB";
  }
  function esc(s) {
    return String(s == null ? "" : s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
  }

  // iOS 17+: trata o áudio da página como mídia (toca mesmo no modo silencioso). Nunca usar áudio silencioso em loop.
  function setPlaybackSession() {
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
  }
  setPlaybackSession();
  function ensureCtx() {
    setPlaybackSession();
    if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.ctx.state === "suspended") state.ctx.resume();
    return state.ctx;
  }
  function getEngine() {
    const ctx = ensureCtx();
    if (!state.enginePromise) {
      state.enginePromise = window.createEngine(ctx).then((eng) => {
        state.engine = eng;
        eng.setParams(state.rate, eng.stretch ? state.semi : 0);
        updateEngineUI();
        return eng;
      });
    }
    return state.enginePromise;
  }
  function updateEngineUI() {
    const eng = state.engine;
    if (!eng) return;
    const can = eng.stretch;
    $("pitch").disabled = !can;
    $("pitchReset").disabled = !can;
    $("pitchBox").title = can ? "" : "Tom indisponível neste navegador";
    $("footNote").textContent = can
      ? "Velocidade não muda o tom · stems ficam só neste aparelho"
      : "Modo simples: velocidade altera o tom · stems ficam só neste aparelho";
  }
  function showError(msg) {
    errorBox.hidden = !msg;
    errorBox.textContent = msg || "";
  }
  function playing() { return !!(state.engine && state.engine.playing); }
  function currentPos() {
    if (!state.engine) return 0;
    return Math.min(state.duration, state.engine.pos());
  }
  function anySolo() { return state.tracks.some((t) => t.solo); }
  function audible(track) {
    if (track.mute) return false;
    return anySolo() ? track.solo : true;
  }

  function computePeaks(buffer, bars = 900) {
    const ch = buffer.getChannelData(0);
    const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const block = Math.max(1, Math.floor(ch.length / bars));
    const peaks = new Float32Array(bars);
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * block;
      const end = Math.min(ch.length, start + block);
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
        if (ch2) { const w = Math.abs(ch2[j]); if (w > max) max = w; }
      }
      peaks[i] = max;
    }
    return peaks;
  }

  function drawWave(track) {
    const canvas = track.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, w, h);
    const peaks = track.peaks;
    const mid = h / 2;
    ctx.fillStyle = track.color;
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const amp = Math.max(1, peaks[i] * (h * 0.46));
      ctx.fillRect(x, mid - amp, Math.max(1, w / peaks.length - 0.3), amp * 2);
    }
  }

  function stopPlayback() {
    if (state.engine) state.engine.stop();
    $("play").textContent = "▶";
    cancelAnimationFrame(state.raf);
  }
  async function startPlayback() {
    if (!state.tracks.length) return;
    ensureCtx();
    const eng = await getEngine();
    let from = eng.offset;
    if (from >= state.duration - 0.05) from = 0;
    eng.play(from);
    $("play").textContent = "❚❚";
    cancelAnimationFrame(state.raf);
    tick();
  }

  function applyGains() {
    if (!state.engine) return;
    for (const track of state.tracks) state.engine.setGain(track, audible(track) ? track.volume : 0);
  }

  function setPos(t) {
    const p = Math.max(0, Math.min(state.duration, t));
    if (state.engine) state.engine.seek(p);
    updateUI();
  }

  function updateUI() {
    const pos = currentPos();
    $("times").textContent = fmt(pos) + " / " + fmt(state.duration);
    $("seek").value = state.duration ? String(Math.round((pos / state.duration) * 1000)) : "0";
    const ratio = state.duration ? pos / state.duration : 0;
    const left = (ratio * 100) + "%";
    $("mixPlayhead").style.left = left;
    for (const track of state.tracks) if (track.playhead) track.playhead.style.left = left;
  }

  function mixPeaks() {
    const bars = 900;
    const acc = new Float32Array(bars);
    for (const track of state.tracks) {
      if (!audible(track)) continue;
      const p = track.peaks;
      if (!p || !p.length) continue;
      const g = track.volume;
      // alinha pela duração de cada stem
      const frac = state.duration ? track.duration / state.duration : 1;
      for (let i = 0; i < bars; i++) {
        const r = i / bars / frac;
        if (r >= 1) continue;
        const idx = Math.min(p.length - 1, Math.floor(r * p.length));
        acc[i] += (p[idx] || 0) * g;
      }
    }
    let peak = 0;
    for (let i = 0; i < bars; i++) if (acc[i] > peak) peak = acc[i];
    if (peak > 0) for (let i = 0; i < bars; i++) acc[i] /= peak;
    return acc;
  }

  function tickStep(dur) {
    if (dur <= 20) return 2;
    if (dur <= 60) return 5;
    if (dur <= 150) return 10;
    if (dur <= 300) return 15;
    if (dur <= 600) return 30;
    return 60;
  }

  function drawRuler() {
    const canvas = $("mixRuler");
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#8b909a";
    ctx.font = "10px ui-sans-serif, Segoe UI, sans-serif";
    ctx.textBaseline = "top";
    const dur = state.duration || 0;
    if (!dur) { ctx.fillText("0:00", 0, 2); return; }
    const step = tickStep(dur);
    for (let t = 0; t <= dur + 0.001; t += step) {
      const x = (t / dur) * w;
      ctx.strokeStyle = "#3a3f49";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, 6);
      ctx.stroke();
      const label = fmtShort(t);
      const tw = ctx.measureText(label).width;
      let tx = x + 3;
      if (t === 0) tx = 0;
      if (tx + tw > w) tx = w - tw;
      ctx.fillStyle = "#8b909a";
      ctx.fillText(label, tx, 7);
    }
  }

  function drawMix() {
    const canvas = $("mixCanvas");
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, w, h);
    const peaks = mixPeaks();
    const mid = h / 2;
    ctx.fillStyle = "#e0b15a";
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const amp = Math.max(0.6, peaks[i] * (h * 0.46));
      ctx.fillRect(x, mid - amp, Math.max(1, w / peaks.length - 0.3), amp * 2);
    }
    drawRuler();
  }
  function redraw() {
    requestAnimationFrame(() => { state.tracks.forEach(drawWave); drawMix(); });
  }

  let lastMedia = 0;
  function tick() {
    updateUI();
    if (playing() && currentPos() >= state.duration - 0.02) {
      stopPlayback();
      if (state.engine) state.engine.offset = 0;
      updateUI();
      syncMediaSession();
      return;
    }
    if (playing()) {
      const now = performance.now();
      if (now - lastMedia > 2000) { lastMedia = now; syncMediaSession(); }
      state.raf = requestAnimationFrame(tick);
    }
  }

  /* ---------- cards ---------- */
  const DRAG_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5.5" cy="3" r="1.4"/><circle cx="10.5" cy="3" r="1.4"/><circle cx="5.5" cy="8" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5.5" cy="13" r="1.4"/><circle cx="10.5" cy="13" r="1.4"/></svg>';
  const PEN_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.6l2.6 2.6-7.6 7.6-3.2.6.6-3.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  function renderTracks() {
    list.innerHTML = "";
    $("songbar").hidden = !state.tracks.length;
    if (!state.tracks.length) {
      list.innerHTML = '<p class="empty">Nenhuma faixa ainda. Use “Enviar stems” no topo, ou abra uma música salva no menu ☰.</p>';
      drawMix();
      updateSongBar();
      return;
    }
    for (const track of state.tracks) {
      const el = document.createElement("div");
      el.className = "track";
      el.style.setProperty("--stem", track.color);
      const safeName = esc(track.name);
      el.innerHTML =
        '<div class="meta">' +
          '<div class="name">' +
            '<i class="swatch" style="background:' + track.color + '"></i>' +
            '<input class="stem-name" value="' + safeName + '" title="Toque para renomear" maxlength="60" aria-label="Nome da stem" />' +
            '<span class="pen" aria-hidden="true">' + PEN_SVG + '</span>' +
          '</div>' +
          '<div class="btns">' +
            '<button class="solo ' + (track.solo ? "on" : "") + '" title="Solo">S</button>' +
            '<button class="mute ' + (track.mute ? "on" : "") + '" title="Mudo">M</button>' +
            '<button class="remove" title="Tirar esta stem">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="wave-wrap"><canvas></canvas><div class="playhead"></div></div>' +
        '<input class="vol" type="range" min="0" max="100" value="' + Math.round(track.volume * 100) + '" aria-label="Volume" />' +
        '<button class="drag" aria-label="Mover stem" title="Arraste para reordenar">' + DRAG_SVG + '</button>';
      el.__track = track;
      el.querySelector(".drag").addEventListener("pointerdown", (e) => startReorder(e, el));
      track.canvas = el.querySelector("canvas");
      track.playhead = el.querySelector(".playhead");
      const nameInput = el.querySelector(".stem-name");
      el.querySelector(".pen").addEventListener("click", () => { nameInput.focus(); nameInput.select(); });
      nameInput.addEventListener("focus", () => el.classList.add("editing"));
      nameInput.addEventListener("input", (e) => { track.name = e.target.value; });
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); });
      nameInput.addEventListener("blur", (e) => {
        el.classList.remove("editing");
        const v = e.target.value.trim();
        track.name = v || Tags.baseName(track.fileName || "stem");
        e.target.value = track.name;
        e.target.title = track.name;
        saveSoon();
        syncMediaSession();
      });
      el.querySelector(".solo").addEventListener("click", () => {
        track.solo = !track.solo;
        applyGains(); renderTracks(); saveSoon();
      });
      el.querySelector(".mute").addEventListener("click", () => {
        track.mute = !track.mute;
        applyGains(); renderTracks(); saveSoon();
      });
      el.querySelector(".remove").addEventListener("click", () => removeTrack(track));
      el.querySelector(".vol").addEventListener("input", (e) => {
        track.volume = Number(e.target.value) / 100;
        applyGains(); drawMix(); saveSoon();
      });
      el.querySelector(".wave-wrap").addEventListener("click", (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setPos(((e.clientX - rect.left) / rect.width) * state.duration);
      });
      list.appendChild(el);
    }
    redraw();
    updateUI();
    updateSongBar();
  }

  function removeTrack(track) {
    if (!confirm("Tirar a stem “" + track.name + "”" + (state.songId ? " desta música? Ela também sai da biblioteca." : "?"))) return;
    if (state.engine) state.engine.remove(track);
    state.tracks = state.tracks.filter((t) => t !== track);
    state.duration = state.tracks.reduce((m, t) => Math.max(m, t.duration), 0);
    if (state.engine && state.engine.offset > state.duration) state.engine.offset = 0;
    applyGains();
    if (!state.tracks.length) stopPlayback();
    renderTracks();
    if (state.songId) {
      Lib.deleteFile(track.id).catch(() => {});
      if (state.tracks.length) saveSoon();
      else { const id = state.songId; detachSong(); Lib.deleteSong(id).then(refreshDrawer).catch(() => {}); }
    }
  }

  // reordenar stems arrastando o ícone do canto superior direito (mouse e toque)
  function startReorder(e, el) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    el.classList.add("dragging");
    document.body.classList.add("reordering");
    const move = (ev) => {
      ev.preventDefault();
      const own = el.getBoundingClientRect();
      if (ev.clientX >= own.left && ev.clientX <= own.right && ev.clientY >= own.top && ev.clientY <= own.bottom) return;
      const others = [...list.querySelectorAll(".track")].filter((c) => c !== el);
      if (!others.length) return;
      const lefts = others.map((c) => c.getBoundingClientRect().left);
      const oneCol = lefts.every((l) => Math.abs(l - lefts[0]) < 2) &&
        Math.abs(el.getBoundingClientRect().left - lefts[0]) < 2;
      let best = null, bestD = Infinity, after = false;
      for (const c of others) {
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const d = oneCol ? Math.abs(ev.clientY - cy) : Math.hypot(ev.clientX - cx, ev.clientY - cy);
        if (d < bestD) {
          bestD = d; best = c;
          after = oneCol || Math.abs(ev.clientY - cy) > r.height / 2 ? ev.clientY > cy : ev.clientX > cx;
        }
      }
      const ref = after ? best.nextElementSibling : best;
      if (ref !== el && el.nextElementSibling !== ref) list.insertBefore(el, ref);
      if (ev.clientY < 60) window.scrollBy(0, -12);
      else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("reordering");
      el.classList.remove("dragging");
      const order = [...list.querySelectorAll(".track")].map((c) => c.__track).filter(Boolean);
      if (order.length === state.tracks.length && order.some((t, i) => t !== state.tracks[i])) {
        state.tracks = order;
        renderTracks();
        saveSoon();
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  /* ---------- carregar ---------- */
  function setLoad(on, done, total, name) {
    $("load").hidden = !on;
    drop.classList.toggle("busy", on);
    if (!on) { $("loadFill").style.width = "0%"; return; }
    const pct = total ? Math.round((done / total) * 100) : 0;
    $("loadFill").style.width = pct + "%";
    $("loadText").textContent = name
      ? "Decodificando " + (done + 1) + "/" + total + " · " + name
      : (done >= total ? "Pronto" : "Carregando " + done + "/" + total);
  }
  function finishLoad(msg) {
    $("loadText").textContent = msg;
    $("loadFill").style.width = "100%";
    setTimeout(() => { setLoad(false); state.loading = false; }, 700);
  }

  function isAudio(f) {
    const s = ((f.type || "") + " " + (f.name || "")).toLowerCase();
    const exts = [".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".aif", ".aiff", ".opus", ".caf"];
    return s.indexOf("audio") >= 0 || exts.some((x) => s.indexOf(x) >= 0);
  }

  async function decodeInto(blob, meta) {
    const ctx = ensureCtx();
    const eng = await getEngine();
    const buf = await blob.arrayBuffer();
    const audio = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
    const track = {
      id: meta.id,
      name: meta.name,
      fileName: meta.fileName,
      size: meta.size || blob.size,
      type: meta.type || blob.type || "",
      color: meta.color || nextColor(),
      volume: meta.volume == null ? 1 : meta.volume,
      mute: !!meta.mute,
      solo: !!meta.solo,
      duration: audio.duration,
      peaks: computePeaks(audio),
      gainNow: null
    };
    track.gainNow = 0;
    eng.add(track, audio);
    return track;
  }

  function signature(files) {
    return files.map((f) => f.name + ":" + f.size).sort().join("|");
  }

  async function addFiles(files, opts) {
    opts = Object.assign({}, opts || {});
    if (state.loading) return;
    showError("");
    files = [...files];
    const incoming = files.filter(isAudio);
    if (!incoming.length) { showError("Nenhum arquivo de áudio reconhecido."); return; }
    ensureCtx();
    if (!opts.newSong && state.tracks.length && !opts.append) {
      opts.newSong = !confirm("Juntar " + (incoming.length > 1 ? "estes " + incoming.length + " arquivos" : "este arquivo") + " à música aberta “" + (state.songName || "sem nome") + "”?\n\nOK = juntar · Cancelar = criar uma música nova");
    }
    // música já salva com exatamente os mesmos arquivos? abre a salva em vez de duplicar
    if (opts.newSong || !state.tracks.length) {
      try {
        const sig = signature(incoming);
        const songs = await Lib.listSongs();
        const same = songs.find((s) => signature(s.stems.map((x) => ({ name: x.fileName, size: x.size }))) === sig);
        if (same) { await openSong(same.id, "Essa música já estava na biblioteca"); return; }
      } catch (e) {}
    }
    state.loading = true;
    const wasPlaying = playing();
    if (opts.newSong && state.tracks.length) clearSession();
    stopPlayback();
    const fresh = !state.tracks.length;
    if (fresh) {
      state.songId = Lib.uid();
      state.songCreated = Date.now();
      state.songName = await Tags.suggestName(incoming);
      setRate(1, true);
      setPitch(0, true);
    }
    setLoad(true, 0, incoming.length, incoming[0].name);
    await new Promise((r) => requestAnimationFrame(r));
    let ok = 0, saveFail = "";
    for (let i = 0; i < incoming.length; i++) {
      const file = incoming[i];
      setLoad(true, i, incoming.length, file.name);
      await new Promise((r) => requestAnimationFrame(r));
      try {
        const track = await decodeInto(file, {
          id: Lib.uid(), name: Tags.baseName(file.name), fileName: file.name, size: file.size, type: file.type
        });
        state.tracks.push(track);
        ok++;
        if (state.songId) {
          try { await Lib.putFile(track.id, state.songId, file); }
          catch (err) { saveFail = err && err.message ? err.message : String(err); }
        }
      } catch (err) {
        showError("Não deu para decodificar " + file.name + " (" + (err && err.message ? err.message : err) + ").");
      }
    }
    state.duration = state.tracks.reduce((m, t) => Math.max(m, t.duration), 0);
    applyGains();
    renderTracks();
    if (ok && state.songId) {
      if (saveFail) {
        showError("Tocando, mas não coube na biblioteca deste aparelho (" + saveFail + ").");
      } else {
        await saveSong(true);
        Lib.persist();
      }
    } else if (!state.tracks.length) {
      detachSong();
    }
    if (wasPlaying && state.tracks.length) startPlayback();
    syncMediaSession();
    finishLoad("Pronto · " + incoming.length + " arquivo" + (incoming.length > 1 ? "s" : "") + (state.songId && !saveFail ? " · salvo na biblioteca" : ""));
  }

  /* ---------- biblioteca ---------- */
  function detachSong() {
    state.songId = null;
    state.songName = "";
    updateSongBar();
  }
  function songMeta() {
    return {
      id: state.songId,
      name: state.songName || "Sem nome",
      created: state.songCreated || Date.now(),
      updated: Date.now(),
      opened: Date.now(),
      rate: state.rate,
      semi: state.semi,
      duration: state.duration,
      bytes: state.tracks.reduce((s, t) => s + (t.size || 0), 0),
      stems: state.tracks.map((t) => ({
        id: t.id, name: t.name, fileName: t.fileName, size: t.size, type: t.type,
        color: t.color, volume: t.volume, mute: t.mute, solo: t.solo, duration: t.duration
      }))
    };
  }
  let saveTimer = 0;
  function saveSoon() {
    if (!state.songId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSong(false), 400);
  }
  function flushSave() { if (saveTimer) saveSong(false); }
  async function saveSong(refresh) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!state.songId || !state.tracks.length) return;
    try {
      await Lib.putSong(songMeta());
      if (refresh || drawerOpen()) refreshDrawer();
    } catch (e) {
      showError("Não deu para salvar na biblioteca (" + (e && e.message ? e.message : e) + ").");
    }
  }
  function updateSongBar() {
    const inp = $("songName");
    if (document.activeElement !== inp) inp.value = state.songName || "";
    const n = state.tracks.length;
    $("songInfo").textContent = n ? (n + " stem" + (n > 1 ? "s" : "") + " · " + (state.songId ? "salvo" : "não salvo")) : "";
  }
  $("songName").addEventListener("input", (e) => { state.songName = e.target.value; });
  $("songName").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); });
  $("songName").addEventListener("blur", (e) => {
    state.songName = e.target.value.trim() || state.songName || "Sem nome";
    e.target.value = state.songName;
    saveSong(true);
    syncMediaSession();
  });

  function clearSession() {
    flushSave();
    stopPlayback();
    if (state.engine) state.engine.clear();
    state.tracks = [];
    state.duration = 0;
    detachSong();
    renderTracks();
    updateUI();
    syncMediaSession();
  }

  async function openSong(id, note) {
    if (state.loading) return;
    showError("");
    ensureCtx();
    const song = await Lib.getSong(id);
    if (!song) { showError("Essa música não está mais na biblioteca."); refreshDrawer(); return; }
    closeDrawer();
    clearSession();
    state.loading = true;
    state.songId = song.id;
    state.songName = song.name;
    state.songCreated = song.created;
    const total = song.stems.length;
    setLoad(true, 0, total, song.stems[0] ? song.stems[0].name : "");
    await new Promise((r) => requestAnimationFrame(r));
    let missing = 0;
    for (let i = 0; i < total; i++) {
      const s = song.stems[i];
      setLoad(true, i, total, s.name);
      await new Promise((r) => requestAnimationFrame(r));
      try {
        const blob = await Lib.getFile(s.id);
        if (!blob) { missing++; continue; }
        state.tracks.push(await decodeInto(blob, s));
      } catch (err) {
        missing++;
        showError("Não deu para abrir " + s.name + " (" + (err && err.message ? err.message : err) + ").");
      }
    }
    state.duration = state.tracks.reduce((m, t) => Math.max(m, t.duration), 0);
    setRate(song.rate || 1, true);
    setPitch(song.semi || 0, true);
    applyGains();
    renderTracks();
    if (missing && !state.tracks.length) {
      showError("Os arquivos desta música sumiram do aparelho (o iOS pode apagar dados de sites pouco usados). Envie as stems de novo.");
    } else if (missing) {
      showError(missing + " stem(s) desta música não estavam mais no aparelho.");
    }
    if (state.tracks.length) saveSong(true);
    syncMediaSession();
    finishLoad((note ? note + " · " : "") + "Aberta: " + song.name);
  }

  function drawerOpen() { return document.body.classList.contains("drawer-open"); }
  function openDrawer() {
    document.body.classList.add("drawer-open");
    $("scrim").hidden = false;
    $("drawer").setAttribute("aria-hidden", "false");
    $("menu").setAttribute("aria-expanded", "true");
    refreshDrawer();
  }
  function closeDrawer() {
    document.body.classList.remove("drawer-open");
    $("scrim").hidden = true;
    $("drawer").setAttribute("aria-hidden", "true");
    $("menu").setAttribute("aria-expanded", "false");
  }
  $("menu").addEventListener("click", () => (drawerOpen() ? closeDrawer() : openDrawer()));
  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);

  const FOLDER_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.4"/></svg>';
  const TRASH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  async function refreshDrawer() {
    const box = $("songs");
    let songs = [];
    try { songs = await Lib.listSongs(); }
    catch (e) {
      box.innerHTML = '<p class="empty">Biblioteca indisponível neste navegador (' + esc(e && e.message ? e.message : e) + ').</p>';
      return;
    }
    if (!songs.length) {
      box.innerHTML = '<p class="empty">Nenhuma música salva ainda. Toda vez que você envia stems, elas ficam guardadas aqui, só neste aparelho.</p>';
    } else {
      box.innerHTML = "";
      for (const s of songs) {
        const row = document.createElement("div");
        row.className = "song" + (s.id === state.songId ? " current" : "");
        const names = s.stems.map((x) => x.name).join(", ");
        row.innerHTML =
          '<button class="song-open" title="Abrir">' + FOLDER_SVG +
            '<span class="song-text"><span class="song-name">' + esc(s.name) + '</span>' +
            '<small>' + s.stems.length + ' stem' + (s.stems.length > 1 ? 's' : '') + ' · ' + fmtShort(s.duration) + ' · ' + fmtBytes(s.bytes) + '</small>' +
            '<small class="song-stems">' + esc(names) + '</small></span>' +
          '</button>' +
          '<button class="icon sm ren" title="Renomear" aria-label="Renomear">' + PEN_SVG + '</button>' +
          '<button class="icon sm del" title="Apagar do aparelho" aria-label="Apagar">' + TRASH_SVG + '</button>';
        row.querySelector(".song-open").addEventListener("click", () => {
          if (row.classList.contains("renaming")) return;
          if (s.id === state.songId && state.tracks.length) { closeDrawer(); return; }
          openSong(s.id).catch((err) => showError("Erro ao abrir: " + (err && err.message ? err.message : err)));
        });
        row.querySelector(".ren").addEventListener("click", () => renameSongRow(row, s));
        row.querySelector(".del").addEventListener("click", async () => {
          if (!confirm("Apagar “" + s.name + "” deste aparelho? Os arquivos das stems saem da biblioteca.")) return;
          await Lib.deleteSong(s.id);
          if (s.id === state.songId) clearSession();
          refreshDrawer();
        });
        box.appendChild(row);
      }
    }
    const est = await Lib.estimate();
    const total = songs.reduce((a, s) => a + (s.bytes || 0), 0);
    $("storeInfo").textContent = "Guardado só neste aparelho · " + songs.length + " música" + (songs.length === 1 ? "" : "s") + " · " + fmtBytes(total) +
      (est && est.quota ? " · espaço livre ~" + fmtBytes(Math.max(0, est.quota - (est.usage || 0))) : "");
  }

  function renameSongRow(row, s) {
    if (row.classList.contains("renaming")) return;
    row.classList.add("renaming");
    const nameEl = row.querySelector(".song-name");
    const inp = document.createElement("input");
    inp.className = "song-rename";
    inp.value = s.name;
    inp.maxLength = 120;
    inp.setAttribute("aria-label", "Novo nome");
    nameEl.replaceWith(inp);
    inp.focus();
    inp.select();
    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const v = inp.value.trim();
      if (save && v && v !== s.name) {
        const song = await Lib.getSong(s.id);
        if (song) {
          song.name = v;
          song.updated = Date.now();
          await Lib.putSong(song);
        }
        if (s.id === state.songId) { state.songName = v; updateSongBar(); syncMediaSession(); }
      }
      refreshDrawer();
    };
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  /* ---------- transporte ---------- */
  function togglePlay() {
    if (!state.tracks.length || state.loading) return;
    if (playing()) { stopPlayback(); updateUI(); }
    else startPlayback();
    syncMediaSession();
  }

  function syncMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.songName || (state.tracks[0] ? state.tracks[0].name : "Stem Sync"),
        artist: "Stem Sync",
        album: state.tracks.length + " stems",
        artwork: ICON ? [{ src: ICON, sizes: "192x192", type: "image/png" }] : []
      });
      navigator.mediaSession.playbackState = playing() ? "playing" : "paused";
      navigator.mediaSession.setPositionState({
        duration: state.duration || 0,
        playbackRate: state.rate || 1,
        position: Math.min(state.duration || 0, currentPos())
      });
    } catch (e) {}
  }

  $("play").addEventListener("click", togglePlay);
  $("stop").addEventListener("click", () => {
    stopPlayback();
    if (state.engine) state.engine.offset = 0;
    updateUI();
    syncMediaSession();
  });
  function skipBy(sec) { setPos(currentPos() + sec); syncMediaSession(); }
  $("back5").addEventListener("click", () => skipBy(-5));
  $("fwd5").addEventListener("click", () => skipBy(5));
  $("unsolo").addEventListener("click", () => {
    if (!anySolo()) return;
    for (const track of state.tracks) track.solo = false;
    applyGains(); renderTracks(); saveSoon();
  });
  $("seek").addEventListener("input", (e) => {
    if (!state.duration) return;
    setPos((Number(e.target.value) / 1000) * state.duration);
  });

  function applyParams() {
    if (state.engine) state.engine.setParams(state.rate, state.engine.stretch ? state.semi : 0);
    syncMediaSession();
  }
  function setRate(rate, quiet) {
    rate = Math.max(0.5, Math.min(1.5, rate));
    state.rate = rate;
    $("rate").value = String(Math.round(rate * 100));
    $("rateReset").textContent = rate.toFixed(2) + "×";
    $("rateReset").classList.toggle("on", Math.abs(rate - 1) > 0.001);
    applyParams();
    if (!quiet) saveSoon();
  }
  function setPitch(semi, quiet) {
    semi = Math.max(-12, Math.min(12, Math.round(semi)));
    state.semi = semi;
    $("pitch").value = String(semi);
    $("pitchReset").textContent = (semi > 0 ? "+" : semi < 0 ? "−" : "") + Math.abs(semi) + " st";
    $("pitchReset").classList.toggle("on", semi !== 0);
    applyParams();
    if (!quiet) saveSoon();
  }
  $("rate").addEventListener("input", (e) => setRate(Number(e.target.value) / 100));
  $("rateReset").addEventListener("click", () => setRate(1));
  $("pitch").addEventListener("input", (e) => setPitch(Number(e.target.value)));
  $("pitchReset").addEventListener("click", () => setPitch(0));
  $("mix").addEventListener("click", (e) => {
    if (!state.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPos(((e.clientX - rect.left) / rect.width) * state.duration);
  });
  $("add").addEventListener("click", () => fileInput.click());
  $("clear").addEventListener("click", () => {
    if (!state.tracks.length) return;
    clearSession();
    setRate(1, true);
    setPitch(0, true);
  });

  /* ---------- seletor de arquivos (iOS) ---------- */
  const picks = new Map();
  function makePick(input, opts) {
    return function onPick() {
      const files = [...(input.files || [])];
      const sig = files.map((f) => f.name + f.size).join("|");
      if (!files.length || sig === picks.get(input)) return;
      picks.set(input, sig);
      showError("");
      $("load").hidden = false;
      $("loadText").textContent = "Recebi " + files.length + " arquivo" + (files.length > 1 ? "s" : "") + ", preparando…";
      if (opts.newSong) closeDrawer();
      addFiles(files, opts).catch((err) => { state.loading = false; setLoad(false); showError("Erro ao carregar: " + (err && err.message ? err.message : err)); })
        .finally(() => { input.value = ""; picks.set(input, ""); });
    };
  }
  for (const [input, opts] of [[fileInput, {}], [fileInput2, { newSong: true }]]) {
    const onPick = makePick(input, opts);
    input.addEventListener("change", onPick);
    input.addEventListener("input", onPick);
    input.addEventListener("click", () => { ensureCtx(); input.value = ""; picks.set(input, ""); });
    // iOS às vezes não dispara change/input: confere o campo quando a página volta do seletor
    const recheck = () => setTimeout(() => { if (input.files && input.files.length) onPick(); }, 400);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) recheck(); });
  }

  /* ---------- versão nova ---------- */
  function checkVersion() {
    if (!location.protocol.startsWith("http")) return;
    const base = location.pathname.endsWith("/") ? location.pathname : location.pathname.replace("index.html", "");
    fetch(base + "index.html?nc=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        const m = t.match(/const VERSION = "([^"]+)"/);
        if (m && m[1] !== VERSION) {
          const v = $("ver");
          v.textContent = VERSION + " → " + m[1] + " disponível, toque para atualizar";
          v.style.cursor = "pointer"; v.style.color = "var(--gold)";
          v.onclick = async () => {
            try {
              const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
              if (reg) await reg.update();
            } catch (e) {}
            location.replace(base + "?v=" + m[1]);
          };
        }
      }).catch(() => {});
  }
  checkVersion();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    {
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch((e) => __log("Aviso: modo offline indisponível (" + (e && e.message ? e.message : e) + ")"));
    }
  }

  window.addEventListener("error", (e) => showError("Erro: " + e.message));
  window.addEventListener("unhandledrejection", (e) => showError("Erro: " + (e.reason && e.reason.message ? e.reason.message : e.reason)));

  ["dragenter", "dragover"].forEach((ev) => {
    window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); });
  });
  window.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input:not([type=range])")) return;
    if (e.key === "Escape" && drawerOpen()) { closeDrawer(); return; }
    const playKeys = ["Space", "MediaPlayPause", "MediaPlay"];
    if (playKeys.includes(e.code) || e.key === "MediaPlayPause") { e.preventDefault(); togglePlay(); }
    if (e.code === "MediaStop" || e.code === "Home") { e.preventDefault(); $("stop").click(); }
    if (e.code === "MediaTrackPrevious" || e.code === "ArrowLeft") { e.preventDefault(); skipBy(-5); }
    if (e.code === "MediaTrackNext" || e.code === "ArrowRight") { e.preventDefault(); skipBy(5); }
  });

  if ("mediaSession" in navigator) {
    const action = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) {} };
    action("play", () => { startPlayback().then(syncMediaSession); });
    action("pause", () => { stopPlayback(); syncMediaSession(); });
    action("stop", () => { $("stop").click(); });
    action("seekbackward", (d) => skipBy(-(d.seekOffset || 5)));
    action("seekforward", (d) => skipBy(d.seekOffset || 5));
    action("seekto", (d) => { if (d.seekTime != null) setPos(d.seekTime); });
  }
  window.addEventListener("resize", redraw);
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });

  renderTracks();
  window.__app = { openSong, refreshDrawer, setRate, setPitch, addFiles, clearSession, state };
  window.__mainOk = true;
})();
