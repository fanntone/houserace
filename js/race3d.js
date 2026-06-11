/* race3d.js — Three.js 真 3D 電視轉播渲染器
 *
 * 與 2D 版（race.js）共用全部賽果數學與流程（progressOf / 名次保證 / 旁述 /
 * 定格慢動作主迴圈），只替換渲染層：真實透視攝影機在場外跟拍領先集團、
 * 彎道自然透視、終點固定機位迎面拍攝壓線。馬匹使用 three.js 官方
 * 低多邊形動畫馬模型（Horse.glb，morph target 奔跑動畫）。
 * 若 THREE 不可用，main.js 會退回 2D 渲染器。
 */
(function (global) {
  'use strict';
  if (typeof THREE === 'undefined' || typeof RaceAnimator === 'undefined') return;

  // ---------- 內嵌馬模型（base64 → ArrayBuffer → GLTF） ----------
  var STRIDE_LEN = 6.2; // 一個完整奔跑週期前進的距離（公尺）；動畫速率 = 地速 ÷ 步幅，杜絕滑步
  var assets = { gltf: null, normScale: 1, clipDur: 1, pending: [] };

  // 平滑法線：把同位置頂點的法線平均，消除低多邊形稜面（方塊感 → 圓潤）
  function smoothNormals(geo) {
    geo.computeVertexNormals();
    var p = geo.attributes.position, nrm = geo.attributes.normal;
    var acc = {}, i, k;
    function key(idx) {
      return p.getX(idx).toFixed(3) + ',' + p.getY(idx).toFixed(3) + ',' + p.getZ(idx).toFixed(3);
    }
    for (i = 0; i < p.count; i++) {
      k = key(i);
      var a = acc[k] || (acc[k] = [0, 0, 0]);
      a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i);
    }
    for (i = 0; i < p.count; i++) {
      var s = acc[key(i)];
      var len = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) || 1;
      nrm.setXYZ(i, s[0] / len, s[1] / len, s[2] / len);
    }
    nrm.needsUpdate = true;
  }

  (function parseHorse() {
    try {
      var bin = atob(HORSE_GLB_BASE64);
      var buf = new ArrayBuffer(bin.length);
      var u8 = new Uint8Array(buf);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      new THREE.GLTFLoader().parse(buf, '', function (gltf) {
        var mesh = gltf.scene.children[0];
        smoothNormals(mesh.geometry);
        var box = new THREE.Box3().setFromObject(mesh);
        var size = box.getSize(new THREE.Vector3());
        assets.normScale = 2.45 / size.y; // 正規化成總高約 2.45m
        // 模型長軸為 Z（面向 +Z），寬度取 X，供號碼布貼合側腹
        assets.halfWidth = Math.min(0.5, (size.x * assets.normScale) / 2 + 0.04);
        assets.backHeight = size.y * assets.normScale * 0.62; // 約馬背高度
        assets.clipDur = gltf.animations[0].duration || 1;
        assets.gltf = gltf;
        assets.pending.forEach(function (cb) { cb(); });
        assets.pending = [];
      }, function (e) { console.warn('Horse.glb 解析失敗', e); });
    } catch (e) { console.warn(e); }
  })();

  // ---------- 共用場景（同一 canvas 只建一次，逐場只重建馬匹） ----------
  var shared = { renderer: null, scene: null, camera: null, built: false,
                 horsesGroup: null, gateGroup: null, screenCtx: null, screenTex: null,
                 overlay: null };

  function RaceAnimator3D(canvas, horses, finishOrder, opts) {
    this.canvas = canvas;
    this.horses = horses;
    this.finishOrder = finishOrder;
    this.opts = opts || {};
    this.duration = this.opts.duration || 38;
    this.speed = 1;
    this.raceTime = 0;
    this.running = false;
    this.finished = false;
    this._raf = null;
    this._setupGeometry();
    RaceAnimator.prototype._setupRace.call(this); // 共用時序/名次/旁述設定
    this._ensureScene();
    this._buildRound();
  }

  // —— 借用 2D 類別的共用數學與主迴圈（drawFrame/_finish/stop 由本類別實作） ——
  ['progressOf', 'distOf', 'rankingAt', 'lanePoint', '_checkMilestones', '_label',
   'start', 'skip', 'setSpeed', 'drawIdle'].forEach(function (m) {
    RaceAnimator3D.prototype[m] = RaceAnimator.prototype[m];
  });

  // 完賽後不停格：繼續渲染「勝利者環繞」鏡頭（馬群自然收步、鏡頭繞著冠軍旋轉）
  RaceAnimator3D.prototype._finish = function () {
    this.running = false;
    this.finished = true;
    this._slowmo = false;
    this.drawFrame(this.endTime);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.opts.onFinish) this.opts.onFinish();
    this._startPostLoop();
  };

  RaceAnimator3D.prototype._startPostLoop = function () {
    var self = this;
    this._post = true;
    this._postT = 0;
    var last = null;
    function loop(now) {
      if (!self._post) return;
      if (last === null) last = now;
      var dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      self._postT += dt;
      self.drawFrame(self.endTime + self._postT);
      self._postRaf = requestAnimationFrame(loop);
    }
    this._postRaf = requestAnimationFrame(loop);
  };

  RaceAnimator3D.prototype.stop = function () {
    this.running = false;
    this._post = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._postRaf) cancelAnimationFrame(this._postRaf);
  };

  RaceAnimator3D.prototype._setupGeometry = function () {
    // 世界座標：公尺。x 沿主直道，z 朝看台側，y 向上。
    this.cx = 0;
    this.cy = 0;
    this.L = 70;          // 直道半長（全長 140m）
    this.lane0R = 66;     // 第 1 道端弧半徑
    this.laneGap = 2.0;
    this.outerR = 72;     // 跑道帶外緣（固定，與馬匹數無關）
    this.innerR = 40;     // 跑道帶內緣
    this.finishX = this.cx + this.L * 0.5;
    this.P0 = 4 * this.L + 2 * Math.PI * this.lane0R; // ≈ 695m，38 秒 ≈ 18.3m/s（真實馬速）
  };

  // 操場形等距取樣（半徑 r、frac 與 lanePoint 同原點），回傳 {x, y(=z)}
  RaceAnimator3D.prototype.ovalXY = function (r, frac) {
    var L = this.L, cx = this.cx, cy = this.cy;
    var P = 4 * L + 2 * Math.PI * r;
    var d0 = L + (this.finishX - this.cx);
    var d = ((d0 + frac * P) % P + P) % P;
    if (d < 2 * L) return { x: cx - L + d, y: cy + r };
    d -= 2 * L;
    if (d < Math.PI * r) {
      var th = Math.PI / 2 - d / r;
      return { x: cx + L + r * Math.cos(th), y: cy + r * Math.sin(th) };
    }
    d -= Math.PI * r;
    if (d < 2 * L) return { x: cx + L - d, y: cy - r };
    d -= 2 * L;
    var ph = -Math.PI / 2 - d / r;
    return { x: cx - L + r * Math.cos(ph), y: cy + r * Math.sin(ph) };
  };

  // 沿賽道距離取點 + 切線/外法線（供攝影機機位）
  RaceAnimator3D.prototype.pathPt = function (dist, lat) {
    var frac = dist / this.P0;
    var a = this.lanePoint(0, frac);
    var b = this.lanePoint(0, frac + 2 / this.P0);
    var tx = b.x - a.x, tz = b.y - a.y;
    var tl = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tl; tz /= tl;
    var nx = tz, nz = -tx; // 法線（取指向場外側）
    if (nx * (a.x - this.cx) + nz * (a.y - this.cy) < 0) { nx = -nx; nz = -nz; }
    return { x: a.x + nx * lat, z: a.y + nz * lat, tx: tx, tz: tz };
  };

  // ---------- 場景建立（靜態部分一次） ----------
  RaceAnimator3D.prototype._ensureScene = function () {
    if (shared.built) {
      this.renderer = shared.renderer;
      this.scene = shared.scene;
      this.camera = shared.camera;
      this._ensureOverlay();
      return;
    }
    var self = this;
    var renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    renderer.setSize(this.canvas.width, this.canvas.height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // 電影級色調，柔化低多邊形的生硬感
    renderer.toneMappingExposure = 1.05;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8fc3e8);
    scene.fog = new THREE.Fog(0xa9d0e8, 260, 720);

    scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x3a6b3f, 0.55));
    var sun = new THREE.DirectionalLight(0xfff1d6, 1.3);
    sun.position.set(130, 170, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
    sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
    sun.shadow.camera.far = 500;
    scene.add(sun);

    // 大地（亮綠草皮，與跑道帶形成對比）
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400),
      new THREE.MeshLambertMaterial({ color: 0x79b06c })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // 跑道帶（手工三角化環帶：外緣與內緣各取樣後織成四邊形帶，保證渲染）
    function ringStrip(rIn, rOut, segs) {
      var pos = [], idx = [];
      for (var i = 0; i <= segs; i++) {
        var f = i / segs;
        var a = self.ovalXY(rOut, f), b = self.ovalXY(rIn, f);
        pos.push(a.x, 0, a.y, b.x, 0, b.y);
      }
      for (var j = 0; j < segs; j++) {
        var o = j * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    }
    var track = new THREE.Mesh(
      ringStrip(this.innerR, this.outerR, 160),
      new THREE.MeshLambertMaterial({ color: 0x256b39, side: THREE.DoubleSide })
    );
    track.position.y = 0.05;
    track.receiveShadow = true;
    scene.add(track);

    // 欄杆（內外各兩道白欄 + 立柱）
    function railRing(r, h) {
      var pts = [];
      for (var i = 0; i < 96; i++) {
        var p = self.ovalXY(r, i / 96);
        pts.push(new THREE.Vector3(p.x, h, p.y));
      }
      var curve = new THREE.CatmullRomCurve3(pts, true);
      return new THREE.Mesh(
        new THREE.TubeGeometry(curve, 192, 0.05, 6, true),
        new THREE.MeshLambertMaterial({ color: 0xf2f5f7 })
      );
    }
    [68.5, 41.5].forEach(function (r) {
      scene.add(railRing(r, 1.05));
      scene.add(railRing(r, 0.6));
      var P = 4 * self.L + 2 * Math.PI * r;
      var count = Math.floor(P / 6);
      var post = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.05, 0.05, 1.05, 5),
        new THREE.MeshLambertMaterial({ color: 0xe8edf0 }), count);
      var m4 = new THREE.Matrix4();
      for (var i = 0; i < count; i++) {
        var p = self.ovalXY(r, i / count);
        m4.makeTranslation(p.x, 0.52, p.y);
        post.setMatrixAt(i, m4);
      }
      scene.add(post);
    });

    // 看台（主直道外側）：階梯 + 群眾貼圖 + 屋頂
    var crowdCv = document.createElement('canvas');
    crowdCv.width = 1024; crowdCv.height = 128;
    var cc = crowdCv.getContext('2d');
    cc.fillStyle = '#737e8c';
    cc.fillRect(0, 0, 1024, 128);
    var pal = ['#e35d5d', '#5d8fe3', '#e3c75d', '#f1f3f5', '#23272e', '#7ce38f', '#c98fe3'];
    for (var d = 0; d < 2600; d++) {
      cc.fillStyle = pal[(d * 31) % 7];
      cc.fillRect((d * 97) % 1024, (d * 53) % 120, 3, 4);
    }
    var crowdTex = new THREE.CanvasTexture(crowdCv);
    crowdTex.encoding = THREE.sRGBEncoding;
    var standGroup = new THREE.Group();
    var greyMat = new THREE.MeshLambertMaterial({ color: 0xaab4bf });
    var crowdMat = new THREE.MeshLambertMaterial({ map: crowdTex, emissive: 0x1a1d22 });
    [[0, 2.2], [5.5, 6.2], [11, 10.2]].forEach(function (t) { // 階梯式三層，往後越高
      var tier = new THREE.Mesh(
        new THREE.BoxGeometry(150, 4.4, 5),
        [greyMat, greyMat, new THREE.MeshLambertMaterial({ color: 0xbcc5cf }),
         greyMat, crowdMat, crowdMat] // 兩面都有群眾，朝跑道必有
      );
      tier.position.set(0, t[1], t[0]);
      tier.castShadow = true;
      standGroup.add(tier);
    });
    var roof = new THREE.Mesh(
      new THREE.BoxGeometry(154, 0.8, 19),
      new THREE.MeshLambertMaterial({ color: 0xe9eef2 })
    );
    roof.position.set(0, 14.6, 6);
    roof.castShadow = true;
    standGroup.add(roof);
    [-72, -24, 24, 72].forEach(function (px) { // 屋頂支柱
      var pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 14.2, 6),
        new THREE.MeshLambertMaterial({ color: 0xd5dbe1 }));
      pillar.position.set(px, 7.1, 11);
      standGroup.add(pillar);
    });
    standGroup.position.set(0, 0, this.lane0R + 26);
    scene.add(standGroup);

    // 內場大螢幕（顯示場次，靠近終點）
    var scv = document.createElement('canvas');
    scv.width = 512; scv.height = 256;
    shared.screenCtx = scv.getContext('2d');
    shared.screenTex = new THREE.CanvasTexture(scv);
    shared.screenTex.encoding = THREE.sRGBEncoding;
    var screenMesh = new THREE.Mesh(
      new THREE.BoxGeometry(16, 8, 0.8),
      new THREE.MeshLambertMaterial({ color: 0x1b212b })
    );
    var face = new THREE.Mesh(
      new THREE.PlaneGeometry(15, 7.2),
      new THREE.MeshBasicMaterial({ map: shared.screenTex })
    );
    face.position.z = 0.45;
    screenMesh.add(face);
    var towerG = new THREE.Group();
    towerG.add(screenMesh);
    var legGeo = new THREE.CylinderGeometry(0.3, 0.3, 6, 6);
    var legMat = new THREE.MeshLambertMaterial({ color: 0x39424e });
    [-6, 6].forEach(function (lx) {
      var leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, -7, 0);
      screenMesh.add(leg);
    });
    screenMesh.position.set(this.finishX - 14, 10, this.innerR - 10);
    screenMesh.lookAt(this.finishX + 10, 2, this.lane0R + 26);
    towerG.castShadow = true;
    scene.add(towerG);

    // 內場湖泊與樹木、場外樹林
    var lake = new THREE.Mesh(
      new THREE.CircleGeometry(16, 28),
      new THREE.MeshLambertMaterial({ color: 0x5d9fd6 })
    );
    lake.rotation.x = -Math.PI / 2;
    lake.scale.x = 1.8;
    lake.position.set(-30, 0.06, 0);
    scene.add(lake);

    var trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.2, 5);
    var crownGeo = new THREE.ConeGeometry(2.2, 5, 7);
    var trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
    var crownMats = [new THREE.MeshLambertMaterial({ color: 0x2a6336 }),
                     new THREE.MeshLambertMaterial({ color: 0x357a42 })];
    function tree(x, z, s) {
      var g = new THREE.Group();
      var tr = new THREE.Mesh(trunkGeo, trunkMat);
      tr.position.y = 1.1;
      var cr = new THREE.Mesh(crownGeo, crownMats[(x * 7 ^ z * 13) & 1]);
      cr.position.y = 4.2;
      cr.castShadow = true;
      g.add(tr); g.add(cr);
      g.position.set(x, 0, z);
      g.scale.setScalar(s);
      scene.add(g);
    }
    for (var ti = 0; ti < 26; ti++) { // 場外（後直道與彎道側）
      var fr = 0.25 + (ti / 26) * 0.62;
      var pp = self.ovalXY(self.outerR + 10 + (ti * 37 % 26), fr);
      tree(pp.x, pp.y, 0.9 + (ti * 29 % 10) / 10);
    }
    for (var tj = 0; tj < 10; tj++) { // 內場
      var pq = self.ovalXY(self.innerR - 12 - (tj * 17 % 18), 0.18 + tj * 0.07);
      tree(pq.x, pq.y, 0.8 + (tj % 3) * 0.2);
    }

    // 終點：白色標柱（內外側）+ 跑道上的白線
    var poleGeo = new THREE.CylinderGeometry(0.07, 0.07, 3.4, 6);
    var poleMat = new THREE.MeshLambertMaterial({ color: 0xf5f7f9 });
    var ballGeo = new THREE.SphereGeometry(0.28, 8, 8);
    var ballMat = new THREE.MeshLambertMaterial({ color: 0xe03131 });
    var fz = [this.lane0R + 2.6, this.innerR + 0.6];
    for (var pi = 0; pi < 2; pi++) {
      var pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(this.finishX, 1.7, fz[pi]);
      pole.castShadow = true;
      scene.add(pole);
      var ball = new THREE.Mesh(ballGeo, ballMat);
      ball.position.set(this.finishX, 3.5, fz[pi]);
      scene.add(ball);
    }
    var fline = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, this.lane0R + 2.4 - this.innerR),
      new THREE.MeshLambertMaterial({ color: 0xf1f3f5 })
    );
    fline.rotation.x = -Math.PI / 2;
    fline.position.set(this.finishX, 0.07, (this.lane0R + 2.4 + this.innerR) / 2);
    scene.add(fline);

    var camera = new THREE.PerspectiveCamera(42, this.canvas.width / this.canvas.height, 0.5, 900);
    camera.position.set(0, 30, 160);

    shared.renderer = renderer;
    shared.scene = scene;
    shared.camera = camera;
    shared.built = true;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this._ensureOverlay();
  };

  // 2D 覆蓋層（小地圖 / 白閃 / 定格字卡）
  RaceAnimator3D.prototype._ensureOverlay = function () {
    if (shared.overlay) { this.overlay = shared.overlay; return; }
    var ov = document.getElementById('overlay');
    if (!ov) { // 預覽頁等情況：動態建立
      ov = document.createElement('canvas');
      ov.width = this.canvas.width; ov.height = this.canvas.height;
      ov.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      if (this.canvas.parentNode) this.canvas.parentNode.appendChild(ov);
    }
    shared.overlay = ov;
    this.overlay = ov;
  };

  // ---------- 每場重建：馬匹 + 號碼布 + 騎師 + 閘門 + 大螢幕文字 ----------
  RaceAnimator3D.prototype._buildRound = function () {
    var self = this;
    if (shared.horsesGroup) { this.scene.remove(shared.horsesGroup); }
    if (shared.gateGroup) { this.scene.remove(shared.gateGroup); }
    shared.horsesGroup = new THREE.Group();
    shared.gateGroup = this._buildGate();
    this.scene.add(shared.horsesGroup);
    this.scene.add(shared.gateGroup);
    this._horses3d = [];
    this._mixers = [];
    this._actions = [];
    this._prevDist = [];

    // 大螢幕文字
    var sc = shared.screenCtx;
    sc.fillStyle = '#10151d';
    sc.fillRect(0, 0, 512, 256);
    sc.fillStyle = '#ffd43b';
    sc.font = 'bold 84px "Microsoft JhengHei", sans-serif';
    sc.textAlign = 'center';
    sc.fillText(this.opts.infieldText || 'RACE', 256, 120);
    sc.fillStyle = '#9aa3b2';
    sc.font = '40px "Microsoft JhengHei", sans-serif';
    sc.fillText(this.opts.infieldSub || '', 256, 196);
    shared.screenTex.needsUpdate = true;

    if (assets.gltf) this._buildHorses();
    else {
      var myGroup = shared.horsesGroup; // 防止舊場次的延遲回呼把舊馬加進新場景
      assets.pending.push(function () {
        if (shared.horsesGroup !== myGroup) return;
        self._buildHorses();
        if (!self.running) self.drawFrame(self.raceTime || 0);
      });
    }
  };

  RaceAnimator3D.prototype._buildGate = function () {
    var g = new THREE.Group();
    var mat = new THREE.MeshLambertMaterial({ color: 0xd7dde3, transparent: true, opacity: 0.92 });
    var n = this.horses.length;
    for (var k = 0; k <= n; k++) {
      // 各道隔板：短板擋在馬身後半，馬頭探出閘門前緣
      var wall = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.1, 0.1), mat);
      var p = this.lanePoint(Math.min(k, n - 1), 0);
      var off = (k === n) ? -this.laneGap : 0;
      wall.position.set(p.x - 0.9, 1.05, p.y + off + this.laneGap / 2);
      wall.castShadow = true;
      g.add(wall);
    }
    var top = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, n * this.laneGap + 1), mat);
    var pm = this.lanePoint((this.horses.length - 1) / 2, 0);
    top.position.set(pm.x - 0.9, 2.45, pm.y);
    g.add(top);
    return g;
  };

  // 鞍布貼圖：圓筒展開圖（u = 繞馬身方向、v = 沿馬身方向）。
  // 號碼印在左右側腹位置，各旋轉 90° 使其在曲面上直立。
  function clothTexture(horse) {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 256;
    var c = cv.getContext('2d');
    c.fillStyle = horse.color.bg;
    c.fillRect(0, 0, 512, 256);
    // 布面明暗（下襬略暗，營造垂墜立體感）
    var g1 = c.createLinearGradient(0, 0, 512, 0);
    g1.addColorStop(0, 'rgba(0,0,0,0.30)');
    g1.addColorStop(0.25, 'rgba(0,0,0,0)');
    g1.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    g1.addColorStop(0.75, 'rgba(0,0,0,0)');
    g1.addColorStop(1, 'rgba(0,0,0,0.30)');
    c.fillStyle = g1;
    c.fillRect(0, 0, 512, 256);
    // 鑲邊
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 10;
    c.strokeRect(5, 5, 502, 246);
    function stamp(u, rot) { // u: 貼圖橫向中心(0..1)，rot: 讓號碼在側腹直立
      c.save();
      c.translate(u * 512, 128);
      c.rotate(rot);
      c.fillStyle = horse.color.fg;
      c.font = 'bold 120px Arial';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(horse.num), 0, 8);
      c.restore();
    }
    stamp(0.25, Math.PI / 2);   // 一側
    stamp(0.75, -Math.PI / 2);  // 另一側
    var t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  // 騎師：骨架式關節人形（兩點間生成肢段，關節相連），競賽蹲姿
  function buildJockey(silksColor, hw) {
    var silks = new THREE.MeshLambertMaterial({ color: silksColor });
    var pants = new THREE.MeshLambertMaterial({ color: 0xf1f3f5 });
    var boots = new THREE.MeshLambertMaterial({ color: 0x23201d });
    var skin = new THREE.MeshLambertMaterial({ color: 0xe8c39e });
    var glove = new THREE.MeshLambertMaterial({ color: 0x2b2118 });
    var jk = new THREE.Group();

    function seg(parent, a, b, r, mat) { // 在 a→b 之間生成一節肢段（膠囊自動轉向）
      var dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      var len = dir.length();
      var mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 3, 8), mat);
      mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    }
    function ball(parent, p, r, mat) {
      var m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
      m.position.set(p[0], p[1], p[2]);
      m.castShadow = true;
      parent.add(m);
      return m;
    }

    var hip = [0, 0.14, -0.14];
    var shoulder = [0, 0.42, 0.18];
    var headC = [0, 0.50, 0.34];
    // 軀幹（前傾脊柱）與骨盆
    ball(jk, hip, 0.095, pants);
    seg(jk, hip, shoulder, 0.105, silks);
    ball(jk, shoulder, 0.10, silks);
    // 頸與頭
    seg(jk, [0, 0.44, 0.22], headC, 0.045, skin);
    ball(jk, headC, 0.085, skin);
    var helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.10, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), silks);
    helmet.position.set(headC[0], headC[1] + 0.015, headC[2] - 0.01);
    helmet.rotation.x = 0.5; // 順著前傾視線戴
    jk.add(helmet);
    var goggles = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.028, 0.012), glove);
    goggles.position.set(0, 0.515, 0.415);
    jk.add(goggles);
    // 雙腿：高抬膝蹲姿（大腿前伸、小腿貼身後收、靴踩鐙）
    [-1, 1].forEach(function (s) {
      var hipS = [s * 0.09, 0.12, -0.10];
      var knee = [s * 0.14, 0.15, 0.20];
      var heel = [s * 0.16, -0.12, 0.08];
      seg(jk, hipS, knee, 0.062, pants);
      seg(jk, knee, heel, 0.05, boots);
      seg(jk, heel, [heel[0], heel[1] - 0.015, heel[2] + 0.11], 0.042, boots); // 靴尖
    });
    // 左臂（拉韁）
    var shL = [-0.11, 0.40, 0.18], elbL = [-0.15, 0.27, 0.32], handL = [-0.09, 0.21, 0.47];
    seg(jk, shL, elbL, 0.048, silks);
    seg(jk, elbL, handL, 0.042, silks);
    ball(jk, handL, 0.05, glove);
    // 右臂 + 馬鞭（以肩為轉軸，可揮動）
    var whipArm = new THREE.Group();
    whipArm.position.set(0.11, 0.40, 0.18);
    var elbR = [0.05, -0.13, 0.13], handR = [0.0, -0.19, 0.29];
    seg(whipArm, [0, 0, 0], elbR, 0.048, silks);
    seg(whipArm, elbR, handR, 0.042, silks);
    ball(whipArm, handR, 0.05, glove);
    seg(whipArm, handR, [handR[0] + 0.02, handR[1] + 0.14, handR[2] - 0.20], 0.011, boots); // 短鞭
    whipArm.rotation.x = -0.4;
    jk.add(whipArm);

    return { group: jk, whipArm: whipArm };
  }

  RaceAnimator3D.prototype._buildHorses = function () {
    if (this._horses3d.length) return;
    var src = assets.gltf.scene.children[0];
    // 模型朝向校正（lookAt 會把群組 +Z 對準行進方向）；可用 window.HORSE_YAW 調校
    var yaw = (typeof global.HORSE_YAW === 'number') ? global.HORSE_YAW : 0;
    for (var k = 0; k < this.horses.length; k++) {
      var horse = this.horses[k];
      var mesh = src.clone();
      mesh.material = src.material.clone();
      mesh.material.color = new THREE.Color(horse.coat ? horse.coat.body : '#8a5a33');
      mesh.castShadow = true;
      mesh.scale.setScalar(assets.normScale);
      var inner = new THREE.Group(); // 模型朝向校正層
      inner.add(mesh);
      inner.rotation.y = yaw;
      var g = new THREE.Group();
      g.add(inner);

      // 鞍布：包裹馬腹的弧形布面（上窄下襬微張），號碼印在兩側曲面上
      var ct = clothTexture(horse);
      var hw = assets.halfWidth || 0.34;
      var backH = assets.backHeight || 1.5;
      // θ 以馬背為中心包約 235°，開口朝腹部下方；下襬微張營造垂墜
      var clothGeo = new THREE.CylinderGeometry(hw + 0.04, hw + 0.07, 0.72, 28, 1, true,
        Math.PI * 0.35, Math.PI * 1.3);
      clothGeo.rotateX(Math.PI / 2); // 圓筒軸轉為沿馬身方向
      var cloth = new THREE.Mesh(clothGeo, new THREE.MeshLambertMaterial({ map: ct }));
      cloth.position.set(0, backH - hw * 0.8, -0.05);
      cloth.castShadow = true;
      g.add(cloth);

      // 騎師：關節人形（競賽蹲姿），掛在馬背基準點，整組做騎乘律動
      var built = buildJockey(horse.color.bg, hw);
      var jk = built.group;
      jk.position.set(0, backH, 0.08); // 略前坐於鞍上
      g.add(jk);
      g.userData.jockey = jk;
      g.userData.whipArm = built.whipArm;
      g.userData.whipT = 0;

      shared.horsesGroup.add(g);
      this._horses3d.push(g);

      var mixer = new THREE.AnimationMixer(mesh);
      var action = mixer.clipAction(assets.gltf.animations[0]);
      action.play();
      action.time = (horse.num * 0.137) % action.getClip().duration; // 步伐錯開
      this._mixers.push(mixer);
      this._actions.push(action);
    }
  };

  // ---------- 轉播攝影機 ----------
  RaceAnimator3D.prototype._updateCamera = function (time, dt) {
    if (!this._camState) {
      this._camState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), shot: '' };
    }
    var cs = this._camState;
    var W = this.P0;
    var shot, posT = new THREE.Vector3(), lookT = new THREE.Vector3();
    var n = this.horses.length;

    if (time <= 0) {
      shot = 'gate';
      var gp = this.pathPt(11, 9);                 // 閘門斜前方近距
      var gl = this.lanePoint((n - 1) / 2, 0);
      posT.set(gp.x, 2.6, gp.z);
      lookT.set(gl.x + 1.2, 1.4, gl.y);
    } else {
      var ranking = this.rankingAt(time);
      var wts = [0.5, 0.3, 0.2], wd = 0;
      for (var i = 0; i < 3; i++) wd += this.distOf(ranking[i], time) * wts[i];
      // 集團質心（前 4 名）
      var cxp = 0, czp = 0, m = Math.min(4, n);
      for (var j = 0; j < m; j++) {
        var pj = this.lanePoint(ranking[j], this.progressOf(ranking[j], time));
        cxp += pj.x / m; czp += pj.y / m;
      }
      var leadD = this.distOf(ranking[0], time);
      var T3 = this.T[this.finishOrder[Math.min(2, n - 1)]];
      if (time > T3 + 0.6) {
        shot = 'winner'; // 賽後：鏡頭緩慢環繞減速中的冠軍馬（勝利者畫面）
        var w = this.finishOrder[0];
        var pw = this.lanePoint(w, this.progressOf(w, time));
        var ang = time * 0.22;
        posT.set(pw.x + Math.cos(ang) * 10, 3.4, pw.y + Math.sin(ang) * 10);
        lookT.set(pw.x, 1.5, pw.y);
      } else if (leadD > this.P0 - 115) {
        shot = 'finish'; // 終點固定機位：馬群迎面衝來壓線
        var fp = this.pathPt(this.P0 + 16, 13);
        var fl = this.lanePoint((n - 1) / 2, 1.0); // 終點線中心
        posT.set(fp.x, 4.6, fp.z);
        lookT.set(fl.x * 0.45 + cxp * 0.55, 1.6, fl.y * 0.45 + czp * 0.55);
      } else {
        shot = 'follow'; // 場外跟拍車（貼近馬群，朝行進方向略帶前視）
        var cp = this.pathPt(wd - 6, 15);
        posT.set(cp.x, 5.2, cp.z);
        lookT.set(cxp + cp.tx * 6, 1.5, czp + cp.tz * 6);
      }
    }

    if (cs.shot !== shot) { // 轉播切換機位＝瞬間跳接
      cs.pos.copy(posT);
      cs.look.copy(lookT);
      cs.shot = shot;
    } else {
      var k = 1 - Math.exp(-(dt || 0.016) * 3.2);
      cs.pos.lerp(posT, k);
      cs.look.lerp(lookT, Math.min(1, k * 1.6));
    }
    this.camera.position.copy(cs.pos);
    this.camera.lookAt(cs.look);
  };

  // ---------- 主繪製 ----------
  RaceAnimator3D.prototype.drawFrame = function (time) {
    var dt = Math.max(0, time - (this._lastT === undefined ? time : this._lastT));
    this._lastT = time;
    var moving = time > 0;

    for (var k = 0; k < this._horses3d.length; k++) {
      var g = this._horses3d[k];
      var prog = this.progressOf(k, time);
      var p = this.lanePoint(k, prog);
      var a = this.lanePoint(k, prog + 0.0015);
      g.position.set(p.x, 0, p.y);
      g.lookAt(a.x, 0, a.y);

      // 腳步貼地：實際地速(m/s) ÷ 步幅長 = 每秒步頻，動畫精準同步不滑步
      var d = this.distOf(k, time);
      var v = (dt > 0 && this._prevDist[k] !== undefined) ? (d - this._prevDist[k]) / dt : 0;
      this._prevDist[k] = d;
      if (this._mixers[k]) {
        var animDt = moving ? dt * Math.max(v, 0) * assets.clipDur / STRIDE_LEN
                            : dt * 0.12; // 待機小幅踏步；定格(dt=0)凍結
        this._mixers[k].update(animDt);
      }

      // 騎師律動：隨步幅起伏前後晃 + 末段隨機揮鞭
      var ud = g.userData;
      if (ud && ud.jockey) {
        var act = this._actions[k];
        var cyc = act ? (act.time / assets.clipDur) * Math.PI * 2 : 0;
        var amp = moving ? 1 : 0.15;
        var baseY = (assets.backHeight || 1.5);
        ud.jockey.position.y = baseY + Math.sin(cyc) * 0.07 * amp;
        ud.jockey.position.z = 0.05 * Math.sin(cyc + 0.6) * amp;
        ud.jockey.rotation.x = 0.08 * Math.sin(cyc + 1.1) * amp;
        if (moving && prog > 0.55 && prog < 1 && ud.whipT <= 0 && Math.random() < dt * 0.5) {
          ud.whipT = 0.5; // 平均約每 2 秒揮鞭一次，各馬隨機；過線後收鞭
        }
        if (ud.whipT > 0) {
          ud.whipT -= dt;
          var wp = 1 - Math.max(ud.whipT, 0) / 0.5;
          ud.whipArm.rotation.x = -0.5 - Math.sin(wp * Math.PI) * 1.3; // 揚鞭→抽落
        } else {
          ud.whipArm.rotation.x = -0.4 + 0.12 * Math.sin(cyc * 2) * amp;
        }
      }
    }
    if (shared.gateGroup) shared.gateGroup.visible = time <= 0.01 || time < 2.0;

    this._updateCamera(time, dt);
    this.renderer.render(this.scene, this.camera);
    this._drawOverlay(time);
  };

  // ---------- 覆蓋層：小地圖 + 定格/白閃/慢動作字卡 ----------
  RaceAnimator3D.prototype._drawOverlay = function (time) {
    var cv = this.overlay;
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    // 小地圖（俯視）
    var worldW = (this.L + this.outerR) * 2 + 16;
    var s = 170 / worldW;
    var mw = worldW * s, mh = (this.outerR * 2 + 16) * s;
    var mx = W - mw - 14, my = 12;
    ctx.fillStyle = 'rgba(10,14,20,0.72)';
    roundRect(ctx, mx - 6, my - 6, mw + 12, mh + 12, 8);
    ctx.fill();
    ctx.save();
    ctx.translate(mx + mw / 2, my + mh / 2);
    ctx.scale(s, s);
    drawStadium(ctx, this, this.outerR, 'rgba(120,185,120,0.5)');
    drawStadium(ctx, this, this.innerR, 'rgba(18,52,28,0.9)');
    ctx.fillStyle = '#f1f3f5';
    ctx.fillRect(this.finishX - 2, this.innerR, 4, this.outerR - this.innerR);
    for (var i = 0; i < this.horses.length; i++) {
      var pt = this.lanePoint(i, this.progressOf(i, time));
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.4 / s * 0.5 + 2.4, 0, Math.PI * 2);
      ctx.fillStyle = this.horses[i].color.bg;
      ctx.fill();
      ctx.lineWidth = 1 / s;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
    }
    ctx.restore();

    // 慢動作 / 白閃 / 定格字卡
    if (this._slowmo && this._freeze <= 0) {
      ctx.fillStyle = 'rgba(13,17,23,0.72)';
      roundRect(ctx, W / 2 - 110, 18, 220, 42, 10);
      ctx.fill();
      ctx.fillStyle = '#ffd43b';
      ctx.font = 'bold 22px "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📸 相片裁判！', W / 2, 47);
    }
    if (this._flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (this._flash * 0.75).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    if (this._freeze > 0) {
      var msg = this.photoFinish ? '📸 相片裁判 判定中…' : '🏁 衝線！';
      ctx.fillStyle = 'rgba(13,17,23,0.78)';
      roundRect(ctx, W / 2 - 150, 24, 300, 54, 12);
      ctx.fill();
      ctx.fillStyle = '#ffd43b';
      ctx.font = 'bold 28px "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, W / 2, 60);
    }
    ctx.textAlign = 'left';
  };

  function roundRect(ctx, x, y, w, h, r) {
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

  function drawStadium(ctx, self, r, fill) {
    var L = self.L;
    ctx.beginPath();
    ctx.moveTo(-L, -r);
    ctx.lineTo(L, -r);
    ctx.arc(L, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(-L, r);
    ctx.arc(-L, 0, r, Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  global.RaceAnimator3D = RaceAnimator3D;
})(typeof window !== 'undefined' ? window : this);
