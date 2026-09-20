// ============================================================
// APOYA BASMA 1v1 - Online Hız Yarışı
// Node.js + Express + Socket.io
// Müzik: Built-in beat veya kendi MP3'ün
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statik dosya sunumu (müzik dosyası için)
app.use(express.static(__dirname));

// ==================== SABITLER ====================
const GAME_DURATION = 60;
const COUNTDOWN_SEC = 5;
const MAX_PLAYERS = 2;

// ==================== MÜZİK DOSYASI ====================
// Kendi müziğini kullanmak istersen aşağıyı düzenle:
// const MUSIC_FILE = 'music.mp3';
const MUSIC_FILE = 'music.mp3';

// ==================== OYUN SINIFI ====================
class ApoyaGame {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.gameState = 'waiting';
        this.countdownLeft = COUNTDOWN_SEC;
        this.timeLeft = GAME_DURATION;
        this.timer = null;
        this.scores = [0, 0];
        this.clickTimestamps = [[], []];
        this.winner = null;
    }

    addPlayer(socketId, name) {
        if (this.players.length >= MAX_PLAYERS) return false;
        if (this.players.find(p => p.socketId === socketId)) return false;
        this.players.push({
            socketId,
            name: name || ('Oyuncu ' + (this.players.length + 1)),
            seatIndex: this.players.length,
            isReady: false,
            score: 0,
            clicks: 0
        });
        return true;
    }

    removePlayer(socketId) {
        const idx = this.players.findIndex(p => p.socketId === socketId);
        if (idx !== -1) {
            this.players.splice(idx, 1);
            this.players.forEach((p, i) => p.seatIndex = i);
            return true;
        }
        return false;
    }

    setReady(socketId) {
        const p = this.players.find(pl => pl.socketId === socketId);
        if (p) p.isReady = true;
    }

    allReady() {
        return this.players.length === MAX_PLAYERS && this.players.every(p => p.isReady);
    }

    startCountdown() {
        this.gameState = 'countdown';
        this.countdownLeft = COUNTDOWN_SEC;
        this.scores = [0, 0];
        this.clickTimestamps = [[], []];
        this.players.forEach(p => { p.score = 0; p.clicks = 0; });
        this.winner = null;
        this.broadcastAll();

        this.timer = setInterval(() => {
            this.countdownLeft--;
            io.to(this.roomId).emit('countdown', this.countdownLeft);
            if (this.countdownLeft <= 0) {
                clearInterval(this.timer);
                this.startPlaying();
            }
        }, 1000);
    }

    startPlaying() {
        this.gameState = 'playing';
        this.timeLeft = GAME_DURATION;
        this.broadcastAll();
        io.to(this.roomId).emit('game_start');

        this.timer = setInterval(() => {
            this.timeLeft--;
            io.to(this.roomId).emit('timer', this.timeLeft);
            if (this.timeLeft <= 0) {
                clearInterval(this.timer);
                this.endGame();
            }
        }, 1000);
    }

    registerClick(seatIndex) {
        if (this.gameState !== 'playing') return false;
        if (seatIndex < 0 || seatIndex >= this.players.length) return false;

        const now = Date.now();
        const timestamps = this.clickTimestamps[seatIndex];

        // Anti-cheat: 80ms içinde çift tıklama engelle
        const recentClicks = timestamps.filter(t => now - t < 80);
        if (recentClicks.length >= 2) return false;

        timestamps.push(now);
        // Bellek temizliği
        if (timestamps.length > 50) {
            this.clickTimestamps[seatIndex] = timestamps.filter(t => now - t < 2000);
        }

        this.players[seatIndex].score++;
        this.players[seatIndex].clicks++;

        io.to(this.roomId).emit('score_update', {
            scores: this.players.map(p => p.score),
            lastClicker: seatIndex
        });

        return true;
    }

    endGame() {
        this.gameState = 'finished';
        const s0 = this.players[0] ? this.players[0].score : 0;
        const s1 = this.players[1] ? this.players[1].score : 0;

        if (s0 > s1) this.winner = this.players[0].name;
        else if (s1 > s0) this.winner = this.players[1].name;
        else this.winner = 'Berabere!';

        io.to(this.roomId).emit('game_over', {
            winner: this.winner,
            scores: this.players.map(p => ({ name: p.name, score: p.score, clicks: p.clicks }))
        });
        this.broadcastAll();
    }

    resetForRematch() {
        this.gameState = 'waiting';
        this.scores = [0, 0];
        this.clickTimestamps = [[], []];
        this.players.forEach(p => { p.isReady = false; p.score = 0; p.clicks = 0; });
        this.winner = null;
        this.broadcastAll();
    }

    getState(requestingSocketId) {
        const reqP = this.players.find(p => p.socketId === requestingSocketId);
        const mySeat = reqP ? reqP.seatIndex : -1;

        return {
            roomId: this.roomId,
            gameState: this.gameState,
            players: this.players.map(p => ({
                name: p.name,
                seatIndex: p.seatIndex,
                isReady: p.isReady,
                score: p.score,
                clicks: p.clicks
            })),
            scores: this.players.map(p => p.score),
            timeLeft: this.timeLeft,
            countdownLeft: this.countdownLeft,
            winner: this.winner,
            mySeat
        };
    }

    broadcastAll() {
        this.players.forEach(p => {
            io.to(p.socketId).emit('game_state', this.getState(p.socketId));
        });
    }
}

// ==================== ODA YÖNETİMİ ====================
const rooms = new Map();
const socketRoomMap = new Map();

