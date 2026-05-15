# trpg-dice-app（astaroths-bones）— アーキテクチャ

3D TRPG ダイスロール SPA。React 18 + Three.js + Tone.js、Vite 6。
標準 7 点セット（d4/d6/d8/d10/d%/d12/d20）対応。

## モジュール構成（`src/`）

| ファイル | 役割 | 主な export |
| --- | --- | --- |
| `data/diceConfig.js` | **純粋データ** | `DICE_TYPES` `BOARD_THEMES` `MATERIALS` `COLOR_THEMES` `SOUND_PRESETS` |
| `logic/diceLogic.js` | **純粋ロジック** | `getDiceRadius` `getNumberSize` `getFaceLabel` `faceIndexToValue` `hexToLinearRgb` `colorLuminance` `decideNumberStyle` `buildFormula` `totalDiceCount` `evaluateRolls` `hasCritical` `hasFumble` `rollDie` `rollDieByType` |
| `App.jsx` | メインコンポーネント（2775 行） | `default TRPGDiceRoller`（L1229〜） |
| `main.jsx` | React エントリ | — |

### `App.jsx` の内訳（全読せず把握するため）

- **L1–1228**: Three.js 系の形状 / テクスチャ生成（`getDiceGeometry` `createPentagonalTrapezohedron` `computeFaceData` `smoothDiceGeometry`、盤面 / 木目テクスチャ、内包物、影）、`findTopFaceIndex`（ライブメッシュ操作）、`DiceSound` クラス（Web Audio / Tone）。
- **L1229–2775**: React コンポーネント本体（state・簡易物理シミュレーション・UI）。
- これらは Three.js / Tone.js / React に密結合のため抽出せず `App.jsx` に残置。純粋ロジックのみ `data/` `logic/` へ分離済み。

## テスト

- `data/diceConfig.test.js`(8) `logic/diceLogic.test.js`(42) — 計 50 件。RNG は注入可能（`rng` 引数）で決定的。
- React コンポーネント / Three.js 描画はテスト対象外。

## 注意点

- d10/d% は自前の pentagonal trapezohedron。d100 は物理面 10、値は ×10 → `rollDieByType('d100')` は 0,10,…,90 を返す。
- `colorLuminance` は `THREE.Color` と同じ sRGB→linear 変換を再現（`hexToLinearRgb`）。
- App は実ロール値を物理から取得するため `rollDie` / `rollDieByType` は App 本体では未使用。テスト対象の純粋ロジックとして保持。
- ビルド時に >500 kB チャンク警告が出るが既知・無害。

## コマンド

`npm run dev|test|build -w trpg-dice-app`
