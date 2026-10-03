const UUID = {
  service: '7f510000-4b7e-4ca4-9f6b-6b2752494345',
  command: '7f510001-4b7e-4ca4-9f6b-6b2752494345',
  info: '7f510002-4b7e-4ca4-9f6b-6b2752494345',
  data: '7f510003-4b7e-4ca4-9f6b-6b2752494345',
  event: '7f510004-4b7e-4ca4-9f6b-6b2752494345',
  image: '7f510005-4b7e-4ca4-9f6b-6b2752494345',
};

const BLE_TEXT_TEST = {
  name: 'RiceWL-BLE-Test',
  service: '7f520000-4b7e-4ca4-9f6b-6b2752494345',
  rx: '7f520001-4b7e-4ca4-9f6b-6b2752494345',
  tx: '7f520002-4b7e-4ca4-9f6b-6b2752494345',
  chunkBytes: 20,
  maxMessageBytes: 240,
};

const APP_VERSION = self.RICE_APP_VERSION || document.documentElement.dataset.releaseVersion || '未知版本';
const MAX_CALIBRATION_IMAGE_BYTES = 1024 * 1024;

const $ = (selector) => document.querySelector(selector);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
let device;
let chars = {};
let info = null;
let incoming = [];
let expectedDownload = 0;
let downloadLastSequence = 0;
let dbPromise;
let currentLocation = null;
let currentLocationDeviceId = null;
let cloudChartState = null;
let chartResizeTimer = null;
let calibrationImageTransfer = null;
let bleTextDevice = null;
let bleTextRx = null;
let bleTextTx = null;
let bleTextReceiveBuffer = '';
let bleTextStreamDecoder = new TextDecoder('utf-8', { fatal: true });

function isIOSSafari() {
  const userAgent = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(userAgent);
  return isIOS && isSafari;
}

function hasWebBluetooth() {
  return Boolean(navigator.bluetooth &&
    typeof navigator.bluetooth.requestDevice === 'function');
}

function bluetoothUnavailableMessage() {
  if (!self.isSecureContext) {
    return '藍牙連線需要 HTTPS；請以已部署的網站開啟，不可直接使用檔案網址。';
  }
  if (isIOSSafari()) {
    return 'iOS Safari 尚未取得藍牙功能。請安裝 Beacio，於 Safari 的「aA → 管理擴充功能」啟用，並允許此網站後重新開啟。';
  }
  return '此瀏覽器不支援 Web Bluetooth；請使用 Android Chrome／Edge，或 iOS Safari 搭配 Beacio。';
}

function updateBleRuntime() {
  const target = $('#ble-runtime');
  if (!target) return;
  if (hasWebBluetooth()) {
    target.textContent = isIOSSafari()
      ? 'iOS Safari：已取得 Beacio 提供的 Web Bluetooth，可直接按「連接 BLE」。'
      : '此瀏覽器已支援 Web Bluetooth，可直接按「連接 BLE」。';
    target.className = 'ble-runtime ready';
    return;
  }
  target.textContent = bluetoothUnavailableMessage();
  target.className = 'ble-runtime notice';
}

function getSupabaseConfig() {
  const raw = self.RICE_SUPABASE_CONFIG || {};
  const url = String(raw.url || '').trim().replace(/\/+$/, '');
  const anonKey = String(raw.anonKey || '').trim();
  const table = String(raw.table || 'rice_measurements').trim();
  const deviceRpc = String(raw.deviceRpc || 'register_rice_device').trim();
  const chartRpc = String(raw.chartRpc || 'get_rice_chart').trim();
  if (!url || !anonKey) return null;
  if (!/^https:\/\//.test(url) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(deviceRpc) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chartRpc)) return null;
  return { url, anonKey, table, deviceRpc, chartRpc };
}

function setCloudDetail(message = '') {
  const target = $('#cloud-detail');
  if (!target) return;
  target.hidden = !message;
  target.textContent = message;
}

function cloudDiagnosticMessage(errorMessage) {
  const raw = String(errorMessage || '').trim();
  if (!raw) return '';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return '雲端診斷：手機無法連上 Supabase。請確認手機網路、Supabase 專案網址與 HTTPS。';
  }
  if (/Supabase HTTP 401/.test(raw)) {
    if (/42501|row-level security/i.test(raw)) {
      return '雲端診斷：HTTP 401／42501，已連上 Supabase，但 rice_measurements 的 RLS 拒絕新增資料；請執行專案內的 fix_anon_insert_policy.sql。';
    }
    return '雲端診斷：HTTP 401，Supabase 拒絕此 API key；請確認 Project URL 與 publishable key。';
  }
  if (/Supabase HTTP 403/.test(raw)) {
    return '雲端診斷：HTTP 403，資料表的 RLS 新增權限拒絕此筆資料。';
  }
  if (/Supabase HTTP 404/.test(raw)) {
    return '雲端診斷：HTTP 404，找不到 Supabase 資料表、裝置登錄或圖表函式；請確認已執行最新 SQL。';
  }
  if (/Supabase HTTP 409/.test(raw)) {
    return '雲端診斷：HTTP 409，資料表主鍵或 upsert 設定不符合預期。';
  }
  return `雲端診斷：${raw}`;
}

function setCloudSummary(message, bad = false, detail = '') {
  const target = $('#cloud-status');
  if (target) {
    target.textContent = message;
    target.style.color = bad ? '#a63d31' : '';
  }
  setCloudDetail(detail);
}

function nullableValue(value, invalidValue) {
  return value === invalidValue ? null : value;
}

function toCloudRecord(record) {
  return {
    device_id: record.deviceId,
    sequence: record.sequence,
    epoch_utc: record.epochUtc ? new Date(record.epochUtc * 1000).toISOString() : null,
    surface_from_top_mm: nullableValue(record.surfaceFromTopMm, -32768),
    water_depth_mm: nullableValue(record.waterDepthMm, -32768),
    temperature_centi_c: nullableValue(record.temperatureCentiC, -32768),
    humidity_centi_pct: nullableValue(record.humidityCentiPct, 65535),
    quality: record.quality,
    flags: record.flags,
    measurement_status: measurementStatus(record),
    firmware_version: record.firmwareVersion || 'UNKNOWN',
    app_version: record.appVersion || APP_VERSION,
    downloaded_at: new Date(record.downloadedAt || Date.now()).toISOString(),
  };
}

function showStatus(message, bad = false) {
  $('#status').textContent = message;
  $('#status').style.color = bad ? '#a63d31' : '';
}

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function parseRecord(value) {
  if (value.byteLength !== 20) throw new Error(`資料長度 ${value.byteLength}，應為 20`);
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const bytes = new Uint8Array(value.buffer, value.byteOffset, 18);
  const expectedCrc = view.getUint16(18, true);
  if (crc16(bytes) !== expectedCrc) throw new Error('CRC 錯誤');
  return {
    deviceId: info?.id || device?.name || 'UNKNOWN',
    firmwareVersion: info?.fw || 'UNKNOWN',
    appVersion: APP_VERSION,
    sequence: view.getUint32(0, true),
    epochUtc: view.getUint32(4, true),
    surfaceFromTopMm: view.getInt16(8, true),
    waterDepthMm: view.getInt16(10, true),
    temperatureCentiC: view.getInt16(12, true),
    humidityCentiPct: view.getUint16(14, true),
    quality: view.getUint8(16),
    flags: view.getUint8(17),
    crc16: expectedCrc,
    downloadedAt: Date.now(),
  };
}

