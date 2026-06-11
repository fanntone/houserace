/* main.js — 遊戲狀態機：下注 → 比賽 → 派彩 循環、錢包、設定、公平驗證 */
(function () {
  'use strict';

  var $ = UI.$;
  var BETTING_SECONDS = 45;

  // ---------- 儲存（localStorage，失敗則僅存在記憶體） ----------
  var store = {
    get: function (k, dflt) {
      try {
        var v = localStorage.getItem('hr_' + k);
        return v === null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },
    set: function (k, v) {
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
      duration: store.get('duration', 38)
    },
    round: null,
    lastRound: null,
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
  }

  function renderBets() {
    UI.renderBetList($('betList'), Game.bets, Game.phase === 'betting', removeBet);
  }

  // ---------- 場次 ----------
  function newRound() {
    Voice.stop();
    Game.roundCounter++;
    store.set('round', Game.roundCounter);

    var seed = RNG.randomSeedHex();
    var round = Model.buildRound(seed, Game.settings.horses, Game.settings.rtp);
    round.no = Game.roundCounter;
    Game.round = round;
    Game.bets = [];
    Game.sel = null;
    Game.amount = 0;

    if (Game.animator) Game.animator.stop();
    var animOpts = {
      duration: Game.settings.duration,
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
      Game.animator = new RaceAnimator3D($('track'), round.horses, round.finishOrder, animOpts);
    } catch (e) {
      console.warn('3D 初始化失敗，改用 2D 渲染：', e);
      Game.animator = new RaceAnimator($('track'), round.horses, round.finishOrder, animOpts);
    }
    Game.animator.drawIdle();

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
    Game.countdown = BETTING_SECONDS;
    $('countdown').textContent = Game.countdown;
    if (Game.countdownTimer) clearInterval(Game.countdownTimer);
    Game.countdownTimer = setInterval(function () {
      if (UI.anyModalOpen()) return; // 看說明/設定時暫停倒數
      Game.countdown--;
      $('countdown').textContent = Game.countdown;
      if (Game.countdown <= 0) startRace();
    }, 1000);
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
    updateBalance();
    renderBets();
    hideTicket();
  }

  function removeBet(i) {
    if (Game.phase !== 'betting') return;
    var bet = Game.bets.splice(i, 1)[0];
    Game.balance += bet.amount;
    store.set('balance', Game.balance);
    updateBalance();
    renderBets();
  }

  // ---------- 比賽與結算 ----------
  function startRace() {
    if (Game.phase !== 'betting') return;
    clearInterval(Game.countdownTimer);
    Game.countdownTimer = null;
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
    Game.lastRound = round;

    setPhase('result');
    updateBalance();
    UI.renderRankBoard($('rankBoard'), round.horses, round.finishOrder, round.market, true);
    $('fairSeedWrap').classList.remove('hidden');
    $('fairSeed').textContent = round.seed;
    UI.renderResult(round, res, Game.balance);
    UI.showModal('resultModal');
  }

  function openVerify() {
    if (!Game.lastRound) return;
    UI.renderVerify(Game.lastRound);
    UI.showModal('verifyModal');
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

    $('btnStartNow').addEventListener('click', startRace);
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
      UI.hideModal('resultModal');
      newRound();
    });

    $('btnVerify').addEventListener('click', openVerify);
    $('btnVerifyFromResult').addEventListener('click', openVerify);
    $('btnCloseVerify').addEventListener('click', function () { UI.hideModal('verifyModal'); });

    // 設定
    $('btnSettings').addEventListener('click', function () {
      $('setRtp').value = String(Game.settings.rtp);
      $('setHorses').value = String(Game.settings.horses);
      $('setDuration').value = String(Game.settings.duration);
      UI.showModal('settingsModal');
    });
    $('btnCloseSettings').addEventListener('click', function () {
      Game.settings.rtp = parseFloat($('setRtp').value);
      Game.settings.horses = parseInt($('setHorses').value, 10);
      Game.settings.duration = parseInt($('setDuration').value, 10);
      store.set('rtp', Game.settings.rtp);
      store.set('horses', Game.settings.horses);
      store.set('duration', Game.settings.duration);
      UI.hideModal('settingsModal');
    });
    $('btnResetWallet').addEventListener('click', function () {
      if (!confirm('確定重置錢包回 10,000 點？')) return;
      // 退掉本場已下注金額，避免結算時憑空多派彩
      Game.bets = [];
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

  // ---------- 啟動 ----------
  bindEvents();
  var voiceOn = store.get('voice', true);
  Voice.setEnabled(voiceOn);
  $('btnVoice').textContent = voiceOn ? '🔊' : '🔇';
  newRound();
  if (!store.get('helpSeen', false)) {
    UI.showModal('helpModal');
    store.set('helpSeen', true);
  }
})();
