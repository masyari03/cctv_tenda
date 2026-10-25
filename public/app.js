/**
 * Tenda CH9 CCTV Client Controller
 * Handles Auth, Dual-Feed Live Polling, PTZ 360 Keyboard & D-Pad, Playback Scrubber, and User Management
 */

// Global State
let currentUser = null;
let activeTab = 'tabLive';
let livePollingInterval = null;
let currentPlayingClip = null;
let isPtzMoving = false;

// DOM Elements
const loginOverlay = document.getElementById('loginOverlay');
const appWrapper = document.getElementById('appWrapper');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const userRole = document.getElementById('userRole');
const btnLogout = document.getElementById('btnLogout');

// Live Elements
const feedCam1 = document.getElementById('feedCam1');
const feedCam2 = document.getElementById('feedCam2');
const overlayCam1 = document.getElementById('overlayCam1');
const overlayCam2 = document.getElementById('overlayCam2');
const ptzContainer = document.getElementById('ptzContainer');
const ptzLockNotice = document.getElementById('ptzLockNotice');

// Playback Elements
const playbackCameraSelect = document.getElementById('playbackCameraSelect');
const playbackDateInput = document.getElementById('playbackDateInput');
const playbackHourSelect = document.getElementById('playbackHourSelect');
const clipsCountBadge = document.getElementById('clipsCountBadge');
const btnFetchRecordings = document.getElementById('btnFetchRecordings');
const clipsList = document.getElementById('clipsList');
const playbackVideo = document.getElementById('playbackVideo');
const currentPlayingTitle = document.getElementById('currentPlayingTitle');
const currentPlayingSub = document.getElementById('currentPlayingSub');
const downloadContainer = document.getElementById('downloadContainer');
const btnDownloadClip = document.getElementById('btnDownloadClip');

// Dual Player & Fast Nav Controls
const singlePlayerBox = document.getElementById('singlePlayerBox');
const dualPlayerBox = document.getElementById('dualPlayerBox');
const dualVideoCam1 = document.getElementById('dualVideoCam1');
const dualVideoCam2 = document.getElementById('dualVideoCam2');
const dualOverlayCam1 = document.getElementById('dualOverlayCam1');
const dualOverlayCam2 = document.getElementById('dualOverlayCam2');

const syncTimeline = document.getElementById('syncTimeline');
const timeCurrent = document.getElementById('timeCurrent');
const timeDuration = document.getElementById('timeDuration');

const btnPrevClip = document.getElementById('btnPrevClip');
const btnNextClip = document.getElementById('btnNextClip');
const btnRewind10 = document.getElementById('btnRewind10');
const btnRewind5 = document.getElementById('btnRewind5');
const btnPlayPause = document.getElementById('btnPlayPause');
const btnForward5 = document.getElementById('btnForward5');
const btnForward10 = document.getElementById('btnForward10');

let currentClips = [];
let currentClipIndex = -1;
let currentPlaybackMode = 'both';

// Settings & Storage Elements
const storageText = document.getElementById('storageText');
const storageFill = document.getElementById('storageFill');
const freeDiskText = document.getElementById('freeDiskText');
const totalFilesText = document.getElementById('totalFilesText');
const storageSettingsForm = document.getElementById('storageSettingsForm');
const settingQuotaGB = document.getElementById('settingQuotaGB');
const settingSegmentMinutes = document.getElementById('settingSegmentMinutes');
const settingStorageDir = document.getElementById('settingStorageDir');
const settingIp = document.getElementById('settingIp');
const settingRtspPort = document.getElementById('settingRtspPort');
const settingOnvifPort = document.getElementById('settingOnvifPort');
const settingUsername = document.getElementById('settingUsername');
const settingPassword = document.getElementById('settingPassword');
const cameraSettingsForm = document.getElementById('cameraSettingsForm');
const btnScanLan = document.getElementById('btnScanLan');
const scanResultBox = document.getElementById('scanResultBox');
const scanResultList = document.getElementById('scanResultList');

// User Modal Elements
const navUsers = document.getElementById('navUsers');
const navPlayback = document.getElementById('navPlayback');
const navSettings = document.getElementById('navSettings');
const usersTableBody = document.getElementById('usersTableBody');
const userModal = document.getElementById('userModal');
const btnOpenAddUser = document.getElementById('btnOpenAddUser');
const btnCancelUserModal = document.getElementById('btnCancelUserModal');
const userForm = document.getElementById('userForm');

// Helper for local timezone date (e.g. YYYY-MM-DD in WIB / local browser)
function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Initialize Today's Date and Hour Options
playbackDateInput.value = getLocalDateString();
if (playbackHourSelect) {
  for (let i = 0; i < 24; i++) {
    const hh = String(i).padStart(2, '0');
    const opt = document.createElement('option');
    opt.value = hh;
    opt.textContent = `Jam ${hh}:00 - ${hh}:59`;
    playbackHourSelect.appendChild(opt);
  }
}

