# trpg-dice-app（astaroths-bones）— アーキテクチャ

3D TRPG ダイスロール SPA。React 18 + Three.js + Tone.js、Vite 6。
標準 7 点セット（d4/d6/d8/d10/d%/d12/d20）対応。

## モジュール構成（`src/`）

| ファイル | 役割 | 主な export |
| --- | --- | --- |
| `data/diceConfig.js` | **純粋データ** | `DICE_TYPES` `MAX_TOTAL_DICE` `MAX_DICE_PER_TYPE` `BOARD_THEMES` `MATERIALS` `COLOR_THEMES` `SOUND_PRESETS` |
| `logic/diceLogic.js` | **純粋ロジック** | `getDiceRadius` `getNumberSize` `getFaceLabel` `faceIndexToValue` `hexToLinearRgb` `colorLuminance` `decideNumberStyle` `buildFormula` `totalDiceCount` `adjustDiceCount` `evaluateRolls` `hasCritical` `hasFumble` `rollDie` `rollDieByType` |
| `App.jsx` | メインコンポーネント（約 2980 行） | `default TRPGDiceRoller`（L1230〜） |
| `main.jsx` | React エントリ | — |

### `App.jsx` の内訳（全読せず把握するため）

- **L1–1228**: Three.js 系の形状 / テクスチャ生成（`getDiceGeometry` `createPentagonalTrapezohedron` `computeFaceData` `smoothDiceGeometry`、盤面 / 木目テクスチャ、内包物、影）、`findTopFaceIndex`（ライブメッシュ操作）、`DiceSound` クラス（Web Audio / Tone）。
- **L1230 以降**: React コンポーネント本体（state・簡易物理シミュレーション・UI）。
- これらは Three.js / Tone.js / React に密結合のため抽出せず `App.jsx` に残置。純粋ロジックのみ `data/` `logic/` へ分離済み。

### ダイス構築（`App.jsx` 内）

- `disposeDie` / `clearDiceMeshes`: メッシュと contact shadow の GPU リソース解放。
- `createDieEntry`: ダイス 1 個分のメッシュ生成（`makeDieMesh` を含む重い処理）。
- `layoutDice`: 現ダイス群を円形プレイ領域内に sunflower（黄金角）配置。各ダイスは実ジオメトリ最下点が床に接する Y を設定（めり込み / 浮き防止）。
- `rebuildDice`: 全破棄して再生成（**素材・色テーマ変更時**）。
- `syncDiceCount`: `diceCounts` との差分だけ追加 / 削除（**個数変更時**）。多数のダイスを増やしても 1 個追加分の処理量で済む。
- どちらを呼ぶかは `prevAppearanceRef`（直前の素材・色テーマ）で判定。

## テスト

- `data/diceConfig.test.js`(10) `logic/diceLogic.test.js`(49) — 計 59 件。RNG は注入可能（`rng` 引数）で決定的。
- React コンポーネント / Three.js 描画はテスト対象外。

## 注意点

- d10/d% は自前の pentagonal trapezohedron。d100 は物理面 10、値は ×10 → `rollDieByType('d100')` は 0,10,…,90 を返す。
- `colorLuminance` は `THREE.Color` と同じ sRGB→linear 変換を再現（`hexToLinearRgb`）。
- App は実ロール値を物理から取得するため `rollDie` / `rollDieByType` は App 本体では未使用。テスト対象の純粋ロジックとして保持。
- ダイス総数は `MAX_TOTAL_DICE`、種別ごとは `MAX_DICE_PER_TYPE` で上限を設け、盤面の破綻を防ぐ。増減は純粋関数 `adjustDiceCount` でクランプ。
- ダイス 0 個のときは盤面を空にする（プレースホルダは表示しない）。
- 物理ループのフェーズ 1 の床補正は rolling 中のダイスのみ、かつフェーズ 2（ダイス同士の押し出し）より前に走る。押し出しで床下へ潜るのを防ぐため、フェーズ 2.5 で全ダイスを実ジオメトリの最下点基準に床上へ補正する（描画前の最終位置）。
- フェーズ 2 で衝突したダイスは接地済み（rolling=false）でも物理を再開させる。再開しないと衝突解決の対象外になり、押し出された接地済みダイスが隣のダイスへめり込んだまま固定されるため。
- ビルド時に >500 kB チャンク警告が出るが既知・無害。

## コマンド

`npm install`（初回）/ `npm run dev` / `npm test` / `npm run build` / `npm run format`
