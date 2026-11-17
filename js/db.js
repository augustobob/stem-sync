/* Stem Sync · biblioteca local (IndexedDB). Os arquivos ficam só neste aparelho. */
(function () {
  const DB_NAME = "stem-sync";
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB indisponível")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) {
          const files = db.createObjectStore("files", { keyPath: "id" });
          files.createIndex("songId", "songId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Banco de dados bloqueado por outra aba"));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transação abortada"));
    });
  }
  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const Lib = {
    uid() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    async listSongs() {
      const db = await open();
      const tx = db.transaction("songs", "readonly");
      const all = await reqP(tx.objectStore("songs").getAll());
      return all.sort((a, b) => (b.opened || b.updated || 0) - (a.opened || a.updated || 0));
    },
    async getSong(id) {
      const db = await open();
      return reqP(db.transaction("songs", "readonly").objectStore("songs").get(id));
    },
    async putSong(song) {
      const db = await open();
      const tx = db.transaction("songs", "readwrite");
      tx.objectStore("songs").put(song);
      return done(tx);
    },
    async putFile(id, songId, blob) {
      const db = await open();
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put({ id, songId, blob });
      return done(tx);
    },
    async getFile(id) {
      const db = await open();
      const rec = await reqP(db.transaction("files", "readonly").objectStore("files").get(id));
      return rec ? rec.blob : null;
    },
    async deleteFile(id) {
      const db = await open();
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").delete(id);
      return done(tx);
    },
    async deleteSong(id) {
      const db = await open();
      const tx = db.transaction(["songs", "files"], "readwrite");
      tx.objectStore("songs").delete(id);
      const idx = tx.objectStore("files").index("songId");
      const keys = await reqP(idx.getAllKeys(id));
      for (const k of keys) tx.objectStore("files").delete(k);
      return done(tx);
    },
    async estimate() {
      try {
        if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
      } catch (e) {}
      return null;
    },
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
          return await navigator.storage.persist();
        }
      } catch (e) {}
      return false;
    }
  };
  window.Lib = Lib;
})();
