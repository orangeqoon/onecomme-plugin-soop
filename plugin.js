// @ts-nocheck
'use strict';

const tls = require('tls');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const STARTER = '\u001b\t';
const SEP = '\f';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let activeSocket = null;
let currentServiceId = null;
let currentBjid = null;
let pingTimer = null;
let seq = 0;

function log(msg) {
  console.info('[SOOPプラグイン] ' + msg);
}

function utf8len(text) {
  return Buffer.byteLength(text, 'utf8');
}

function encodePacket(code, payload) {
  return STARTER + code + String(utf8len(payload)).padStart(6, '0') + '00' + payload;
}

function connectPacket() {
  return encodePacket('0001', SEP.repeat(3) + '16' + SEP);
}

function joinPacket(chatNo) {
  return encodePacket('0002', SEP + chatNo + SEP.repeat(5));
}

function pingPacket() {
  return encodePacket('0000', SEP);
}

function maskFrame(opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = buf[i] ^ mask[i % 4];

  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function extractBjid(url) {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL('https://' + raw);
    const host = u.hostname.toLowerCase();

    if (host.includes('sooplive.') || host.includes('afreecatv.')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const skip = new Set(['player', 'live', 'station', 'browser', 'watch', 'vod']);
      const found = parts.find((p) => !skip.has(p.toLowerCase()) && /^[a-zA-Z0-9_]{2,32}$/.test(p));
      if (found) return found;
    }

    const aliasMatch = u.pathname.match(/\/soop\/([a-zA-Z0-9_]{2,32})/i);
    if (aliasMatch) return aliasMatch[1];
  } catch (_) {}

  if (/^[a-zA-Z0-9_]{2,32}$/.test(raw)) return raw;
  const m = raw.match(/(?:^|\/)([a-zA-Z0-9_]{2,32})\/?$/);
  return m ? m[1] : '';
}

function fetchLiveInfo(bjid) {
  const url = 'https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid=' + encodeURIComponent(bjid);
  const body = new URLSearchParams({
    bid: bjid,
    type: 'live',
    pwd: '',
    player_type: 'html5',
    stream_type: 'common',
    quality: 'HD',
    mode: 'landing',
    from_api: '0',
    is_revive: 'false',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': UA,
          'Origin': 'https://play.sooplive.co.kr',
          'Referer': 'https://play.sooplive.co.kr/' + bjid,
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const ch = (json && json.CHANNEL) || {};
            resolve({
              result: Number(ch.RESULT || 0),
              online: Number(ch.RESULT || 0) === 1,
              streamerId: String(ch.BJID || bjid),
              streamerNick: String(ch.BJNICK || ''),
              title: String(ch.TITLE || ''),
              chatNo: String(ch.CHATNO || ''),
              chatDomain: String(ch.CHDOMAIN || '').toLowerCase(),
              chatPort: Number.parseInt(String(ch.CHPT || '0'), 10) || 0,
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Live API タイムアウト'));
    });
    req.write(body);
    req.end();
  });
}

function postJson(port, pathname, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 4000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.write(body);
    req.end();
  });
}

function parseEvent(packet) {
  if (!packet.startsWith(STARTER)) return null;
  const code = packet.slice(2, 6);
  const parts = packet.split(SEP);
  const now = Date.now();

  // 0005: チャットコメント
  if (code === '0005') {
    const comment = parts[1] || '';
    if (!comment) return null;
    return {
      type: 'chat',
      userId: parts[2] || '',
      name: parts[6] || parts[2] || 'SOOP',
      comment,
      hasGift: false,
      isOwner: false,
      timestamp: now,
    };
  }
  // 0109: 絵文字
  if (code === '0109') {
    return {
      type: 'emoticon',
      userId: parts[6] || '',
      name: parts[7] || parts[6] || 'SOOP',
      comment: parts[3] ? '[絵文字 ' + parts[3] + ']' : '[絵文字]',
      hasGift: false,
      isOwner: false,
      timestamp: now,
    };
  }
  // 0018: 星風船
  if (code === '0018') {
    const amount = Number.parseInt(parts[4] || '0', 10) || 0;
    return {
      type: 'donation',
      userId: parts[2] || '',
      name: parts[3] || parts[2] || 'SOOP',
      comment: '星風船 ' + amount + '個',
      hasGift: true,
      isOwner: false,
      timestamp: now,
    };
  }
  // 0087: アドバルーン
  if (code === '0087') {
    const amount = Number.parseInt(parts[10] || '0', 10) || 0;
    return {
      type: 'donation',
      userId: parts[3] || '',
      name: parts[4] || parts[3] || 'SOOP',
      comment: 'アドバルーン ' + amount + '個',
      hasGift: true,
      isOwner: false,
      timestamp: now,
    };
  }
  // 0093: サブスク
  if (code === '0093') {
    const months = Number.parseInt(parts[4] || '0', 10) || 0;
    return {
      type: 'subscribe',
      userId: parts[2] || '',
      name: parts[3] || parts[2] || 'SOOP',
      comment: months ? 'サブスク ' + months + 'か月目' : 'サブスク',
      hasGift: true,
      isOwner: false,
      timestamp: now,
    };
  }
  // 0104: 運営・枠の通知
  if (code === '0104') {
    const notice = parts[4] || '';
    if (!notice) return null;
    return {
      type: 'notice',
      userId: 'soop',
      name: 'SOOP',
      comment: notice,
      hasGift: false,
      isOwner: true,
      timestamp: now,
    };
  }
  return null;
}

