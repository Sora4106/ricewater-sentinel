const UUID = {
  service: '7f510000-4b7e-4ca4-9f6b-6b2752494345',
  command: '7f510001-4b7e-4ca4-9f6b-6b2752494345',
  info: '7f510002-4b7e-4ca4-9f6b-6b2752494345',
  data: '7f510003-4b7e-4ca4-9f6b-6b2752494345',
  event: '7f510004-4b7e-4ca4-9f6b-6b2752494345',
};

const APP_VERSION = self.RICE_APP_VERSION;

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

function getSupabaseConfig() {
  const raw = self.RICE_SUPABASE_CONFIG || {};
  const url = String(raw.url || '').trim().replace(/\/+$/, '');
  const anonKey = String(raw.anonKey || '').trim();
  const table = String(raw.table || 'rice_measurements').trim();
  if (!url || !anonKey) return null;
  if (!/^https:\/\//.test(url) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return null;
  return { url, anonKey, table };
}

function setCloudSummary(message, bad = false) {
  const target = $('#cloud-status');
  if (!target) return;
  target.textContent = message;
  target.style.color = bad ? '#a63d31' : '';
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
    const request = indexedDB.open('rice-water-monitor', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains('records')
        ? request.transaction.objectStore('records')
        : db.createObjectStore('records', { keyPath: ['deviceId', 'sequence'] });
      if (!store.indexNames.contains('device')) store.createIndex('device', 'deviceId');
      if (!store.indexNames.contains('cloudStatus')) {
        store.createIndex('cloudStatus', 'cloudStatus');
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

async function syncRecordsToCloud(records) {
  const config = getSupabaseConfig();
  if (!config) {
    setCloudSummary('未設定');
    return { configured: false, synced: 0, pending: records.length };
  }
  if (!records.length) {
    setCloudSummary('已同步');
    return { configured: true, synced: 0, pending: 0 };
  }

  let synced = 0;
  try {
    // Keep batches modest for intermittent field-network connections.  The
    // composite primary key and ignore-duplicates preference make retries safe.
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100);
      const response = await fetch(
        `${config.url}/rest/v1/${encodeURIComponent(config.table)}?on_conflict=device_id,sequence`,
        {
          method: 'POST',
          headers: {
            apikey: config.anonKey,
            Authorization: `Bearer ${config.anonKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify(batch.map(toCloudRecord)),
        },
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        throw new Error(`Supabase HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      }
      await markCloudRecords(batch, 'synced');
      synced += batch.length;
    }
    setCloudSummary('已同步');
    await renderRecords();
    return { configured: true, synced, pending: 0 };
  } catch (error) {
    const unsynced = records.slice(synced);
    await markCloudRecords(unsynced, 'pending', error.message);
    setCloudSummary(`待重試 ${unsynced.length} 筆`, true);
    await renderRecords();
    return { configured: true, synced, pending: unsynced.length, error };
  }
}

async function syncPendingCloudRecords() {
  return syncRecordsToCloud(await getPendingCloudRecords());
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

async function renderRecords() {
  const records = await getLocalRecords();
  $('#local-count').textContent = records.length;
  const pendingCloud = records.filter((record) => record.cloudStatus !== 'synced').length;
  if (!getSupabaseConfig()) {
    setCloudSummary('未設定');
  } else {
    const lastCloudError = records.find((record) => record.cloudStatus !== 'synced' && record.cloudError);
    setCloudSummary(pendingCloud ? `待上傳 ${pendingCloud} 筆` : '已同步', Boolean(lastCloudError));
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

async function readInfo() {
  const value = await chars.info.readValue();
  info = JSON.parse(decoder.decode(value));
  $('#device-id').textContent = info.id;
  $('#device-count').textContent = info.records;
  $('#device-time').textContent = info.utc ? new Date(info.utc * 1000).toLocaleString() : '無效';
  $('#firmware-version').textContent = info.fw || '—';
  $('#setting-id').value = info.id;
  $('#setting-interval').value = info.interval_h;
  $('#setting-gps').value = info.gps_days;
  $('#setting-offset').value = info.offset_mm;
  $('#setting-climate').checked = info.climate;
  $('#roi-state').textContent = info.roi_valid
    ? `已學習（x ${info.roi[0]}, y ${info.roi[1]}, w ${info.roi[2]}, h ${info.roi[3]} ‰）`
    : '尚未學習；下次量測會掃描完整畫面';
  return info;
}

async function sendCommand(command) {
  if (!chars.command) throw new Error('尚未連線');
  await chars.command.writeValue(encoder.encode(command));
}

async function connect() {
  if (!navigator.bluetooth) throw new Error('此瀏覽器不支援 Web Bluetooth；請使用 Android Chrome 並以 HTTPS 開啟');
  device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'RiceWL-' }],
    optionalServices: [UUID.service],
  });
  device.addEventListener('gattserverdisconnected', () => {
    $('#connection').textContent = '已斷線';
    chars = {};
    showStatus('BLE 已斷線；未送出 ACK 的裝置資料仍會保留。', true);
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UUID.service);
  [chars.command, chars.info, chars.data, chars.event] = await Promise.all([
    service.getCharacteristic(UUID.command),
    service.getCharacteristic(UUID.info),
    service.getCharacteristic(UUID.data),
    service.getCharacteristic(UUID.event),
  ]);
  chars.data.addEventListener('characteristicvaluechanged', onData);
  chars.event.addEventListener('characteristicvaluechanged', onEvent);
  await Promise.all([chars.data.startNotifications(), chars.event.startNotifications()]);
  await readInfo();
  $('#connection').textContent = `已連接 ${device.name}`;
  showStatus('連線完成。');
  // Retry phone-backed records whenever a field worker opens the app; this
  // does not need, and never asks, the ESP32-CAM to use Wi-Fi.
  syncPendingCloudRecords().catch((error) => setCloudSummary('待重試', true));
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
  if (message.startsWith('DL,')) {
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
$('#refresh').addEventListener('click', () => guarded(async () => { await sendCommand('GET_INFO'); await new Promise((r) => setTimeout(r, 150)); await readInfo(); }));
$('#save-settings').addEventListener('click', () => guarded(async () => {
  const id = $('#setting-id').value.trim();
  const interval = Number($('#setting-interval').value);
  const gpsDays = Number($('#setting-gps').value);
  const offset = Number($('#setting-offset').value);
  if (!/^[A-Za-z0-9_-]{1,8}$/.test(id)) throw new Error('ID 必須是 1～8 位英數、- 或 _');
  if (interval < 1 || interval > 24 || gpsDays < 1 || gpsDays > 7 || offset < -500 || offset > 500) throw new Error('設定值超出範圍');
  for (const command of [`SET_ID,${id}`, `SET_INTERVAL,${interval}`, `SET_GPS_DAYS,${gpsDays}`, `SET_OFFSET,${offset}`, `SET_CLIMATE,${$('#setting-climate').checked ? 1 : 0}`]) {
    await sendCommand(command);
    await new Promise((r) => setTimeout(r, 100));
  }
  showStatus('設定已送出；裝置名稱會在下次 BLE 啟動更新。');
}));
$('#sync-time').addEventListener('click', () => guarded(() => sendCommand(`SET_TIME,${Math.floor(Date.now() / 1000)}`)));
$('#gps-sync').addEventListener('click', () => guarded(() => sendCommand('GPS_SYNC')));
$('#clear-roi').addEventListener('click', () => guarded(async () => {
  if (!confirm('清除目前尺規裁切範圍？下次量測會重新掃描完整畫面並學習外框。')) return;
  await sendCommand('CLEAR_ROI');
  showStatus('已要求清除尺規位置；下次量測會重新定位。');
}));
$('#measure').addEventListener('click', () => guarded(() => sendCommand('MEASURE')));
$('#download').addEventListener('click', () => guarded(async () => { incoming = []; expectedDownload = 0; await sendCommand('DOWNLOAD'); }));
$('#sleep').addEventListener('click', () => guarded(() => sendCommand('SLEEP')));
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
  const result = await syncPendingCloudRecords();
  if (!result.configured) {
    showStatus('尚未填入 Supabase 網址與 anon key；資料仍保留在手機。', true);
  } else if (result.pending) {
    showStatus(`雲端同步未完成，${result.pending} 筆仍保留在手機等待重試。`, true);
  } else {
    showStatus(`雲端同步完成（${result.synced} 筆）。手機備份未刪除。`);
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

$('#app-version').textContent = APP_VERSION;
renderRecords().catch((error) => showStatus(error.message, true));

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
