/**
 * Tenda CH9 ONVIF PTZ Controller
 * Handles 360 Pan/Tilt motor steering via ONVIF SOAP protocol
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

class TendaPTZController {
  constructor(config = {}) {
    this.ip = config.ip || process.env.TENDA_IP || '192.168.1.100';
    this.port = parseInt(config.port || process.env.TENDA_ONVIF_PORT || 80, 10);
    this.username = config.username || process.env.TENDA_USER || 'admin';
    this.password = config.password || process.env.TENDA_PASS || 'admin123456';
    this.profileToken = config.profileToken || 'Profile_1';
  }

  updateConfig({ ip, port, username, password }) {
    if (ip) this.ip = ip;
    if (port) this.port = parseInt(port, 10);
    if (username) this.username = username;
    if (password) this.password = password;
  }

  /**
   * Automatically activates Channel 2 (Fixed Lens) in the camera's native firmware via RPC2
   */
  async ensureDualLensEnabled() {
    return new Promise((resolve) => {
      try {
        const postData = JSON.stringify({
          method: 'global.login',
          params: {
            username: this.username,
            password: Buffer.from(this.password).toString('base64'),
            clientType: 'Web3.0'
          },
          id: 1
        });

        const req = https.request({
          hostname: this.ip,
          port: 443,
          path: '/RPC2',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 4000
        }, (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', async () => {
            const rawCookie = res.headers['set-cookie'];
            const cookie = rawCookie && rawCookie[0] ? rawCookie[0].split(';')[0] : '';
            if (!cookie) {
              console.warn('[CameraRPC2] Login failed, could not verify dual-lens status');
              return resolve(false);
            }

            // Query current Encode config
            const getEncodeData = JSON.stringify({
              method: 'configManager.getConfig',
              params: { name: 'Encode' },
              id: 2
            });

            const getReq = https.request({
              hostname: this.ip,
              port: 443,
              path: '/RPC2',
              method: 'POST',
              rejectUnauthorized: false,
              headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'Content-Length': Buffer.byteLength(getEncodeData)
              },
              timeout: 4000
            }, (res2) => {
              let data2 = '';
              res2.on('data', d => data2 += d);
              res2.on('end', () => {
                try {
                  const json = JSON.parse(data2);
                  const table = json.params?.table;
                  if (!table || !table.MainFormat) return resolve(false);

                  if (table.MainFormat[1] && table.MainFormat[1].VideoEnable === true) {
                    console.log('[CameraRPC2] Channel 2 (Fixed Lens) encoder is already ACTIVE.');
                    return resolve(true);
                  }

                  // Enable MainFormat[1].VideoEnable
                  table.MainFormat[1].VideoEnable = true;
                  const setEncodeData = JSON.stringify({
                    method: 'configManager.setConfig',
                    params: { name: 'Encode', table },
                    id: 3
                  });

                  const setReq = https.request({
                    hostname: this.ip,
                    port: 443,
                    path: '/RPC2',
                    method: 'POST',
                    rejectUnauthorized: false,
                    headers: {
                      'Content-Type': 'application/json',
                      'Cookie': cookie,
                      'Content-Length': Buffer.byteLength(setEncodeData)
                    },
                    timeout: 4000
                  }, (res3) => {
                    let data3 = '';
                    res3.on('data', d => data3 += d);
                    res3.on('end', () => {
                      console.log('[CameraRPC2] Channel 2 (Fixed Lens) encoder successfully activated via RPC2.');
                      resolve(true);
                    });
                  });
                  setReq.on('error', () => resolve(false));
                  setReq.write(setEncodeData);
                  setReq.end();

                } catch (e) {
                  resolve(false);
                }
              });
            });
            getReq.on('error', () => resolve(false));
            getReq.write(getEncodeData);
            getReq.end();
          });
        });

        req.on('error', (e) => {
          console.warn('[CameraRPC2] Failed to reach camera HTTPS on port 443:', e.message);
          resolve(false);
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.write(postData);
        req.end();

      } catch (err) {
        resolve(false);
      }
    });
  }

  /**
   * Generates WS-Security SOAP Header for ONVIF Authentication
   */
  createWSSecurityHeader() {
    const created = new Date().toISOString();
    const nonceBuffer = crypto.randomBytes(16);
    const nonceBase64 = nonceBuffer.toString('base64');

    // Password_Digest = Base64(SHA1(RawNonce + Created + Password))
    const sha1 = crypto.createHash('sha1');
    sha1.update(nonceBuffer);
    sha1.update(Buffer.from(created, 'utf8'));
    sha1.update(Buffer.from(this.password, 'utf8'));
    const passwordDigest = sha1.digest('base64');

    return `
      <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
        <wsse:UsernameToken>
          <wsse:Username>${this.username}</wsse:Username>
          <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passwordDigest}</wsse:Password>
          <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBase64}</wsse:Nonce>
          <wsu:Created>${created}</wsu:Created>
        </wsse:UsernameToken>
      </wsse:Security>
    `;
  }

  /**
   * Sends ONVIF SOAP POST request to camera
   */
  async sendSoapRequest(soapAction, xmlBody, path = '/onvif/ptz_service') {
    return new Promise((resolve, reject) => {
      const securityHeader = this.createWSSecurityHeader();
      const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header>
    ${securityHeader}
  </s:Header>
  <s:Body>
    ${xmlBody}
  </s:Body>
</s:Envelope>`;

      const postData = Buffer.from(envelope, 'utf8');

      const options = {
        hostname: this.ip,
        port: this.port,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8; action="' + soapAction + '"',
          'Content-Length': postData.length,
          'User-Agent': 'TendaCCTVServer/1.0'
        },
        timeout: 4000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode, data });
          } else {
            // Also resolve soft failure so server doesn't crash
            resolve({ success: false, statusCode: res.statusCode, error: data });
          }
        });
      });

      req.on('error', (err) => {
        // Return soft error without throwing
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection to camera timed out' });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * ContinuousMove (Pan/Tilt 360 Steering)
   * @param {string} direction 'up' | 'down' | 'left' | 'right'
   * @param {number} speed 0.1 to 1.0 (default 0.6)
   */
  async continuousMove(direction, speed = 0.6) {
    let x = 0;
    let y = 0;

    switch (direction.toLowerCase()) {
      case 'left':
        x = -speed;
        break;
      case 'right':
        x = speed;
        break;
      case 'up':
        y = speed;
        break;
      case 'down':
        y = -speed;
        break;
      default:
        return { success: false, error: 'Invalid direction' };
    }

    const xml = `
      <tptz:ContinuousMove>
        <tptz:ProfileToken>${this.profileToken}</tptz:ProfileToken>
        <tptz:Velocity>
          <tt:PanTilt x="${x.toFixed(2)}" y="${y.toFixed(2)}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace"/>
        </tptz:Velocity>
      </tptz:ContinuousMove>
    `;

    return this.sendSoapRequest('http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove', xml);
  }

  /**
   * Stop PTZ Motion
   */
  async stop() {
    const xml = `
      <tptz:Stop>
        <tptz:ProfileToken>${this.profileToken}</tptz:ProfileToken>
        <tptz:PanTilt>true</tptz:PanTilt>
        <tptz:Zoom>true</tptz:Zoom>
      </tptz:Stop>
    `;

    return this.sendSoapRequest('http://www.onvif.org/ver20/ptz/wsdl/Stop', xml);
  }

  /**
   * Night Mode & AI Light Recognition Controller per Lens via Native Camera RPC2
   * @param {string} lens 'cam1' | 'cam2'
   * @param {string} mode 'smart_ai' | 'full_color' | 'ir_classic' | 'day'
   */
  async setNightMode(lens = 'cam1', mode = 'smart_ai') {
    const modeMapping = {
      smart_ai: 'Smart',      // AI Smart: IR B&W in dark, white spotlight auto-turns on when human/vehicle detected
      full_color: 'FullColor', // White spotlight LED always on (full color night vision)
      ir_classic: 'Infrared',  // Classic B&W infrared LED
      day: 'Off'               // Day mode: lights off
    };

    const targetMode = modeMapping[mode];
    if (!targetMode) {
      return { success: false, error: `Mode '${mode}' tidak valid. Pilihan: smart_ai, full_color, ir_classic, day` };
    }

    const channel = lens === 'cam2' ? 1 : 0;

    return new Promise((resolve) => {
      try {
        const postLogin = JSON.stringify({
          method: 'global.login',
          params: {
            username: this.username,
            password: Buffer.from(this.password).toString('base64'),
            clientType: 'Web3.0'
          },
          id: 1
        });

        const req = https.request({
          hostname: this.ip,
          port: 443,
          path: '/RPC2',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postLogin)
          },
          timeout: 4000
        }, (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            const rawCookie = res.headers['set-cookie'];
            const cookie = rawCookie && rawCookie[0] ? rawCookie[0].split(';')[0] : '';
            if (!cookie) {
              return resolve({ success: false, error: 'Login RPC2 kamera gagal.' });
            }

            const setConfigData = JSON.stringify({
              method: 'configManager.setConfig',
              params: {
                name: 'NightVision',
                channel: channel,
                table: {
                  AlertType: ["VideoMotion", "VideoHuman", "VideoVehicle", "VideoBike"],
                  InfraredBrightness: 100,
                  Mode: targetMode,
                  WhiteBrightness: 100
                }
              },
              id: 2
            });

            const req2 = https.request({
              hostname: this.ip,
              port: 443,
              path: '/RPC2',
              method: 'POST',
              rejectUnauthorized: false,
              headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'Content-Length': Buffer.byteLength(setConfigData)
              },
              timeout: 4000
            }, (res2) => {
              let data2 = '';
              res2.on('data', d => data2 += d);
              res2.on('end', () => {
                try {
                  const json = JSON.parse(data2);
                  const isOk = json.result === true;

                  // Save state locally
                  try {
                    const modeFile = path.join(__dirname, 'data', 'night_mode.json');
                    let current = { cam1: 'smart_ai', cam2: 'smart_ai' };
                    if (fs.existsSync(modeFile)) {
                      current = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
                    }
                    current[lens] = mode;
                    fs.writeFileSync(modeFile, JSON.stringify(current, null, 2), 'utf8');
                  } catch (e) {}

                  resolve({
                    success: isOk,
                    lens,
                    mode,
                    cameraMode: targetMode,
                    channel,
                    message: isOk
                      ? `Lampu & Mode malam ${lens === 'cam1' ? 'Lensa 1 (PTZ 360)' : 'Lensa 2 (Sudut Lebar)'} berhasil diubah ke [${targetMode}]`
                      : 'Kamera menolak perintah mode malam RPC2.'
                  });
                } catch (e) {
                  resolve({ success: false, error: e.message });
                }
              });
            });

            req2.on('error', (err) => resolve({ success: false, error: err.message }));
            req2.write(setConfigData);
            req2.end();
          });
        });

        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout koneksi kamera RPC2' }); });
        req.write(postLogin);
        req.end();

      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  getNightModes() {
    try {
      const modeFile = path.join(__dirname, 'data', 'night_mode.json');
      if (fs.existsSync(modeFile)) {
        return JSON.parse(fs.readFileSync(modeFile, 'utf8'));
      }
    } catch (e) {}
    return { cam1: 'smart_ai', cam2: 'smart_ai' };
  }
}

const path = require('path');
const fs = require('fs');

module.exports = TendaPTZController;

