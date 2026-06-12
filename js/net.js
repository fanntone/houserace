/* net.js — P2P 房間層（PeerJS / WebRTC DataChannel）
 *
 * 房主即伺服器：廣播場次、轉發注單動態、收集隨機數、同步賽果。
 * 訊息協定（JSON）：
 *   guest → host : hello{name,ver} | bet{bet} | nonce{v}
 *   host  → all  : players{list} | round{no,hash,horses,rtp,racer,countdown,phase}
 *                  betfeed{who,bet} | lock{} | start{order,nonces} | reveal{hostSeed}
 * 牽線（signaling）走 PeerJS 免費公共節點，資料流是瀏覽器間直連。
 */
(function (global) {
  'use strict';

  var Net = {
    mode: null,    // null | 'host' | 'guest'
    peer: null,
    conns: [],     // host：所有客人連線；guest：[到房主的連線]
    players: [],   // {id, name, betCount, betTotal}
    code: '',
    myName: '玩家',
    cid: '',       // 穩定客戶端識別（由 app 設定）：同一人斷線重連時房主據此去重
    cb: {}         // onJoined(name,conn) onPlayers onRound onBetFeed onLock onStart onReveal onLeft onNonce
  };

  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 避開易混淆字元

  // ICE 設定：多組 STUN + 盡力而為的免費 TURN 中繼。
  // 行動網路（4G/5G 的 CGNAT/對稱 NAT）只靠 STUN 打洞常失敗 →「加入沒反應、十幾秒後逾時」。
  // TURN 走 80/443 也能繞過嚴格防火牆；憑證若失效 ICE 會自動略過該伺服器，無副作用。
  var PEER_OPTS = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443',
                 'turns:openrelay.metered.ca:443?transport=tcp'],
          username: 'openrelayproject', credential: 'openrelayproject' }
      ]
    }
  };

  function code6() {
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function send(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) {}
  }

  function findPlayer(id) {
    for (var i = 0; i < Net.players.length; i++) {
      if (Net.players[i].id === id) return Net.players[i];
    }
    return null;
  }

  Net.broadcast = function (msg) {
    for (var i = 0; i < Net.conns.length; i++) send(Net.conns[i], msg);
  };

  Net.sendTo = function (conn, msg) { send(conn, msg); };

  Net.pushPlayers = function () {
    var list = Net.players.map(function (p) {
      return { name: p.name, betCount: p.betCount, betTotal: p.betTotal };
    });
    Net.broadcast({ t: 'players', list: list });
    if (Net.cb.onPlayers) Net.cb.onPlayers(list);
  };

  Net.resetBetStats = function () {
    Net.players.forEach(function (p) { p.betCount = 0; p.betTotal = 0; });
    Net.pushPlayers();
  };

  // ---------- 房主 ----------
  // wantCode：頁面重載後用原房號重開房（客人重連得回來）；被占用時自動換新號
  Net.host = function (name, cb, onReady, onFail, wantCode) {
    Net.cb = cb;
    Net.myName = name;
    Net.mode = 'host';
    var code = (wantCode && /^[A-Z0-9]{4,8}$/.test(String(wantCode))) ? String(wantCode) : code6();
    var peer = new Peer('hrace-' + code, PEER_OPTS);
    Net.peer = peer;
    var ready = false;
    peer.on('open', function () {
      ready = true;
      Net.code = code;
      Net.players = [{ id: 'self', name: name, betCount: 0, betTotal: 0 }];
      onReady(code);
    });
    peer.on('error', function (err) {
      if (err && err.type === 'unavailable-id' && !ready) { // 房號碰撞 → 換號重試
        try { peer.destroy(); } catch (e) {}
        Net.host(name, cb, onReady, onFail);
      } else if (!ready) {
        Net.leaveSilent();
        if (onFail) onFail(err);
      } // 已開房後的零星連線錯誤（例如客人斷線）忽略，由 conn close 處理
    });
    peer.on('connection', function (conn) {
      conn.on('data', function (msg) { hostOnData(conn, msg); });
      conn.on('close', function () { hostDropConn(conn); });
      conn.on('error', function () { hostDropConn(conn); });
    });
  };

  function hostOnData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      // 冪等：客人同步重試會重發 hello，不重複加人、但會重發場次快照
      conn._name = String(msg.name || '玩家').slice(0, 12) || '玩家';
      conn._cid = String(msg.cid || '');
      // 同一玩家重連（手機鎖屏/網路抖動後重入）：踢掉舊連線，名單不留殭屍
      if (conn._cid) {
        for (var k = Net.conns.length - 1; k >= 0; k--) {
          var oldC = Net.conns[k];
          if (oldC !== conn && oldC._cid === conn._cid) {
            try { oldC.close(); } catch (e2) {}
            hostDropConn(oldC);
          }
        }
      }
      if (Net.conns.indexOf(conn) === -1) Net.conns.push(conn);
      var existing = findPlayer(conn.peer);
      var isNew = !existing;
      if (existing) existing.name = conn._name;
      else Net.players.push({ id: conn.peer, name: conn._name, betCount: 0, betTotal: 0 });
      Net.pushPlayers();
      if (Net.cb.onJoined) Net.cb.onJoined(conn._name, conn, isNew);
    } else if (msg.t === 'bet' && msg.bet) {
      var p = findPlayer(conn.peer);
      if (p) {
        p.betCount++;
        p.betTotal += (msg.bet.amount | 0);
      }
      Net.pushPlayers();
      var feed = { t: 'betfeed', who: conn._name || '玩家', bet: msg.bet };
      Net.broadcast(feed);
      if (Net.cb.onBetFeed) Net.cb.onBetFeed(feed.who, msg.bet);
    } else if (msg.t === 'nonce') {
      if (Net.cb.onNonce) Net.cb.onNonce(conn.peer, String(msg.v || '').slice(0, 64));
    } else if (msg.t === 'pong') {
      conn._seen = Date.now();
    }
  }

  function hostDropConn(conn) {
    var ci = Net.conns.indexOf(conn);
    if (ci !== -1) Net.conns.splice(ci, 1);
    for (var i = Net.players.length - 1; i >= 0; i--) {
      if (Net.players[i].id === conn.peer) Net.players.splice(i, 1);
    }
    Net.pushPlayers();
  }

  // ---------- 客人 ----------
  Net.join = function (code, name, cb, onReady, onFail) {
    Net.cb = cb;
    Net.myName = name;
    Net.mode = 'guest';
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var peer = new Peer(PEER_OPTS);
    Net.peer = peer;
    var opened = false, failed = false, peerOpened = false;
    function status(t) { if (cb.onStatus) cb.onStatus(t); } // 連線進度回報（UI 顯示用）
    function fail(message, type) {
      if (opened || failed) return;
      failed = true;
      Net.leaveSilent();
      if (onFail) {
        var e = new Error(message);
        e.type = type || ''; // 重連流程靠它分辨「房主真不在」與暫時性失敗
        onFail(e);
      }
    }
    status('正在連線訊號伺服器…');
    peer.on('open', function () {
      peerOpened = true;
      status('已連上訊號伺服器，正在與房主建立直連…');
      var conn = peer.connect('hrace-' + code, { reliable: true });
      Net.conns = [conn];
      conn.on('open', function () {
        opened = true;
        Net.code = code;
        send(conn, { t: 'hello', name: name, ver: global.APP_BUILD || '', cid: Net.cid });
        onReady();
      });
      conn.on('data', function (msg) { guestOnData(msg); });
      conn.on('close', function () {
        if (opened) {
          var cbLeft = Net.cb.onLeft;
          Net.leaveSilent();
          if (cbLeft) cbLeft();
        }
      });
    });
    peer.on('error', function (err) {
      if (err && err.type === 'peer-unavailable') fail('找不到房間 ' + code + '（房主已離線或房號錯誤）', 'peer-unavailable');
      else if (!opened) fail('連線失敗：' + (err && err.type || ''), err && err.type);
    });
    setTimeout(function () {
      fail(peerOpened
        ? '連線逾時：與房主建立直連失敗。行動網路（4G/5G）較容易失敗，建議改用 Wi-Fi（與房主同一網路最穩）再試一次。'
        : '連線逾時：無法連上訊號伺服器，請檢查網路後再試。');
    }, 20000);
  };

  function guestOnData(msg) {
    if (!msg || typeof msg !== 'object') return;
    var cb = Net.cb;
    if (msg.t === 'ping') { // 房主心跳：回 pong 並記錄存活時刻
      Net.lastPing = Date.now();
      Net.broadcast({ t: 'pong' });
      return;
    }
    if (msg.t === 'players') { Net.players = msg.list || []; if (cb.onPlayers) cb.onPlayers(Net.players); }
    else if (msg.t === 'round' && cb.onRound) cb.onRound(msg);
    else if (msg.t === 'betfeed' && cb.onBetFeed) cb.onBetFeed(msg.who, msg.bet);
    else if (msg.t === 'lock' && cb.onLock) cb.onLock();
    else if (msg.t === 'start' && cb.onStart) cb.onStart(msg);
    else if (msg.t === 'reveal' && cb.onReveal) cb.onReveal(msg);
  }

  // ---------- 共用 ----------
  Net.sendBet = function (bet) {
    if (Net.mode === 'guest') {
      Net.broadcast({ t: 'bet', bet: bet });
    } else if (Net.mode === 'host') {
      var me = Net.players[0];
      if (me) {
        me.betCount++;
        me.betTotal += (bet.amount | 0);
      }
      Net.pushPlayers();
      var feed = { t: 'betfeed', who: Net.myName, bet: bet };
      Net.broadcast(feed);
      if (Net.cb.onBetFeed) Net.cb.onBetFeed(Net.myName, bet);
    }
  };

  Net.sendNonce = function (v) {
    if (Net.mode === 'guest') Net.broadcast({ t: 'nonce', v: v });
  };

  // 客人：同步重試（場次快照沒送到時重新請求；房主端冪等）
  Net.resendHello = function () {
    if (Net.mode === 'guest') {
      Net.broadcast({ t: 'hello', name: Net.myName, ver: global.APP_BUILD || '', cid: Net.cid });
    }
  };

  // 房主：廣播心跳並清理失聯的客人（瀏覽器被直接關掉不會有乾淨的 close）
  Net.heartbeat = function (timeoutMs) {
    if (Net.mode !== 'host') return;
    Net.broadcast({ t: 'ping' });
    var now = Date.now();
    for (var i = Net.conns.length - 1; i >= 0; i--) {
      var c = Net.conns[i];
      if (c._seen === undefined) c._seen = now; // 首次心跳起算
      if (now - c._seen > timeoutMs) {
        try { c.close(); } catch (e) {}
        hostDropConn(c);
      }
    }
  };
  Net.lastPing = 0;

  Net.active = function () { return Net.mode !== null; };
  Net.isHost = function () { return Net.mode === 'host'; };
  Net.count = function () { return Net.players.length; };

  Net.leaveSilent = function () {
    try { if (Net.peer) Net.peer.destroy(); } catch (e) {}
    Net.peer = null;
    Net.conns = [];
    Net.players = [];
    Net.mode = null;
    Net.code = '';
    Net.cb = {};
  };
  Net.leave = Net.leaveSilent;

  global.Net = Net;
})(window);
