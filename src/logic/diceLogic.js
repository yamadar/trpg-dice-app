// =========================================================
// 純粋なダイス / 数学ロジック
// React / THREE / Tone / DOM / window への依存なし。
// import 時の副作用なし → unit-test 可能。
// =========================================================

import { DICE_TYPES } from '../data/diceConfig.js';

// 衝突 & 床着地時の中心Y = 外接球半径（頂点めり込み防止）
export function getDiceRadius(id) {
  switch (id) {
    case 'd4':   return 1.1;
    case 'd6':   return 1.1;
    case 'd8':   return 1.1;
    case 'd10':  return 1.05;
    case 'd100': return 1.05;
    case 'd12':  return 1.05;
    case 'd20':  return 1.05;
    default:     return 1.0;
  }
}

export function getNumberSize(id) {
  switch (id) {
    case 'd4':   return 0.5;
    case 'd6':   return 0.85;
    case 'd8':   return 0.6;
    case 'd10':  return 0.55;
    case 'd100': return 0.5;
    case 'd12':  return 0.55;
    case 'd20':  return 0.5;
    default:     return 0.5;
  }
}

// 面 index から面に描く文字ラベルへ
export function getFaceLabel(typeId, faceIndex) {
  if (typeId === 'd100') return (faceIndex * 10).toString().padStart(2, '0');
  if (typeId === 'd10')  return faceIndex.toString();
  return (faceIndex + 1).toString();
}

// 面 index からダイスの値へ
export function faceIndexToValue(typeId, faceIndex) {
  if (typeId === 'd10') return faceIndex === 0 ? 10 : faceIndex; // 「0」は10として読む慣習
  if (typeId === 'd100') return faceIndex * 10;
  return faceIndex + 1;
}

// =========================================================
// 色の明度計算（THREE.Color 非依存の純粋実装）
// THREE.Color(hex) は sRGB → リニア変換を行うため、それを再現する。
// =========================================================
function _srgbToLinear(c) {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// "#rrggbb" / "rrggbb" を受け取り、リニアRGB { r, g, b } を返す
export function hexToLinearRgb(hex) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return { r: _srgbToLinear(r), g: _srgbToLinear(g), b: _srgbToLinear(b) };
}

// 知覚的明度（ITU-R BT.601）。0=黒, 1=白
export function colorLuminance(hex) {
  const c = hexToLinearRgb(hex);
  return c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
}

// 数字のスタイル（インク・太字・縁取り）をマテリアル×色テーマで決定
// mainColorObj: { r, g, b } を持つ色オブジェクト（THREE.Color 互換）
// 戻り値: { ink, bolder, outlineColor, outlineWidth }
export function decideNumberStyle(material, colorTheme, mainColorObj) {
  const inkHex = colorTheme.ink;
  const inkLum = colorLuminance(inkHex);
  const bgLum = mainColorObj.r * 0.299 + mainColorObj.g * 0.587 + mainColorObj.b * 0.114;
  // インクと背景の明度差（コントラスト）
  const contrast = Math.abs(inkLum - bgLum);

  let bolder = false;
  let outlineColor = null;
  let outlineWidth = 0;

  // 素材ごとの基本設定
  if (material === 'acrylic') {
    bolder = true;
  } else if (material === 'wood') {
    bolder = true;
    outlineColor = inkLum > 0.5 ? 'rgba(20, 12, 5, 0.85)' : 'rgba(240, 220, 180, 0.85)';
    outlineWidth = 4;
  } else if (material === 'metal') {
    bolder = true;
  } else if (material === 'gemstone') {
    bolder = true;
    outlineColor = 'rgba(0, 0, 0, 0.5)';
    outlineWidth = 3;
  } else if (material === 'resin') {
    bolder = true;
    outlineColor = inkLum > 0.5 ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)';
    outlineWidth = 3;
  }

  // コントラスト不足の場合は縁取り追加 / 強化
  if (contrast < 0.30) {
    const outlineLum = inkLum > 0.5 ? 0 : 1;
    const oc = `rgba(${outlineLum * 255}, ${outlineLum * 255}, ${outlineLum * 255}, 0.85)`;
    if (!outlineColor) {
      outlineColor = oc;
      outlineWidth = 5;
    } else {
      outlineWidth = Math.max(outlineWidth, 5);
    }
  }

  return { ink: inkHex, bolder, outlineColor, outlineWidth };
}

// =========================================================
// ロールの式・集計ロジック（純粋）
// =========================================================

// diceCounts: { d4, d6, ... } と modifier から表示用の式を組み立てる
// 例: { d20: 2, d6: 1 }, +3 → "2d20 + 1d6 +3"
export function buildFormula(diceCounts, modifier, diceTypes = DICE_TYPES) {
  const parts = [];
  diceTypes.forEach(d => {
    if (diceCounts[d.id] > 0) parts.push(`${diceCounts[d.id]}${d.label.toLowerCase()}`);
  });
  let f = parts.join(' + ') || '—';
  if (modifier > 0) f += ` +${modifier}`;
  else if (modifier < 0) f += ` ${modifier}`;
  return f;
}

// 選択中のダイス総数
export function totalDiceCount(diceCounts) {
  return Object.values(diceCounts).reduce((a, b) => a + b, 0);
}

// ダイス種別 id を delta だけ増減した新しい diceCounts を返す（純粋）。
// 1 種別あたり maxPerType、全体で maxTotal を超えない範囲にクランプする。
// 上限に達している場合は増加分が無視される（盤面の破綻防止）。
export function adjustDiceCount(
  diceCounts, id, delta,
  { maxTotal = Infinity, maxPerType = Infinity } = {},
) {
  const current = diceCounts[id] || 0;
  const othersTotal = totalDiceCount(diceCounts) - current;
  let next = current + delta;
  next = Math.max(0, Math.min(next, maxPerType));
  next = Math.min(next, Math.max(0, maxTotal - othersTotal));
  return { ...diceCounts, [id]: next };
}

// rolls 配列（[{ type, value, label }]）と modifier から合計を出す
export function evaluateRolls(rolls, modifier = 0) {
  return rolls.reduce((s, r) => s + r.value, 0) + modifier;
}

// d20 のクリティカル（=20）・ファンブル（=1）判定
export function hasCritical(rolls) {
  return rolls.some(r => r.type === 'd20' && r.value === 20);
}

export function hasFumble(rolls) {
  return rolls.some(r => r.type === 'd20' && r.value === 1);
}

// =========================================================
// RNG とダイスロール（注入可能 RNG でテスト可能）
// rng: () => number  (0 <= n < 1)。省略時は Math.random。
// =========================================================

// 面数 faces のダイスを 1 回振り、1..faces の整数を返す
export function rollDie(faces, rng = Math.random) {
  return Math.floor(rng() * faces) + 1;
}

// typeId のダイスの「物理的な面数」。
// d100 はパーセンタイルダイスで物理的には 10 面（00,10,...,90）。
function physicalFaceCount(typeId, type) {
  return typeId === 'd100' ? 10 : type.faces;
}

// typeId（'d4' 等）のダイスを 1 回振り、ゲーム上の値を返す。
// d100 は 0,10,...,90 の慣習に従う。
export function rollDieByType(typeId, rng = Math.random, diceTypes = DICE_TYPES) {
  const type = diceTypes.find(d => d.id === typeId);
  if (!type) throw new Error(`unknown dice type: ${typeId}`);
  const faceIndex = Math.floor(rng() * physicalFaceCount(typeId, type)); // 0..faces-1
  return faceIndexToValue(typeId, faceIndex);
}
