/*
==================================================
APPLICATION BACKEND ENGINE
Developer   : Muhamad Badru Wasih
Official    : Aplikasikita.id
Copyright   : © Aplikasikita.id
Contact     : 082258041628
Security    : Server-Side Encrypted Link & Vault
dilarang keras menampilkan link/URL mentah (baik di Code.gs maupun index.html), dan seluruh link sensitif diamankan menggunakan mekanisme Server-Side Encrypted Vault & Token Resolver.
==================================================
*/

const APP_NAME = "SMART ATTENDANCE";
const SCRIPT_PROP = PropertiesService.getScriptProperties();

function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Sistem Absensi Sekolah')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

const SECURE_VAULT = {
  "ACT_OFFICIAL_WEB": "aHR0cHM6Ly9hcGxpa2FzaWtpdGEuaWQ=", // Base64 encoded for basic obfuscation in script, actual resolution is server-side
  "ACT_SUPPORT_WA": "aHR0cHM6Ly93YS5tZS82MjgyMjU4MDQxNjI4",
  "ACT_JOIN_GROUP": "aHR0cHM6Ly9jaGF0LndoYXRzYXBwLmNvbS9MZU96WEF4VjFMb0JsaUt5b0JscU5x"
};

function resolveSecureAction(actionId) {
  try {
    if (SECURE_VAULT[actionId]) {
      // Decode the URL server-side before returning
      const decodedUrl = Utilities.newBlob(Utilities.base64Decode(SECURE_VAULT[actionId])).getDataAsString();
      return { success: true, url: decodedUrl };
    }
    return { success: false, message: "Action not found" };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

function getDb() {
  let dbId = SCRIPT_PROP.getProperty('DB_ID');
  if (!dbId) {
    let ss = SpreadsheetApp.create('DB_SMART_ATTENDANCE');
    dbId = ss.getId();
    SCRIPT_PROP.setProperty('DB_ID', dbId);
  }
  return SpreadsheetApp.openById(dbId);
}

function setupDatabase() {
  const ss = getDb();
  const sheetsInfo = [
    { name: 'USERS', headers: ['ID', 'USERNAME', 'PASSWORD', 'NAMA', 'ROLE', 'STATUS', 'CREATED_AT'] },
    { name: 'SISWA', headers: ['ID_SISWA', 'NIS', 'NISN', 'NAMA', 'JK', 'KELAS', 'JURUSAN', 'TAHUN_MASUK', 'NO_WA', 'ALAMAT', 'NAMA_ORTU', 'WA_ORTU', 'FOTO', 'QR_ID', 'BARCODE_ID', 'FACE_DATA', 'STATUS'] },
    { name: 'GURU', headers: ['ID_GURU', 'NIP', 'NAMA', 'NO_WA', 'WALI_KELAS', 'STATUS'] },
    { name: 'KELAS', headers: ['ID_KELAS', 'NAMA_KELAS', 'JURUSAN'] },
    { name: 'ABSENSI', headers: ['ID_ABSENSI', 'TIMESTAMP', 'TANGGAL', 'JAM', 'ID_SISWA', 'NIS', 'NAMA', 'KELAS', 'STATUS', 'METODE', 'DEVICE', 'PETUGAS'] },
    { name: 'SETTING', headers: ['KEY', 'VALUE', 'UPDATED_AT'] },
    { name: 'LOG', headers: ['TIMESTAMP', 'USER', 'ROLE', 'AKTIVITAS', 'DATA', 'STATUS'] }
  ];

  sheetsInfo.forEach(info => {
    let sheet = ss.getSheetByName(info.name);
    if (!sheet) {
      sheet = ss.insertSheet(info.name);
      sheet.appendRow(info.headers);
      sheet.getRange(1, 1, 1, info.headers.length).setFontWeight('bold').setBackground('#e2e8f0');
    }
  });

  // Setup Default Super Admin if empty
  let userSheet = ss.getSheetByName('USERS');
  if (userSheet.getLastRow() <= 1) {
    userSheet.appendRow(['USR-001', 'admin', 'admin123', 'Super Administrator', 'SUPER ADMIN', 'AKTIF', new Date().toISOString()]);
  }

  // Setup Default Settings
  let setSheet = ss.getSheetByName('SETTING');
  if (setSheet.getLastRow() <= 1) {
    const defaults = [
      ['NAMA_SEKOLAH', 'SMK BISA SMART'],
      ['JAM_MASUK', '07:00'],
      ['BATAS_TELAT', '07:15'],
      ['MODE_PULANG', 'OFF']
    ];
    defaults.forEach(d => setSheet.appendRow([d[0], d[1], new Date().toISOString()]));
  }
  
  return { success: true, message: "Database siap digunakan." };
}

function loginUser(username, password) {
  const lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    const sheet = getDb().getSheetByName('USERS');
    if(!sheet) return {success:false, message:"Sistem belum di-setup."};
    
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] == username && data[i][2] == password && data[i][5] == 'AKTIF') {
        logActivity(username, data[i][4], 'LOGIN', 'Berhasil masuk ke sistem', 'SUCCESS');
        return { 
          success: true, 
          token: generateId('TOK'),
          user: { id: data[i][0], username: data[i][1], name: data[i][3], role: data[i][4] } 
        };
      }
    }
    logActivity(username, 'GUEST', 'LOGIN FAILED', 'Percobaan login gagal', 'FAILED');
    return { success: false, message: "Username atau Password salah!" };
  } finally {
    lock.releaseLock();
  }
}

