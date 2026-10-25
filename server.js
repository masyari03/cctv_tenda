/**
 * Tenda CH9 CCTV Server - Express Backend
 * Implements Security Protocol, Granular RBAC, Video Streaming, PTZ 360, and Storage Watchdog
 */
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const net = require('net');

const TendaCCTVRecorder = require('./recorder');
const StorageWatchdog = require('./watchdog');
const TendaPTZController = require('./ptz');

const app = express();
const PORT = parseInt(process.env.PORT || '3080', 10);
let STORAGE_DIR = process.env.STORAGE_DIR || '/home/arif/storage/CCTV_RUMAH';
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// Ensure directories exist
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// Initialize Core Subsystems
const recorder = new TendaCCTVRecorder({ storageDir: STORAGE_DIR });
const watchdog = new StorageWatchdog({ storageDir: STORAGE_DIR });
const ptz = new TendaPTZController();

// In-Memory Sessions & Rate Limiter Store
const sessions = new Map(); // token -> { user, expiresAt }
const loginAttempts = new Map(); // ip -> { count, resetAt }

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// User Database Helpers
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[DB] Error loading users:', e.message);
  }
  return [];
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[DB] Error saving users:', e.message);
    return false;
  }
}

// Authentication Middleware
function authMiddleware(req, res, next) {
  const token = req.cookies['cctv_session'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Sesi tidak valid atau telah berakhir. Silakan login kembali.' });
  }

  const session = sessions.get(token);
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesi telah kedaluwarsa. Silakan login kembali.' });
  }

  // Reload user state to ensure real-time permission enforcement
  const users = loadUsers();
  const currentUser = users.find(u => u.id === session.user.id);
  if (!currentUser) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Pengguna tidak ditemukan.' });
  }

  // Check account expiration date
  if (currentUser.expiresAt && new Date(currentUser.expiresAt).getTime() < Date.now()) {
    return res.status(403).json({ error: 'Akses akun Anda telah melewati masa berlaku.' });
  }

  req.user = currentUser;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak. Fitur ini hanya untuk Super Administrator.' });
  }
  next();
}