// ==========================================
// AUTHENTICATION & SESSION
// ==========================================

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      onLoginSuccess(data.user);
    } else {
      showLogin();
    }
  } catch (e) {
    showLogin();
  }
}

function showLogin() {
  stopLivePolling();
  loginOverlay.classList.add('active');
  appWrapper.style.display = 'none';
}

function onLoginSuccess(user) {
  currentUser = user;
  loginOverlay.classList.remove('active');
  appWrapper.style.display = 'flex';

  userName.textContent = user.name || user.username;
  userRole.textContent = user.role.toUpperCase();
  userAvatar.textContent = (user.name || user.username).charAt(0).toUpperCase();

  // Apply RBAC UI Rules
  const isAdmin = user.role === 'admin';
  const perms = user.permissions || {};

  navUsers.style.display = isAdmin ? 'flex' : 'none';
  navSettings.style.display = isAdmin ? 'flex' : 'none';

  if (!isAdmin && !perms.can_view_playback) {
    navPlayback.style.display = 'none';
  } else {
    navPlayback.style.display = 'flex';
  }

  // PTZ Permissions
  if (!isAdmin && !perms.can_control_ptz) {
    ptzLockNotice.style.display = 'block';
    document.querySelectorAll('.dpad-btn').forEach(btn => btn.style.pointerEvents = 'none');
  } else {
    ptzLockNotice.style.display = 'none';
    document.querySelectorAll('.dpad-btn').forEach(btn => btn.style.pointerEvents = 'auto');
  }

  switchTab('tabLive');
  fetchSystemStatus();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.style.display = 'none';

  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      loginForm.reset();
      onLoginSuccess(data.user);
    } else {
      loginError.textContent = data.error || 'Login gagal';
      loginError.style.display = 'block';
    }
  } catch (err) {
    loginError.textContent = 'Koneksi ke server gagal';
    loginError.style.display = 'block';
  }
});

btnLogout.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  currentUser = null;
  showLogin();
});

// ==========================================
// NAVIGATION & TABS
// ==========================================

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-tab');
    if (target) switchTab(target);
  });
});

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === tabId);
  });

  if (tabId === 'tabLive') {
    startLivePolling();
  } else {
    stopLivePolling();
  }

  if (tabId === 'tabPlayback') {
    fetchRecordings();
  }

  if (tabId === 'tabUsers' && currentUser?.role === 'admin') {
    fetchUsersList();
  }

  if (tabId === 'tabSettings' && currentUser?.role === 'admin') {
    fetchSystemStatus();
  }
}

// ==========================================
// LIVE VIEW & STREAM POLLING
// ==========================================

function updateFeedFrame(camKey, imgElem, overlayElem) {
  const nextImg = new Image();
  const url = `/api/live/snapshot/${camKey}?t=${Date.now()}`;

  nextImg.onload = () => {
    imgElem.src = url;
    overlayElem.style.display = 'none';
  };
  nextImg.onerror = () => {
    // Do not blank out if a frame is already displayed
    if (!imgElem.src || imgElem.naturalWidth === 0) {
      overlayElem.style.display = 'flex';
    }
  };
  nextImg.src = url;
}


async function checkCameraStatus() {
  try {
    const res = await fetch('/api/system/status');
    if (!res.ok) return;
    const data = await res.json();
    const c1 = data.recorder?.cam1;
    const c2 = data.recorder?.cam2;

    const overlay1Text = overlayCam1.querySelector('span:last-child');
    const overlay2Text = overlayCam2.querySelector('span:last-child');

    const authErrorMsg = '⚠️ <strong>Password Kamera Salah (401 Unauthorized)</strong><br><span style="font-size:0.8rem;color:#cbd5e1;margin-top:4px;display:inline-block;">1. Buka tab web kamera <a href="https://192.168.1.8" target="_blank" style="color:#38bdf8;text-decoration:underline;">https://192.168.1.8</a> lalu matikan toggle <strong>RTSP Authentication</strong> dan klik Save.<br>2. ATAU klik tab <strong>⚙️ Pengaturan & Storage</strong> di atas dan masukkan password kamera Anda.</span>';

    if (c1?.lastError && (c1.lastError.includes('401') || c1.lastError.includes('Unauthorized'))) {
      if (overlay1Text) overlay1Text.innerHTML = authErrorMsg;
    } else if (c1?.status === 'recording') {
      if (overlay1Text) overlay1Text.textContent = 'Menghubungkan ke Lensa 1...';
    }

    if (c2?.lastError && (c2.lastError.includes('401') || c2.lastError.includes('Unauthorized'))) {
      if (overlay2Text) overlay2Text.innerHTML = authErrorMsg;
    } else if (c2?.status === 'recording') {
      if (overlay2Text) overlay2Text.textContent = 'Menghubungkan ke Lensa 2...';
    }
  } catch (e) {}
}

