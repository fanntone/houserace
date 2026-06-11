/* race.js — 賽事動畫：電視轉播側視角主畫面（仿賽馬大亨）+ 俯視小地圖
 *
 * 名次保證：先依名次指定每匹馬的衝線時間 T_i，進度曲線
 *   p(u) = u + sin(πu)·(A1·sin(2πf1·u+φ1) + A2·sin(2πf2·u+φ2)),  u = t / T_i
 * 端點擺動為 0 ⇒ p(T_i) = 1 精確；振幅與頻率上限保證單調
 * ⇒ 中途領先交替有戲劇性，但衝線順序必等於抽定名次（不影響公平）。
 *
 * 轉播視角：鏡頭沿「賽道距離軸」跟拍領先集團，馬匹側面繪製、
 * 近大遠小（外側道在前）、落後集團自然滑出畫面左側。
 */
(function (global) {
  'use strict';

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function RaceAnimator(canvas, horses, finishOrder, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.horses = horses;
    this.finishOrder = finishOrder;
    this.opts = opts || {};
    this.duration = this.opts.duration || 38; // 頭馬完賽秒數（speed=1 時）
    this.speed = 1;
    this.raceTime = 0;
    this.running = false;
    this.finished = false;
    this._raf = null;
    this._setupGeometry();
    this._setupRace();
  }

  RaceAnimator.prototype._setupGeometry = function () {
    var W = this.canvas.width, H = this.canvas.height;
    var n = this.horses.length;

    // —— 俯視小地圖用的橢圓跑道幾何 ——
    this.cx = W / 2;
    this.cy = H / 2;
    this.outerR = 250;
    this.L = 200;
    this.laneGap = Math.min(14, (this.outerR - 60) / n);
    this.lane0R = this.outerR - 18;
    this.innerR = this.lane0R - (n - 1) * this.laneGap - 16;
    this.finishX = this.cx + this.L * 0.5;
    this.P0 = 4 * this.L + 2 * Math.PI * this.lane0R; // 基準賽程長（世界 px）

    // —— 轉播側視角 ——
    this.horizonY = Math.round(H * 0.34);  // 地平線
    this.nearY = H - 64;                   // 第 1 道（最近）地面 y
    this.laneDY = Math.min(16, (this.nearY - this.horizonY - 70) / Math.max(1, n - 1));
    this.xScale = 2.2;                     // 世界距離 → 螢幕像素
    this.anchorX = W * 0.55;               // 鏡頭錨點
    this.sBase = 1.18;                     // 馬匹基準縮放
  };

  RaceAnimator.prototype._setupRace = function () {
    var D = this.duration, n = this.horses.length;
    var T = new Array(n);
    var t = D;
    for (var rank = 0; rank < n; rank++) {
      if (rank > 0) {
        // 名次間隔：1/4 機率是相片裁判等級的貼身差距
        t += (Math.random() < 0.25) ? (0.02 + Math.random() * 0.08)
                                    : (0.10 + Math.random() * 0.45);
      }
      T[this.finishOrder[rank]] = t;
    }
    this.T = T;
    this.endTime = t + 1.4; // 末馬衝線後再跑一小段收尾

    // 配速模型（純演出、與賽果無關）：距離差模型 + 跑法風格 + 內側省地利
    //   進度 p_i(t) = s − g_i(s)，s = t/T0（以頭馬完賽時間正規化）
    //   g_i = 集團內深度：中段維持小深度（緊咬膠著、依跑法此消彼長），
    //         末段 28% 平滑混合到精確最終差距 G_i = (T_i−T0)/T0 ⇒ p_i(T_i) = 1 精確
    this.T0 = this.T[this.finishOrder[0]];
    this._gateHold = 3.0; // 出閘前停閘秒數（3-2-1 倒數、各就各位）
    this._goFlash = 0;    // 出閘瞬間「開跑！」爆閃
    this.pace = [];
    for (var i = 0; i < n; i++) {
      var style = Math.random();                       // 跑法：0 逃馬（貼前）→ 1 後追
      var gateInner = (n - 1 - i) / Math.max(1, n - 1); // 閘位：1 號最內 = 1
      this.pace.push({
        base: Math.max(0.0005, 0.002 + style * 0.010 - gateInner * 0.003), // 中段深度（內側省地利）
        amp: 0.0012 + Math.random() * 0.0024,           // 集團內小幅消長（無突兀加速）
        f: 0.5 + Math.random() * 0.7,
        ph: Math.random() * Math.PI * 2,
        G: this._W(this.T[i] / this.T0) - 1             // 最終差距（含起步加速曲線，保證精準壓線）
      });
    }
    this.photoFinish = (T[this.finishOrder[1]] - T[this.finishOrder[0]]) < 0.06;
    this._crossed = false; // 冠軍是否已壓線（觸發定格/白閃）
    this._freeze = 0;
    this._flash = 0;
    this._dust = [];       // 揚塵粒子
    this._dustT = 0;

    // 旁述時間點（相對頭馬完賽時間）——賽事主播式的激情播報
    this._milestones = [
      { at: 0.001, fired: false, text: function () { return '閘門大開！比賽開始，馬群蜂擁而出！'; } },
      { at: 0.13, fired: false, text: function (lead) { return lead + ' 搶先帶出，節奏相當明快！'; } },
      { at: 0.30, fired: false, text: function (lead, sec) { return '進入彎道！' + lead + ' 沿欄領跑，' + sec + ' 緊咬不放！'; } },
      { at: 0.50, fired: false, text: function (lead) { return '比賽過半！' + lead + ' 仍在前頭，後方馬群蠢蠢欲動！'; } },
      { at: 0.70, fired: false, text: function (lead, sec) { return '轉入最後直線！' + lead + ' 率先殺出，' + sec + ' 奮力追趕！'; } },
      { at: 0.88, fired: false, text: function (lead, sec) { return '最後一百米！' + lead + ' 和 ' + sec + ' 拼到底，全場沸騰！'; } }
    ];
    this._announcedWinner = false;
    this._lastLeader = null; // 領先易主即時播報用
    this._lastAnnT = -9;
  };

  function smoothstep01(x) { return x * x * (3 - 2 * x); }

  // 共同配速的起步加速曲線：出閘瞬間約 25% 速度、2~3 秒內升到全速。
  // W(s) = s − A(1 − e^(−s/τ))，單調遞增；最終差距 G 以 W 計算 ⇒ 壓線時刻仍精確。
  RaceAnimator.prototype._W = function (s) {
    return s - 0.045 * (1 - Math.exp(-s / 0.06));
  };

  // 進度（0 → 1 衝線；衝線後減速續跑，軟漸近 1.12 且嚴格保序，不會繞回）
  // 中段：馬群緊咬（深度 ≤ 約1.4% 賽程 ≈ 數個馬身），依跑法風格小幅消長；
  // 末段 28%：深度平滑混合到最終差距 ⇒ 後追馬掃過、力竭馬被吞，且壓線時刻精確。
  RaceAnimator.prototype.progressOf = function (i, time) {
    var Ti = this.T[i];
    if (time <= 0) return 0;
    if (time >= Ti) {
      var over = ((time - Ti) / Ti) * 0.85;
      return 1 + 0.12 * (1 - Math.exp(-over / 0.12));
    }
    var s = time / this.T0;
    var pc = this.pace[i];
    var ramp = Math.min(1, s / 0.12); // 出閘成形期：從並列逐漸排出隊形
    var b = ramp * (pc.base + pc.amp * Math.sin(2 * Math.PI * pc.f * s + pc.ph));
    if (b < 0) b = 0;
    var w = (s <= 0.72) ? 0 : (s >= 1 ? 1 : smoothstep01((s - 0.72) / 0.28));
    var p = this._W(s) - (b * (1 - w) + pc.G * w); // W：靜止出閘的加速曲線
    return p > 0 ? p : 0;
  };

  // 沿賽道的累積距離（世界 px）
  RaceAnimator.prototype.distOf = function (i, time) {
    return this.progressOf(i, time) * this.P0;
  };

  // 目前名次（依進度排序；衝線前後排序皆一致）
  RaceAnimator.prototype.rankingAt = function (time) {
    var self = this;
    var idx = this.horses.map(function (_, i) { return i; });
    idx.sort(function (a, b) { return self.progressOf(b, time) - self.progressOf(a, time); });
    return idx;
  };

  // ---------- 俯視小地圖幾何（操場形） ----------
  RaceAnimator.prototype.lanePoint = function (laneIdx, frac) {
    var r = this.lane0R - laneIdx * this.laneGap;
    var L = this.L, cx = this.cx, cy = this.cy;
    var P = 4 * L + 2 * Math.PI * r;
    var d0 = L + (this.finishX - this.cx); // 路徑原點(cx−L, cy+r) 到終點線的距離
    var d = ((d0 + frac * P) % P + P) % P;
    if (d < 2 * L) {                                   // 下直道（往右）
      return { x: cx - L + d, y: cy + r };
    }
    d -= 2 * L;
    if (d < Math.PI * r) {                             // 右端弧（下→右→上）
      var th = Math.PI / 2 - d / r;
      return { x: cx + L + r * Math.cos(th), y: cy + r * Math.sin(th) };
    }
    d -= Math.PI * r;
    if (d < 2 * L) {                                   // 上直道（往左）
      return { x: cx + L - d, y: cy - r };
    }
    d -= 2 * L;
    var ph = -Math.PI / 2 - d / r;                     // 左端弧（上→左→下）
    return { x: cx - L + r * Math.cos(ph), y: cy + r * Math.sin(ph) };
  };

  RaceAnimator.prototype._stadiumPath = function (r) {
    var ctx = this.ctx, cx = this.cx, cy = this.cy, L = this.L;
    ctx.beginPath();
    ctx.moveTo(cx - L, cy - r);
    ctx.lineTo(cx + L, cy - r);
    ctx.arc(cx + L, cy, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(cx - L, cy + r);
    ctx.arc(cx - L, cy, r, Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.closePath();
  };

  // ---------- 轉播鏡頭（沿賽道距離軸） ----------
  RaceAnimator.prototype.laneY = function (k) { return this.nearY - k * this.laneDY; };
  RaceAnimator.prototype.laneScale = function (k) { return this.sBase * (1 - k * 0.033); };
  RaceAnimator.prototype.screenX = function (d) {
    return this.anchorX + (d - this.cam.d) * this.xScale;
  };

  RaceAnimator.prototype._updateCamera = function (time) {
    var W = this.canvas.width;
    var lineLockD = this.P0 - (W * 0.70 - this.anchorX) / this.xScale; // 終點線停在畫面 70%
    var tD;
    if (time <= 0) {
      tD = 0 - (W * 0.60 - this.anchorX) / this.xScale; // 閘門列隊置於畫面 60%
    } else {
      var ranking = this.rankingAt(time);
      var wts = [0.5, 0.3, 0.2], wd = 0;
      for (var i = 0; i < 3; i++) wd += this.distOf(ranking[i], time) * wts[i];
      tD = wd - (W * 0.62 - this.anchorX) / this.xScale; // 集團重心放在畫面 62%
      if (tD > lineLockD) tD = lineLockD; // 終點前鎖定終點線，看馬群衝進畫面壓線
    }
    if (!this.cam) this.cam = { d: tD };
    var dt = Math.max(0, time - (this._camT === undefined ? time : this._camT));
    this._camT = time;
    var k = (time <= 0) ? 1 : 1 - Math.exp(-dt * 2.5);
    this.cam.d += (tD - this.cam.d) * k;
  };

  // 賽道段落：依鏡頭所在距離判斷主直道/彎道/後直道，供場景與彎道效果使用
  RaceAnimator.prototype._sectionInfo = function (d) {
    var L = this.L, P = this.P0;
    var arc = Math.PI * this.lane0R;
    var d0 = L + (this.finishX - this.cx); // 與 lanePoint 相同的路徑原點偏移
    var dd = ((d0 + d) % P + P) % P;
    var seg, into, len;
    if (dd < 2 * L) { seg = 'home'; into = dd; len = 2 * L; }
    else if (dd < 2 * L + arc) { seg = 'turn'; into = dd - 2 * L; len = arc; }
    else if (dd < 4 * L + arc) { seg = 'back'; into = dd - 2 * L - arc; len = 2 * L; }
    else { seg = 'turn'; into = dd - 4 * L - arc; len = arc; }
    var ramp = 90; // 進出段落的過渡長度（世界 px）
    function w(i, l) { return Math.max(0, Math.min(1, i / ramp, (l - i) / ramp)); }
    return {
      seg: seg,
      curve: seg === 'turn' ? w(into, len) : 0,  // 彎道強度 0→1→0
      stand: seg === 'home' ? w(into, len) : 0,  // 看台（主直道）
      board: seg === 'back' ? w(into, len) : 0   // 計分塔（後直道）
    };
  };

  // ---------- 背景：天空、雲、看台、草地、欄杆 ----------
  RaceAnimator.prototype._drawSky = function () {
    var ctx = this.ctx, W = this.canvas.width;
    var sky = ctx.createLinearGradient(0, 0, 0, this.horizonY);
    sky.addColorStop(0, '#6fa8d8');
    sky.addColorStop(1, '#d9ecf7');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, this.horizonY);
    // 雲（慢速視差）
    var off = this.cam.d * this.xScale * 0.06;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    for (var c = 0; c < 5; c++) {
      var cx = ((c * 727 - off) % (W + 460) + (W + 460)) % (W + 460) - 230;
      var cy = 16 + (c * 53) % Math.max(20, this.horizonY - 96);
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8, 46, 11, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - 24, cy + 12, 26, 9, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 26, cy + 12, 30, 9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  RaceAnimator.prototype._drawGrandstand = function () {
    var ctx = this.ctx, W = this.canvas.width;
    var top = this.horizonY - 56, bot = this.horizonY - 6;
    var off = this.cam.d * this.xScale * 0.22;
    // 主體與屋頂
    ctx.fillStyle = '#8d99a6';
    ctx.fillRect(0, top, W, bot - top);
    ctx.fillStyle = '#e6ebf0';
    ctx.fillRect(0, top, W, 7);
    // 支柱（淡化，避免看起來像柵欄）
    ctx.fillStyle = 'rgba(40,48,58,0.14)';
    var px0 = -((off % 110) + 110) % 110;
    for (var px = px0; px < W; px += 110) ctx.fillRect(px, top + 7, 2, bot - top - 7);
    // 群眾（彩色點陣）
    var palette = ['#e35d5d', '#5d8fe3', '#e3c75d', '#f1f3f5', '#23272e', '#7ce38f', '#c98fe3'];
    var colOff = Math.floor(off / 6);
    for (var row = 0; row < 5; row++) {
      var y = top + 13 + row * 8;
      for (var col = 0; col < W / 6 + 1; col++) {
        var h = ((col + colOff) * 31 + row * 17) % 7;
        ctx.fillStyle = palette[h];
        ctx.globalAlpha = 0.8;
        ctx.fillRect(col * 6 - (off % 6), y, 3, 3.6);
      }
    }
    ctx.globalAlpha = 1;
    // 看台前綠籬
    ctx.fillStyle = '#2c5b35';
    ctx.fillRect(0, bot, W, this.horizonY - bot);
  };

  RaceAnimator.prototype._drawTrackBase = function () {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    var turf = ctx.createLinearGradient(0, this.horizonY, 0, H);
    turf.addColorStop(0, '#4f9e5c');
    turf.addColorStop(1, '#2e6b3a');
    ctx.fillStyle = turf;
    ctx.fillRect(0, this.horizonY, W, H - this.horizonY);
    // 割草條紋（隨賽道捲動）
    var sw = 80; // 世界 px
    var k0 = Math.floor((this.cam.d - this.anchorX / this.xScale) / sw) - 1;
    var count = Math.ceil(W / (sw * this.xScale)) + 3;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (var k = k0; k < k0 + count; k++) {
      if (k % 2 !== 0) continue;
      ctx.fillRect(this.screenX(k * sw), this.horizonY, sw * this.xScale, H - this.horizonY);
    }
  };

  // 欄杆：兩道白欄 + 立柱；parallax 控制遠近捲動速度；bow > 0 時欄杆彎成弧（過彎）
  RaceAnimator.prototype._drawRail = function (railY, postH, barW, parallax, bow) {
    var ctx = this.ctx, W = this.canvas.width;
    bow = bow || 0;
    function yAt(x) {
      return railY - bow * Math.sin(Math.PI * Math.min(Math.max(x / W, 0), 1));
    }
    // 接地陰影
    ctx.strokeStyle = 'rgba(30,40,30,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = 0; x <= W; x += 46) {
      var y = yAt(x) + postH;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 立柱（沿弧線分布）
    var spacing = 64; // 世界 px
    var k0 = Math.floor((this.cam.d * parallax - this.anchorX / this.xScale) / spacing) - 1;
    var count = Math.ceil(W / (spacing * this.xScale)) + 3;
    ctx.fillStyle = '#eef2f5';
    for (var k = k0; k < k0 + count; k++) {
      var px = this.anchorX + (k * spacing - this.cam.d * parallax) * this.xScale;
      ctx.fillRect(px, yAt(px), barW * 0.6, postH);
    }
    // 兩道橫欄（順著彎度）
    ctx.strokeStyle = '#eef2f5';
    var bars = [[0, barW], [postH * 0.45, barW * 0.7]];
    for (var b = 0; b < 2; b++) {
      ctx.lineWidth = bars[b][1];
      ctx.beginPath();
      for (var x2 = 0; x2 <= W; x2 += 40) {
        var y2 = yAt(x2) + bars[b][0];
        if (x2 === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
  };

  // 樹林帶（彎道與後直道的基底背景）
  RaceAnimator.prototype._drawTrees = function () {
    var ctx = this.ctx, W = this.canvas.width;
    var top = this.horizonY - 30;
    var off = this.cam.d * this.xScale * 0.22;
    ctx.fillStyle = '#27502f';
    ctx.fillRect(0, top + 12, W, this.horizonY - top - 12);
    var k0 = Math.floor(off / 46);
    for (var k = k0 - 1; k < k0 + W / 46 + 2; k++) {
      var x = k * 46 - off;
      var h = 10 + ((k * 37 % 12) + 12) % 12;
      ctx.fillStyle = (k % 2 === 0) ? '#356f41' : '#2a5e36';
      ctx.beginPath();
      ctx.arc(x, top + 14, h, Math.PI, 2 * Math.PI);
      ctx.fill();
    }
  };

  // 計分塔（後直道可見，顯示場次）
  RaceAnimator.prototype._drawScoreboard = function (alpha) {
    if (alpha <= 0.02) return;
    var ctx = this.ctx, W = this.canvas.width;
    var x = W * 0.62, top = this.horizonY - 70;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#1b212b';
    ctx.fillRect(x - 78, top, 156, 50);
    ctx.strokeStyle = '#3b4452';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 78, top, 156, 50);
    ctx.fillStyle = '#39424e';
    ctx.fillRect(x - 60, top + 50, 8, 20);
    ctx.fillRect(x + 52, top + 50, 8, 20);
    ctx.fillStyle = '#ffd43b';
    ctx.font = 'bold 17px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.opts.infieldText || 'RACE', x, top + 22);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '11px "Microsoft JhengHei", sans-serif';
    ctx.fillText(this.opts.infieldSub || '', x, top + 40);
    ctx.restore();
    ctx.textAlign = 'left';
  };

  // 起跑閘門（位於賽程 0）
  RaceAnimator.prototype._drawGate = function () {
    var ctx = this.ctx, W = this.canvas.width;
    var gx = this.screenX(0);
    if (gx < -260 || gx > W + 260) return;
    var n = this.horses.length;
    var topY = this.laneY(n - 1) - 64;
    var botY = this.nearY + 22;
    ctx.fillStyle = '#cfd6dd';
    ctx.fillRect(gx - 40, topY, 5, botY - topY);   // 後柱
    ctx.fillRect(gx + 12, topY, 5, botY - topY);   // 前柱
    ctx.fillRect(gx - 44, topY - 8, 64, 8);        // 頂梁
    ctx.fillStyle = 'rgba(207,214,221,0.65)';
    for (var k = 0; k < n; k++) {                  // 各道隔欄
      var y = this.laneY(k) - 26 * this.laneScale(k);
      ctx.fillRect(gx - 40, y, 57, 3);
    }
  };

  // 終點（位於賽程 P0）：草地棋盤線 + 標柱
  RaceAnimator.prototype._drawFinishLine = function () {
    var ctx = this.ctx, W = this.canvas.width;
    var fx = this.screenX(this.P0);
    if (fx < -100 || fx > W + 100) return;
    var n = this.horses.length;
    var topY = this.laneY(n - 1) - 24;
    var botY = this.nearY + 20;
    var sq = 8;
    for (var y = topY, r = 0; y < botY; y += sq, r++) {
      ctx.fillStyle = (r % 2 === 0) ? '#f1f3f5' : '#1a1a1a';
      ctx.fillRect(fx - 4, y, sq, Math.min(sq, botY - y));
    }
    // 終點標柱（近端大、遠端小）
    ctx.fillStyle = '#f1f3f5';
    ctx.fillRect(fx - 2, botY, 5, 30);
    ctx.fillRect(fx - 1, topY - 26, 3, 26);
    ctx.fillStyle = '#e03131';
    ctx.beginPath();
    ctx.arc(fx + 0.5, botY + 2, 7, 0, Math.PI * 2);
    ctx.arc(fx + 0.5, topY - 26, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd43b';
    ctx.font = 'bold 13px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('終點', fx, topY - 34);
    ctx.textAlign = 'left';
  };

  // ---------- 側面賽馬（手繪貝茲曲線剪影 + 肌肉光影 + 三段式腿） ----------
  // 完整馬體輪廓（伸展奔馳姿態）：尾根→臀頂→背線→頸脊→頭→口鼻→喉→胸→腹線→臀下
  function bodyPath(ctx) {
    ctx.beginPath();
    ctx.moveTo(-43, -12);
    ctx.bezierCurveTo(-40, -19, -32, -23, -22, -22);
    ctx.bezierCurveTo(-12, -21, -2, -23, 10, -24);
    ctx.bezierCurveTo(18, -25, 26, -23, 33, -18);
    ctx.bezierCurveTo(38, -24, 44, -32, 49, -37);
    ctx.bezierCurveTo(52, -40, 58, -40, 62, -36);
    ctx.bezierCurveTo(66, -33, 69, -29, 69, -26);
    ctx.bezierCurveTo(69, -23, 66, -21, 62, -20);
    ctx.bezierCurveTo(58, -19, 55, -16, 52, -12);
    ctx.bezierCurveTo(48, -6, 44, 0, 39, 5);
    ctx.bezierCurveTo(35, 10, 28, 14, 20, 16);
    ctx.bezierCurveTo(8, 18, -8, 18, -20, 15);
    ctx.bezierCurveTo(-30, 13, -38, 8, -42, 0);
    ctx.bezierCurveTo(-44, -4, -44, -8, -43, -12);
    ctx.closePath();
  }

  // 三段式腿（上段粗肌肉→關節→下段細管骨→蹄）
  function leg(ctx, px, py, u, k, L1, L2, w1, w2, color) {
    var kx = px + Math.sin(u) * L1, ky = py + Math.cos(u) * L1;
    var a2 = u + k;
    var fx = kx + Math.sin(a2) * L2, fy = ky + Math.cos(a2) * L2;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = w1;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(kx, ky); ctx.stroke();
    ctx.lineWidth = w2;
    ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.save(); // 蹄（順著管骨方向）
    ctx.translate(fx, fy);
    ctx.rotate(a2);
    ctx.fillStyle = '#181210';
    ctx.beginPath();
    ctx.ellipse(0, 2.2, 3.1, 2.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  RaceAnimator.prototype._drawHorseSide = function (sx, sy, horse, time, moving, s, lean) {
    var ctx = this.ctx;
    var coat = horse.coat || { body: '#7d4a26', dark: '#4a2a12' };
    var freq = 2.2 + (horse.num % 3) * 0.06; // 各馬步頻微差，避免同步划一
    var ph = time * freq * Math.PI * 2 + horse.num * 2.1;
    var bob = moving ? -Math.abs(Math.sin(ph)) * 3.4 : 0;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(s, s);

    // 地面影子（不隨起伏）
    ctx.beginPath();
    ctx.ellipse(2, 34, 44, 5.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();

    ctx.translate(0, bob);
    // 奔跑俯仰 + 過彎內傾
    ctx.rotate((moving ? 0.035 * Math.sin(ph + 0.8) : 0) + (lean || 0));

    // 步態角度：u = 上段自垂直向前擺角；k = 關節折角（前膝向後折、後飛節向前折）
    function gait(p, hind) {
      if (!moving) {
        return hind ? { u: 0.10, k: 0.10 } : { u: -0.05, k: -0.08 };
      }
      var fold = Math.pow(Math.max(0, Math.cos(p)), 1.3);
      return hind
        ? { u: 0.14 + 0.95 * Math.sin(p), k: 0.20 + 1.25 * fold }
        : { u: -0.12 + 1.05 * Math.sin(p), k: -(0.18 + 1.50 * fold) };
    }

    // 遠側腿（深色、位置略偏）
    var ff = gait(ph + 0.5, false), fh = gait(ph + 3.9, true);
    leg(ctx, 29, 0, ff.u, ff.k, 17, 15, 7, 3.8, coat.dark);
    leg(ctx, -26, -2, fh.u, fh.k, 19, 16, 8.5, 4.2, coat.dark);

    // 馬尾（飄揚的旗狀，隨步伐擺動）
    var sw = moving ? Math.sin(ph * 0.5 + horse.num) * 3.5 : 0.6;
    ctx.beginPath();
    ctx.moveTo(-42, -15);
    ctx.bezierCurveTo(-50, -14 + sw, -56, -9 + sw, -60, -2 + sw * 1.4);
    ctx.bezierCurveTo(-62, 2 + sw, -61, 6 + sw, -58, 8 + sw);
    ctx.bezierCurveTo(-54, 6 + sw * 0.8, -49, 1, -46, -3);
    ctx.bezierCurveTo(-44, -6, -43, -9, -42, -12);
    ctx.closePath();
    ctx.fillStyle = coat.dark;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; // 尾絲
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-44, -11);
    ctx.bezierCurveTo(-51, -8 + sw, -55, -3 + sw, -58, 3 + sw * 1.2);
    ctx.stroke();

    // 馬體
    bodyPath(ctx);
    ctx.fillStyle = coat.body;
    ctx.fill();
    // 肌肉光影（裁切在身體內）
    ctx.save();
    bodyPath(ctx);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; // 背部受光
    ctx.beginPath();
    ctx.ellipse(2, -17, 42, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; // 肩肌、臀肌
    ctx.beginPath();
    ctx.ellipse(24, -4, 10, 12, 0, 0, Math.PI * 2);
    ctx.ellipse(-26, -6, 12, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; // 腹部陰影
    ctx.beginPath();
    ctx.ellipse(-2, 13, 40, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; // 肌肉刻線
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(16, -2, 12, 0.5, 1.8); ctx.stroke();
    ctx.beginPath(); ctx.arc(-19, -3, 13, 1.2, 2.4); ctx.stroke();
    ctx.restore();
    // 輪廓
    bodyPath(ctx);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(22,13,8,0.45)';
    ctx.stroke();

    // 耳朵
    ctx.fillStyle = coat.dark;
    ctx.beginPath();
    ctx.moveTo(49, -36); ctx.lineTo(51.5, -44); ctx.lineTo(54, -36.5);
    ctx.moveTo(54.5, -36); ctx.lineTo(57.5, -42); ctx.lineTo(58.5, -34.5);
    ctx.closePath();
    ctx.fill();

    // 鬃毛（沿頸脊飄動）
    var mw = moving ? Math.sin(ph * 0.5) * 1.5 : 0;
    ctx.beginPath();
    ctx.moveTo(48, -38);
    ctx.bezierCurveTo(42, -34 + mw, 38, -30 + mw, 34, -24);
    ctx.bezierCurveTo(31, -20, 30, -17, 31, -15);
    ctx.bezierCurveTo(34, -18 + mw, 38, -24 + mw, 43, -31);
    ctx.bezierCurveTo(46, -34, 48, -36, 48, -38);
    ctx.closePath();
    ctx.fillStyle = coat.dark;
    ctx.fill();

    // 頭部細節：眼、鼻孔、嘴線、轡頭
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath(); ctx.arc(58, -32, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(58.6, -32.6, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(20,12,8,0.8)';
    ctx.beginPath(); ctx.ellipse(66, -24.5, 1.6, 1.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(20,12,8,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(62, -20.5); ctx.lineTo(66.5, -22); ctx.stroke();
    ctx.strokeStyle = 'rgba(30,20,15,0.55)'; // 轡頭皮帶
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(55, -31); ctx.lineTo(60, -22);
    ctx.moveTo(60, -29); ctx.lineTo(64, -23.5);
    ctx.stroke();

    // 鞍墊 + 號碼布
    ctx.beginPath();
    ctx.ellipse(2, -14, 11, 4.5, -0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#3a2d22';
    ctx.fill();
    roundRectPath(ctx, -16, -16, 26, 22, 5);
    ctx.fillStyle = horse.color.bg;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.fillStyle = horse.color.fg;
    ctx.font = 'bold 15px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(horse.num), -3, -5);
    ctx.textBaseline = 'alphabetic';

    // 近側腿（亮色、畫在身體之前）
    var nf = gait(ph, false), nh = gait(ph + 3.4, true);
    leg(ctx, 25, 4, nf.u, nf.k, 17, 15, 8.5, 4.5, coat.body);
    leg(ctx, -30, 2, nh.u, nh.k, 19, 16, 10, 5, coat.body);

    // 騎師（競賽前傾蹲姿）
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f1f3f5'; // 白馬褲大腿
    ctx.lineWidth = 5.5;
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(13, -9); ctx.stroke();
    ctx.strokeStyle = '#23201d'; // 馬靴小腿
    ctx.lineWidth = 3.8;
    ctx.beginPath(); ctx.moveTo(13, -9); ctx.lineTo(7, 0); ctx.stroke();
    ctx.strokeStyle = horse.color.bg; // 彩衣軀幹（水平前傾）
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(18, -31); ctx.stroke();
    ctx.lineWidth = 4; // 前伸手臂
    ctx.beginPath(); ctx.moveTo(17, -30); ctx.lineTo(34, -24); ctx.stroke();
    ctx.fillStyle = '#e8c39e'; // 臉
    ctx.beginPath(); ctx.arc(25, -33, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = horse.color.bg; // 頭盔
    ctx.beginPath(); ctx.arc(24, -35, 4.6, Math.PI * 0.9, Math.PI * 2.1); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(24, -35, 4.6, Math.PI * 0.9, Math.PI * 2.1); ctx.stroke();
    ctx.strokeStyle = '#23201d'; // 護目鏡帶
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(21.5, -34); ctx.lineTo(28, -33.5); ctx.stroke();
    // 馬鞭與韁繩
    ctx.strokeStyle = 'rgba(40,30,20,0.8)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(34, -24); ctx.lineTo(41, -31); ctx.stroke();
    ctx.strokeStyle = 'rgba(40,30,20,0.55)';
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(34, -24); ctx.lineTo(60, -23); ctx.stroke();

    ctx.restore();
  };

  // ---------- 揚塵粒子 ----------
  RaceAnimator.prototype._updateDust = function (time) {
    var dt = Math.min(Math.max(time - this._dustT, 0), 0.08);
    this._dustT = time;
    if (dt <= 0) return;
    for (var i = this._dust.length - 1; i >= 0; i--) {
      var p = this._dust[i];
      p.age += dt;
      if (p.age >= p.life) { this._dust.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 14 * dt;
    }
  };

  RaceAnimator.prototype._drawDust = function () {
    var ctx = this.ctx;
    for (var i = 0; i < this._dust.length; i++) {
      var p = this._dust[i];
      var a = (1 - p.age / p.life) * 0.35;
      ctx.fillStyle = 'rgba(150,160,118,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + p.age * 2), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // ---------- 俯視小地圖 ----------
  RaceAnimator.prototype._drawMinimap = function (time) {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    var s = 0.165, mw = W * s, mh = H * s;
    var mx = W - mw - 14, my = 12;
    ctx.save();
    roundRectPath(ctx, mx - 6, my - 6, mw + 12, mh + 12, 8);
    ctx.fillStyle = 'rgba(10,14,20,0.72)';
    ctx.fill();
    ctx.translate(mx, my);
    ctx.scale(s, s);
    this._stadiumPath(this.outerR);
    ctx.fillStyle = 'rgba(120,185,120,0.5)';
    ctx.fill();
    this._stadiumPath(this.innerR);
    ctx.fillStyle = 'rgba(18,52,28,0.9)';
    ctx.fill();
    ctx.fillStyle = '#f1f3f5';
    ctx.fillRect(this.finishX - 4, this.cy + this.innerR, 8, this.outerR - this.innerR);
    for (var i = 0; i < this.horses.length; i++) {
      var pt = this.lanePoint(i, this.progressOf(i, time));
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = this.horses[i].color.bg;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
    }
    ctx.restore();
  };

  // ---------- 主繪製 ----------
  RaceAnimator.prototype.drawFrame = function (time) {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    this._updateCamera(time);

    var sec = this._sectionInfo(this.cam.d); // 主直道 / 彎道 / 後直道

    this._drawSky();
    this._drawTrees(); // 基底遠景
    this._drawScoreboard(sec.board);
    if (sec.stand > 0.02) { // 看台只在主直道
      ctx.globalAlpha = sec.stand;
      this._drawGrandstand();
      ctx.globalAlpha = 1;
    }
    this._drawTrackBase();

    var n = this.horses.length;
    // 外側欄杆（遠）：過彎時彎成弧形
    this._drawRail(this.laneY(n - 1) - 30, 14, 3, 1, 30 * sec.curve);
    this._drawGate();
    this._drawFinishLine();

    // 馬匹：遠道（內側）先畫、近道（外側）後畫；離開鏡頭範圍的不畫
    var moving = time > 0;
    var lean = -0.09 * sec.curve; // 過彎時向內傾
    for (var k = n - 1; k >= 0; k--) {
      var sx = this.screenX(this.distOf(k, time));
      if (sx < -200 || sx > W + 200) continue;
      // 過彎時沿弧線抬升（內側道抬得更多）
      var bowK = sec.curve * (14 + (n > 1 ? (k / (n - 1)) * 14 : 0));
      var sy = this.laneY(k) - bowK * Math.sin(Math.PI * Math.min(Math.max(sx / W, 0), 1));
      var sc = this.laneScale(k);
      this._drawHorseSide(sx, sy, this.horses[k], time, moving, sc, lean);
      // 揚塵
      if (moving && this._dust.length < 150 && Math.random() < 0.4) {
        this._dust.push({
          x: sx - 48 * sc, y: sy + 30 * sc,
          vx: -(50 + Math.random() * 70), vy: -(4 + Math.random() * 12),
          life: 0.4 + Math.random() * 0.35, age: 0, r: (1.6 + Math.random() * 2.2) * sc
        });
      }
    }
    this._updateDust(time);
    this._drawDust();

    // 內側欄杆（近，前景，捲動稍快）
    this._drawRail(this.nearY + 26, 26, 5, 1.16, 12 * sec.curve);

    this._drawMinimap(time);

    // 相片裁判慢動作提示
    if (this._slowmo && this._freeze <= 0) {
      roundRectPath(ctx, W / 2 - 110, 18, 220, 42, 10);
      ctx.fillStyle = 'rgba(13,17,23,0.72)';
      ctx.fill();
      ctx.fillStyle = '#ffd43b';
      ctx.font = 'bold 22px "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📸 相片裁判！', W / 2, 47);
    }

    // 壓線白閃
    if (this._flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (this._flash * 0.75).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    // 壓線定格字卡（置頂，避免蓋住壓線馬群）
    if (this._freeze > 0) {
      var msg = this.photoFinish ? '📸 相片裁判 判定中…' : '🏁 衝線！';
      roundRectPath(ctx, W / 2 - 150, 24, 300, 54, 12);
      ctx.fillStyle = 'rgba(13,17,23,0.78)';
      ctx.fill();
      ctx.fillStyle = '#ffd43b';
      ctx.font = 'bold 28px "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, W / 2, 60);
    }
    ctx.textAlign = 'left';
  };

  // 待機畫面（下注階段：全員列隊在閘門）
  RaceAnimator.prototype.drawIdle = function () {
    this.drawFrame(0);
  };

  // ---------- 主迴圈 ----------
  RaceAnimator.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.raceTime = 0;
    if (this._gateHold > 0 && this.opts.onCommentary) {
      this.opts.onCommentary('馬匹進閘完畢，各就各位──');
    }
    var self = this;
    var last = null;
    function loop(now) {
      if (!self.running) return;
      if (last === null) last = now;
      var dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      self._flash = Math.max(0, self._flash - dt * 2.2);
      self._goFlash = Math.max(0, (self._goFlash || 0) - dt);
      if (self._gateHold > 0) {
        self._gateHold -= dt; // 停閘：鏡頭停在閘口，3-2-1 倒數
        if (self._gateHold <= 0) self._goFlash = 0.9; // 出閘瞬間
      } else if (self._freeze > 0) {
        self._freeze -= dt; // 壓線定格：時間暫停，畫面停在過線瞬間
      } else {
        // 相片裁判等級的貼身賽：衝線前後切慢動作
        var slow = self.photoFinish &&
          self.raceTime > self.T[self.finishOrder[0]] - 0.9 &&
          self.raceTime < self.T[self.finishOrder[1]] + 0.2;
        self._slowmo = slow;
        self.raceTime += dt * self.speed * (slow ? 0.35 : 1);
        if (!self._crossed && self.raceTime >= self.T[self.finishOrder[0]]) {
          self._crossed = true;
          self._freeze = self.photoFinish ? 1.15 : 0.7;
          self._flash = 1;
        }
      }
      self._checkMilestones();
      self.drawFrame(self.raceTime);
      if (self.opts.onTick) self.opts.onTick(self.raceTime, self.rankingAt(self.raceTime));
      if (self.raceTime >= self.endTime) {
        self._finish();
        return;
      }
      self._raf = requestAnimationFrame(loop);
    }
    this._raf = requestAnimationFrame(loop);
  };

  RaceAnimator.prototype._checkMilestones = function () {
    if (!this.opts.onCommentary) return;
    var rel = this.raceTime / this.duration;
    var ranking = this.rankingAt(this.raceTime);
    var lead = this._label(ranking[0]), sec = this._label(ranking[1]);
    for (var i = 0; i < this._milestones.length; i++) {
      var m = this._milestones[i];
      if (!m.fired && rel >= m.at) {
        m.fired = true;
        this._lastAnnT = this.raceTime;
        this.opts.onCommentary(m.text(lead, sec));
      }
    }
    // 領先易主：即時插播超越（冷卻 2.2 秒，避免洗版）
    if (rel > 0.08 && rel < 0.92) {
      if (this._lastLeader === null) {
        this._lastLeader = ranking[0];
      } else if (ranking[0] !== this._lastLeader) {
        if (this.raceTime - this._lastAnnT > 2.2) {
          this._lastAnnT = this.raceTime;
          var hype = ['不得了！', '喔喔！', '看哪！'][Math.floor(Math.random() * 3)];
          this.opts.onCommentary(hype + lead + ' 強勢超越，搶下領先！');
        }
        this._lastLeader = ranking[0];
      }
    }
    // 頭馬衝線（相片裁判時等定格判定結束才宣布，保留懸念）
    var winner = this.finishOrder[0];
    if (!this._announcedWinner && this.raceTime >= this.T[winner] &&
        (!this.photoFinish || this._freeze <= 0)) {
      this._announcedWinner = true;
      var msg = this.photoFinish
        ? '兩馬幾乎同時撞線！相片裁判判定──頭馬是 ' + this._label(winner) + '，險勝！'
        : '衝過終點！頭馬就是 ' + this._label(winner) + '！';
      this.opts.onCommentary(msg);
    }
  };

  RaceAnimator.prototype._label = function (i) {
    return this.horses[i].num + '號 ' + this.horses[i].name;
  };

  RaceAnimator.prototype._finish = function () {
    this.running = false;
    this.finished = true;
    this._slowmo = false;
    this.drawFrame(this.endTime);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.opts.onFinish) this.opts.onFinish();
  };

  RaceAnimator.prototype.skip = function () {
    if (!this.running) return;
    // 觸發尚未播出的旁述後直接收尾
    this.raceTime = this.endTime;
    this._gateHold = 0;
    this._freeze = 0;
    this._flash = 0;
    this._slowmo = false;
    this._checkMilestones();
    this._finish();
  };

  RaceAnimator.prototype.setSpeed = function (x) { this.speed = x; };

  RaceAnimator.prototype.stop = function () {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RaceAnimator;
  else global.RaceAnimator = RaceAnimator;
})(typeof window !== 'undefined' ? window : this);
