/* race-test.js — 動畫一致性驗證（node test/race-test.js）：
 * 1) 每匹馬的進度曲線嚴格單調（不會倒退）
 * 2) 衝線時間排序 = 抽定名次
 * 3) 賽末名次板排序 = 抽定名次（含短/標準/長賽程）
 */
'use strict';

var Model = require('../js/model.js');
var RaceAnimator = require('../js/race.js');

// Canvas 2D context 替身（僅供 Node 測試；繪圖呼叫皆為 no-op）
var ctxStub = {};
['fillRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'fill', 'stroke',
 'fillText', 'save', 'translate', 'rotate', 'ellipse', 'restore', 'quadraticCurveTo',
 'scale', 'rect', 'clip', 'bezierCurveTo', 'strokeRect'].forEach(function (m) {
  ctxStub[m] = function () {};
});
ctxStub.createLinearGradient = function () { return { addColorStop: function () {} }; };
var fakeCanvas = { width: 920, height: 540, getContext: function () { return ctxStub; } };
var failures = 0;

[22, 38, 55].forEach(function (duration) {
  var bad = 0;
  for (var trial = 0; trial < 200; trial++) {
    var seed = ('0000000000000000000000000000000' + trial.toString(16)).slice(-32);
    var n = [6, 8, 12][trial % 3];
    var round = Model.buildRound(seed, n, 1.0);
    var an = new RaceAnimator(fakeCanvas, round.horses, round.finishOrder, { duration: duration });

    for (var i = 0; i < n; i++) {
      var prev = -1;
      for (var t = 0; t <= an.endTime + 0.001; t += 0.01) {
        var p = an.progressOf(i, t);
        if (p < prev - 1e-12) { bad++; break; }
        prev = p;
      }
    }
    var byT = round.horses.map(function (_, k) { return k; })
      .sort(function (a, b) { return an.T[a] - an.T[b]; });
    if (byT.join() !== round.finishOrder.join()) bad++;
    if (an.rankingAt(an.endTime).join() !== round.finishOrder.join()) bad++;
  }
  var ok = bad === 0;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '賽程 ' + duration + 's × 200 場（6/8/12 匹混合）' +
    (ok ? '：單調 + 衝線順序 + 名次板皆一致' : '：異常 ' + bad + ' 件'));
  if (!ok) failures++;
});

// 3.5) 種子化編排：同 opts.rand 種子 → 兩個動畫器的時序/跑法完全一致
//      （多人模式各端用 hash+名次衍生同一種子，畫面跑位才會同步）
var RNG = require('../js/rng.js');
(function () {
  var r = Model.buildRound('a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', 8, 1.0);
  var seed = RNG.sha256(r.hash + '|' + r.finishOrder.join(','));
  function mk() {
    return new RaceAnimator(fakeCanvas, r.horses, r.finishOrder,
      { duration: 38, rand: RNG.seededRand(seed) });
  }
  var a = mk(), b = mk();
  var same = a.T.join() === b.T.join();
  for (var i = 0; i < 8 && same; i++) {
    var pa = a.pace[i], pb = b.pace[i];
    if (pa.base !== pb.base || pa.amp !== pb.amp || pa.f !== pb.f || pa.ph !== pb.ph) same = false;
  }
  // 不同名次 → 不同種子（編排不該跨場沿用）
  var c = new RaceAnimator(fakeCanvas, r.horses, r.finishOrder,
    { duration: 38, rand: RNG.seededRand(RNG.sha256(r.hash + '|other')) });
  var differs = a.T.join() !== c.T.join();
  console.log((same ? '  ✓ ' : '  ✗ ') + '同種子編排一致（多人跑位同步）');
  console.log((differs ? '  ✓ ' : '  ✗ ') + '異種子編排相異');
  if (!same || !differs) failures++;
})();

// 4) start → 動畫迴圈 → onFinish 鏈路（以假 rAF 快轉，每幀推進 100ms）
global.requestAnimationFrame = function (cb) {
  return setImmediate(function () { vTime += 100; cb(vTime); });
};
global.cancelAnimationFrame = function (id) { clearImmediate(id); };
var vTime = 0;
var round = Model.buildRound('feedfacefeedfacefeedfacefeedface', 8, 1.0);
var commentaries = 0;
var an = new RaceAnimator(fakeCanvas, round.horses, round.finishOrder, {
  duration: 38,
  onCommentary: function () { commentaries++; },
  onFinish: function () {
    var ok1 = an.finished && !an.running;
    var ok2 = an.rankingAt(an.endTime).join() === round.finishOrder.join();
    var ok3 = commentaries >= 6; // 5 個里程碑 + 衝線播報
    console.log((ok1 ? '  ✓ ' : '  ✗ ') + 'onFinish 觸發且狀態正確');
    console.log((ok2 ? '  ✓ ' : '  ✗ ') + '完賽名次 = 抽定名次');
    console.log((ok3 ? '  ✓ ' : '  ✗ ') + '旁述播報完整（' + commentaries + ' 則）');
    if (!ok1 || !ok2 || !ok3) failures++;
    console.log(failures === 0 ? '動畫一致性 PASS ✓' : 'FAIL ✗');
    process.exit(failures === 0 ? 0 : 1);
  }
});
an.start();