function startLivePolling() {
  stopLivePolling();
  checkCameraStatus();
  updateFeedFrame('cam1', feedCam1, overlayCam1);
  updateFeedFrame('cam2', feedCam2, overlayCam2);

  // Poll a new snapshot frame every 900ms for smooth live perception
  livePollingInterval = setInterval(() => {
    if (activeTab === 'tabLive') {
      updateFeedFrame('cam1', feedCam1, overlayCam1);
      updateFeedFrame('cam2', feedCam2, overlayCam2);
    }
  }, 900);

  // Periodic status check every 5 seconds
  checkCameraStatus();
}

function stopLivePolling() {
  if (livePollingInterval) {
    clearInterval(livePollingInterval);
    livePollingInterval = null;
  }
}


// ==========================================
// PTZ 360 STEERING CONTROLS
// ==========================================

async function sendPtzMove(direction) {
  if (isPtzMoving) return;
  isPtzMoving = true;
  try {
    await fetch('/api/ptz/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, speed: 0.6 })
    });
  } catch (e) {}
}

async function sendPtzStop() {
  isPtzMoving = false;
  try {
    await fetch('/api/ptz/stop', { method: 'POST' });
  } catch (e) {}
}

function bindPtzButton(btnId, direction) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  btn.addEventListener('mousedown', (e) => { e.preventDefault(); sendPtzMove(direction); });
  btn.addEventListener('mouseup', (e) => { e.preventDefault(); sendPtzStop(); });
  btn.addEventListener('mouseleave', () => { if (isPtzMoving) sendPtzStop(); });

  btn.addEventListener('touchstart', (e) => { e.preventDefault(); sendPtzMove(direction); }, { passive: false });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); sendPtzStop(); }, { passive: false });
}

bindPtzButton('btnPtzUp', 'up');
bindPtzButton('btnPtzDown', 'down');
bindPtzButton('btnPtzLeft', 'left');
bindPtzButton('btnPtzRight', 'right');
document.getElementById('btnPtzStop').addEventListener('click', sendPtzStop);

// Keyboard Arrow Steering
window.addEventListener('keydown', (e) => {
  if (activeTab !== 'tabLive' || !currentUser) return;
  if (currentUser.role !== 'admin' && !currentUser.permissions?.can_control_ptz) return;

  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); sendPtzMove('up'); break;
    case 'ArrowDown': e.preventDefault(); sendPtzMove('down'); break;
    case 'ArrowLeft': e.preventDefault(); sendPtzMove('left'); break;
    case 'ArrowRight': e.preventDefault(); sendPtzMove('right'); break;
  }
});

window.addEventListener('keyup', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    sendPtzStop();
  }
});

// ==========================================
// REKA ULANG & PLAYBACK
// ==========================================

let activeHourFilter = '';

// Quick Hour Range Pills
document.querySelectorAll('.hour-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.hour-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    const range = pill.getAttribute('data-range');
    if (range === 'pagi') {
      activeHourFilter = '06,07,08,09,10,11';
      if (playbackHourSelect) playbackHourSelect.value = '';
    } else if (range === 'siang') {
      activeHourFilter = '12,13,14,15,16,17';
      if (playbackHourSelect) playbackHourSelect.value = '';
    } else if (range === 'malam') {
      activeHourFilter = '18,19,20,21,22,23';
      if (playbackHourSelect) playbackHourSelect.value = '';
    } else if (range === 'dini') {
      activeHourFilter = '00,01,02,03,04,05';
      if (playbackHourSelect) playbackHourSelect.value = '';
    } else {
      activeHourFilter = '';
      if (playbackHourSelect) playbackHourSelect.value = '';
    }
    fetchRecordings();
  });
});

if (playbackHourSelect) {
  playbackHourSelect.addEventListener('change', () => {
    activeHourFilter = playbackHourSelect.value;
    document.querySelectorAll('.hour-pill').forEach(p => {
      p.classList.toggle('active', !activeHourFilter && p.getAttribute('data-hour') === '');
    });
    fetchRecordings();
  });
}

btnFetchRecordings.addEventListener('click', fetchRecordings);

function getActiveVideos() {
  if (currentPlaybackMode === 'both') {
    const list = [];
    if (dualVideoCam1 && dualVideoCam1.src && dualVideoCam1.style.display !== 'none') list.push(dualVideoCam1);
    if (dualVideoCam2 && dualVideoCam2.src && dualVideoCam2.style.display !== 'none') list.push(dualVideoCam2);
    return list;
  }
  return playbackVideo && playbackVideo.src ? [playbackVideo] : [];
}

