/**
 * Tenda CH9 Dual-Lens FFmpeg Recorder & Live Stream Manager
 * Low RAM (<100MB), Zero-Transcoding CPU, 15-Minute Segmented Recording
 * Persistent In-Memory (RAM /dev/shm) Live Frame Streaming
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Resolve FFmpeg binary: prefer system native ffmpeg
let ffmpegPath = 'ffmpeg';
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  ffmpegPath = 'ffmpeg';
} catch (e) {
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
      ffmpegPath = staticFfmpeg;
    }
  } catch (err) {}
}

// Check for in-memory tmpfs /dev/shm for ultra-fast zero disk I/O live frames
const RAM_DIR = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();

class TendaCCTVRecorder {
  constructor(config = {}) {
    this.ffmpegBinary = ffmpegPath;
    this.storageDir = config.storageDir || process.env.STORAGE_DIR || '/home/arif/storage/CCTV_RUMAH';
    this.segmentTimeSeconds = (parseInt(config.segmentMinutes || process.env.SEGMENT_MINUTES || 1, 10)) * 60;

    // Camera Channels
    this.cameras = {
      cam1: {
        id: 'cam1',
        name: 'Lensa 1 (Pan/Tilt 360)',
        folderName: 'Lensa_1_PTZ',
        rtspMain: config.ch1Main || process.env.CH1_RTSP_MAIN || 'rtsp://admin:arifdifa0311@192.168.1.8:554/ch=1&subtype=0',
        rtspSub: config.ch1Sub || process.env.CH1_RTSP_SUB || 'rtsp://admin:arifdifa0311@192.168.1.8:554/ch=1&subtype=1',
        process: null,
        liveProcess: null,
        liveSnapshotPath: path.join(RAM_DIR, 'cctv_cam1.jpg'),
        reconnectTimer: null,
        liveReconnectTimer: null,
        status: 'idle',
        lastError: null,
        reconnectCount: 0
      },
      cam2: {
        id: 'cam2',
        name: 'Lensa 2 (Sudut Lebar)',
        folderName: 'Lensa_2_Fixed',
        rtspMain: config.ch2Main || process.env.CH2_RTSP_MAIN || 'rtsp://admin:arifdifa0311@192.168.1.8:554/ch=2&subtype=0',
        rtspSub: config.ch2Sub || process.env.CH2_RTSP_SUB || 'rtsp://admin:arifdifa0311@192.168.1.8:554/ch=2&subtype=1',

        process: null,
        liveProcess: null,
        liveSnapshotPath: path.join(RAM_DIR, 'cctv_cam2.jpg'),
        reconnectTimer: null,
        liveReconnectTimer: null,
        status: 'idle',
        lastError: null,
        reconnectCount: 0
      }
    };

    // Live Snapshot Cache
    this.snapshots = {
      cam1: { buffer: null, timestamp: 0 },
      cam2: { buffer: null, timestamp: 0 }
    };

    this.isShuttingDown = false;
  }

  updateCameraCredentials({ ip, port, username, password }) {
    if (!ip) return;
    const p = port || 554;
    const authPart = (username && password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';

    this.cameras.cam1.rtspMain = `rtsp://${authPart}${ip}:${p}/ch=1&subtype=0`;
    this.cameras.cam1.rtspSub = `rtsp://${authPart}${ip}:${p}/ch=1&subtype=1`;
    this.cameras.cam2.rtspMain = `rtsp://${authPart}${ip}:${p}/ch=2&subtype=0`;
    this.cameras.cam2.rtspSub = `rtsp://${authPart}${ip}:${p}/ch=2&subtype=1`;

    this.snapshots = {
      cam1: { buffer: null, timestamp: 0 },
      cam2: { buffer: null, timestamp: 0 }
    };

    console.log(`[Recorder] Camera endpoints updated to IP ${ip}:${p} (Auth: ${authPart ? 'enabled' : 'none'})`);
  }

  updateStorageSettings({ storageDir, segmentMinutes }) {
    if (storageDir) {
      this.storageDir = storageDir;
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    }
    if (segmentMinutes) {
      this.segmentTimeSeconds = parseInt(segmentMinutes, 10) * 60;
    }
    console.log(`[Recorder] Storage settings updated: Dir=${this.storageDir}, Segment=${this.segmentTimeSeconds}s`);
  }


  /**
   * Spawns an FFmpeg recording process for a specific camera channel
   */
  startCameraRecording(camKey) {
    if (this.isShuttingDown) return;
    const cam = this.cameras[camKey];
    if (!cam) return;

    if (cam.process) {
      try { cam.process.kill('SIGINT'); } catch (e) {}
      cam.process = null;
    }

    const outputFolder = path.join(this.storageDir, cam.folderName);
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const outputPattern = path.join(outputFolder, '%Y-%m-%d_%H-%M-%S.mp4');

    // Stream URL directly from camera configuration (cam1 -> ch=1 PTZ, cam2 -> ch=2 Fixed)
    const streamUrl = cam.rtspMain;

    // High performance stream copy with audio resample (16kHz AAC avoids clipping/crash on alaw 8kHz)
    // AND simultaneous RAM live snapshot (MJPEG 2 fps) with atomic overwrite (zero socket spikes)
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', streamUrl,
      // Output 1: Segmented MP4 Recording
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '16000',
      '-b:a', '64k',
      '-f', 'segment',
      '-segment_time', this.segmentTimeSeconds.toString(),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      outputPattern,
      // Output 2: RAM Live Snapshot at 2 fps
      '-vf', 'fps=2',
      '-q:v', camKey === 'cam1' ? '3' : '4',
      '-update', '1',
      '-atomic_writing', '1',
      cam.liveSnapshotPath
    ];

    console.log(`[Recorder] Launching recording for ${cam.name} using ${path.basename(this.ffmpegBinary)}`);
    cam.status = 'connecting';

    try {
      const child = spawn(this.ffmpegBinary, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'] // Ignore stdout to prevent broken pipe (exit code 183)
      });

      cam.process = child;

      child.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!msg.includes('Opening') && !msg.includes('frame=') && !msg.includes('Too many bits')) {
          cam.lastError = msg.trim().slice(0, 150);
        }
      });

      child.on('spawn', () => {
        cam.status = 'recording';
        cam.reconnectCount = 0;
        console.log(`[Recorder] ${cam.name} recording started successfully (PID: ${child.pid})`);
      });

      child.on('close', (code) => {
        cam.process = null;
        if (this.isShuttingDown) {
          cam.status = 'stopped';
          return;
        }

        cam.status = 'disconnected';
        cam.reconnectCount += 1;
        const delay = Math.min(cam.reconnectCount * 3000, 15000);
        console.warn(`[Recorder] ${cam.name} stream exited (code ${code}). Reconnecting in ${delay / 1000}s...`);

        if (cam.reconnectTimer) clearTimeout(cam.reconnectTimer);
        cam.reconnectTimer = setTimeout(() => {
          this.startCameraRecording(camKey);
        }, delay);
      });

      child.on('error', (err) => {
        cam.status = 'error';
        cam.lastError = err.message;
        console.error(`[Recorder] Failed to spawn ${cam.name}:`, err.message);
      });

    } catch (err) {
      cam.status = 'error';
      cam.lastError = err.message;
      console.error(`[Recorder] Exception starting ${cam.name}:`, err.message);
    }
  }

  /**
   * Continuous RAM frame generator (1 persistent stream per camera, zero socket spikes)
   */
  startCameraLiveWorker(camKey) {
    if (this.isShuttingDown) return;
    const cam = this.cameras[camKey];
    if (!cam) return;

    if (cam.liveProcess) {
      try { cam.liveProcess.kill('SIGINT'); } catch (e) {}
      cam.liveProcess = null;
    }

    const snapshotTarget = cam.liveSnapshotPath;
    // Extract 2 frames per second continuously into RAM disk
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', cam.rtspSub,
      '-an',
      '-vf', 'fps=2',
      '-q:v', '3',
      '-update', '1',
      '-atomic_writing', '1',
      snapshotTarget
    ];

    console.log(`[LiveWorker] Starting continuous RAM frame generator for ${cam.name} -> ${snapshotTarget}`);

    try {
      const child = spawn(this.ffmpegBinary, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      cam.liveProcess = child;

      child.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) cam.lastError = msg.slice(0, 150);
      });

      child.on('spawn', () => {
        console.log(`[LiveWorker] ${cam.name} live frame worker running (PID: ${child.pid})`);
      });

      child.on('close', (code) => {
        cam.liveProcess = null;
        if (!this.isShuttingDown) {
          if (cam.liveReconnectTimer) clearTimeout(cam.liveReconnectTimer);
          cam.liveReconnectTimer = setTimeout(() => {
            this.startCameraLiveWorker(camKey);
          }, 3000);
        }
      });

      child.on('error', (err) => {
        cam.liveProcess = null;
      });

    } catch (err) {
      console.error(`[LiveWorker] Exception starting worker for ${cam.name}:`, err.message);
    }
  }

  /**
   * Starts unified recording and live streaming workers for all cameras (zero socket spikes)
   */
  startAll() {
    this.startCameraRecording('cam1');
    this.startCameraRecording('cam2');
  }

  /**
   * Stops all recording and live workers cleanly
   */
  stopAll() {
    this.isShuttingDown = true;
    for (const key of Object.keys(this.cameras)) {
      const cam = this.cameras[key];
      if (cam.reconnectTimer) clearTimeout(cam.reconnectTimer);
      if (cam.liveReconnectTimer) clearTimeout(cam.liveReconnectTimer);

      if (cam.process) {
        try { cam.process.kill('SIGINT'); } catch (e) {}
        cam.process = null;
      }
      if (cam.liveProcess) {
        try { cam.liveProcess.kill('SIGINT'); } catch (e) {}
        cam.liveProcess = null;
      }
      cam.status = 'stopped';
    }
    console.log('[Recorder] All CCTV recording and live worker processes terminated cleanly.');
  }

  /**
   * Fetches the latest JPEG snapshot from RAM instantly (0.05ms) with zero camera connection load
   */
  async getSnapshot(camKey) {
    const cam = this.cameras[camKey];
    if (!cam) return null;

    try {
      if (fs.existsSync(cam.liveSnapshotPath)) {
        const stat = await fs.promises.stat(cam.liveSnapshotPath);
        // If file is fresh (modified within last 8 seconds) and non-empty
        if (stat.size > 1000 && (Date.now() - stat.mtimeMs < 8000)) {
          const buf = await fs.promises.readFile(cam.liveSnapshotPath);
          this.snapshots[camKey] = { buffer: buf, timestamp: stat.mtimeMs };
          return buf;
        }
      }
    } catch (e) {}

    // Fallback: return last known buffer from memory
    if (this.snapshots[camKey].buffer) {
      return this.snapshots[camKey].buffer;
    }

    return null;
  }

  getStatus() {
    return {
      cam1: {
        id: this.cameras.cam1.id,
        name: this.cameras.cam1.name,
        status: this.cameras.cam1.status,
        lastError: this.cameras.cam1.lastError,
        pid: this.cameras.cam1.process ? this.cameras.cam1.process.pid : null,
        livePid: this.cameras.cam1.liveProcess ? this.cameras.cam1.liveProcess.pid : null
      },
      cam2: {
        id: this.cameras.cam2.id,
        name: this.cameras.cam2.name,
        status: this.cameras.cam2.status,
        lastError: this.cameras.cam2.lastError,
        pid: this.cameras.cam2.process ? this.cameras.cam2.process.pid : null,
        livePid: this.cameras.cam2.liveProcess ? this.cameras.cam2.liveProcess.pid : null
      }
    };
  }
}

module.exports = TendaCCTVRecorder;