function createCloudTestRecord() {
  const now = Date.now();
  const testValue = `PWA_TEST_${now}`;
  return {
    // Keep synthetic records separate from actual device measurements while
    // exercising the identical IndexedDB -> Supabase upload path.
    deviceId: `TEST-${info?.id || 'PWA'}`,
    firmwareVersion: info?.fw || 'PWA-TEST',
    appVersion: APP_VERSION,
    sequence: now,
    epochUtc: Math.floor(now / 1000),
    surfaceFromTopMm: -32768,
    waterDepthMm: -32768,
    temperatureCentiC: -32768,
    humidityCentiPct: 65535,
    quality: 100,
    flags: 0,
    crc16: 0,
    downloadedAt: now,
    cloudTestValue: testValue,
  };
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('rice-water-monitor', 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains('records')
        ? request.transaction.objectStore('records')
        : db.createObjectStore('records', { keyPath: ['deviceId', 'sequence'] });
      if (!store.indexNames.contains('device')) store.createIndex('device', 'deviceId');
      if (!store.indexNames.contains('cloudStatus')) {
        store.createIndex('cloudStatus', 'cloudStatus');
      }
      const deviceStore = db.objectStoreNames.contains('deviceConfigs')
        ? request.transaction.objectStore('deviceConfigs')
        : db.createObjectStore('deviceConfigs', { keyPath: 'deviceId' });
      if (!deviceStore.indexNames.contains('cloudStatus')) {
        deviceStore.createIndex('cloudStatus', 'cloudStatus');
      }
      const photoStore = db.objectStoreNames.contains('calibrationPhotos')
        ? request.transaction.objectStore('calibrationPhotos')
        : db.createObjectStore('calibrationPhotos', { keyPath: 'id' });
      if (!photoStore.indexNames.contains('device')) {
        photoStore.createIndex('device', 'deviceId');
      }
      if (!photoStore.indexNames.contains('capturedAt')) {
        photoStore.createIndex('capturedAt', 'capturedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function saveRecords(records) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    records.forEach((record) => {
      const lookup = store.get([record.deviceId, record.sequence]);
      lookup.onsuccess = () => {
        const existing = lookup.result;
        store.put({
          ...record,
          cloudStatus: existing?.cloudStatus || 'pending',
          cloudSyncedAt: existing?.cloudSyncedAt || null,
          cloudError: existing?.cloudError || null,
          cloudAttempts: existing?.cloudAttempts || 0,
        });
      };
      lookup.onerror = () => tx.abort();
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

async function getLocalRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const request = tx.objectStore('records').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.sequence - a.sequence));
    request.onerror = () => reject(request.error);
  });
}

async function clearLocalRecords() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function saveCalibrationPhoto(photo) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('calibrationPhotos', 'readwrite');
    tx.objectStore('calibrationPhotos').put(photo);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('校正照片儲存失敗'));
  });
}

async function getCalibrationPhotos() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('calibrationPhotos', 'readonly');
    const request = tx.objectStore('calibrationPhotos').getAll();
    request.onsuccess = () => resolve(
      request.result.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
    );
    request.onerror = () => reject(request.error);
  });
}

async function deleteCalibrationPhoto(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('calibrationPhotos', 'readwrite');
    tx.objectStore('calibrationPhotos').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('校正照片刪除失敗'));
  });
}

async function getPendingCloudRecords() {
  const records = await getLocalRecords();
  return records.filter((record) => record.cloudStatus !== 'synced');
}

async function markCloudRecords(records, status, errorMessage = null) {
  if (!records.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    records.forEach((record) => {
      const lookup = store.get([record.deviceId, record.sequence]);
      lookup.onsuccess = () => {
        const saved = lookup.result;
        if (!saved) return;
        saved.cloudStatus = status;
        saved.cloudAttempts = (saved.cloudAttempts || 0) + 1;
        saved.cloudError = errorMessage;
        if (status === 'synced') saved.cloudSyncedAt = Date.now();
        store.put(saved);
      };
      lookup.onerror = () => tx.abort();
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

async function saveDeviceConfig(config) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('deviceConfigs', 'readwrite');
    const store = tx.objectStore('deviceConfigs');
    const lookup = store.get(config.deviceId);
    lookup.onsuccess = () => {
      const existing = lookup.result;
      store.put({
        ...existing,
        ...config,
        installedAt: existing?.installedAt || config.installedAt || Date.now(),
        cloudStatus: 'pending',
        cloudSyncedAt: existing?.cloudSyncedAt || null,
        cloudError: null,
        cloudAttempts: existing?.cloudAttempts || 0,
      });
    };
    lookup.onerror = () => tx.abort();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB device transaction aborted'));
  });
}

async function getDeviceConfig(deviceId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('deviceConfigs', 'readonly');
    const request = tx.objectStore('deviceConfigs').get(deviceId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getDeviceConfigs() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('deviceConfigs', 'readonly');
    const request = tx.objectStore('deviceConfigs').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function markDeviceConfig(config, status, errorMessage = null) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('deviceConfigs', 'readwrite');
    const store = tx.objectStore('deviceConfigs');
    const lookup = store.get(config.deviceId);
    lookup.onsuccess = () => {
      const saved = lookup.result;
      if (!saved) return;
      saved.cloudStatus = status;
      saved.cloudAttempts = (saved.cloudAttempts || 0) + 1;
      saved.cloudError = errorMessage;
      if (status === 'synced') saved.cloudSyncedAt = Date.now();
      store.put(saved);
    };
    lookup.onerror = () => tx.abort();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB device transaction aborted'));
  });
}

function deviceRpcBody(config) {
  return {
    p_device_id: config.deviceId,
    p_latitude: config.latitude,
    p_longitude: config.longitude,
    p_accuracy_m: config.accuracyM,
    p_location_recorded_at: config.locationRecordedAt,
    p_interval_hours: config.intervalHours,
    p_water_offset_mm: config.waterOffsetMm,
    p_climate_enabled: config.climateEnabled,
    p_firmware_version: config.firmwareVersion || 'UNKNOWN',
    p_app_version: config.appVersion || APP_VERSION,
  };
}