function checkPermission(permKey) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || (req.user.permissions && req.user.permissions[permKey] === true)) {
      return next();
    }
    return res.status(403).json({ error: `Akses dibatasi. Anda tidak memiliki izin [${permKey}]. Hubungi admin.` });
  };
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  // Rate Limiting: Max 5 failed attempts per minute
  let attempt = loginAttempts.get(ip);
  if (attempt && now < attempt.resetAt && attempt.count >= 5) {
    const waitSec = Math.ceil((attempt.resetAt - now) / 1000);
    return res.status(429).json({ error: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${waitSec} detik.` });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  const users = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    if (!attempt || now >= attempt.resetAt) {
      loginAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    } else {
      attempt.count += 1;
    }
    return res.status(401).json({ error: 'Username atau password salah.' });
  }

  // Account expiration check
  if (user.expiresAt && new Date(user.expiresAt).getTime() < now) {
    return res.status(403).json({ error: 'Masa aktif akun ini telah berakhir.' });
  }

  // Reset rate limiter on success
  loginAttempts.delete(ip);

  // Generate secure session token
  const token = require('crypto').randomBytes(32).toString('hex');
  const sessionDuration = 24 * 60 * 60 * 1000; // 24 hours
  sessions.set(token, {
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt: now + sessionDuration
  });

  res.cookie('cctv_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: sessionDuration,
    secure: process.env.NODE_ENV === 'production' && req.secure
  });

  return res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: user.permissions
    }
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies['cctv_session'];
  if (token) sessions.delete(token);
  res.clearCookie('cctv_session');
  res.json({ success: true, message: 'Berhasil logout' });
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      name: req.user.name,
      role: req.user.role,
      permissions: req.user.permissions
    }
  });
});

// ==========================================
// USER MANAGEMENT ROUTES (ADMIN ONLY)
// ==========================================

// GET /api/users
app.get('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const users = loadUsers().map(u => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    permissions: u.permissions,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt
  }));
  res.json({ users });
});

// POST /api/users
app.post('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const { username, name, password, role, permissions, expiresAt } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  const users = loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Username sudah digunakan.' });
  }

  const newUser = {
    id: 'usr_' + Date.now().toString(36),
    username: username.trim(),
    name: name ? name.trim() : username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'user',
    permissions: {
      can_view_live: permissions?.can_view_live !== false,
      can_control_ptz: permissions?.can_control_ptz === true,
      can_view_playback: permissions?.can_view_playback === true,
      can_download_clips: permissions?.can_download_clips === true,
      can_hear_audio: permissions?.can_hear_audio === true,
      can_manage_users: role === 'admin'
    },
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null
  };

  users.push(newUser);
  saveUsers(users);

  res.json({ success: true, user: { id: newUser.id, username: newUser.username } });
});

// PUT /api/users/:id
app.put('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, password, permissions, expiresAt } = req.body;

  const users = loadUsers();
  const index = users.findIndex(u => u.id === id);
  if (index === -1) return res.status(404).json({ error: 'User tidak ditemukan.' });

  if (name) users[index].name = name.trim();
  if (password && password.trim().length >= 4) {
    users[index].passwordHash = bcrypt.hashSync(password.trim(), 10);
  }
  if (permissions) {
    users[index].permissions = { ...users[index].permissions, ...permissions };
  }
  if (expiresAt !== undefined) {
    users[index].expiresAt = expiresAt || null;
  }

  saveUsers(users);
  res.json({ success: true, message: 'Izin akses user berhasil diperbarui.' });
});

// DELETE /api/users/:id
app.delete('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (req.user.id === id) {
    return res.status(400).json({ error: 'Anda tidak dapat menghapus akun admin Anda sendiri.' });
  }

  let users = loadUsers();
  users = users.filter(u => u.id !== id);
  saveUsers(users);
  res.json({ success: true, message: 'User berhasil dihapus.' });
});

// ==========================================
// PTZ 360 STEERING ROUTES
// ==========================================

// POST /api/ptz/move
app.post('/api/ptz/move', authMiddleware, checkPermission('can_control_ptz'), async (req, res) => {
  const { direction, speed } = req.body;
  if (!direction) return res.status(400).json({ error: 'Direction is required' });

  const result = await ptz.continuousMove(direction, speed || 0.6);
  res.json(result);
});

// POST /api/ptz/stop
app.post('/api/ptz/stop', authMiddleware, checkPermission('can_control_ptz'), async (req, res) => {
  const result = await ptz.stop();
  res.json(result);
});

// ==========================================
// LIVE VIEW STREAM & SNAPSHOT
// ==========================================

// GET /api/live/snapshot/:camera
app.get('/api/live/snapshot/:camera', authMiddleware, checkPermission('can_view_live'), async (req, res) => {
  const camKey = req.params.camera; // 'cam1' or 'cam2'
  if (!recorder.cameras[camKey]) {
    return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  }

  const buffer = await recorder.getSnapshot(camKey);
  if (!buffer) {
    // Return transparent 1x1 placeholder if offline
    return res.status(503).json({ error: 'Kamera sedang offline atau menghubungkan ulang' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(buffer);
});

// ==========================================
// REKA ULANG & PLAYBACK ROUTES (WITH HOUR FILTER)
// ==========================================

// Helper to find folder path for camera
function getCameraFolders(cameraKey) {
  const isCam2 = cameraKey === 'cam2';
  const primaryName = isCam2 ? 'Lensa_2_Fixed' : 'Lensa_1_PTZ';
  const legacyName = isCam2 ? 'Camera_2_Fixed' : 'Camera_1_PTZ';

  const folders = [];
  const p1 = path.join(STORAGE_DIR, primaryName);
  const p2 = path.join(STORAGE_DIR, legacyName);
  if (fs.existsSync(p1)) folders.push(p1);
  if (fs.existsSync(p2) && p2 !== p1) folders.push(p2);
  return folders;
}

// GET /api/recordings
app.get('/api/recordings', authMiddleware, checkPermission('can_view_playback'), async (req, res) => {
  const cameraKey = req.query.camera === 'cam2' ? 'cam2' : 'cam1';
  const targetDate = req.query.date; // YYYY-MM-DD
  const targetHour = req.query.hour; // '00' to '23' or empty for all
  const folders = getCameraFolders(cameraKey);

  try {
    let files = [];
    for (const folder of folders) {
      if (!fs.existsSync(folder)) continue;
      const entries = await fs.promises.readdir(folder);

      for (const file of entries) {
        if (!file.toLowerCase().endsWith('.mp4')) continue;
        if (targetDate && !file.startsWith(targetDate)) continue;

        // Filter by hour if specified (format: YYYY-MM-DD_HH-MM-SS.mp4)
        const fileHour = file.length >= 13 ? file.slice(11, 13) : '';
        if (targetHour !== undefined && targetHour !== '') {
          const hourList = targetHour.split(',').map(h => h.trim());
          if (hourList.length > 0 && !hourList.includes(fileHour)) {
            continue;
          }
        }

        const fullPath = path.join(folder, file);
        const stat = await fs.promises.stat(fullPath);

        files.push({
          filename: file,
          folder: path.basename(folder),
          sizeBytes: stat.size,
          sizeFormatted: stat.size > 1024 * 1024 ? (stat.size / (1024 * 1024)).toFixed(1) + ' MB' : (stat.size / 1024).toFixed(0) + ' KB',
          date: file.slice(0, 10),
          time: file.slice(11, 19).replace(/-/g, ':'),
          hour: fileHour,
          timestamp: stat.mtimeMs
        });
      }
    }

    // Sort newest first
    files.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ files, count: files.length, targetDate, targetHour: targetHour || 'all' });
  } catch (err) {
    console.error('[Recordings] Error listing files:', err.message);
    res.status(500).json({ error: 'Gagal membaca riwayat rekaman' });
  }
});

// GET /api/recordings/stream/:camera/:filename
// HTTP 206 Partial Content video range stream
app.get('/api/recordings/stream/:camera/:filename', authMiddleware, checkPermission('can_view_playback'), (req, res) => {
  const cameraKey = req.params.camera === 'cam2' ? 'cam2' : 'cam1';
  const safeFilename = path.basename(req.params.filename);
  const folders = getCameraFolders(cameraKey);

  let filePath = null;
  for (const f of folders) {
    const candidate = path.join(f, safeFilename);
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File video rekaman tidak ditemukan' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/recordings/download/:camera/:filename
app.get('/api/recordings/download/:camera/:filename', authMiddleware, checkPermission('can_download_clips'), (req, res) => {
  const cameraKey = req.params.camera === 'cam2' ? 'cam2' : 'cam1';
  const safeFilename = path.basename(req.params.filename);
  const folders = getCameraFolders(cameraKey);

  let filePath = null;
  for (const f of folders) {
    const candidate = path.join(f, safeFilename);
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }

  res.download(filePath, safeFilename);
});

// ==========================================
// NIGHT MODE & AI ILLUMINATION CONTROL (PER LENSA)
// ==========================================

// POST /api/camera/night-mode
app.post('/api/camera/night-mode', authMiddleware, requireAdmin, async (req, res) => {
  const { lens, mode } = req.body;
  if (!lens || !mode) {
    return res.status(400).json({ error: 'Lensa (cam1/cam2) dan mode wajib dipilih.' });
  }

  const result = await ptz.setNightMode(lens, mode);
  res.json(result);
});

// GET /api/camera/night-mode
app.get('/api/camera/night-mode', authMiddleware, (req, res) => {
  res.json({ success: true, modes: ptz.getNightModes() });
});

// ==========================================
// STORAGE SETTINGS CONTROLLER (DYNAMIC GB QUOTA)
// ==========================================

// POST /api/settings/update-storage
app.post('/api/settings/update-storage', authMiddleware, requireAdmin, (req, res) => {
  const { quotaGB, storageDir, segmentMinutes } = req.body;
  const newQuota = parseInt(quotaGB, 10);
  if (isNaN(newQuota) || newQuota < 1) {
    return res.status(400).json({ error: 'Kapasitas kuota GB harus berupa angka minimal 1 GB' });
  }

  const newDir = storageDir ? storageDir.trim() : STORAGE_DIR;
  const newSeg = segmentMinutes ? parseInt(segmentMinutes, 10) : 1;

  watchdog.updateQuota(newQuota, newDir);
  recorder.updateStorageSettings({ storageDir: newDir, segmentMinutes: newSeg });

  // Persist to .env
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/STORAGE_LIMIT_GB=.*/, `STORAGE_LIMIT_GB=${newQuota}`);
      if (storageDir) envContent = envContent.replace(/STORAGE_DIR=.*/, `STORAGE_DIR=${newDir}`);
      if (segmentMinutes) envContent = envContent.replace(/SEGMENT_MINUTES=.*/, `SEGMENT_MINUTES=${newSeg}`);
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log(`[Config] .env storage updated: Quota=${newQuota}GB, Dir=${newDir}, Segment=${newSeg}m`);
    }
  } catch (e) {
    console.error('[Config] Failed to persist .env storage:', e.message);
  }

  res.json({
    success: true,
    message: `Kapasitas kuota berhasil diubah menjadi ${newQuota} GB (Penyimpanan: ${newDir})`
  });
});


// ==========================================
// SYSTEM & STORAGE MONITOR
// ==========================================

// GET /api/system/status
app.get('/api/system/status', authMiddleware, async (req, res) => {
  const watchdogStatus = await watchdog.inspectAndPurge();
  const recorderStatus = recorder.getStatus();

  res.json({
    recorder: recorderStatus,
    storage: {
      storageDir: STORAGE_DIR,
      usedGB: (watchdogStatus.usedBytes / (1024 ** 3)).toFixed(2),
      quotaGB: (watchdogStatus.quotaBytes / (1024 ** 3)).toFixed(0),
      freeDiskGB: (watchdogStatus.freeDiskBytes / (1024 ** 3)).toFixed(2),
      percentage: ((watchdogStatus.usedBytes / watchdogStatus.quotaBytes) * 100).toFixed(1),
      totalFiles: watchdogStatus.totalFiles,
      lastPurged: watchdogStatus.lastPurgedFile,
      segmentMinutes: recorder.segmentTimeSeconds / 60
    },
    cameraSettings: {
      ip: ptz.ip,
      port: ptz.port,
      username: ptz.username
    },
    nightModes: ptz.getNightModes()
  });

});

// POST /api/settings/update-camera
app.post('/api/settings/update-camera', authMiddleware, requireAdmin, (req, res) => {
  const { ip, port, username, password } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP Kamera wajib diisi' });

  ptz.updateConfig({ ip, port, username, password });
  recorder.updateCameraCredentials({ ip, port, username, password });
  recorder.startAll(); // restart streams with new credentials

  // Persist into .env file
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/TENDA_IP=.*/, `TENDA_IP=${ip}`);
      if (username) envContent = envContent.replace(/TENDA_USER=.*/, `TENDA_USER=${username}`);
      if (password !== undefined) envContent = envContent.replace(/TENDA_PASS=.*/, `TENDA_PASS=${password}`);
      const auth = (username && password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
      envContent = envContent.replace(/CH1_RTSP_MAIN=.*/, `CH1_RTSP_MAIN=rtsp://${auth}${ip}:554/ch=1&subtype=0`);
      envContent = envContent.replace(/CH1_RTSP_SUB=.*/, `CH1_RTSP_SUB=rtsp://${auth}${ip}:554/ch=1&subtype=1`);
      envContent = envContent.replace(/CH2_RTSP_MAIN=.*/, `CH2_RTSP_MAIN=rtsp://${auth}${ip}:554/ch=2&subtype=0`);
      envContent = envContent.replace(/CH2_RTSP_SUB=.*/, `CH2_RTSP_SUB=rtsp://${auth}${ip}:554/ch=2&subtype=1`);
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[Config] .env updated with new camera credentials');
    }
  } catch (err) {
    console.error('[Config] Failed to persist .env:', err.message);
  }

  res.json({ success: true, message: `Kamera berhasil dihubungkan ke IP ${ip}` });
});


