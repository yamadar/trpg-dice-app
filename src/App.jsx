import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import * as Tone from 'tone';
import {
  DICE_TYPES, BOARD_THEMES, MATERIALS, COLOR_THEMES, SOUND_PRESETS,
  MAX_TOTAL_DICE, MAX_DICE_PER_TYPE,
} from './data/diceConfig.js';
import {
  getDiceRadius, getNumberSize, getFaceLabel, faceIndexToValue,
  decideNumberStyle, buildFormula, totalDiceCount, adjustDiceCount,
  evaluateRolls, hasCritical, hasFumble,
} from './logic/diceLogic.js';

// 盤面の物理パラメータ（クリック判定と物理シミュレーションで共有）
const BOARD_RADIUS = 5.5; // ダイスが収まる円形プレイ領域の半径
const FLOOR_Y = -0.5;     // 論理床（felt 上面と一致）

// =========================================================
// ジオメトリ
// =========================================================

function createPentagonalTrapezohedron() {
  // 正しい pentagonal trapezohedron: 10 個の kite 面が平面になる頂点配置
  // 数学的条件: e = h * (1 - cos(36°)) / (1 + cos(36°))
  // 上頂点に隣接する5頂点は y = -e（下側）、下頂点に隣接する5頂点は y = +e（上側）
  const geom = new THREE.BufferGeometry();
  const verts = [];
  const apex = 1.05;
  const r = 1.0;
  const cos36 = Math.cos(36 * Math.PI / 180);
  const e = apex * (1 - cos36) / (1 + cos36); // ≈ 0.111

  verts.push(0, apex, 0);   // 0: 上頂点
  verts.push(0, -apex, 0);  // 1: 下頂点

  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    // i%2==0 → 上頂点側kiteの「鋭頂点」(下に下がる)
    // i%2==1 → 下頂点側kiteの「鋭頂点」(上に上がる)
    const y = (i % 2 === 0) ? -e : e;
    verts.push(r * Math.cos(a), y, r * Math.sin(a));
  }

  const indices = [];
  for (let i = 0; i < 10; i++) {
    const prev = (i + 9) % 10;
    const next = (i + 1) % 10;
    if (i % 2 === 0) {
      // 上頂点側kite (apex + prev + i + next) → 対角線 apex-i で2三角に分割（CCW）
      indices.push(0, 2 + i, 2 + prev);
      indices.push(0, 2 + next, 2 + i);
    } else {
      // 下頂点側kite (bottom + i + prev + next) → 対角線 bottom-i で2三角に分割（CCW）
      indices.push(1, 2 + prev, 2 + i);
      indices.push(1, 2 + i, 2 + next);
    }
  }
  geom.setIndex(indices);
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.computeVertexNormals();
  return geom;
}

function getDiceGeometry(id) {
  switch (id) {
    case 'd4':   return new THREE.TetrahedronGeometry(1.1);
    case 'd6':   return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case 'd8':   return new THREE.OctahedronGeometry(1.1);
    case 'd10':  return createPentagonalTrapezohedron();
    case 'd100': return createPentagonalTrapezohedron();
    case 'd12':  return new THREE.DodecahedronGeometry(1.05);
    case 'd20':  return new THREE.IcosahedronGeometry(1.05);
    default:     return new THREE.BoxGeometry(1.5, 1.5, 1.5);
  }
}

// getDiceRadius / getNumberSize は ./logic/diceLogic.js に移動

// 各面の中心と法線（同方向の三角形をグループ化）
function computeFaceData(geometry, expectedFaceCount = null) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  const tris = [];
  for (let i = 0; i < triCount; i++) {
    const ia = idx ? idx.getX(i * 3)     : i * 3;
    const ib = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
    const ic = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
    const va = new THREE.Vector3().fromBufferAttribute(pos, ia);
    const vb = new THREE.Vector3().fromBufferAttribute(pos, ib);
    const vc = new THREE.Vector3().fromBufferAttribute(pos, ic);
    const center = va.clone().add(vb).add(vc).divideScalar(3);
    const cross = new THREE.Vector3()
      .subVectors(vb, va)
      .cross(new THREE.Vector3().subVectors(vc, va));
    const area = cross.length() * 0.5;
    const n = cross.normalize();
    tris.push({ center, normal: n, area });
  }

  // 法線が近い三角形をグループ化（共有面=同一向き）
  // bevel後の頂点ずれで三角形法線がわずかに傾いても同一面として扱えるよう、閾値はやや緩め
  const faces = [];
  const used = new Array(tris.length).fill(false);
  const THRESHOLD = 0.965; // acos≈15度 まで許容
  for (let i = 0; i < tris.length; i++) {
    if (used[i]) continue;
    const group = [tris[i]];
    used[i] = true;
    for (let j = i + 1; j < tris.length; j++) {
      if (used[j]) continue;
      if (tris[i].normal.dot(tris[j].normal) > THRESHOLD) {
        group.push(tris[j]);
        used[j] = true;
      }
    }
    // 面積加重で中心を計算
    const centerAvg = new THREE.Vector3();
    let totalArea = 0;
    group.forEach(t => {
      centerAvg.addScaledVector(t.center, t.area);
      totalArea += t.area;
    });
    if (totalArea > 0) centerAvg.divideScalar(totalArea);
    // 法線も面積加重で平均
    const normalAvg = new THREE.Vector3();
    group.forEach(t => normalAvg.addScaledVector(t.normal, t.area));
    normalAvg.normalize();
    faces.push({ center: centerAvg, normal: normalAvg, area: totalArea });
  }

  // 期待面数が指定されていれば、面積でソートして上位だけ返す
  // （bevel追加面=エッジベベル/頂点キャップ は面積が小さいので除外される）
  if (expectedFaceCount !== null && faces.length > expectedFaceCount) {
    faces.sort((a, b) => b.area - a.area);
    return faces.slice(0, expectedFaceCount);
  }
  return faces;
}