function createChat(channel, handlers) {
  const host = channel.chatDomain;
  const port = channel.chatPort + 1;
  const path = '/Websocket/' + channel.streamerId;
  const key = crypto.randomBytes(16).toString('base64');
  let closed = false;
  let handshake = false;
  let buf = Buffer.alloc(0);
  let localPingTimer = null;

  log('SSLソケット接続開始: ' + host + ':' + port);
  const socket = tls.connect(
    { host, port, servername: host, rejectUnauthorized: false },
    () => {
      if (closed) return;
      log('SSL接続確立。WebSocketアップグレード送信中...');
      socket.write(
        'GET ' +
          path +
          ' HTTP/1.1\r\n' +
          'Host: ' +
          host +
          ':' +
          port +
          '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' +
          key +
          '\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Protocol: chat\r\n' +
          'Origin: https://play.sooplive.co.kr\r\n' +
          'User-Agent: ' +
          UA +
          '\r\n\r\n'
      );
    }
  );
  socket.setTimeout(180000);

  const sendText = (packetStr) => {
    if (closed || !handshake) return;
    socket.write(maskFrame(0x1, Buffer.from(packetStr, 'utf8')));
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (localPingTimer) clearInterval(localPingTimer);
    localPingTimer = null;
    try { socket.end(); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
    handlers.onClose();
  };

  socket.on('timeout', cleanup);
  socket.on('error', (err) => {
    handlers.onError(err);
    cleanup();
  });
  socket.on('close', cleanup);
  socket.on('data', (chunk) => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);

    if (!handshake) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString('utf8');
      buf = buf.slice(idx + 4);
      if (!head.includes('101')) {
        handlers.onError(new Error('WebSocketハンドシェイク失敗'));
        cleanup();
        return;
      }
      handshake = true;
      log('101 Switching Protocols 受信！ログインパケット(0001)送信');
      handlers.onOpen();
      sendText(connectPacket());
    }

    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      const masked = Boolean(buf[1] & 0x80);
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) off += 4;
      if (buf.length < off + len) break;

      let payload = buf.slice(off, off + len);
      if (masked) {
        const mask = buf.slice(off - 4, off);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      buf = buf.slice(off + len);

      // 切断フレーム
      if (opcode === 0x8) {
        cleanup();
        return;
      }
      // ping フレーム -> 正しい pong (0xa) を返送
      if (opcode === 0x9) {
        socket.write(maskFrame(0xa, payload));
        continue;
      }

      // SOOPはテキスト(0x1)またはバイナリ(0x2)で送信してくる
      if (opcode !== 0x1 && opcode !== 0x2) continue;

      const rawText = payload.toString('utf8');

      // 1つのフレームに複数パケットが含まれている可能性があるため、STARTER で分割処理
      const rawPackets = rawText.split(STARTER).filter(Boolean).map(p => STARTER + p);
      for (const packet of rawPackets) {
        const code = packet.length >= 6 ? packet.slice(2, 6) : '';

        // 0001: ログイン認証ACK -> 部屋参加(0002)送信
        if (code === '0001') {
          log('認証ACK(0001)受信！チャットルーム参加(0002)送信 (ChatNo: ' + channel.chatNo + ')');
          sendText(joinPacket(channel.chatNo));
          continue;
        }

        // 0002: 部屋参加完了！
        if (code === '0002') {
          log('● チャットルーム参加成功(0002)！コメント受信スタンバイ完了！');
          handlers.onJoined();
          if (!localPingTimer) {
            localPingTimer = setInterval(() => {
              sendText(pingPacket());
            }, 45000);
          }
          continue;
        }

        // 定期ping応答 (0000) など
        if (code === '0000') continue;

        const event = parseEvent(packet);
        if (event) {
          handlers.onEvent(event);
        } else {
          // コメント以外のパケット（ユーザー参加・統計等）もデバッグ記録
          if (code) log('SOOP受信コード: ' + code);
        }
      }
    }
  });

  return { close: cleanup };
}