function genRoomId() {
    // 6 haneli oda kodu üretir
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Baglandi: ' + socket.id);

    socket.on('create_room', (name) => {
        const rid = genRoomId();
        const room = new ApoyaGame(rid);
        room.addPlayer(socket.id, name);
        rooms.set(rid, room);
        socket.join(rid);
        socketRoomMap.set(socket.id, rid);
        socket.emit('room_joined', { roomId: rid, seatIndex: 0 });
        room.broadcastAll();
    });

    socket.on('join_room', (data) => {
        const rid = data.roomId.toUpperCase();
        const room = rooms.get(rid);
        if (!room) return socket.emit('error_msg', 'Oda bulunamadi!');
        if (room.players.length >= MAX_PLAYERS) return socket.emit('error_msg', 'Oda dolu! 1v1 sadece.');
        if (room.gameState !== 'waiting') return socket.emit('error_msg', 'Oyun baslamis!');
        room.addPlayer(socket.id, data.playerName);
        socket.join(rid);
        socketRoomMap.set(socket.id, rid);
        socket.emit('room_joined', { roomId: rid, seatIndex: room.players.length - 1 });
        room.broadcastAll();
    });

    socket.on('player_ready', () => {
        const rid = socketRoomMap.get(socket.id);
        const room = rooms.get(rid);
        if (!room || room.gameState !== 'waiting') return;
        room.setReady(socket.id);
        room.broadcastAll();
        if (room.allReady()) {
            room.startCountdown();
        }
    });

    socket.on('click_apoya', () => {
        const rid = socketRoomMap.get(socket.id);
        const room = rooms.get(rid);
        if (!room) return;
        const p = room.players.find(pl => pl.socketId === socket.id);
        if (!p) return;
        room.registerClick(p.seatIndex);
    });

    socket.on('rematch', () => {
        const rid = socketRoomMap.get(socket.id);
        const room = rooms.get(rid);
        if (!room || room.gameState !== 'finished') return;
        const p = room.players.find(pl => pl.socketId === socket.id);
        if (p) p.isReady = true;
        room.broadcastAll();
        if (room.players.every(pl => pl.isReady)) {
            room.resetForRematch();
            setTimeout(() => room.startCountdown(), 500);
        }
    });

    socket.on('disconnect', () => {
        const rid = socketRoomMap.get(socket.id);
        if (rid) {
            const room = rooms.get(rid);
            if (room) {
                room.removePlayer(socket.id);
                if (room.players.length === 0) {
                    if (room.timer) clearInterval(room.timer);
                    rooms.delete(rid);
                } else {
                    if (room.gameState === 'playing' || room.gameState === 'countdown') {
                        if (room.timer) clearInterval(room.timer);
                        room.gameState = 'finished';
                        room.winner = 'Rakip ayrildi!';
                        io.to(rid).emit('game_over', {
                            winner: room.winner,
                            scores: room.players.map(p => ({ name: p.name, score: p.score, clicks: p.clicks }))
                        });
                    }
                    room.broadcastAll();
                }
            }
            socketRoomMap.delete(socket.id);
        }
    });
});

// ==================== FRONTEND HTML ====================
app.get('/', (req, res) => res.send(getHTML()));

