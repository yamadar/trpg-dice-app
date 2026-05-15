# Astaroth's Bones · TRPG Dice Roller

3D TRPGダイスロールSPA。標準7点セット（d4/d6/d8/d10/d%/d12/d20）対応。素材・色テーマ・ボードテーマ組合せ自由。Three.js + Tone.js。

## 必要環境
- Node.js 18+ （推奨: 20+）
- npm

## 起動

```bash
npm install
npm run dev
```

`http://localhost:5173/` がブラウザで自動起動。

## ビルド

```bash
npm run build
npm run preview
```

## 操作

- 左パネル: ダイス種類ごとに +/- で個数指定、修正値設定、`CAST THE BONES` で振る
- 右パネル: 素材（5種）、色テーマ（8種）、盤面（6種）切替
- 結果が出るとクリティカル（d20=20）・ファンブル（d20=1）演出
- 音声トグル: ヘッダー右の `♪ ON/OFF`

## 構成

```
trpg-dice-app/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx
    └── App.jsx   ← メインコンポーネント
```

## 既知の制約

- Tone.jsは初回ロール時にユーザー操作トリガで起動（ブラウザのオーディオポリシー対応）
- 物理は簡易シミュレーション（厳密な剛体物理ではない）
- d10は自前 pentagonal trapezohedron ジオメトリ。数字テクスチャは未貼付（モック段階）
