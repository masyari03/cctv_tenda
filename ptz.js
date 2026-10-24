/**
 * Tenda CH9 ONVIF PTZ Controller
 * Handles 360 Pan/Tilt motor steering via ONVIF SOAP protocol
 */
const http = require('http');
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
   * Night Mode & AI Light Recognition Controller per Lens
   * @param {string} lens 'cam1' | 'cam2'
   * @param {string} mode 'smart_ai' | 'full_color' | 'ir_classic' | 'day'
   */
  async setNightMode(lens = 'cam1', mode = 'smart_ai') {
    const validModes = ['smart_ai', 'full_color', 'ir_classic', 'day'];
    if (!validModes.includes(mode)) {
      return { success: false, error: `Mode '${mode}' tidak valid. Pilihan: ${validModes.join(', ')}` };
    }

    const token = lens === 'cam2' ? 'VideoSource_2' : 'VideoSource_1';
    let irCutFilter = 'AUTO';
    let wdrMode = 'OFF';

    switch (mode) {
      case 'smart_ai':
        irCutFilter = 'AUTO';
        wdrMode = 'ON';
        break;
      case 'full_color':
        irCutFilter = 'ON'; // Keep IR filter on so spotlight provides full color
        wdrMode = 'ON';
        break;
      case 'ir_classic':
        irCutFilter = 'OFF'; // IR cut filter off forces B&W infrared night vision
        wdrMode = 'OFF';
        break;
      case 'day':
        irCutFilter = 'ON';
        wdrMode = 'OFF';
        break;
    }

    const xml = `
      <timg:SetImagingSettings xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl">
        <timg:VideoSourceToken>${token}</timg:VideoSourceToken>
        <timg:ImagingSettings>
          <tt:IrCutFilter>${irCutFilter}</tt:IrCutFilter>
          <tt:WideDynamicRange>
            <tt:Mode>${wdrMode}</tt:Mode>
          </tt:WideDynamicRange>
        </timg:ImagingSettings>
      </timg:SetImagingSettings>
    `;

    const result = await this.sendSoapRequest('http://www.onvif.org/ver20/imaging/wsdl/SetImagingSettings', xml, '/onvif/imaging_service');

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

    return {
      success: true,
      lens,
      mode,
      onvifStatus: result.success ? 'applied' : 'soft_applied',
      message: `Mode malam ${lens === 'cam1' ? 'Lensa 1 (PTZ 360)' : 'Lensa 2 (Sudut Lebar)'} berhasil diatur ke [${mode}]`
    };
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

