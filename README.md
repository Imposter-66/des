# 🌍 理科クイズ！地球破壊オンライン（バトルロイヤル版）

理科クイズで他のプレイヤーの星を破壊する、オンライン多人数対戦ゲームです。
判定・ダメージ計算・コイン付与・パスワード管理はすべて**サーバー側**で行うので、ブラウザを改ざんしてもズルはできません。

---

## 📦 ファイル構成

GitHub に置くファイルは次の **5つ** です。

| ファイル | 役割 | 入手方法 |
|---|---|---|
| `index.html` | 画面（フロントエンド） | 生成済み |
| `server.js` | サーバー（API・ゲームの判定） | 生成済み |
| `README.md` | このファイル | 生成済み |
| `vercel.json` | Vercel の設定（下の「設定ファイル」をコピペ） | 下記 |
| `package.json` | Node のバージョン指定（下の「設定ファイル」をコピペ） | 下記 |

### 設定ファイル（コピペ用）

**`vercel.json`**（ファイル名もこのとおりに）

```json
{
  "version": 2,
  "builds": [
    { "src": "server.js", "use": "@vercel/node" },
    { "src": "index.html", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/server.js" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```

**`package.json`**

```json
{
  "name": "chikyu-hakai-online",
  "version": "2.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "engines": { "node": "24.x" }
}
```

> 💡 追加のライブラリ（`npm install`）は **不要** です。外部サービスは Node 標準の機能だけで呼んでいます。

---

## 🚀 デプロイ手順（初心者向け・全部ブラウザだけでできます）

### 手順1：GitHub にファイルを置く

1. https://github.com にログインし、右上の **＋ → New repository** をクリック。
2. Repository name に `earth-destroy-online` など好きな名前を入れ、**Create repository**。
3. 作成後の画面で **「uploading an existing file」** をクリックし、`index.html`・`server.js`・`README.md` の3つをドラッグ＆ドロップ → **Commit changes**。
4. 次に **Add file → Create new file** を押し、ファイル名に `vercel.json` と入力。上の `vercel.json` の中身を貼り付けて **Commit changes**。
5. もう一度 **Add file → Create new file** で `package.json` を同じように作成。

これで GitHub 側は完了です。

### 手順2：Vercel でデプロイ

1. https://vercel.com に **GitHub アカウントでログイン**。
2. **Add New… → Project** をクリックし、先ほどのリポジトリの **Import** を押す。
3. 設定は何も変えずに **Deploy**。
4. 数十秒で完成します。ただし**この時点ではまだデータベースが無いので、ログインや登録はできません**（次の手順3へ）。

### 手順3：データベース（Upstash Redis）をつなぐ ⭐重要

1. Vercel のプロジェクト画面で上のメニュー **Storage** を開く。
2. **Create Database（または Browse Marketplace）** → **Upstash** → **Upstash Redis** を選び、画面の案内どおりに作成（無料プランでOK）。リージョンは日本に近い所（例：`ap-northeast-1` 東京）がおすすめ。
3. 作成したデータベースを、このプロジェクトに **Connect（接続）** する。
   → 自動で環境変数（`KV_REST_API_URL` と `KV_REST_API_TOKEN`、または `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN`）が追加されます。どちらの名前でも動きます。
4. 上のメニュー **Deployments** → 一番上のデプロイの **︙ → Redeploy** で、再デプロイします。

### 手順4：動作確認

1. デプロイされた URL（`https://〜.vercel.app`）を開く。
2. 右上の **ログイン → アカウント作成** でアカウントを作る。
3. 別のブラウザ（またはスマホ）でも別アカウントを作り、片方で **ルーム作成**、もう片方で **参加** → **ゲーム開始！**

URL の後ろに `/api/health` を付けて開くと、`{"ok":true,"db":"upstash",...}` と出れば、データベース接続は成功です。

---

## 🔐 環境変数

**基本的には何も設定しなくて動きます。** 必要なのは手順3で自動追加される Upstash の2つだけです。

