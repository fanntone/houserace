/* fairness-test.js — 公平性驗證（Node 執行：node test/fairness-test.js）
 *
 * 驗證三件事，合起來證明遊戲公平：
 *   A. 賠率誠實：每個盤口項目 機率 × 賠率 = 派彩率（解析檢查，零誤差）
 *   B. 賽果誠實：抽樣頻率 = 宣稱機率（蒙地卡羅 + z 檢定）
 *   C. 結算正確：完整下注→結算流程的長期回報率 = 派彩率
 * 另含 SHA-256 標準測試向量與種子確定性檢查（可驗證公平的基礎）。
 */
'use strict';

var RNG = require('../js/rng.js');
var Model = require('../js/model.js');
var Betting = require('../js/betting.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ←─ 失敗 ' + (detail || '')));
  if (!ok) failures++;
}
function fmt(x, d) { return x.toFixed(d === undefined ? 4 : d); }

// ---------- 0. SHA-256 標準測試向量 ----------
console.log('\n[0] SHA-256 標準測試向量');
check('sha256("")', RNG.sha256('') ===
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', RNG.sha256(''));
check('sha256("abc")', RNG.sha256('abc') ===
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', RNG.sha256('abc'));
check('sha256(56 字元)', RNG.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

// ---------- 1. 種子確定性：同種子必重現同一場比賽 ----------
console.log('\n[1] 種子確定性（commit-reveal 驗證的基礎）');
var seedA = '0123456789abcdef0123456789abcdef';
var rA = Model.buildRound(seedA, 8, 1.0);
var rB = Model.buildRound(seedA, 8, 1.0);
check('名次重現', rA.finishOrder.join(',') === rB.finishOrder.join(','));
check('賠率重現', JSON.stringify(rA.market) === JSON.stringify(rB.market));
check('雜湊 = sha256(seed)', rA.hash === RNG.sha256(seedA));
var rC = Model.buildRound('ffff0000ffff0000ffff0000ffff0000', 8, 1.0);
check('不同種子產生不同賽果（抽查）',
  rA.finishOrder.join(',') !== rC.finishOrder.join(',') || rA.horses[0].name !== rC.horses[0].name);

// ---------- 2. 賠率誠實（解析檢查）：p × odds ≈ rtp ----------
console.log('\n[2] 賠率誠實：每個盤口項目 機率 × 賠率 = 派彩率（200 場 × 2 種派彩率）');
[1.0, 0.92].forEach(function (rtp) {
  var maxErr = 0, items = 0, clamped = 0;
  for (var i = 0; i < 200; i++) {
    var seed = RNG.sha256('odds-' + rtp + '-' + i).slice(0, 32);
    var round = Model.buildRound(seed, 8, rtp);
    var m = round.market;
    var entries = [];
    m.win.forEach(function (e) { entries.push(e); });
    m.place.forEach(function (e) { entries.push(e); });
    Object.keys(m.quinella).forEach(function (k) { entries.push(m.quinella[k]); });
    Object.keys(m.exacta).forEach(function (k) { entries.push(m.exacta[k]); });
    entries.forEach(function (e) {
      if (e.odds <= 1.01 || e.odds >= 9999) { clamped++; return; } // 夾限項目（極端機率）不計
      var err = Math.abs(e.p * e.odds - rtp);
      var tol = e.p * 0.005 + 1e-12; // 賠率四捨五入到小數 2 位的最大誤差
      if (err > tol && err > maxErr) maxErr = err;
      if (err > tol) items++;
    });
  }
  check('rtp=' + rtp + '：所有項目 |p×odds − rtp| 在捨入容差內（夾限 ' + clamped + ' 項）',
    items === 0, '超差 ' + items + ' 項，最大誤差 ' + fmt(maxErr, 6));
});

// ---------- 2.5 機率總和不變量（含 6 匹/12 匹的位置規則） ----------
console.log('\n[2.5] 機率總和不變量');
[6, 8, 12].forEach(function (n) {
  var round = Model.buildRound(RNG.sha256('inv-' + n).slice(0, 32), n, 1.0);
  var m = round.market;
  function total(arr) { return arr.reduce(function (s, e) { return s + e.p; }, 0); }
  function totalMap(obj) { return Object.keys(obj).reduce(function (s, k) { return s + obj[k].p; }, 0); }
  var ok = Math.abs(total(m.win) - 1) < 1e-9 &&
           Math.abs(total(m.place) - m.placeCount) < 1e-9 &&
           Math.abs(totalMap(m.quinella) - 1) < 1e-9 &&
           Math.abs(totalMap(m.exacta) - 1) < 1e-9;
  check(n + ' 匹：Σ獨贏=1、Σ位置=' + m.placeCount + '（前' + m.placeCount + '名）、Σ連贏=1、Σ二重彩=1', ok);
});

// ---------- 3. 賽果誠實（蒙地卡羅）：抽樣頻率 = 宣稱機率 ----------
console.log('\n[3] 賽果誠實：固定一組實力抽 30 萬次名次，頻率 vs 機率（z 檢定）');
(function () {
  var N = 300000;
  var round = Model.buildRound('a1b2c3d4e5f60718a1b2c3d4e5f60718', 8, 1.0);
  var strengths = round.horses.map(function (h) { return h.strength; });
  var m = round.market;
  var n = 8;

  var winCnt = new Array(n).fill(0);
  var placeCnt = new Array(n).fill(0);
  var quinCnt = {}, exaCnt = {};
  Object.keys(m.quinella).forEach(function (k) { quinCnt[k] = 0; });
  Object.keys(m.exacta).forEach(function (k) { exaCnt[k] = 0; });

  var rand = RNG.seededRand(RNG.sha256('mc-sampling').slice(0, 32));
  for (var t = 0; t < N; t++) {
    var ord = Model.sampleFinishOrder(rand, strengths);
    var f1 = ord[0] + 1, f2 = ord[1] + 1;
    winCnt[ord[0]]++;
    for (var k = 0; k < m.placeCount; k++) placeCnt[ord[k]]++;
    quinCnt[Math.min(f1, f2) + '-' + Math.max(f1, f2)]++;
    exaCnt[f1 + '-' + f2]++;
  }

  function maxZ(pairs) { // pairs: [{p, cnt}]
    var z = 0;
    pairs.forEach(function (e) {
      var sd = Math.sqrt(e.p * (1 - e.p) / N);
      var zz = Math.abs(e.cnt / N - e.p) / sd;
      if (zz > z) z = zz;
    });
    return z;
  }
  var zWin = maxZ(m.win.map(function (e, i) { return { p: e.p, cnt: winCnt[i] }; }));
  var zPlace = maxZ(m.place.map(function (e, i) { return { p: e.p, cnt: placeCnt[i] }; }));
  var zQuin = maxZ(Object.keys(m.quinella).map(function (k) { return { p: m.quinella[k].p, cnt: quinCnt[k] }; }));
  var zExa = maxZ(Object.keys(m.exacta).map(function (k) { return { p: m.exacta[k].p, cnt: exaCnt[k] }; }));

  check('獨贏   頻率≈機率（max z = ' + fmt(zWin, 2) + ' < 4.5）', zWin < 4.5);
  check('位置   頻率≈機率（max z = ' + fmt(zPlace, 2) + ' < 4.5）', zPlace < 4.5);
  check('連贏   頻率≈機率（max z = ' + fmt(zQuin, 2) + ' < 4.5）', zQuin < 4.5);
  check('二重彩 頻率≈機率（max z = ' + fmt(zExa, 2) + ' < 4.5）', zExa < 4.5);
})();

// ---------- 4. 結算邏輯單元檢查 ----------
console.log('\n[4] 結算邏輯（名次 3-7-5-…，前三名 3,7,5）');
(function () {
  var finish = [3, 7, 5, 1, 2, 4, 6, 8];
  function w(type, sel) { return Betting.isWinner({ type: type, sel: sel }, finish, 3); }
  check('獨贏 3 中、獨贏 7 不中', w('win', [3]) && !w('win', [7]));
  check('位置 3/7/5 中、位置 1 不中', w('place', [3]) && w('place', [7]) && w('place', [5]) && !w('place', [1]));
  check('連贏 3-7 與 7-3 皆中、3-5 不中', w('quinella', [3, 7]) && w('quinella', [7, 3]) && !w('quinella', [3, 5]));
  check('二重彩 3→7 中、7→3 不中', w('exacta', [3, 7]) && !w('exacta', [7, 3]));
  var s = Betting.settle([{ type: 'win', sel: [3], amount: 100, odds: 4.5 }], finish, 3);
  check('派彩 = 注金×賠率（100×4.5=450）', s.totalPayout === 450 && s.net === 350);
})();

// ---------- 5. 整合模擬：完整下注→結算的長期回報率 = 派彩率 ----------
console.log('\n[5] 整合模擬：每回合四種玩法各隨機下 1 注，長期回報率 ≈ 派彩率');
[{ rtp: 1.0, rounds: 60000 }, { rtp: 0.92, rounds: 40000 }].forEach(function (cfg) {
  var betRand = RNG.seededRand(RNG.sha256('bets-' + cfg.rtp).slice(0, 32));
  var stake = { win: 0, place: 0, quinella: 0, exacta: 0 };
  var ret = { win: 0, place: 0, quinella: 0, exacta: 0 };
  for (var i = 0; i < cfg.rounds; i++) {
    var seed = RNG.sha256('sim-' + cfg.rtp + '-' + i).slice(0, 32);
    var round = Model.buildRound(seed, 8, cfg.rtp);
    var finishNums = round.finishOrder.map(function (x) { return x + 1; });
    var a = 1 + Math.floor(betRand() * 8);
    var b = 1 + Math.floor(betRand() * 7); if (b >= a) b++;
    var bets = [
      { type: 'win', sel: [a], amount: 10 },
      { type: 'place', sel: [b], amount: 10 },
      { type: 'quinella', sel: [a, b], amount: 10 },
      { type: 'exacta', sel: [a, b], amount: 10 }
    ];
    bets.forEach(function (bet) { bet.odds = Betting.getOdds(round.market, bet.type, bet.sel); });
    var s = Betting.settle(bets, finishNums, round.market.placeCount);
    s.results.forEach(function (r) {
      stake[r.bet.type] += r.bet.amount;
      ret[r.bet.type] += r.payout;
    });
  }
  var tol = { win: 0.06, place: 0.03, quinella: 0.10, exacta: 0.15 };
  Object.keys(stake).forEach(function (type) {
    var rate = ret[type] / stake[type];
    check('rtp=' + cfg.rtp + ' ' + Betting.BET_TYPES[type].label +
      '\t回報率 ' + fmt(rate, 4) + '（容差 ±' + tol[type] + '）',
      Math.abs(rate - cfg.rtp) < tol[type]);
  });
});

console.log('\n' + (failures === 0 ? '全部通過 ✓ — 賠率與賽果經驗證為公平' : '失敗 ' + failures + ' 項 ✗'));
process.exit(failures === 0 ? 0 : 1);
