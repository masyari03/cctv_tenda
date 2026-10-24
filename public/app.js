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

// Initialize Today's Date and Hour Options
playbackDateInput.value = new Date().toISOString().slice(0, 10);
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

async function fetchRecordings() {
  const camera = playbackCameraSelect.value;
  const date = playbackDateInput.value;
  const hourParam = activeHourFilter ? `&hour=${encodeURIComponent(activeHourFilter)}` : '';

  clipsList.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Memuat arsip...</div>`;

  try {
    const res = await fetch(`/api/recordings?camera=${camera}&date=${date}${hourParam}`);
    const data = await res.json();

    if (!res.ok) {
      clipsList.innerHTML = `<div style="color: #fb7185; padding: 1rem;">${data.error || 'Gagal mengambil rekaman'}</div>`;
      if (clipsCountBadge) clipsCountBadge.textContent = '0 Klip';
      return;
    }

    if (clipsCountBadge) {
      clipsCountBadge.textContent = `${data.files.length} Klip`;
    }

    if (data.files.length === 0) {
      clipsList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem; text-align: center;">Tidak ada rekaman untuk tanggal ${date} ${activeHourFilter ? '(filter jam aktif)' : ''}.</div>`;
      return;
    }

    clipsList.innerHTML = '';
    data.files.forEach((clip, idx) => {
      const item = document.createElement('div');
      item.className = 'clip-item' + (idx === 0 ? ' active' : '');
      item.innerHTML = `
        <div>
          <div class="clip-time">🕒 ${clip.time}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${clip.filename}</div>
        </div>
        <div class="clip-size">${clip.sizeFormatted}</div>
      `;
      item.addEventListener('click', () => {
        document.querySelectorAll('.clip-item').forEach(c => c.classList.remove('active'));
        item.classList.add('active');
        playClip(camera, clip);
      });
      clipsList.appendChild(item);
    });

    // Auto-play first clip
    if (data.files.length > 0) {
      playClip(camera, data.files[0]);
    }

  } catch (err) {
    clipsList.innerHTML = `<div style="color: #fb7185; padding: 1rem;">Gagal memuat file rekaman</div>`;
    if (clipsCountBadge) clipsCountBadge.textContent = '0 Klip';
  }
}

function playClip(camera, clip) {
  currentPlayingClip = { camera, ...clip };
  const streamUrl = `/api/recordings/stream/${camera}/${clip.filename}`;
  playbackVideo.src = streamUrl;
  playbackVideo.load();
  playbackVideo.play().catch(() => {});

  currentPlayingTitle.textContent = `▶️ ${camera === 'cam1' ? 'Lensa 1 (PTZ)' : 'Lensa 2 (Fixed)'} - ${clip.time}`;
  currentPlayingSub.textContent = `File: ${clip.filename} (${clip.sizeFormatted})`;

  // Download Button Handling
  const canDownload = currentUser.role === 'admin' || currentUser.permissions?.can_download_clips;
  if (canDownload) {
    downloadContainer.style.display = 'block';
    btnDownloadClip.onclick = () => {
      window.location.href = `/api/recordings/download/${camera}/${clip.filename}`;
    };
  } else {
    downloadContainer.style.display = 'none';
  }
}

// Playback Speed Controls
document.querySelectorAll('.btn-speed').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-speed').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const speed = parseFloat(btn.getAttribute('data-speed'));
    playbackVideo.playbackRate = speed;
  });
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
    totalFilesText.textContent = `${s.totalFiles} File`;

    // Populate Dynamic Storage Inputs (if user is not currently typing)
    if (settingQuotaGB && !settingQuotaGB.matches(':focus')) {
      settingQuotaGB.value = s.quotaGB || 50;
    }
    if (settingStorageDir && !settingStorageDir.matches(':focus')) {
      settingStorageDir.value = s.storageDir || '/home/arif/storage/CCTV_RUMAH';
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