function updatePlayPauseBtnUI(playing) {
  if (!btnPlayPause) return;
  btnPlayPause.textContent = playing ? '⏸️ Pause' : '▶️ Play';
  btnPlayPause.classList.toggle('playing', playing);
}

function formatPlayTime(sec) {
  if (isNaN(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function seekRelative(seconds) {
  const vids = getActiveVideos();
  if (vids.length === 0) return;

  vids.forEach(v => {
    try {
      const dur = v.duration || 60;
      v.currentTime = Math.max(0, Math.min(dur, v.currentTime + seconds));
    } catch (e) {}
  });

  const master = vids[0];
  if (master && syncTimeline) {
    syncTimeline.value = master.currentTime;
    timeCurrent.textContent = formatPlayTime(master.currentTime);
  }
}

function togglePlayPause() {
  const vids = getActiveVideos();
  if (vids.length === 0) return;
  const isPaused = vids[0].paused;

  vids.forEach(v => {
    if (isPaused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  });
  updatePlayPauseBtnUI(isPaused);
}

function selectClipByIndex(idx) {
  if (idx < 0 || idx >= currentClips.length) return;
  currentClipIndex = idx;

  document.querySelectorAll('.clip-item').forEach((item, i) => {
    item.classList.toggle('active', i === idx);
  });

  const clip = currentClips[idx];
  playClip(currentPlaybackMode, clip);
}

function playPrevClip() {
  if (currentClipIndex > 0) {
    selectClipByIndex(currentClipIndex - 1);
  }
}

function playNextClip() {
  if (currentClipIndex < currentClips.length - 1) {
    selectClipByIndex(currentClipIndex + 1);
  }
}

async function fetchRecordings() {
  const camera = playbackCameraSelect.value;
  const date = playbackDateInput.value || getLocalDateString();
  const hourParam = activeHourFilter ? `&hour=${encodeURIComponent(activeHourFilter)}` : '';

  clipsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Memuat arsip rekaman...</div>`;

  try {
    const res = await fetch(`/api/recordings?camera=${camera}&date=${date}${hourParam}`);
    const data = await res.json();

    if (!res.ok) {
      clipsList.innerHTML = `<div style="color: #fb7185; padding: 1rem;">${data.error || 'Gagal mengambil rekaman'}</div>`;
      if (clipsCountBadge) clipsCountBadge.textContent = '0 Klip';
      return;
    }

    currentPlaybackMode = data.mode || (camera === 'both' ? 'both' : 'single');
    currentClips = data.files || [];
    currentClipIndex = -1;

    if (clipsCountBadge) {
      clipsCountBadge.textContent = `${currentClips.length} Klip`;
    }

    if (currentClips.length === 0) {
      clipsList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem; text-align: center;">Tidak ada rekaman untuk tanggal ${date} ${activeHourFilter ? '(filter jam aktif)' : ''}.</div>`;
      return;
    }

    clipsList.innerHTML = '';
    currentClips.forEach((clip, idx) => {
      const item = document.createElement('div');
      item.className = 'clip-item' + (idx === 0 ? ' active' : '');

      if (currentPlaybackMode === 'both') {
        const hasCam1 = !!clip.cam1;
        const hasCam2 = !!clip.cam2;
        item.innerHTML = `
          <div>
            <div class="clip-time">🕒 ${clip.minute || clip.time} (Dual Lensa)</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
              ${hasCam1 ? '🎥 Lensa 1' : '❌ Lensa 1'} • ${hasCam2 ? '📹 Lensa 2' : '❌ Lensa 2'}
            </div>
          </div>
          <div class="clip-size" style="font-size: 0.72rem; color: var(--accent-cyan);">Dual Sync</div>
        `;
      } else {
        item.innerHTML = `
          <div>
            <div class="clip-time">🕒 ${clip.time}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${clip.filename}</div>
          </div>
          <div class="clip-size">${clip.sizeFormatted}</div>
        `;
      }

      item.addEventListener('click', () => {
        selectClipByIndex(idx);
      });
      clipsList.appendChild(item);
    });

    // Auto-play first clip
    if (currentClips.length > 0) {
      selectClipByIndex(0);
    }

  } catch (err) {
    clipsList.innerHTML = `<div style="color: #fb7185; padding: 1rem;">Gagal memuat file rekaman</div>`;
    if (clipsCountBadge) clipsCountBadge.textContent = '0 Klip';
  }
}

let isCompatMode = false;
const btnToggleCompat = document.getElementById('btnToggleCompat');
const playbackErrorNotice = document.getElementById('playbackErrorNotice');
const btnAudioCam1 = document.getElementById('btnAudioCam1');
const btnAudioCam2 = document.getElementById('btnAudioCam2');

function setCompatMode(enabled) {
  isCompatMode = enabled;
  if (btnToggleCompat) {
    btnToggleCompat.textContent = isCompatMode ? '⚡ Mode Kompatibel (H.264): ON' : '⚡ Mode Kompatibel (H.264): OFF';
    btnToggleCompat.classList.toggle('active', isCompatMode);
  }
  if (playbackErrorNotice) {
    playbackErrorNotice.style.display = 'none';
  }
  if (currentPlayingClip && currentClipIndex >= 0 && currentClips[currentClipIndex]) {
    playClip(currentPlaybackMode, currentClips[currentClipIndex]);
  }
}

if (btnToggleCompat) {
  btnToggleCompat.addEventListener('click', () => {
    setCompatMode(!isCompatMode);
  });
}

window.enableCompatMode = function() {
  setCompatMode(true);
};

if (btnAudioCam1 && dualVideoCam1) {
  btnAudioCam1.addEventListener('click', () => {
    dualVideoCam1.muted = !dualVideoCam1.muted;
    btnAudioCam1.textContent = dualVideoCam1.muted ? '🔇 Buka Suara' : '🔊 Suara Aktif';
    btnAudioCam1.classList.toggle('unmuted', !dualVideoCam1.muted);
  });
}

if (btnAudioCam2 && dualVideoCam2) {
  btnAudioCam2.addEventListener('click', () => {
    dualVideoCam2.muted = !dualVideoCam2.muted;
    btnAudioCam2.textContent = dualVideoCam2.muted ? '🔇 Buka Suara' : '🔊 Suara Aktif';
    btnAudioCam2.classList.toggle('unmuted', !dualVideoCam2.muted);
  });
}

function attachVideoErrorHandler(videoElem, label) {
  if (!videoElem) return;
  videoElem.addEventListener('error', () => {
    const err = videoElem.error;
    console.warn(`[VideoError] ${label} error:`, err);
    if (!isCompatMode && playbackErrorNotice) {
      playbackErrorNotice.style.display = 'flex';
      playbackErrorNotice.innerHTML = `
        <div>⚠️ <strong>Browser belum mendukung H.265 bawaan (${label}).</strong> Klik tombol untuk memutar dengan konversi H.264 instan:</div>
        <button type="button" class="btn-primary" style="margin-top:6px; font-size:0.75rem; padding:6px 12px;" onclick="enableCompatMode()">⚡ Aktifkan Mode Kompatibel (H.264)</button>
      `;
    }
  });
}

attachVideoErrorHandler(playbackVideo, 'Lensa');
attachVideoErrorHandler(dualVideoCam1, 'Lensa 1');
attachVideoErrorHandler(dualVideoCam2, 'Lensa 2');

function playClip(mode, clip) {
  currentPlayingClip = { mode, ...clip };
  if (playbackErrorNotice) playbackErrorNotice.style.display = 'none';

  // Update Download Button
  const canDownload = currentUser && (currentUser.role === 'admin' || currentUser.permissions?.can_download_clips);
  const compatParam = isCompatMode ? '?compat=1' : '';

  if (mode === 'both') {
    // Show Dual Player Box, Hide Single
    if (singlePlayerBox) singlePlayerBox.style.display = 'none';
    if (dualPlayerBox) dualPlayerBox.style.display = 'grid';

    // Lensa 1 (PTZ)
    if (clip.cam1 && clip.cam1.filename) {
      dualVideoCam1.src = `/api/recordings/stream/cam1/${clip.cam1.filename}${compatParam}`;
      dualVideoCam1.style.display = 'block';
      dualOverlayCam1.style.display = 'none';
      dualVideoCam1.muted = true;
      if (btnAudioCam1) {
        btnAudioCam1.textContent = '🔇 Buka Suara';
        btnAudioCam1.classList.remove('unmuted');
      }
      dualVideoCam1.load();
      dualVideoCam1.play().catch(() => {});
    } else {
      dualVideoCam1.removeAttribute('src');
      dualVideoCam1.style.display = 'none';
      dualOverlayCam1.style.display = 'flex';
    }

    // Lensa 2 (Fixed)
    if (clip.cam2 && clip.cam2.filename) {
      dualVideoCam2.src = `/api/recordings/stream/cam2/${clip.cam2.filename}${compatParam}`;
      dualVideoCam2.style.display = 'block';
      dualOverlayCam2.style.display = 'none';
      dualVideoCam2.muted = true;
      if (btnAudioCam2) {
        btnAudioCam2.textContent = '🔇 Buka Suara';
        btnAudioCam2.classList.remove('unmuted');
      }
      dualVideoCam2.load();
      dualVideoCam2.play().catch(() => {});
    } else {
      dualVideoCam2.removeAttribute('src');
      dualVideoCam2.style.display = 'none';
      dualOverlayCam2.style.display = 'flex';
    }

    currentPlayingTitle.textContent = `🎥 Dual Sync Playback - ${clip.minute || clip.time}`;
    currentPlayingSub.textContent = `Lensa 1: ${clip.cam1 ? clip.cam1.filename : '(Tidak ada)'} | Lensa 2: ${clip.cam2 ? clip.cam2.filename : '(Tidak ada)'}`;

    if (canDownload && clip.cam1) {
      downloadContainer.style.display = 'flex';
      downloadContainer.innerHTML = `
        <button class="btn-primary" style="padding: 6px 10px; font-size: 0.75rem;" onclick="window.location.href='/api/recordings/download/cam1/${clip.cam1.filename}'">⬇️ Unduh Lensa 1</button>
        ${clip.cam2 ? `<button class="btn-primary" style="padding: 6px 10px; font-size: 0.75rem; background: rgba(59, 130, 246, 0.2); border-color: rgba(59, 130, 246, 0.4); color: #60a5fa;" onclick="window.location.href='/api/recordings/download/cam2/${clip.cam2.filename}'">⬇️ Unduh Lensa 2</button>` : ''}
      `;
    } else {
      downloadContainer.style.display = 'none';
    }

  } else {
    // Single Camera Mode
    if (dualPlayerBox) dualPlayerBox.style.display = 'none';
    if (singlePlayerBox) singlePlayerBox.style.display = 'block';

    const camKey = clip.camera || playbackCameraSelect.value || 'cam1';
    playbackVideo.src = `/api/recordings/stream/${camKey}/${clip.filename}${compatParam}`;
    playbackVideo.muted = true;
    playbackVideo.load();
    playbackVideo.play().catch(() => {});

    currentPlayingTitle.textContent = `▶️ ${camKey === 'cam1' ? 'Lensa 1 (PTZ)' : 'Lensa 2 (Sudut Lebar)'} - ${clip.time}`;
    currentPlayingSub.textContent = `File: ${clip.filename} (${clip.sizeFormatted})`;

    if (canDownload) {
      downloadContainer.style.display = 'flex';
      downloadContainer.innerHTML = `
        <button class="btn-primary" style="padding: 6px 12px; font-size: 0.8rem;" onclick="window.location.href='/api/recordings/download/${camKey}/${clip.filename}'">⬇️ Download Klip</button>
      `;
    } else {
      downloadContainer.style.display = 'none';
    }
  }

  updatePlayPauseBtnUI(true);
}

// Bind Timeupdate on videos for synced timeline
function bindVideoSync(videoElem) {
  if (!videoElem) return;

  videoElem.addEventListener('timeupdate', () => {
    if (!syncTimeline || syncTimeline.matches(':active')) return;
    const cur = videoElem.currentTime;
    const dur = videoElem.duration || 60;
    syncTimeline.value = cur;
    if (dur && !isNaN(dur)) syncTimeline.max = dur;
    timeCurrent.textContent = formatPlayTime(cur);
    timeDuration.textContent = formatPlayTime(dur);
  });

  videoElem.addEventListener('play', () => updatePlayPauseBtnUI(true));
  videoElem.addEventListener('pause', () => updatePlayPauseBtnUI(false));
  videoElem.addEventListener('ended', () => {
    // Auto advance to next clip when clip ends
    playNextClip();
  });
}

bindVideoSync(playbackVideo);
bindVideoSync(dualVideoCam1);
bindVideoSync(dualVideoCam2);

// Timeline Scrubber Drag
if (syncTimeline) {
  syncTimeline.addEventListener('input', () => {
    const val = parseFloat(syncTimeline.value);
    timeCurrent.textContent = formatPlayTime(val);
    const vids = getActiveVideos();
    vids.forEach(v => {
      try { v.currentTime = val; } catch (e) {}
    });
  });
}

// Navigation & Skip Buttons
if (btnRewind10) btnRewind10.addEventListener('click', () => seekRelative(-10));
if (btnRewind5) btnRewind5.addEventListener('click', () => seekRelative(-5));
if (btnForward5) btnForward5.addEventListener('click', () => seekRelative(5));
if (btnForward10) btnForward10.addEventListener('click', () => seekRelative(10));
if (btnPrevClip) btnPrevClip.addEventListener('click', playPrevClip);
if (btnNextClip) btnNextClip.addEventListener('click', playNextClip);
if (btnPlayPause) btnPlayPause.addEventListener('click', togglePlayPause);

// Playback Speed Controls
document.querySelectorAll('.btn-speed').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-speed').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const speed = parseFloat(btn.getAttribute('data-speed'));
    const vids = [playbackVideo, dualVideoCam1, dualVideoCam2];
    vids.forEach(v => {
      if (v) v.playbackRate = speed;
    });
  });
});

