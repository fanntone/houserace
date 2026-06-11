/* model.js — 馬匹生成、Plackett-Luce 機率與公平賠率、賽果抽樣（瀏覽器 / Node 通用） */
(function (global) {
  'use strict';

  var RNG = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : global.RNG;

  // 虛構馬名池（每場隨機取用，不重複）
  var NAMES = [
    '赤兔千里', '的盧飛影', '絕影追風', '爪黃飛電', '雷霆一閃', '破曉之星',
    '金戈鐵馬', '風馳電掣', '夜照玉獅', '烈焰紅駒', '青雲直上', '萬里無雲',
    '銀鞍白馬', '踏雪無痕', '驚雷破陣', '旭日東昇', '凌雲壯志', '追星趕月'
  ];

  // 鞍號布色（仿 JRA 枠色：白黑紅藍黃綠橙粉 + 延伸色）
  var SADDLE = [
    { bg: '#f4f4f4', fg: '#1a1a1a' }, // 1 白
    { bg: '#23272e', fg: '#ffffff' }, // 2 黑
    { bg: '#e03131', fg: '#ffffff' }, // 3 紅
    { bg: '#1c7ed6', fg: '#ffffff' }, // 4 藍
    { bg: '#f5c518', fg: '#1a1a1a' }, // 5 黃
    { bg: '#2f9e44', fg: '#ffffff' }, // 6 綠
    { bg: '#f76707', fg: '#ffffff' }, // 7 橙
    { bg: '#f783ac', fg: '#1a1a1a' }, // 8 粉
    { bg: '#9c36b5', fg: '#ffffff' }, // 9 紫
    { bg: '#0ca678', fg: '#ffffff' }, // 10 青
    { bg: '#845ef7', fg: '#ffffff' }, // 11 藍紫
    { bg: '#a0826d', fg: '#ffffff' }  // 12 棕
  ];

  // 馬匹毛色（俯視繪圖用；避開與沙地跑道 #b9854c 相近的色調）
  var COATS = [
    { body: '#7d4a26', dark: '#4a2a12' }, // 棗紅（bay）
    { body: '#9c5530', dark: '#5e3018' }, // 栗毛（chestnut）
    { body: '#4f3018', dark: '#2b1809' }, // 深棗（dark bay）
    { body: '#332d2a', dark: '#16120f' }, // 黑鹿（black）
    { body: '#cfcbc4', dark: '#8d8780' }, // 灰白（grey）
    { body: '#6b3b2a', dark: '#3d2015' }, // 肝栗（liver）
    { body: '#76716c', dark: '#46423e' }, // 深灰（dark grey）
    { body: '#8f4a3a', dark: '#562a1f' }, // 紅棗（red bay）
    { body: '#5c4a3a', dark: '#332821' }  // 煙褐（smoky brown）
  ];

  var STRENGTH_SIGMA = 0.85; // 實力值離散度（log-normal），決定熱門/冷門差距

  function generateHorses(rand, n) {
    var pool = NAMES.slice();
    var horses = [];
    for (var i = 0; i < n; i++) {
      var j = i + Math.floor(rand() * (pool.length - i));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      horses.push({
        num: i + 1,
        name: pool[i],
        color: SADDLE[i],
        // 毛色依馬名固定（純外觀，不消耗隨機數，不影響種子重現）
        coat: COATS[NAMES.indexOf(pool[i]) % COATS.length],
        strength: Math.exp(STRENGTH_SIGMA * RNG.normal(rand))
      });
    }
    return horses;
  }

  function sum(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
  }

  // 獨贏機率：p_i = s_i / Σs
  function winProbs(strengths) {
    var S = sum(strengths);
    return strengths.map(function (s) { return s / S; });
  }

  // 二重彩機率：P(i 第1、j 第2) = (s_i/Σs) × (s_j/(Σs − s_i))
  function exactaProb(strengths, S, i, j) {
    return (strengths[i] / S) * (strengths[j] / (S - strengths[i]));
  }

  // 位置機率：枚舉前 k 名所有排列（k=2 或 3，n≤12 時最多 1320 項）
  function placeProbs(strengths, k) {
    var n = strengths.length, S = sum(strengths);
    var p = new Array(n);
    for (var x = 0; x < n; x++) p[x] = 0;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var p2 = exactaProb(strengths, S, i, j);
        if (k === 2) {
          p[i] += p2; p[j] += p2;
        } else {
          for (var l = 0; l < n; l++) {
            if (l === i || l === j) continue;
            var p3 = p2 * (strengths[l] / (S - strengths[i] - strengths[j]));
            p[i] += p3; p[j] += p3; p[l] += p3;
          }
        }
      }
    }
    return p;
  }

  // 機率 → 賠率（小數賠率，含派彩率；payout = 注金 × 賠率）
  function toOdds(p, rtp) {
    var o = rtp / p;
    if (o < 1.01) o = 1.01;
    if (o > 9999) o = 9999;
    return Math.round(o * 100) / 100;
  }

  /**
   * 計算整個盤口。回傳：
   * {
   *   placeCount,                          // 位置算前幾名（≥7 匹算前三，否則前二）
   *   win:   [{ p, odds } × n],            // 索引 = 馬匹索引（0-based）
   *   place: [{ p, odds } × n],
   *   quinella: { 'a-b': { p, odds } },    // a < b，皆為馬號（1-based）
   *   exacta:   { 'a-b': { p, odds } }     // a = 冠軍馬號, b = 亞軍馬號
   * }
   */
  function computeMarket(horses, rtp) {
    var strengths = horses.map(function (h) { return h.strength; });
    var n = strengths.length, S = sum(strengths);
    var placeCount = n >= 7 ? 3 : 2;

    var win = winProbs(strengths).map(function (p) { return { p: p, odds: toOdds(p, rtp) }; });
    var place = placeProbs(strengths, placeCount).map(function (p) { return { p: p, odds: toOdds(p, rtp) }; });

    var quinella = {}, exacta = {};
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var pe = exactaProb(strengths, S, i, j);
        exacta[(i + 1) + '-' + (j + 1)] = { p: pe, odds: toOdds(pe, rtp) };
        if (i < j) {
          var pq = pe + exactaProb(strengths, S, j, i);
          quinella[(i + 1) + '-' + (j + 1)] = { p: pq, odds: toOdds(pq, rtp) };
        }
      }
    }
    return { placeCount: placeCount, win: win, place: place, quinella: quinella, exacta: exacta };
  }

  // 依 Plackett-Luce 逐位抽出完整名次（回傳馬匹索引陣列，0-based，依名次排列）
  function sampleFinishOrder(rand, strengths) {
    var idx = [];
    for (var i = 0; i < strengths.length; i++) idx.push(i);
    var order = [];
    while (idx.length > 0) {
      var total = 0, k;
      for (k = 0; k < idx.length; k++) total += strengths[idx[k]];
      var r = rand() * total, acc = 0, pick = idx.length - 1;
      for (k = 0; k < idx.length; k++) {
        acc += strengths[idx[k]];
        if (r < acc) { pick = k; break; }
      }
      order.push(idx[pick]);
      idx.splice(pick, 1);
    }
    return order;
  }

  /**
   * 由種子確定性地建立一整場比賽（可驗證公平的核心）：
   * 同一個 seed 必定重現同樣的馬匹、實力、賠率與名次。
   */
  function buildRound(seedHex, numHorses, rtp) {
    var rand = RNG.seededRand(seedHex);
    var horses = generateHorses(rand, numHorses);
    var market = computeMarket(horses, rtp);
    var finishOrder = sampleFinishOrder(rand, horses.map(function (h) { return h.strength; }));
    return {
      seed: seedHex,
      hash: RNG.sha256(seedHex),
      rtp: rtp,
      horses: horses,
      market: market,
      finishOrder: finishOrder // 馬匹索引（0-based）
    };
  }

  var Model = {
    NAMES: NAMES,
    SADDLE: SADDLE,
    generateHorses: generateHorses,
    winProbs: winProbs,
    placeProbs: placeProbs,
    computeMarket: computeMarket,
    sampleFinishOrder: sampleFinishOrder,
    buildRound: buildRound
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  else global.Model = Model;
})(typeof window !== 'undefined' ? window : this);
