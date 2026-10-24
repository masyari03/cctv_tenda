/**
 * Storage Watchdog & FIFO Auto-Purge Manager
 * Enforces 50GB storage limit and safeguards Drive D free space
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class StorageWatchdog {
  constructor(options = {}) {
    this.storageDir = options.storageDir || process.env.STORAGE_DIR || 'D:\\CCTV_Storage';
    this.maxQuotaBytes = (parseInt(options.limitGB || process.env.STORAGE_LIMIT_GB || 50, 10)) * 1024 * 1024 * 1024;
    this.minFreeSpaceBytes = (parseInt(options.minFreeGB || process.env.MIN_FREE_SPACE_GB || 15, 10)) * 1024 * 1024 * 1024;
    this.targetClearBytes = this.maxQuotaBytes * 0.90; // purge until 90% (45GB) to prevent thrashing
    this.isPurging = false;
    this.lastCheck = null;
    this.status = {
      usedBytes: 0,
      quotaBytes: this.maxQuotaBytes,
      freeDiskBytes: 0,
      totalDiskBytes: 0,
      totalFiles: 0,
      lastPurgedFile: null,
    };
  }

  updateQuota(limitGB, storageDir) {
    if (limitGB) {
      const gb = parseInt(limitGB, 10);
      if (!isNaN(gb) && gb > 0) {
        this.maxQuotaBytes = gb * 1024 * 1024 * 1024;
        this.targetClearBytes = this.maxQuotaBytes * 0.90;
        this.status.quotaBytes = this.maxQuotaBytes;
      }
    }
    if (storageDir) {
      this.storageDir = storageDir;
    }
    console.log(`[Watchdog] Quota updated: ${this.maxQuotaBytes / (1024**3)} GB, Dir: ${this.storageDir}`);
  }


  /**
   * Scans a folder recursively and collects all mp4 files with size and modification timestamp
   */
  async scanDirectory(dir) {
    let files = [];
    try {
      if (!fs.existsSync(dir)) return files;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            const subFiles = await this.scanDirectory(fullPath);
            files = files.concat(subFiles);
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
            const stats = await fs.promises.stat(fullPath);
            files.push({
              path: fullPath,
              name: entry.name,
              size: stats.size,
              mtime: stats.mtimeMs,
              birthtime: stats.birthtimeMs
            });
          }
        } catch (err) {
          // Ignore individual file read issues
        }
      }
    } catch (err) {
      console.error(`[Watchdog] Error scanning directory ${dir}:`, err.message);
    }
    return files;
  }

  /**
   * Retrieves remaining free disk space (Cross-platform: Linux df / Node statfs / Windows)
   */
  async getDriveFreeSpace() {
    try {
      if (fs.promises && fs.promises.statfs) {
        const stats = await fs.promises.statfs(this.storageDir);
        return stats.bavail * stats.bsize;
      }
    } catch (e) {}

    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        exec('powershell -NoProfile -Command "Get-PSDrive D | Select-Object -ExpandProperty Free"', { timeout: 4000 }, (err, stdout) => {
          if (!err && stdout && !isNaN(parseInt(stdout.trim(), 10))) {
            resolve(parseInt(stdout.trim(), 10));
          } else {
            resolve(50 * 1024 * 1024 * 1024);
          }
        });
      });
    }

    return new Promise((resolve) => {
      exec(`df -B1 "${this.storageDir}" 2>/dev/null | tail -n 1 | awk '{print $4}'`, { timeout: 4000 }, (err, stdout) => {
        if (!err && stdout && !isNaN(parseInt(stdout.trim(), 10))) {
          resolve(parseInt(stdout.trim(), 10));
        } else {
          resolve(50 * 1024 * 1024 * 1024);
        }
      });
    });
  }

  /**
   * Executes quota inspection & FIFO purge if limit exceeded
   */
  async inspectAndPurge() {
    if (this.isPurging) return this.status;
    this.isPurging = true;

    try {
      const cam1Dir = path.join(this.storageDir, 'Camera_1_PTZ');
      const cam2Dir = path.join(this.storageDir, 'Camera_2_Fixed');

      const files1 = await this.scanDirectory(cam1Dir);
      const files2 = await this.scanDirectory(cam2Dir);
      const allFiles = [...files1, ...files2];

      const totalUsedBytes = allFiles.reduce((acc, f) => acc + f.size, 0);
      const freeDiskBytes = await this.getDriveFreeSpace('D');

      this.status = {
        usedBytes: totalUsedBytes,
        quotaBytes: this.maxQuotaBytes,
        freeDiskBytes: freeDiskBytes,
        totalFiles: allFiles.length,
        lastPurgedFile: this.status.lastPurgedFile,
        lastCheckTime: new Date().toISOString()
      };

      const quotaExceeded = totalUsedBytes > this.maxQuotaBytes;
      const diskLow = freeDiskBytes < this.minFreeSpaceBytes;

      if (quotaExceeded || diskLow) {
        console.log(`[Watchdog] Quota/Disk check triggered. Used: ${(totalUsedBytes / (1024**3)).toFixed(2)}GB, Free Drive D: ${(freeDiskBytes / (1024**3)).toFixed(2)}GB`);

        // Sort ascending by time (oldest first)
        allFiles.sort((a, b) => a.mtime - b.mtime);

        let currentUsed = totalUsedBytes;
        for (const file of allFiles) {
          if (currentUsed <= this.targetClearBytes && freeDiskBytes >= this.minFreeSpaceBytes) {
            break;
          }

          try {
            await fs.promises.unlink(file.path);
            currentUsed -= file.size;
            this.status.lastPurgedFile = file.name;
            console.log(`[Watchdog FIFO] Auto-purged oldest file: ${file.name} (${(file.size / (1024*1024)).toFixed(1)} MB)`);
          } catch (delErr) {
            console.error(`[Watchdog FIFO] Failed to delete file ${file.path}:`, delErr.message);
          }
        }
        this.status.usedBytes = currentUsed;
      }
    } catch (err) {
      console.error('[Watchdog] Error in inspectAndPurge:', err.message);
    } finally {
      this.isPurging = false;
    }

    return this.status;
  }

  /**
   * Starts periodic background interval (every 5 minutes)
   */
  startScheduler(intervalMs = 300000) {
    this.inspectAndPurge();
    setInterval(() => {
      this.inspectAndPurge();
    }, intervalMs);
    console.log(`[Watchdog] Storage Watchdog active. Quota: ${(this.maxQuotaBytes / (1024**3)).toFixed(0)} GB, checked every ${intervalMs / 60000} mins.`);
  }
}

module.exports = StorageWatchdog;