// Keyboard Shortcuts for Playback Navigation
window.addEventListener('keydown', (e) => {
  if (activeTab !== 'tabPlayback') return;
  // Ignore if user is currently typing in an input
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekRelative(-5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekRelative(5);
      break;
    case 'j':
    case 'J':
      e.preventDefault();
      seekRelative(-10);
      break;
    case 'l':
    case 'L':
      e.preventDefault();
      seekRelative(10);
      break;
    case '[':
      e.preventDefault();
      playPrevClip();
      break;
    case ']':
      e.preventDefault();
      playNextClip();
      break;
  }
});

// ==========================================
// USER MANAGEMENT (ADMIN ONLY)
// ==========================================

async function fetchUsersList() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!res.ok) return;

    usersTableBody.innerHTML = '';
    data.users.forEach(u => {
      const p = u.permissions || {};
      const tr = document.createElement('tr');

      const isMe = u.id === currentUser.id;
      const permBadges = `
        <span class="badge-perm ${p.can_view_live ? 'badge-on' : 'badge-off'}">Live</span>
        <span class="badge-perm ${p.can_control_ptz ? 'badge-on' : 'badge-off'}">PTZ 360</span>
        <span class="badge-perm ${p.can_view_playback ? 'badge-on' : 'badge-off'}">Rekaman</span>
        <span class="badge-perm ${p.can_download_clips ? 'badge-on' : 'badge-off'}">Download</span>
        <span class="badge-perm ${p.can_hear_audio ? 'badge-on' : 'badge-off'}">Audio</span>
      `;

      tr.innerHTML = `
        <td style="font-weight: 600;">${u.username}</td>
        <td>${u.name}</td>
        <td><span style="text-transform: uppercase; font-size: 0.8rem; color: ${u.role === 'admin' ? 'var(--accent-cyan)' : 'var(--text-secondary)'}">${u.role}</span></td>
        <td>${permBadges}</td>
        <td>${u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : 'Selamanya'}</td>
        <td>
          ${!isMe ? `<button onclick="deleteUser('${u.id}', '${u.username}')" class="btn-logout" style="padding: 4px 8px; font-size: 0.75rem;">Hapus</button>` : '<span style="color: var(--text-muted); font-size: 0.8rem;">(Anda)</span>'}
        </td>
      `;
      usersTableBody.appendChild(tr);
    });
  } catch (e) {}
}

