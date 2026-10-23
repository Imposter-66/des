'use strict';
/**
 * 地球破壊オンライン - サーバー (server.js)
 * ------------------------------------------------------------
 *  ・Vercel の Node 関数としても、`node server.js` のローカル起動としても動きます。
 *  ・状態の保存は Upstash Redis（Vercel の Storage から追加）。
 *    ローカルで環境変数が無い場合だけ「メモリ保存」で動きます（再起動で消えます）。
 *  ・ログインは「GAKU acct」（学校のスプレッドシートのアカウント）だけを使います。
 *    ブラウザに届いた「確認コード」を、このサーバーが GAKU acct のサーバーに送って本人確認します。
 *    （パスワードはこのゲームには一切届きません。保存もしません。）
 *  ・判定・ダメージ計算・コイン付与は、すべてこのサーバーで行います。
 *    ブラウザ(index.html)は「入力を送る」「結果を表示する」だけです。
 *
 *  目次
 *   1. 設定 / スキル・スキン定義
 *   2. 問題データ (QuestionRepo)
 *   3. データベース層 (Upstash / メモリ)
 *   4. 共通ユーティリティ (エラー・ロック・レート制限)
 *   5. 認証 (GAKU acct の確認コード + 署名付きCookie)
 *   6. ルーム管理 / ゲームエンジン
 *   7. ショップ
 *   8. ルーティングと HTTP ハンドラ
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================================================
 * 1. 設定 / スキル・スキン定義
 * ============================================================ */
const CONFIG = {
  QUESTION_MS: 12000,          // 1問の制限時間
  REVEAL_MS: 5000,             // 正解発表の表示時間
  RESOLVE_GRACE_MS: 600,       // 締切後、判定を実行するまでの猶予（通信遅延ぶん）
  BASE_DAMAGE: 20,             // 不正解のダメージ
  MAX_QUESTIONS: 40,           // これを超えたらHPで順位を決めて終了（無限ループ防止）
  MIN_PLAYERS_TO_START: 2,
  MAX_PLAYER_CHOICES: [2, 4, 10, 50, 100, 1000],
  ROOM_TTL_PLAY: 3600,         // ルームの保存期間(秒)。更新のたびに延長
  ROOM_TTL_END: 900,           // 終了後の結果保持(秒)
  SESSION_DAYS: 7,
  SKILL_MAX_LEVEL: 10,
  MAX_EQUIPPED: 2,
  DAILY_COIN_CAP: 5000,        // 1ユーザーが1日に試合で稼げる上限（不正な周回対策）
  MIN_QUESTIONS_FOR_REWARD: 3, // これ未満で終わった試合はコイン無し
};

const SKILLS = [
  { id: 'attack',   name: '攻撃', desc: '1位正解時、不正解者への追加ダメージ +5 (Lvごと)', icon: 'ph-sword' },
  { id: 'hp',       name: '体力', desc: '最大HP +10 (Lvごと)', icon: 'ph-heart' },
  { id: 'evade',    name: '回避', desc: '不正解でもダメージを受けない確率 +5% (Lvごと)', icon: 'ph-wind' },
  { id: 'heal',     name: '回復', desc: '正解時にHP回復 +5 (Lvごと)', icon: 'ph-first-aid' },
  { id: 'critical', name: '会心', desc: '1位正解時、+30ダメージになる確率 +5% (Lvごと)', icon: 'ph-lightning' },
];

const SKINS = [
  { id: 'earth',   name: '地球',   cost: 0,   color: '#3b82f6' },
  { id: 'mars',    name: '火星',   cost: 200, color: '#ef4444' },
  { id: 'venus',   name: '金星',   cost: 200, color: '#fbbf24' },
  { id: 'mercury', name: '水星',   cost: 200, color: '#9ca3af' },
  { id: 'jupiter', name: '木星',   cost: 500, color: '#d97706' },
  { id: 'saturn',  name: '土星',   cost: 500, color: '#fde047' },
  { id: 'uranus',  name: '天王星', cost: 500, color: '#7dd3fc' },
  { id: 'neptune', name: '海王星', cost: 500, color: '#1e3a8a' },
];
const skillCost = (lv) => 50 + lv * 50;

/* GAKU acct（確認コードの照合先）
 * 環境変数 GAKU_ACCT_URL（ウェブアプリの /exec のURL）があればそれを使います。
 * 無ければ、下の2つを順番に試します。 */
