// =========================================================
// 定義データ（純粋な設定オブジェクト）
// React / THREE / Tone / DOM への依存なし。安全に import / unit-test 可能。
// =========================================================

export const DICE_TYPES = [
  { id: 'd4',   faces: 4,   label: 'D4'   },
  { id: 'd6',   faces: 6,   label: 'D6'   },
  { id: 'd8',   faces: 8,   label: 'D8'   },
  { id: 'd10',  faces: 10,  label: 'D10'  },
  { id: 'd100', faces: 100, label: 'D%'   },
  { id: 'd12',  faces: 12,  label: 'D12'  },
  { id: 'd20',  faces: 20,  label: 'D20'  },
];

// 円形プレイ領域に過密なく配置できるダイスの総数上限。
// これを超えると盤面からはみ出す / めり込むため UI 側で増加を止める。
export const MAX_TOTAL_DICE = 20;
// 1 種別あたりの上限。
export const MAX_DICE_PER_TYPE = 20;

export const BOARD_THEMES = {
  oak:       { name: 'オーク卓', felt: '#2a1a0e', edge: '#6b4a2a', glow: '#8b6f47', vignette: '#000000', sound: 'wood_table' },
  marble:    { name: '大理石',   felt: '#d8d0c4', edge: '#7a7570', glow: '#aaa298', vignette: '#3a3530', sound: 'stone' },
  void:      { name: '虚空',     felt: '#0a0518', edge: '#2a1a4a', glow: '#5a3aaa', vignette: '#000000', sound: 'soft' },
  cavern:    { name: '洞窟',     felt: '#1a1410', edge: '#3a2a1a', glow: '#6a4a2a', vignette: '#000000', sound: 'stone' },
  parchment: { name: '古地図',   felt: '#b39871', edge: '#6e4a1a', glow: '#8a6730', vignette: '#3a2a10', sound: 'felt' },
  battle:    { name: '戦場',     felt: '#28321e', edge: '#5a5030', glow: '#8a7340', vignette: '#0a0a05', sound: 'felt' },
};

export const MATERIALS = {
  acrylic:  { name: 'フロスト', metalness: 0.0,  roughness: 0.95, opacity: 0.55, transparent: true,  sound: 'plastic' },
  resin:    { name: 'レジン',   metalness: 0.05, roughness: 0.08, opacity: 0.55, transparent: true,  sound: 'resin'   },
  metal:    { name: 'メタル',   metalness: 0.98, roughness: 0.22, opacity: 1.0,  transparent: false, sound: 'metal'   },
  gemstone: { name: '宝石',     metalness: 0.55, roughness: 0.02, opacity: 0.78, transparent: true,  sound: 'crystal' },
  wood:     { name: '木材',     metalness: 0.0,  roughness: 0.82, opacity: 1.0,  transparent: false, sound: 'wood'    },
};

export const COLOR_THEMES = {
  dragonEye: { name: 'ドラゴンアイ', primary: '#2a7a3a', secondary: '#f4c425', emissive: '#1a4015', ink: '#fff0a0' },
  nebula:    { name: 'ネビュラ',     primary: '#5a2a8c', secondary: '#a070ff', emissive: '#2a1a5a', ink: '#f0d8ff' },
  ocean:     { name: '深海',         primary: '#1a5a9c', secondary: '#5ab0d4', emissive: '#0a3a6a', ink: '#d8f0ff' },
  forest:    { name: '深森',         primary: '#3a6a1a', secondary: '#8cba4a', emissive: '#1a3a08', ink: '#eaf6c8' },
  flame:     { name: '紅蓮',         primary: '#a02a0a', secondary: '#f48a27', emissive: '#5a1a02', ink: '#ffe8c8' },
  sacred:    { name: '神聖',         primary: '#f0e8d0', secondary: '#e4c027', emissive: '#5a4520', ink: '#3a2a10' },
  shadow:    { name: '影',           primary: '#3a1a3a', secondary: '#8a5aaa', emissive: '#1a0a1a', ink: '#dabbe8' },
  venom:     { name: '毒',           primary: '#5a7a1a', secondary: '#d4f427', emissive: '#2a3a02', ink: '#202010' },
};