btnOpenAddUser.addEventListener('click', () => {
  userForm.reset();
  userModal.classList.add('active');
});

btnCancelUserModal.addEventListener('click', () => {
  userModal.classList.remove('active');
});

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('inputUsername').value;
  const name = document.getElementById('inputName').value;
  const password = document.getElementById('inputPassword').value;
  const expiresAt = document.getElementById('inputExpiresAt').value || null;

  const permissions = {
    can_view_live: document.getElementById('permLive').checked,
    can_control_ptz: document.getElementById('permPTZ').checked,
    can_view_playback: document.getElementById('permPlayback').checked,
    can_download_clips: document.getElementById('permDownload').checked,
    can_hear_audio: document.getElementById('permAudio').checked
  };

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, password, role: 'user', permissions, expiresAt })
    });
    const data = await res.json();
    if (res.ok) {
      userModal.classList.remove('active');
      fetchUsersList();
    } else {
      alert(data.error || 'Gagal menambah user');
    }
  } catch (err) {
    alert('Koneksi server gagal');
  }
});

window.deleteUser = async function(id, username) {
  if (!confirm(`Yakin ingin menghapus akses user ${username}?`)) return;
  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res.ok) fetchUsersList();
  } catch (e) {}
};

// ==========================================
// SETTINGS & STORAGE MONITOR
// ==========================================

