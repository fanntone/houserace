/* audio.js — 語音旁述（Web Speech API，瀏覽器內建、離線可用） */
(function (global) {
  'use strict';

  var supported = typeof speechSynthesis !== 'undefined' &&
                  typeof SpeechSynthesisUtterance !== 'undefined';
  var enabled = true;
  var voice = null;

  // 挑選賽事主播聲線：男聲 > 自然語音（Edge）> 台灣中文 > 任何中文
  function scoreVoice(v) {
    var name = (v.name || '').toLowerCase();
    var lang = (v.lang || '').toLowerCase().replace('_', '-');
    if (lang.indexOf('zh') !== 0) return -1;
    var s = 1;
    if (lang === 'zh-tw') s += 3;
    if (/natural|online/.test(name)) s += 4; // Edge 內建自然語音，質感最佳
    if (/yunjhe|yunxi|yunyang|yunye|kangkang|male|雲哲|男/.test(name)) s += 6; // 男聲
    return s;
  }
  function pickVoice() {
    if (!supported) return;
    var vs = speechSynthesis.getVoices();
    var best = null, bestScore = -1;
    for (var i = 0; i < vs.length; i++) {
      var sc = scoreVoice(vs[i]);
      if (sc > bestScore) { bestScore = sc; best = vs[i]; }
    }
    voice = best;
  }
  if (supported) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  var gen = 0; // 世代計數：stop() 後仍在排程中的語音一律作廢

  // rate：1.0 平穩 → 1.3 衝線激動
  function speak(text, rate) {
    if (!supported || !enabled) return;
    var clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
    if (!clean) return;
    var token = ++gen;
    try {
      speechSynthesis.cancel();
      // Chrome 已知問題：cancel 後立刻 speak 可能被吃掉，稍微延遲
      setTimeout(function () {
        if (!enabled || token !== gen) return;
        var u = new SpeechSynthesisUtterance(clean);
        u.lang = 'zh-TW';
        if (voice) u.voice = voice;
        u.rate = rate || 1.05;
        u.pitch = 1.08 + Math.min(0.14, Math.max(0, (u.rate - 1) * 0.3)); // 越急促音調越亢奮
        speechSynthesis.speak(u);
      }, 30);
    } catch (e) { /* 語音失敗不影響遊戲 */ }
  }

  function stop() {
    gen++;
    if (supported) { try { speechSynthesis.cancel(); } catch (e) {} }
  }

  global.Voice = {
    supported: supported,
    speak: speak,
    stop: stop,
    setEnabled: function (on) { enabled = !!on; if (!on) stop(); },
    isEnabled: function () { return enabled; }
  };
})(window);
