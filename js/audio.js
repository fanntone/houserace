/* audio.js — 語音旁述（Web Speech API，瀏覽器內建、離線可用） */
(function (global) {
  'use strict';

  var supported = typeof speechSynthesis !== 'undefined' &&
                  typeof SpeechSynthesisUtterance !== 'undefined';
  var enabled = true;
  var voice = null;
  var preferredName = null; // 使用者在設定中指定的語音名稱

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
    if (preferredName) { // 使用者指定優先
      for (var j = 0; j < vs.length; j++) {
        if (vs[j].name === preferredName) { voice = vs[j]; return; }
      }
    }
    var best = null, bestScore = -1;
    for (var i = 0; i < vs.length; i++) {
      var sc = scoreVoice(vs[i]);
      if (sc > bestScore) { bestScore = sc; best = vs[i]; }
    }
    voice = best;
  }

  // 可用的中文語音清單（給設定面板）
  function listZh() {
    if (!supported) return [];
    return speechSynthesis.getVoices()
      .filter(function (v) { return (v.lang || '').toLowerCase().replace('_', '-').indexOf('zh') === 0; })
      .map(function (v) { return { name: v.name, lang: v.lang, score: scoreVoice(v) }; })
      .sort(function (a, b) { return b.score - a.score; });
  }
  if (supported) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  var gen = 0; // 世代計數：stop() 後仍在排程中的語音一律作廢

  // 主播式播報：把長句切成短爆發句，逐句加速、音調起伏，營造抑揚頓挫
  // rate：1.0 平穩 → 1.5 衝線激動
  function speak(text, rate) {
    if (!supported || !enabled) return;
    var clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
    if (!clean) return;
    var base = rate || 1.05;
    // 以驚嘆號/逗號切句，保留語氣
    var parts = clean.split(/(?<=[！!])|(?<=[，,])/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (parts.length === 0) parts = [clean];
    var token = ++gen;
    try {
      speechSynthesis.cancel();
      // Chrome 已知問題：cancel 後立刻 speak 可能被吃掉，稍微延遲
      setTimeout(function () {
        if (!enabled || token !== gen) return;
        for (var i = 0; i < parts.length; i++) {
          var u = new SpeechSynthesisUtterance(parts[i]);
          u.lang = 'zh-TW';
          if (voice) u.voice = voice;
          var excl = /[！!]$/.test(parts[i]) ? 0.08 : 0;        // 驚嘆句再亢奮一點
          u.rate = Math.min(1.6, base + i * 0.04 + excl);       // 逐句催速
          u.pitch = Math.min(1.35,
            1.06 + Math.max(0, (u.rate - 1) * 0.35) + excl +    // 越快越高亢
            (Math.random() * 0.06 - 0.03));                     // 微抖動避免機械感
          speechSynthesis.speak(u);                             // 依序排隊播出
        }
      }, 30);
    } catch (e) { /* 語音失敗不影響遊戲 */ }
  }

  function stop() {
    gen++;
    if (supported) { try { speechSynthesis.cancel(); } catch (e) {} }
  }

  // 出閘倒數嗶聲（WebAudio 合成，無音檔）
  var actx = null;
  function beep(freq, ms) {
    if (!enabled) return;
    try {
      actx = actx || new (global.AudioContext || global.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator();
      var gn = actx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      gn.gain.setValueAtTime(0.0001, actx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.22, actx.currentTime + 0.012);
      gn.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + ms / 1000);
      o.connect(gn);
      gn.connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + ms / 1000 + 0.05);
    } catch (e) { /* 無聲也不影響遊戲 */ }
  }

  global.Voice = {
    supported: supported,
    speak: speak,
    stop: stop,
    setEnabled: function (on) { enabled = !!on; if (!on) stop(); },
    isEnabled: function () { return enabled; },
    listZh: listZh,
    setPreferred: function (name) { preferredName = name || null; pickVoice(); },
    currentName: function () { return voice ? voice.name : '(無)'; },
    beep: beep
  };
})(window);