// GET /api/settings/scan-lan
// Fast ARP / Port 554 scanner on local subnet
app.get('/api/settings/scan-lan', authMiddleware, requireAdmin, async (req, res) => {
  const subnet = '192.168.1.';
  const candidates = [];

  const checkPort = (ip, port, timeout = 700) => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, ip);
    });
  };

  const promises = [];
  // Scan common IP ranges
  for (let i = 2; i <= 254; i++) {
    const targetIp = `${subnet}${i}`;
    promises.push(
      checkPort(targetIp, 554).then(open => {
        if (open) candidates.push({ ip: targetIp, port: 554, desc: 'RTSP Video Port Open' });
      })
    );
  }

  await Promise.all(promises);
  res.json({ subnet: subnet + '*', foundDevices: candidates });
});

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server & Subsystems
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=======================================================`);
  console.log(`🚀 TENDA CH9 CCTV SERVER RUNNING ON http://localhost:${PORT}`);
  console.log(`📁 Storage: ${STORAGE_DIR} (Quota: ${process.env.STORAGE_LIMIT_GB || 50} GB)`);
  console.log(`=======================================================`);

  // Auto-provision Channel 2 (Fixed lens) in camera firmware via RPC2
  try {
    await ptz.ensureDualLensEnabled();
  } catch (err) {
    console.warn('[Server] Note: ensureDualLensEnabled warning:', err.message);
  }

  // Start background watchdog & recorder
  watchdog.startScheduler(300000); // every 5 mins
  recorder.startAll();
});

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Gracefully shutting down...');
  recorder.stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  recorder.stopAll();
  process.exit(0);
});
