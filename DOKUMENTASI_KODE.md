# 📘 DOKUMENTASI SISTEM & PANDUAN EDIT MANUAL (TENDA CH9 CCTV SERVER)

Aplikasi server perekaman mandiri untuk CCTV Tenda CH9 Dual-Lens dengan batasan penyimpanan 50 GB di Harddisk Drive D: dan konsumsi RAM ultra-rendah (<100MB).

---

## 1. DAFTAR FILE SISTEM
| File & Path | Fungsi & Penjelasan |
| :--- | :--- |
| `c:\laragon\www\tenda-cctv\.env` | Berisi variabel environment (Port, IP CCTV, kredensial TDSEE, kuota 50GB, direktori Drive D). |
| `c:\laragon\www\tenda-cctv\server.js` | Backend Express yang melayani API autentikasi, proteksi brute-force, streaming video HTTP 206, dan manajemen user. |
| `c:\laragon\www\tenda-cctv\recorder.js` | Pengendali FFmpeg stream-copy (zero-transcoding) yang merekam Lensa 1 (PTZ) & Lensa 2 (Fixed) beserta audio mic ke file `.mp4` 15 menitan. |
| `c:\laragon\www\tenda-cctv\watchdog.js` | Pengawas kuota 50 GB di Drive D: yang menjalankan pembersihan otomatis tertua (FIFO Auto-Purge) setiap 5 menit. |
| `c:\laragon\www\tenda-cctv\ptz.js` | Modul pengirim sinyal ONVIF SOAP untuk menggerakkan motor putar 360° kamera Lensa 1. |
| `c:\laragon\www\tenda-cctv\data\users.json` | Database pengguna lokal berisi username, role, izin granular, dan password ter-hash Bcrypt. |
| `c:\laragon\www\tenda-cctv\public\index.html` | Antarmuka web portal responsif (Live Dual Screen, Player Reka Ulang, Kemudi 360, Kelola User). |
| `c:\laragon\www\tenda-cctv\public\style.css` | Desain tema Dark Slate Glassmorphism yang sejuk di mata untuk monitoring jangka panjang. |
| `c:\laragon\www\tenda-cctv\public\app.js` | Logika frontend untuk streaming live snapshot, D-pad steering, kontrol keyboard, player speed 0.5x-8x. |
| `c:\laragon\www\tenda-cctv\start.bat` | Script peluncur sekali klik (double-click) untuk menyalakan server di laptop. |

---

## 2. CARA MENJALANKAN & MENGAKSES SERVER
1. **Buka di Browser Laptop / HP:**
   - Di laptop server: `http://localhost:3080`
   - Dari HP / laptop lain di WiFi yang sama: `http://192.168.1.7:3080`
2. **Kredensial Default:**
   - **Username:** `admin`
   - **Password:** `admin123`
   *(Pengguna tamu: `tamu` / `admin123` dengan hak akses terbatas).*

---

## 3. PANDUAN UBAH MANUAL DI KEMUDIAN HARI

### A. Mengubah Batas Kuota Penyimpanan (Default: 50 GB)
* Buka file: `c:\laragon\www\tenda-cctv\.env`
* Cari baris:
  ```env
  STORAGE_LIMIT_GB=50
  ```
* Ubah angka `50` menjadi kuota yang diinginkan (contoh: `80` atau `100`).

### B. Mengubah Durasi Pemotongan Segmen Video (Default: 15 Menit)
* Buka file: `c:\laragon\www\tenda-cctv\.env`
* Cari baris:
  ```env
  SEGMENT_MINUTES=15
  ```
* Ubah `15` menjadi durasi yang diinginkan (misal `30` untuk rekaman per 30 menit).

### C. Mengubah IP & Password CCTV Tenda CH9
* Buka menu **⚙️ Pengaturan & Storage** di antarmuka web, klik tombol **"🔍 Scan IP Otomatis"** untuk mendeteksi kamera, lalu klik **"Simpan & Terapkan Koneksi"**.
* Atau ubah manual di file `.env`:
  ```env
  TENDA_IP=192.168.1.xxx
  TENDA_PASS=password_tdsee_anda
  ```

### D. Mengubah / Menambah User & Hak Akses
* Buka tab **👥 Kelola User** di web dashboard (hanya bisa dibuka oleh Admin).
* Anda dapat mencentang atau mematikan izin berikut per user:
  - `Bisa Tonton Siaran Langsung (Live View)`
  - `Izin Kemudi Putar 360° (PTZ)` (matikan agar tamu tidak bisa putar-putar kamera)
  - `Buka Akses Reka Ulang (Riwayat Rekaman)` (saklar on/off oleh Admin)
  - `Izin Download File Video`
  - `Izin Mendengar Suara Mikrofon`
  - `Masa Berlaku Akun` (atur tanggal kadaluwarsa)

---

## 4. HASIL PEMERIKSAAN MYSQL (LARAGON)
* **Kondisi Aktif:** MySQL 8.0.30 saat ini berjalan normal pada port `3306` (PID 38000).
* **Catatan Dua Proses `mysqld`:** PID 34916 adalah *supervisor/watchdog* bawaan MySQL Windows yang mengawasi worker PID 38000. Ini perilaku normal.
* **Akses Remote:** User `root` hanya boleh dari `localhost`. Jika ingin koneksi remote LAN, gunakan user `bro` (host `%`) atau jalankan perintah SQL:
  ```sql
  CREATE USER 'admin_lan'@'%' IDENTIFIED BY 'password_anda';
  GRANT ALL PRIVILEGES ON *.* TO 'admin_lan'@'%';
  FLUSH PRIVILEGES;
  ```
