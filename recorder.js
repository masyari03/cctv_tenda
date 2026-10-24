/**
 * Tenda CH9 Dual-Lens FFmpeg Recorder & Live Stream Manager
 * Low RAM (<100MB), Zero-Transcoding CPU, 15-Minute Segmented Recording
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Resolve FFmpeg binary
let ffmpegPath = 'ffmpeg';
try {
  const staticFfmpeg = require('ffmpeg-static');
  if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
    ffmpegPath = staticFfmpeg;
  }
} catch (e) {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer && installer.path && fs.existsSync(installer.path)) {
      ffmpegPath = installer.path;
    }
  } catch (err) {}
}

class TendaCCTVRecorder {
  constructor(config = {}) {
    this.ffmpegBinary = ffmpegPath;
    this.storageDir = config.storageDir || process.env.STORAGE_DIR || 'D:\\CCTV_Storage';
    this.segmentTimeSeconds = (parseInt(config.segmentMinutes || process.env.SEGMENT_MINUTES || 15, 10)) * 60;
    
    // Camera Channels
    this.cameras = {
      cam1: {
        id: 'cam1',
        name: 'Camera 1 (Pan/Tilt 360)',
        folderName: 'Camera_1_PTZ',
        rtspMain: config.ch1Main || process.env.CH1_RTSP_MAIN || 'rtsp://admin:admin123456@192.168.1.8:554/ch=1&subtype=0',
        rtspSub: config.ch1Sub || process.env.CH1_RTSP_SUB || 'rtsp://admin:admin123456@192.168.1.8:554/ch=1&subtype=1',
        process: null,
        reconnectTimer: null,
        status: 'idle',
        lastError: null,
        reconnectCount: 0
      },
      cam2: {
        id: 'cam2',
        name: 'Camera 2 (Fixed Wide-Angle)',
        folderName: 'Camera_2_Fixed',
        rtspMain: config.ch2Main || process.env.CH2_RTSP_MAIN || 'rtsp://admin:admin123456@192.168.1.8:554/ch=2&subtype=0',
        rtspSub: config.ch2Sub || process.env.CH2_RTSP_SUB || 'rtsp://admin:admin123456@192.168.1.8:554/ch=2&subtype=1',
        process: null,
        reconnectTimer: null,
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
    const u = encodeURIComponent(username || 'admin');
    const pwd = encodeURIComponent(password || 'admin123456');

    this.cameras.cam1.rtspMain = `rtsp://${u}:${pwd}@${ip}:${p}/ch=1&subtype=0`;
    this.cameras.cam1.rtspSub = `rtsp://${u}:${pwd}@${ip}:${p}/ch=1&subtype=1`;
    this.cameras.cam2.rtspMain = `rtsp://${u}:${pwd}@${ip}:${p}/ch=2&subtype=0`;
    this.cameras.cam2.rtspSub = `rtsp://${u}:${pwd}@${ip}:${p}/ch=2&subtype=1`;

    console.log(`[Recorder] Camera endpoints updated to IP ${ip}:${p}`);
  }

  /**
   * Spawns an FFmpeg recording process for a specific camera channel
   */
  startCameraRecording(camKey) {
    if (this.isShuttingDown) return;
    const cam = this.cameras[camKey];
    if (!cam) return;

    if (cam.process) {
      try { cam.process.kill(); } catch (e) {}
      cam.process = null;
    }

    const outputFolder = path.join(this.storageDir, cam.folderName);
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const outputPattern = path.join(outputFolder, '%Y-%m-%d_%H-%M-%S.mp4');

    // High performance stream copy: zero cpu transcoding, audio AAC conversion
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-i', cam.rtspMain,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-f', 'segment',
      '-segment_time', this.segmentTimeSeconds.toString(),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      outputPattern
    ];

    console.log(`[Recorder] Launching recording for ${cam.name} using ${path.basename(this.ffmpegBinary)}`);
    cam.status = 'connecting';

    try {
      const child = spawn(this.ffmpegBinary, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      cam.process = child;

      child.stderr.on('data', (data) => {
        const msg = data.toString();
        // Ignore normal progress logs
        if (!msg.includes('Opening') && !msg.includes('frame=')) {
          cam.lastError = msg.trim().slice(0, 150);
        }
      });

      child.on('spawn', () => {
        cam.status = 'recording';
        cam.reconnectCount = 0;
        console.log(`[Recorder] ${cam.name} started successfully (PID: ${child.pid})`);
      });

      child.on('close', (code) => {
        cam.process = null;
        if (this.isShuttingDown) {
          cam.status = 'stopped';
          return;
        }

        cam.status = 'disconnected';
        cam.reconnectCount += 1;
        const delay = Math.min(cam.reconnectCount * 3000, 15000); // 3s, 6s, max 15s
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
   * Starts recording for all camera channels
   */
  startAll() {
    this.startCameraRecording('cam1');
    this.startCameraRecording('cam2');
  }

  /**
   * Stops all recordings cleanly
   */
  stopAll() {
    this.isShuttingDown = true;
    for (const key of Object.keys(this.cameras)) {
      const cam = this.cameras[key];
      if (cam.reconnectTimer) clearTimeout(cam.reconnectTimer);
      if (cam.process) {
        try {
          cam.process.kill('SIGINT');
        } catch (e) {}
        cam.process = null;
      }
      cam.status = 'stopped';
    }
    console.log('[Recorder] All CCTV recording processes terminated cleanly.');
  }

  /**
   * Fetches an on-demand snapshot from camera for live view in web UI
   */
  async getSnapshot(camKey) {
    const cam = this.cameras[camKey];
    if (!cam) return null;

    const now = Date.now();
    // Cache for 800ms to avoid overwhelming camera with concurrent web viewers
    if (this.snapshots[camKey].buffer && (now - this.snapshots[camKey].timestamp < 800)) {
      return this.snapshots[camKey].buffer;
    }

    return new Promise((resolve) => {
      // Pull single frame from sub-stream for instant speed
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', cam.rtspSub,
        '-vframes', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1'
      ];

      const child = spawn(this.ffmpegBinary, args, { windowsHide: true });
      const chunks = [];

      child.stdout.on('data', (c) => chunks.push(c));
      child.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          const buf = Buffer.concat(chunks);
          this.snapshots[camKey] = { buffer: buf, timestamp: now };
          resolve(buf);
        } else {
          resolve(this.snapshots[camKey].buffer || null);
        }
      });
      child.on('error', () => resolve(this.snapshots[camKey].buffer || null));

      setTimeout(() => {
        try { child.kill(); } catch (e) {}
        resolve(this.snapshots[camKey].buffer || null);
      }, 4000);
    });
  }

  getStatus() {
    return {
      cam1: {
        id: this.cameras.cam1.id,
        name: this.cameras.cam1.name,
        status: this.cameras.cam1.status,
        lastError: this.cameras.cam1.lastError,
        pid: this.cameras.cam1.process ? this.cameras.cam1.process.pid : null
      },
      cam2: {
        id: this.cameras.cam2.id,
        name: this.cameras.cam2.name,
        status: this.cameras.cam2.status,
        lastError: this.cameras.cam2.lastError,
        pid: this.cameras.cam2.process ? this.cameras.cam2.process.pid : null
      }
    };
  }
}

module.exports = TendaCCTVRecorder;