async function emitComment(serviceId, event) {
  if (!serviceId) return;
  seq += 1;
  const now = event.timestamp || Date.now();
  const payload = {
    service: {
      id: serviceId,
      write: true,
      speech: true,
      persist: true,
    },
    comment: {
      id: 'soop-' + now + '-' + seq,
      userId: event.userId || 'soop',
      name: event.name || 'SOOP',
      badges: [],
      profileImage: event.userId ? ('https://profile.img.afreecatv.com/LOGO/' + event.userId.slice(0, 2) + '/' + event.userId + '/' + event.userId + '.jpg') : '',
      comment: event.comment,
      hasGift: Boolean(event.hasGift),
      isOwner: Boolean(event.isOwner),
      timestamp: now,
    },
  };
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: '127.0.0.1',
    port: 11180,
    path: '/api/comments',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8')
    }
  }, (res) => {
    if (res.statusCode === 200) {
      log('わんコメへ送信完了 [OK]: ' + event.name + ': ' + event.comment);
    } else {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => log('API Error: ' + res.statusCode + ' ' + data));
    }
  });
  req.on('error', e => log('API Req Error: ' + e.message));
  req.write(body);
  req.end();
}

function disconnect() {
  if (activeSocket) {
    log('切断処理を実行');
    try { activeSocket.close(); } catch (_) {}
    activeSocket = null;
  }
  currentBjid = null;
  currentServiceId = null;
}

async function startSoop(serviceId, bjid) {
  disconnect();
  currentServiceId = serviceId;
  currentBjid = bjid;

  log('配信状態確認中: BJID=' + bjid);
  let channel;
  try {
    channel = await fetchLiveInfo(bjid);
  } catch (err) {
    log('配信情報取得失敗: ' + (err && err.message));
    return;
  }

  if (channel.result === -6) {
    log('年齢制限・非公開枠のためゲスト接続できません (RESULT=-6)');
    return;
  }

  if (!channel.online || !channel.chatDomain || !channel.chatNo) {
    log('配信はオフラインです (' + (channel.title || 'タイトルなし') + ')。枠がONの間、定期確認します。');
    return;
  }

  log('配信中を確認: ' + channel.streamerNick + ' (タイトル: ' + channel.title + ')');
  log('チャットルームへ接続します: ChatNo=' + channel.chatNo);

  activeSocket = createChat(channel, {
    onOpen: () => log('SSL接続完了'),
    onJoined: () => log('★ コメント受信中！わんコメへ送信開始'),
    onEvent: (event) => {
      log('受信 [' + event.name + ']: ' + event.comment);
      emitComment(serviceId, event).catch(() => {});
    },
    onError: (err) => log('チャットエラー: ' + (err && err.message ? err.message : String(err))),
    onClose: () => {
      log('チャット接続が切断されました');
      activeSocket = null;
    },
  });
}

function loadConfig(dir) {
  const targetDir = dir || __dirname;
  const cfgPath = path.join(targetDir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (_) {}
  }
  return {};
}

const plugin = {
  name: 'SOOP (AfreecaTV)',
  uid: 'dev.orangeqoon.soop',
  version: '2.2.0',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-soop',
  permissions: ['comments', 'services'],
  defaultState: {},

  init(ctx) {
    const dir = ctx && ctx.dir ? ctx.dir : __dirname;
    log('SOOPプラグイン起動（自動枠検知・常時安定モード v2.2）');
    this.dir = dir;

    this.timer = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:11180/api/services');
        if (!res.ok) return;
        const services = await res.json();

        // 枠名に SOOP を含む枠、または URL に sooplive/afreecatv/soop を含む枠を探す
        const soopService = services.find((s) => {
          if (!s.enabled) return false;
          const name = (s.name || '').toLowerCase();
          const u = (s.url || '').toLowerCase();
          return name.includes('soop') || u.includes('sooplive.') || u.includes('afreecatv.') || u.includes('/soop/');
        });

        if (!soopService) {
          if (activeSocket || currentBjid) {
            log('SOOP枠がオフになりました。切断します。');
            disconnect();
          }
          return;
        }

        // BJIDの取得: URLから、または config.json から、または枠名から
        let bjid = extractBjid(soopService.url);
        if (!bjid) {
          const cfg = loadConfig(this.dir);
          bjid = cfg.bjid || cfg.streamer_id || '';
        }
        if (!bjid) {
          const m = (soopService.name || '').match(/soop[:\s_]+([a-zA-Z0-9_]{2,32})/i);
          if (m) bjid = m[1];
        }
        if (!bjid) return;

        // 内蔵ブラウザのエラー切断防止（URLが設定されていたら自動クリア）
        if (soopService.url && soopService.url.trim() !== '') {
          fetch('http://localhost:11180/api/services/' + soopService.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...soopService, url: '', meta: {} })
          }).catch(() => {});
        }

        // 枠IDまたはBJIDが切り替わった場合、または未接続の場合に接続開始
        if (currentBjid !== bjid || currentServiceId !== soopService.id || !activeSocket) {
          log('SOOP枠検知: ' + soopService.name + ' (ID: ' + bjid + ') -> 接続処理開始');
          startSoop(soopService.id, bjid);
        }
      } catch (_) {}
    }, 4000);
  },

  destroy() {
    if (this.timer) clearInterval(this.timer);
    disconnect();
  },
};

module.exports = plugin;