const GAKU_ID = 'AKfycbyDnabgy3qc0L6Y4cfwW53tyzPMPS2thg1nd6mAvtIHa5YURK3Tui4c7vCUWt47sCow';
const GAKU_VERIFY_URLS = process.env.GAKU_ACCT_URL
  ? [String(process.env.GAKU_ACCT_URL).trim().replace(/[?#].*$/, '')]
  : [
    `https://script.google.com/macros/s/${GAKU_ID}/exec`,
    `https://script.google.com/a/macros/school.kasugai.ed.jp/s/${GAKU_ID}/exec`,
  ];

/* ============================================================
 * 2. 問題データ
 *    形式: { term:学期, unit:単元, q:問題文, o:[選択肢...], a:正解の番号(0始まり) }
 *    ★ 問題を足したいときは、下の配列に同じ形で1行ずつ足すだけです。
 *    ★ id を書かない場合は自動で q1, q2... が付きます。
 *       並び替えや削除をしても困らないように、できるだけ id を固定してください。
 * ============================================================ */
const BUILTIN_QUESTIONS = [
  // ---- 1学期 ----
  { term: '1学期', unit: '燃焼の仕組み', q: '物が燃えるためには、何という気体が必要？', o: ['二酸化炭素', '窒素', '酸素', '水素'], a: 2 },
  { term: '1学期', unit: '燃焼の仕組み', q: '物が燃えたあと、空気中で増える気体は何？', o: ['二酸化炭素', '窒素', '酸素', '水素'], a: 0 },
  { term: '1学期', unit: '燃焼の仕組み', q: 'ろうそくの火が消えるのは、空気中の何が減ったから？', o: ['二酸化炭素', '窒素', '酸素', '一酸化炭素'], a: 2 },
  { term: '1学期', unit: '燃焼の仕組み', q: '石灰水に二酸化炭素を通すとどうなる？', o: ['赤くなる', '青くなる', '白くにごる', '黄色になる'], a: 2 },
  { term: '1学期', unit: '植物の養分と水', q: '葉に日光が当たると作られる養分は？', o: ['タンパク質', '脂肪', 'デンプン', 'ビタミン'], a: 2 },
  { term: '1学期', unit: '植物の養分と水', q: 'デンプンがあるかを確かめるために使う薬品は？', o: ['石灰水', 'ヨウ素液', 'BTB溶液', '食塩水'], a: 1 },
  { term: '1学期', unit: '植物の養分と水', q: '植物が根から吸い上げた水が、葉から水蒸気として出ていくことを何という？', o: ['呼吸', '光合成', '蒸散', '発芽'], a: 2 },
  { term: '1学期', unit: '人や動物の体', q: '食べ物を体の中で吸収されやすい形に変える働きを何という？', o: ['消化', '吸収', '循環', '排泄'], a: 0 },
  { term: '1学期', unit: '人や動物の体', q: 'だ液によってデンプンは何に変わる？', o: ['別の養分(糖)', 'アミノ酸', '脂肪酸', '食物繊維'], a: 0 },
  { term: '1学期', unit: '人や動物の体', q: '空気中の酸素を取り入れ、二酸化炭素を出す働きを何という？', o: ['消化', '呼吸', '循環', '蒸散'], a: 1 },
  { term: '1学期', unit: '人や動物の体', q: '血液を全身に送り出すポンプの働きをしている器官は？', o: ['肺', '胃', '肝臓', '心臓'], a: 3 },
  { term: '1学期', unit: '人や動物の体', q: '体の中で出た不要なものをこし取り、尿をつくる器官はどこ？', o: ['胃', '小腸', '肝臓', '腎臓'], a: 3 },
  // ---- 2学期 ----
  { term: '2学期', unit: '生物と環境', q: '生物どうしの「食べる・食べられる」のつながりを何という？', o: ['食物連鎖', '食物網', '生態系', '弱肉強食'], a: 0 },
  { term: '2学期', unit: '生物と環境', q: '植物のように、自分で養分を作る生物を何という？', o: ['消費者', '生産者', '分解者', '捕食者'], a: 1 },
  { term: '2学期', unit: '月と太陽', q: '月が光って見えるのは、何の光を反射しているから？', o: ['地球', '火星', '太陽', '金星'], a: 2 },
  { term: '2学期', unit: '月と太陽', q: '地球から見て、月と太陽が同じ方向にあるとき、月はどのように見える？', o: ['満月', '半月', '三日月', '新月'], a: 3 },
  { term: '2学期', unit: '大地のつくりと変化', q: '流れる水が、川岸などを削る働きを何という？', o: ['浸食', '運搬', '堆積', '風化'], a: 0 },
  { term: '2学期', unit: '大地のつくりと変化', q: '流れる水が、運んできた土や砂を積もらせる働きを何という？', o: ['浸食', '運搬', '堆積', '地層'], a: 2 },
  { term: '2学期', unit: '大地のつくりと変化', q: '大昔の生き物の死がいや足跡などが地層に残ったものを何という？', o: ['鉱物', '化石', '地層', '岩石'], a: 1 },
  { term: '2学期', unit: '大地のつくりと変化', q: '火山の噴火によってできる、穴がたくさん空いた石を何という？', o: ['大理石', '石灰岩', '軽石', 'れき岩'], a: 2 },
  { term: '2学期', unit: '大地のつくりと変化', q: '地震の揺れの大きさを表す階級はどれ？', o: ['マグニチュード', '震度', 'ガル', 'ヘルツ'], a: 1 },
  { term: '2学期', unit: 'てこのはたらき', q: 'てこで、力を加える場所を何という？', o: ['支点', '力点', '作用点', '頂点'], a: 1 },
  { term: '2学期', unit: 'てこのはたらき', q: 'てこで、棒を支えている場所を何という？', o: ['支点', '力点', '作用点', '中心'], a: 0 },
  { term: '2学期', unit: '水溶液の性質', q: '水に溶けている物質のことを何という？', o: ['溶媒', '溶質', '溶液', '水溶液'], a: 1 },
  { term: '2学期', unit: '水溶液の性質', q: 'リトマス紙が赤色から青色に変わるとき、その水溶液の性質は？', o: ['酸性', '中性', 'アルカリ性', '塩基性'], a: 2 },
  { term: '2学期', unit: '水溶液の性質', q: '塩酸にスチールウール（鉄）を入れると発生する気体は？', o: ['酸素', '水素', '二酸化炭素', '窒素'], a: 1 },
  { term: '2学期', unit: '水溶液の性質', q: '二酸化炭素が水に溶けた水溶液を何という？', o: ['炭酸水', '食塩水', 'アンモニア水', '塩酸'], a: 0 },
  // ---- 3学期 ----
  { term: '3学期', unit: '電気と私たちのくらし', q: '手回し発電機で作った電気と同じように使えるものはどれ？', o: ['磁石', '乾電池', '豆電球', 'モーター'], a: 1 },
  { term: '3学期', unit: '電気と私たちのくらし', q: '電気を光に変えて利用しているものはどれ？', o: ['アイロン', 'モーター', 'LED', 'スピーカー'], a: 2 },
  { term: '3学期', unit: '電気と私たちのくらし', q: '発光ダイオードの略称をアルファベット3文字で何という？', o: ['LCD', 'LED', 'USB', 'CPU'], a: 1 },
  { term: '3学期', unit: '電気と私たちのくらし', q: '電熱線に電気を通したとき、何が発生する？', o: ['光', '音', '熱', '風'], a: 2 },
  { term: '3学期', unit: '電気と私たちのくらし', q: 'プログラムを使って、意図したとおりに動かすことを何という？', o: ['プログラミング', 'タイピング', 'インストール', 'ダウンロード'], a: 0 },
  { term: '3学期', unit: '人と環境', q: '地球温暖化の主な原因と考えられている気体は？', o: ['酸素', '窒素', '水素', '二酸化炭素'], a: 3 },
  { term: '3学期', unit: '人と環境', q: '水や風、太陽の光など、自然の力を利用したエネルギーを何という？', o: ['化石燃料', '原子力', '再生可能エネルギー', 'バイオマス'], a: 2 },
];

/** 問題の取り出し口。将来 DB / CSV に差し替えるときは、この中身だけ変えればOK */
const QuestionRepo = (() => {
  function validate(list) {
    if (!Array.isArray(list) || list.length === 0) throw new Error('questions must be a non-empty array');
    return list.map((x, i) => {
      const ok = x && typeof x.q === 'string' && typeof x.unit === 'string' && typeof x.term === 'string' &&
        Array.isArray(x.o) && x.o.length >= 2 && x.o.length <= 6 && x.o.every((s) => typeof s === 'string') &&
        Number.isInteger(x.a) && x.a >= 0 && x.a < x.o.length;
      if (!ok) throw new Error(`question #${i + 1} is invalid`);
      return { id: x.id ? String(x.id) : `q${i + 1}`, term: x.term, unit: x.unit, q: x.q, o: x.o, a: x.a };
    });
  }
  let list;
  try {
    // 上級者向け: questions.json があればそちらを優先（README参照）
    const file = path.join(__dirname, 'questions.json');
    list = fs.existsSync(file) ? validate(JSON.parse(fs.readFileSync(file, 'utf8'))) : validate(BUILTIN_QUESTIONS);
  } catch (e) {
    console.warn('[questions] fallback to builtin:', e.message);
    list = validate(BUILTIN_QUESTIONS);
  }
  const byId = new Map(list.map((q) => [q.id, q]));
  return {
    all: () => list,
    get: (id) => byId.get(id),
    units() {
      const out = {};
      for (const q of list) {
        out[q.term] = out[q.term] || [];
        if (!out[q.term].includes(q.unit)) out[q.term].push(q.unit);
      }
      return out;
    },
    allUnitNames() { return new Set(list.map((q) => q.unit)); },
    pick(units, usedIds) {
      let pool = list.filter((q) => units.includes(q.unit));
      if (!pool.length) pool = list;
      let fresh = pool.filter((q) => !usedIds.includes(q.id));
      let reset = false;
      if (!fresh.length) { fresh = pool; reset = true; }
      return { q: fresh[crypto.randomInt(fresh.length)], reset };
    },
  };
})();

/* ============================================================
 * 3. データベース層
 *    Upstash Redis の REST API を fetch で呼ぶだけ（追加ライブラリ不要）。
 * ============================================================ */
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const IS_VERCEL = !!process.env.VERCEL;
const USE_UPSTASH = !!(UP_URL && UP_TOKEN);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}

// ---- メモリ版（ローカル確認用。Redis互換の最小限のコマンドだけ実装） ----
const mem = new Map();
function memGet(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp <= Date.now()) { mem.delete(k); return null; }
  return e;
}
function memCmd(args) {
  const op = String(args[0]).toUpperCase();
  const a = args.slice(1).map((x) => String(x));
  switch (op) {
    case 'GET': { const e = memGet(a[0]); return e ? e.v : null; }
    case 'SET': {
      let exp = 0; let nx = false;
      for (let i = 2; i < a.length; i++) {
        const f = a[i].toUpperCase();
        if (f === 'EX') exp = Date.now() + Number(a[++i]) * 1000;
        else if (f === 'PX') exp = Date.now() + Number(a[++i]);
        else if (f === 'NX') nx = true;
      }
      if (nx && memGet(a[0])) return null;
      mem.set(a[0], { v: a[1], exp });
      return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of a) if (memGet(k)) { mem.delete(k); n++; } return n; }
    case 'INCR': case 'INCRBY': {
      const by = op === 'INCR' ? 1 : Number(a[1]);
      const e = memGet(a[0]);
      const v = (e ? Number(e.v) : 0) + by;
      mem.set(a[0], { v: String(v), exp: e ? e.exp : 0 });
      return v;
    }
    case 'EXPIRE': {
      const e = memGet(a[0]);
      if (!e) return 0;
      if (a[2] && a[2].toUpperCase() === 'NX' && e.exp) return 0;
      e.exp = Date.now() + Number(a[1]) * 1000;
      return 1;
    }
    case 'MGET': return a.map((k) => { const e = memGet(k); return e ? e.v : null; });
    case 'SADD': {
      let e = memGet(a[0]);
      if (!e) { e = { v: new Set(), exp: 0 }; mem.set(a[0], e); }
      let n = 0; for (const m of a.slice(1)) if (!e.v.has(m)) { e.v.add(m); n++; }
      return n;
    }
    case 'SREM': {
      const e = memGet(a[0]); if (!e) return 0;
      let n = 0; for (const m of a.slice(1)) if (e.v.delete(m)) n++;
      return n;
    }
    case 'SMEMBERS': { const e = memGet(a[0]); return e ? [...e.v] : []; }
    case 'HSET': {
      let e = memGet(a[0]);
      if (!e) { e = { v: new Map(), exp: 0 }; mem.set(a[0], e); }
      let n = 0;
      for (let i = 1; i + 1 < a.length; i += 2) { if (!e.v.has(a[i])) n++; e.v.set(a[i], a[i + 1]); }
      return n;
    }
    case 'HSETNX': {
      let e = memGet(a[0]);
      if (!e) { e = { v: new Map(), exp: 0 }; mem.set(a[0], e); }
      if (e.v.has(a[1])) return 0;
      e.v.set(a[1], a[2]); return 1;
    }
    case 'HGET': { const e = memGet(a[0]); return e && e.v.has(a[1]) ? e.v.get(a[1]) : null; }
    case 'HGETALL': { const e = memGet(a[0]); if (!e) return []; const out = []; for (const [k, v] of e.v) out.push(k, v); return out; }
    case 'HLEN': { const e = memGet(a[0]); return e ? e.v.size : 0; }
    case 'HDEL': { const e = memGet(a[0]); if (!e) return 0; let n = 0; for (const f of a.slice(1)) if (e.v.delete(f)) n++; return n; }
    case 'EVAL': { // ロック解除スクリプト専用: [script, numkeys, key, token]
      const e = memGet(a[2]);
      if (e && e.v === a[3]) { mem.delete(a[2]); return 1; }
      return 0;
    }
    default: throw new Error('memory db: unsupported command ' + op);
  }
}
setInterval(() => { for (const k of [...mem.keys()]) memGet(k); }, 60000).unref();