| 名前 | 必須 | 説明 |
|---|---|---|
| `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL` | ✅ | Upstash の接続先（手順3で自動設定） |
| `KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash の接続用トークン（手順3で自動設定） |
| `SESSION_SECRET` | 任意 | ログイン用の署名キー（16文字以上）。**未設定ならサーバーが初回に自動生成してDBに保存**します。自分で決めたいときだけ、Vercel の Settings → Environment Variables に追加 |

> ⚠️ トークンや `SESSION_SECRET` は **絶対に GitHub に書かないでください**。Vercel の環境変数にだけ入れます。

---

## 💻 パソコンで試す（任意）

[Node.js](https://nodejs.org/) 18 以上を入れて、3ファイルのあるフォルダで：

```
node server.js
```

→ http://localhost:3000 を開く。環境変数が無い場合は **メモリ保存モード** で動きます（サーバーを止めるとデータは消えます）。

---

## 🏗️ 仕組み（なぜ安全になったか）

| 以前の問題 | 今の対策 |
|---|---|
| ダメージ計算・正解判定をブラウザでやっていた | **すべて `server.js`**。ブラウザは「選んだ番号」を送るだけ |
| 問題データに正解が入っていた | 出題中は**正解を一切送らない**。選択肢の並びもサーバーがシャッフル |
| 早押しの時刻をブラウザが決めていた | **サーバーの受信時刻**で判定 |
| コインをブラウザが自分で加算 | **サーバーだけが付与**（二重付与防止ロック・1日の上限つき） |
| パスワードをブラウザでハッシュ化 | サーバーで **scrypt＋ソルト**。ログイン状態は改ざん不可の署名つき Cookie（HttpOnly） |
| APIキーが丸見え | ブラウザに秘密情報は**ゼロ**。キーは環境変数のみ |
| プライベートルームの暗号が全員に見えた | 暗号は**ハッシュ化して保存**し、一覧APIにも含めない。総当たりは回数制限 |
| ホストのブラウザがゲームを進行 | **サーバーが進行**。ホストが落ちてもゲームは続く |
| DOM 直書きでスパゲッティ | `state` ＋ `render()` の一方向データフロー、`data-action` によるイベント委譲 |
| ユーザー名で XSS できた | 画面表示はすべて `textContent`（`innerHTML` に埋め込まない） |
| 1000人でブラウザが固まる | ライバル一覧は**見えている行だけ描画する仮想スクロール**。変化が無いときは通信も最小 |
| 問題がコードに埋め込み | `server.js` 冒頭の `BUILTIN_QUESTIONS` に分離（下記） |

### 通信の流れ

- ブラウザは 1秒ごとに `GET /api/rooms/:id/state?since=バージョン` で確認します。
- 変化が無ければ `{changed:false}` だけが返ります（極小）。変化があった時だけ全員分のHP等が届きます。
- 問題の締切・正解発表の切り替えは、「誰かのリクエストが来た時に、期限を過ぎていたらサーバーが進める」方式です（Vercel は常駐できないため）。同時実行はロックで1回だけに制御します。

### API 一覧

```
GET  /api/health  /api/meta  /api/me  /api/rooms  /api/rooms/:id/state?since=N
POST /api/auth/register  /api/auth/login  /api/auth/logout
POST /api/rooms  /api/rooms/:id/join  /leave  /start  /answer
POST /api/shop/skill/upgrade  /skill/equip  /skin/buy  /skin/select
```

---

## ➕ 問題を追加するには

`server.js` を開き、`BUILTIN_QUESTIONS` の中に1行足します（GitHub 上で鉛筆アイコン✏️から編集できます）。

```js
{ id: 'q035', term: '3学期', unit: '人と環境', q: '問題文', o: ['選択肢1', '選択肢2', '選択肢3', '選択肢4'], a: 0 },
```

- `a` は正解の番号（**0始まり**：1番目が正解なら `0`）
- `term`（学期）と `unit`（単元）を新しい名前にすると、ルーム作成画面に**自動で**チェックボックスが増えます。
- 選択肢は2〜6個まで。`id` は他と重ならない文字列にしてください（省略すると自動採番）。

編集後に Commit すると、Vercel が自動で再デプロイします。

---

## ⚠️ 知っておいてほしい制限

- **旧バージョンのアカウントは引き継げません**（パスワードの保存方式が変わったため）。新しく作り直してください。
- **リアルタイムは約1秒遅れ**のポーリング方式です。本物の WebSocket が必要になったら、`server.js` を Render などの常駐サーバーに置く構成に移行できます。
- **Upstash の無料枠にはコマンド数の上限があります**（最新の上限は Upstash の料金ページで確認してください）。1ゲーム中は参加者ぶんだけ毎秒リクエストが発生するので、大人数で長時間遊ぶと上限に達することがあります。その場合は Upstash の有料プラン（従量課金）に切り替えてください。
- **1000人対戦**は設計上は対応していますが、実際の人数での負荷試験はしていません。Vercel の関数の実行時間制限や Upstash のプランによって制約を受けます。
- 画面のデザインには Tailwind の **CDN 版**を使っています（ビルド不要で簡単な反面、公式には本番非推奨）。本格的に公開するときは、Tailwind をビルドして CSS ファイルにまとめる構成への移行をおすすめします。
- 同じユーザーが同時に複数のルームには入れません。ゲーム中にページを再読み込みしても、ログインすれば元のルームに自動で戻ります。
- 試合で稼げるコインは、1人あたり**1日 5000 まで**（複数アカウントでの周回対策）。`server.js` の `CONFIG.DAILY_COIN_CAP` で変更できます。
- ゲームは最大 40 問で終了し、生き残りが複数いる場合は残りHPで順位を決めます（`CONFIG.MAX_QUESTIONS`）。

## 🛠️ トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 「データベース(Upstash Redis)が設定されていません」と出る | 手順3が未完了、または再デプロイしていません。Storage でプロジェクトに接続したあと **Redeploy** してください |
| `/api/health` が 404 | `vercel.json` が置かれていない、または名前が違います |
| 画面は出るがログインできない | `/api/health` を開いて `db` が `upstash` になっているか確認 |
| 「混み合っています」 | 同時操作が重なっただけです。もう一度押してください |
| ログインが急に切れる | Cookie を消した、または7日経過しました。再ログインしてください |