async function fetchSystemStatus() {
  try {
    const res = await fetch('/api/system/status');
    const data = await res.json();
    if (!res.ok) return;

    // Update Storage Bar
    const s = data.storage;
    storageText.textContent = `${s.usedGB} GB / ${s.quotaGB} GB (${s.percentage}%)`;
    storageFill.style.width = `${Math.min(parseFloat(s.percentage), 100)}%`;
    freeDiskText.textContent = `${s.freeDiskGB} GB`;
    totalFilesText.textContent = `${s.totalFiles} File (Auto-Record Aktif)`;

    // Populate Dynamic Storage Inputs (if user is not currently typing)
    if (settingQuotaGB && !settingQuotaGB.matches(':focus')) {
      settingQuotaGB.value = s.quotaGB || 50;
    }
    if (settingStorageDir && !settingStorageDir.matches(':focus')) {
      settingStorageDir.value = s.storageDir || '/mnt/data/CCTV_RUMAH';
    }
    if (settingSegmentMinutes && s.segmentMinutes) {
      settingSegmentMinutes.value = String(s.segmentMinutes);
    }

    // Populate Settings Inputs
    if (data.cameraSettings) {
      settingIp.value = data.cameraSettings.ip || '';
      settingRtspPort.value = data.cameraSettings.port || 554;
      settingUsername.value = data.cameraSettings.username || 'admin';
    }

    // Sync Night Modes UI
    if (data.nightModes) {
      applyNightModesUI(data.nightModes);
    }
  } catch (e) {}
}