async function syncDeviceConfigsToCloud(configs) {
  const cloudConfig = getSupabaseConfig();
  if (!cloudConfig) {
    return { configured: false, synced: 0, pending: configs.length };
  }
  if (!configs.length) return { configured: true, synced: 0, pending: 0 };

  let synced = 0;
  for (let index = 0; index < configs.length; index += 1) {
    const deviceConfig = configs[index];
    try {
      const response = await fetch(
        `${cloudConfig.url}/rest/v1/rpc/${encodeURIComponent(cloudConfig.deviceRpc)}`,
        {
          method: 'POST',
          headers: {
            apikey: cloudConfig.anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(deviceRpcBody(deviceConfig)),
        },
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        throw new Error(`Supabase HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      }
      await markDeviceConfig(deviceConfig, 'synced');
      synced += 1;
    } catch (error) {
      const remaining = configs.slice(index);
      for (const pending of remaining) {
        await markDeviceConfig(pending, 'pending', error.message);
      }
      return { configured: true, synced, pending: remaining.length, error };
    }
  }
  return { configured: true, synced, pending: 0 };
}

async function syncPendingDeviceConfigs() {
  const configs = (await getDeviceConfigs())
    .filter((config) => config.cloudStatus !== 'synced');
  return syncDeviceConfigsToCloud(configs);
}

function cloudRequestBody(records) {
  // JSON.stringify normally removes object keys whose values are undefined.
  // Older local records may lack optional sensor fields; keeping those keys as
  // null ensures every PostgREST batch row has exactly the same shape.
  return JSON.stringify(records.map(toCloudRecord), (_field, value) => (
    value === undefined ? null : value
  ));
}

async function insertCloudRecords(config, records) {
  const response = await fetch(
    `${config.url}/rest/v1/${encodeURIComponent(config.table)}`,
    {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: cloudRequestBody(records),
    },
  );
  const detail = response.ok ? '' : (await response.text()).slice(0, 240);
  return { response, detail };
}

function isDuplicateInsert(response, detail) {
  return response.status === 409 && /23505|duplicate key/i.test(detail);
}

async function syncRecordsToCloud(records) {
  const config = getSupabaseConfig();
  if (!config) {
    setCloudSummary('未設定');
    return { configured: false, synced: 0, inserted: 0, duplicates: 0, pending: records.length };
  }
  if (!records.length) {
    setCloudSummary('已是最新資料');
    return { configured: true, synced: 0, inserted: 0, duplicates: 0, pending: 0 };
  }

  let synced = 0;
  let duplicates = 0;
  try {
    // Normal uploads stay batched. If a retry contains an existing primary
    // key, retry that batch one-by-one so both existing and new records can be
    // marked synced without granting anonymous SELECT access.
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100);
      const batchResult = await insertCloudRecords(config, batch);
      if (batchResult.response.ok) {
        await markCloudRecords(batch, 'synced');
        synced += batch.length;
        continue;
      }

      if (!isDuplicateInsert(batchResult.response, batchResult.detail)) {
        throw new Error(`Supabase HTTP ${batchResult.response.status}${batchResult.detail ? `：${batchResult.detail}` : ''}`);
      }

      for (const record of batch) {
        const singleResult = await insertCloudRecords(config, [record]);
        const duplicate = isDuplicateInsert(singleResult.response, singleResult.detail);
        if (!singleResult.response.ok &&
            !duplicate) {
          throw new Error(`Supabase HTTP ${singleResult.response.status}${singleResult.detail ? `：${singleResult.detail}` : ''}`);
        }
        if (duplicate) duplicates += 1;
        await markCloudRecords([record], 'synced');
        synced += 1;
      }
    }
    await renderRecords();
    const inserted = synced - duplicates;
    setCloudSummary(inserted ? '已同步' : '已是最新資料');
    return { configured: true, synced, inserted, duplicates, pending: 0 };
  } catch (error) {
    const unsynced = records.slice(synced);
    await markCloudRecords(unsynced, 'pending', error.message);
    setCloudSummary(`待重試 ${unsynced.length} 筆`, true,
                    cloudDiagnosticMessage(error.message));
    await renderRecords();
    return {
      configured: true,
      synced,
      inserted: synced - duplicates,
      duplicates,
      pending: unsynced.length,
      error,
    };
  }
}

async function syncPendingCloudRecords() {
  return syncRecordsToCloud(await getPendingCloudRecords());
}

async function syncAllPendingCloudData() {
  const devices = await syncPendingDeviceConfigs();
  const measurements = await syncPendingCloudRecords();
  await renderRecords();
  return { devices, measurements };
}

async function testSupabaseConnection() {
  const config = getSupabaseConfig();
  if (!config) {
    const message = 'Supabase 尚未設定 Project URL 或 publishable key。';
    setCloudSummary('未設定', true, message);
    showStatus(message, true);
    return;
  }

  try {
    // The Auth settings endpoint verifies the project URL, publishable key,
    // HTTPS and CORS without requiring table permission or writing a test row.
    const response = await fetch(
      `${config.url}/auth/v1/settings`,
      {
        method: 'GET',
        headers: { apikey: config.anonKey },
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new Error(`Supabase HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    setCloudSummary('連線正常');
    showStatus(`Supabase 連線測試成功（HTTP ${response.status}）；此按鈕只檢查專案與 API key，不檢查資料表或寫入權限。`);
  } catch (error) {
    const detail = cloudDiagnosticMessage(error.message);
    setCloudSummary('連線失敗', true, detail);
    showStatus('Supabase 連線測試失敗。', true);
  }
}

const CLOUD_CHARTS = [
  {
    canvasId: 'chart-water',
    readoutId: 'chart-water-readout',
    field: 'water_height_cm',
    label: '水位高度／水深',
    unit: 'cm',
    color: '#16745a',
    allowNegative: false,
  },
  {
    canvasId: 'chart-battery',
    readoutId: 'chart-battery-readout',
    field: 'battery_percent',
    label: '電池電量',
    unit: '%',
    color: '#c18a18',
    allowNegative: false,
  },
  {
    canvasId: 'chart-temperature',
    readoutId: 'chart-temperature-readout',
    field: 'temperature_c',
    label: '溫度',
    unit: '°C',
    color: '#b94b3d',
    allowNegative: true,
  },
  {
    canvasId: 'chart-humidity',
    readoutId: 'chart-humidity-readout',
    field: 'humidity_percent',
    label: '相對濕度',
    unit: '%',
    color: '#367aa2',
    allowNegative: false,
  },
];

function setChartStatus(message, bad = false) {
  const target = $('#chart-status');
  target.textContent = message;
  target.className = bad ? 'chart-status error' : 'chart-status';
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function selectedChartPeriod() {
  const range = $('#chart-range').value;
  const parts = $('#chart-date').value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value))) {
    throw new Error('請選擇圖表日期。');
  }
  const [year, month, day] = parts;
  const verified = new Date(year, month - 1, day);
  if (verified.getFullYear() !== year || verified.getMonth() + 1 !== month ||
      verified.getDate() !== day) {
    throw new Error('圖表日期無效。');
  }
  return { range, year, month, day };
}

function chartPeriodText(period) {
  if (period.range === 'year') return `${period.year} 年（每月平均，共 12 點）`;
  if (period.range === 'month') {
    const days = new Date(period.year, period.month, 0).getDate();
    return `${period.year} 年 ${period.month} 月（每日平均，共 ${days} 點）`;
  }
  return `${period.year} 年 ${period.month} 月 ${period.day} 日（每小時平均，共 24 點）`;
}

function updateChartPeriodDescription() {
  try {
    const period = selectedChartPeriod();
    $('#chart-period-description').textContent =
      `${chartPeriodText(period)}；時間分組採 Asia/Taipei。`;
  } catch (_error) {
    $('#chart-period-description').textContent = '請選擇有效日期。';
  }
}

function numericChartValue(row, field) {
  if (row[field] === null || row[field] === undefined || row[field] === '') return null;
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : null;
}

function chartYAxis(rows, definition) {
  const values = rows
    .map((row) => numericChartValue(row, definition.field))
    .filter((value) => value !== null);
  const highest = values.length ? Math.max(...values) : 0;
  const lowest = values.length ? Math.min(...values) : 0;
  const maximum = Math.max(20, Math.ceil(highest / 10) * 10 + 20);
  const minimum = definition.allowNegative && lowest < 0
    ? Math.floor(lowest / 10) * 10
    : 0;
  return { minimum, maximum, hasData: values.length > 0 };
}

function renderCloudChart(definition, rows) {
  const canvas = $(`#${definition.canvasId}`);
  const readout = $(`#${definition.readoutId}`);
  const scroll = canvas.parentElement;
  const pointWidth = rows.length > 24 ? 43 : rows.length > 12 ? 48 : 64;
  const cssWidth = Math.max(scroll.clientWidth || 640, 100 + rows.length * pointWidth);
  const cssHeight = 300;
  const pixelRatio = Math.max(1, Math.min(self.devicePixelRatio || 1, 2));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * pixelRatio);
  canvas.height = Math.round(cssHeight * pixelRatio);

  const context = canvas.getContext('2d');
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const margin = { left: 58, right: 22, top: 20, bottom: 50 };
  const plotWidth = cssWidth - margin.left - margin.right;
  const plotHeight = cssHeight - margin.top - margin.bottom;
  const axis = chartYAxis(rows, definition);
  const ySpan = axis.maximum - axis.minimum;
  const xAt = (index) => margin.left + (rows.length <= 1
    ? plotWidth / 2
    : (index / (rows.length - 1)) * plotWidth);
  const yAt = (value) => margin.top + ((axis.maximum - value) / ySpan) * plotHeight;

  context.font = '12px system-ui, -apple-system, "Noto Sans TC", sans-serif';
  context.lineWidth = 1;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let tick = axis.minimum; tick <= axis.maximum; tick += 10) {
    const y = yAt(tick);
    context.strokeStyle = tick === 0 ? '#9aac9f' : '#e4e9e4';
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(cssWidth - margin.right, y);
    context.stroke();
    context.fillStyle = '#637a72';
    context.fillText(String(tick), margin.left - 9, y);
  }

  context.textAlign = 'center';
  context.textBaseline = 'top';
  rows.forEach((row, index) => {
    const x = xAt(index);
    context.strokeStyle = '#cfd8d1';
    context.beginPath();
    context.moveTo(x, cssHeight - margin.bottom);
    context.lineTo(x, cssHeight - margin.bottom + 5);
    context.stroke();
    context.fillStyle = '#637a72';
    context.fillText(String(row.bucket_label), x, cssHeight - margin.bottom + 9);
  });

  context.strokeStyle = definition.color;
  context.lineWidth = 2.5;
  context.beginPath();
  let previousWasValue = false;
  rows.forEach((row, index) => {
    const value = numericChartValue(row, definition.field);
    if (value === null) {
      previousWasValue = false;
      return;
    }
    const x = xAt(index);
    const y = yAt(value);
    if (previousWasValue) context.lineTo(x, y);
    else context.moveTo(x, y);
    previousWasValue = true;
  });
  context.stroke();

  rows.forEach((row, index) => {
    const value = numericChartValue(row, definition.field);
    if (value === null) return;
    context.fillStyle = '#ffffff';
    context.strokeStyle = definition.color;
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(xAt(index), yAt(value), 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });

  const defaultText = axis.hasData
    ? '移動或點選資料點可查看時段平均值。'
    : `此期間沒有${definition.label}資料。`;
  readout.textContent = defaultText;

  const showPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const ratio = (pointerX - margin.left) / plotWidth;
    const index = Math.max(0, Math.min(rows.length - 1,
      Math.round(ratio * Math.max(0, rows.length - 1))));
    const row = rows[index];
    const value = numericChartValue(row, definition.field);
    const count = Number(row.sample_count || 0);
    readout.textContent = value === null
      ? `${row.bucket_label}：沒有資料（該時段共 ${count} 筆量測）`
      : `${row.bucket_label}：${value.toFixed(2)} ${definition.unit}（${count} 筆平均）`;
  };
  canvas.onpointermove = showPoint;
  canvas.onpointerdown = showPoint;
  canvas.onpointerleave = () => { readout.textContent = defaultText; };
}