function getHTML() {
    const musicLine = MUSIC_FILE
        ? "bgMusicEl.src = '" + MUSIC_FILE + "';"
        : "// Built-in beat kullanilacak";

    const musicPlayLine = MUSIC_FILE
        ? "bgMusicEl.play().catch(function(){});"
        : "startBeat();";

    return '<!DOCTYPE html>\n' +
'<html lang="tr">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>APOYA BASMA 1v1</title>\n' +
'<script src="/socket.io/socket.io.js"></script>\n' +
'<style>\n' +
'*{margin:0;padding:0;box-sizing:border-box;user-select:none;-webkit-user-select:none;}\n' +
'body{font-family:"Segoe UI",sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;overflow:hidden;}\n' +
'\n' +
'/* LOBBY */\n' +
'.lobby{display:flex;justify-content:center;align-items:center;min-height:100vh;background:radial-gradient(circle at center,#1a1a2e,#0a0a0a);}\n' +
'.lcard{background:rgba(255,255,255,.05);backdrop-filter:blur(15px);border-radius:24px;padding:45px;width:420px;text-align:center;border:1px solid rgba(255,255,255,.1);}\n' +
'.lcard h1{font-size:2.8em;margin-bottom:5px;background:linear-gradient(90deg,#ff6b6b,#feca57,#ff6b6b);background-size:200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 2s infinite;}\n' +
'@keyframes shimmer{0%{background-position:0%;}100%{background-position:200%;}}\n' +
'.lcard .sub{color:rgba(255,255,255,.4);margin-bottom:30px;font-size:.9em;}\n' +
'.inp{width:100%;padding:14px 18px;border:2px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.06);color:#fff;font-size:16px;margin-bottom:12px;transition:.3s;}\n' +
'.inp:focus{outline:none;border-color:#ff6b6b;background:rgba(255,255,255,.1);}\n' +
'.inp::placeholder{color:rgba(255,255,255,.25);}\n' +
'.btn{width:100%;padding:15px;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer;transition:.3s;text-transform:uppercase;letter-spacing:2px;margin-top:8px;}\n' +
'.btn:hover{transform:translateY(-3px);box-shadow:0 8px 25px rgba(0,0,0,.4);}\n' +
'.btn:active{transform:translateY(0);}\n' +
'.btn-r{background:linear-gradient(135deg,#ff6b6b,#ee5a24);color:#fff;}\n' +
'.btn-b{background:linear-gradient(135deg,#4facfe,#00f2fe);color:#0a0a0a;}\n' +
'.btn-g{background:linear-gradient(135deg,#feca57,#ff9f43);color:#0a0a0a;}\n' +
'.btn-p{background:linear-gradient(135deg,#a29bfe,#6c5ce7);color:#fff;}\n' +
'.divider{display:flex;align-items:center;margin:20px 0;color:rgba(255,255,255,.3);}\n' +
'.divider::before,.divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.1);}\n' +
'.divider span{padding:0 15px;font-size:.85em;}\n' +
'\n' +
'/* WAITING */\n' +
'.waiting{display:none;justify-content:center;align-items:center;min-height:100vh;background:radial-gradient(circle at center,#1a1a2e,#0a0a0a);}\n' +
'.wcard{background:rgba(255,255,255,.05);backdrop-filter:blur(15px);border-radius:24px;padding:45px;width:480px;text-align:center;border:1px solid rgba(255,255,255,.1);}\n' +
'.rcode{font-size:3.5em;font-weight:900;color:#feca57;letter-spacing:10px;margin:15px 0;text-shadow:0 0 30px rgba(254,202,87,.3);}\n' +
'.vs-display{display:flex;justify-content:center;align-items:center;gap:30px;margin:25px 0;}\n' +
'.vs-player{text-align:center;padding:20px;border-radius:16px;background:rgba(255,255,255,.04);border:2px solid rgba(255,255,255,.08);min-width:140px;transition:.3s;}\n' +
'.vs-player.ready{border-color:#2ecc71;background:rgba(46,204,113,.1);box-shadow:0 0 20px rgba(46,204,113,.2);}\n' +
'.vs-player .pname{font-weight:700;font-size:1.1em;margin-bottom:5px;}\n' +
'.vs-player .pstatus{font-size:.8em;color:rgba(255,255,255,.4);}\n' +
'.vs-text{font-size:2.5em;font-weight:900;color:rgba(255,255,255,.15);}\n' +
'\n' +
'/* GAME */\n' +
'.game{display:none;width:100vw;height:100vh;position:relative;background:#0a0a0a;}\n' +
'.game-bg{position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(circle at 50% 50%,#1a1a2e,#0a0a0a);transition:background .1s;}\n' +
'.game-bg.pulse-red{background:radial-gradient(circle at 50% 50%,#2d1111,#0a0a0a);}\n' +
'.game-bg.pulse-blue{background:radial-gradient(circle at 50% 50%,#0d1b2a,#0a0a0a);}\n' +
'\n' +
'/* SCOREBOARD */\n' +
'.scoreboard{position:absolute;top:0;left:0;right:0;height:120px;display:flex;justify-content:space-between;align-items:center;padding:0 40px;z-index:10;}\n' +
'.sb-player{display:flex;flex-direction:column;align-items:center;min-width:200px;}\n' +
'.sb-name{font-size:1em;color:rgba(255,255,255,.6);margin-bottom:5px;}\n' +
'.sb-score{font-size:4em;font-weight:900;line-height:1;transition:transform .05s;}\n' +
'.sb-score.pop{transform:scale(1.3);}\n' +
'.sb-score.red{color:#ff6b6b;text-shadow:0 0 30px rgba(255,107,107,.4);}\n' +
'.sb-score.blue{color:#4facfe;text-shadow:0 0 30px rgba(79,172,254,.4);}\n' +
'.sb-bar{width:200px;height:6px;background:rgba(255,255,255,.1);border-radius:3px;margin-top:8px;overflow:hidden;}\n' +
'.sb-fill{height:100%;border-radius:3px;transition:width .1s;}\n' +
'.sb-fill.red{background:#ff6b6b;}\n' +
'.sb-fill.blue{background:#4facfe;}\n' +
'\n' +
'/* TIMER */\n' +
'.timer-center{position:absolute;top:30px;left:50%;transform:translateX(-50%);text-align:center;z-index:10;}\n' +
'.timer-val{font-size:3em;font-weight:900;color:#feca57;text-shadow:0 0 20px rgba(254,202,87,.3);}\n' +
'.timer-val.urgent{color:#ff6b6b;animation:tpulse .5s infinite;}\n' +
'@keyframes tpulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.6;transform:scale(1.1);}}\n' +
'.timer-label{font-size:.75em;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:3px;}\n' +
'\n' +
'/* COUNTDOWN OVERLAY */\n' +
'.cd-overlay{position:fixed;top:0;left:0;right:0;bottom:0;display:none;justify-content:center;align-items:center;background:rgba(0,0,0,.85);z-index:100;}\n' +
'.cd-overlay.show{display:flex;}\n' +
'.cd-num{font-size:12em;font-weight:900;color:#feca57;text-shadow:0 0 60px rgba(254,202,87,.5);animation:cdPop .8s ease-out;}\n' +
'@keyframes cdPop{0%{transform:scale(3);opacity:0;}50%{transform:scale(.9);opacity:1;}100%{transform:scale(1);}}\n' +
'\n' +
'/* APOYA BUTTON */\n' +
'.apoya-container{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:20;}\n' +
'.apoya-btn{width:220px;height:220px;border-radius:50%;border:6px solid rgba(255,255,255,.15);background:radial-gradient(circle at 40% 35%,#ff6b6b,#c0392b);cursor:pointer;transition:all .05s;box-shadow:0 0 40px rgba(255,107,107,.3),inset 0 -8px 20px rgba(0,0,0,.3);display:flex;justify-content:center;align-items:center;flex-direction:column;position:relative;-webkit-tap-highlight-color:transparent;}\n' +
'.apoya-btn:active,.apoya-btn.pressed{transform:scale(.92);box-shadow:0 0 60px rgba(255,107,107,.6),inset 0 -4px 10px rgba(0,0,0,.3);border-color:rgba(255,255,255,.4);}\n' +
'.apoya-btn .label{font-size:1.4em;font-weight:900;color:#fff;text-transform:uppercase;letter-spacing:3px;text-shadow:0 2px 4px rgba(0,0,0,.3);pointer-events:none;text-align:center;line-height:1.3;}\n' +
'.apoya-btn .sublabel{font-size:.7em;color:rgba(255,255,255,.7);margin-top:5px;pointer-events:none;}\n' +
'.apoya-ring{position:absolute;top:-15px;left:-15px;right:-15px;bottom:-15px;border-radius:50%;border:3px solid rgba(255,107,107,.2);animation:ringPulse 2s infinite;pointer-events:none;}\n' +
'@keyframes ringPulse{0%{transform:scale(1);opacity:.5;}100%{transform:scale(1.3);opacity:0;}}\n' +
'.apoya-btn.disabled{opacity:.3;cursor:not-allowed;filter:grayscale(1);}\n' +
'.apoya-btn.disabled:active{transform:none;box-shadow:0 0 40px rgba(255,107,107,.3);}\n' +
'\n' +
'/* CLICK EFFECTS */\n' +
'.click-fx{position:absolute;pointer-events:none;font-weight:900;font-size:1.5em;color:#feca57;animation:floatUp .6s ease-out forwards;z-index:30;}\n' +
'@keyframes floatUp{0%{opacity:1;transform:translateY(0) scale(1);}100%{opacity:0;transform:translateY(-80px) scale(1.5);}}\n' +
'\n' +
'/* PARTICLES */\n' +
'.particle{position:absolute;width:6px;height:6px;border-radius:50%;pointer-events:none;animation:particleFly .5s ease-out forwards;z-index:25;}\n' +
'@keyframes particleFly{0%{opacity:1;transform:translate(0,0) scale(1);}100%{opacity:0;transform:translate(var(--tx),var(--ty)) scale(0);}}\n' +
'\n' +
'/* RESULT MODAL */\n' +
'.result-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:200;justify-content:center;align-items:center;}\n' +
'.result-overlay.show{display:flex;}\n' +
'.result-card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:24px;padding:50px;text-align:center;border:2px solid rgba(255,255,255,.1);max-width:500px;width:90%;animation:resultIn .5s ease-out;}\n' +
'@keyframes resultIn{from{transform:scale(.8);opacity:0;}to{transform:scale(1);opacity:1;}}\n' +
'.result-title{font-size:2.5em;font-weight:900;margin-bottom:10px;}\n' +
'.result-title.win{color:#2ecc71;text-shadow:0 0 30px rgba(46,204,113,.4);}\n' +
'.result-title.lose{color:#ff6b6b;text-shadow:0 0 30px rgba(255,107,107,.4);}\n' +
'.result-title.draw{color:#feca57;text-shadow:0 0 30px rgba(254,202,87,.4);}\n' +
'.result-scores{display:flex;justify-content:center;gap:40px;margin:25px 0;}\n' +
'.rs-col{text-align:center;}\n' +
'.rs-col .rs-name{font-size:.9em;color:rgba(255,255,255,.5);margin-bottom:5px;}\n' +
'.rs-col .rs-val{font-size:3em;font-weight:900;}\n' +
'.result-actions{display:flex;gap:10px;margin-top:25px;}\n' +
'\n' +
'/* NOTIF */\n' +
'.notif{position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:12px;font-weight:600;z-index:1000;animation:slideR .3s ease-out;max-width:320px;}\n' +
'@keyframes slideR{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}\n' +
'.notif.error{background:#e74c3c;color:#fff;}\n' +
'.notif.success{background:#2ecc71;color:#fff;}\n' +
'.notif.info{background:#3498db;color:#fff;}\n' +
'\n' +
'/* VOLUME */\n' +
'.vol-ctrl{position:absolute;bottom:20px;right:20px;z-index:50;display:flex;align-items:center;gap:8px;}\n' +
'.vol-ctrl label{font-size:.8em;color:rgba(255,255,255,.4);}\n' +
'.vol-ctrl input[type=range]{width:100px;accent-color:#feca57;}\n' +
'\n' +
'@media(max-width:600px){\n' +
'.apoya-btn{width:180px;height:180px;}\n' +
'.apoya-btn .label{font-size:1.1em;}\n' +
'.sb-score{font-size:3em;}\n' +
'.scoreboard{padding:0 15px;}\n' +
'.timer-val{font-size:2.2em;}\n' +
'}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'\n' +
'<audio id="bgMusic" loop></audio>\n' +
'\n' +
'<!-- LOBBY -->\n' +
'<div id="lobby" class="lobby">\n' +
'<div class="lcard">\n' +
'<h1>APOYA BAS</h1>\n' +
'<p class="sub">1v1 Hiz Yarisi - 60 Saniye - Kim Daha Fazla Basar?</p>\n' +
'<input class="inp" id="nameInp" placeholder="Adini yaz..." maxlength="15">\n' +
'<button class="btn btn-r" onclick="createRoom()">Oda Olustur</button>\n' +
'<div class="divider"><span>veya</span></div>\n' +
'<input class="inp" id="codeInp" placeholder="Oda kodu (6 hane)..." maxlength="6" style="text-transform:uppercase;">\n' +
'<button class="btn btn-b" onclick="joinRoom()">Rakibe Katil</button>\n' +
'</div>\n' +
'</div>\n' +
'\n' +
'<!-- WAITING -->\n' +
'<div id="waitingScr" class="waiting">\n' +
'<div class="wcard">\n' +
'<h2 style="margin-bottom:5px;">Rakip Bekleniyor</h2>\n' +
'<p style="color:rgba(255,255,255,.4);font-size:.85em;">Oda kodunu paylas:</p>\n' +
'<div class="rcode" id="dispCode">------</div>\n' +
'<div class="vs-display">\n' +
'<div class="vs-player" id="vs0"><div class="pname">---</div><div class="pstatus">Bekliyor...</div></div>\n' +
'<div class="vs-text">VS</div>\n' +
'<div class="vs-player" id="vs1"><div class="pname">---</div><div class="pstatus">Bekliyor...</div></div>\n' +
'</div>\n' +
'<button class="btn btn-g" id="readyBtn" onclick="toggleReady()">HAZIRIM</button>\n' +
'</div>\n' +
'</div>\n' +
'\n' +
'<!-- GAME -->\n' +
'<div id="gameScr" class="game">\n' +
'<div class="game-bg" id="gameBg"></div>\n' +
'<div class="scoreboard">\n' +
'<div class="sb-player">\n' +
'<div class="sb-name" id="sbName0">Oyuncu 1</div>\n' +
'<div class="sb-score red" id="sbScore0">0</div>\n' +
'<div class="sb-bar"><div class="sb-fill red" id="sbFill0" style="width:0%"></div></div>\n' +
'</div>\n' +
'<div class="sb-player">\n' +
'<div class="sb-name" id="sbName1">Oyuncu 2</div>\n' +
'<div class="sb-score blue" id="sbScore1">0</div>\n' +
'<div class="sb-bar"><div class="sb-fill blue" id="sbFill1" style="width:0%"></div></div>\n' +
'</div>\n' +
'</div>\n' +
'<div class="timer-center">\n' +
'<div class="timer-label">Kalan Sure</div>\n' +
'<div class="timer-val" id="timerVal">60</div>\n' +
'</div>\n' +
'<div class="apoya-container">\n' +
'<div class="apoya-btn disabled" id="apoyaBtn">\n' +
'<div class="apoya-ring"></div>\n' +
'<div class="label">APOYA<br>BAS!</div>\n' +
'<div class="sublabel">SPACE / TIKLA</div>\n' +
'</div>\n' +
'</div>\n' +
'<div class="vol-ctrl">\n' +
'<label>Muzik</label>\n' +
'<input type="range" min="0" max="100" value="40" oninput="setVolume(this.value)">\n' +
'</div>\n' +
'</div>\n' +
'\n' +
'<!-- COUNTDOWN -->\n' +
'<div class="cd-overlay" id="cdOverlay">\n' +
'<div class="cd-num" id="cdNum">5</div>\n' +
'</div>\n' +
'\n' +
'<!-- RESULT -->\n' +
'<div class="result-overlay" id="resultOverlay">\n' +
'<div class="result-card">\n' +
'<div class="result-title" id="resTitle">SONUC</div>\n' +
'<div class="result-scores" id="resScores"></div>\n' +
'<div class="result-actions">\n' +
'<button class="btn btn-g" onclick="requestRematch()" style="flex:1;">Tekrar Oyna</button>\n' +
'<button class="btn btn-p" onclick="location.reload()" style="flex:1;">Lobiye Don</button>\n' +
'</div>\n' +
'</div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'var socket = io();\n' +
'var mySeat = -1;\n' +
'var roomId = "";\n' +
'var gState = null;\n' +
'var isReady = false;\n' +
'var audioCtx = null;\n' +
'var musicGain = null;\n' +
'var clickGain = null;\n' +
'var bgMusicEl = document.getElementById("bgMusic");\n' +
'var isPlaying = false;\n' +
'var beatInterval = null;\n' +
'\n' +
'// SES MOTORU\n' +
'function initAudio() {\n' +
'    if (audioCtx) return;\n' +
'    audioCtx = new (window.AudioContext || window.webkitAudioContext)();\n' +
'    musicGain = audioCtx.createGain();\n' +
'    musicGain.gain.value = 0.4;\n' +
'    musicGain.connect(audioCtx.destination);\n' +
'    clickGain = audioCtx.createGain();\n' +
'    clickGain.gain.value = 0.6;\n' +
'    clickGain.connect(audioCtx.destination);\n' +
'}\n' +
'\n' +
'function startBeat() {\n' +
'    if (!audioCtx) initAudio();\n' +
'    if (beatInterval) return;\n' +
'    var bpm = 140;\n' +
'    var interval = 60000 / bpm;\n' +
'    var step = 0;\n' +
'    beatInterval = setInterval(function() {\n' +
'        if (!isPlaying) return;\n' +
'        var osc = audioCtx.createOscillator();\n' +
'        var gain = audioCtx.createGain();\n' +
'        osc.connect(gain);\n' +
'        gain.connect(musicGain);\n' +
'        if (step % 4 === 0) {\n' +
'            osc.frequency.setValueAtTime(150, audioCtx.currentTime);\n' +
'            osc.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + 0.1);\n' +
'            gain.gain.setValueAtTime(1, audioCtx.currentTime);\n' +
'            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);\n' +
'            osc.start(audioCtx.currentTime);\n' +
'            osc.stop(audioCtx.currentTime + 0.15);\n' +
'        } else if (step % 4 === 2) {\n' +
'            osc.type = "square";\n' +
'            osc.frequency.setValueAtTime(200, audioCtx.currentTime);\n' +
'            gain.gain.setValueAtTime(0.5, audioCtx.currentTime);\n' +
'            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);\n' +
'            osc.start(audioCtx.currentTime);\n' +
'            osc.stop(audioCtx.currentTime + 0.1);\n' +
'        } else if (step % 2 === 1) {\n' +
'            osc.type = "sawtooth";\n' +
'            osc.frequency.setValueAtTime(8000, audioCtx.currentTime);\n' +
'            gain.gain.setValueAtTime(0.15, audioCtx.currentTime);\n' +
'            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);\n' +
'            osc.start(audioCtx.currentTime);\n' +
'            osc.stop(audioCtx.currentTime + 0.05);\n' +
'        }\n' +
'        if (step % 8 === 0) {\n' +
'            var bass = audioCtx.createOscillator();\n' +
'            var bGain = audioCtx.createGain();\n' +
'            bass.connect(bGain);\n' +
'            bGain.connect(musicGain);\n' +
'            bass.frequency.setValueAtTime(55, audioCtx.currentTime);\n' +
'            bGain.gain.setValueAtTime(0.6, audioCtx.currentTime);\n' +
'            bGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);\n' +
'            bass.start(audioCtx.currentTime);\n' +
'            bass.stop(audioCtx.currentTime + 0.3);\n' +
'        }\n' +
'        step++;\n' +
'    }, interval / 2);\n' +
'}\n' +
'\n' +
'function stopBeat() {\n' +
'    if (beatInterval) { clearInterval(beatInterval); beatInterval = null; }\n' +
'}\n' +
'\n' +
'function playClickSound() {\n' +
'    if (!audioCtx) initAudio();\n' +
'    var osc = audioCtx.createOscillator();\n' +
'    var gain = audioCtx.createGain();\n' +
'    osc.connect(gain);\n' +
'    gain.connect(clickGain);\n' +
'    osc.frequency.setValueAtTime(800 + Math.random() * 400, audioCtx.currentTime);\n' +
'    osc.type = "sine";\n' +
'    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);\n' +
'    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);\n' +
'    osc.start(audioCtx.currentTime);\n' +
'    osc.stop(audioCtx.currentTime + 0.08);\n' +
'}\n' +
'\n' +
'function playCountdownBeep() {\n' +
'    if (!audioCtx) initAudio();\n' +
'    var osc = audioCtx.createOscillator();\n' +
'    var gain = audioCtx.createGain();\n' +
'    osc.connect(gain);\n' +
'    gain.connect(audioCtx.destination);\n' +
'    osc.frequency.value = 880;\n' +
'    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);\n' +
'    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);\n' +
'    osc.start(audioCtx.currentTime);\n' +
'    osc.stop(audioCtx.currentTime + 0.2);\n' +
'}\n' +
'\n' +
'function playWinSound() {\n' +
'    if (!audioCtx) initAudio();\n' +
'    var notes = [523, 659, 784, 1047];\n' +
'    for (var i = 0; i < notes.length; i++) {\n' +
'        (function(freq, delay) {\n' +
'            var osc = audioCtx.createOscillator();\n' +
'            var gain = audioCtx.createGain();\n' +
'            osc.connect(gain);\n' +
'            gain.connect(audioCtx.destination);\n' +
'            osc.frequency.value = freq;\n' +
'            gain.gain.setValueAtTime(0.3, audioCtx.currentTime + delay);\n' +
'            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + delay + 0.4);\n' +
'            osc.start(audioCtx.currentTime + delay);\n' +
'            osc.stop(audioCtx.currentTime + delay + 0.4);\n' +
'        })(notes[i], i * 0.15);\n' +
'    }\n' +
'}\n' +
'\n' +
'function setVolume(val) {\n' +
'    var v = val / 100;\n' +
'    if (musicGain) musicGain.gain.value = v;\n' +
'    bgMusicEl.volume = v;\n' +
'}\n' +
'\n' + musicLine + '\n' +
'\n' +
'// SOCKET OLAYLARI\n' +
'socket.on("room_joined", function(d) {\n' +
'    roomId = d.roomId;\n' +
'    mySeat = d.seatIndex;\n' +
'    showScreen("waitingScr");\n' +
'    document.getElementById("dispCode").textContent = roomId;\n' +
'});\n' +
'\n' +
'socket.on("game_state", function(s) {\n' +
'    gState = s;\n' +
'    updateWaiting(s);\n' +
'    if (s.gameState === "playing" || s.gameState === "countdown") {\n' +
'        showScreen("gameScr");\n' +
'        renderGame(s);\n' +
'    }\n' +
'});\n' +
'\n' +
'socket.on("countdown", function(n) {\n' +
'    var overlay = document.getElementById("cdOverlay");\n' +
'    var num = document.getElementById("cdNum");\n' +
'    overlay.classList.add("show");\n' +
'    num.textContent = n > 0 ? n : "BAS!";\n' +
'    num.style.animation = "none";\n' +
'    void num.offsetWidth;\n' +
'    num.style.animation = "cdPop .8s ease-out";\n' +
'    playCountdownBeep();\n' +
'    if (n <= 0) setTimeout(function() { overlay.classList.remove("show"); }, 800);\n' +
'});\n' +
'\n' +
'socket.on("game_start", function() {\n' +
'    isPlaying = true;\n' + musicPlayLine + '\n' +
'    enableButton();\n' +
'    notify("BASLADI! BAS BAS BAS!", "success");\n' +
'});\n' +
'\n' +
'socket.on("timer", function(t) {\n' +
'    var el = document.getElementById("timerVal");\n' +
'    el.textContent = t;\n' +
'    if (t <= 10) el.classList.add("urgent");\n' +
'    else el.classList.remove("urgent");\n' +
'});\n' +
'\n' +
'socket.on("score_update", function(d) {\n' +
'    updateScores(d.scores, d.lastClicker);\n' +
'});\n' +
'\n' +
'socket.on("game_over", function(d) {\n' +
'    isPlaying = false;\n' +
'    stopBeat();\n' +
'    bgMusicEl.pause();\n' +
'    showResult(d);\n' +
'    playWinSound();\n' +
'});\n' +
'\n' +
'socket.on("error_msg", function(m) { notify(m, "error"); });\n' +
'socket.on("disconnect", function() { notify("Baglanti koptu!", "error"); });\n' +
'\n' +
'// EKRAN YONETIMI\n' +
'function showScreen(id) {\n' +
'    var screens = ["lobby", "waitingScr", "gameScr"];\n' +
'    for (var i = 0; i < screens.length; i++) {\n' +
'        document.getElementById(screens[i]).style.display = "none";\n' +
'    }\n' +
'    var el = document.getElementById(id);\n' +
'    el.style.display = id === "gameScr" ? "block" : "flex";\n' +
'}\n' +
'\n' +
'// LOBBY\n' +
'function createRoom() {\n' +
'    initAudio();\n' +
'    var n = document.getElementById("nameInp").value.trim();\n' +
'    if (!n) return notify("Ad gir!", "error");\n' +
'    socket.emit("create_room", n);\n' +
'}\n' +
'\n' +
'function joinRoom() {\n' +
'    initAudio();\n' +
'    var n = document.getElementById("nameInp").value.trim();\n' +
'    var c = document.getElementById("codeInp").value.trim().toUpperCase();\n' +
'    if (!n || !c) return notify("Ad ve kod gerekli!", "error");\n' +
'    socket.emit("join_room", { roomId: c, playerName: n });\n' +
'}\n' +
'\n' +
'function toggleReady() {\n' +
'    isReady = !isReady;\n' +
'    var btn = document.getElementById("readyBtn");\n' +
'    btn.textContent = isReady ? "HAZIR" : "HAZIRIM";\n' +
'    btn.className = isReady ? "btn btn-p" : "btn btn-g";\n' +
'    socket.emit("player_ready");\n' +
'}\n' +
'\n' +
'// WAITING RENDER\n' +
'function updateWaiting(s) {\n' +
'    for (var i = 0; i < 2; i++) {\n' +
'        var el = document.getElementById("vs" + i);\n' +
'        if (s.players[i]) {\n' +
'            el.classList.add("filled");\n' +
'            if (s.players[i].isReady) el.classList.add("ready");\n' +
'            else el.classList.remove("ready");\n' +
'            el.querySelector(".pname").textContent = s.players[i].name + (i === mySeat ? " (Sen)" : "");\n' +
'            el.querySelector(".pstatus").textContent = s.players[i].isReady ? "Hazir" : "Bekliyor...";\n' +
'        } else {\n' +
'            el.classList.remove("filled", "ready");\n' +
'            el.querySelector(".pname").textContent = "???";\n' +
'            el.querySelector(".pstatus").textContent = "Rakip bekleniyor...";\n' +
'        }\n' +
'    }\n' +
'}\n' +
'\n' +
'// GAME RENDER\n' +
'function renderGame(s) {\n' +
'    var oppSeat = mySeat === 0 ? 1 : 0;\n' +
'    document.getElementById("sbName0").textContent = s.players[mySeat] ? s.players[mySeat].name + " (Sen)" : "?";\n' +
'    document.getElementById("sbName1").textContent = s.players[oppSeat] ? s.players[oppSeat].name : "?";\n' +
'    document.getElementById("sbScore0").textContent = s.players[mySeat] ? s.players[mySeat].score : 0;\n' +
'    document.getElementById("sbScore1").textContent = s.players[oppSeat] ? s.players[oppSeat].score : 0;\n' +
'    document.getElementById("timerVal").textContent = s.timeLeft;\n' +
'    if (s.gameState === "countdown") disableButton();\n' +
'}\n' +
'\n' +
'function updateScores(scores, lastClicker) {\n' +
'    var myScore = scores[mySeat] || 0;\n' +
'    var oppSeat = mySeat === 0 ? 1 : 0;\n' +
'    var oppScore = scores[oppSeat] || 0;\n' +
'    var maxScore = Math.max(myScore, oppScore, 1);\n' +
'    var s0 = document.getElementById("sbScore0");\n' +
'    var s1 = document.getElementById("sbScore1");\n' +
'    s0.textContent = myScore;\n' +
'    s1.textContent = oppScore;\n' +
'    document.getElementById("sbFill0").style.width = (myScore / Math.max(maxScore * 1.2, 100) * 100) + "%";\n' +
'    document.getElementById("sbFill1").style.width = (oppScore / Math.max(maxScore * 1.2, 100) * 100) + "%";\n' +
'    if (lastClicker === mySeat) {\n' +
'        s0.classList.add("pop");\n' +
'        setTimeout(function() { s0.classList.remove("pop"); }, 50);\n' +
'        spawnClickFx();\n' +
'        spawnParticles();\n' +
'        flashBg("red");\n' +
'    } else {\n' +
'        s1.classList.add("pop");\n' +
'        setTimeout(function() { s1.classList.remove("pop"); }, 50);\n' +
'        flashBg("blue");\n' +
'    }\n' +
'}\n' +
'\n' +
'function enableButton() { document.getElementById("apoyaBtn").classList.remove("disabled"); }\n' +
'function disableButton() { document.getElementById("apoyaBtn").classList.add("disabled"); }\n' +
'\n' +
'// APOYA BAS MEKANIGI\n' +
'var apoyBtn = document.getElementById("apoyaBtn");\n' +
'\n' +
'function doClick() {\n' +
'    if (!gState || gState.gameState !== "playing") return;\n' +
'    if (apoyBtn.classList.contains("disabled")) return;\n' +
'    apoyBtn.classList.add("pressed");\n' +
'    setTimeout(function() { apoyBtn.classList.remove("pressed"); }, 50);\n' +
'    playClickSound();\n' +
'    socket.emit("click_apoya");\n' +
'}\n' +
'\n' +
'apoyBtn.addEventListener("mousedown", function(e) { e.preventDefault(); doClick(); });\n' +
'apoyBtn.addEventListener("touchstart", function(e) { e.preventDefault(); doClick(); }, { passive: false });\n' +
'\n' +
'document.addEventListener("keydown", function(e) {\n' +
'    if (e.code === "Space" && !e.repeat) {\n' +
'        e.preventDefault();\n' +
'        doClick();\n' +
'        apoyBtn.classList.add("pressed");\n' +
'    }\n' +
'});\n' +
'document.addEventListener("keyup", function(e) {\n' +
'    if (e.code === "Space") apoyBtn.classList.remove("pressed");\n' +
'});\n' +
'\n' +
'// GORSEL EFEKTLER\n' +
'function spawnClickFx() {\n' +
'    var fx = document.createElement("div");\n' +
'    fx.className = "click-fx";\n' +
'    fx.textContent = "+1";\n' +
'    var rect = apoyBtn.getBoundingClientRect();\n' +
'    fx.style.left = (rect.left + rect.width / 2 - 15 + (Math.random() * 40 - 20)) + "px";\n' +
'    fx.style.top = (rect.top + (Math.random() * 40 - 20)) + "px";\n' +
'    document.body.appendChild(fx);\n' +
'    setTimeout(function() { fx.remove(); }, 600);\n' +
'}\n' +
'\n' +
'function spawnParticles() {\n' +
'    var rect = apoyBtn.getBoundingClientRect();\n' +
'    var cx = rect.left + rect.width / 2;\n' +
'    var cy = rect.top + rect.height / 2;\n' +
'    var colors = ["#ff6b6b", "#feca57", "#fff", "#4facfe"];\n' +
'    for (var i = 0; i < 8; i++) {\n' +
'        var p = document.createElement("div");\n' +
'        p.className = "particle";\n' +
'        var angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.5;\n' +
'        var dist = 60 + Math.random() * 80;\n' +
'        p.style.setProperty("--tx", Math.cos(angle) * dist + "px");\n' +
'        p.style.setProperty("--ty", Math.sin(angle) * dist + "px");\n' +
'        p.style.left = cx + "px";\n' +
'        p.style.top = cy + "px";\n' +
'        p.style.background = colors[Math.floor(Math.random() * colors.length)];\n' +
'        document.body.appendChild(p);\n' +
'        setTimeout(function(el) { el.remove(); }, 500, p);\n' +
'    }\n' +
'}\n' +
'\n' +
'function flashBg(color) {\n' +
'    var bg = document.getElementById("gameBg");\n' +
'    bg.classList.add("pulse-" + color);\n' +
'    setTimeout(function() { bg.classList.remove("pulse-" + color); }, 100);\n' +
'}\n' +
'\n' +
'// SONUC\n' +
'function showResult(d) {\n' +
'    var overlay = document.getElementById("resultOverlay");\n' +
'    var title = document.getElementById("resTitle");\n' +
'    var scores = document.getElementById("resScores");\n' +
'    var myName = gState.players[mySeat] ? gState.players[mySeat].name : "";\n' +
'    if (d.winner === "Berabere!") {\n' +
'        title.textContent = "BERABERE!";\n' +
'        title.className = "result-title draw";\n' +
'    } else if (d.winner === myName) {\n' +
'        title.textContent = "KAZANDIN!";\n' +
'        title.className = "result-title win";\n' +
'    } else if (d.winner === "Rakip ayrildi!") {\n' +
'        title.textContent = "RAKIP AYRILDI!";\n' +
'        title.className = "result-title win";\n' +
'    } else {\n' +
'        title.textContent = "KAYBETTIN!";\n' +
'        title.className = "result-title lose";\n' +
'    }\n' +
'    scores.innerHTML = "";\n' +
'    for (var i = 0; i < d.scores.length; i++) {\n' +
'        var s = d.scores[i];\n' +
'        var isMe = s.name === myName;\n' +
'        var col = isMe ? "#ff6b6b" : "#4facfe";\n' +
'        scores.innerHTML += "<div class=\\"rs-col\\"><div class=\\"rs-name\\">" + s.name + (isMe ? " (Sen)" : "") + "</div><div class=\\"rs-val\\" style=\\"color:" + col + "\\\">" + s.score + "</div></div>";\n' +
'    }\n' +
'    overlay.classList.add("show");\n' +
'}\n' +
'\n' +
'function requestRematch() {\n' +
'    document.getElementById("resultOverlay").classList.remove("show");\n' +
'    socket.emit("rematch");\n' +
'    notify("Tekrar mac isteği gönderildi...", "info");\n' +
'}\n' +
'\n' +
'// BILDIRIM\n' +
'function notify(msg, type) {\n' +
'    type = type || "info";\n' +
'    var n = document.createElement("div");\n' +
'    n.className = "notif " + type;\n' +
'    n.textContent = msg;\n' +
'    document.body.appendChild(n);\n' +
'    setTimeout(function() {\n' +
'        n.style.opacity = "0";\n' +
'        n.style.transform = "translateX(100%)";\n' +
'        n.style.transition = ".3s";\n' +
'        setTimeout(function() { n.remove(); }, 300);\n' +
'    }, 3000);\n' +
'}\n' +
'\n' +
'showScreen("lobby");\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}

// ==================== SUNUCUYU BASLAT ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('APOYA BASMA sunucusu ' + PORT + ' portunda calisiyor...');
    console.log('Tarayicidan http://localhost:' + PORT + ' adresine git');
});