function getSiswaData() {
  const sheet = getDb().getSheetByName('SISWA');
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const result = data.map(row => {
    let obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return { success: true, data: result };
}

function saveSiswa(payload) {
  const lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    const sheet = getDb().getSheetByName('SISWA');
    const qrId = 'QR-' + payload.nis + '-' + new Date().getTime();
    const barcodeId = 'BC-' + payload.nis;
    
    if (payload.action === 'add') {
      const newId = generateId('SSW');
      sheet.appendRow([
        newId, payload.nis, payload.nisn, payload.nama, payload.jk, payload.kelas, 
        payload.jurusan, payload.tahun_masuk, payload.no_wa, payload.alamat, 
        payload.nama_ortu, payload.wa_ortu, payload.foto || '', qrId, barcodeId, '', 'AKTIF'
      ]);
      return { success: true, message: "Data siswa berhasil ditambah." };
    } 
    // Handle Edit/Delete logic here based on ID
  } catch (err) {
    return { success: false, message: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

function processAttendance(identifier, method, currentUser, device) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const db = getDb();
    const sheetSiswa = db.getSheetByName('SISWA');
    const sheetAbsen = db.getSheetByName('ABSENSI');
    const sheetSetting = db.getSheetByName('SETTING');
    
    // 1. Find Siswa
    const dataSiswa = sheetSiswa.getDataRange().getValues();
    let siswa = null;
    for(let i=1; i<dataSiswa.length; i++) {
      if(dataSiswa[i][13] == identifier || dataSiswa[i][14] == identifier || dataSiswa[i][1] == identifier) {
        siswa = {
          id: dataSiswa[i][0], nis: dataSiswa[i][1], nama: dataSiswa[i][3], 
          kelas: dataSiswa[i][5], foto: dataSiswa[i][12], status: dataSiswa[i][16]
        };
        break;
      }
    }
    
    if(!siswa) return { success: false, message: "Siswa tidak terdaftar di database." };
    if(siswa.status !== 'AKTIF') return { success: false, message: "Status siswa tidak aktif." };

    // 2. Check Duplicates for Today
    const now = new Date();
    const todayStr = Utilities.formatDate(now, "Asia/Jakarta", "dd-MM-yyyy");
    const jamStr = Utilities.formatDate(now, "Asia/Jakarta", "HH:mm:ss");
    
    const dataAbsen = sheetAbsen.getDataRange().getValues();
    for(let i=1; i<dataAbsen.length; i++) {
      if(dataAbsen[i][2] == todayStr && dataAbsen[i][4] == siswa.id) {
        return { 
          success: false, 
          isDuplicate: true,
          siswa: siswa,
          message: "Siswa sudah absen hari ini." 
        };
      }
    }

    // 3. Determine Status (Hadir/Terlambat)
    let statusAbsen = "HADIR";
    const jamMasuk = getSettingValue(sheetSetting, 'BATAS_TELAT') || "07:15"; // Default telat after 7:15
    const currentHourMin = Utilities.formatDate(now, "Asia/Jakarta", "HH:mm");
    
    if (currentHourMin > jamMasuk) {
      statusAbsen = "TERLAMBAT";
    }

    // 4. Save to Database
    const absenId = generateId('ABS');
    sheetAbsen.appendRow([
      absenId, now.toISOString(), todayStr, jamStr, siswa.id, siswa.nis, 
      siswa.nama, siswa.kelas, statusAbsen, method, device, currentUser.name || 'System'
    ]);
    
    logActivity(currentUser.username, currentUser.role, 'ABSENSI', `${siswa.nama} via ${method}`, 'SUCCESS');

    return {
      success: true,
      siswa: siswa,
      absen: {
        tanggal: todayStr,
        jam: jamStr,
        status: statusAbsen,
        metode: method
      }
    };

  } catch (err) {
    return { success: false, message: "System Error: " + err.toString() };
  } finally {
    lock.releaseLock();
  }
}

function getDashboardStats() {
  const db = getDb();
  const siswaSheet = db.getSheetByName('SISWA');
  const absenSheet = db.getSheetByName('ABSENSI');
  
  const totalSiswa = siswaSheet.getLastRow() > 1 ? siswaSheet.getLastRow() - 1 : 0;
  
  const todayStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd-MM-yyyy");
  const dataAbsen = absenSheet.getLastRow() > 1 ? absenSheet.getDataRange().getValues() : [];
  
  let stats = { total: totalSiswa, hadir: 0, terlambat: 0, izin: 0, sakit: 0, absenData: [] };
  
  for(let i=1; i<dataAbsen.length; i++) {
    if(dataAbsen[i][2] == todayStr) {
      const status = dataAbsen[i][8];
      if(status == 'HADIR') stats.hadir++;
      else if(status == 'TERLAMBAT') stats.terlambat++;
      else if(status == 'IZIN') stats.izin++;
      else if(status == 'SAKIT') stats.sakit++;
      
      // Collect last 10 records for table
      stats.absenData.push({
        waktu: dataAbsen[i][3], nama: dataAbsen[i][6], 
        kelas: dataAbsen[i][7], status: status, metode: dataAbsen[i][9]
      });
    }
  }
  stats.belum = totalSiswa - (stats.hadir + stats.terlambat + stats.izin + stats.sakit);
  stats.absenData = stats.absenData.reverse().slice(0, 10); // get latest
  
  return { success: true, data: stats };
}

function generateId(prefix) {
  return prefix + '-' + new Date().getTime() + Math.floor(Math.random() * 100);
}

function getSettingValue(sheet, key) {
  const data = sheet.getDataRange().getValues();
  for(let i=1; i<data.length; i++) {
    if(data[i][0] == key) return data[i][1];
  }
  return null;
}

function logActivity(user, role, activity, data, status) {
  try {
    const sheet = getDb().getSheetByName('LOG');
    sheet.appendRow([
      Utilities.formatDate(new Date(), "Asia/Jakarta", "dd-MM-yyyy HH:mm:ss"),
      user, role, activity, data, status
    ]);
  } catch(e) {} // Silent fail for logs
}