async function upstashFetch(suffix, body) {
  const res = await fetch(UP_URL + suffix, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null) throw new Error(`Upstash error ${res.status}: ${data && data.error ? data.error : ''}`);
  return data;
}

const UNLOCK_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

const db = {
  mode: USE_UPSTASH ? 'upstash' : (IS_VERCEL ? 'missing' : 'memory'),
  async cmd(args) {
    if (USE_UPSTASH) {
      const d = await upstashFetch('', args);
      if (d.error) throw new Error('Upstash: ' + d.error);
      return d.result;
    }
    if (IS_VERCEL) throw new HttpError(500, 'データベース(Upstash Redis)が設定されていません。READMEの「手順3」を確認してください。', 'no_db');
    return memCmd(args);
  },
  async pipe(cmds) {
    if (!cmds.length) return [];
    if (USE_UPSTASH) {
      const d = await upstashFetch('/pipeline', cmds);
      return d.map((x) => { if (x.error) throw new Error('Upstash: ' + x.error); return x.result; });
    }
    if (IS_VERCEL) throw new HttpError(500, 'データベース(Upstash Redis)が設定されていません。READMEの「手順3」を確認してください。', 'no_db');
    return cmds.map(memCmd);
  },
  delIfEq(key, val) { return this.cmd(['EVAL', UNLOCK_LUA, 1, key, val]); },
};

const parseJSON = (s) => (s == null ? null : JSON.parse(s));
const getJSON = async (k) => parseJSON(await db.cmd(['GET', k]));
function pairsToMap(flat, mapper) {
  const o = Object.create(null);
  if (!flat) return o;
  if (!Array.isArray(flat)) { for (const [k, v] of Object.entries(flat)) o[k] = mapper ? mapper(v) : v; return o; }
  for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = mapper ? mapper(flat[i + 1]) : flat[i + 1];
  return o;
}

// キー名の一覧（ここを見ればDBの構造が分かります）
const K = {
  user: (k) => `user:${k}`, coin: (k) => `coin:${k}`, inroom: (k) => `inroom:${k}`,
  room: (id) => `room:${id}`, pl: (id) => `pl:${id}`, ver: (id) => `ver:${id}`,
  ans: (id, q) => `ans:${id}:${q}`, res: (id, q) => `res:${id}:${q}`, rw: (id) => `rw:${id}`,
};

/* ============================================================
 * 4. 共通ユーティリティ
 * ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同じキーの処理を同時に1つだけにするロック（二重判定・二重付与の防止） */
async function withLock(name, ttlMs, fn, opts = {}) {
  const retries = opts.retries || 0;
  const token = crypto.randomBytes(8).toString('hex');
  const key = `lock:${name}`;
  for (let i = 0; ; i++) {
    const ok = await db.cmd(['SET', key, token, 'PX', ttlMs, 'NX']);
    if (ok === 'OK') break;
    if (i >= retries) {
      if (opts.silent) return undefined;
      throw new HttpError(503, '混み合っています。もう一度お試しください。', 'busy');
    }
    await sleep(60 + Math.random() * 120);
  }
  try { return await fn(); } finally { await db.delIfEq(key, token).catch(() => {}); }
}

/** レート制限（一定時間あたりの回数制限） */
async function rateLimit(key, limit, windowSec, message) {
  const out = await db.pipe([['INCR', `rl:${key}`], ['EXPIRE', `rl:${key}`, windowSec, 'NX']]);
  if (Number(out[0]) > limit) throw new HttpError(429, message || '操作が多すぎます。少し待ってからもう一度お試しください。', 'rate_limited');
}