function renderCloudCharts() {
  if (!cloudChartState) return;
  CLOUD_CHARTS.forEach((definition) =>
    renderCloudChart(definition, cloudChartState.rows));
}

async function loadCloudCharts() {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase 尚未設定 Project URL 或 publishable key。');
  const deviceId = $('#chart-device-id').value.trim();
  if (!/^[A-Za-z0-9_-]{1,8}$/.test(deviceId)) {
    throw new Error('圖表裝置 ID 必須是 1～8 位英數、- 或 _。');
  }
  const period = selectedChartPeriod();
  setChartStatus('正在直接讀取 Supabase 圖表資料…');

  const response = await fetch(
    `${config.url}/rest/v1/rpc/${encodeURIComponent(config.chartRpc)}`,
    {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_device_id: deviceId,
        p_range_type: period.range,
        p_year: period.year,
        p_month: period.range === 'year' ? null : period.month,
        p_day: period.range === 'day' ? period.day : null,
      }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`Supabase HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('Supabase 圖表回應格式不正確。');

  const expectedPoints = period.range === 'year'
    ? 12
    : period.range === 'month'
      ? new Date(period.year, period.month, 0).getDate()
      : 24;
  if (payload.length !== expectedPoints) {
    throw new Error(`雲端圖表點數不正確（收到 ${payload.length}，預期 ${expectedPoints}）。`);
  }

  cloudChartState = { rows: payload, period, deviceId };
  localStorage.setItem('rice-chart-device-id', deviceId);
  renderCloudCharts();
  const samples = payload.reduce((total, row) => total + Number(row.sample_count || 0), 0);
  setChartStatus(
    `${deviceId}｜${chartPeriodText(period)}｜Supabase 共納入 ${samples} 筆量測。`,
  );
}

async function initializeCloudCharts() {
  $('#chart-date').value = localIsoDate();
  let deviceId = localStorage.getItem('rice-chart-device-id') || '';
  if (!deviceId) {
    const configs = await getDeviceConfigs();
    const latest = [...configs].sort((a, b) =>
      (b.installedAt || 0) - (a.installedAt || 0))[0];
    deviceId = latest?.deviceId || '';
  }
  $('#chart-device-id').value = deviceId;
  updateChartPeriodDescription();
  if (deviceId) await loadCloudCharts();
}

function formatValue(value, divisor, suffix) {
  if (value === -32768 || value === 65535) return '—';
  return `${(value / divisor).toFixed(divisor === 100 ? 2 : 1)} ${suffix}`;
}

function measurementStatus(record) {
  if (record.cloudTestValue) return `雲端測試（${record.cloudTestValue}）`;
  if (!(record.flags & 0x01)) {
    return (record.flags & 0x80) ? '查無尺規' : '相機取像失敗';
  }
  if (!(record.flags & 0x02)) return '查無水面';
  return '正常';
}

function renderPhoneLocation(location, cloudStatus = null) {
  const detail = $('#phone-location');
  const summary = $('#device-location-status');
  if (!location) {
    detail.textContent = '尚未取得；定位只由手機上傳，ESP32 不含 GPS。';
    summary.textContent = '尚未取得';
    return;
  }
  const accuracy = Number.isFinite(location.accuracyM)
    ? `，精度約 ±${Math.round(location.accuracyM)} m`
    : '';
  const recorded = location.locationRecordedAt
    ? new Date(location.locationRecordedAt).toLocaleString()
    : '時間未知';
  detail.textContent = `${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}${accuracy}（${recorded}）`;
  summary.textContent = cloudStatus === 'synced'
    ? '已登錄雲端'
    : cloudStatus === 'pending'
      ? '待上傳'
      : '手機已定位';
}

async function loadDeviceLocation(deviceId) {
  if (!deviceId) return null;
  const saved = await getDeviceConfig(deviceId);
  if (!saved) {
    if (currentLocationDeviceId === deviceId) renderPhoneLocation(currentLocation);
    return null;
  }
  currentLocation = {
    latitude: saved.latitude,
    longitude: saved.longitude,
    accuracyM: saved.accuracyM,
    locationRecordedAt: saved.locationRecordedAt,
  };
  currentLocationDeviceId = deviceId;
  renderPhoneLocation(currentLocation, saved.cloudStatus);
  return saved;
}

function requestPhoneLocation() {
  if (!self.isSecureContext) {
    return Promise.reject(new Error('手機 GPS 定位需要 HTTPS 網頁。'));
  }
  if (!navigator.geolocation) {
    return Promise.reject(new Error('此瀏覽器不支援手機定位功能。'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: Number.isFinite(position.coords.accuracy)
          ? position.coords.accuracy
          : null,
        locationRecordedAt: new Date(position.timestamp || Date.now()).toISOString(),
      }),
      (error) => {
        const messages = {
          1: '手機定位權限遭拒；請在瀏覽器網站設定中允許位置權限。',
          2: '手機目前無法取得定位；請到戶外或開啟系統定位後重試。',
          3: '取得手機定位逾時，請再試一次。',
        };
        reject(new Error(messages[error.code] || `手機定位失敗：${error.message}`));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

async function renderRecords() {
  const [records, deviceConfigs] = await Promise.all([
    getLocalRecords(),
    getDeviceConfigs(),
  ]);
  $('#local-count').textContent = records.length;
  const pendingCloud = records.filter((record) => record.cloudStatus !== 'synced').length;
  const pendingDevices = deviceConfigs.filter((config) => config.cloudStatus !== 'synced').length;
  if (!info && !currentLocation && deviceConfigs.length) {
    const latestDevice = [...deviceConfigs].sort((a, b) =>
      (b.installedAt || 0) - (a.installedAt || 0))[0];
    renderPhoneLocation(latestDevice, latestDevice.cloudStatus);
  }
  if (!getSupabaseConfig()) {
    setCloudSummary('未設定');
  } else {
    const lastCloudError = records.find((record) => record.cloudStatus !== 'synced' && record.cloudError);
    const lastDeviceError = deviceConfigs.find((config) => config.cloudStatus !== 'synced' && config.cloudError);
    const pendingParts = [];
    if (pendingCloud) pendingParts.push(`${pendingCloud} 筆量測`);
    if (pendingDevices) pendingParts.push(`${pendingDevices} 項裝置設定`);
    setCloudSummary(
      pendingParts.length ? `待上傳 ${pendingParts.join('、')}` : '已同步',
      Boolean(lastCloudError || lastDeviceError),
      cloudDiagnosticMessage(lastCloudError?.cloudError || lastDeviceError?.cloudError || '')
    );
  }
  const rows = records.slice(0, 30).map((record) => {
    const time = record.epochUtc ? new Date(record.epochUtc * 1000).toLocaleString() : '時間無效';
    return `<tr><td>${record.sequence}</td><td>${time}</td>` +
      `<td>${formatValue(record.waterDepthMm, 10, 'cm')}</td>` +
      `<td>${formatValue(record.surfaceFromTopMm, 10, 'cm')}</td>` +
      `<td>${formatValue(record.temperatureCentiC, 100, '°C')}</td>` +
      `<td>${formatValue(record.humidityCentiPct, 100, '%')}</td>` +
      `<td>${record.quality}</td>` +
      `<td>${measurementStatus(record)}（0x${record.flags.toString(16).padStart(2, '0')}）</td></tr>`;
  });
  $('#records').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="8">尚無資料</td></tr>';
}

function imageCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1)
        ? ((crc >>> 1) ^ 0xedb88320) >>> 0
        : (crc >>> 1) >>> 0;
    }
  }
  return (~crc) >>> 0;
}

function setCalibrationStatus(message, bad = false) {
  const target = $('#calibration-status');
  target.textContent = message;
  target.classList.toggle('error', bad);
}

function calibrationFlagText(flags) {
  const parts = [];
  parts.push(flags & 0x01 ? '已找到定位圖示' : '未找到定位圖示');
  parts.push(flags & 0x02 ? '已找到水面' : '未找到水面');
  if (flags & 0x04) parts.push('已使用LED補光');
  if (flags & 0x08) parts.push('已使用儲存的裁切範圍');
  if (flags & 0x10) parts.push('裁切失效後改用完整畫面');
  if (flags & 0x20) parts.push('已找到尺規外框');
  return parts.join('、');
}

function drawCalibrationPhoto(photo) {
  const canvas = $('#calibration-image');
  const empty = $('#calibration-empty');
  const metadata = $('#calibration-metadata');
  if (!photo) {
    canvas.hidden = true;
    empty.hidden = false;
    metadata.textContent = '照片只保存在此手機瀏覽器，不會上傳 Supabase。';
    return;
  }

  const pixels = photo.pixels instanceof ArrayBuffer
    ? new Uint8Array(photo.pixels)
    : new Uint8Array(photo.pixels.buffer, photo.pixels.byteOffset,
      photo.pixels.byteLength);
  if (pixels.length !== photo.width * photo.height) {
    throw new Error('已保存的校正照片尺寸不正確');
  }
  canvas.width = photo.width;
  canvas.height = photo.height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(photo.width, photo.height);
  for (let index = 0, target = 0; index < pixels.length; index += 1, target += 4) {
    const value = pixels[index];
    image.data[target] = value;
    image.data[target + 1] = value;
    image.data[target + 2] = value;
    image.data[target + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  canvas.hidden = false;
  empty.hidden = true;
  metadata.textContent = `${photo.deviceId}｜${new Date(photo.capturedAt).toLocaleString()}｜` +
    `${photo.width}×${photo.height}｜品質 ${photo.quality}｜${calibrationFlagText(photo.flags)}`;
}

async function renderCalibrationPhotos(preferredId = '') {
  const photos = await getCalibrationPhotos();
  const select = $('#calibration-photo-select');
  const previousId = preferredId || select.value;
  select.replaceChildren();
  for (const photo of photos) {
    const option = document.createElement('option');
    option.value = photo.id;
    option.textContent = `${new Date(photo.capturedAt).toLocaleString()}｜${photo.deviceId}`;
    select.append(option);
  }
  const selected = photos.find((photo) => photo.id === previousId) || photos[0] || null;
  if (selected) select.value = selected.id;
  select.disabled = photos.length === 0;
  $('#delete-calibration-photo').disabled = photos.length === 0;
  drawCalibrationPhoto(selected);
}

async function finishCalibrationImage(totalChunks, endCrc32) {
  const transfer = calibrationImageTransfer;
  if (!transfer) throw new Error('沒有進行中的校正照片');
  if (!totalChunks || transfer.chunks.size !== totalChunks ||
      transfer.receivedBytes !== transfer.totalBytes) {
    throw new Error(`照片接收不完整（收到 ${transfer.chunks.size} / ${totalChunks} 段）`);
  }
  const pixels = new Uint8Array(transfer.totalBytes);
  let offset = 0;
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunk = transfer.chunks.get(chunkIndex);
    if (!chunk || offset + chunk.length > pixels.length) {
      throw new Error(`照片缺少第 ${chunkIndex} 段`);
    }
    pixels.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== pixels.length) throw new Error('照片組合後的大小不正確');
  transfer.pixels = pixels;
  const actualCrc32 = imageCrc32(transfer.pixels);
  if (actualCrc32 !== transfer.crc32 || actualCrc32 !== endCrc32) {
    throw new Error('照片 CRC32 驗證失敗，請重新拍攝');
  }

  calibrationImageTransfer = null;
  const capturedAt = Date.now();
  const deviceId = info?.id || device?.name || 'UNKNOWN';
  const photo = {
    id: `${deviceId}:${capturedAt}:${transfer.id}`,
    deviceId,
    firmwareVersion: info?.fw || 'UNKNOWN',
    appVersion: APP_VERSION,
    capturedAt,
    transferId: transfer.id,
    width: transfer.width,
    height: transfer.height,
    flags: transfer.flags,
    quality: transfer.quality,
    crc32: transfer.crc32,
    pixels: transfer.pixels.buffer.slice(0),
  };
  await saveCalibrationPhoto(photo);
  await renderCalibrationPhotos(photo.id);
  $('#calibration-progress').value = 1;
  $('#capture-calibration').disabled = !chars.image;
  setCalibrationStatus(`校正照片已保存於手機：${calibrationFlagText(photo.flags)}。`);
  readInfo().catch(() => {});
}

function onImage(event) {
  try {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length < 6 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[3] !== 1) {
      throw new Error('收到不支援的影像封包');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const packetType = bytes[2];
    const transferId = view.getUint16(4, true);

    if (packetType === 0) {
      if (bytes.length !== 20) throw new Error('影像描述封包長度不正確');
      const width = view.getUint16(6, true);
      const height = view.getUint16(8, true);
      const totalBytes = view.getUint32(10, true);
      if (!width || !height || totalBytes !== width * height ||
          totalBytes > MAX_CALIBRATION_IMAGE_BYTES) {
        throw new Error('影像尺寸超出允許範圍');
      }
      calibrationImageTransfer = {
        id: transferId,
        width,
        height,
        totalBytes,
        crc32: view.getUint32(14, true),
        flags: bytes[18],
        quality: bytes[19],
        chunks: new Map(),
        receivedBytes: 0,
      };
      $('#calibration-progress').value = 0;
      setCalibrationStatus(`開始接收 ${width}×${height} 校正照片。`);
      return;
    }

    const transfer = calibrationImageTransfer;
    if (!transfer || transfer.id !== transferId) {
      throw new Error('影像編號不一致');
    }
    if (packetType === 1) {
      if (bytes.length < 10) throw new Error('影像資料封包過短');
      const chunkIndex = view.getUint16(6, true);
      const payloadLength = view.getUint16(8, true);
      if (!payloadLength || payloadLength > transfer.totalBytes ||
          bytes.length !== 10 + payloadLength) {
        throw new Error(`影像分段 ${chunkIndex} 長度不正確`);
      }
      if (!transfer.chunks.has(chunkIndex)) {
        transfer.chunks.set(chunkIndex, bytes.slice(10));
        transfer.receivedBytes += payloadLength;
        if (transfer.receivedBytes > transfer.totalBytes) {
          throw new Error('收到的影像資料超過預期大小');
        }
      }
      $('#calibration-progress').value = transfer.receivedBytes / transfer.totalBytes;
      setCalibrationStatus(
        `接收照片 ${Math.round(transfer.receivedBytes / 1024)} / ` +
        `${Math.round(transfer.totalBytes / 1024)} KB。`
      );
      return;
    }
    if (packetType === 2) {
      if (bytes.length !== 12) throw new Error('影像結束封包長度不正確');
      finishCalibrationImage(view.getUint16(6, true), view.getUint32(8, true))
        .catch((error) => {
          calibrationImageTransfer = null;
          $('#capture-calibration').disabled = !chars.image;
          setCalibrationStatus(error.message, true);
        });
      return;
    }
    throw new Error(`未知的影像封包類型 ${packetType}`);
  } catch (error) {
    calibrationImageTransfer = null;
    $('#capture-calibration').disabled = !chars.image;
    setCalibrationStatus(error.message, true);
  }
}

async function captureCalibrationImage() {
  if (!chars.image) throw new Error('目前韌體不支援校正照片，請更新ESP32-CAM韌體');
  calibrationImageTransfer = null;
  $('#calibration-progress').value = 0;
  $('#capture-calibration').disabled = true;
  setCalibrationStatus(info?.test_mode
    ? '正在傳送「拍照並回傳」測試指令，不會啟動相機…'
    : '正在請求ESP32-CAM拍攝校正照片…');
  try {
    await sendCommand('CAL_IMAGE');
  } catch (error) {
    $('#capture-calibration').disabled = false;
    throw error;
  }
}

async function readInfo() {
  const value = await chars.info.readValue();
  info = JSON.parse(decoder.decode(value));
  $('#device-id').textContent = info.id;
  $('#device-count').textContent = info.records;
  $('#device-time').textContent = info.utc ? new Date(info.utc * 1000).toLocaleString() : '無效';
  $('#firmware-version').textContent = info.fw || '—';
  $('#device-setup-status').textContent = info.provisioned ? '已完成' : '等待設定';
  $('#setting-id').value = info.id;
  if (!$('#chart-device-id').value) $('#chart-device-id').value = info.id;
  $('#setting-interval').value = info.interval_h;
  $('#setting-offset').value = info.offset_mm;
  $('#setting-climate').checked = info.climate;
  $('#capture-calibration').textContent = info.test_mode
    ? '測試拍照指令（不拍照）'
    : '圖片校正（取得照片）';
  $('#calibration-description').textContent = info.test_mode
    ? '目前為 BLE 連線測試模式：按鈕只要求晶片回覆已收到「拍照並回傳」指令，不會啟動相機或保存照片。'
    : '先連接BLE，再取得ESP32-CAM目前用於辨識的灰階照片；暗場或辨識不清時會自動使用LED補光。';
  $('#roi-state').textContent = info.roi_valid
    ? `已學習（x ${info.roi[0]}, y ${info.roi[1]}, w ${info.roi[2]}, h ${info.roi[3]} ‰）`
    : '尚未學習；下次量測會掃描完整畫面';
  await loadDeviceLocation(info.id);
  return info;
}

function setBleTextStatus(message, state = '') {
  const target = $('#ble-test-status');
  target.textContent = message;
  target.className = `ble-test-status${state ? ` ${state}` : ''}`;
}

function appendBleTextLog(direction, message) {
  const log = $('#ble-test-log');
  const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  log.value += `[${timestamp}] ${direction}：${message}\n`;
  log.scrollTop = log.scrollHeight;
}

function resetBleTextReceiveState() {
  bleTextReceiveBuffer = '';
  bleTextStreamDecoder = new TextDecoder('utf-8', { fatal: true });
}

function updateBleTextDisconnectedUi(message = '尚未連接 RiceWL-BLE-Test。', bad = false) {
  bleTextRx = null;
  bleTextTx = null;
  resetBleTextReceiveState();
  $('#ble-test-connect').textContent = '連接測試晶片';
  $('#ble-test-connect').disabled = false;
  $('#ble-test-disconnect').disabled = true;
  $('#ble-test-send').disabled = true;
  setBleTextStatus(message, bad ? 'error' : '');
}

function onBleTextDisconnected() {
  const name = bleTextDevice?.name || BLE_TEXT_TEST.name;
  bleTextDevice = null;
  updateBleTextDisconnectedUi(`已與 ${name} 斷線。`, true);
  appendBleTextLog('系統', `${name} 已斷線`);
}

function onBleTextNotification(event) {
  try {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    bleTextReceiveBuffer += bleTextStreamDecoder.decode(bytes, { stream: true });
    if (bleTextReceiveBuffer.length > 2048) {
      throw new Error('接收緩衝超過限制，已重設');
    }
    let newlineIndex = bleTextReceiveBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const message = bleTextReceiveBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      bleTextReceiveBuffer = bleTextReceiveBuffer.slice(newlineIndex + 1);
      if (message) appendBleTextLog('晶片 → App', message);
      newlineIndex = bleTextReceiveBuffer.indexOf('\n');
    }
  } catch (error) {
    resetBleTextReceiveState();
    setBleTextStatus(`UTF-8 接收錯誤：${error.message}`, 'error');
  }
}

async function connectBleTextTest() {
  if (!hasWebBluetooth()) throw new Error(bluetoothUnavailableMessage());
  if (bleTextDevice?.gatt?.connected && bleTextRx && bleTextTx) {
    setBleTextStatus(`已連接 ${bleTextDevice.name}。`, 'connected');
    return;
  }

  setBleTextStatus('正在選擇 BLE UTF-8 測試晶片…');
  const selectedDevice = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: BLE_TEXT_TEST.name, services: [BLE_TEXT_TEST.service] }],
    optionalServices: [BLE_TEXT_TEST.service],
  });
  bleTextDevice = selectedDevice;
  bleTextDevice.addEventListener('gattserverdisconnected', onBleTextDisconnected, { once: true });

  try {
    setBleTextStatus(`正在連接 ${bleTextDevice.name}…`);
    const server = await bleTextDevice.gatt.connect();
    const service = await server.getPrimaryService(BLE_TEXT_TEST.service);
    // Beacio has shown better compatibility when all characteristics are
    // discovered first, rather than looking them up one UUID at a time.
    const availableCharacteristics = await service.getCharacteristics();
    const byUuid = new Map(availableCharacteristics.map((characteristic) =>
      [characteristic.uuid.toLowerCase(), characteristic]));
    bleTextRx = byUuid.get(BLE_TEXT_TEST.rx) || null;
    bleTextTx = byUuid.get(BLE_TEXT_TEST.tx) || null;
    if (!bleTextRx || !bleTextTx) {
      const found = availableCharacteristics.map((characteristic) => characteristic.uuid)
        .join(', ') || '無';
      throw new Error(`找不到文字收發 Characteristic；晶片回報：${found}`);
    }
    bleTextTx.addEventListener('characteristicvaluechanged', onBleTextNotification);
    await bleTextTx.startNotifications();
    resetBleTextReceiveState();

    // The initial Read is informative only.  Some iOS BLE bridges do not
    // support it on a Notify characteristic, so it must never end a good link.
    try {
      const initialValue = await bleTextTx.readValue();
      if (initialValue.byteLength) {
        const bytes = new Uint8Array(
          initialValue.buffer, initialValue.byteOffset, initialValue.byteLength);
        const initialText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        appendBleTextLog('晶片狀態', initialText);
      }
    } catch (readError) {
      appendBleTextLog('系統', `略過初始讀取：${readError.message}`);
    }

    $('#ble-test-connect').textContent = 'BLE 已連接';
    $('#ble-test-connect').disabled = true;
    $('#ble-test-disconnect').disabled = false;
    $('#ble-test-send').disabled = false;
    setBleTextStatus(`已連接 ${bleTextDevice.name}，可以互傳 UTF-8 文字。`, 'connected');
    appendBleTextLog('系統', `${bleTextDevice.name} 連線成功`);
  } catch (error) {
    if (bleTextDevice?.gatt?.connected) bleTextDevice.gatt.disconnect();
    updateBleTextDisconnectedUi(`連線失敗：${error.message}`, true);
    throw error;
  }
}

function disconnectBleTextTest() {
  if (bleTextDevice?.gatt?.connected) {
    bleTextDevice.gatt.disconnect();
  } else {
    bleTextDevice = null;
    updateBleTextDisconnectedUi();
  }
}

async function writeBleTextChunks(message) {
  if (!bleTextDevice?.gatt?.connected || !bleTextRx) {
    throw new Error('尚未連接 RiceWL-BLE-Test');
  }
  const messageBytes = encoder.encode(message);
  if (!messageBytes.length) throw new Error('請先輸入要傳送的文字');
  if (messageBytes.length > BLE_TEXT_TEST.maxMessageBytes) {
    throw new Error(`訊息為 ${messageBytes.length} bytes，最多只能傳送 ${BLE_TEXT_TEST.maxMessageBytes} bytes`);
  }

  const framed = encoder.encode(`${message}\n`);
  for (let offset = 0; offset < framed.length; offset += BLE_TEXT_TEST.chunkBytes) {
    const chunk = framed.slice(offset, offset + BLE_TEXT_TEST.chunkBytes);
    if (typeof bleTextRx.writeValueWithResponse === 'function') {
      await bleTextRx.writeValueWithResponse(chunk);
    } else {
      await bleTextRx.writeValue(chunk);
    }
    if (offset + BLE_TEXT_TEST.chunkBytes < framed.length) {
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  }
}

async function sendBleTextFromUi() {
  const input = $('#ble-test-message');
  const message = input.value;
  if (!message.trim()) throw new Error('請先輸入要傳送的文字');
  $('#ble-test-send').disabled = true;
  try {
    await writeBleTextChunks(message);
    appendBleTextLog('App → 晶片', message);
    input.value = '';
    setBleTextStatus('文字已送出，等待晶片 ECHO 回覆。', 'connected');
  } finally {
    $('#ble-test-send').disabled = !bleTextDevice?.gatt?.connected;
  }
}

async function guardedBleText(action) {
  try {
    await action();
  } catch (error) {
    setBleTextStatus(error.message, 'error');
  }
}

async function sendCommand(command) {
  if (!chars.command) throw new Error('尚未連線');
  await chars.command.writeValue(encoder.encode(command));
}

async function connect() {
  if (!hasWebBluetooth()) throw new Error(bluetoothUnavailableMessage());
  device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'RiceWL-', services: [UUID.service] }],
    optionalServices: [UUID.service],
  });
  device.addEventListener('gattserverdisconnected', () => {
    $('#connection').textContent = '已斷線';
    chars = {};
    calibrationImageTransfer = null;
    $('#capture-calibration').disabled = true;
    setCalibrationStatus('BLE已斷線；手機中先前保存的校正照片仍會保留。', true);
    showStatus('BLE 已斷線；未送出 ACK 的裝置資料仍會保留。', true);
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UUID.service);
  [chars.command, chars.info, chars.data, chars.event, chars.image] = await Promise.all([
    service.getCharacteristic(UUID.command),
    service.getCharacteristic(UUID.info),
    service.getCharacteristic(UUID.data),
    service.getCharacteristic(UUID.event),
    service.getCharacteristic(UUID.image).catch(() => null),
  ]);
  chars.data.addEventListener('characteristicvaluechanged', onData);
  chars.event.addEventListener('characteristicvaluechanged', onEvent);
  const notificationStarts = [
    chars.data.startNotifications(),
    chars.event.startNotifications(),
  ];
  if (chars.image) {
    chars.image.addEventListener('characteristicvaluechanged', onImage);
    notificationStarts.push(chars.image.startNotifications());
  }
  await Promise.all(notificationStarts);
  await readInfo();
  // With no onboard GPS, every BLE connection refreshes the ESP32 RTC from
  // the phone. Deep sleep keeps this UTC value until power is fully removed.
  await sendCommand(`SET_TIME,${Math.floor(Date.now() / 1000)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await readInfo();
  $('#connection').textContent = `已連接 ${device.name}`;
  $('#capture-calibration').disabled = !chars.image;
  setCalibrationStatus(chars.image
    ? (info?.test_mode
      ? '已連線；目前只測試拍照指令往返，不會實際拍照。'
      : '已連線，可按「圖片校正」取得目前相機畫面。')
    : '目前韌體沒有校正影像通道，請更新ESP32-CAM韌體。', !chars.image);
  showStatus(info?.provisioned
    ? '連線完成，已使用手機 UTC 校正裝置時間。'
    : '連線完成；裝置尚未完成首次設定，因此不會自動拍照或睡眠。');
  // Retry phone-backed records whenever a field worker opens the app; this
  // does not need, and never asks, the ESP32-CAM to use Wi-Fi.
  syncAllPendingCloudData().catch(() => setCloudSummary('待重試', true));
}

function onData(event) {
  try {
    const record = parseRecord(event.target.value);
    incoming.push(record);
    $('#progress').value = expectedDownload ? incoming.length / expectedDownload : 0;
    showStatus(`接收 ${incoming.length} / ${expectedDownload} 筆`);
  } catch (error) {
    showStatus(`資料封包錯誤：${error.message}；本次不會 ACK。`, true);
    expectedDownload = -1;
  }
}

async function finishDownload(lastSequence) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (expectedDownload < 0 || incoming.length !== expectedDownload ||
      lastSequence !== downloadLastSequence) {
    showStatus(`下載不完整（收到 ${incoming.length} / ${expectedDownload}），不刪裝置資料。`, true);
    return;
  }
  await saveRecords(incoming);
  // Local IndexedDB is the first durable destination.  Cloud delivery is then
  // attempted immediately, but a temporary network failure must not prevent
  // the already backed-up phone data from being acknowledged to the device.
  await syncPendingDeviceConfigs();
  const cloud = await syncRecordsToCloud(incoming);
  await sendCommand(`ACK,${lastSequence}`);
  await renderRecords();
  const cloudText = !cloud.configured
    ? '雲端尚未設定，資料已留在手機等待日後設定。'
    : cloud.pending
      ? `雲端暫未完成；${cloud.pending} 筆已保留於手機並會重試。`
      : `已同步 ${cloud.synced} 筆至雲端，手機備份已保留。`;
  showStatus(`已保存 ${incoming.length} 筆至手機並送出裝置 ACK；${cloudText}`,
             Boolean(cloud.pending));
}

function onEvent(event) {
  const message = decoder.decode(event.target.value);
  if (message === 'TEST,CAL_IMAGE') {
    calibrationImageTransfer = null;
    $('#calibration-progress').value = 0;
    $('#capture-calibration').disabled = !chars.image;
    setCalibrationStatus('晶片已收到「拍照並回傳」指令；BLE 指令往返正常，目前未實際拍照。');
  } else if (message === 'TEST,MEASURE') {
    showStatus('晶片已收到「立即量測並保存」指令；BLE 指令往返正常，目前未實際拍照或新增紀錄。');
  } else if (message === 'ERR,SETUP_REQUIRED') {
    showStatus('裝置尚未完成首次設定，不會執行量測或進入睡眠。', true);
  } else if (message === 'IMG_WAIT') {
    setCalibrationStatus('ESP32-CAM正在拍攝與分析，暗場時會自動使用LED補光。');
  } else if (message.startsWith('IMG_READY,')) {
    setCalibrationStatus(`照片 ${message.split(',')[1]} 已拍攝，準備接收。`);
  } else if (message.startsWith('IMG_DONE,')) {
    // The image characteristic carries the verified end packet. Persistence is
    // completed there; this event only confirms that the camera buffer closed.
  } else if (message.startsWith('ERR,IMG_')) {
    calibrationImageTransfer = null;
    $('#capture-calibration').disabled = !chars.image;
    setCalibrationStatus(
      message === 'ERR,IMG_CAMERA'
        ? '相機初始化或拍照失敗，請檢查鏡頭排線後重試。'
        : '影像傳輸忙碌中，請等待目前照片完成。',
      true
    );
  } else if (message.startsWith('DL,')) {
    const [, count, last] = message.split(',');
    expectedDownload = Number(count);
    downloadLastSequence = Number(last);
    incoming = [];
    $('#progress').value = 0;
    showStatus(`裝置準備傳送 ${expectedDownload} 筆。`);
  } else if (message.startsWith('DL_DONE,')) {
    finishDownload(Number(message.split(',')[1])).catch((error) => showStatus(error.message, true));
  } else if (message.startsWith('ACK_OK,')) {
    showStatus(`完成：裝置已移除 ${message.split(',')[1]} 筆已保存資料。`);
    readInfo().catch(() => {});
  } else {
    showStatus(`裝置：${message}`);
    if (message.startsWith('OK,') || message.startsWith('M,')) {
      setTimeout(() => readInfo().catch(() => {}), 150);
    }
  }
}

async function guarded(action) {
  try { await action(); } catch (error) { showStatus(error.message, true); }
}

$('#connect').addEventListener('click', () => guarded(connect));
$('#ble-test-connect').addEventListener('click', () => guardedBleText(connectBleTextTest));
$('#ble-test-disconnect').addEventListener('click', disconnectBleTextTest);
$('#ble-test-send').addEventListener('click', () => guardedBleText(sendBleTextFromUi));
$('#ble-test-clear').addEventListener('click', () => {
  $('#ble-test-log').value = '';
  setBleTextStatus(bleTextDevice?.gatt?.connected
    ? `已連接 ${bleTextDevice.name}，可以互傳 UTF-8 文字。`
    : `尚未連接 ${BLE_TEXT_TEST.name}。`,
  bleTextDevice?.gatt?.connected ? 'connected' : '');
});
$('#ble-test-message').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  guardedBleText(sendBleTextFromUi);
});
$('#capture-calibration').addEventListener('click', () => guarded(captureCalibrationImage));
$('#calibration-photo-select').addEventListener('change', (event) =>
  guarded(() => renderCalibrationPhotos(event.target.value)));
