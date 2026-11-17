/* Stem Sync · lê título/artista das tags (ID3, FLAC, WAV INFO) para sugerir o nome da música */
(function () {
  function latin1(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function decode(bytes, enc) {
    try { return new TextDecoder(enc).decode(bytes); } catch (e) { return latin1(bytes); }
  }
  function clean(s) {
    return String(s || "").split("\u0000").join(" ").trim();
  }
  function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }

  function parseID3(b, off) {
    const out = {};
    if (latin1(b.subarray(off, off + 3)) !== "ID3") return out;
    const ver = b[off + 3];
    const size = syncsafe(b, off + 6);
    let p = off + 10;
    const end = Math.min(b.length, off + 10 + size);
    while (p + 10 <= end) {
      const id = latin1(b.subarray(p, p + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
      const body = b.subarray(p + 10, Math.min(end, p + 10 + fs));
      if (id === "TIT2" || id === "TPE1" || id === "TALB") {
        const enc = body[0];
        const raw = body.subarray(1);
        const txt = enc === 1 || enc === 2 ? decode(raw, enc === 2 ? "utf-16be" : "utf-16") : decode(raw, enc === 3 ? "utf-8" : "latin1");
        out[id === "TIT2" ? "title" : id === "TPE1" ? "artist" : "album"] = clean(txt);
      }
      p += 10 + fs;
    }
    return out;
  }

  function parseFLAC(b) {
    const out = {};
    let p = 4;
    while (p + 4 <= b.length) {
      const last = b[p] & 0x80, type = b[p] & 0x7f;
      const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      if (type === 4) {
        const dv = new DataView(b.buffer, b.byteOffset + p + 4, Math.min(len, b.length - p - 4));
        let q = 0;
        const vlen = dv.getUint32(q, true); q += 4 + vlen;
        const n = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < n && q + 4 <= dv.byteLength; i++) {
          const l = dv.getUint32(q, true); q += 4;
          const s = decode(new Uint8Array(dv.buffer, dv.byteOffset + q, Math.min(l, dv.byteLength - q)), "utf-8");
          q += l;
          const eq = s.indexOf("=");
          if (eq > 0) {
            const k = s.slice(0, eq).toUpperCase();
            if (k === "TITLE") out.title = clean(s.slice(eq + 1));
            if (k === "ARTIST") out.artist = clean(s.slice(eq + 1));
            if (k === "ALBUM") out.album = clean(s.slice(eq + 1));
          }
        }
        break;
      }
      if (last) break;
      p += 4 + len;
    }
    return out;
  }

  function parseWAV(b) {
    const out = {};
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 12;
    while (p + 8 <= b.length) {
      const id = latin1(b.subarray(p, p + 4));
      const len = dv.getUint32(p + 4, true);
      if (id === "LIST" && latin1(b.subarray(p + 8, p + 12)) === "INFO") {
        let q = p + 12;
        const end = Math.min(b.length, p + 8 + len);
        while (q + 8 <= end) {
          const sid = latin1(b.subarray(q, q + 4));
          const sl = dv.getUint32(q + 4, true);
          const val = clean(decode(b.subarray(q + 8, Math.min(end, q + 8 + sl)), "utf-8"));
          if (sid === "INAM") out.title = val;
          if (sid === "IART") out.artist = val;
          if (sid === "IPRD") out.album = val;
          q += 8 + sl + (sl & 1);
        }
      } else if (id === "id3 " || id === "ID3 ") {
        Object.assign(out, parseID3(b, p + 8));
      } else if (id === "data" && len > b.length) {
        break; // as tags costumam vir antes ou depois do áudio; não lemos o arquivo inteiro
      }
      p += 8 + len + (len & 1);
    }
    return out;
  }

  async function readTags(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
      const magic = latin1(head.subarray(0, 4));
      if (magic.slice(0, 3) === "ID3") return parseID3(head, 0);
      if (magic === "fLaC") return parseFLAC(head);
      if (magic === "RIFF") {
        const t = parseWAV(head);
        if (t.title) return t;
        if (file.size > 262144) {
          // LIST/INFO no fim do WAV: lê o final do arquivo
          const tailStart = Math.max(0, file.size - 65536);
          const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
          const at = latin1(tail).lastIndexOf("LIST");
          if (at >= 0) {
            const fake = new Uint8Array(12 + tail.length - at);
            fake.set(tail.subarray(at), 12);
            return parseWAV(fake);
          }
        }
        return t;
      }
    } catch (e) {}
    return {};
  }

  const ROLE_WORDS = ["vocal", "vocals", "voz", "back", "backing", "guitarra", "guitar", "baixo", "bass", "bateria", "drums", "outros", "other", "piano", "instrumental", "inst", "stem", "stems"];

  function baseName(n) {
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(0, i) : n;
  }
  function trimSep(s) {
    let a = 0, b = s.length;
    const sep = " -_.()[]·–—";
    while (a < b && sep.indexOf(s[a]) >= 0) a++;
    while (b > a && sep.indexOf(s[b - 1]) >= 0) b--;
    return s.slice(a, b);
  }

  async function suggestName(files) {
    const titles = {};
    let best = null;
    for (const f of files) {
      const t = await readTags(f);
      if (t.title) {
        const key = (t.artist ? t.artist + " – " : "") + t.title;
        titles[key] = (titles[key] || 0) + 1;
        if (!best || titles[key] > titles[best]) best = key;
      }
    }
    if (best) return best;
    const rel = files.map((f) => f.webkitRelativePath || "").filter(Boolean);
    if (rel.length) {
      const parts = rel[0].split("/");
      if (parts.length > 1) return parts[parts.length - 2];
    }
    const names = files.map((f) => baseName(f.name));
    if (names.length > 1) {
      let pre = names[0];
      for (const n of names) { while (pre && n.indexOf(pre) !== 0) pre = pre.slice(0, -1); }
      pre = trimSep(pre);
      if (pre.length >= 3 && ROLE_WORDS.indexOf(pre.toLowerCase()) < 0) return pre;
    } else if (names.length === 1) {
      return trimSep(names[0]) || names[0];
    }
    const d = new Date();
    const two = (x) => String(x).padStart(2, "0");
    return "Música de " + two(d.getDate()) + "/" + two(d.getMonth() + 1) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  window.Tags = { readTags, suggestName, baseName };
})();
