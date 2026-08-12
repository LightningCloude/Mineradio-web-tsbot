const DB_NAME = 'minerats-bg-db';
const STORE_NAME = 'videos';
const WALLPAPER_KEY = 'bg-video';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function openWallpaperDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持本地壁纸存储'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地壁纸存储'));
    request.onblocked = () => reject(new Error('本地壁纸存储正被其他页面占用，请关闭旧页面后重试'));
  });
}

export function normalizeWallpaperRecord(value) {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      blob: value,
      name: typeof value.name === 'string' ? value.name : '本地视频',
      updatedAt: 0,
    };
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof Blob !== 'undefined' &&
    value.blob instanceof Blob
  ) {
    return {
      blob: value.blob,
      name: String(value.name || '本地视频'),
      updatedAt: Number(value.updatedAt) || 0,
    };
  }
  return null;
}

export async function loadLocalWallpaper() {
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(WALLPAPER_KEY));
    return normalizeWallpaperRecord(value);
  } finally {
    database.close();
  }
}

export async function saveLocalWallpaper(file) {
  if (!(file instanceof Blob) || file.size <= 0) {
    throw new Error('请选择有效的视频文件');
  }

  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(
      {
        blob: file,
        name: typeof file.name === 'string' ? file.name : '本地视频',
        type: file.type || '',
        size: file.size,
        updatedAt: Date.now(),
      },
      WALLPAPER_KEY,
    );
    await transactionDone(transaction);
  } catch (error) {
    if (error?.name === 'QuotaExceededError') {
      throw new Error('视频过大或浏览器存储空间不足，请选择较小的视频');
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function clearLocalWallpaper() {
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(WALLPAPER_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  navigator.storage.persist().catch(() => {});
}

export function formatWallpaperSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024 * 1024) return `${Math.max(0.1, size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