function clientIp(req) {
  const h = req.headers;
  const v = h['x-vercel-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  return String(v).split(',')[0].trim();
}

const dayKey = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 日本時間の日付

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ============================================================
 * 5. 認証
 * ============================================================ */
let secretCache = null;
async function getSecret() {
  if (secretCache) return secretCache;
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    secretCache = process.env.SESSION_SECRET;
    return secretCache;
  }
  // 環境変数が無ければ、初回に自動生成してDBに保存（手間なしで安全に動かすため）
  let s = await db.cmd(['GET', 'sys:secret']);
  if (!s) {
    await db.cmd(['SET', 'sys:secret', crypto.randomBytes(32).toString('hex'), 'NX']);
    s = await db.cmd(['GET', 'sys:secret']);
  }
  secretCache = s;
  return s;
}

async function signToken(payload) {
  const secret = await getSecret();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
async function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const secret = await getSecret();
  const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 無視 */ }
  }
  return out;
}

function setSessionCookie(ctx, token, maxAgeSec) {
  const secure = String(ctx.req.headers['x-forwarded-proto'] || '').includes('https') || !!ctx.req.socket.encrypted;
  const parts = [`sid=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  ctx.res.setHeader('Set-Cookie', parts.join('; '));
}

async function requireUser(ctx) {
  const tok = parseCookies(ctx.req.headers.cookie).sid;
  const p = await verifyToken(tok);
  if (!p) throw new HttpError(401, 'ログインが必要です。', 'unauthorized');
  ctx.user = { name: p.u, key: p.k };
  return ctx.user;
}

/** プレイヤーを見分けるための短い公開ID（クラス・出席番号は画面に出さない） */
const uid = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

const defaultUserDoc = (name, cls, no) => ({
  username: name, cls, no, createdAt: Date.now(),
  skills: { attack: 0, hp: 0, evade: 0, heal: 0, critical: 0 },
  equipped: [], skins: ['earth'], skin: 'earth',
});
const getUser = (key) => getJSON(K.user(key));
const setUser = (key, doc) => db.cmd(['SET', K.user(key), JSON.stringify(doc)]);

async function buildMe(key, doc) {
  const [coinRaw, roomId] = await Promise.all([db.cmd(['GET', K.coin(key)]), currentRoomOf(key)]);
  return {
    user: {
      id: uid(key), username: doc.username, cls: doc.cls, no: doc.no,
      coins: Number(coinRaw || 0), skills: doc.skills, equipped: doc.equipped, unlockedSkins: doc.skins, skin: doc.skin,
    },
    roomId,
  };
}

async function issueSession(ctx, doc, key) {
  const maxAge = CONFIG.SESSION_DAYS * 86400;
  const token = await signToken({ u: doc.username, k: key, exp: Date.now() + maxAge * 1000 });
  setSessionCookie(ctx, token, maxAge);
}

/** GAKU acct のサーバーに確認コードを送り、本人の情報を受け取る（コードは5分・1回だけ有効） */
async function verifyGakuCode(code) {
  let lastErr = null;
  for (const base of GAKU_VERIFY_URLS) {
    let res;
    try {
      res = await fetch(`${base}?verify=${code}`, { redirect: 'follow', signal: AbortSignal.timeout(9000) });
    } catch (e) { lastErr = e; continue; }
    const text = await res.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch { /* HTMLが返ってきた = 公開設定が「全員」になっていない等 */ }
    if (j && typeof j === 'object' && typeof j.ok === 'boolean') return j;
    lastErr = new Error(`non-JSON response from GAKU acct (HTTP ${res.status})`);
  }
  console.error('[gaku verify]', lastErr && lastErr.message);
  throw new HttpError(502, 'GAKU acct と通信できませんでした。しばらくしてからもう一度お試しください。（改善しない場合は、管理者にウェブアプリの公開設定を確認してもらってください）', 'gaku_unreachable');
}

/** ログイン：ブラウザの GAKU acct 画面から届いた「確認コード」を照合して、ゲームのセッションを作る */
async function gakuLogin(ctx) {
  const code = ctx.body.code;
  if (typeof code !== 'string' || !/^[0-9a-f]{64}$/.test(code)) throw new HttpError(400, '確認コードが正しくありません。GAKU acct でログインし直してください。', 'bad_code');
  await rateLimit(`gaku:${ctx.ip}`, 60, 300, 'ログインの試行が多すぎます。少し待ってからお試しください。');

  const v = await verifyGakuCode(code);
  if (!v.ok) throw new HttpError(401, v.message || '確認コードが正しくありません。GAKU acct でログインし直してください。', 'bad_code');
  if (v.active === false) throw new HttpError(403, 'このアカウントは現在停止中です。', 'inactive');

  const cls = String(v.cls || '').normalize('NFKC').trim();
  const no = Number(v.no);
  const name = String(v.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  if (!cls || cls.length > 30 || !Number.isInteger(no) || no < 1 || no > 9999 || !name) {
    throw new HttpError(502, 'アカウント情報を読み取れませんでした。', 'bad_account');
  }
  const key = `g:${cls}:${no}`;                      // クラス＋出席番号が、このゲームでのユーザーID

  const fresh = defaultUserDoc(name, cls, no);
  const created = await db.cmd(['SET', K.user(key), JSON.stringify(fresh), 'NX']);   // 初回だけ作る
  let doc = fresh;
  if (created === 'OK') {
    await db.cmd(['SET', K.coin(key), '0', 'NX']);
  } else {
    doc = await getUser(key);
    if (doc && (doc.username !== name || doc.cls !== cls || doc.no !== no)) {          // 名前が変わっていたら更新
      await withLock(`user:${key}`, 8000, async () => {
        const d2 = await getUser(key);
        d2.username = name; d2.cls = cls; d2.no = no;
        await setUser(key, d2); doc = d2;
      }, { retries: 20 });
    }
    if (!doc) throw new HttpError(500, 'アカウントの読み込みに失敗しました。', 'server_error');
  }
  await issueSession(ctx, doc, key);
  return buildMe(key, doc);
}

async function logout(ctx) {
  setSessionCookie(ctx, '', 0);
  return { ok: true };
}

async function me(ctx) {
  const u = await requireUser(ctx);
  const doc = await getUser(u.key);
  if (!doc) { setSessionCookie(ctx, '', 0); throw new HttpError(401, 'アカウントが見つかりません。', 'unauthorized'); }
  return buildMe(u.key, doc);
}

/* ============================================================
 * 6. ルーム管理 / ゲームエンジン
 *
 *  DBの持ち方（1000人でも重くならないよう分割しています）
 *    room:{id}   … ルームの設定と進行状況（小さいJSON）
 *    pl:{id}     … 参加者のハッシュ  field=ユーザーキー  value=プレイヤーJSON
 *    ans:{id}:{問題番号} … その問題の回答（1人1回だけ書ける）
 *    res:{id}:{問題番号} … その問題の個人別結果
 *    ver:{id}    … 変更のたびに +1 するバージョン番号（ポーリングの差分判定用）
 *    rw:{id}     … 試合終了時のコイン獲得額
 *
 *  進行は「誰かのリクエストが来たときに、締切を過ぎていたら判定する」方式（lazy advance）。
 *  Vercelは常駐できないため、タイマーではなくこの方式にしています。
 * ============================================================ */
const ROOM_ID_RE = /^[a-z0-9]{8,32}$/;
function validId(id) {
  if (!ROOM_ID_RE.test(String(id))) throw new HttpError(404, 'ルームが見つかりません。', 'room_gone');
  return String(id);
}
const getRoom = (id) => getJSON(K.room(id));
const passHash = async (id, pass) => crypto.createHmac('sha256', await getSecret()).update(`${id}:${pass}`).digest('hex');

async function writeRoom(room) {
  const ttl = room.status === 'finished' ? CONFIG.ROOM_TTL_END : CONFIG.ROOM_TTL_PLAY;
  const cmds = [
    ['SET', K.room(room.id), JSON.stringify(room), 'EX', ttl],
    ['INCR', K.ver(room.id)],
    ['EXPIRE', K.ver(room.id), ttl],
    ['EXPIRE', K.pl(room.id), ttl],
    ['EXPIRE', K.rw(room.id), ttl],
  ];
  if (room.status === 'finished') cmds.push(['SREM', 'rooms', room.id]);
  const out = await db.pipe(cmds);
  return Number(out[1]);
}
async function deleteRoom(id) {
  await db.pipe([['DEL', K.room(id)], ['DEL', K.pl(id)], ['DEL', K.ver(id)], ['SREM', 'rooms', id]]);
}

/** いま参加中のルームIDを返す（無効なら掃除してnull） */
async function currentRoomOf(key, opts = {}) {
  const rid = await db.cmd(['GET', K.inroom(key)]);
  if (!rid) return null;
  const [rawRoom, me] = await db.pipe([['GET', K.room(rid)], ['HGET', K.pl(rid), key]]);
  if (!rawRoom || !me) { await db.cmd(['DEL', K.inroom(key)]); return null; }
  if (opts.ignoreFinished && JSON.parse(rawRoom).status === 'finished') return null;
  return rid;
}

function makePlayer(doc, mode, key) {
  const eq = {};
  let mx = 100;
  if (mode === 'normal') {
    for (const id of doc.equipped || []) {
      const lv = (doc.skills && doc.skills[id]) || 0;
      if (lv <= 0) continue;
      if (id === 'hp') mx += lv * 10; else eq[id] = lv;
    }
  }
  return { u: uid(key), n: doc.username, hp: mx, mx, sn: doc.skin || 'earth', d: 0, rk: null, eq };
}

async function createRoom(ctx) {
  const u = await requireUser(ctx);
  const b = ctx.body;
  const mode = b.mode === 'no_skill' ? 'no_skill' : 'normal';
  const maxPlayers = Number(b.maxPlayers);
  if (!CONFIG.MAX_PLAYER_CHOICES.includes(maxPlayers)) throw new HttpError(400, '最大人数の指定が不正です。', 'bad_request');
  const known = QuestionRepo.allUnitNames();
  const units = Array.isArray(b.categories) ? [...new Set(b.categories.filter((x) => typeof x === 'string' && known.has(x)))] : [];
  if (!units.length) throw new HttpError(400, '出題する単元を1つ以上選んでください。', 'bad_request');
  const isPrivate = !!b.isPrivate;
  const passcode = String(b.passcode || '');
  if (isPrivate && !/^\d{6}$/.test(passcode)) throw new HttpError(400, '暗号は6桁の数字にしてください。', 'bad_request');

  await rateLimit(`rc:${u.key}`, 10, 3600, 'ルームを作りすぎです。しばらくしてからお試しください。');
  if (await currentRoomOf(u.key, { ignoreFinished: true })) throw new HttpError(409, 'すでに別のルームに参加中です。先に退出してください。', 'in_room');
  const doc = await getUser(u.key);
  if (!doc) throw new HttpError(401, 'アカウントが見つかりません。', 'unauthorized');

  const id = crypto.randomBytes(8).toString('hex');
  const room = {
    id, host: doc.username, hostKey: u.key, mode, maxPlayers, units, isPrivate,
    pass: isPrivate ? await passHash(id, passcode) : null,
    status: 'waiting', phase: 'lobby', qNo: 0, cur: null, usedQ: [],
    startedAt: 0, deadline: 0, revealUntil: 0, alive: 1, last: null, createdAt: Date.now(),
  };
  await db.pipe([
    ['SET', K.room(id), JSON.stringify(room), 'EX', CONFIG.ROOM_TTL_PLAY],
    ['HSET', K.pl(id), u.key, JSON.stringify(makePlayer(doc, mode, u.key))],
    ['EXPIRE', K.pl(id), CONFIG.ROOM_TTL_PLAY],
    ['SET', K.ver(id), '1', 'EX', CONFIG.ROOM_TTL_PLAY],
    ['SADD', 'rooms', id],
    ['SET', K.inroom(u.key), id, 'EX', 7200],
  ]);
  return { roomId: id };
}

async function listRooms(ctx) {
  await requireUser(ctx);
  const ids = ((await db.cmd(['SMEMBERS', 'rooms'])) || []).slice(0, 200);
  if (!ids.length) return { rooms: [] };
  const raws = await db.cmd(['MGET', ...ids.map(K.room)]);
  const live = []; const stale = [];
  ids.forEach((id, i) => { if (!raws[i]) stale.push(id); else { const r = JSON.parse(raws[i]); if (r.status !== 'finished') live.push(r); } });
  live.sort((a, b) => b.createdAt - a.createdAt);
  const shown = live.slice(0, 60);
  const cmds = shown.map((r) => ['HLEN', K.pl(r.id)]);
  if (stale.length) cmds.push(['SREM', 'rooms', ...stale]);
  const out = await db.pipe(cmds);
  return {
    rooms: shown.map((r, i) => ({
      id: r.id, host: r.host, mode: r.mode, unitCount: r.units.length,
      players: Number(out[i]), maxPlayers: r.maxPlayers, status: r.status, isPrivate: r.isPrivate,
    })),
  };
}

async function joinRoom(ctx) {
  const u = await requireUser(ctx);
  const id = validId(ctx.params.id);
  await rateLimit(`join:${u.key}`, 30, 60);
  const existing = await currentRoomOf(u.key, { ignoreFinished: true });
  if (existing === id) return { roomId: id };                       // 再読み込み後の復帰
  if (existing) throw new HttpError(409, 'すでに別のルームに参加中です。先に退出してください。', 'in_room');

  const room = await getRoom(id);
  if (!room) throw new HttpError(404, 'ルームが見つかりません。', 'room_gone');
  if (room.status !== 'waiting') throw new HttpError(409, 'すでにゲームが開始されています。', 'started');
  if (room.isPrivate) {
    await rateLimit(`pw:${u.key}:${id}`, 5, 600, '暗号の入力を間違えすぎました。10分ほど待ってください。');
    await rateLimit(`pwr:${id}`, 100, 600, 'このルームへの参加試行が多すぎます。しばらく待ってください。');
    const given = await passHash(id, String(ctx.body.passcode || ''));
    const a = Buffer.from(given); const b = Buffer.from(room.pass);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, '暗号が違います。', 'bad_passcode');
  }
  const doc = await getUser(u.key);
  if (!doc) throw new HttpError(401, 'アカウントが見つかりません。', 'unauthorized');

  const added = await db.cmd(['HSETNX', K.pl(id), u.key, JSON.stringify(makePlayer(doc, room.mode, u.key))]);
  if (Number(added) === 1) {
    const [n, fresh] = await db.pipe([['HLEN', K.pl(id)], ['GET', K.room(id)]]);
    const r2 = parseJSON(fresh);
    if (Number(n) > room.maxPlayers || !r2 || r2.status !== 'waiting') {   // 満員 or 直前に開始された
      await db.cmd(['HDEL', K.pl(id), u.key]);
      throw new HttpError(409, Number(n) > room.maxPlayers ? '満員です。' : 'すでにゲームが開始されています。', 'full');
    }
    await db.pipe([['INCR', K.ver(id)], ['SET', K.inroom(u.key), id, 'EX', 7200]]);
  } else {
    await db.cmd(['SET', K.inroom(u.key), id, 'EX', 7200]);
  }
  return { roomId: id };
}

function startQuestion(room) {
  const { q, reset } = QuestionRepo.pick(room.units, room.usedQ);
  if (reset) room.usedQ = [];
  room.usedQ.push(q.id);
  room.qNo += 1;
  room.cur = { id: q.id, order: shuffle(q.o.map((_, i) => i)) };  // 選択肢の並びをサーバーがシャッフル
  room.startedAt = Date.now();
  room.deadline = room.startedAt + CONFIG.QUESTION_MS;
  room.revealUntil = 0;
  room.phase = 'question';
}

async function startGame(ctx) {
  const u = await requireUser(ctx);
  const id = validId(ctx.params.id);
  await withLock(`room:${id}`, 15000, async () => {
    const room = await getRoom(id);
    if (!room) throw new HttpError(404, 'ルームが見つかりません。', 'room_gone');
    if (room.hostKey !== u.key) throw new HttpError(403, 'ホストだけが開始できます。', 'not_host');
    if (room.status !== 'waiting') throw new HttpError(409, 'すでに開始しています。', 'started');
    const n = Number(await db.cmd(['HLEN', K.pl(id)]));
    if (n < CONFIG.MIN_PLAYERS_TO_START) throw new HttpError(400, '2人以上で開始できます。', 'few_players');
    room.status = 'playing';
    room.alive = n;
    startQuestion(room);
    await writeRoom(room);
  }, { retries: 25 });
  return { ok: true };
}

async function leaveRoom(ctx) {
  const u = await requireUser(ctx);
  const id = validId(ctx.params.id);
  await withLock(`room:${id}`, 15000, async () => {
    const room = await getRoom(id);
    if (!room) return;
    if (room.status === 'waiting') {
      if (room.hostKey === u.key) await deleteRoom(id);               // ホストが抜けたら解散
      else await db.pipe([['HDEL', K.pl(id), u.key], ['INCR', K.ver(id)]]);
    } else if (room.status === 'playing') {
      const raw = await db.cmd(['HGET', K.pl(id), u.key]);
      if (raw) {
        const p = JSON.parse(raw);
        if (!p.d) {
          p.d = 1; p.hp = 0; p.rk = Math.max(1, room.alive);
          room.alive = Math.max(0, room.alive - 1);
          await db.cmd(['HSET', K.pl(id), u.key, JSON.stringify(p)]);
          if (room.alive <= 1) await finishAfterLeave(room); else await writeRoom(room);
        }
      }
    }
  }, { retries: 25 });
  await db.cmd(['DEL', K.inroom(u.key)]);
  return { ok: true };
}

async function finishAfterLeave(room) {
  const players = pairsToMap(await db.cmd(['HGETALL', K.pl(room.id)]), JSON.parse);
  const survivors = Object.keys(players).filter((k) => !players[k].d);
  const flat = [];
  for (const k of survivors) { players[k].rk = 1; flat.push(k, JSON.stringify(players[k])); }
  if (flat.length) await db.cmd(['HSET', K.pl(room.id), ...flat]);
  room.status = 'finished'; room.phase = 'over'; room.alive = survivors.length;
  await awardCoins(room, players);
  await writeRoom(room);
}

/** 回答を受け付ける（時刻はサーバーの受信時刻。クライアントの時計は信用しない） */
async function answer(ctx) {
  const u = await requireUser(ctx);
  const id = validId(ctx.params.id);
  const qNo = Number(ctx.body.qNo); const choice = Number(ctx.body.choice);
  if (!Number.isInteger(qNo) || !Number.isInteger(choice) || choice < 0 || choice > 9) throw new HttpError(400, '回答が不正です。', 'bad_request');
  await rateLimit(`ans:${u.key}`, 40, 10);
  const [rawRoom, rawMe] = await db.pipe([['GET', K.room(id)], ['HGET', K.pl(id), u.key]]);
  if (!rawRoom) throw new HttpError(404, 'ルームが見つかりません。', 'room_gone');
  const room = JSON.parse(rawRoom);
  if (!rawMe) throw new HttpError(403, 'このルームの参加者ではありません。', 'not_member');
  if (room.status !== 'playing' || room.phase !== 'question' || room.qNo !== qNo) throw new HttpError(409, 'この問題は終了しました。', 'late');
  if (JSON.parse(rawMe).d) throw new HttpError(409, '脱落しているので回答できません。', 'dead');
  const t = Date.now();
  if (t > room.deadline) throw new HttpError(409, '時間切れです。', 'late');
  const q = QuestionRepo.get(room.cur.id);
  if (!q || choice >= q.o.length) throw new HttpError(400, '回答が不正です。', 'bad_request');

  const out = await db.pipe([
    ['HSETNX', K.ans(id, qNo), u.key, JSON.stringify({ i: choice, t: t - room.startedAt })],
    ['EXPIRE', K.ans(id, qNo), 300],
    ['HLEN', K.ans(id, qNo)],
  ]);
  if (Number(out[0]) !== 1) throw new HttpError(409, 'すでに回答済みです。', 'already');
  if (Number(out[2]) >= room.alive) await advance(id).catch(() => {});   // 全員回答済みなら待たずに判定
  return { ok: true };
}

/** 締切や発表時間を過ぎていたら、次の状態へ進める（ロックで1人だけが実行） */
async function advance(id) {
  await withLock(`room:${id}`, 15000, async () => {
    const room = await getRoom(id);
    if (!room || room.status !== 'playing') return;
    const t = Date.now();
    if (room.phase === 'question') {
      let due = t >= room.deadline + CONFIG.RESOLVE_GRACE_MS;
      if (!due) due = Number(await db.cmd(['HLEN', K.ans(id, room.qNo)])) >= room.alive;
      if (due) await resolveRound(room);
    } else if (room.phase === 'reveal' && t >= room.revealUntil) {
      startQuestion(room);
      await writeRoom(room);
    }
  }, { retries: 0, silent: true });
}

/** 1問ぶんの判定：正解判定・ダメージ・スキル・脱落・順位・終了をここで決める */
async function resolveRound(room) {
  const id = room.id;
  const [plFlat, ansFlat] = await db.pipe([['HGETALL', K.pl(id)], ['HGETALL', K.ans(id, room.qNo)]]);
  const players = pairsToMap(plFlat, JSON.parse);
  const answers = pairsToMap(ansFlat, JSON.parse);
  const q = QuestionRepo.get(room.cur.id);
  const correctIdx = room.cur.order.indexOf(q.a);
  const aliveKeys = Object.keys(players).filter((k) => !players[k].d);

  // 一番乗り（最速の正解者）
  let top = null; let topT = Infinity;
  for (const k of aliveKeys) {
    const a = answers[k];
    if (a && a.i === correctIdx && (a.t < topT || (a.t === topT && k < top))) { top = k; topT = a.t; }
  }
  let topAtk = 0; let crit = false;
  if (top && room.mode === 'normal') {
    const eq = players[top].eq || {};
    if (eq.attack) topAtk += eq.attack * 5;
    if (eq.critical && crypto.randomInt(100) < eq.critical * 5) { topAtk += 30; crit = true; }
  }

  const results = {}; const changed = new Set(); const dead = [];
  for (const k of aliveKeys) {
    const p = players[k]; const a = answers[k];
    const correct = !!(a && a.i === correctIdx);
    const r = { c: correct ? 1 : 0, d: 0, e: 0, h: 0 };
    if (correct) {
      const heal = room.mode === 'normal' && p.eq && p.eq.heal ? p.eq.heal * 5 : 0;
      if (heal) { const nh = Math.min(p.mx, p.hp + heal); r.h = nh - p.hp; p.hp = nh; if (r.h) changed.add(k); }
    } else {
      let dmg = CONFIG.BASE_DAMAGE + topAtk;
      if (room.mode === 'normal' && p.eq && p.eq.evade && crypto.randomInt(100) < p.eq.evade * 5) { dmg = 0; r.e = 1; }
      r.d = dmg; p.hp -= dmg;
      if (dmg) changed.add(k);
    }
    if (p.hp <= 0) { p.hp = 0; p.d = 1; dead.push(k); changed.add(k); }
    results[k] = r;
  }
  const aliveAfter = aliveKeys.length - dead.length;
  for (const k of dead) players[k].rk = Math.max(1, aliveAfter + 1);   // 同時に脱落した人は同順位
  room.alive = aliveAfter;
  room.last = { qNo: room.qNo, correctIndex: correctIdx, top: top ? players[top].n : null, topId: top ? players[top].u : null, topAtk, crit };

  const finished = aliveAfter <= 1 || room.qNo >= CONFIG.MAX_QUESTIONS;
  if (finished) {
    const survivors = aliveKeys.filter((k) => !players[k].d);
    survivors.sort((x, y) => players[y].hp - players[x].hp || (x < y ? -1 : 1));
    let rank = 1;
    survivors.forEach((k, i) => {
      if (i > 0 && players[k].hp < players[survivors[i - 1]].hp) rank = i + 1;
      players[k].rk = rank; changed.add(k);
    });
  }

  const cmds = [];
  if (changed.size) {
    const flat = []; for (const k of changed) flat.push(k, JSON.stringify(players[k]));
    cmds.push(['HSET', K.pl(id), ...flat]);
  }
  const rflat = []; for (const k of Object.keys(results)) rflat.push(k, JSON.stringify(results[k]));
  if (rflat.length) { cmds.push(['HSET', K.res(id, room.qNo), ...rflat]); cmds.push(['EXPIRE', K.res(id, room.qNo), 600]); }
  if (cmds.length) await db.pipe(cmds);

  if (finished) {
    room.status = 'finished'; room.phase = 'over';
    await awardCoins(room, players);
  } else {
    room.phase = 'reveal'; room.revealUntil = Date.now() + CONFIG.REVEAL_MS;
  }
  await writeRoom(room);
}

function calcReward(rank, total) {
  if (total <= 2) return rank === 1 ? 20 : 5;
  if (rank === 1) return 20 + (total - 2) * 10;
  return Math.max(5, 5 + Math.floor((total - rank) * 5));
}

/** コインの付与はサーバーだけが行う。マーカーキーで二重付与を防ぐ */
async function awardCoins(room, players) {
  const id = room.id;
  const marker = await db.cmd(['SET', `rewarded:${id}`, '1', 'NX', 'EX', CONFIG.ROOM_TTL_END]);
  if (marker !== 'OK') return;
  const keys = Object.keys(players);
  const total = keys.length;
  const day = dayKey();
  const rwFlat = [];
  const cmds = [];
  if (room.qNo >= CONFIG.MIN_QUESTIONS_FOR_REWARD) {
    const used = await db.cmd(['MGET', ...keys.map((k) => `daily:${k}:${day}`)]);
    keys.forEach((k, i) => {
      const earn = calcReward(players[k].rk || total, total);
      const grant = Math.max(0, Math.min(earn, CONFIG.DAILY_COIN_CAP - Number(used[i] || 0)));
      if (grant > 0) {
        cmds.push(['INCRBY', K.coin(k), grant], ['INCRBY', `daily:${k}:${day}`, grant], ['EXPIRE', `daily:${k}:${day}`, 172800]);
      }
      rwFlat.push(k, String(grant));
    });
  } else {
    for (const k of keys) rwFlat.push(k, '0');
  }
  if (rwFlat.length) { cmds.push(['HSET', K.rw(id), ...rwFlat]); cmds.push(['EXPIRE', K.rw(id), CONFIG.ROOM_TTL_END]); }
  for (let i = 0; i < cmds.length; i += 500) await db.pipe(cmds.slice(i, i + 500));
}

function publicQuestion(room) {
  if (!room.cur) return null;
  const q = QuestionRepo.get(room.cur.id);
  if (!q) return null;
  return { id: q.id, text: q.q, options: room.cur.order.map((i) => q.o[i]), unit: q.unit, term: q.term }; // 正解は含めない
}

/** ポーリング用。version が変わっていなければ「変化なし」だけ返して通信量を抑える */
async function roomState(ctx) {
  const u = await requireUser(ctx);
  const id = validId(ctx.params.id);
  const since = Number(ctx.query.since) || 0;
  let [raw, ver] = await db.cmd(['MGET', K.room(id), K.ver(id)]);
  if (!raw) throw new HttpError(404, 'ルームが解散されました。', 'room_gone');
  let room = JSON.parse(raw);
  if (room.status === 'playing') {
    const t = Date.now();
    const due = (room.phase === 'question' && t >= room.deadline + CONFIG.RESOLVE_GRACE_MS) || (room.phase === 'reveal' && t >= room.revealUntil);
    if (due) {
      await advance(id);
      [raw, ver] = await db.cmd(['MGET', K.room(id), K.ver(id)]);
      if (!raw) throw new HttpError(404, 'ルームが解散されました。', 'room_gone');
      room = JSON.parse(raw);
    }
  }
  if (Number(ver || 0) === since) return { changed: false, now: Date.now() };

  const lastQ = room.last ? room.last.qNo : 0;
  const [plFlat, resRaw, rwRaw, ansRaw] = await db.pipe([
    ['HGETALL', K.pl(id)], ['HGET', K.res(id, lastQ), u.key], ['HGET', K.rw(id), u.key], ['HGET', K.ans(id, room.qNo), u.key],
  ]);
  const map = pairsToMap(plFlat, JSON.parse);
  const meP = map[u.key];
  if (!meP) throw new HttpError(403, 'このルームの参加者ではありません。', 'not_member');
  const players = Object.values(map).map((p) => ({ u: p.u, n: p.n, h: p.hp, m: p.mx, s: p.sn, d: p.d, r: p.rk }));
  const publicRoom = {
    id: room.id, status: room.status, phase: room.phase, mode: room.mode, maxPlayers: room.maxPlayers,
    isPrivate: room.isPrivate, host: room.host, isHost: room.hostKey === u.key,
    qNo: room.qNo, maxQ: CONFIG.MAX_QUESTIONS, startedAt: room.startedAt, deadline: room.deadline,
    revealUntil: room.revealUntil, limitMs: CONFIG.QUESTION_MS, alive: room.alive, total: players.length,
    question: publicQuestion(room),
    last: room.phase === 'question' ? null : room.last,   // 出題中は正解情報を一切返さない
  };
  const myAnswer = ansRaw ? JSON.parse(ansRaw).i : null;
  return {
    changed: true, now: Date.now(), ver: Number(ver || 0), room: publicRoom, players,
    me: { u: meP.u, n: meP.n, h: meP.hp, m: meP.mx, s: meP.sn, d: meP.d, r: meP.rk },
    myResult: room.phase === 'question' ? null : parseJSON(resRaw),
    myReward: room.status === 'finished' && rwRaw != null ? Number(rwRaw) : null,
    myAnswer,
  };
}

/* ============================================================
 * 7. ショップ（コインの増減はすべてサーバー側）
 * ============================================================ */
async function userTx(ctx, fn) {
  const u = await requireUser(ctx);
  await rateLimit(`shop:${u.key}`, 60, 60);
  return withLock(`user:${u.key}`, 8000, async () => {
    const doc = await getUser(u.key);
    if (!doc) throw new HttpError(401, 'アカウントが見つかりません。', 'unauthorized');
    await fn(doc, u);
    await setUser(u.key, doc);
    const m = await buildMe(u.key, doc);
    return { user: m.user };
  }, { retries: 20 });
}
async function spendCoins(key, cost) {
  const after = Number(await db.cmd(['INCRBY', K.coin(key), -cost]));
  if (after < 0) { await db.cmd(['INCRBY', K.coin(key), cost]); throw new HttpError(402, 'コインが足りません。', 'no_coins'); }
}
const skillOf = (id) => { const s = SKILLS.find((x) => x.id === id); if (!s) throw new HttpError(400, 'スキルが不正です。', 'bad_request'); return s; };
const skinOf = (id) => { const s = SKINS.find((x) => x.id === id); if (!s) throw new HttpError(400, 'スキンが不正です。', 'bad_request'); return s; };

const shopRoutes = {
  skillUpgrade: (ctx) => userTx(ctx, async (doc, u) => {
    const s = skillOf(ctx.body.id);
    const lv = doc.skills[s.id] || 0;
    if (lv >= CONFIG.SKILL_MAX_LEVEL) throw new HttpError(400, 'すでに最大レベルです。', 'max_level');
    await spendCoins(u.key, skillCost(lv));
    doc.skills[s.id] = lv + 1;
  }),
  skillEquip: (ctx) => userTx(ctx, async (doc) => {
    const s = skillOf(ctx.body.id);
    if (!(doc.skills[s.id] > 0)) throw new HttpError(400, '未解放のスキルです。', 'locked');
    const i = doc.equipped.indexOf(s.id);
    if (i >= 0) doc.equipped.splice(i, 1);
    else {
      if (doc.equipped.length >= CONFIG.MAX_EQUIPPED) throw new HttpError(400, `スキルは${CONFIG.MAX_EQUIPPED}つまでしか装備できません。`, 'too_many');
      doc.equipped.push(s.id);
    }
  }),
  skinBuy: (ctx) => userTx(ctx, async (doc, u) => {
    const s = skinOf(ctx.body.id);
    if (doc.skins.includes(s.id)) throw new HttpError(400, 'すでに持っています。', 'owned');
    await spendCoins(u.key, s.cost);
    doc.skins.push(s.id); doc.skin = s.id;
  }),
  skinSelect: (ctx) => userTx(ctx, async (doc) => {
    const s = skinOf(ctx.body.id);
    if (!doc.skins.includes(s.id)) throw new HttpError(400, '未購入の惑星です。', 'locked');
    doc.skin = s.id;
  }),
};

/* ============================================================
 * 8. ルーティングと HTTP ハンドラ
 * ============================================================ */
const ROUTES = [
  ['GET',  /^\/api\/health$/, async () => ({ ok: true, db: db.mode, questions: QuestionRepo.all().length })],
  ['GET',  /^\/api\/meta$/, async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=60');
    return { units: QuestionRepo.units(), skills: SKILLS, skins: SKINS, config: {
      maxPlayerChoices: CONFIG.MAX_PLAYER_CHOICES, maxEquipped: CONFIG.MAX_EQUIPPED, maxSkillLevel: CONFIG.SKILL_MAX_LEVEL,
      questionMs: CONFIG.QUESTION_MS, maxQuestions: CONFIG.MAX_QUESTIONS,
    } };
  }],
  ['POST', /^\/api\/auth\/gaku$/, gakuLogin],
  ['POST', /^\/api\/auth\/logout$/, logout],
  ['GET',  /^\/api\/me$/, me],
  ['GET',  /^\/api\/rooms$/, listRooms],
  ['POST', /^\/api\/rooms$/, createRoom],
  ['POST', /^\/api\/rooms\/([a-z0-9]+)\/join$/, joinRoom],
  ['POST', /^\/api\/rooms\/([a-z0-9]+)\/leave$/, leaveRoom],
  ['POST', /^\/api\/rooms\/([a-z0-9]+)\/start$/, startGame],
  ['POST', /^\/api\/rooms\/([a-z0-9]+)\/answer$/, answer],
  ['GET',  /^\/api\/rooms\/([a-z0-9]+)\/state$/, roomState],
  ['POST', /^\/api\/shop\/skill\/upgrade$/, shopRoutes.skillUpgrade],
  ['POST', /^\/api\/shop\/skill\/equip$/, shopRoutes.skillEquip],
  ['POST', /^\/api\/shop\/skin\/buy$/, shopRoutes.skinBuy],
  ['POST', /^\/api\/shop\/skin\/select$/, shopRoutes.skinSelect],
];

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const bad = () => new HttpError(400, '不正なリクエストです。', 'bad_json');
  if (req.body !== undefined && req.body !== null) { // Vercel が解析済みの場合
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { throw bad(); } }
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw bad(); } }
    return typeof req.body === 'object' ? req.body : {};
  }
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20000) throw new HttpError(413, 'リクエストが大きすぎます。', 'too_large');
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString('utf8');
  if (!txt) return {};
  try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : {}; } catch { throw bad(); }
}

function checkPostSafety(req) {
  const origin = req.headers.origin;
  if (origin) { // 他サイトからの書き込み(CSRF)を拒否
    let host = '';
    try { host = new URL(origin).host; } catch { /* 無視 */ }
    if (host !== req.headers.host) throw new HttpError(403, '不正なリクエストです。', 'bad_origin');
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    throw new HttpError(415, '不正なリクエストです。', 'bad_content_type');
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Not Found');
  }
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  } catch {
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('index.html not found');
  }
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }   // CORSは許可しない(同一オリジンのみ)
    const route = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) throw new HttpError(req.method === 'GET' || req.method === 'POST' ? 404 : 405, 'APIが見つかりません。', 'not_found');
    const m = url.pathname.match(route[1]);
    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), params: { id: m[1] }, ip: clientIp(req), body: {}, user: null };
    if (req.method === 'POST') { checkPostSafety(req); ctx.body = await readBody(req); }
    const out = await route[2](ctx);
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error('[server error]', e);
    sendJson(res, 500, { error: 'サーバーでエラーが発生しました。しばらくしてからお試しください。', code: 'server_error' });
  }
}

module.exports = handler;

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(port, () => {
    console.log(`地球破壊オンライン: http://localhost:${port}  (DB: ${db.mode})`);
    if (db.mode === 'memory') console.log('※ メモリ保存モードです。再起動するとデータは消えます（ローカル確認用）。');
  });
}