// Storage Settings Form (Dynamic GB Quota)
if (storageSettingsForm) {
  storageSettingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const quotaGB = settingQuotaGB.value;
    const segmentMinutes = settingSegmentMinutes.value;
    const storageDir = settingStorageDir.value.trim();

    try {
      const res = await fetch('/api/settings/update-storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotaGB, segmentMinutes, storageDir })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Pengaturan kuota & penyimpanan berhasil diperbarui!');
        fetchSystemStatus();
      } else {
        alert(data.error || 'Gagal menyimpan pengaturan penyimpanan.');
      }
    } catch (err) {
      alert('Koneksi server gagal saat memperbarui kuota.');
    }
  });
}

// Per-Lens Night Mode Controls
function initNightModeButtons() {
  document.querySelectorAll('.nm-btn-group').forEach(group => {
    const lens = group.getAttribute('data-lens');
    group.querySelectorAll('.nm-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-mode');
        // Visual optimistic feedback
        group.querySelectorAll('.nm-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        try {
          const res = await fetch('/api/camera/night-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lens, mode })
          });
          const data = await res.json();
          if (!res.ok) {
            alert('Gagal mengubah mode malam: ' + (data.error || 'Terjadi kesalahan'));
            loadNightModes(); // revert
          }
        } catch (err) {
          alert('Koneksi server gagal saat mengubah mode malam.');
          loadNightModes(); // revert
        }
      });
    });
  });
}

function applyNightModesUI(modes) {
  ['cam1', 'cam2'].forEach(lens => {
    const activeMode = modes[lens];
    if (activeMode) {
      const group = document.querySelector(`.nm-btn-group[data-lens="${lens}"]`);
      if (group) {
        group.querySelectorAll('.nm-btn').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-mode') === activeMode);
        });
      }
    }
  });
}

async function loadNightModes() {
  try {
    const res = await fetch('/api/camera/night-mode');
    if (!res.ok) return;
    const data = await res.json();
    if (data.modes) {
      applyNightModesUI(data.modes);
    }
  } catch (e) {}
}

cameraSettingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = settingIp.value.trim();
  const rtspPort = settingRtspPort.value;
  const onvifPort = settingOnvifPort.value;
  const username = settingUsername.value.trim();
  const password = settingPassword.value;

  try {
    const res = await fetch('/api/settings/update-camera', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, port: onvifPort, username, password })
    });
    const data = await res.json();
    alert(data.message || 'Pengaturan kamera diperbarui');
    startLivePolling();
  } catch (err) {
    alert('Gagal memperbarui pengaturan kamera');
  }
});

btnScanLan.addEventListener('click', async () => {
  btnScanLan.textContent = '⏳ Memindai...';
  btnScanLan.disabled = true;
  scanResultBox.style.display = 'block';
  scanResultList.innerHTML = 'Memindai port video 554 di subnet 192.168.1.x...';

  try {
    const res = await fetch('/api/settings/scan-lan');
    const data = await res.json();
    btnScanLan.textContent = '🔍 Scan IP Otomatis';
    btnScanLan.disabled = false;

    if (data.foundDevices.length === 0) {
      scanResultList.innerHTML = '<span style="color: var(--text-muted);">Tidak ditemukan kamera baru pada subnet default. Periksa apakah kamera menyala dan terhubung ke WiFi router yang sama.</span>';
      return;
    }

    scanResultList.innerHTML = '';
    data.foundDevices.forEach(dev => {
      const d = document.createElement('div');
      d.style.display = 'flex';
      d.style.justifyContent = 'space-between';
      d.style.alignItems = 'center';
      d.style.padding = '6px 0';
      d.style.borderBottom = '1px solid var(--border-color)';
      d.innerHTML = `
        <div>
          <strong>${dev.ip}</strong> <span style="font-size: 0.75rem; color: var(--accent-cyan);">${dev.desc}</span>
        </div>
        <button class="btn-primary" style="padding: 4px 8px; font-size: 0.75rem;">Pakai IP Ini</button>
      `;
      d.querySelector('button').addEventListener('click', () => {
        settingIp.value = dev.ip;
        alert(`Alamat IP ${dev.ip} dimasukkan ke kolom konfigurasi. Klik Simpan & Terapkan Koneksi.`);
      });
      scanResultList.appendChild(d);
    });
  } catch (err) {
    btnScanLan.textContent = '🔍 Scan IP Otomatis';
    btnScanLan.disabled = false;
    scanResultList.innerHTML = 'Gagal melakukan pemindaian LAN.';
  }
});

// Kickoff
initNightModeButtons();
loadNightModes();
checkSession();
