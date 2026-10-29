import type { BarData } from "@/lib/brokers/types";

const DB_NAME = "backtest-bar-cache";
const STORE_NAME = "bars";
const DB_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface BarCacheEntry {
  key: string;
  bars: BarData[];
  tickSize: number;
  tickValue: number;
  contractId: string;
  contractName: string;
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
}

export async function getCachedBars(key: string): Promise<BarCacheEntry | null> {
  if (typeof indexedDB === "undefined") return null;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => {
      const entry = req.result as BarCacheEntry | undefined;
      db.close();
      if (!entry) {
        resolve(null);
        return;
      }
      if (entry.cachedAt + TTL_MS < Date.now()) {
        resolve(null);
        return;
      }
      resolve(entry);
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

export async function setCachedBars(entry: BarCacheEntry): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      resolve();
    };
  });
}

export async function clearBarCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      resolve();
    };
  });
}
