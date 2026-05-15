# CLAUDE.md

3D TRPG ダイスロール SPA (React + Three.js + Tone.js)。Vite 6 + React 18 + Vitest 3 のスタンドアロン SPA リポジトリ。

## 作業前に docs/ を読む

`docs/ARCHITECTURE.md` にモジュール構成・主な export・`App.jsx`（2775行）の行範囲別内訳・テスト配置・注意点がまとまっている。**ソースを調査・改修する前に必ず読むこと。** `App.jsx` を全読せず作業位置を特定できる。

- docs と実コードが食い違う場合は実コードが正。docs を更新する。
- 構成（モジュールの追加 / 削除 / 責務変更、エクスポートの変更）を変えたら、同じコミットで `docs/ARCHITECTURE.md` も更新する。

## 規約

- 純粋ロジック（ダイス計算・設定データ）は `src/logic` `src/data` に分離し Vitest でテストする。
- THREE / Tone / React に密結合したコードは import 時に副作用を持たせない。純粋モジュールは Node 環境でテスト可能に保つ。
- 既存挙動を変えるリファクタは避け、コードの移動を優先する。

## コマンド

`npm install`（初回）/ `npm run dev` / `npm test` / `npm run build` / `npm run format`
