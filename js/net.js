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
    cb: {}         // onJoined(name,conn) onPlayers onRound onBetFeed onLock onStart onReveal onLeft onNonce
  };

  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 避開易混淆字元

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
  Net.host = function (name, cb, onReady, onFail) {
    Net.cb = cb;
    Net.myName = name;
    Net.mode = 'host';
    var code = code6();
    var peer = new Peer('hrace-' + code, { debug: 0 });
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
    var peer = new Peer({ debug: 0 });
    Net.peer = peer;
    var opened = false, failed = false;
    function fail(message) {
      if (opened || failed) return;
      failed = true;
      Net.leaveSilent();
      if (onFail) onFail(new Error(message));
    }
    peer.on('open', function () {
      var conn = peer.connect('hrace-' + code, { reliable: true });
      Net.conns = [conn];
      conn.on('open', function () {
        opened = true;
        Net.code = code;
        send(conn, { t: 'hello', name: name, ver: global.APP_BUILD || '' });
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
      if (err && err.type === 'peer-unavailable') fail('找不到房間 ' + code + '（房主已離線或房號錯誤）');
      else if (!opened) fail('連線失敗：' + (err && err.type || ''));
    });
    setTimeout(function () { fail('連線逾時，請確認房號與網路'); }, 15000);
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
      Net.broadcast({ t: 'hello', name: Net.myName, ver: global.APP_BUILD || '' });
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
