const WebSocket = require('ws');

let socket = null;
let currentServiceId = null;
let currentBjid = null;
let pingInterval = null;

const ServiceCommand = {
  PING: 0, LOGIN: 1, JOIN: 2, CHAT: 5, BALLOON: 18, BALLOON_AD: 87, STREAM_CLOSED: 88
};

function decodeCommand(msg) {
  const header = msg.slice(0, 14);
  const serviceCommand = parseInt(new TextDecoder().decode(header.slice(2, 6)));
  const body = msg.slice(15);
  const bodyParted = new TextDecoder().decode(body).split(String.fromCharCode(12));
  return { serviceCommand, bodyParted };
}

function sendCommand(ws, command, body) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cmd = command.toString().padStart(4, '0');
  const bodyLength = body.length.toString().padStart(6, '0');
  const header = String.fromCharCode(27, 9) + cmd + bodyLength + '00';
  ws.send(Buffer.from(header + body));
}

const plugin = {
  name: 'SOOP (AfreecaTV)',
  uid: 'dev.orangeqoon.soop',
  version: '1.0.0',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-soop',
  permissions: ['comments', 'service'],
  defaultState: {},

  async init({ dir, store }) {
    plugin.log('SOOP 플러그인 시작됨');
    
    setInterval(async () => {
      try {
        const res = await fetch('http://localhost:11180/api/services');
        if (!res.ok) return;
        const services = await res.json();
        
        const soopService = services.find(s => s.url && s.url.includes('sooplive.co.kr'));
        if (!soopService || !soopService.enabled) {
          if (socket) disconnect();
          return;
        }

        const match = soopService.url.match(/sooplive\.co\.kr\/(?:player\/)?([a-zA-Z0-9_]+)/);
        if (!match) return;
        const bjid = match[1];

        if (currentBjid !== bjid) {
          disconnect();
          currentServiceId = soopService.id;
          currentBjid = bjid;
          connectSoop(bjid);
        }
      } catch (err) { }
    }, 3000);
  },

  destroy() {
    disconnect();
  }
};

function disconnect() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (socket) {
    plugin.log('SOOP 연결 종료');
    socket.close();
    socket = null;
  }
  currentBjid = null;
  currentServiceId = null;
}

async function connectSoop(bjid) {
  try {
    plugin.log('SOOP 방송 정보 조회: ' + bjid);
    const formData = new URLSearchParams({
      bid: bjid, type: 'live', pwd: '', player_type: 'html5', stream_type: 'common', mode: 'landing', from_api: '0'
    });
    
    const res = await fetch('https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid=' + bjid, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData
    });
    
    const data = await res.json();
    if (data.CHANNEL && data.CHANNEL.RESULT === 1) {
      const channel = data.CHANNEL;
      const wsUrl = 'wss://' + channel.CHDOMAIN.toLowerCase() + ':' + (parseInt(channel.CHPT) + 1) + '/Websocket/' + channel.BJID;
      plugin.log('SOOP 웹소켓 연결: ' + wsUrl);
      
      socket = new WebSocket(wsUrl, 'chat');
      
      socket.on('open', () => {
        plugin.log('SOOP 웹소켓 연결 성공');
        const buf = Buffer.from([27, 9, 48, 48, 48, 49, 48, 48, 48, 48, 48, 54, 48, 48, 12, 12, 12, 49, 54, 12]);
        socket.send(buf);
        pingInterval = setInterval(() => {
          sendCommand(socket, ServiceCommand.PING, String.fromCharCode(12));
        }, 60000);
      });
      
      socket.on('message', (msg) => {
        const { serviceCommand, bodyParted } = decodeCommand(msg);
        if (serviceCommand === ServiceCommand.CHAT) {
          const content = bodyParted[0];
          const userId = bodyParted[1];
          const nickname = bodyParted[5];
          postComment({
            id: Date.now().toString() + Math.floor(Math.random()*1000),
            name: nickname,
            comment: content,
            profileImage: 'https://profile.img.afreecatv.com/LOGO/' + userId.slice(0, 2) + '/' + userId + '/' + userId + '.jpg',
            badges: []
          });
        }
      });
      
      socket.on('close', () => {
        plugin.log('SOOP 웹소켓 끊어짐');
        disconnect();
      });
      
      socket.on('error', (err) => {
        plugin.log('SOOP 웹소켓 에러: ' + err.message);
      });
    } else {
      plugin.log('방송 중이 아닙니다.');
    }
  } catch (e) {
    plugin.log('SOOP 연결 오류: ' + e.message);
  }
}

async function postComment(commentData) {
  if (!currentServiceId) return;
  try {
    await fetch('http://localhost:11180/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: currentServiceId,
        comments: [Object.assign({}, commentData, {
          hasGift: false, isOwner: false, isModerator: false, isFirstTime: false
        })]
      })
    });
  } catch (err) {}
}

plugin.log = (msg) => { console.info('[soop-plugin] ' + msg); };

module.exports = plugin;
