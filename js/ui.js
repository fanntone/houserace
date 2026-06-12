/* ui.js — 畫面渲染：賠率表/矩陣、注單列表、名次板、結果與驗證面板 */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function money(x) { return Math.round(x).toLocaleString('zh-Hant'); }

  function numChip(horse) {
    return '<span class="numchip" style="background:' + horse.color.bg +
           ';color:' + horse.color.fg + '">' + horse.num + '</span>';
  }

  function pct(p) {
    return (p * 100 >= 10 ? (p * 100).toFixed(1) : (p * 100).toFixed(2)) + '%';
  }

  function oddsText(o) { return o >= 100 ? o.toFixed(0) : o.toFixed(2); }

  // ---------- 賠率區（獨贏/位置 = 表格；連贏/二重彩 = 矩陣） ----------
  function renderOddsArea(container, round, type, onSelect) {
    var horses = round.horses, m = round.market, n = horses.length;
    container.innerHTML = '';

    if (type === 'win' || type === 'place') {
      var entries = (type === 'win') ? m.win : m.place;
      var tbl = document.createElement('table');
      tbl.className = 'odds-table';
      var head = (type === 'win') ? '勝率' : '入位率';
      var html = '<tr><th>號</th><th>馬名</th><th>' + head + '</th><th>賠率</th></tr>';
      for (var i = 0; i < n; i++) {
        html += '<tr class="pickable" data-key="' + horses[i].num + '">' +
          '<td>' + numChip(horses[i]) + '</td>' +
          '<td class="hname">' + horses[i].name + '</td>' +
          '<td class="prob">' + pct(entries[i].p) + '</td>' +
          '<td class="odds">' + oddsText(entries[i].odds) + '</td></tr>';
      }
      tbl.innerHTML = html;
      tbl.addEventListener('click', function (e) {
        var tr = e.target.closest('tr.pickable');
        if (!tr) return;
        var num = parseInt(tr.dataset.key, 10);
        onSelect([num]);
      });
      container.appendChild(tbl);
      return;
    }

    // 矩陣（連贏：上三角；二重彩：冠軍列 × 亞軍欄）
    var grid = document.createElement('div');
    grid.className = 'odds-matrix';
    grid.style.gridTemplateColumns = 'repeat(' + (n + 1) + ', minmax(0,1fr))';
    var corner = document.createElement('div');
    corner.className = 'mx-corner';
    corner.textContent = (type === 'exacta') ? '冠＼亞' : '組合';
    grid.appendChild(corner);
    var c, r, cell;
    for (c = 0; c < n; c++) {
      cell = document.createElement('div');
      cell.className = 'mx-head';
      cell.innerHTML = numChip(horses[c]);
      grid.appendChild(cell);
    }
    for (r = 0; r < n; r++) {
      cell = document.createElement('div');
      cell.className = 'mx-head';
      cell.innerHTML = numChip(horses[r]);
      grid.appendChild(cell);
      for (c = 0; c < n; c++) {
        cell = document.createElement('div');
        var a = r + 1, b = c + 1;
        var ok = (type === 'quinella') ? (a < b) : (a !== b);
        if (!ok) {
          cell.className = 'mx-blank';
        } else {
          var key = a + '-' + b;
          var entry = (type === 'quinella') ? m.quinella[key] : m.exacta[key];
          cell.className = 'mx-cell pickable';
          cell.dataset.key = key;
          cell.textContent = oddsText(entry.odds);
          cell.title = (type === 'quinella' ? '連贏 ' + a + '-' + b : '二重彩 ' + a + '→' + b) +
                       '　機率 ' + pct(entry.p);
        }
        grid.appendChild(cell);
      }
    }
    grid.addEventListener('click', function (e) {
      var el = e.target.closest('.mx-cell');
      if (!el) return;
      var parts = el.dataset.key.split('-');
      onSelect([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
    });
    container.appendChild(grid);
  }

  function markSelection(container, key) {
    container.querySelectorAll('.selected').forEach(function (el) { el.classList.remove('selected'); });
    if (key === null) return;
    var el = container.querySelector('[data-key="' + key + '"]');
    if (el) el.classList.add('selected');
  }

  // ---------- 注單列表 ----------
  function renderBetList(container, bets, removable, onRemove) {
    if (bets.length === 0) { container.innerHTML = ''; return; }
    var total = 0, html = '<div class="betlist-title">已下注</div>';
    for (var i = 0; i < bets.length; i++) {
      var b = bets[i];
      total += b.amount;
      html += '<div class="bet-row">' +
        '<span class="bet-desc">' + Betting.describeBet(b) + '</span>' +
        '<span class="bet-odds">@' + oddsText(b.odds) + '</span>' +
        '<span class="bet-amt">' + money(b.amount) + ' 點</span>' +
        '<span class="bet-pot">可派彩 ' + money(b.amount * b.odds) + '</span>' +
        (removable ? '<button class="bet-del" data-i="' + i + '" title="取消退款">✕</button>' : '') +
        '</div>';
    }
    html += '<div class="betlist-total">共 ' + bets.length + ' 注，合計 ' + money(total) + ' 點</div>';
    container.innerHTML = html;
    if (removable) {
      container.querySelectorAll('.bet-del').forEach(function (btn) {
        btn.addEventListener('click', function () { onRemove(parseInt(btn.dataset.i, 10)); });
      });
    }
  }

  // ---------- 名次板 ----------
  function renderRankBoard(ol, horses, ranking, market, racing) {
    var html = '';
    for (var pos = 0; pos < ranking.length; pos++) {
      var h = horses[ranking[pos]];
      var medal = racing ? (pos === 0 ? '🥇' : pos === 1 ? '🥈' : pos === 2 ? '🥉' : (pos + 1)) : h.num + '號';
      var extra = racing ? '' : '<span class="rb-odds">獨贏 ' + oddsText(market.win[ranking[pos]].odds) + '</span>';
      html += '<li><span class="rb-pos">' + medal + '</span>' + numChip(h) +
              '<span class="rb-name">' + h.name + '</span>' + extra + '</li>';
    }
    ol.innerHTML = html;
  }

  // ---------- 結果面板 ----------
  function renderResult(round, settleResult, balance) {
    $('resultTitle').textContent = '第 ' + round.no + ' 場 賽果';
    var horses = round.horses;
    var fin = round.finishOrder;
    var medals = ['🥇', '🥈', '🥉'];
    var html = '';
    for (var k = 0; k < Math.min(3, fin.length); k++) {
      var h = horses[fin[k]];
      html += '<div class="podium-row"><span class="podium-medal">' + medals[k] + '</span>' +
              numChip(h) + '<span class="podium-name">' + h.name + '</span></div>';
    }
    $('resultPodium').innerHTML = html;

    if (settleResult.results.length === 0) {
      $('resultBets').innerHTML = '<div class="no-bets">本場未下注（純觀賽）</div>';
      $('resultTotals').innerHTML = '';
    } else {
      var rows = '<table class="result-table"><tr><th>注項</th><th>賠率</th><th>注金</th><th>結果</th><th>派彩</th></tr>';
      settleResult.results.forEach(function (r) {
        rows += '<tr class="' + (r.won ? 'won' : 'lost') + '">' +
          '<td>' + Betting.describeBet(r.bet) + '</td>' +
          '<td>' + oddsText(r.bet.odds) + '</td>' +
          '<td>' + money(r.bet.amount) + '</td>' +
          '<td>' + (r.won ? '✓ 中獎' : '未中') + '</td>' +
          '<td>' + (r.won ? money(r.payout) : '—') + '</td></tr>';
      });
      rows += '</table>';
      $('resultBets').innerHTML = rows;
      var net = settleResult.net;
      $('resultTotals').innerHTML =
        '<div class="totals-line">投注 ' + money(settleResult.totalStake) +
        ' 點　派彩 ' + money(settleResult.totalPayout) + ' 點　' +
        '<span class="' + (net >= 0 ? 'net-pos' : 'net-neg') + '">' +
        (net >= 0 ? '淨贏 +' : '淨輸 ') + money(net) + ' 點</span>' +
        '　餘額 ' + money(balance) + ' 點</div>';
    }
    $('resultSeed').textContent = round.seed;
  }

  // ---------- 驗證面板 ----------
  function renderVerify(round) {
    if (round.mpData) { renderVerifyMP(round); return; } // 多人場次走多方驗證
    var recomputed = Model.buildRound(round.seed, round.horses.length, round.rtp);
    var hashOk = recomputed.hash === round.hash;
    var orderOk = recomputed.finishOrder.join(',') === round.finishOrder.join(',');
    function row(label, val) {
      return '<div class="vf-row"><span class="vf-label">' + label + '</span><code>' + val + '</code></div>';
    }
    function badge(ok) {
      return '<span class="' + (ok ? 'vf-ok' : 'vf-bad') + '">' + (ok ? '✓ 一致' : '✗ 不一致！') + '</span>';
    }
    var finText = round.finishOrder.map(function (i) { return round.horses[i].num; }).join(' → ');
    var reText = recomputed.finishOrder.map(function (i) { return recomputed.horses[i].num; }).join(' → ');
    var allOk = hashOk && orderOk;
    $('verifyBody').innerHTML =
      row('公開的種子', round.seed) +
      row('下注前公布的雜湊', round.hash) +
      row('重新計算 SHA-256(種子)', recomputed.hash) +
      '<div class="vf-row">' + badge(hashOk) + '　雜湊比對</div>' +
      row('實際名次（馬號）', finText) +
      row('由種子重現的名次', reText) +
      '<div class="vf-row">' + badge(orderOk) + '　名次重現</div>' +
      '<div class="vf-conclusion ' + (allOk ? 'vf-ok' : 'vf-bad') + '">' +
      (allOk ? '✓ 驗證通過：賽果在下注前已鎖定，未被竄改。'
             : '✗ 驗證失敗：資料不一致。') + '</div>' +
      '<p class="vf-note">自行驗證：任何 SHA-256 工具算出的「種子雜湊」都會等於上方公布值；' +
      '賽果由種子經 sfc32 + Plackett-Luce 抽樣決定（原始碼 js/model.js 可查）。</p>';
  }

  // 多人場次驗證：賽果 = f(房主種子, 全體玩家隨機數)，任一方都無法單獨操控
  function renderVerifyMP(round) {
    var d = round.mpData;
    function row(label, val) {
      return '<div class="vf-row"><span class="vf-label">' + label + '</span><code>' + val + '</code></div>';
    }
    function badge(ok) {
      return '<span class="' + (ok ? 'vf-ok' : 'vf-bad') + '">' + (ok ? '✓ 一致' : '✗ 不一致！') + '</span>';
    }
    if (!d.hostSeed) {
      $('verifyBody').innerHTML = '<p>等待房主揭示種子後即可驗證……</p>';
      return;
    }
    var hashOk = RNG.sha256(d.hostSeed) === round.hash;
    var reOrder = Model.finishFromSeeds(d.hostSeed, d.nonces, round.horses);
    var orderOk = reOrder.join(',') === round.finishOrder.join(',');
    var finText = round.finishOrder.map(function (i) { return round.horses[i].num; }).join(' → ');
    var reText = reOrder.map(function (i) { return round.horses[i].num; }).join(' → ');
    var allOk = hashOk && orderOk && d.nonceOk;
    $('verifyBody').innerHTML =
      row('房主種子（賽後揭示）', d.hostSeed) +
      row('下注前公布的雜湊', round.hash) +
      row('重新計算 SHA-256(種子)', RNG.sha256(d.hostSeed)) +
      '<div class="vf-row">' + badge(hashOk) + '　雜湊比對</div>' +
      row('全體玩家隨機數（' + d.nonces.length + ' 份）', d.nonces.join(', ')) +
      '<div class="vf-row">' + badge(d.nonceOk) + '　我的隨機數已納入賽果</div>' +
      row('實際名次（馬號）', finText) +
      row('由種子＋隨機數重現的名次', reText) +
      '<div class="vf-row">' + badge(orderOk) + '　名次重現</div>' +
      '<div class="vf-conclusion ' + (allOk ? 'vf-ok' : 'vf-bad') + '">' +
      (allOk ? '✓ 驗證通過：賽果由房主種子＋全體玩家隨機數共同決定，下注截止前無人能預知。'
             : '✗ 驗證失敗：資料不一致，本場結果不可信。') + '</div>';
  }

  // ---------- Modal / 分頁 ----------
  function showModal(id) { $(id).classList.remove('hidden'); }
  function hideModal(id) { $(id).classList.add('hidden'); }
  function anyModalOpen() { return !!document.querySelector('.modal:not(.hidden)'); }

  function bindTabs(tabsEl, onSwitch) {
    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (!btn) return;
      tabsEl.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      onSwitch(btn.dataset.type || btn.dataset.tab);
    });
  }

  var UI = {
    $: $,
    money: money,
    numChip: numChip,
    oddsText: oddsText,
    renderOddsArea: renderOddsArea,
    markSelection: markSelection,
    renderBetList: renderBetList,
    renderRankBoard: renderRankBoard,
    renderResult: renderResult,
    renderVerify: renderVerify,
    showModal: showModal,
    hideModal: hideModal,
    anyModalOpen: anyModalOpen,
    bindTabs: bindTabs
  };

  global.UI = UI;
})(window);
