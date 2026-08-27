export class EventStore {
  constructor(name = "coachjd") { this.name = name; this.db = null; }

  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const events = db.createObjectStore("events", { keyPath: "eventId" });
        events.createIndex("matchId", "matchId");
        db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this;
  }

  async append(event) {
    await this.#request("events", "readwrite", store => store.add(event));
    await this.setMeta("activeMatchId", event.matchId);
    return event;
  }

  async appendMany(events) {
    if (!events.length) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction("events", "readwrite");
      const store = tx.objectStore("events");
      events.forEach(event => store.add(event));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async eventsFor(matchId) {
    const rows = await this.#request("events", "readonly", store => store.index("matchId").getAll(matchId));
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  async allEvents() {
    const rows = await this.#request("events", "readonly", store => store.getAll());
    return rows.sort((a, b) => a.realTimestamp.localeCompare(b.realTimestamp) || a.sequence - b.sequence);
  }

  async allMeta() { return this.#request("meta", "readonly", store => store.getAll()); }

  async replaceAll({ events, meta }) {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(["events", "meta"], "readwrite");
      const eventStore = tx.objectStore("events");
      const metaStore = tx.objectStore("meta");
      eventStore.clear();
      metaStore.clear();
      events.forEach(event => eventStore.add(event));
      meta.forEach(record => metaStore.put(record));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async clearAll() { return this.replaceAll({ events: [], meta: [] }); }

  async deleteMatch(matchId) {
    const keys = await this.#request("events", "readonly", store => store.index("matchId").getAllKeys(matchId));
    if (keys.length) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction("events", "readwrite");
        const events = tx.objectStore("events");
        keys.forEach(key => events.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    await this.setMeta("activeMatchId", null);
  }

  async getActiveMatchId() { return (await this.getMeta("activeMatchId"))?.value || null; }
  async setMeta(key, value) { return this.#request("meta", "readwrite", store => store.put({ key, value })); }
  async getMeta(key) { return this.#request("meta", "readonly", store => store.get(key)); }

  #request(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }
}