$('#delete-calibration-photo').addEventListener('click', () => guarded(async () => {
  const selectedId = $('#calibration-photo-select').value;
  if (!selectedId) return;
  if (!confirm('刪除這張保存在手機中的校正照片？此操作無法復原。')) return;
  await deleteCalibrationPhoto(selectedId);
  await renderCalibrationPhotos();
  setCalibrationStatus('已刪除選取的校正照片。');
}));
$('#load-cloud-charts').addEventListener('click', () => guarded(loadCloudCharts));
$('#chart-range').addEventListener('change', updateChartPeriodDescription);
$('#chart-date').addEventListener('change', updateChartPeriodDescription);
$('#refresh').addEventListener('click', () => guarded(async () => { await sendCommand('GET_INFO'); await new Promise((r) => setTimeout(r, 150)); await readInfo(); }));
$('#get-location').addEventListener('click', () => guarded(async () => {
  showStatus('正在取得手機 GPS 定位…');
  currentLocation = await requestPhoneLocation();
  currentLocationDeviceId = null;
  renderPhoneLocation(currentLocation);
  showStatus('已取得手機定位；確認裝置 ID 後請按「寫入設定並登錄位置」。');
}));
$('#save-settings').addEventListener('click', () => guarded(async () => {
  const id = $('#setting-id').value.trim();
  const interval = Number($('#setting-interval').value);
  const offset = Number($('#setting-offset').value);
  if (!/^[A-Za-z0-9_-]{1,8}$/.test(id)) throw new Error('ID 必須是 1～8 位英數、- 或 _');
  if (!Number.isInteger(interval) || interval < 1 || interval > 24 ||
      !Number.isInteger(offset) || offset < -500 || offset > 500) {
    throw new Error('設定值超出範圍');
  }

  let location = currentLocation;
  if (!location || (currentLocationDeviceId && currentLocationDeviceId !== id)) {
    location = null;
    const saved = await getDeviceConfig(id);
    if (saved) {
      location = {
        latitude: saved.latitude,
        longitude: saved.longitude,
        accuracyM: saved.accuracyM,
        locationRecordedAt: saved.locationRecordedAt,
      };
    }
  }
  if (!location) {
    throw new Error('首次安裝請先按「取得手機 GPS 定位」，再寫入設定。');
  }

  const climateEnabled = $('#setting-climate').checked;
  for (const command of [
    `SET_ID,${id}`,
    `SET_INTERVAL,${interval}`,
    `SET_OFFSET,${offset}`,
    `SET_CLIMATE,${climateEnabled ? 1 : 0}`,
    `SET_TIME,${Math.floor(Date.now() / 1000)}`,
    'COMPLETE_SETUP',
  ]) {
    await sendCommand(command);
    await new Promise((r) => setTimeout(r, 100));
  }

  await readInfo();

  const deviceConfig = {
    deviceId: id,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyM: location.accuracyM,
    locationRecordedAt: location.locationRecordedAt,
    intervalHours: interval,
    waterOffsetMm: offset,
    climateEnabled,
    firmwareVersion: info?.fw || 'UNKNOWN',
    appVersion: APP_VERSION,
    installedAt: Date.now(),
  };
  await saveDeviceConfig(deviceConfig);
  currentLocation = location;
  currentLocationDeviceId = id;
  const cloud = await syncDeviceConfigsToCloud([deviceConfig]);
  await renderRecords();
  await loadDeviceLocation(id);
  if (!cloud.configured) {
    showStatus('設定已寫入裝置，GPS 位置已保存在手機；Supabase 尚未設定，之後會自動重試。', true);
  } else if (cloud.pending) {
    showStatus('設定已寫入裝置，GPS 位置已保存在手機；雲端登錄暫未完成，之後會自動重試。', true);
  } else {
    showStatus('設定與手機 GPS 位置已登錄 Supabase；裝置名稱會在下次 BLE 啟動更新。');
  }
}));
$('#sync-time').addEventListener('click', () => guarded(() => sendCommand(`SET_TIME,${Math.floor(Date.now() / 1000)}`)));
$('#clear-roi').addEventListener('click', () => guarded(async () => {
  if (!confirm('清除目前尺規裁切範圍？下次量測會重新掃描完整畫面並學習外框。')) return;
  await sendCommand('CLEAR_ROI');
  showStatus('已要求清除尺規位置；下次量測會重新定位。');
}));
$('#measure').addEventListener('click', () => guarded(() => sendCommand('MEASURE')));
$('#download').addEventListener('click', () => guarded(async () => { incoming = []; expectedDownload = 0; await sendCommand('DOWNLOAD'); }));
$('#sleep').addEventListener('click', () => guarded(() => sendCommand('SLEEP')));
$('#test-cloud-connection').addEventListener('click', () => guarded(testSupabaseConnection));
$('#test-cloud').addEventListener('click', () => guarded(async () => {
  const testRecord = createCloudTestRecord();
  await saveRecords([testRecord]);
  const result = await syncRecordsToCloud([testRecord]);
  if (!result.configured) {
    showStatus(`測試參數 ${testRecord.cloudTestValue} 已保留於手機；Supabase 尚未設定。`, true);
  } else if (result.pending) {
    showStatus(`測試參數 ${testRecord.cloudTestValue} 尚未上傳，已保留於手機等待重試。`, true);
  } else {
    showStatus(`測試參數 ${testRecord.cloudTestValue} 已成功上傳 Supabase。`);
  }
}));
$('#sync-cloud').addEventListener('click', () => guarded(async () => {
  const { devices, measurements: result } = await syncAllPendingCloudData();
  if (!result.configured || !devices.configured) {
    showStatus('尚未填入 Supabase 網址與 anon key；資料仍保留在手機。', true);
  } else if (result.pending || devices.pending) {
    const parts = [];
    if (result.pending) parts.push(`${result.pending} 筆量測`);
    if (devices.pending) parts.push(`${devices.pending} 項裝置設定`);
    showStatus(`雲端同步未完成，${parts.join('、')}仍保留在手機等待重試。`, true);
  } else if (devices.synced && !result.inserted) {
    showStatus(`裝置位置與基本設定已同步（${devices.synced} 項）；量測已經是最新資料了。手機備份未刪除。`);
  } else if (!result.inserted) {
    showStatus('已經是最新資料了。手機備份未刪除。');
  } else if (result.duplicates) {
    showStatus(`雲端同步完成：新增 ${result.inserted} 筆，${result.duplicates} 筆已經是最新資料。手機備份未刪除。`);
  } else {
    showStatus(`雲端同步完成（新增 ${result.inserted} 筆）。手機備份未刪除。`);
  }
}));
$('#export').addEventListener('click', () => guarded(async () => {
  const records = (await getLocalRecords()).reverse();
  if (!records.length) throw new Error('手機內沒有資料');
  const header = 'device_id,firmware_version,app_version,sequence,utc,surface_from_top_mm,water_depth_mm,temperature_centi_c,humidity_centi_pct,quality,flags,measurement_status\n';
  const body = records.map((r) => [r.deviceId, r.firmwareVersion || '', r.appVersion || '', r.sequence, r.epochUtc, r.surfaceFromTopMm, r.waterDepthMm, r.temperatureCentiC, r.humidityCentiPct, r.quality, r.flags, measurementStatus(r)].join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([header + body], { type: 'text/csv;charset=utf-8' }));
  link.download = `rice-water-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}));
$('#clear-local').addEventListener('click', () => guarded(async () => {
  const pending = await getPendingCloudRecords();
  if (pending.length && !confirm(`有 ${pending.length} 筆尚未同步雲端。確定仍要清除手機備份？`)) return;
  if (!confirm('只清除手機瀏覽器內已保存的資料？此操作無法復原。')) return;
  await clearLocalRecords();
  await renderRecords();
  showStatus('手機本機資料已清除。');
}));

document.querySelectorAll('[data-app-version]').forEach((element) => {
  element.textContent = APP_VERSION;
});
updateBleRuntime();
// Beacio may announce that its Safari extension is ready just after page load.
// The ESP32-CAM GATT connection itself continues to use standard Web Bluetooth.
window.addEventListener('beacio:ready', updateBleRuntime);
window.addEventListener('beacio:extension:ready', updateBleRuntime);
window.addEventListener('resize', () => {
  if (!cloudChartState) return;
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(renderCloudCharts, 120);
});
Promise.all([renderRecords(), renderCalibrationPhotos()])
  .then(() => syncAllPendingCloudData())
  .catch((error) => showStatus(error.message, true));
initializeCloudCharts().catch((error) => {
  setChartStatus(cloudDiagnosticMessage(error.message) || error.message, true);
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
    .then((registration) => {
      const checkForUpdate = () => registration.update().catch(() => {});
      checkForUpdate();
      window.setInterval(checkForUpdate, 30 * 60 * 1000);
    })
    .catch(() => {});
}

registerServiceWorker();
