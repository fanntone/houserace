/* betting.js — 投注種類定義、賠率查詢、注單結算（瀏覽器 / Node 通用） */
(function (global) {
  'use strict';

  var BET_TYPES = {
    win:      { label: '獨贏',   picks: 1, desc: '猜中第 1 名' },
    place:    { label: '位置',   picks: 1, desc: '猜中前三名其中之一（不足 7 匹馬時為前二名）' },
    quinella: { label: '連贏',   picks: 2, desc: '猜中第 1、2 名（不分先後）' },
    exacta:   { label: '二重彩', picks: 2, desc: '依順序猜中第 1 名與第 2 名' }
  };

  function keyFor(type, sel) {
    if (type === 'win' || type === 'place') return String(sel[0]);
    if (type === 'quinella') {
      var a = Math.min(sel[0], sel[1]), b = Math.max(sel[0], sel[1]);
      return a + '-' + b;
    }
    return sel[0] + '-' + sel[1];
  }

  // sel 為馬號（1-based）陣列
  function getOdds(market, type, sel) {
    if (type === 'win') return market.win[sel[0] - 1].odds;
    if (type === 'place') return market.place[sel[0] - 1].odds;
    if (type === 'quinella') return market.quinella[keyFor(type, sel)].odds;
    return market.exacta[keyFor(type, sel)].odds;
  }

  // finishNums = 依名次排列的馬號（1-based）
  function isWinner(bet, finishNums, placeCount) {
    var first = finishNums[0], second = finishNums[1];
    switch (bet.type) {
      case 'win':
        return bet.sel[0] === first;
      case 'place':
        return finishNums.slice(0, placeCount).indexOf(bet.sel[0]) !== -1;
      case 'quinella':
        return (bet.sel[0] === first && bet.sel[1] === second) ||
               (bet.sel[0] === second && bet.sel[1] === first);
      case 'exacta':
        return bet.sel[0] === first && bet.sel[1] === second;
    }
    return false;
  }

  // bets = [{ type, sel, amount, odds }]；派彩 = 注金 × 賠率（含本金），四捨五入到整數點
  function settle(bets, finishNums, placeCount) {
    var results = [], totalStake = 0, totalPayout = 0;
    for (var i = 0; i < bets.length; i++) {
      var bet = bets[i];
      var won = isWinner(bet, finishNums, placeCount);
      var payout = won ? Math.round(bet.amount * bet.odds) : 0;
      totalStake += bet.amount;
      totalPayout += payout;
      results.push({ bet: bet, won: won, payout: payout });
    }
    return { results: results, totalStake: totalStake, totalPayout: totalPayout, net: totalPayout - totalStake };
  }

  function describeBet(bet) {
    return BET_TYPES[bet.type].label + ' ' + bet.sel.join(bet.type === 'exacta' ? '→' : '-');
  }

  var Betting = {
    BET_TYPES: BET_TYPES,
    keyFor: keyFor,
    getOdds: getOdds,
    isWinner: isWinner,
    settle: settle,
    describeBet: describeBet
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Betting;
  else global.Betting = Betting;
})(typeof window !== 'undefined' ? window : this);
