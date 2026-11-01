// تخزين محلي بسيط فوق IndexedDB
const DB = (() => {
  const NAME = 'hudoor';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('employees')) {
          db.createObjectStore('employees', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('ts', 'ts');
          s.createIndex('empId', 'empId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async all(store) {
      const db = await open();
      return reqP(db.transaction(store).objectStore(store).getAll());
    },
    async get(store, key) {
      const db = await open();
      return reqP(db.transaction(store).objectStore(store).get(key));
    },
    put(store, value) { return tx(store, 'readwrite', s => { s.put(value); }); },
    del(store, key) { return tx(store, 'readwrite', s => { s.delete(key); }); },
    clear(store) { return tx(store, 'readwrite', s => { s.clear(); }); },
    putMany(store, values) { return tx(store, 'readwrite', s => { values.forEach(v => s.put(v)); }); },
    async recordsBetween(fromTs, toTs) {
      const db = await open();
      const idx = db.transaction('records').objectStore('records').index('ts');
      return reqP(idx.getAll(IDBKeyRange.bound(fromTs, toTs)));
    },
    async getSetting(key, def) {
      const row = await this.get('settings', key);
      return row ? row.value : def;
    },
    setSetting(key, value) { return this.put('settings', { key, value }); },
    async persist() {
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    }
  };
})();