function createNumberTexture(text, inkColor, options = {}) {
  const { bolder = false, outlineColor = null, outlineWidth = 0 } = options;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);

  const fontSize = text.length > 1 ? 56 : 84;
  ctx.font = `bold ${fontSize}px 'Cinzel', 'Noto Serif JP', serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 縁取り：指定があれば描く（数字の周囲にコントラスト色の縁を出す）
  if (outlineColor && outlineWidth > 0) {
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeText(text, 64, 70);
  }

  // 太字化用ストローク（インク色で太く描いてから fill）
  if (bolder) {
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = text.length > 1 ? 6 : 9;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeText(text, 64, 70);
  }

  ctx.fillStyle = inkColor;
  ctx.fillText(text, 64, 70);

  // 6 と 9 区別用アンダーバー
  if (text === '6' || text === '9') {
    const barH = bolder ? 6 : 4;
    const barW = bolder ? 40 : 32;
    // 縁取りも入れる
    if (outlineColor && outlineWidth > 0) {
      ctx.fillStyle = outlineColor;
      const pad = Math.ceil(outlineWidth / 2);
      ctx.fillRect(64 - barW / 2 - pad, 116 - pad, barW + pad * 2, barH + pad * 2);
    }
    ctx.fillStyle = inkColor;
    ctx.fillRect(64 - barW / 2, 116, barW, barH);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// _colorLuminance / decideNumberStyle / getFaceLabel は ./logic/diceLogic.js に移動

// 上面（最も +Y を向いている面）の index を取得
function findTopFaceIndex(mesh, faces) {
  let bestDot = -Infinity;
  let bestIdx = 0;
  for (let i = 0; i < faces.length; i++) {
    const nWorld = faces[i].normal.clone().applyQuaternion(mesh.quaternion);
    if (nWorld.y > bestDot) {
      bestDot = nWorld.y;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// faceIndexToValue は ./logic/diceLogic.js に移動

// 重複を排除したローカル頂点配列（物理計算用）
function extractUniqueVertices(geometry) {
  const pos = geometry.attributes.position;
  const seen = new Map();
  const verts = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      verts.push(v);
    }
  }
  return verts;
}

// =========================================================
// 頂点を滑らかに見せる（smooth shading 化）
// 元のサイコロのジオメトリは保ったまま、同位置の頂点インスタンスを
// 共有化して頂点法線を平均化。flatShading: false の material と
// 組み合わせることで、頂点付近で法線が補間され視覚的に丸く見える。
// 面の中央は対称性によって各頂点法線の平均が元の面法線と一致する
// ため、フラット感を保つ（サイコロらしさは失われない）。
// =========================================================
function smoothDiceGeometry(geom) {
  const pos = geom.attributes.position;
  const hasIndex = geom.index !== null;
  const oldIndices = hasIndex
    ? Array.from(geom.index.array)
    : Array.from({ length: pos.count }, (_, i) => i);

  // 同じ位置の頂点を 1 つのインデックスに統合
  const tolerance = 0.001;
  const keyOf = (x, y, z) =>
    `${Math.round(x / tolerance)}_${Math.round(y / tolerance)}_${Math.round(z / tolerance)}`;

  const newVerts = [];
  const remap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = keyOf(x, y, z);
    if (!remap.has(key)) {
      remap.set(key, newVerts.length / 3);
      newVerts.push(x, y, z);
    }
  }

  const newIndices = [];
  for (let i = 0; i < oldIndices.length; i++) {
    const oldIdx = oldIndices[i];
    const x = pos.getX(oldIdx), y = pos.getY(oldIdx), z = pos.getZ(oldIdx);
    newIndices.push(remap.get(keyOf(x, y, z)));
  }

  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute('position', new THREE.Float32BufferAttribute(newVerts, 3));
  newGeom.setIndex(newIndices);
  // 共有頂点なので、各頂点法線は接続する全三角形の法線の平均になる
  newGeom.computeVertexNormals();
  return newGeom;
}

// =========================================================
// レジン内包物：透明な樹脂の中で色が渦巻き光を反射するような表現
// 小さな球体と細長い薄板を内部に配置、それぞれ emissive を持つ
// =========================================================
function createResinInclusions(diceRadius, colorTheme) {
  const inclusions = [];
  const innerR = diceRadius * 0.55; // 内部の有効半径

  const primary   = new THREE.Color(colorTheme.primary);
  const secondary = new THREE.Color(colorTheme.secondary);
  const emissiveCol = new THREE.Color(colorTheme.emissive);

  // 1. 中心に大きめの渦巻き状の薄い面（色の主体）
  //    複数の細長い PlaneGeometry を放射状に配置
  const swirlCount = 7;
  for (let i = 0; i < swirlCount; i++) {
    const w = innerR * (1.2 + Math.random() * 0.5);
    const h = innerR * (0.15 + Math.random() * 0.2);
    const plane = new THREE.PlaneGeometry(w, h);
    const color = i % 2 === 0 ? primary.clone() : secondary.clone();
    color.lerp(emissiveCol, 0.4); // emissive 寄りに
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(plane, mat);
    // ランダム回転＆位置
    m.rotation.x = Math.random() * Math.PI * 2;
    m.rotation.y = Math.random() * Math.PI * 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    const offR = innerR * 0.25 * Math.random();
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    m.position.set(
      offR * Math.sin(phi) * Math.cos(theta),
      offR * Math.sin(phi) * Math.sin(theta),
      offR * Math.cos(phi)
    );
    m.userData.spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    m.userData.spinSpeed = (Math.random() - 0.5) * 0.6; // 緩いアニメ
    inclusions.push(m);
  }

  // 2. 小さな光の粒（金属粉のような点光源）を散在
  const sparkleCount = 18;
  for (let i = 0; i < sparkleCount; i++) {
    const r = innerR * (0.05 + Math.random() * 0.06);
    const sphere = new THREE.SphereGeometry(r, 6, 5);
    const color = Math.random() < 0.5 ? primary.clone() : secondary.clone();
    color.lerp(new THREE.Color(0xffffff), 0.3);
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(sphere, mat);
    const offR = innerR * (0.3 + Math.random() * 0.55);
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    m.position.set(
      offR * Math.sin(phi) * Math.cos(theta),
      offR * Math.sin(phi) * Math.sin(theta),
      offR * Math.cos(phi)
    );
    m.userData.sparkle = true; // アニメ用フラグ
    m.userData.sparkleOffset = Math.random() * Math.PI * 2;
    m.userData.sparkleSpeed = 1.5 + Math.random() * 2.5;
    inclusions.push(m);
  }

  return inclusions;
}

// =========================================================
// 宝石用キラキラインクルージョン
// 内部にカット面風の薄板と多数のスパークル光を配置
// レジンより光が強く、より色彩豊か（プリズム的）
// =========================================================
function createGemstoneSparkles(diceRadius, colorTheme) {
  const inclusions = [];
  const innerR = diceRadius * 0.60;

  const primary   = new THREE.Color(colorTheme.primary);
  const secondary = new THREE.Color(colorTheme.secondary);
  const emissive  = new THREE.Color(colorTheme.emissive);

  // 1. カット面風の薄い平面（光を屈折させる「ファセット」を模す）
  // 大きさ違いで複数配置
  const facetCount = 12;
  for (let i = 0; i < facetCount; i++) {
    const w = innerR * (0.8 + Math.random() * 0.8);
    const h = innerR * (0.5 + Math.random() * 0.5);
    const plane = new THREE.PlaneGeometry(w, h);
    // 色：primary と secondary を補間 + 明るく
    const color = primary.clone().lerp(secondary, Math.random());
    color.lerp(new THREE.Color(0xffffff), 0.45); // 白寄り = 強い光
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(plane, mat);
    m.rotation.x = Math.random() * Math.PI * 2;
    m.rotation.y = Math.random() * Math.PI * 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    const offR = innerR * 0.30 * Math.random();
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    m.position.set(
      offR * Math.sin(phi) * Math.cos(theta),
      offR * Math.sin(phi) * Math.sin(theta),
      offR * Math.cos(phi)
    );
    m.userData.spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    m.userData.spinSpeed = (Math.random() - 0.5) * 0.9; // やや速め
    inclusions.push(m);
  }

  // 2. 大きめの輝点（プリズム反射光）
  const bigSparkleCount = 8;
  for (let i = 0; i < bigSparkleCount; i++) {
    const r = innerR * (0.10 + Math.random() * 0.08);
    // 4面体で「カット」感
    const sphere = new THREE.TetrahedronGeometry(r, 0);
    const color = new THREE.Color(0xffffff).lerp(
      Math.random() < 0.5 ? primary : secondary, 0.25
    );
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(sphere, mat);
    const offR = innerR * (0.35 + Math.random() * 0.45);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    m.position.set(
      offR * Math.sin(phi) * Math.cos(theta),
      offR * Math.sin(phi) * Math.sin(theta),
      offR * Math.cos(phi)
    );
    // ゆっくり回転 + 強い点滅
    m.userData.sparkle = true;
    m.userData.sparkleOffset = Math.random() * Math.PI * 2;
    m.userData.sparkleSpeed = 2.0 + Math.random() * 3.0;
    m.userData.spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    m.userData.spinSpeed = 0.8 + Math.random() * 1.5;
    inclusions.push(m);
  }

  // 3. 細かい星屑（小さな白い点が多数キラキラ）
  const dustCount = 40;
  for (let i = 0; i < dustCount; i++) {
    const r = innerR * (0.03 + Math.random() * 0.04);
    const sphere = new THREE.SphereGeometry(r, 5, 4);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(sphere, mat);
    const offR = innerR * (0.25 + Math.random() * 0.65);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    m.position.set(
      offR * Math.sin(phi) * Math.cos(theta),
      offR * Math.sin(phi) * Math.sin(theta),
      offR * Math.cos(phi)
    );
    m.userData.sparkle = true;
    m.userData.sparkleOffset = Math.random() * Math.PI * 2;
    // 速い点滅でキラキラ感
    m.userData.sparkleSpeed = 3.0 + Math.random() * 5.0;
    inclusions.push(m);
  }

  return inclusions;
}

// =========================================================
// Contact Shadow（フロスト用の擬似柔影）
// 放射状グラデーションを Canvas で生成、半透明の Plane に貼って
// ダイスの真下に配置。シャドウマップとは独立した「常に柔らかい影」。
// =========================================================
function createSoftShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  // 中心が黒で外周に向かって透明になる放射状グラデ
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
  grad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.4, 'rgba(0,0,0,0.30)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.10)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createContactShadow(diceRadius) {
  const tex = createSoftShadowTexture();
  // ダイスの直径の 2.2倍の Plane（影が外まで広がるように）
  const size = diceRadius * 2.2 * 2;
  const geom = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  // 床に水平に配置（XZ 平面）
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.49; // 床(-0.5)のわずかに上で z-fight 回避
  mesh.renderOrder = 1; // 他の透明物体より前に描画
  return mesh;
}

// =========================================================
// 木目テクスチャ生成
// 自然な木目：歪んだ年輪パターン + 細かい繊維方向のノイズ
// RGB のグレースケールで出力（map は乗算合成、白=ベース色そのまま）
// =========================================================
function createWoodGrainTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 簡易ノイズ関数（2D値ノイズ風）
  // grid に乱数を置き、補間でなめらかなノイズを作る
  const noiseSeed = Math.random() * 1000;
  function smoothNoise(x, y, freq) {
    const sx = x * freq + noiseSeed;
    const sy = y * freq + noiseSeed * 0.7;
    const ix = Math.floor(sx), iy = Math.floor(sy);
    const fx = sx - ix, fy = sy - iy;
    const hash = (i, j) => {
      const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const a = hash(ix, iy), b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    // smoothstep 補間
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy)
         + c * (1 - ux) * uy        + d * ux * uy;
  }
  // 複数オクターブの fBm（自然な揺らぎ）
  function fbm(x, y, octaves) {
    let total = 0, amp = 1, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
      total += smoothNoise(x, y, freq) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2.2;
    }
    return total / max;
  }

  // 木の中心軸：パターンの「年輪の中心」となる擬似中心
  // 中心はテクスチャの外側に置くことで、表示範囲内では「同心円の一部」に見える
  const centerX = -W * (0.3 + Math.random() * 0.4);
  const centerY = H * (0.2 + Math.random() * 0.6);

  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;

      // 中心からの距離（年輪の半径）
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 距離に fBm ノイズを加えて年輪を歪ませる
      // ノイズの周波数を低めにして大きな歪み、振幅を大きく
      const distortion = (fbm(x * 0.008, y * 0.008, 4) - 0.5) * 90;
      const ringPos = (dist + distortion) * 0.18; // 年輪の周期

      // 年輪：sin で周期的、累乗で線を細く尖らせる
      let ring = Math.sin(ringPos);
      ring = Math.pow(Math.max(0, ring), 4); // 0..1 にクランプ、上を尖らせる

      // 繊維方向の細かいノイズ（径方向に伸びた縞）
      const angle = Math.atan2(dy, dx);
      const fiber = fbm(angle * 30 + dist * 0.02, dist * 0.5, 3);
      const fiberStreak = Math.pow(fiber, 1.8) * 0.25;

      // 中間の太い波（粗い濃淡）
      const broad = fbm(x * 0.004, y * 0.004, 2) * 0.18;

      // 全体合成：1.0 を基準に暗くしていく
      // ring=1で大きく暗く、繊維と粗い濃淡が中間色を作る
      let v = 1.0 - ring * 0.55 - fiberStreak - broad * 0.5;
      v = Math.max(0.25, Math.min(1.0, v));

      const g = Math.round(v * 255);
      // わずかに赤茶寄りに（純グレーより温かみ）
      data[idx]     = Math.min(255, g + 6);
      data[idx + 1] = g;
      data[idx + 2] = Math.max(0, g - 8);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 節（knot）を 0〜2 個ランダム追加
  const knotCount = Math.floor(Math.random() * 3);
  for (let k = 0; k < knotCount; k++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 8 + Math.random() * 12;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(40, 22, 10, 0.7)');
    grad.addColorStop(0.5, 'rgba(60, 35, 18, 0.4)');
    grad.addColorStop(1, 'rgba(60, 35, 18, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// =========================================================
// 盤面テクスチャ生成（各 boardTheme 用）
// 共通：2D値ノイズと fBm を使った手続き生成
// =========================================================
function _makeNoiseFns(seedOffset = 0) {
  const seed = Math.random() * 1000 + seedOffset;
  function smoothNoise(x, y, freq) {
    const sx = x * freq + seed, sy = y * freq + seed * 0.7;
    const ix = Math.floor(sx), iy = Math.floor(sy);
    const fx = sx - ix, fy = sy - iy;
    const hash = (i, j) => {
      const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const a = hash(ix, iy), b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy)
         + c * (1 - ux) * uy        + d * ux * uy;
  }
  function fbm(x, y, octaves) {
    let total = 0, amp = 1, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
      total += smoothNoise(x, y, freq) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2.2;
    }
    return total / max;
  }
  return { smoothNoise, fbm };
}

// オーク卓：オレンジがかった茶色ベース、木目はそれより少し暗い茶色
function createOakBoardTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { fbm } = _makeNoiseFns();
  // 中心を盤面外側に置いて緩い同心円に
  const cx = -W * 0.5, cy = H * 0.5;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  // オークのベース色（暖色照明とトーンマッピング補正済み）
  // 出力時に #825104 寄りに見えるよう、入力色を逆補正
  // base:  RGB(120, 65, 30)  G/B を抑えオレンジを正確に
  // grain: RGB(60, 30, 12)   暗茶
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const distortion = (fbm(x * 0.006, y * 0.006, 4) - 0.5) * 80;
      const ringPos = (dist + distortion) * 0.10;
      let ring = Math.sin(ringPos);
      ring = Math.pow(Math.max(0, ring), 3.5);
      const broad = (fbm(x * 0.003, y * 0.003, 3) - 0.5) * 0.30;
      const fine = (fbm(x * 0.05, y * 0.02, 2) - 0.5) * 0.18;
      // mix: 0=ベース色, 1=木目色（暗茶）
      let mix = ring * 0.78 + Math.max(0, broad) * 0.5;
      mix = Math.max(0, Math.min(1, mix));
      // 個々のピクセルで明度を少し揺らす（板の質感）
      const lightness = 1.0 + fine;
      const r = (120 * (1 - mix) + 60 * mix) * lightness;
      const g = (65  * (1 - mix) + 30 * mix) * lightness;
      const b = (30  * (1 - mix) + 12 * mix) * lightness;
      data[idx]     = Math.max(0, Math.min(255, Math.round(r)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 大理石：白ベースに脈状のマーブル模様
function createMarbleTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { fbm } = _makeNoiseFns();
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      // ターブレンス効果：座標を歪ませて sin を取る
      const tx = fbm(x * 0.006, y * 0.006, 5) * 6;
      const ty = fbm(x * 0.006, y * 0.006 + 100, 5) * 6;
      // 大理石の脈：sin(x + ノイズ) で帯を作る、累乗で線を細く
      const vein = Math.abs(Math.sin((x * 0.012 + ty) * Math.PI));
      const veinThin = Math.pow(1 - vein, 8);
      // 細かい粒状ノイズ
      const grain = fbm(x * 0.03, y * 0.03, 3);
      // 全体明度
      const baseLight = 0.86 + grain * 0.10;
      const v = Math.max(0.5, Math.min(1.0, baseLight - veinThin * 0.35));
      // わずかに灰色寄り（純白でない）
      data[idx]     = Math.round(v * 240);
      data[idx + 1] = Math.round(v * 235);
      data[idx + 2] = Math.round(v * 222);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 一段濃い脈を1〜2本上書き
  const veinCount = 2 + Math.floor(Math.random() * 2);
  for (let v = 0; v < veinCount; v++) {
    ctx.strokeStyle = `rgba(80, 75, 70, ${0.15 + Math.random() * 0.10})`;
    ctx.lineWidth = 0.8 + Math.random() * 1.2;
    ctx.beginPath();
    let cx = Math.random() * W;
    let cy = Math.random() * H;
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 200; s++) {
      cx += (Math.random() - 0.5) * 18;
      cy += (Math.random() - 0.5) * 18;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 虚空：黒地に星々
function createVoidStarsTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // 深い紫がかった黒のグラデ
  const grad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.7);
  grad.addColorStop(0, '#1a0a2e');
  grad.addColorStop(0.6, '#0a0518');
  grad.addColorStop(1, '#000005');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 銀河の薄い帯
  ctx.save();
  ctx.translate(W/2, H/2);
  ctx.rotate(Math.PI * 0.2);
  const bandGrad = ctx.createLinearGradient(-W, 0, W, 0);
  bandGrad.addColorStop(0, 'rgba(80, 60, 130, 0)');
  bandGrad.addColorStop(0.5, 'rgba(120, 80, 160, 0.18)');
  bandGrad.addColorStop(1, 'rgba(80, 60, 130, 0)');
  ctx.fillStyle = bandGrad;
  ctx.fillRect(-W, -H*0.15, W*2, H*0.3);
  ctx.restore();
  // 星々
  const starCount = 350;
  for (let i = 0; i < starCount; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = Math.random() < 0.85 ? 0.5 + Math.random() * 0.8
                                   : 1.0 + Math.random() * 1.8;
    const brightness = 0.5 + Math.random() * 0.5;
    // 色のバリエーション（白/青/橙）
    const tint = Math.random();
    let r2, g, b;
    if (tint < 0.7) { r2 = 255; g = 250; b = 230; }
    else if (tint < 0.9) { r2 = 200; g = 220; b = 255; }
    else { r2 = 255; g = 200; b = 150; }
    ctx.fillStyle = `rgba(${r2}, ${g}, ${b}, ${brightness})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 大きい星はハロー
    if (r > 1.2) {
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      halo.addColorStop(0, `rgba(${r2}, ${g}, ${b}, ${brightness * 0.3})`);
      halo.addColorStop(1, `rgba(${r2}, ${g}, ${b}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 星雲のかすかな雲
  const nebulaCount = 3;
  for (let i = 0; i < nebulaCount; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 60 + Math.random() * 80;
    const hue = ['rgba(120, 60, 180,', 'rgba(60, 100, 180,', 'rgba(180, 80, 120,'][i % 3];
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    halo.addColorStop(0, hue + '0.12)');
    halo.addColorStop(0.6, hue + '0.05)');
    halo.addColorStop(1, hue + '0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// 洞窟：ゴツゴツした岩肌
function createCavernRockTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { fbm } = _makeNoiseFns();
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      // 大きな岩塊
      const big = fbm(x * 0.012, y * 0.012, 5);
      // 中サイズの凹凸
      const mid = fbm(x * 0.04, y * 0.04, 4);
      // 細かい粒子
      const fine = fbm(x * 0.15, y * 0.15, 2);
      // ハードエッジ感を出すため累乗で歪ませる
      const combined = big * 0.55 + mid * 0.30 + fine * 0.15;
      // コントラスト強めて岩感
      let v = Math.pow(combined, 1.3);
      v = Math.max(0.10, Math.min(0.55, v));
      // 暗い茶+グレー混じり
      data[idx]     = Math.round(v * 145);
      data[idx + 1] = Math.round(v * 110);
      data[idx + 2] = Math.round(v * 85);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 亀裂をいくつか
  for (let c = 0; c < 12; c++) {
    ctx.strokeStyle = `rgba(15, 10, 5, ${0.4 + Math.random() * 0.3})`;
    ctx.lineWidth = 0.6 + Math.random() * 0.8;
    ctx.beginPath();
    let x = Math.random() * W, y = Math.random() * H;
    const segs = 10 + Math.floor(Math.random() * 15);
    ctx.moveTo(x, y);
    let ang = Math.random() * Math.PI * 2;
    for (let s = 0; s < segs; s++) {
      ang += (Math.random() - 0.5) * 1.2;
      x += Math.cos(ang) * (4 + Math.random() * 8);
      y += Math.sin(ang) * (4 + Math.random() * 8);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 古地図：古紙の質感
function createParchmentTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { fbm } = _makeNoiseFns();
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      // 紙の繊維と汚れの濃淡
      const stain = fbm(x * 0.008, y * 0.008, 4);
      const fiber = fbm(x * 0.06, y * 0.06, 3);
      const fine = (Math.random() - 0.5) * 0.05;
      // 古い羊皮紙の色（明るい黄褐色）
      const v = 0.72 + stain * 0.20 - fiber * 0.10 + fine;
      const clamped = Math.max(0.45, Math.min(0.95, v));
      data[idx]     = Math.round(clamped * 230);
      data[idx + 1] = Math.round(clamped * 200);
      data[idx + 2] = Math.round(clamped * 140);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 染みを数個
  for (let s = 0; s < 8; s++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 15 + Math.random() * 35;
    const a = 0.08 + Math.random() * 0.15;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(100, 65, 25, ${a})`);
    grad.addColorStop(1, 'rgba(100, 65, 25, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 折り目線
  for (let f = 0; f < 3; f++) {
    ctx.strokeStyle = 'rgba(80, 55, 25, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const y = Math.random() * H;
    ctx.moveTo(0, y + (Math.random() - 0.5) * 4);
    ctx.lineTo(W, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// 戦場：芝生のような濃緑、葉の細い縞 + 土・パッチ
function createBattlefieldTexture() {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { fbm } = _makeNoiseFns();
  const img = ctx.createImageData(W, H);
  const data = img.data;
  // 芝の色プリセット（暗緑〜やや明るい緑）
  // 個々のピクセルでこの範囲内をランダムに
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      // 大きな地形の起伏（暗パッチと明パッチ）
      const big = fbm(x * 0.006, y * 0.006, 3);
      // 草の縦長テクスチャ（y方向高周波で「縦に伸びた草の葉」感）
      const bladeY = fbm(x * 0.25, y * 0.9, 2);
      // 細かい色のばらつき
      const grain = fbm(x * 0.5, y * 0.5, 2);
      // 葉の縞： bladeY が中心付近で「縞」、外れると暗くなる
      const blade = Math.pow(Math.abs(bladeY - 0.5) * 2, 2.0); // 0(縞中心)〜1(縞間)
      // 明度（0.5〜0.95）：縞のときに明、縞間で暗、地形起伏で全体変動
      const lightness = 0.55 + (1 - blade) * 0.30 + (big - 0.5) * 0.18 + (grain - 0.5) * 0.10;
      const clamped = Math.max(0.30, Math.min(1.0, lightness));
      // 緑の色相を微変動（黄緑〜青緑）
      const hueShift = (grain - 0.5) * 0.4;
      // ベース色（鮮やかな草緑 RGB 45, 110, 28）に変動を加える
      const r = 45 * clamped * (1 - hueShift * 0.3);
      const g = 110 * clamped * (1 + hueShift * 0.15);
      const b = 28 * clamped * (1 + hueShift * 0.4);
      data[idx]     = Math.max(0, Math.min(255, Math.round(r)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 散在する暗いパッチ（踏み倒された草、土の露出）
  for (let p = 0; p < 18; p++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 10 + Math.random() * 28;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    // 土色（茶系）
    grad.addColorStop(0, 'rgba(60, 40, 20, 0.45)');
    grad.addColorStop(1, 'rgba(60, 40, 20, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 明るい草の塊（黄緑の小さな塊）数個
  for (let p = 0; p < 12; p++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 6 + Math.random() * 14;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(110, 145, 45, 0.30)');
    grad.addColorStop(1, 'rgba(110, 145, 45, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// boardTheme から適切なテクスチャを取得
function createBoardTexture(themeKey) {
  switch (themeKey) {
    case 'oak':       return createOakBoardTexture();
    case 'marble':    return createMarbleTexture();
    case 'void':      return createVoidStarsTexture();
    case 'cavern':    return createCavernRockTexture();
    case 'parchment': return createParchmentTexture();
    case 'battle':    return createBattlefieldTexture();
    default:          return null;
  }
}

// =========================================================
// サウンド
// =========================================================
// =========================================================
// 物理ベースのモーダル合成サウンド
// 各素材の共鳴周波数・減衰時間を実物理から取った値で再現
// =========================================================

class DiceSound {
  constructor() {
    this.ready = false;
    this.ctx = null;
    this.master = null;
    this.noiseBuffers = {};
  }

  async init() {
    if (this.ready) return;
    await Tone.start();
    this.ctx = Tone.getContext().rawContext;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.1;

    const reverbBuf = this.makeImpulseResponse(0.35, 1.5);
    const convolver = this.ctx.createConvolver();
    convolver.buffer = reverbBuf;
    const dry = this.ctx.createGain();
    dry.gain.value = 0.88;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.12;

    this.master.connect(compressor);
    compressor.connect(dry).connect(this.ctx.destination);
    compressor.connect(convolver).connect(wet).connect(this.ctx.destination);

    this.noiseBuffers.white = this.makeNoiseBuffer('white', 0.06);
    this.noiseBuffers.brown = this.makeNoiseBuffer('brown', 0.06);
    this.noiseBuffers.pink  = this.makeNoiseBuffer('pink',  0.06);

    this.ready = true;
  }

  makeImpulseResponse(duration, decay) {
    const sr = this.ctx.sampleRate;
    const len = Math.ceil(sr * duration);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  makeNoiseBuffer(type, duration) {
    const sr = this.ctx.sampleRate;
    const len = Math.ceil(sr * duration);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    if (type === 'white') {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else if (type === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
    } else if (type === 'pink') {
      let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886*b0 + w*0.0555179;
        b1 = 0.99332*b1 + w*0.0750759;
        b2 = 0.96900*b2 + w*0.1538520;
        b3 = 0.86650*b3 + w*0.3104856;
        b4 = 0.55000*b4 + w*0.5329522;
        b5 = -0.7616*b5 - w*0.0168980;
        data[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
        b6 = w*0.115926;
      }
    }
    return buf;
  }

  // 単一モード（共鳴）を再生
  playMode(freq, decay, amp, startTime) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(amp, startTime + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);

    osc.connect(gain).connect(this.master);
    osc.start(startTime);
    osc.stop(startTime + decay + 0.05);
  }

  playNoiseBurst(type, decay, amp, filterFreq, filterQ, startTime) {
    const buf = this.noiseBuffers[type];
    if (!buf) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(amp, startTime + 0.0005);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);

    noise.connect(filter).connect(gain).connect(this.master);
    noise.start(startTime);
    noise.stop(startTime + decay + 0.05);
  }

  /**
   * 物理衝突に基づくヒット音
   * @param {string} material プリセット名
   * @param {number} impulse 衝突インパルスの大きさ（0..2.5 程度）
   */
  hit(material, impulse = 1) {
    if (!this.ready) return;
    const preset = SOUND_PRESETS[material] || SOUND_PRESETS.plastic;
    const now = this.ctx.currentTime + 0.001;

    // インパルスを 0..2.5 にクランプ
    const rawV = Math.max(0.01, Math.min(impulse, 2.5));
    // power 1.8 の convex 曲線：強い衝突だけが目立ち、弱い衝突は控えめに
    //   rawV 2.5 → v=1.0 (最大), 1.0 → v=0.19, 0.5 → v=0.055
    const v = Math.pow(rawV / 2.5, 1.8);

    // ピッチ：弱い衝突はやや低く、強い衝突は +35% まで
    const pitchShift = 0.92 + v * 0.43;
    // 音量：base を下げ、強衝突との差を強調
    //   v=0.055 → ampScale ≒ 0.13、v=1.0 → ampScale ≒ 1.60
    const ampScale = preset.gain * (0.03 + v * 1.57);
    // 減衰：弱い衝突は短く、強い衝突はしっかり響く
    const decayScale = 0.22 + v * 1.18;

    preset.modes.forEach(m => {
      const fJitter = m.freq * pitchShift * (0.96 + Math.random() * 0.08);
      const dJitter = m.decay * decayScale * (0.85 + Math.random() * 0.3);
      this.playMode(fJitter, dJitter, m.amp * ampScale, now);
    });

    if (preset.noise) {
      const n = preset.noise;
      const nv = n.amp * ampScale * (0.7 + Math.random() * 0.4);
      this.playNoiseBurst(n.type, n.decay * decayScale, nv,
        n.filterFreq * (0.75 + v * 0.55), n.filterQ, now);
    }
  }

  /**
   * 2素材の混合ヒット（例: ダイス×床）
   * 主素材100%, 副素材55%
   */
  hitMixed(primary, secondary, impulse = 1) {
    this.hit(primary, impulse);
    this.hit(secondary, impulse * 0.55);
  }

  fanfare() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      this.playMode(freq, 0.5, 0.25, now + i * 0.08);
      this.playMode(freq * 2, 0.4, 0.12, now + i * 0.08);
    });
    setTimeout(() => {
      const t = this.ctx.currentTime;
      const high = [1318.5, 1568.0, 1975.5, 2093.0];
      high.forEach((f, i) => this.playMode(f, 0.35, 0.15, t + i * 0.06));
    }, 320);
  }
}

// =========================================================
// メイン
// =========================================================

const randomKey = (obj) => {
  const keys = Object.keys(obj);
  return keys[Math.floor(Math.random() * keys.length)];
};

export default function TRPGDiceRoller() {
  const [diceCounts, setDiceCounts] = useState({ d4:0, d6:0, d8:0, d10:0, d100:0, d12:0, d20:1 });
  const [modifier, setModifier] = useState(0);
  const [material, setMaterial] = useState(() => randomKey(MATERIALS));
  const [colorTheme, setColorTheme] = useState(() => randomKey(COLOR_THEMES));
  const [boardTheme, setBoardTheme] = useState(() => randomKey(BOARD_THEMES));
  const [isRolling, setIsRolling] = useState(false);
  const [results, setResults] = useState(null);
  const [history, setHistory] = useState([]);
  const [soundOn, setSoundOn] = useState(true);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < 768
  );

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // モバイル切替時はドロワー閉じる
      if (mobile) {
        setLeftOpen(false);
        setRightOpen(false);
      }
    };
    window.addEventListener('resize', onResize);
    // 初回モバイルだったらパネル閉じる
    if (window.innerWidth < 768) {
      setLeftOpen(false);
      setRightOpen(false);
    }
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const diceMeshesRef = useRef([]);
  const animFrameRef = useRef(null);
  const soundRef = useRef(new DiceSound());
  const boardRef = useRef(null);
  const wasRollingRef = useRef(false);
  const onRollCompleteRef = useRef(null);
  const rollStartTimeRef = useRef(0);
  const dropPointRef = useRef(null); // 盤面タップで指定された落下位置 {x,z}（1回限り）
  const prevAppearanceRef = useRef(null); // 直前の素材・色テーマ（差分更新の判定用）
  // 物理ループから読む（state変更でも最新値を参照）
  const soundOnRef = useRef(true);
  const materialSoundRef = useRef('resin');
  const boardSoundRef = useRef('wood_table');

  const board = BOARD_THEMES[boardTheme];
  const mat = MATERIALS[material];
  const col = COLOR_THEMES[colorTheme];

  const formula = buildFormula(diceCounts, modifier);

  const totalDice = totalDiceCount(diceCounts);

  // === Three.js セットアップ ===
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const w = mount.clientWidth, h = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(board.vignette, 8, 22);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(0, 8, 7.5);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ライト（環境マップなしで全方位を照らす）
    const amb = new THREE.AmbientLight(0xfff5d0, 0.65);
    scene.add(amb);
    // 半球光: 上=暖色金、下=暗茶 — 環境マップ代わりの間接光
    const hemi = new THREE.HemisphereLight(0xffd890, 0x3a2818, 0.6);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 11, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.bias = -0.0005;
    // 影を柔らかく：PCFSoftShadowMap でのブラー半径とサンプル数を増やす
    key.shadow.radius = 8;
    key.shadow.blurSamples = 25;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffb066, 0.65);
    rim.position.set(-6, 4, -4);
    scene.add(rim);
    const accent = new THREE.PointLight(0xffd07a, 0.8, 14);
    accent.position.set(0, 5, 3);
    scene.add(accent);
    const fill = new THREE.DirectionalLight(0xa090c0, 0.3);
    fill.position.set(0, -3, 5);
    scene.add(fill);

    // ボード
    const boardGroup = new THREE.Group();
    const feltGeom = new THREE.CircleGeometry(6.2, 64);
    const boardTex = createBoardTexture(boardTheme);
    if (boardTex) {
      // タイリングしない：CircleGeometry の UV に 1枚そのまま貼る（継ぎ目防止）
      boardTex.wrapS = THREE.ClampToEdgeWrapping;
      boardTex.wrapT = THREE.ClampToEdgeWrapping;
    }
    const feltMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, // テクスチャを使うので白（テクスチャ色をそのまま反映）
      map: boardTex,
      roughness: 0.92,
      metalness: 0.0,
    });
    const felt = new THREE.Mesh(feltGeom, feltMat);
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = -0.5;
    felt.receiveShadow = true;
    boardGroup.add(felt);

    const edgeGeom = new THREE.TorusGeometry(6.2, 0.3, 16, 64);
    const edgeMat = new THREE.MeshStandardMaterial({ color: board.edge, roughness: 0.55, metalness: 0.3 });
    const edge = new THREE.Mesh(edgeGeom, edgeMat);
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = -0.45;
    edge.castShadow = true;
    boardGroup.add(edge);

    const ringGeom = new THREE.RingGeometry(4.8, 4.9, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: board.glow, transparent: true, opacity: 0.35, side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.499;
    boardGroup.add(ring);

    scene.add(boardGroup);
    boardRef.current = boardGroup;

    // 星空（void テーマ）
    if (boardTheme === 'void') {
      const starGeom = new THREE.BufferGeometry();
      const starVerts = [];
      for (let i = 0; i < 400; i++) {
        starVerts.push((Math.random() - 0.5) * 60, Math.random() * 30 - 5, (Math.random() - 0.5) * 60);
      }
      starGeom.setAttribute('position', new THREE.Float32BufferAttribute(starVerts, 3));
      const stars = new THREE.Points(starGeom, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.08, transparent: true, opacity: 0.7
      }));
      scene.add(stars);
    }

    rebuildDice(scene);
    prevAppearanceRef.current = { material, colorTheme };

    // === アニメーションループ ===
    const clock = new THREE.Clock();
    const GRAVITY = 26;
    const UP = new THREE.Vector3(0, 1, 0);
    const floorClampVec = new THREE.Vector3(); // 床めり込み補正用の作業ベクトル

    const animate = () => {
      const dt = Math.min(clock.getDelta(), 0.033);

      // === フェーズ1: 各ダイスの物理 ===
      diceMeshesRef.current.forEach(d => {
        if (!d.physics.rolling) return;

        // 重力
        d.physics.velocity.y -= GRAVITY * dt;

        // 並進積分
        d.mesh.position.x += d.physics.velocity.x * dt;
        d.mesh.position.y += d.physics.velocity.y * dt;
        d.mesh.position.z += d.physics.velocity.z * dt;

        // 回転積分（クォータニオン）
        const angMag = Math.sqrt(
          d.physics.angVel.x ** 2 + d.physics.angVel.y ** 2 + d.physics.angVel.z ** 2
        );
        if (angMag > 0.0001) {
          const ax = d.physics.angVel.x / angMag;
          const ay = d.physics.angVel.y / angMag;
          const az = d.physics.angVel.z / angMag;
          const dq = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(ax, ay, az), angMag * dt
          );
          d.mesh.quaternion.premultiply(dq);
        }

        // === 多面体の床衝突 ===
        // ローカル頂点をワールドに変換、最低点を探す
        let minY = Infinity;
        const worldVerts = [];
        for (const lv of d.localVerts) {
          const wv = lv.clone().applyQuaternion(d.mesh.quaternion).add(d.mesh.position);
          worldVerts.push(wv);
          if (wv.y < minY) minY = wv.y;
        }
        // 接地している頂点（最低点とほぼ同じ高さの集合）を抽出
        const TOL = 0.025;
        const contacts = worldVerts.filter(v => v.y < minY + TOL);

        if (minY < FLOOR_Y) {
          // めり込み修正
          const pen = FLOOR_Y - minY;
          d.mesh.position.y += pen;
          // 接触点も同じだけ上にシフト
          contacts.forEach(c => { c.y += pen; });

          // 接触点の平均（複数頂点接地時は安定）
          const cc = new THREE.Vector3();
          contacts.forEach(c => cc.add(c));
          cc.divideScalar(contacts.length);

          // 中心から接触点への相対ベクトル
          const r = cc.clone().sub(d.mesh.position);

          // 接触点の速度: v + ω × r
          const omegaCrossR = new THREE.Vector3().crossVectors(d.physics.angVel, r);
          const contactVel = new THREE.Vector3().addVectors(d.physics.velocity, omegaCrossR);

          // 床法線は +Y。法線方向速度
          const vn = contactVel.y;

          // 慣性モーメント近似（剛体球的）
          const I = 0.5;

          if (vn < 0) {
            // 反発インパルス
            const restitution = contacts.length >= 3 ? 0.18 : 0.34;
            const denom = 1 + (r.x * r.x + r.z * r.z) / I;
            const j = -(1 + restitution) * vn / denom;
            // 並進応答（法線=+Y方向のみ）
            d.physics.velocity.y += j;
            // 角速度応答
            d.physics.angVel.x += (-r.z * j) / I;
            d.physics.angVel.z += ( r.x * j) / I;

            // ★ 床衝突音発火（impulseに応じた強弱、25ms クールダウン）
            const now = clock.getElapsedTime();
            // j を正規化（実測 j は 0.2 ~ 12 程度の range）
            const impactMag = j / 5.0;
            // 弱い接触は無視（強い衝突だけ目立つように閾値を上げる）
            if (impactMag > 0.15 && now - d.sound.lastFloorHit > 0.025) {
              if (soundOnRef.current && soundRef.current.ready) {
                soundRef.current.hitMixed(
                  boardSoundRef.current,
                  materialSoundRef.current,
                  Math.min(impactMag * 1.4, 2.5)
                );
              }
              d.sound.lastFloorHit = now;
            }
          }

          // 摩擦（接平面方向）
          const tx = contactVel.x;
          const tz = contactVel.z;
          const tMag = Math.sqrt(tx * tx + tz * tz);
          if (tMag > 0.01) {
            const muBase = contacts.length >= 3 ? 0.85 : (contacts.length === 2 ? 0.45 : 0.25);
            const mu = muBase;
            const tDirX = tx / tMag;
            const tDirZ = tz / tMag;
            const fric = Math.min(tMag * mu, Math.abs(vn) * mu + 2.0);
            d.physics.velocity.x -= tDirX * fric;
            d.physics.velocity.z -= tDirZ * fric;
            // 摩擦による角速度応答
            const fImpulseX = -tDirX * fric;
            const fImpulseZ = -tDirZ * fric;
            // (r × F) / I; F = (fImpulseX, 0, fImpulseZ)
            // cross: (r.y*Fz - r.z*Fy, r.z*Fx - r.x*Fz, r.x*Fy - r.y*Fx)
            d.physics.angVel.x += (r.y * fImpulseZ - r.z * 0) / I;
            d.physics.angVel.y += (r.z * fImpulseX - r.x * fImpulseZ) / I;
            d.physics.angVel.z += (r.x * 0 - r.y * fImpulseX) / I;
          }

          // 面接地時の角速度減衰（安定化）
          if (contacts.length >= 3) {
            d.physics.angVel.x *= 0.78;
            d.physics.angVel.y *= 0.78;
            d.physics.angVel.z *= 0.78;
          }
        }

        // ボード境界（円形フェルト）— ダイス半径ぶん内側で止め、はみ出しを防ぐ
        const distXZ = Math.sqrt(d.mesh.position.x ** 2 + d.mesh.position.z ** 2);
        const edgeLimit = BOARD_RADIUS - d.radius;
        if (distXZ > edgeLimit) {
          const nx = d.mesh.position.x / distXZ;
          const nz = d.mesh.position.z / distXZ;
          d.mesh.position.x = nx * edgeLimit;
          d.mesh.position.z = nz * edgeLimit;
          const vn2 = d.physics.velocity.x * nx + d.physics.velocity.z * nz;
          if (vn2 > 0) {
            d.physics.velocity.x -= 2 * vn2 * nx * 0.6;
            d.physics.velocity.z -= 2 * vn2 * nz * 0.6;

            // ★ 縁衝突音（縁は木製想定）
            const now = clock.getElapsedTime();
            const eMag = vn2 / 4.0;
            if (eMag > 0.18 && now - d.sound.lastEdgeHit > 0.05) {
              if (soundOnRef.current && soundRef.current.ready) {
                soundRef.current.hitMixed(
                  'wood_table',
                  materialSoundRef.current,
                  Math.min(eMag * 1.3, 2.0)
                );
              }
              d.sound.lastEdgeHit = now;
            }
          }
        }

        // 空気抵抗
        const linDecay = Math.pow(0.7, dt);
        const angDecay = Math.pow(0.55, dt);
        d.physics.velocity.x *= linDecay;
        d.physics.velocity.z *= linDecay;
        d.physics.angVel.x *= angDecay;
        d.physics.angVel.y *= angDecay;
        d.physics.angVel.z *= angDecay;

        const speed = Math.sqrt(
          d.physics.velocity.x ** 2 + d.physics.velocity.y ** 2 + d.physics.velocity.z ** 2
        );
        const angSpeed = Math.sqrt(
          d.physics.angVel.x ** 2 + d.physics.angVel.y ** 2 + d.physics.angVel.z ** 2
        );

        // === 完全停止判定: 面が接地 & 速度小 ===
        if (contacts.length >= 3 && speed < 0.15 && angSpeed < 0.3) {
          d.physics.rolling = false;
          d.physics.velocity.set(0, 0, 0);
          d.physics.angVel.set(0, 0, 0);
        }
      });

      // フェーズ2: ダイス同士の衝突
      const dice = diceMeshesRef.current;
      for (let iter = 0; iter < 2; iter++) {
        for (let i = 0; i < dice.length; i++) {
          for (let j = i + 1; j < dice.length; j++) {
            const a = dice[i], b = dice[j];
            if (!a.physics.rolling && !b.physics.rolling) continue;
            const dx = b.mesh.position.x - a.mesh.position.x;
            const dy = b.mesh.position.y - a.mesh.position.y;
            const dz = b.mesh.position.z - a.mesh.position.z;
            const distSq = dx*dx + dy*dy + dz*dz;
            const minDist = a.radius + b.radius;
            if (distSq < minDist*minDist && distSq > 0.0001) {
              const dist = Math.sqrt(distSq);
              const overlap = minDist - dist;
              const nx = dx/dist, ny = dy/dist, nz = dz/dist;
              const aMove = a.physics.rolling ? 1 : 0;
              const bMove = b.physics.rolling ? 1 : 0;
              const totalMove = aMove + bMove;
              if (totalMove === 0) continue;
              const aShare = bMove / totalMove;
              const bShare = aMove / totalMove;
              a.mesh.position.x -= nx*overlap*aShare;
              a.mesh.position.y -= ny*overlap*aShare;
              a.mesh.position.z -= nz*overlap*aShare;
              b.mesh.position.x += nx*overlap*bShare;
              b.mesh.position.y += ny*overlap*bShare;
              b.mesh.position.z += nz*overlap*bShare;
              if (iter === 0) {
                const rvx = b.physics.velocity.x - a.physics.velocity.x;
                const rvy = b.physics.velocity.y - a.physics.velocity.y;
                const rvz = b.physics.velocity.z - a.physics.velocity.z;
                const vAlong = rvx*nx + rvy*ny + rvz*nz;
                if (vAlong < 0) {
                  const restitution = 0.42;
                  const impulse = -(1 + restitution) * vAlong / 2;
                  a.physics.velocity.x -= impulse*nx;
                  a.physics.velocity.y -= impulse*ny;
                  a.physics.velocity.z -= impulse*nz;
                  b.physics.velocity.x += impulse*nx;
                  b.physics.velocity.y += impulse*ny;
                  b.physics.velocity.z += impulse*nz;
                  const sj = 1.8;
                  a.physics.angVel.x += (Math.random()-0.5)*sj;
                  a.physics.angVel.y += (Math.random()-0.5)*sj;
                  a.physics.angVel.z += (Math.random()-0.5)*sj;
                  b.physics.angVel.x += (Math.random()-0.5)*sj;
                  b.physics.angVel.y += (Math.random()-0.5)*sj;
                  b.physics.angVel.z += (Math.random()-0.5)*sj;

                  // ★ ダイス同士衝突音（両方とも同じダイス素材想定）
                  const now = clock.getElapsedTime();
                  const cMag = Math.abs(impulse) / 3.5;
                  if (cMag > 0.18 && now - a.sound.lastFloorHit > 0.03) {
                    if (soundOnRef.current && soundRef.current.ready) {
                      soundRef.current.hit(
                        materialSoundRef.current,
                        Math.min(cMag * 1.3, 2.0)
                      );
                    }
                    a.sound.lastFloorHit = now;
                    b.sound.lastFloorHit = now;
                  }
                }
              }
              // 接地済み(rolling=false)のダイスがぶつかられて押し出された場合は
              // 物理を再開させる。rolling=false のままだと衝突解決(L1605)の対象外になり、
              // 隣の接地済みダイスへめり込んだまま固定されてしまうため。
              // 衝突インパルスで付与された速度もこれで初めて積分される。
              a.physics.rolling = true;
              b.physics.rolling = true;
            }
          }
        }
      }

      // === フェーズ2.5: 全ダイスを盤面内へ + 床めり込み補正 ===
      // フェーズ1の床補正は rolling 中のダイスにしか効かず、しかも
      // フェーズ2（ダイス同士の押し出し）より前に走る。そのため
      // 押し出しで床下へ潜ったダイスはここで実ジオメトリ基準に補正する。
      //（停止済み・回転中を問わず、描画前の最終位置で必ず床上に乗せる）
      diceMeshesRef.current.forEach(d => {
        const dXZ = Math.sqrt(d.mesh.position.x ** 2 + d.mesh.position.z ** 2);
        const lim = BOARD_RADIUS - d.radius;
        if (dXZ > lim && dXZ > 0.0001) {
          const k = lim / dXZ;
          d.mesh.position.x *= k;
          d.mesh.position.z *= k;
        }
        // 実ジオメトリの最下点（現在の姿勢で評価）が床より下なら押し上げる
        let minY = Infinity;
        for (const lv of d.localVerts) {
          floorClampVec.copy(lv).applyQuaternion(d.mesh.quaternion);
          const wy = floorClampVec.y + d.mesh.position.y;
          if (wy < minY) minY = wy;
        }
        if (Number.isFinite(minY) && minY < FLOOR_Y) {
          d.mesh.position.y += FLOOR_Y - minY;
        }
      });

      // === フェーズ3: 全ダイス停止検知 → 結果コールバック ===
      if (wasRollingRef.current) {
        const dl = diceMeshesRef.current;
        const anyRolling = dl.some(d => d.physics.rolling);
        // 10秒タイムアウト保険
        const elapsed = Date.now() - rollStartTimeRef.current;
        const timeout = elapsed > 10000;
        if (!anyRolling || timeout) {
          // 強制停止（タイムアウト時）
          if (timeout) {
            dl.forEach(d => {
              d.physics.rolling = false;
              d.physics.velocity.set(0, 0, 0);
              d.physics.angVel.set(0, 0, 0);
            });
          }
          wasRollingRef.current = false;
          if (onRollCompleteRef.current) {
            const cb = onRollCompleteRef.current;
            onRollCompleteRef.current = null;
            cb();
          }
        }
      }

      // レジン内包物のアニメーション（緩い回転 + 光の点滅）
      const animT = clock.getElapsedTime();
      diceMeshesRef.current.forEach(d => {
        // Contact shadow（フロスト用）：ダイスの位置と高さに連動
        if (d.contactShadow) {
          const dh = d.mesh.position.y - (-0.5); // 床からの高さ
          // 高いほど影は薄く・大きく、低いほど濃く・コンパクト
          // 高さ 0: scale 1.0, opacity 0.85
          // 高さ 2.0: scale 1.6, opacity 0.35
          const heightFactor = Math.min(dh / 2.0, 1.0);
          const scale = 1.0 + heightFactor * 0.6;
          const opacity = 0.85 - heightFactor * 0.50;
          d.contactShadow.position.x = d.mesh.position.x;
          d.contactShadow.position.z = d.mesh.position.z;
          d.contactShadow.scale.set(scale, scale, 1);
          d.contactShadow.material.opacity = Math.max(opacity, 0.10);
        }

        if (!d.mesh.userData.inclusions) return;
        d.mesh.userData.inclusions.forEach(inc => {
          // 両方を持つ要素（宝石の大きい輝点）にも対応するため独立判定
          if (inc.userData.sparkle) {
            // 光の粒：opacity をサインで変動（キラキラ）
            const t = animT * inc.userData.sparkleSpeed + inc.userData.sparkleOffset;
            inc.material.opacity = 0.50 + 0.45 * (0.5 + 0.5 * Math.sin(t));
          }
          if (inc.userData.spinAxis) {
            // 回転（板や4面体）
            inc.rotateOnAxis(inc.userData.spinAxis, inc.userData.spinSpeed * dt);
          }
        });
      });

      renderer.render(scene, camera);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      if (!mount) return;
      const nw = mount.clientWidth, nh = mount.clientHeight;
      if (nw === 0 || nh === 0) return;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);
    const ro = new ResizeObserver(handleResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', handleResize);
      ro.disconnect();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []); // eslint-disable-line

  // ボードテーマ更新
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !boardRef.current) return;
    scene.fog.color.set(board.vignette);
    boardRef.current.children.forEach((child, idx) => {
      if (idx === 0) {
        // felt: 既存テクスチャを dispose して新規生成
        if (child.material.map) child.material.map.dispose();
        const newTex = createBoardTexture(boardTheme);
        if (newTex) {
          newTex.wrapS = THREE.ClampToEdgeWrapping;
          newTex.wrapT = THREE.ClampToEdgeWrapping;
        }
        child.material.map = newTex;
        child.material.color.set(0xffffff); // テクスチャ表示用に白
        child.material.needsUpdate = true;
      }
      if (idx === 1) child.material.color.set(board.edge);
      if (idx === 2) child.material.color.set(board.glow);
    });
  }, [boardTheme]); // eslint-disable-line

  // ダイス再構築。
  // 素材・色テーマ変更時は見た目が変わるため全再生成、
  // 個数のみの変更時は差分追加 / 削除で済ませる（多数追加時の待ち時間を抑える）。
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const prev = prevAppearanceRef.current;
    if (!prev || prev.material !== material || prev.colorTheme !== colorTheme) {
      prevAppearanceRef.current = { material, colorTheme };
      rebuildDice(scene);
    } else {
      syncDiceCount(scene);
    }
  }, [diceCounts, material, colorTheme]); // eslint-disable-line

  // 音用 ref 同期（物理ループから最新値を参照可能に）
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);
  useEffect(() => { materialSoundRef.current = mat.sound; }, [material]); // eslint-disable-line
  useEffect(() => { boardSoundRef.current = board.sound; }, [boardTheme]); // eslint-disable-line

  // モバイル時のカメラ調整
  useEffect(() => {
    if (!cameraRef.current) return;
    const cam = cameraRef.current;
    if (isMobile) {
      cam.position.set(0, 10, 9);
      cam.fov = 52;
    } else {
      cam.position.set(0, 8, 7.5);
      cam.fov = 45;
    }
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
  }, [isMobile]);

  // 1 個のダイス（mesh + contact shadow）の GPU リソースを解放
  function disposeDie(scene, d) {
    scene.remove(d.mesh);
    d.mesh.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
        else {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });
    if (d.contactShadow) {
      scene.remove(d.contactShadow);
      d.contactShadow.geometry.dispose();
      if (d.contactShadow.material.map) d.contactShadow.material.map.dispose();
      d.contactShadow.material.dispose();
    }
  }

  function clearDiceMeshes(scene) {
    diceMeshesRef.current.forEach(d => disposeDie(scene, d));
    diceMeshesRef.current = [];
  }

  // ダイス 1 個分のメッシュ生成（重い処理）。位置は layoutDice に委ねる。
  function createDieEntry(scene, t) {
    const radius = getDiceRadius(t.id);
    const mesh = makeDieMesh(t);
    mesh.userData.type = t;
    scene.add(mesh);

    // フロスト専用: 半透明の柔らかい contact shadow
    let contactShadow = null;
    if (material === 'acrylic') {
      contactShadow = createContactShadow(radius);
      scene.add(contactShadow);
    }

    return {
      mesh,
      type: t,
      radius,
      faces: mesh.userData.faces || [],
      localVerts: mesh.userData.localVerts || [],
      contactShadow,
      physics: {
        rolling: false,
        velocity: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
      },
      sound: {
        lastFloorHit: 0,
        lastEdgeHit: 0,
      },
    };
  }

  // 現在のダイス群を円形プレイ領域内に整列配置する。
  // sunflower（黄金角）配置で円盤を均等に埋め、盤面からのはみ出しを防ぐ。
  // 各ダイスは実ジオメトリの最下点が床に接するよう Y を決め、めり込み/浮きを防ぐ。
  function layoutDice() {
    const dice = diceMeshesRef.current;
    const n = dice.length;
    if (n === 0) return;
    const maxRadius = dice.reduce((m, d) => Math.max(m, d.radius), 0);
    const fieldR = Math.max(0, BOARD_RADIUS - maxRadius - 0.2);
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    dice.forEach((d, i) => {
      let x = 0, z = 0;
      if (n > 1) {
        const rr = Math.sqrt((i + 0.5) / n) * fieldR;
        const ang = i * GOLDEN_ANGLE;
        x = Math.cos(ang) * rr;
        z = Math.sin(ang) * rr;
      }
      d.mesh.quaternion.identity();
      // 静止姿勢での実ジオメトリ最下点を床に合わせる
      let minLocalY = Infinity;
      for (const lv of d.localVerts) {
        if (lv.y < minLocalY) minLocalY = lv.y;
      }
      if (!Number.isFinite(minLocalY)) minLocalY = -d.radius;
      d.mesh.position.set(x, FLOOR_Y - minLocalY, z);
      d.physics.rolling = false;
      d.physics.velocity.set(0, 0, 0);
      d.physics.angVel.set(0, 0, 0);
      if (d.contactShadow) d.contactShadow.position.set(x, FLOOR_Y + 0.01, z);
    });
  }

  // 全ダイスを破棄して作り直す（素材・色テーマ変更時）
  function rebuildDice(scene) {
    clearDiceMeshes(scene);
    DICE_TYPES.forEach(t => {
      for (let i = 0; i < diceCounts[t.id]; i++) {
        diceMeshesRef.current.push(createDieEntry(scene, t));
      }
    });
    layoutDice();
  }

  // diceCounts に合わせて差分だけ追加 / 削除する（個数変更時）。
  // 全再生成しないため、ダイスが増えても 1 個追加分の処理量で済む。
  function syncDiceCount(scene) {
    DICE_TYPES.forEach(t => {
      const desired = diceCounts[t.id];
      const current = diceMeshesRef.current.filter(d => d.type.id === t.id);
      if (current.length > desired) {
        const remove = new Set(current.slice(desired));
        remove.forEach(d => disposeDie(scene, d));
        diceMeshesRef.current = diceMeshesRef.current.filter(d => !remove.has(d));
      } else {
        for (let i = current.length; i < desired; i++) {
          diceMeshesRef.current.push(createDieEntry(scene, t));
        }
      }
    });
    layoutDice();
  }

  function makeDieMesh(type) {
    let geom = getDiceGeometry(type.id);
    // 同位置の頂点を共有化 + 頂点法線を平均化
    // smooth shading (flatShading: false) と組み合わせて
    // 頂点付近の法線が滑らかに補間され、視覚的に角が丸まる
    geom = smoothDiceGeometry(geom);

    const mainColor = new THREE.Color(col.primary);
    if (material === 'gemstone') mainColor.lerp(new THREE.Color(col.secondary), 0.3);
    if (material === 'metal')    mainColor.lerp(new THREE.Color(col.secondary), 0.55);
    // レジンは外殻を薄めの色味に（中身が透けて見えるように）
    if (material === 'resin')    mainColor.lerp(new THREE.Color(0xffffff), 0.35);
    // 木材：テーマ色を木の茶色とブレンド（塗料が木に染み込んだような色味）
    //   暗めの木の茶色 (0x4a2f17) を主体、テーマ色を混ぜる
    if (material === 'wood') {
      const woodBase = new THREE.Color(0x4a2f17);
      woodBase.lerp(mainColor, 0.35);
      mainColor.copy(woodBase);
    }

    // 木目テクスチャ（木材時のみ）
    const woodTexture = material === 'wood' ? createWoodGrainTexture() : null;

    const matOpts = {
      color: mainColor,
      map: woodTexture, // 木材時は木目を重ねる
      metalness: mat.metalness,
      roughness: mat.roughness,
      transparent: mat.transparent,
      opacity: mat.transparent ? mat.opacity : 1.0,
      emissive: new THREE.Color(col.emissive),
      emissiveIntensity:
        material === 'gemstone' ? 0.85 : // 宝石は内部発光を強める
        material === 'resin'    ? 0.10 :
        material === 'acrylic'  ? 0.28 :
        material === 'wood'     ? 0.08 :
        0.10,
      flatShading: false,
      envMapIntensity:
        material === 'metal'    ? 1.4 :
        material === 'gemstone' ? 2.0 : // 反射を最大化
        material === 'acrylic'  ? 0.10 :
        material === 'resin'    ? 1.1 :
        0.5,
      // フロストは FrontSide で表面だけ描画 → 裏面の数字が透けず、後ろの空間が見える
      // 他の透明素材（レジン・宝石）は DoubleSide で内部や裏面の数字も見せる
      side: material === 'acrylic' ? THREE.FrontSide :
            (mat.transparent ? THREE.DoubleSide : THREE.FrontSide),
      depthWrite: (material === 'resin' || material === 'gemstone') ? false : true, // 内包物を見せるため
      depthTest: true,
    };

    // フロストもMeshStandardMaterialで実装（MeshPhysicalMaterialはこの環境で動作不安定）
    // 高 roughness + 白ブレンド + 低 envMapIntensity でフロスト感を作る
    const meshMat = new THREE.MeshStandardMaterial(matOpts);

    // 木材時：UV が無くても木目を表示するため position ベースで UV を計算
    // 真の triplanar mapping：3軸の投影を法線で重み付けブレンド → 継ぎ目なし
    // 重要：smooth shading の頂点法線は面の中で補間されてしまうため、
    // dFdx/dFdy で物理的な面法線（flat normal）を計算する
    if (material === 'wood' && woodTexture) {
      meshMat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWorldPos;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
           vWorldPos = position;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWorldPos;`
        );
        // map のサンプリングを 3軸ブレンドの triplanar に置き換え
        // dFdx/dFdy で各画素の物理的な面法線を計算（smooth shading の影響を回避）
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `
          #ifdef USE_MAP
            // 面の物理的な normal を画素ごとに計算（フラット法線）
            // dFdx/dFdy はワールド位置の各画素間の差分
            vec3 fdx = dFdx(vWorldPos);
            vec3 fdy = dFdy(vWorldPos);
            vec3 faceN = normalize(cross(fdx, fdy));

            // 各軸の重み（しっかり主軸が選ばれるようにべき乗を高く）
            vec3 weights = pow(abs(faceN), vec3(8.0));
            weights /= max(weights.x + weights.y + weights.z, 0.0001);

            float scale = 0.42;
            // 3 軸それぞれで投影してサンプル
            vec2 uvX = vec2(vWorldPos.z, vWorldPos.y) * scale;
            vec2 uvY = vec2(vWorldPos.x, vWorldPos.z) * scale;
            vec2 uvZ = vec2(vWorldPos.x, vWorldPos.y) * scale;
            vec4 sX = texture2D(map, uvX);
            vec4 sY = texture2D(map, uvY);
            vec4 sZ = texture2D(map, uvZ);
            vec4 sampledDiffuseColor = sX * weights.x + sY * weights.y + sZ * weights.z;
            diffuseColor *= sampledDiffuseColor;
          #endif
          `
        );
      };
    }

    const mesh = new THREE.Mesh(geom, meshMat);
    // フロストは半透明なので影をほぼ落とさない（自然な見た目）
    // 他の素材は通常通り影を落とす
    mesh.castShadow = material !== 'acrylic';
    mesh.receiveShadow = true;

    // === レジン専用: 内部に光の反射する内包物を配置 ===
    if (material === 'resin') {
      const radius = getDiceRadius(type.id);
      const inclusions = createResinInclusions(radius, col);
      inclusions.forEach(inc => mesh.add(inc));
      mesh.userData.inclusions = inclusions; // アニメーション用
    }

    // === 宝石専用: キラキラ輝く内包物 ===
    if (material === 'gemstone') {
      const radius = getDiceRadius(type.id);
      const sparkles = createGemstoneSparkles(radius, col);
      sparkles.forEach(s => mesh.add(s));
      mesh.userData.inclusions = sparkles; // 同じアニメーションループで処理
    }

    // エッジ：主面同士の境界線を出す
    // 元のサイコロは d6で90度・d20で42度などの二面角を持つ
    // smooth化後も三角形の法線自体は変わらないので、閾値22度で主面の境界が出る
    const edges = new THREE.EdgesGeometry(geom, 22);
    const lineMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(col.ink),
      transparent: true,
      opacity: mat.transparent ? 0.5 : 0.7,
      depthTest: true,
    });
    const wire = new THREE.LineSegments(edges, lineMat);
    mesh.add(wire);

    // === 各面の中心・法線（数字テクスチャ配置&面判定用） ===
    // smooth化後も元の三角形は保持されるが、d10/d100 は同一法線の三角形が
    // 2つあるので閾値で正しく面数にグルーピングされる
    // d100 は物理ジオメトリ的に10面（pentagonal trapezohedron）
    const physicalFaceCount = type.id === 'd100' ? 10 : type.faces;
    const faces = computeFaceData(geom, physicalFaceCount);
    mesh.userData.faces = faces;
    // 物理用ユニーク頂点（元のシャープな頂点 = 物理判定はそのまま）
    mesh.userData.localVerts = extractUniqueVertices(geom);

    // === 各面に数字を貼る ===
    const numSize = getNumberSize(type.id);
    // 不透明素材は片面のみ（反対側面の数字が透けないように）、半透明は両面
    // フロストはダイス本体が FrontSide なので、数字も FrontSide（裏面表示しない）
    // 他の透明素材は DoubleSide（内部から見える数字も描画）
    const numSide = material === 'acrylic' ? THREE.FrontSide :
                    (mat.transparent ? THREE.DoubleSide : THREE.FrontSide);
    // 素材×色テーマに応じて数字スタイル（太さ・縁取り）を決定
    const numStyle = decideNumberStyle(material, col, mainColor);
    faces.forEach((face, i) => {
      const label = getFaceLabel(type.id, i);
      const tex = createNumberTexture(label, numStyle.ink, {
        bolder: numStyle.bolder,
        outlineColor: numStyle.outlineColor,
        outlineWidth: numStyle.outlineWidth,
      });
      const numGeom = new THREE.PlaneGeometry(numSize, numSize);
      const numMat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: numSide,
        depthWrite: false,
        depthTest: true,
      });
      const numMesh = new THREE.Mesh(numGeom, numMat);
      // 面の外側にわずかに突出（z-fight防止）
      numMesh.position.copy(face.center).add(face.normal.clone().multiplyScalar(0.012));
      // Three.js の Object3D.lookAt() は +Z 軸を target に向ける仕様。
      // Plane の表（+Z）を法線方向（外向き）にするため、target は face.normal 方向に置く。
      const lookTarget = numMesh.position.clone().add(face.normal);
      numMesh.lookAt(lookTarget);
      mesh.add(numMesh);
    });

    return mesh;
  }

  // ロール
  const handleRoll = useCallback(async () => {
    if (isRolling || totalDice === 0) return;
    if (soundOn) await soundRef.current.init();
    setIsRolling(true);
    setResults(null);

    // ロール対象のダイス参照スナップショット
    const diceList = diceMeshesRef.current.slice();
    const diceCount = diceList.length;

    // 盤面タップ位置（あれば）を落下中心に。なければ盤面中央。1回限りで消費。
    const drop = dropPointRef.current;
    dropPointRef.current = null;
    let dropX = 0, dropZ = 0;
    if (drop) {
      // 落下中心を内側へクランプ：端をタップしてもダイス群が盤面に収まる
      const cd = Math.sqrt(drop.x ** 2 + drop.z ** 2);
      const centerLimit = BOARD_RADIUS - 1.4;
      if (cd > centerLimit && cd > 0.0001) {
        dropX = (drop.x / cd) * centerLimit;
        dropZ = (drop.z / cd) * centerLimit;
      } else {
        dropX = drop.x;
        dropZ = drop.z;
      }
    }

    // 物理発射のみ（結果は決めない）
    diceList.forEach((d, i) => {
      d.physics.rolling = true;
      const angle = (i / Math.max(diceCount, 1)) * Math.PI * 2 + Math.random() * 0.6;

      let px, pz, vx, vy, vz;
      if (drop) {
        // タップ位置を中心に小さくばらけて「その場に落とす」
        const spreadR = diceCount === 1 ? 0 : 0.55 + (i % 3) * 0.5 + Math.random() * 0.3;
        px = dropX + Math.cos(angle) * spreadR;
        pz = dropZ + Math.sin(angle) * spreadR;
        // 水平速度は小さく抑え、タップ位置から大きく散らさない
        vx = (Math.random() - 0.5) * 1.6;
        vy = 0.5 + Math.random() * 0.8;
        vz = (Math.random() - 0.5) * 1.6;
      } else {
        // 中央からのロール（従来挙動）
        const launchR = 1.2 + Math.random() * 1.0;
        px = Math.cos(angle) * launchR;
        pz = Math.sin(angle) * launchR;
        vx = Math.cos(angle) * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2;
        vy = 1 + Math.random() * 1.5;
        vz = Math.sin(angle) * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2;
      }

      // 生成位置を盤面内へクランプ（個数・位置によらず縁からはみ出さない）
      const limitR = BOARD_RADIUS - d.radius - 0.1;
      const pd = Math.sqrt(px ** 2 + pz ** 2);
      if (pd > limitR && pd > 0.0001) {
        px = (px / pd) * limitR;
        pz = (pz / pd) * limitR;
      }

      d.mesh.position.x = px;
      d.mesh.position.z = pz;
      d.mesh.position.y = 4.5 + Math.random() * 2;
      // 初期姿勢もランダム化（結果に偏りが出ないように）
      d.mesh.quaternion.setFromEuler(new THREE.Euler(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
      ));
      d.physics.velocity.set(vx, vy, vz);
      d.physics.angVel.set(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16
      );
    });

    wasRollingRef.current = true;
    rollStartTimeRef.current = Date.now();

    // 完了時のコールバック：実際の上面から結果を読み取る
    const currentModifier = modifier;
    const currentFormula = formula;
    onRollCompleteRef.current = () => {
      const rolls = [];
      diceList.forEach(d => {
        const topIdx = findTopFaceIndex(d.mesh, d.faces);
        const value = faceIndexToValue(d.type.id, topIdx);
        rolls.push({ type: d.type.id, value, label: d.type.label });
      });
      const total = evaluateRolls(rolls, currentModifier);

      setResults({ rolls, total, modifier: currentModifier });
      setHistory(h => [{ formula: currentFormula, total, rolls, ts: Date.now() }, ...h].slice(0, 50));
      if (soundOn && hasCritical(rolls)) soundRef.current.fanfare();
      setIsRolling(false);
    };
  }, [diceCounts, modifier, isRolling, totalDice, soundOn, formula]);

  // 盤面クリック/タップ：交点を計算し、その位置を落下位置に指定してロール
  const handleBoardClick = useCallback((e) => {
    if (isRolling || totalDice === 0) return;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      // 床（felt 上面）平面との交点をタップ位置とする
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
      const hit = new THREE.Vector3();
      const ok = raycaster.ray.intersectPlane(plane, hit);
      // 盤面（felt 半径 6.2）内をタップしたときのみ落下位置を採用
      if (ok && Math.sqrt(hit.x ** 2 + hit.z ** 2) <= 6.2) {
        dropPointRef.current = { x: hit.x, z: hit.z };
      } else {
        dropPointRef.current = null;
      }
    }
    handleRoll();
  }, [isRolling, totalDice, handleRoll]);

  const updateDice = (id, delta) => {
    setDiceCounts(c => adjustDiceCount(c, id, delta, {
      maxTotal: MAX_TOTAL_DICE,
      maxPerType: MAX_DICE_PER_TYPE,
    }));
  };
  const clearAll = () => {
    setDiceCounts({ d4:0, d6:0, d8:0, d10:0, d100:0, d12:0, d20:0 });
    setModifier(0);
  };

  // =========================================================
  // UI
  // =========================================================
  const leftW = isMobile ? 0 : (leftOpen ? 280 : 44);
  const rightW = isMobile ? 0 : (rightOpen ? 280 : 44);

  // モバイル時のドロワー切替（左右同時を防ぐ）
  const toggleLeftMobile = () => {
    setLeftOpen(o => {
      const next = !o;
      if (next) setRightOpen(false);
      return next;
    });
  };
  const toggleRightMobile = () => {
    setRightOpen(o => {
      const next = !o;
      if (next) setLeftOpen(false);
      return next;
    });
  };

  return (
    <div className="app-root" style={{
      fontFamily: "'Cormorant Garamond', 'Hiragino Mincho ProN', 'Yu Mincho', serif",
      width: '100%',
      background: `radial-gradient(ellipse at 50% 30%, #1a1410 0%, #0a0608 100%)`,
      color: '#e8dcc0',
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Noto+Serif+JP:wght@400;700&display=swap');
        .grimoire-h { font-family: 'Cinzel', 'Noto Serif JP', serif; letter-spacing: 0.18em; text-transform: uppercase; }
        .jp { font-family: 'Noto Serif JP', serif; }
        .app-root {
          /* Android Chrome 等で URL バー分の高さを除いた実表示領域に収める */
          height: 100vh;
          height: 100dvh;
        }
        .panel {
          background: linear-gradient(145deg, rgba(28,22,18,0.92), rgba(18,14,12,0.95));
          border: 1px solid rgba(180,140,80,0.25);
          box-shadow: 0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(212,160,23,0.08);
          backdrop-filter: blur(8px);
        }
        .ornate-divider {
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(212,160,23,0.4), transparent);
          margin: 10px 0;
        }
        .dice-row {
          transition: all 0.18s cubic-bezier(.2,.9,.3,1.2);
          background: linear-gradient(140deg, rgba(50,38,24,0.5), rgba(30,22,16,0.7));
          border: 1px solid rgba(180,140,80,0.25);
          border-radius: 4px;
          padding: 6px 8px;
          display: flex; align-items: center; gap: 8px;
        }
        .dice-row.active {
          background: linear-gradient(140deg, rgba(120,80,30,0.7), rgba(80,50,20,0.85));
          border-color: rgba(244,216,118,0.6);
          box-shadow: 0 0 16px rgba(212,160,23,0.3);
        }
        .swatch {
          transition: all 0.18s;
          cursor: pointer;
          border: 2px solid rgba(180,140,80,0.25);
        }
        .swatch:hover { transform: scale(1.06); border-color: rgba(244,216,118,0.6); }
        .swatch.active { border-color: rgba(244,216,118,1.0); box-shadow: 0 0 16px rgba(212,160,23,0.5); }
        .roll-btn {
          background: linear-gradient(160deg, #d4a017, #8a6510);
          color: #1a0e02;
          border: 1px solid rgba(255,220,140,0.4);
          box-shadow: 0 6px 22px rgba(212,160,23,0.4), inset 0 1px 0 rgba(255,235,180,0.6), inset 0 -2px 4px rgba(80,50,5,0.4);
          font-family: 'Cinzel', serif;
          letter-spacing: 0.22em;
          transition: all 0.2s;
        }
        .roll-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 10px 32px rgba(212,160,23,0.6); }
        .roll-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .result-glow {
          text-shadow: 0 0 24px rgba(212,160,23,0.7), 0 0 48px rgba(212,160,23,0.4);
          animation: glow-pulse 2.5s ease-in-out infinite;
        }
        @keyframes glow-pulse {
          0%, 100% { text-shadow: 0 0 24px rgba(212,160,23,0.7); }
          50% { text-shadow: 0 0 36px rgba(244,216,118,0.9); }
        }
        .critical { color: #ffd76a; }
        .fumble { color: #c84a3a; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); }
        ::-webkit-scrollbar-thumb { background: rgba(180,140,80,0.4); border-radius: 3px; }
        .pillbtn {
          background: rgba(60,42,20,0.6);
          color: #f4d976;
          border: 1px solid rgba(180,140,80,0.4);
          width: 22px; height: 22px;
          border-radius: 3px;
          font-size: 13px; font-weight: 700;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer;
          padding: 0; line-height: 1;
        }
        .pillbtn:hover { background: rgba(120,80,30,0.7); }
        .pillbtn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
          filter: grayscale(0.6);
        }
        .pillbtn:disabled:hover { background: rgba(60,42,20,0.6); }
        .toggle-tab {
          background: linear-gradient(180deg, rgba(40,30,20,0.95), rgba(20,14,10,0.95));
          border: 1px solid rgba(180,140,80,0.3);
          color: #d4a017;
          cursor: pointer;
          font-family: 'Cinzel', serif; font-size: 10px;
          letter-spacing: 0.15em;
          display: flex; align-items: center; justify-content: center;
          padding: 0;
        }
        .toggle-tab:hover { background: rgba(80,55,25,0.9); color: #f4d976; }
        .panel-open-tab {
          background: linear-gradient(180deg, rgba(150,100,38,0.95), rgba(95,62,24,0.97));
          border: 1px solid rgba(212,160,23,0.7);
          color: #f7e08a;
          font-size: 13px; font-weight: 700;
          box-shadow: inset 0 0 22px rgba(212,160,23,0.22), 0 0 16px rgba(0,0,0,0.55);
          animation: tabPulse 2.4s ease-in-out infinite;
        }
        .panel-open-tab:hover {
          background: linear-gradient(180deg, rgba(185,128,52,1), rgba(120,80,32,1));
          color: #fff4cb;
          box-shadow: inset 0 0 26px rgba(244,217,118,0.3), 0 0 22px rgba(212,160,23,0.4);
        }
        @keyframes tabPulse {
          0%, 100% { box-shadow: inset 0 0 22px rgba(212,160,23,0.22), 0 0 12px rgba(0,0,0,0.55); }
          50%      { box-shadow: inset 0 0 22px rgba(212,160,23,0.22), 0 0 22px rgba(212,160,23,0.45); }
        }
        .panel-anim { transition: width 0.24s cubic-bezier(.2,.9,.3,1.2); }
      `}</style>

      {/* ヘッダー */}
      <header style={{
        padding: isMobile ? '8px 12px' : '12px 20px',
        borderBottom: '1px solid rgba(180,140,80,0.25)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'linear-gradient(180deg, rgba(20,14,8,0.9), rgba(10,6,4,0))',
        flexShrink: 0,
        gap: isMobile ? 8 : 16,
      }}>
        <div style={{ flexShrink: 0, minWidth: 0 }}>
          <h1 className="grimoire-h" style={{
            fontSize: isMobile ? 13 : 18, margin: 0, fontWeight: 700, color: '#d4a017',
            textShadow: '0 0 18px rgba(212,160,23,0.4)',
            whiteSpace: 'nowrap',
          }}>
            {isMobile ? '⚜ A.B. ⚜' : "⚜  Astaroth's Bones  ⚜"}
          </h1>
          {!isMobile && (
            <div className="jp" style={{ fontSize: 9, opacity: 0.55, letterSpacing: '0.3em', marginTop: 2 }}>
              アスタロトの骨子 — TRPGダイスロール
            </div>
          )}
          {isMobile && (
            <div className="grimoire-h" style={{
              fontSize: 10, color: '#f4d976', marginTop: 2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: 130,
            }}>
              {formula}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 12, flex: 1, justifyContent: 'flex-end', minWidth: 0 }}>
          {!isMobile && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(180,140,80,0.3)',
              borderRadius: 4,
              padding: '6px 14px',
              minWidth: 0, flexShrink: 1, maxWidth: 420,
            }}>
              <span className="grimoire-h" style={{ fontSize: 9, color: '#a89570', letterSpacing: '0.2em', flexShrink: 0 }}>
                FORMULA
              </span>
              <span className="grimoire-h" style={{
                fontSize: 14, color: '#f4d976', fontWeight: 700,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {formula}
              </span>
            </div>
          )}

          <button
            className="roll-btn"
            onClick={handleRoll}
            disabled={isRolling || totalDice === 0}
            style={{
              padding: isMobile ? '9px 14px' : '10px 26px',
              fontSize: isMobile ? 12 : 13, fontWeight: 700,
              cursor: isRolling || totalDice === 0 ? 'not-allowed' : 'pointer',
              borderRadius: 4,
              flexShrink: 0,
              minHeight: 40,
            }}
          >
            {isRolling ? (isMobile ? '⌛' : '⌛ ROLLING') : (isMobile ? '⚔ ROLL' : '⚔ ROLL ⚔')}
          </button>

          <button onClick={() => setSoundOn(s => !s)} style={{
            background: 'transparent', color: '#d4a017',
            border: '1px solid rgba(180,140,80,0.4)',
            padding: isMobile ? '6px 8px' : '6px 12px', cursor: 'pointer',
            fontFamily: 'Cinzel, serif', fontSize: 11, letterSpacing: '0.15em',
            borderRadius: 3, flexShrink: 0,
            minHeight: 40, minWidth: 40,
          }}>
            {soundOn ? '♪' : '♪⃠'}
          </button>
        </div>
      </header>

      {/* 本体グリッド */}
      <main style={{
        flex: 1,
        display: isMobile ? 'flex' : 'grid',
        flexDirection: isMobile ? 'column' : undefined,
        gridTemplateColumns: isMobile ? undefined : `${leftW}px 1fr ${rightW}px`,
        gap: isMobile ? 6 : 10,
        padding: isMobile ? 6 : 10,
        minHeight: 0,
        position: 'relative',
      }}>
        {/* モバイル時ドロワー背景オーバーレイ */}
        {isMobile && (leftOpen || rightOpen) && (
          <div
            onClick={() => { setLeftOpen(false); setRightOpen(false); }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
              zIndex: 90, backdropFilter: 'blur(2px)',
            }}
          />
        )}

        {/* === 左パネル === */}
        <aside className="panel panel-anim" style={{
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          ...(isMobile ? {
            position: 'fixed',
            bottom: 0, left: 0, right: 0,
            maxHeight: '72dvh',
            zIndex: 100,
            transform: leftOpen ? 'translateY(0)' : 'translateY(110%)',
            transition: 'transform 0.32s cubic-bezier(.2,.9,.3,1.05)',
            borderRadius: '14px 14px 0 0',
            boxShadow: '0 -14px 50px rgba(0,0,0,0.7)',
          } : {
            position: 'relative',
          }),
        }}>
          {(isMobile || leftOpen) ? (
            <>
              <div style={{
                padding: isMobile ? '14px 16px 10px' : '12px 14px 8px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderBottom: '1px solid rgba(180,140,80,0.18)',
                flexShrink: 0,
              }}>
                <div>
                  <div className="grimoire-h" style={{ fontSize: isMobile ? 13 : 12, color: '#d4a017' }}>◇ ダイス変更 ◇</div>
                  <div className="jp" style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.2em' }}>CHANGE DICE</div>
                </div>
                <button className="toggle-tab" onClick={() => setLeftOpen(false)}
                  style={{ width: isMobile ? 36 : 22, height: isMobile ? 36 : 22, borderRadius: 3, fontSize: isMobile ? 14 : 12 }}>{isMobile ? '✕' : '‹'}</button>
              </div>

              <div style={{ padding: '10px 12px', overflowY: 'auto', flex: 1 }}>
                {/* コンパクトなダイスリスト */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {DICE_TYPES.map(d => {
                    const addDisabled = totalDice >= MAX_TOTAL_DICE
                      || diceCounts[d.id] >= MAX_DICE_PER_TYPE;
                    return (
                    <div key={d.id} className={`dice-row ${diceCounts[d.id] > 0 ? 'active' : ''}`}>
                      <span className="grimoire-h" style={{
                        fontSize: 13, fontWeight: 700,
                        color: diceCounts[d.id] > 0 ? '#f4d976' : '#a89570',
                        width: 32,
                      }}>{d.label}</span>
                      <span style={{ fontSize: 9, opacity: 0.5, flex: 1 }}>{d.faces}面</span>
                      <button className="pillbtn" onClick={() => updateDice(d.id, -1)}>−</button>
                      <span style={{
                        minWidth: 18, textAlign: 'center', fontSize: 13,
                        color: '#f4d976', fontFamily: 'Cinzel, serif',
                      }}>{diceCounts[d.id]}</span>
                      <button
                        className="pillbtn"
                        onClick={() => updateDice(d.id, 1)}
                        disabled={addDisabled}
                        title={addDisabled ? `盤面の上限は ${MAX_TOTAL_DICE} 個です` : ''}
                      >+</button>
                    </div>
                    );
                  })}
                </div>

                <div className="jp" style={{
                  fontSize: 10, textAlign: 'center', marginTop: 8,
                  letterSpacing: '0.1em',
                  color: totalDice >= MAX_TOTAL_DICE ? '#e08a3a' : '#a89570',
                }}>
                  ダイス合計 {totalDice} / {MAX_TOTAL_DICE}
                  {totalDice >= MAX_TOTAL_DICE && '（上限）'}
                </div>

                <div className="ornate-divider" />

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="grimoire-h" style={{ fontSize: 10, color: '#d4a017', minWidth: 50 }}>MOD</span>
                  <button className="pillbtn" onClick={() => setModifier(m => m - 1)}>−</button>
                  <input
                    type="number"
                    value={modifier}
                    onChange={e => setModifier(parseInt(e.target.value || '0', 10))}
                    style={{
                      flex: 1, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(180,140,80,0.3)',
                      color: '#f4d976', textAlign: 'center', padding: 4, fontSize: 14,
                      fontFamily: 'Cinzel, serif', borderRadius: 3, width: 30,
                    }}
                  />
                  <button className="pillbtn" onClick={() => setModifier(m => m + 1)}>+</button>
                </div>

                <div className="ornate-divider" />

                <button onClick={clearAll} style={{
                  width: '100%', padding: 6,
                  background: 'transparent', color: '#a89570',
                  border: '1px solid rgba(180,140,80,0.3)',
                  fontFamily: 'Cinzel, serif', letterSpacing: '0.2em', fontSize: 10,
                  cursor: 'pointer', borderRadius: 3,
                }}>CLEAR ALL</button>
              </div>
            </>
          ) : !isMobile ? (
            <button className="toggle-tab panel-open-tab" onClick={() => setLeftOpen(true)}
              style={{ width: '100%', height: '100%', borderRadius: 4, flexDirection: 'column', gap: 12 }}>
              <span style={{ writingMode: 'vertical-rl', letterSpacing: '0.3em' }}>ダイス変更</span>
              <span style={{ fontSize: 16 }}>›</span>
            </button>
          ) : null}
        </aside>

        {/* === 中央エリア === */}
        <section style={{
          display: 'flex', flexDirection: 'column', gap: isMobile ? 6 : 10,
          minHeight: 0, minWidth: 0,
          flex: 1, // モバイルの flex column で section を main の残り高さに伸ばす
        }}>
          {/* 3Dビュー（タップ/クリックでもロール実行） */}
          <div
            className="panel"
            onClick={handleBoardClick}
            style={{
              flex: 1, position: 'relative', overflow: 'hidden', borderRadius: 4,
              minHeight: 200,
              cursor: isRolling || totalDice === 0 ? 'default' : 'pointer',
              userSelect: 'none',
            }}
          >
            <div ref={mountRef} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              boxShadow: 'inset 0 0 120px rgba(0,0,0,0.7)',
            }} />
            <div style={{
              position: 'absolute', top: 12, left: 14,
              fontFamily: 'Cinzel, serif', fontSize: 10,
              color: '#d4a017', opacity: 0.7, letterSpacing: '0.3em',
              pointerEvents: 'none',
            }}>
              ◈ {board.name} · {mat.name} · {col.name} ◈
            </div>
          </div>

          {/* 結果 */}
          <div className="panel" style={{
            padding: isMobile ? 10 : 14,
            height: isMobile ? 110 : 138,
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {results ? (
              <div style={{ width: '100%' }}>
                <ResultDisplay results={results} formula={formula} isMobile={isMobile} />
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div className="grimoire-h" style={{ fontSize: 11, color: '#a89570', opacity: 0.6, letterSpacing: '0.3em' }}>
                  Ready to roll
                </div>
                <div className="jp" style={{ fontSize: 11, opacity: 0.4, marginTop: 4 }}>
                  {totalDice > 0 ? '盤面をタップ、またはROLLボタンで実行' : 'ダイスを選択してください'}
                </div>
              </div>
            )}
          </div>

          {/* LOG（独立トグル、高さ固定でUIガタつき防止） */}
          <div className="panel" style={{
            flexShrink: 0,
            overflow: 'hidden',
            height: logOpen ? (isMobile ? 132 : 168) : (isMobile ? 42 : 36),
            transition: 'height 0.22s ease',
          }}>
            <button onClick={() => setLogOpen(o => !o)} style={{
              width: '100%', background: 'transparent', border: 'none',
              padding: isMobile ? '10px 14px' : '8px 14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              color: '#d4a017', minHeight: isMobile ? 40 : 34,
            }}>
              <span className="grimoire-h" style={{ fontSize: 11 }}>
                ◇ 記録 · LOG ({history.length})
              </span>
              <span style={{ fontSize: 12 }}>{logOpen ? '▾' : '▸'}</span>
            </button>
            {logOpen && (
              <div style={{
                height: isMobile ? 90 : 130,
                overflowY: 'auto', padding: '0 14px 12px',
                borderTop: '1px solid rgba(180,140,80,0.15)',
              }}>
                {history.length === 0 ? (
                  <div className="jp" style={{ opacity: 0.4, fontSize: 11, padding: '8px 0', textAlign: 'center' }}>履歴なし</div>
                ) : (
                  history.map((h, i) => (
                    <div key={i} style={{
                      padding: '5px 0',
                      borderBottom: '1px dashed rgba(180,140,80,0.15)',
                      display: 'flex', justifyContent: 'space-between',
                      fontSize: 12,
                    }}>
                      <span style={{ opacity: 0.7, fontFamily: 'Cinzel, serif', letterSpacing: '0.05em' }}>{h.formula}</span>
                      <span className="grimoire-h" style={{ color: '#f4d976', fontWeight: 700 }}>= {h.total}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>

        {/* === 右パネル === */}
        <aside className="panel panel-anim" style={{
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          ...(isMobile ? {
            position: 'fixed',
            bottom: 0, left: 0, right: 0,
            maxHeight: '72dvh',
            zIndex: 100,
            transform: rightOpen ? 'translateY(0)' : 'translateY(110%)',
            transition: 'transform 0.32s cubic-bezier(.2,.9,.3,1.05)',
            borderRadius: '14px 14px 0 0',
            boxShadow: '0 -14px 50px rgba(0,0,0,0.7)',
          } : {
            position: 'relative',
          }),
        }}>
          {(isMobile || rightOpen) ? (
            <>
              <div style={{
                padding: isMobile ? '14px 16px 10px' : '12px 14px 8px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderBottom: '1px solid rgba(180,140,80,0.18)',
                flexShrink: 0,
              }}>
                <div>
                  <div className="grimoire-h" style={{ fontSize: isMobile ? 13 : 12, color: '#d4a017' }}>◇ スタイル ◇</div>
                  <div className="jp" style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.2em' }}>STYLE</div>
                </div>
                <button className="toggle-tab" onClick={() => setRightOpen(false)}
                  style={{ width: isMobile ? 36 : 22, height: isMobile ? 36 : 22, borderRadius: 3, fontSize: isMobile ? 14 : 12 }}>{isMobile ? '✕' : '›'}</button>
              </div>

              <div style={{ padding: '10px 12px', overflowY: 'auto', flex: 1 }}>
                {/* 素材 */}
                <h3 className="grimoire-h" style={{ fontSize: 10, color: '#d4a017', margin: '0 0 6px 0' }}>素材 · Material</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                  {Object.entries(MATERIALS).map(([k, m]) => (
                    <button
                      key={k}
                      onClick={() => setMaterial(k)}
                      style={{
                        padding: '6px 4px', fontSize: 11, cursor: 'pointer',
                        background: material === k
                          ? 'linear-gradient(140deg, rgba(120,80,30,0.7), rgba(80,50,20,0.85))'
                          : 'linear-gradient(140deg, rgba(50,38,24,0.5), rgba(30,22,16,0.7))',
                        border: `1px solid ${material === k ? 'rgba(244,216,118,0.6)' : 'rgba(180,140,80,0.25)'}`,
                        borderRadius: 3,
                        fontFamily: 'Noto Serif JP, serif',
                        color: material === k ? '#f4d976' : '#a89570',
                      }}
                    >{m.name}</button>
                  ))}
                </div>

                <div className="ornate-divider" />

                {/* 色 */}
                <h3 className="grimoire-h" style={{ fontSize: 10, color: '#d4a017', margin: '0 0 6px 0' }}>色 · Theme</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                  {Object.entries(COLOR_THEMES).map(([k, c]) => (
                    <div
                      key={k}
                      onClick={() => setColorTheme(k)}
                      className={`swatch ${colorTheme === k ? 'active' : ''}`}
                      title={c.name}
                      style={{
                        aspectRatio: '1', borderRadius: '50%',
                        background: `radial-gradient(circle at 30% 30%, ${c.secondary}, ${c.primary} 60%, ${c.emissive})`,
                      }}
                    />
                  ))}
                </div>
                <div className="jp" style={{ fontSize: 10, opacity: 0.6, textAlign: 'center', marginTop: 4 }}>
                  {col.name}
                </div>

                <div className="ornate-divider" />

                {/* ボード */}
                <h3 className="grimoire-h" style={{ fontSize: 10, color: '#d4a017', margin: '0 0 6px 0' }}>盤面 · Board</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                  {Object.entries(BOARD_THEMES).map(([k, b]) => (
                    <button
                      key={k}
                      onClick={() => setBoardTheme(k)}
                      style={{
                        padding: '8px 4px', fontSize: 10, cursor: 'pointer',
                        background: boardTheme === k
                          ? 'linear-gradient(140deg, rgba(120,80,30,0.7), rgba(80,50,20,0.85))'
                          : 'linear-gradient(140deg, rgba(50,38,24,0.5), rgba(30,22,16,0.7))',
                        border: `1px solid ${boardTheme === k ? 'rgba(244,216,118,0.6)' : 'rgba(180,140,80,0.25)'}`,
                        borderRadius: 3,
                        fontFamily: 'Noto Serif JP, serif',
                        color: boardTheme === k ? '#f4d976' : '#a89570',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                      }}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: `radial-gradient(circle, ${b.glow}, ${b.felt} 70%, ${b.edge})`,
                        border: `1px solid ${b.edge}`,
                      }} />
                      <span>{b.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : !isMobile ? (
            <button className="toggle-tab panel-open-tab" onClick={() => setRightOpen(true)}
              style={{ width: '100%', height: '100%', borderRadius: 4, flexDirection: 'column', gap: 12 }}>
              <span style={{ fontSize: 16 }}>‹</span>
              <span style={{ writingMode: 'vertical-rl', letterSpacing: '0.3em' }}>スタイル変更</span>
            </button>
          ) : null}
        </aside>
      </main>

      {/* モバイル底部タブバー */}
      {isMobile && (
        <footer style={{
          flexShrink: 0,
          display: 'flex',
          borderTop: '1px solid rgba(180,140,80,0.3)',
          background: 'linear-gradient(0deg, rgba(20,14,8,0.95), rgba(15,10,6,0.9))',
          padding: '4px 6px',
          paddingBottom: 'calc(4px + env(safe-area-inset-bottom))',
          gap: 6,
          zIndex: 50,
        }}>
          <button
            onClick={toggleLeftMobile}
            style={{
              flex: 1,
              padding: '12px 8px',
              background: leftOpen ? 'linear-gradient(140deg, rgba(120,80,30,0.7), rgba(80,50,20,0.85))' : 'rgba(0,0,0,0.4)',
              color: leftOpen ? '#f4d976' : '#d4a017',
              border: `1px solid rgba(180,140,80,${leftOpen ? 0.6 : 0.3})`,
              borderRadius: 4,
              fontFamily: 'Cinzel, serif',
              fontSize: 13, letterSpacing: '0.1em',
              cursor: 'pointer',
              minHeight: 48,
            }}
          >
            ＋／− ダイス変更
          </button>
          <button
            onClick={toggleRightMobile}
            style={{
              flex: 1,
              padding: '12px 8px',
              background: rightOpen ? 'linear-gradient(140deg, rgba(120,80,30,0.7), rgba(80,50,20,0.85))' : 'rgba(0,0,0,0.4)',
              color: rightOpen ? '#f4d976' : '#d4a017',
              border: `1px solid rgba(180,140,80,${rightOpen ? 0.6 : 0.3})`,
              borderRadius: 4,
              fontFamily: 'Cinzel, serif',
              fontSize: 13, letterSpacing: '0.1em',
              cursor: 'pointer',
              minHeight: 48,
            }}
          >
            ✦ スタイル
          </button>
        </footer>
      )}
    </div>
  );
}

// =========================================================
// 結果表示
// =========================================================
function ResultDisplay({ results, formula, isMobile }) {
  const { rolls, total, modifier } = results;
  const hasCrit = hasCritical(rolls);
  const fumble = hasFumble(rolls);

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: isMobile ? 4 : 6,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="grimoire-h" style={{ fontSize: 9, color: '#a89570', letterSpacing: '0.3em', opacity: 0.7 }}>
            Result · 結果
          </div>
          <div style={{
            fontSize: isMobile ? 10 : 12, color: '#a89570', marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{formula}</div>
        </div>
        <div className={`grimoire-h result-glow ${hasCrit ? 'critical' : ''} ${fumble ? 'fumble' : ''}`} style={{
          fontSize: isMobile ? 32 : 42, fontWeight: 700, color: '#f4d976', lineHeight: 1,
          flexShrink: 0,
        }}>
          {total}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {rolls.map((r, i) => (
          <span key={i} style={{
            padding: '2px 7px',
            background: 'rgba(0,0,0,0.4)',
            border: `1px solid ${
              r.type === 'd20' && r.value === 20 ? '#ffd76a' :
              r.type === 'd20' && r.value === 1 ? '#c84a3a' :
              'rgba(180,140,80,0.3)'}`,
            borderRadius: 3, fontSize: isMobile ? 10 : 11, color: '#f4d976',
            fontFamily: 'Cinzel, serif', letterSpacing: '0.06em',
          }}>
            {r.label}: <strong>{r.value}</strong>
          </span>
        ))}
        {modifier !== 0 && (
          <span style={{
            padding: '2px 7px', background: 'rgba(0,0,0,0.4)',
            border: '1px dashed rgba(180,140,80,0.4)',
            borderRadius: 3, fontSize: isMobile ? 10 : 11, color: '#a89570',
            fontFamily: 'Cinzel, serif',
          }}>
            MOD: <strong>{modifier > 0 ? `+${modifier}` : modifier}</strong>
          </span>
        )}
      </div>
      {hasCrit && (
        <div className="grimoire-h critical" style={{ marginTop: 4, fontSize: isMobile ? 10 : 11, letterSpacing: '0.25em' }}>
          ⚔ CRITICAL SUCCESS ⚔
        </div>
      )}
      {fumble && (
        <div className="grimoire-h fumble" style={{ marginTop: 4, fontSize: isMobile ? 10 : 11, letterSpacing: '0.25em' }}>
          ✗ CRITICAL FAILURE ✗
        </div>
      )}
    </div>
  );
}
