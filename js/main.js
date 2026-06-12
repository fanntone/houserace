/* main.js — 遊戲狀態機：下注 → 比賽 → 派彩 循環、錢包、設定、公平驗證 */
(function () {
  'use strict';

  var $ = UI.$;
  var BETTING_SECONDS = 45;

  // ---------- 儲存（localStorage，失敗則僅存在記憶體） ----------
  var store = {
    disabled: false, // 多分頁衝突時凍結本分頁的寫入
    get: function (k, dflt) {
      try {
        var v = localStorage.getItem('hr_' + k);
        return v === null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },
    set: function (k, v) {
      if (store.disabled) return;
      try { localStorage.setItem('hr_' + k, JSON.stringify(v)); } catch (e) {}
    }
  };

  var Game = {
    phase: 'betting',            // betting | racing | result
    balance: store.get('balance', 10000),
    roundCounter: store.get('round', 0),
    settings: {
      rtp: store.get('rtp', 1),
      horses: store.get('horses', 8),
      duration: store.get('duration', 38),
      racer: store.get('racer', 'horse')
    },
    round: null,
    lastRound: null,
    // 多人房間狀態（P2P）：host=房主（其瀏覽器即伺服器）
    mp: { active: false, host: false, code: '', racer: null, hostSeed: null,
          nonces: null, myNonce: null, nonceOk: true, waiting: false,
          reconnecting: false, needReconnect: false },
    bets: [],
    betType: 'win',
    sel: null,
    amount: 0,
    animator: null,
    countdown: BETTING_SECONDS,
    countdownTimer: null,
    lastRankTick: 0
  };

  // ---------- 顯示輔助 ----------
  function updateBalance() {
    $('balance').textContent = UI.money(Game.balance);
    var broke = Game.phase === 'betting' && Game.balance < 10 && Game.bets.length === 0;
    $('brokeBanner').classList.toggle('hidden', !broke);
  }

  function setPhase(phase) {
    Game.phase = phase;
    var pill = $('phasePill');
    pill.textContent = phase === 'betting' ? '下注中' : phase === 'racing' ? '比賽中' : '派彩';
    pill.className = 'pill phase ' + phase;
    $('left').classList.toggle('locked', phase !== 'betting');
  }

  function renderOdds() {
    UI.renderOddsArea($('oddsArea'), Game.round, Game.betType, selectOutcome);
    $('typeHint').textContent = Betting.BET_TYPES[Game.betType].label + '：' + Betting.BET_TYPES[Game.betType].desc;
    // 不足 7 匹時位置只算前二名，分頁直接標明，避免誤會
    var placeTab = $('betTabs').querySelector('[data-type="place"]');
    if (placeTab) placeTab.textContent = (Game.round.market.placeCount === 2) ? '位置(前二)' : '位置';
  }

  function renderBets() {
    UI.renderBetList($('betList'), Game.bets,
      Game.phase === 'betting' && !Game.mp.active, removeBet);
  }

  // ---------- 場次持久化（修復：重載頁面後注金已扣但注單消失） ----------
  // 未結算的場次（種子+參數+注單）隨時寫入儲存；結算時清除。
  // 重載時用同一種子重建同一場比賽（種子確定性保證馬匹/賠率/賽果完全一致）。
  function savePending() {
    if (Game.mp.active) return; // 多人場次不持久化（斷線即離房，注金由離房流程退還）
    store.set('pending', {
      seed: Game.round.seed,
      no: Game.round.no,
      rtp: Game.round.rtp,
      n: Game.round.horses.length,
      bets: Game.bets
    });
  }

  function validBets(raw, n) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (b) {
      return b && Betting.BET_TYPES[b.type] &&
        Array.isArray(b.sel) && b.sel.length === Betting.BET_TYPES[b.type].picks &&
        b.sel.every(function (x) { return x >= 1 && x <= n && x === Math.floor(x); }) &&
        typeof b.amount === 'number' && b.amount >= 10 &&
        typeof b.odds === 'number' && b.odds > 1;
    });
  }

  // ---------- 場次 ----------
  function newRound() {
    Voice.stop();
    Game.roundCounter++;
    store.set('round', Game.roundCounter);

    var seed = RNG.randomSeedHex();
    var round = Model.buildRound(seed, Game.settings.horses, Game.settings.rtp);
    round.no = Game.roundCounter;
    Game.bets = [];
    beginRound(round);
    savePending();
  }

  // 還原上次未結算的場次（同種子 → 同一場比賽，注單原封還原）
  function resumeRound(p) {
    Voice.stop();
    var round = Model.buildRound(p.seed, p.n, p.rtp);
    round.no = p.no;
    Game.roundCounter = p.no;
    store.set('round', p.no);
    Game.bets = validBets(p.bets, p.n);
    beginRound(round);
    if (Game.bets.length > 0) {
      $('commentary').textContent = '📣 已還原上一場未完成的場次與您的 ' +
        Game.bets.length + ' 筆注單（賽果雜湊不變，可驗證）。';
    }
  }

  function beginRound(round) {
    Game.round = round;
    Game.sel = null;
    Game.amount = 0;
    makeAnimator(round);
    finishBeginRound(round);
  }

  // 建立（或重建）動畫器。多人模式下注期間名次未定，先用占位順序畫閘口，
  // 開跑時拿到全員隨機數決定的真名次再重建。
  function makeAnimator(round) {
    if (Game.animator) Game.animator.stop();
    var order = round.finishOrder || round.horses.map(function (_, i) { return i; });
    var animOpts = {
      // 編排種子＝雜湊+名次衍生：多人各端可自行算出同一套（畫面跑位一致），
      // 雜湊在下注前已公開、名次在重建動畫器時已是公開資訊，無洩漏
      rand: RNG.seededRand(RNG.sha256(round.hash + '|' + order.join(','))),
      duration: Game.settings.duration,
      racerType: (Game.mp.active && Game.mp.racer) ? Game.mp.racer : Game.settings.racer,
      infieldText: '第 ' + round.no + ' 場',
      infieldSub: '派彩率 ' + Math.round(round.rtp * 100) + '%　' + round.horses.length + ' 匹出賽',
      onCommentary: function (text) {
        var el = $('commentary');
        el.textContent = '📣 ' + text;
        el.classList.remove('flash');
        void el.offsetWidth; // 重新觸發動畫
        el.classList.add('flash');
        // 語音旁述：越接近終點語速越快越激動（跳至結果時不發聲）
        if (!Game.muteCommentary) {
          var prog = Game.animator ? Math.min(1, Game.animator.raceTime / Game.animator.duration) : 0;
          Voice.speak(text, 1.05 + 0.45 * prog);
        }
      },
      onTick: function (time, ranking) {
        var now = performance.now();
        if (now - Game.lastRankTick < 200) return;
        Game.lastRankTick = now;
        UI.renderRankBoard($('rankBoard'), round.horses, ranking, round.market, true);
      },
      onFinish: settleRound
    };
    // 優先用 Three.js 真 3D 轉播；WebGL 不可用時退回 2D
    try {
      if (typeof RaceAnimator3D === 'undefined') throw new Error('no THREE');
      Game.animator = new RaceAnimator3D($('track'), round.horses, order, animOpts);
    } catch (e) {
      console.warn('3D 初始化失敗，改用 2D 渲染：', e);
      Game.animator = new RaceAnimator($('track'), round.horses, order, animOpts);
    }
    Game.animator.drawIdle();
  }

  function finishBeginRound(round) {
    $('roundNo').textContent = '第 ' + round.no + ' 場';
    $('fairHash').textContent = round.hash;
    setPhase('betting');
    updateBalance();
    renderOdds();
    renderBets();
    hideTicket();
    $('commentary').textContent = '📣 下注開始！本場 ' + round.horses.length +
      ' 匹出賽，賽果已鎖定（雜湊見下方），祝君好運！';
    UI.renderRankBoard($('rankBoard'), round.horses,
      round.horses.map(function (_, i) { return i; }), round.market, false);

    $('countdownOverlay').classList.remove('hidden');
    $('speedCtrl').classList.add('hidden');
    // 倒數採 wall-clock 截止制（背景分頁計時器被節流也照樣準時觸發）
    Game.countdown = BETTING_SECONDS;
    Game.countdownEndsAt = Date.now() + BETTING_SECONDS * 1000;
    $('countdown').textContent = Game.countdown;
  }

  // ---------- 下注 ----------
  function selectOutcome(sel) {
    if (Game.phase !== 'betting') return;
    Game.sel = sel;
    var key = (sel.length === 1) ? String(sel[0]) :
      (Game.betType === 'quinella' ? Math.min(sel[0], sel[1]) + '-' + Math.max(sel[0], sel[1])
                                   : sel[0] + '-' + sel[1]);
    UI.markSelection($('oddsArea'), key);
    $('ticketDesc').innerHTML = Betting.describeBet({ type: Game.betType, sel: sel });
    $('ticketOdds').textContent = UI.oddsText(Betting.getOdds(Game.round.market, Game.betType, sel));
    $('ticket').classList.remove('hidden');
    updateTicket();
  }

  function updateTicket() {
    var odds = Game.sel ? Betting.getOdds(Game.round.market, Game.betType, Game.sel) : 0;
    $('ticketAmount').textContent = UI.money(Game.amount);
    $('ticketPotential').textContent = UI.money(Game.amount * odds);
    $('btnConfirmBet').disabled = !(Game.amount >= 10 && Game.amount <= Game.balance);
  }

  function hideTicket() {
    Game.sel = null;
    Game.amount = 0;
    $('ticket').classList.add('hidden');
    UI.markSelection($('oddsArea'), null);
  }

  function confirmBet() {
    if (!Game.sel || Game.amount < 10 || Game.amount > Game.balance) return;
    var bet = {
      type: Game.betType,
      sel: Game.sel.slice(),
      amount: Game.amount,
      odds: Betting.getOdds(Game.round.market, Game.betType, Game.sel)
    };
    Game.bets.push(bet);
    Game.balance -= bet.amount;
    store.set('balance', Game.balance);
    savePending(); // 注單與扣款一起持久化
    if (Game.mp.active) Net.sendBet(bet); // 多人：注單動態同步全房
    updateBalance();
    renderBets();
    hideTicket();
  }

  function removeBet(i) {
    if (Game.phase !== 'betting' || Game.mp.active) return; // 多人模式注單已廣播，不可撤
    var bet = Game.bets.splice(i, 1)[0];
    Game.balance += bet.amount;
    store.set('balance', Game.balance);
    savePending();
    updateBalance();
    renderBets();
  }

  // ---------- 比賽與結算 ----------
  function startRace() {
    if (Game.phase !== 'betting') return;
    Game.countdownEndsAt = null;
    setPhase('racing');
    hideTicket();
    renderBets();
    $('countdownOverlay').classList.add('hidden');
    $('speedCtrl').classList.remove('hidden');
    Game.animator.setSpeed(1);
    document.querySelectorAll('#speedCtrl .spd').forEach(function (b) {
      b.classList.toggle('active', b.dataset.speed === '1');
    });
    Game.animator.start();
  }

  function settleRound() {
    var round = Game.round;
    var finishNums = round.finishOrder.map(function (i) { return i + 1; });
    var res = Betting.settle(Game.bets, finishNums, round.market.placeCount);
    Game.balance += res.totalPayout;
    store.set('balance', Game.balance);
    store.set('pending', null); // 場次已結算，清除還原點
    Game.lastRound = round;

    // 多人：記錄多方公平資料；房主揭示種子讓全房驗證
    if (Game.mp.active) {
      round.mpData = {
        hostSeed: Game.mp.host ? Game.mp.hostSeed : (Game.mp.pendingReveal || null),
        nonces: Game.mp.nonces || [],
        nonceOk: Game.mp.nonceOk
      };
      if (Game.mp.host) Net.broadcast({ t: 'reveal', hostSeed: Game.mp.hostSeed });
    }
    // 機台式持續循環：結果顯示 10 秒後自動開下一場（房主與單機；客人由房主廣播帶動）
    if (!Game.mp.active || Game.mp.host) {
      Game.autoNextAt = Date.now() + 10500;
      Game.autoNextRemain = null;
    }

    setPhase('result');
    updateBalance();
    UI.renderRankBoard($('rankBoard'), round.horses, round.finishOrder, round.market, true);
    $('fairSeedWrap').classList.remove('hidden');
    $('fairSeed').textContent = round.seed || (round.mpData && round.mpData.hostSeed) || '（多人場次）';
    UI.renderResult(round, res, Game.balance);
    if (Game.mp.active) {
      $('resultSeed').textContent = (round.mpData.hostSeed || '等待房主揭示…');
      var nb = $('btnNextRound');
      if (Game.mp.host) {
        nb.disabled = false;
        nb.textContent = '下一場 ▶（全房同步）';
      } else {
        nb.disabled = true;
        nb.textContent = '等待房主開下一場…';
      }
    } else {
      var nb2 = $('btnNextRound');
      nb2.disabled = false;
      nb2.textContent = '下一場 ▶';
    }
    UI.showModal('resultModal');
  }

  function openVerify() {
    if (!Game.lastRound) return;
    UI.renderVerify(Game.lastRound);
    UI.showModal('verifyModal');
  }

  // ---------- 多人房間（P2P）：場次同步、注單動態、多方公平 ----------
  function mpName() {
    return ($('mpName').value || '').trim().slice(0, 12) ||
      ('玩家' + Math.floor(Math.random() * 900 + 100));
  }

  function mpFeedLine(html) {
    var feed = $('mpFeed');
    var d = document.createElement('div');
    d.innerHTML = html;
    feed.insertBefore(d, feed.firstChild);
    while (feed.children.length > 5) feed.removeChild(feed.lastChild);
  }

  function mpUpdateUI() {
    var on = Game.mp.active;
    $('mpBar').classList.toggle('hidden', !on);
    $('mpSolo').classList.toggle('hidden', on);
    $('mpIn').classList.toggle('hidden', !on);
    $('btnMp').classList.toggle('mp-on', on);
    // 客人不能提前開賽（開賽時機由房主控制）
    $('btnStartNow').classList.toggle('hidden', on && !Game.mp.host);
    if (on) {
      $('mpCodeShow').textContent = Game.mp.code;
      $('mpStatus').textContent = '🌐 房間 ' + Game.mp.code +
        (Game.mp.host ? '（你是房主）' : '') + '・' + Net.count() + ' 人在線';
      $('mpCountShow').textContent = Net.count();
    }
  }

  function mpRenderPlayers(list) {
    $('mpPlayers').innerHTML = list.map(function (p) {
      return '<span class="mp-chip">' + p.name +
        (p.betCount ? '（' + p.betCount + ' 注）' : '') + '</span>';
    }).join('');
    mpUpdateUI();
  }

  function mpRoundMsg(forConn) {
    var msg = {
      t: 'round',
      no: Game.round.no,
      hash: Game.round.hash,
      rtp: Game.round.rtp,
      racer: Game.settings.racer,
      horses: Game.round.horses.map(function (h) {
        return { num: h.num, name: h.name, strength: h.strength };
      }),
      countdown: (Game.phase === 'betting' && Game.countdownEndsAt)
        ? Math.max(0, (Game.countdownEndsAt - Date.now()) / 1000) : 0,
      phase: Game.phase === 'betting' ? 'betting' : 'waiting'
    };
    // 補課資料（斷線重連用）：賽果已定就附名次與隨機數，
    // 比賽中再附已跑秒數（重連者快轉到同步進度）、已結算附種子（直接領彩）
    if (Game.phase !== 'betting' && Game.round.finishOrder) {
      msg.order = Game.round.finishOrder;
      msg.nonces = Game.mp.nonces || [];
      if (Game.phase === 'result') msg.hostSeed = Game.mp.hostSeed;
      else if (Game.animator && Game.animator.running) msg.elapsed = Game.animator.raceTime;
    }
    return msg;
  }

  // 房主開新場：種子只決定馬匹盤口，名次等全員隨機數混合後才產生
  function mpNewRound() {
    Voice.stop();
    Game.mp.hostSeed = RNG.randomSeedHex();
    Game.mp.nonces = null;
    var round = Model.buildRoundMP(Game.mp.hostSeed, Game.settings.horses, Game.settings.rtp);
    Game.roundCounter++;
    round.no = Game.roundCounter;
    Game.bets = [];
    Game.mp.racer = Game.settings.racer;
    beginRound(round);
    Net.resetBetStats();
    Net.broadcast(mpRoundMsg());
  }

  // 房主：下注截止 → 收集全員隨機數 → 廣播開跑
  function mpLock() {
    if (Game.phase !== 'betting' || !Game.mp.host) return;
    Game.countdownEndsAt = null;
    setPhase('racing');
    hideTicket();
    renderBets();
    $('countdownOverlay').classList.add('hidden');
    Net.broadcast({ t: 'lock' });
    $('commentary').textContent = '📣 下注截止！收集全員隨機數，產生賽果…';
    Game.mp.nonces = [RNG.randomSeedHex().slice(0, 16)]; // 房主自己的隨機數
    Game.mp.startAt = Date.now() + 1500; // 收隨機數窗口（節拍器到點廣播開跑，背景也準時）
  }

  // 全員：拿到名次後重建動畫器並開跑
  function mpStartRace(order) {
    Game.round.finishOrder = order;
    makeAnimator(Game.round);
    setPhase('racing');
    hideTicket();
    renderBets();
    $('countdownOverlay').classList.add('hidden');
    // 多人不開放加速/跳至結果：本地變速會讓畫面與全房不同步（賽果仍一致）
    $('speedCtrl').classList.add('hidden');
    Game.animator.setSpeed(1);
    Game.animator.start();
  }

  // 客人：套用房主廣播的場次
  function mpApplyRound(msg) {
    // 同步重試可能重複收到同一場：已同步且場次號相同就忽略（避免清掉已下的注單）
    if (Game.mp.synced && Game.round && msg.no === Game.round.no) return;
    Game.mp.synced = true;
    if (Game.mp.syncTimer) { clearInterval(Game.mp.syncTimer); Game.mp.syncTimer = null; }
    // 斷線重連回到同一場（場次號+雜湊都吻合）：保留本地注單，只補課接上進度
    if (Game.round && msg.no === Game.round.no && msg.hash === Game.round.hash) {
      mpResync(msg);
      return;
    }
    // 若上一場動畫還沒跑完（例如剛從背景回來），先瞬間結算再進新場，注金不蒸發
    if (Game.phase === 'racing' && Game.animator && Game.animator.running) {
      Game.muteCommentary = true;
      Game.animator.skip();
      Game.muteCommentary = false;
    }
    Game.autoNextAt = null;
    Game.mp.pendingReveal = null;
    Voice.stop();
    UI.hideModal('resultModal');
    var horses = Model.reviveHorses(msg.horses || []);
    var round = {
      seed: null,
      hash: msg.hash,
      rtp: msg.rtp,
      no: msg.no,
      horses: horses,
      market: Model.computeMarket(horses, msg.rtp),
      finishOrder: null
    };
    Game.roundCounter = msg.no;
    // 重連回來時房主已換場：原注單無從結算，退還注金（正常換場時這裡必為空或已結算）
    if (Game.bets.length && Game.phase !== 'result') {
      var refund = 0;
      Game.bets.forEach(function (b) { refund += b.amount; });
      Game.balance += refund;
      store.set('balance', Game.balance);
    }
    Game.bets = [];
    Game.mp.racer = msg.racer || 'horse';
    Game.mp.myNonce = null;
    Game.mp.nonces = null;
    Game.mp.nonceOk = true;
    beginRound(round);
    if (msg.phase !== 'betting') { // 中途加入：本場觀望，等下一場
      Game.mp.waiting = true;
      Game.countdownEndsAt = null;
      $('countdownOverlay').classList.add('hidden');
      setPhase('result');
      $('commentary').textContent = '📣 本場已開跑，請稍候——下一場開始即可下注！';
    } else {
      Game.mp.waiting = false;
      // 與房主對時：用房主的剩餘秒數重設本地 wall-clock 截止點，兩邊倒數一致
      // （beginRound 預設整段下注時間，中途加入不重設會從頭數）
      var cd = Math.max(0, Number(msg.countdown) || 0);
      Game.countdown = Math.ceil(cd);
      Game.countdownEndsAt = Date.now() + cd * 1000;
      $('countdown').textContent = Game.countdown;
    }
  }

  // 斷線重連補課：回到同一場時依房主目前階段把本地接上（注單與錢包都保住）
  function mpResync(msg) {
    if (msg.phase === 'betting') {
      if (Game.phase !== 'betting') return; // 本地已越過下注階段，等開跑/換場訊息
      var cd = Math.max(0, Number(msg.countdown) || 0);
      Game.countdown = Math.ceil(cd);
      Game.countdownEndsAt = Date.now() + cd * 1000;
      $('countdown').textContent = Game.countdown;
      return;
    }
    if (Game.phase === 'result' || Game.mp.waiting) return; // 已結算/觀望中：等下一場廣播
    if (!msg.order) return; // 房主在收隨機數窗口：等 start 訊息即可
    // 房主已開跑或已結算：套用名次補跑（編排種子同樣由雜湊+名次衍生，畫面一致）
    Game.mp.nonces = msg.nonces || [];
    Game.mp.nonceOk = !Game.mp.myNonce || Game.mp.nonces.indexOf(Game.mp.myNonce) !== -1;
    if (msg.hostSeed) Game.mp.pendingReveal = msg.hostSeed;
    var alreadyRunning = Game.animator && Game.animator.running && Game.round.finishOrder;
    Game.muteCommentary = true;
    if (!alreadyRunning) mpStartRace(msg.order);
    if (msg.hostSeed) {
      Game.animator.skip(); // 房主已在結算畫面：直接跳到結果領彩
    } else {
      // 快轉到房主目前進度（advance 會自行吃掉出閘倒數/定格等時間）
      var target = Math.max(0, Number(msg.elapsed) || 0), guard = 0;
      while (Game.animator.running && Game.animator.raceTime < target && guard++ < 600) {
        Game.animator.advance(0.5);
      }
    }
    Game.muteCommentary = false;
  }

  function mpCallbacks() {
    return {
      // —— 房主側 ——
      onJoined: function (name, conn, isNew) {
        Net.sendTo(conn, mpRoundMsg(conn)); // 同步重試也會重發場次快照（冪等）
        if (isNew) mpFeedLine('🙌 <b>' + name + '</b> 加入了房間');
        mpUpdateUI();
      },
      onNonce: function (id, v) {
        if (Game.mp.nonces && Game.mp.nonces.length < 64 && v) Game.mp.nonces.push(v);
      },
      // —— 共用 ——
      onPlayers: mpRenderPlayers,
      onBetFeed: function (who, bet) {
        if (bet) mpFeedLine('💰 <b>' + who + '</b> 下注 ' + Betting.describeBet(bet) +
          ' ×' + UI.money(bet.amount));
      },
      // —— 客人側 ——
      onRound: mpApplyRound,
      onLock: function () {
        if (Game.mp.waiting) return;
        Game.countdownEndsAt = null;
        setPhase('racing');
        hideTicket();
        renderBets();
        $('countdownOverlay').classList.add('hidden');
        Game.mp.myNonce = RNG.randomSeedHex().slice(0, 16);
        Net.sendNonce(Game.mp.myNonce);
        $('commentary').textContent = '📣 下注截止！已提交你的隨機數，等待開跑…';
      },
      onStart: function (msg) {
        if (Game.mp.waiting) return;
        Game.mp.nonces = msg.nonces || [];
        Game.mp.nonceOk = !Game.mp.myNonce || Game.mp.nonces.indexOf(Game.mp.myNonce) !== -1;
        mpStartRace(msg.order || []);
      },
      onReveal: function (msg) {
        // 可能比本地結算先到（動畫進度不同步），先暫存
        Game.mp.pendingReveal = msg.hostSeed;
        if (Game.lastRound && Game.lastRound.mpData && !Game.lastRound.mpData.hostSeed) {
          Game.lastRound.mpData.hostSeed = msg.hostSeed;
          if (!document.getElementById('resultModal').classList.contains('hidden')) {
            $('resultSeed').textContent = msg.hostSeed;
          }
        }
      },
      onLeft: function () {
        // 連線斷掉先嘗試自動重連（房主真離線時重連會快速失敗→退房退注金）；
        // 背景中不重連（行動裝置整頁暫停，計時器不可靠），回前景再處理
        if (document.hidden) { Game.mp.needReconnect = true; return; }
        mpReconnect();
      }
    };
  }

  // 客人同步看門狗：場次快照偶發遺失時自動重新請求（房主端冪等）
  function startSyncWatchdog() {
    Game.mp.synced = false;
    if (Game.mp.syncTimer) clearInterval(Game.mp.syncTimer);
    Game.mp.syncTimer = setInterval(function () {
      if (!Game.mp.active || Game.mp.synced) {
        clearInterval(Game.mp.syncTimer);
        Game.mp.syncTimer = null;
        return;
      }
      Net.resendHello();
      $('commentary').textContent = '📣 同步場次中…（重試）';
    }, 2500);
  }

  // 斷線自動重連：手機鎖屏、網路抖動很常見——先試著回原房間，多次失敗才退房。
  // 回到同一場由 mpResync 補課（注單保留）；房主已換場則退還原注金再進新場。
  function mpReconnect() {
    if (!Game.mp.active || Game.mp.host || Game.mp.reconnecting) return;
    Game.mp.reconnecting = true;
    if (Game.mp.syncTimer) { clearInterval(Game.mp.syncTimer); Game.mp.syncTimer = null; }
    var code = Game.mp.code, name = Net.myName || mpName(), attempt = 0;
    Net.leaveSilent();
    function giveUp(text) {
      Game.mp.reconnecting = false;
      if (Game.mp.active) leaveMP(text);
    }
    function tryOnce() {
      if (!Game.mp.active || !Game.mp.reconnecting) return;
      attempt++;
      $('commentary').textContent = '📣 連線中斷，重連房間 ' + code + ' 中…（第 ' + attempt + ' 次）';
      Net.join(code, name, mpCallbacks(), function () {
        Game.mp.reconnecting = false;
        Net.lastPing = Date.now();
        startSyncWatchdog();
        mpFeedLine('🔁 連線中斷後已自動重連');
        $('commentary').textContent = '📣 已重新連上房間，同步場次中…';
      }, function (err) {
        if (err && err.type === 'peer-unavailable') {
          giveUp('📣 房主已離線，已退還未結算注金並切回單機模式。');
        } else if (attempt >= 3) {
          giveUp('📣 重連失敗，已退還未結算注金並切回單機模式。');
        } else {
          setTimeout(tryOnce, 2000);
        }
      });
    }
    tryOnce();
  }

  // 進房前收拾單機狀態：退還未結算注金、清掉斷線還原點與各種截止時刻
  function mpPrep() {
    // 穩定客戶端識別：同一瀏覽器固定一組，斷線重連時房主據此踢舊連線去重
    if (!Net.cid) {
      Net.cid = store.get('cid', '') || RNG.randomSeedHex().slice(0, 12);
      store.set('cid', Net.cid);
    }
    if (Game.phase !== 'result' && Game.bets.length) {
      var refund = 0;
      Game.bets.forEach(function (b) { refund += b.amount; });
      Game.balance += refund;
      store.set('balance', Game.balance);
    }
    Game.bets = [];
    store.set('pending', null);
    Game.countdownEndsAt = null;
    Game.autoNextAt = null;
    if (Game.mp.syncTimer) { clearInterval(Game.mp.syncTimer); Game.mp.syncTimer = null; }
    if (Game.animator) Game.animator.stop();
    Voice.stop();
    $('mpFeed').innerHTML = '';
  }

  function enterHost() {
    if (typeof Peer === 'undefined') { alert('P2P 元件載入失敗'); return; }
    var name = mpName();
    store.set('name', name);
    mpPrep();
    $('commentary').textContent = '📣 開房中…';
    Net.host(name, mpCallbacks(), function (code) {
      Game.mp.active = true;
      Game.mp.host = true;
      Game.mp.code = code;
      mpUpdateUI();
      mpNewRound();
      mpFeedLine('🏠 房間已開啟，把房號 <b>' + code + '</b> 或邀請連結傳給朋友吧！');
    }, function (err) {
      alert('開房失敗：' + (err && err.message || err && err.type || err));
      leaveMP(null);
    });
  }

  function enterJoin(code) {
    if (typeof Peer === 'undefined') { alert('P2P 元件載入失敗'); return; }
    if (!code || code.length < 4) { alert('請輸入正確的房號'); return; }
    var name = mpName();
    store.set('name', name);
    mpPrep();
    $('commentary').textContent = '📣 連線到房間 ' + code.toUpperCase() + '…';
    Net.join(code, name, mpCallbacks(), function () {
      Game.mp.active = true;
      Game.mp.host = false;
      Game.mp.code = Net.code;
      Net.lastPing = Date.now(); // 心跳寬限起點
      mpUpdateUI();
      UI.hideModal('mpModal');
      $('commentary').textContent = '📣 已加入房間，同步場次中…';
      startSyncWatchdog();
    }, function (err) {
      alert(err.message);
      leaveMP(null);
    });
  }

  function leaveMP(message) {
    Net.leave();
    if (Game.phase !== 'result' && Game.bets.length) { // 未結算注金退還
      var refund = 0;
      Game.bets.forEach(function (b) { refund += b.amount; });
      Game.balance += refund;
      store.set('balance', Game.balance);
    }
    Game.bets = [];
    if (Game.mp.syncTimer) clearInterval(Game.mp.syncTimer);
    Game.mp = { active: false, host: false, code: '', racer: null, hostSeed: null,
                nonces: null, myNonce: null, nonceOk: true, waiting: false,
                synced: false, syncTimer: null, startAt: null, pendingReveal: null,
                reconnecting: false, needReconnect: false };
    Game.autoNextAt = null;
    mpUpdateUI();
    UI.hideModal('resultModal');
    newRound();
    if (message) $('commentary').textContent = message;
  }

  // ---------- 事件綁定 ----------
  function bindEvents() {
    UI.bindTabs($('betTabs'), function (type) {
      Game.betType = type;
      hideTicket();
      renderOdds();
    });

    document.querySelectorAll('#ticket .chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = parseInt(btn.dataset.v, 10);
        Game.amount = (v === 0) ? 0 : Math.min(Game.amount + v, Game.balance);
        updateTicket();
      });
    });
    $('btnConfirmBet').addEventListener('click', confirmBet);

    $('btnStartNow').addEventListener('click', function () {
      // 多人：房主走鎖注廣播（全房同步開跑）；客人此鈕已隱藏
      if (Game.mp.active) { if (Game.mp.host) mpLock(); return; }
      startRace();
    });
    document.querySelectorAll('#speedCtrl .spd').forEach(function (btn) {
      btn.addEventListener('click', function () {
        Game.animator.setSpeed(parseInt(btn.dataset.speed, 10));
        document.querySelectorAll('#speedCtrl .spd').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });
    $('btnSkipRace').addEventListener('click', function () {
      if (!Game.animator) return;
      Game.muteCommentary = true; // 跳過時剩餘旁述只顯示文字、不發聲
      Game.animator.skip();
      Game.muteCommentary = false;
      Voice.stop(); // 立刻打斷正在播的語音
    });

    $('btnNextRound').addEventListener('click', function () {
      Game.autoNextAt = null; // 手動進場：取消自動循環倒數
      UI.hideModal('resultModal');
      if (Game.mp.active) {
        if (Game.mp.host) mpNewRound(); // 客人按鈕已停用，等房主廣播
      } else {
        newRound();
      }
    });

    // 多人房間
    $('btnMp').addEventListener('click', function () {
      $('mpName').value = store.get('name', '');
      UI.showModal('mpModal');
    });
    $('btnMpClose').addEventListener('click', function () { UI.hideModal('mpModal'); });
    $('btnMpHost').addEventListener('click', function () {
      UI.hideModal('mpModal');
      enterHost();
    });
    $('btnMpJoin').addEventListener('click', function () {
      enterJoin($('mpCode').value);
    });
    $('btnMpLeave').addEventListener('click', function () {
      UI.hideModal('mpModal');
      leaveMP('📣 已離開房間，回到單機模式。');
    });
    $('btnMpCopy').addEventListener('click', function () {
      var link = location.origin + location.pathname + '#room=' + Game.mp.code;
      try {
        navigator.clipboard.writeText(link);
        $('btnMpCopy').textContent = '已複製 ✓';
        setTimeout(function () { $('btnMpCopy').textContent = '複製邀請連結'; }, 1500);
      } catch (e) { prompt('複製這個連結給朋友：', link); }
    });

    $('btnVerify').addEventListener('click', openVerify);
    $('btnVerifyFromResult').addEventListener('click', openVerify);
    $('btnCloseVerify').addEventListener('click', function () { UI.hideModal('verifyModal'); });

    // 設定
    $('btnSettings').addEventListener('click', function () {
      $('setRtp').value = String(Game.settings.rtp);
      $('setHorses').value = String(Game.settings.horses);
      $('setDuration').value = String(Game.settings.duration);
      $('setRacer').value = Game.settings.racer;
      // 列出可用中文語音（依品質排序）
      var sel = $('setVoice');
      var saved = store.get('voiceName', '');
      sel.innerHTML = '<option value="">自動（優先男聲/自然語音）</option>';
      Voice.listZh().forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = v.name + '（' + v.lang + '）';
        if (v.name === saved) opt.selected = true;
        sel.appendChild(opt);
      });
      UI.showModal('settingsModal');
    });
    $('btnCloseSettings').addEventListener('click', function () {
      Game.settings.rtp = parseFloat($('setRtp').value);
      Game.settings.horses = parseInt($('setHorses').value, 10);
      Game.settings.duration = parseInt($('setDuration').value, 10);
      Game.settings.racer = $('setRacer').value;
      store.set('rtp', Game.settings.rtp);
      store.set('horses', Game.settings.horses);
      store.set('duration', Game.settings.duration);
      store.set('racer', Game.settings.racer);
      var vName = $('setVoice').value;
      store.set('voiceName', vName);
      Voice.setPreferred(vName);
      if (vName) Voice.speak('語音測試，祝您旗開得勝！', 1.15); // 立即試聽
      UI.hideModal('settingsModal');
    });
    $('btnResetWallet').addEventListener('click', function () {
      if (!confirm('確定重置錢包回 10,000 點？')) return;
      // 退掉本場已下注金額，避免結算時憑空多派彩
      Game.bets = [];
      savePending();
      renderBets();
      Game.balance = 10000;
      store.set('balance', Game.balance);
      updateBalance();
    });

    // 語音旁述開關
    $('btnVoice').addEventListener('click', function () {
      var on = !Voice.isEnabled();
      Voice.setEnabled(on);
      store.set('voice', on);
      $('btnVoice').textContent = on ? '🔊' : '🔇';
    });

    // 說明
    $('btnHelp').addEventListener('click', function () { UI.showModal('helpModal'); });
    $('btnCloseHelp').addEventListener('click', function () { UI.hideModal('helpModal'); });
    UI.bindTabs($('helpTabs'), function (tab) {
      document.querySelectorAll('.help-page').forEach(function (p) {
        p.classList.toggle('hidden', p.id !== tab);
      });
    });
  }

  // ---------- 背景節拍器與截止時刻 ----------
  // Web Worker 計時不受背景分頁節流：背景時驅動比賽推進、倒數鎖注、自動下一場，
  // 避免房主切到別的視窗後全房卡住（rAF 在背景完全停擺）。
  function checkDeadlines() {
    if (Game.conflictShown) return;
    var now = Date.now();
    // 下注倒數
    if (Game.phase === 'betting' && Game.countdownEndsAt) {
      if (!Game.mp.active && UI.anyModalOpen()) {
        Game.countdownEndsAt += now - (Game._lastDl || now); // 單機看面板：順延
      } else {
        var remain = Math.ceil((Game.countdownEndsAt - now) / 1000);
        if (remain !== Game.countdown) {
          Game.countdown = Math.max(0, remain);
          $('countdown').textContent = Game.countdown;
        }
        if (remain <= 0) {
          Game.countdownEndsAt = null;
          if (Game.mp.active && Game.mp.host) mpLock();
          else if (!Game.mp.active) startRace();
          // 多人客人：顯示 0，等房主的鎖注訊息
        }
      }
    }
    // 房主：鎖注後收隨機數的窗口到期 → 廣播開跑
    if (Game.mp.startAt && Game.mp.active && Game.mp.host && now >= Game.mp.startAt) {
      Game.mp.startAt = null;
      var order = Model.finishFromSeeds(Game.mp.hostSeed, Game.mp.nonces, Game.round.horses);
      Net.broadcast({ t: 'start', order: order, nonces: Game.mp.nonces });
      mpStartRace(order);
    }
    // 機台式持續循環：結果顯示後自動開下一場（房主/單機）
    if (Game.autoNextAt && Game.phase === 'result' && (!Game.mp.active || Game.mp.host)) {
      var busy = false;
      ['verifyModal', 'settingsModal', 'helpModal', 'mpModal'].forEach(function (id) {
        if (!document.getElementById(id).classList.contains('hidden')) busy = true;
      });
      if (busy) {
        Game.autoNextAt += now - (Game._lastDl || now); // 玩家在看面板：順延
      } else {
        var r2 = Math.ceil((Game.autoNextAt - now) / 1000);
        if (r2 !== Game.autoNextRemain) {
          Game.autoNextRemain = r2;
          var nb = $('btnNextRound');
          if (r2 > 0) {
            nb.textContent = '下一場 ▶（' + r2 + ' 秒後自動）';
          }
        }
        if (r2 <= 0) {
          Game.autoNextAt = null;
          UI.hideModal('resultModal');
          if (Game.mp.active && Game.mp.host) mpNewRound();
          else if (!Game.mp.active) newRound();
        }
      }
    }
    // 心跳：房主每 2 秒廣播並清理失聯客人（寬限 25s，行動網路抖動/短暫背景不誤殺）；
    // 客人前景下 12 秒沒心跳 → 自動重連（多次失敗才退房）。背景不判定（整頁可能被暫停）
    if (Game.mp.active) {
      if (Game.mp.host) {
        if (!Game._lastPingOut || now - Game._lastPingOut >= 2000) {
          Game._lastPingOut = now;
          Net.heartbeat(25000);
        }
      } else if (!document.hidden && !Game.mp.reconnecting &&
                 Net.lastPing && now - Net.lastPing > 12000) {
        mpReconnect();
      }
    }
    Game._lastDl = now;
  }

  // 回到前景：行動裝置鎖屏/切 App 會把整頁暫停，心跳必然過期——
  // 先給寬限並催一次快照（房主若已換場會立刻補上）；連線已死則執行延後的重連
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !Game.mp.active || Game.mp.host) return;
    if (Game.mp.needReconnect) {
      Game.mp.needReconnect = false;
      mpReconnect();
    } else {
      Net.lastPing = Date.now();
      Net.resendHello();
    }
  });

  var ticker = null;
  try {
    var tickBlob = new Blob(['setInterval(function(){postMessage(1)},250);'], { type: 'text/javascript' });
    ticker = new Worker(URL.createObjectURL(tickBlob));
    var lastTickWall = Date.now();
    ticker.onmessage = function () {
      var now = Date.now();
      var dt = (now - lastTickWall) / 1000;
      lastTickWall = now;
      // 背景時 rAF 停擺：由節拍器推進比賽（含 321 倒數開閘、定格、完賽結算）
      if (document.hidden && Game.animator && Game.animator.running && Game.animator.advance) {
        Game.animator.advance(dt);
      }
      checkDeadlines();
    };
  } catch (e) {
    console.warn('Worker 節拍器不可用，退回前景計時', e);
  }
  setInterval(checkDeadlines, 500); // 前景備援（Worker 不可用時仍能運作）

  // ---------- 響應式賽事畫布 ----------
  // 手機直版時改用近正方形比例，賽事畫面占滿螢幕寬（桌面維持寬螢幕轉播比例）
  function fitTrackCanvas() {
    var cv = $('track'), ov = $('overlay');
    var portrait = window.innerWidth < window.innerHeight;
    var W = 920;
    var H = portrait ? 860 : 440;
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
      if (ov) { ov.width = W; ov.height = H; }
      if (Game.animator && Game.animator.resize) Game.animator.resize();
    }
  }
  window.addEventListener('resize', fitTrackCanvas);
  window.addEventListener('orientationchange', fitTrackCanvas);

  // ---------- 多分頁防護 ----------
  // storage 事件只會由「其他分頁」的寫入觸發：偵測到即凍結本分頁，
  // 避免兩個分頁互相覆寫注單與餘額（單機網頁多人「同時玩」唯一的衝突來源）。
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf('hr_') !== 0 || Game.conflictShown) return;
    Game.conflictShown = true;
    store.disabled = true;
    Game.countdownEndsAt = null;
    Game.autoNextAt = null;
    if (Game.mp.active) Net.leave(); // 衝突分頁若在房間中先退出，避免殭屍連線
    if (Game.animator) Game.animator.stop();
    Voice.stop();
    var d = document.createElement('div');
    d.className = 'modal';
    d.innerHTML = '<div class="modal-box"><h2>⚠ 偵測到多個分頁</h2>' +
      '<p>本遊戲已在另一個分頁／視窗進行中。為避免注單與餘額互相覆寫，本分頁已暫停且不再存檔。</p>' +
      '<p>請只用一個分頁遊玩。</p>' +
      '<div class="modal-actions"><button class="primary" id="btnReloadTab">重新載入本分頁</button></div></div>';
    document.body.appendChild(d);
    d.querySelector('#btnReloadTab').addEventListener('click', function () { location.reload(); });
  });

  // ---------- 啟動 ----------
  fitTrackCanvas(); // 先依裝置方向定好畫布比例，再建場次
  bindEvents();
  var voiceOn = store.get('voice', true);
  Voice.setEnabled(voiceOn);
  Voice.setPreferred(store.get('voiceName', '') || null);
  $('btnVoice').textContent = voiceOn ? '🔊' : '🔇';
  // 邀請連結 #room=XXXX：自動帶入房號並打開多人面板
  var roomMatch = location.hash.match(/room=([A-Za-z0-9]{4,8})/);
  if (roomMatch) {
    setTimeout(function () {
      $('mpName').value = store.get('name', '');
      $('mpCode').value = roomMatch[1].toUpperCase();
      UI.showModal('mpModal');
    }, 300);
  }

  // 有未結算的場次（含已下注未開獎）→ 還原同一場；否則開新場次
  var pending = store.get('pending', null);
  if (pending && pending.seed && typeof pending.no === 'number') {
    try {
      resumeRound(pending);
    } catch (e) {
      console.warn('場次還原失敗，開新場次：', e);
      newRound();
    }
  } else {
    newRound();
  }
  if (!store.get('helpSeen', false)) {
    UI.showModal('helpModal');
    store.set('helpSeen', true);
  }
})();