// =========================================================
// 物理ベースのモーダル合成サウンドのプリセット
// 各 mode = { freq: 共鳴周波数Hz, decay: 減衰時間秒, amp: 振幅 }
// noise = 打撃時の瞬間ノイズ成分
// =========================================================
export const SOUND_PRESETS = {
  // === ダイス素材 ===
  wood: {
    modes: [
      { freq: 180,  decay: 0.14,  amp: 0.55 },
      { freq: 420,  decay: 0.09,  amp: 0.32 },
      { freq: 880,  decay: 0.04,  amp: 0.15 },
      { freq: 1450, decay: 0.025, amp: 0.08 },
    ],
    noise: { decay: 0.014, amp: 0.28, filterFreq: 700, filterQ: 1.0, type: 'brown' },
    gain: 0.9,
  },
  plastic: {
    modes: [
      { freq: 1400, decay: 0.045, amp: 0.45 },
      { freq: 2800, decay: 0.028, amp: 0.28 },
      { freq: 4200, decay: 0.018, amp: 0.14 },
      { freq: 6200, decay: 0.010, amp: 0.07 },
    ],
    noise: { decay: 0.008, amp: 0.20, filterFreq: 3500, filterQ: 0.7, type: 'white' },
    gain: 0.85,
  },
  resin: {
    modes: [
      { freq: 900,  decay: 0.075, amp: 0.45 },
      { freq: 2100, decay: 0.050, amp: 0.28 },
      { freq: 3800, decay: 0.025, amp: 0.14 },
      { freq: 5400, decay: 0.015, amp: 0.07 },
    ],
    noise: { decay: 0.012, amp: 0.20, filterFreq: 2500, filterQ: 0.7, type: 'white' },
    gain: 0.88,
  },
  metal: {
    // 非整数倍音（ベル状）, Helmholtz比に近い
    // 基音を低めにして「重みのある金属」の音色に
    modes: [
      { freq: 620,  decay: 0.7,  amp: 0.34 },
      { freq: 1710, decay: 0.55, amp: 0.26 },
      { freq: 3350, decay: 0.40, amp: 0.18 },
      { freq: 5530, decay: 0.30, amp: 0.12 },
      { freq: 8270, decay: 0.22, amp: 0.07 },
    ],
    noise: { decay: 0.005, amp: 0.18, filterFreq: 5000, filterQ: 0.6, type: 'white' },
    gain: 0.78,
  },
  crystal: {
    // 宝石: 基音を低めに、深みと澄んだ余韻のバランス
    modes: [
      { freq: 1450, decay: 0.45, amp: 0.40 },
      { freq: 3150, decay: 0.32, amp: 0.28 },
      { freq: 4700, decay: 0.22, amp: 0.18 },
      { freq: 6600, decay: 0.14, amp: 0.10 },
      { freq: 8700, decay: 0.10, amp: 0.06 },
    ],
    noise: { decay: 0.004, amp: 0.15, filterFreq: 7000, filterQ: 0.55, type: 'white' },
    gain: 0.75,
  },

  // === ボード床素材 ===
  wood_table: {
    // 厚いオーク卓: 重く低い、減衰やや長め
    modes: [
      { freq: 95,  decay: 0.22, amp: 0.55 },
      { freq: 220, decay: 0.14, amp: 0.32 },
      { freq: 480, decay: 0.07, amp: 0.16 },
      { freq: 880, decay: 0.04, amp: 0.08 },
    ],
    noise: { decay: 0.020, amp: 0.32, filterFreq: 500, filterQ: 1.2, type: 'brown' },
    gain: 1.0,
  },
  stone: {
    // 大理石・石: 硬く、短く、わずかに鋭い反響
    modes: [
      { freq: 320,  decay: 0.08, amp: 0.48 },
      { freq: 880,  decay: 0.05, amp: 0.32 },
      { freq: 2200, decay: 0.03, amp: 0.20 },
      { freq: 4400, decay: 0.018, amp: 0.10 },
    ],
    noise: { decay: 0.006, amp: 0.22, filterFreq: 2800, filterQ: 0.6, type: 'white' },
    gain: 0.85,
  },
  felt: {
    // フェルト・布: 柔らかく、低周波寄り、明確な共鳴なし
    modes: [
      { freq: 70,  decay: 0.07, amp: 0.40 },
      { freq: 150, decay: 0.05, amp: 0.22 },
    ],
    noise: { decay: 0.028, amp: 0.42, filterFreq: 280, filterQ: 0.9, type: 'brown' },
    gain: 0.75,
  },
  soft: {
    // 虚空: 柔らかく、サブベース寄り、空間的
    modes: [
      { freq: 110, decay: 0.12, amp: 0.38 },
      { freq: 240, decay: 0.07, amp: 0.22 },
    ],
    noise: { decay: 0.035, amp: 0.32, filterFreq: 420, filterQ: 0.7, type: 'brown' },
    gain: 0.70,
  },
};
