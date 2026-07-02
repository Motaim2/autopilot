import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Undo2, Trash2, Clock, Target, Star, History, BarChart3, FileText,
  Brain, Zap, Coins, Settings, Sparkles, TrendingUp, TrendingDown, Wallet,
} from "lucide-react";

/* ══════════════════════════ GAME MODEL ══════════════════════════ */
const SYMBOLS = {
  tomato:  { emoji: "🍅", ar: "طماطم", size: "small", fam: "steak",   mult: 5  },
  carrot:  { emoji: "🥕", ar: "جزر",   size: "small", fam: "fish",    mult: 5  },
  corn:    { emoji: "🌽", ar: "ذرة",   size: "small", fam: "crab",    mult: 5  },
  cabbage: { emoji: "🥬", ar: "ملفوف", size: "small", fam: "chicken", mult: 5  },
  crab:    { emoji: "🦀", ar: "سلطعون", size: "big",  fam: "crab",    mult: 10 },
  steak:   { emoji: "🥩", ar: "لحم",   size: "big",   fam: "steak",   mult: 15 },
  fish:    { emoji: "🐟", ar: "سمك",   size: "big",   fam: "fish",    mult: 25 },
  chicken: { emoji: "🍗", ar: "دجاج",  size: "big",   fam: "chicken", mult: 45 },
};
const ORDER = ["tomato", "carrot", "corn", "cabbage", "chicken", "fish", "steak", "crab"];
const FAM_AR = { steak: "لحم", fish: "سمك", crab: "سلطعون", chicken: "دجاج" };
const PRIOR = (() => {
  const inv = Object.fromEntries(ORDER.map((s) => [s, 1 / SYMBOLS[s].mult]));
  const t = ORDER.reduce((a, s) => a + inv[s], 0);
  return Object.fromEntries(ORDER.map((s) => [s, inv[s] / t]));
})();

const STORAGE_KEY = "knuz_trader_v1";
const loadState = () => {
  try { const r = window.__memStore?.[STORAGE_KEY]; if (r) return JSON.parse(r); } catch (e) {}
  return { moves: [], base: 100, profit: 1000, limit: 0 };
};
const saveState = (s) => { try { if (!window.__memStore) window.__memStore = {}; window.__memStore[STORAGE_KEY] = JSON.stringify(s); } catch (e) {} };
const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const zeros = () => Object.fromEntries(ORDER.map((s) => [s, 0]));
const norm = (o) => {
  const t = ORDER.reduce((a, s) => a + Math.max(o[s] || 0, 0), 0);
  if (t <= 0) return null;
  return Object.fromEntries(ORDER.map((s) => [s, Math.max(o[s] || 0, 0) / t]));
};

/* ══════════════════════ STREAKS ══════════════════════ */
function computeStreaks(moves) {
  const out = []; let run = 0, prev = null;
  for (const m of moves) {
    const f = SYMBOLS[m.symbol].fam;
    run = prev === null ? 1 : f !== prev ? run + 1 : 1;
    out.push(run); prev = f;
  }
  return out;
}

/* ═══════════════ PRO ENSEMBLE ENGINE (7 models, adaptive) ═══════════════ */
const HALF_LIFE = 12;
const decayW = (i, n) => Math.pow(0.5, (n - 1 - i) / HALF_LIFE);

function subModels(moves) {
  const chain = moves.map((m) => m.symbol);
  const n = chain.length;
  const out = {};
  { /* markov1 */
    const T = {}; ORDER.forEach((a) => (T[a] = zeros()));
    for (let i = 0; i < n - 1; i++) T[chain[i]][chain[i + 1]] += decayW(i + 1, n);
    const row = { ...T[chain[n - 1]] };
    ORDER.forEach((s) => (row[s] += 0.25));
    out.markov1 = norm(row);
  }
  if (n >= 3) { /* markov2 */
    const T = {};
    for (let i = 0; i < n - 2; i++) {
      const k = chain[i] + "|" + chain[i + 1];
      if (!T[k]) T[k] = zeros();
      T[k][chain[i + 2]] += decayW(i + 2, n);
    }
    const k = chain[n - 2] + "|" + chain[n - 1];
    const row = { ...(T[k] || zeros()) };
    ORDER.forEach((s) => (row[s] += 0.2));
    out.markov2 = norm(row);
  }
  { /* deep pattern */
    const sc = zeros();
    for (const { len, w } of [{ len: 4, w: 3 }, { len: 3, w: 2 }]) {
      if (n <= len) continue;
      const pat = chain.slice(-len).join("|");
      for (let i = 0; i <= n - len - 1; i++)
        if (chain.slice(i, i + len).join("|") === pat) sc[chain[i + len]] += w * decayW(i + len, n);
    }
    ORDER.forEach((s) => (sc[s] += 0.05));
    out.pattern = norm(sc);
  }
  { /* periodicity */
    const sc = zeros();
    for (const s of ORDER) {
      const idxs = []; for (let i = 0; i < n; i++) if (chain[i] === s) idxs.push(i);
      if (idxs.length >= 2) {
        const gaps = idxs.slice(1).map((v, j) => v - idxs[j]);
        const avg = gaps.reduce((a, g) => a + g, 0) / gaps.length;
        const since = n - 1 - idxs[idxs.length - 1];
        sc[s] = 1 - Math.min(1, Math.abs(since + 1 - avg) / Math.max(avg, 1));
      }
    }
    ORDER.forEach((s) => (sc[s] += 0.08));
    out.periodic = norm(sc);
  }
  { /* wheel bias */
    const obs = zeros(); let tw = 0;
    for (let i = 0; i < n; i++) { const w = decayW(i, n); obs[chain[i]] += w; tw += w; }
    const sc = zeros();
    ORDER.forEach((s) => { const p = tw ? obs[s] / tw : 0; sc[s] = Math.pow(p / PRIOR[s], 1.2) * PRIOR[s]; });
    out.bias = norm(sc);
  }
  { /* post-8 */
    const sc = zeros(); let any = false;
    for (let i = 0; i < n - 1; i++) if (moves[i].eight) { sc[chain[i + 1]] += decayW(i + 1, n); any = true; }
    if (moves[n - 1]?.eight && any) { ORDER.forEach((s) => (sc[s] += 0.1)); out.post8 = norm(sc); }
  }
  { /* rhythm */
    const sizes = chain.map((s) => SYMBOLS[s].size);
    const famScore = { steak: 0, fish: 0, crab: 0, chicken: 0 };
    const sizeScore = { big: 0, small: 0 };
    const st = computeStreaks(moves);
    const curRun = st[n - 1] || 1;
    const curFam = SYMBOLS[chain[n - 1]].fam;
    if (curRun >= 4) famScore[curFam] += (curRun - 3) * 1.5;
    else Object.keys(famScore).forEach((f) => { if (f !== curFam) famScore[f] += 0.5; });
    const last = sizes[n - 1]; let run = 1;
    for (let i = n - 2; i >= 0; i--) { if (sizes[i] === last) run++; else break; }
    if (last === "big" && run <= 3) sizeScore.big += (4 - run);
    if (last === "small" && run >= 4) sizeScore.big += (run - 3) * 0.8;
    sizeScore[last === "big" ? "small" : "big"] += 0.3;
    const sc = zeros();
    ORDER.forEach((s) => { sc[s] = famScore[SYMBOLS[s].fam] + sizeScore[SYMBOLS[s].size] * 0.8 + 0.15; });
    out.rhythm = norm(sc);
  }
  return out;
}

const MODEL_KEYS = ["markov1", "markov2", "pattern", "periodic", "bias", "post8", "rhythm"];
const MODEL_AR = { markov1: "انتقالات", markov2: "أزواج", pattern: "أنماط عميقة", periodic: "إيقاع دوري", bias: "انحياز العجلة", post8: "ما بعد ٨", rhythm: "موجات" };
const defaultEMA = () => Object.fromEntries(MODEL_KEYS.map((k) => [k, 0.3]));
const weightsFrom = (ema) => Object.fromEntries(MODEL_KEYS.map((k) => [k, 0.25 + 2.2 * Math.pow(ema[k] || 0, 1.5)]));

function blend(models, weights) {
  const sc = zeros(); let any = false;
  for (const k of MODEL_KEYS) {
    const d = models[k]; if (!d) continue; any = true;
    ORDER.forEach((s) => (sc[s] += d[s] * (weights[k] || 1)));
  }
  if (!any) return null;
  const d = norm(sc); if (!d) return null;
  const mixed = Object.fromEntries(ORDER.map((s) => [s, d[s] * 0.78 + PRIOR[s] * 0.22]));
  return ORDER.map((s) => ({ symbol: s, conf: mixed[s] * 100 })).sort((a, b) => b.conf - a.conf);
}
function predictFrom(moves, weights) {
  if (!moves.length) return null;
  return blend(subModels(moves), weights || weightsFrom(defaultEMA()));
}
function pickCoverage(pred, k = 3, manualSyms = null) {
  if (!pred || !pred.length) return null;
  const p = pred.map((x) => x.conf / 100);
  const H = -p.reduce((a, v) => a + (v > 0 ? v * Math.log(v) : 0), 0) / Math.log(8);
  const conf = Object.fromEntries(pred.map((x) => [x.symbol, x.conf]));
  const options = manualSyms && manualSyms.length ? manualSyms : pred.slice(0, k).map((x) => x.symbol);
  const coverProb = options.reduce((a, s) => a + (conf[s] || 0), 0);
  return {
    options, coverProb,
    top: pred[0], second: pred[1] || null, entropy: H,
    confident: coverProb >= 50 || pred[0].conf >= 28,
    skip: H > 0.94 && pred[0].conf < 20,
  };
}

/* ═══════════════ BANKROLL MATH (ladder depth · survival · sizing) ═══════════════
   ladderInfo: how many consecutive losses the bankroll absorbs with the
   recovery ladder, and each rung's cost.
   ruinProb: exact DP probability of hitting a loss-run longer than depth D
   within N rounds, given per-round loss probability q.
   suggestBase: largest base stake keeping ruin ≤ 5% for the planned rounds. */
function ladderInfo(bankroll, options, base, profit) {
  if (!bankroll || !options?.length) return { depth: 0, rungs: [], used: 0 };
  let carry = 0, used = 0;
  const rungs = [];
  for (let d = 0; d < 15; d++) {
    const plan = computeBetPlan(carry, options, base, profit, d, 0);
    if (used + plan.cost > bankroll) break;
    used += plan.cost; carry += plan.cost; rungs.push(plan.cost);
  }
  return { depth: rungs.length, rungs, used };
}
function ruinProb(N, q, D) {
  if (D <= 0) return 1;
  if (D >= N) return 0;
  let dp = new Array(D + 1).fill(0); dp[0] = 1; let ruin = 0;
  for (let i = 0; i < N; i++) {
    const nd = new Array(D + 1).fill(0);
    for (let r = 0; r <= D; r++) {
      const pr = dp[r]; if (!pr) continue;
      nd[0] += pr * (1 - q);
      if (r + 1 > D) ruin += pr * q; else nd[r + 1] += pr * q;
    }
    dp = nd;
  }
  return ruin;
}
const BASE_CANDIDATES = [100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000, 8000, 10000];
function suggestBase(bankroll, options, profit, rounds, q) {
  let best = 100;
  for (const b of BASE_CANDIDATES) {
    const L = ladderInfo(bankroll, options, b, profit);
    if (L.depth < 1) break;
    if (ruinProb(rounds, q, L.depth) <= 0.05) best = b;
  }
  return best;
}

/* ═══════════════ POSITION SIZING (balanced, economical) ═══════════════ */
function computeBetPlan(carry, options, base, profit, lossRun, limit) {
  const mults = options.map((o) => SYMBOLS[o].mult);
  const S = options.reduce((a, o) => a + 1 / SYMBOLS[o].mult, 0);
  const desiredProfit = profit * (1 + Math.max(0, lossRun) * 0.5);
  const floorT = base * Math.min(...mults);
  let T = S >= 1 ? floorT : Math.max((carry + desiredProfit) / (1 - S), floorT);
  let capped = false;
  const mk = () => options.map((o) => ({ sym: o, mult: SYMBOLS[o].mult, stake: Math.max(100, Math.ceil(T / SYMBOLS[o].mult / 100) * 100) }));
  let stakes = mk(); let cost = stakes.reduce((a, s) => a + s.stake, 0);
  if (limit && cost > limit) { capped = true; T = floorT; stakes = mk(); cost = stakes.reduce((a, s) => a + s.stake, 0); }
  const rows = stakes.map((s) => ({ ...s, win: s.stake * s.mult, net: s.stake * s.mult - cost - (capped ? 0 : carry) }));
  return { options, rows, cost, capped, desiredProfit: Math.round(desiredProfit) };
}

/* ═══════════════ FULL-STRIP READING ═══════════════ */
function liveAnalysis(moves, pred) {
  const chain = moves.map((m) => m.symbol);
  const n = chain.length;
  if (n < 1) return null;
  const notes = [];
  const sizes = chain.map((s) => SYMBOLS[s].size);
  const fams = chain.map((s) => SYMBOLS[s].fam);
  const fc = {}; fams.forEach((f) => (fc[f] = (fc[f] || 0) + 1));
  const dom = Object.entries(fc).sort((a, b) => b[1] - a[1])[0];
  if (dom) notes.push(`قرأت ${n} ضربة — ${FAM_AR[dom[0]]} الأنشط (${dom[1]})`);
  const big = sizes.filter((s) => s === "big").length;
  notes.push(`${n - big} صغار / ${big} كبار`);
  const st = computeStreaks(moves);
  if (st[n - 1] >= 3) notes.push(`سلسلة ${st[n - 1]} قابلة للانكسار`);
  let br = 0; for (let i = sizes.length - 1; i >= 0; i--) { if (sizes[i] === "big") br++; else break; }
  let sr = 0; for (let i = sizes.length - 1; i >= 0; i--) { if (sizes[i] === "small") sr++; else break; }
  if (br >= 2) notes.push(`🌊 جحفلة ${br} متتالية`);
  if (sr >= 4) notes.push(`صغار ${sr} — كبير مستحق`);
  if (n >= 2 && chain[n - 1] === chain[n - 2]) notes.push(`تكرار ${SYMBOLS[chain[n - 1]].emoji}`);
  if (n >= 4 && chain[n - 1] === chain[n - 3] && chain[n - 2] === chain[n - 4] && chain[n - 1] !== chain[n - 2])
    notes.push(`تبادلي ${SYMBOLS[chain[n - 2]].emoji}${SYMBOLS[chain[n - 1]].emoji}`);
  const last = chain[n - 1]; const tr = {};
  for (let i = 0; i < n - 1; i++) if (chain[i] === last) tr[chain[i + 1]] = (tr[chain[i + 1]] || 0) + 1;
  const tt = Object.entries(tr).sort((a, b) => b[1] - a[1])[0];
  if (tt) notes.push(`بعد ${SYMBOLS[last].emoji} غالباً ${SYMBOLS[tt[0]].emoji} (${tt[1]}×)`);
  let verdict = null;
  if (pred?.length) {
    const p1 = pred[0], p2 = pred[1];
    verdict = p2
      ? `${SYMBOLS[p1.symbol].emoji} ${SYMBOLS[p1.symbol].ar} ${p1.conf.toFixed(0)}% ثم ${SYMBOLS[p2.symbol].emoji} ${SYMBOLS[p2.symbol].ar} ${p2.conf.toFixed(0)}%`
      : `${SYMBOLS[p1.symbol].emoji} ${SYMBOLS[p1.symbol].ar} ${p1.conf.toFixed(0)}%`;
  }
  return { notes, verdict };
}

/* ═══════════════ MILESTONE REPORT ═══════════════ */
function buildReport(moves, coverK = 3, manualSyms = null) {
  const chain = moves.map((m) => m.symbol); const n = chain.length;
  const ms = [7, 10, 15, 20];
  const milestone = [...ms].reverse().find((m) => n >= m);
  if (!milestone) { const next = ms.find((m) => m > n); return { locked: true, next, remaining: next - n }; }
  const counts = zeros(); chain.forEach((s) => counts[s]++);
  const ranked = ORDER.map((s) => ({ s, c: counts[s] })).filter((x) => x.c).sort((a, b) => b.c - a.c);
  const most = ranked[0], least = ranked[ranked.length - 1];
  let hits = 0, top1 = 0, chances = 0;
  for (let i = 1; i < n; i++) {
    const p = predictFrom(moves.slice(0, i));
    const cov = pickCoverage(p, coverK, manualSyms);
    if (p && cov) { chances++; if (cov.options.includes(chain[i])) hits++; if (p[0].symbol === chain[i]) top1++; }
  }
  const acc = chances ? Math.round((hits / chances) * 100) : 0;
  const accTop1 = chances ? Math.round((top1 / chances) * 100) : 0;
  const streaks = computeStreaks(moves);
  const with8 = moves.filter((m) => m.eight);
  let t8 = "الـ ٨ ما نزلت بعد.";
  if (with8.length) {
    const c8 = zeros(); with8.forEach((m) => c8[m.symbol]++);
    const t = ORDER.map((s) => ({ s, c: c8[s] })).sort((a, b) => b.c - a.c)[0];
    t8 = `الـ ٨ نزلت ${with8.length} مرة، أكثرها ${SYMBOLS[t.s].emoji} ${SYMBOLS[t.s].ar}.`;
  }
  const lines = [
    `📊 بعد ${n} جولة (محطة ${milestone}):`,
    `• الأكثر: ${SYMBOLS[most.s].emoji} ${SYMBOLS[most.s].ar} (${most.c}×) — الأقل: ${SYMBOLS[least.s].emoji} ${SYMBOLS[least.s].ar} (${least.c}×).`,
    `• دقة فوز المراهنة: ${acc}% (${hits}/${chances}) — تطابق الأول: ${accTop1}%.`,
    `• أطول سلسلة عدم تكرار: ${Math.max(...streaks)}، الحالية: ${streaks[n - 1]}.`,
    `• ${t8}`,
  ];
  return { locked: false, milestone, acc, lines };
}

/* tiny SVG sparkline path from series */
function sparkPath(vals, w, h, pad = 2) {
  if (!vals.length) return "";
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const rng = mx - mn || 1;
  return vals.map((v, i) => {
    const x = pad + (i / Math.max(vals.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - ((v - mn) / rng) * (h - pad * 2);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

/* ════════════════════════════ APP ════════════════════════════ */
export default function App() {
  const [moves, setMoves] = useState([]);
  const [eightArmed, setEightArmed] = useState(false);
  const [tab, setTab] = useState("play");
  const [base, setBase] = useState(100);
  const [profit, setProfit] = useState(1000);
  const [limit, setLimit] = useState(0);
  const [bankroll, setBankroll] = useState(50000);
  const [rounds, setRounds] = useState(20);
  const [coverK, setCoverK] = useState(3);
  const [manualMode, setManualMode] = useState(false);
  const [manualSyms, setManualSyms] = useState([]);
  const [goalPct, setGoalPct] = useState(100);  // 0=بدون · 50=+٥٠٪ · 100=دبل · 200=×٣
  const [stopPct, setStopPct] = useState(50);   // 0=بدون · 25 · 50
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const s = loadState();
    setMoves(s.moves || []); setBase(s.base || 100); setProfit(s.profit || 1000); setLimit(s.limit || 0);
    setBankroll(s.bankroll ?? 50000); setRounds(s.rounds ?? 20); setCoverK(s.coverK ?? 3);
    setManualMode(!!s.manualMode); setManualSyms(s.manualSyms || []);
    setGoalPct(s.goalPct ?? 100); setStopPct(s.stopPct ?? 50);
  }, []);
  useEffect(() => {
    saveState({ moves, base, profit, limit, bankroll, rounds, coverK, manualMode, manualSyms, goalPct, stopPct });
  }, [moves, base, profit, limit, bankroll, rounds, coverK, manualMode, manualSyms, goalPct, stopPct]);

  const activeManual = manualMode && manualSyms.length >= 1 ? manualSyms : null;

  /* Adaptive walk: bets, model EMAs, session P&L equity, confidence history */
  const sim = useMemo(() => {
    let carry = 0, lossRun = 0, equity = 0;
    const ema = defaultEMA();
    const used = {};
    const perMove = [];
    const equitySeries = [];
    const confSeries = [];
    for (let i = 0; i < moves.length; i++) {
      if (i === 0) { perMove.push({ bet: null, rank: 0 }); continue; }
      const hist = moves.slice(0, i);
      const models = subModels(hist);
      const pred = blend(models, weightsFrom(ema));
      const cov = pickCoverage(pred, coverK, activeManual);
      const landed = moves[i].symbol;
      for (const k of MODEL_KEYS) {
        const d = models[k]; if (!d) continue;
        used[k] = true;
        const top3 = ORDER.map((s) => ({ s, v: d[s] })).sort((a, b) => b.v - a.v).slice(0, 3).map((x) => x.s);
        ema[k] = ema[k] * 0.8 + (top3.includes(landed) ? 1 : 0) * 0.2;
      }
      if (!pred || !cov) { perMove.push({ bet: null, rank: 0 }); continue; }
      confSeries.push(cov.coverProb);
      const plan = computeBetPlan(carry, cov.options, base, profit, lossRun, limit);
      const won = cov.options.includes(landed);
      let rank = 0;
      if (pred[0]?.symbol === landed) rank = 1;
      else if (pred[1]?.symbol === landed) rank = 2;
      const effCarry = plan.capped ? 0 : carry;
      if (plan.capped) { carry = 0; lossRun = 0; }
      if (won) {
        const payout = plan.rows.find((r) => r.sym === landed).win;
        equity += payout - plan.cost;
        perMove.push({ bet: { ...plan, landed, won: true, payout, net: payout - plan.cost - effCarry, coverProb: cov.coverProb }, rank });
        carry = 0; lossRun = 0;
      } else {
        equity -= plan.cost;
        carry += plan.cost; lossRun += 1;
        perMove.push({ bet: { ...plan, landed, won: false, coverProb: cov.coverProb }, rank });
      }
      equitySeries.push(equity);
    }
    let nextPred = null, nextCov = null, nextPlan = null;
    if (moves.length) {
      nextPred = blend(subModels(moves), weightsFrom(ema));
      nextCov = pickCoverage(nextPred, coverK, activeManual);
      if (nextCov) {
        nextPlan = computeBetPlan(carry, nextCov.options, base, profit, lossRun, limit);
        nextPlan.coverProb = nextCov.coverProb;
        nextPlan.skip = nextCov.skip;
        nextPlan.confident = nextCov.confident;
      }
    }
    const hot = MODEL_KEYS.filter((k) => used[k]).map((k) => ({ k, v: ema[k] })).sort((a, b) => b.v - a.v)[0] || null;
    return { perMove, carry, lossRun, nextPred, nextCov, nextPlan, hotModel: hot, equity, equitySeries, confSeries };
  }, [moves, base, profit, limit, coverK, activeManual]);

  const prediction = sim.nextPred;
  const cov = sim.nextCov;
  const betPlan = sim.nextPlan;
  const streaks = useMemo(() => computeStreaks(moves), [moves]);
  const rankFlags = useMemo(() => sim.perMove.map((p) => p.rank || 0), [sim]);
  const winTrend = useMemo(() => sim.perMove.filter((p) => p.bet).map((p) => (p.bet.won ? (p.rank === 2 ? 2 : 1) : 0)), [sim]);
  const analysis = useMemo(() => liveAnalysis(moves, prediction), [moves, prediction]);
  const report = useMemo(() => buildReport(moves, coverK, activeManual), [moves, coverK, activeManual]);

  /* ── Session plan math ── */
  const session = useMemo(() => {
    const repOptions = cov?.options
      || activeManual
      || [...ORDER].sort((a, b) => PRIOR[b] - PRIOR[a]).slice(0, coverK);
    const bets = sim.perMove.filter((p) => p.bet).slice(-20);
    let q;
    if (bets.length >= 8) q = bets.filter((p) => !p.bet.won).length / bets.length;
    else if (cov) q = Math.min(0.95, Math.max(0.05, 1 - cov.coverProb / 100));
    else q = Math.min(0.95, Math.max(0.05, 1 - repOptions.reduce((a, s) => a + PRIOR[s], 0)));
    const ladder = ladderInfo(bankroll, repOptions, base, profit);
    const survive = 1 - ruinProb(rounds, q, ladder.depth);
    const suggested = suggestBase(bankroll, repOptions, profit, rounds, q);
    const S = repOptions.reduce((a, o) => a + 1 / SYMBOLS[o].mult, 0);
    const margin = (1 - S) * 100;
    const goalTarget = goalPct > 0 ? Math.round(bankroll * goalPct / 100) : 0;
    const goalProgress = goalTarget ? Math.max(0, Math.min(1, sim.equity / goalTarget)) : 0;
    const goalHit = goalTarget > 0 && sim.equity >= goalTarget;
    const stopTarget = stopPct > 0 ? Math.round(bankroll * stopPct / 100) : 0;
    const stopHit = stopTarget > 0 && sim.equity <= -stopTarget;
    return { repOptions, q, ladder, survive, suggested, margin, goalTarget, goalProgress, goalHit, stopHit };
  }, [cov, activeManual, coverK, bankroll, base, profit, rounds, goalPct, stopPct, sim]);

  const toggleManualSym = useCallback((s) => {
    setManualSyms((prev) => prev.includes(s)
      ? prev.filter((x) => x !== s)
      : prev.length >= 6 ? prev : [...prev, s]);
  }, []);

  const logHit = useCallback((symId) => {
    setMoves((prev) => [...prev, { symbol: symId, eight: eightArmed, ts: Date.now() }]);
    setEightArmed(false);
  }, [eightArmed]);
  const undo = useCallback(() => setMoves((prev) => prev.slice(0, -1)), []);
  const resetAll = useCallback(() => { setMoves([]); setEightArmed(false); }, []);

  const top = prediction?.[0];
  const second = prediction?.[1];
  const signal = !cov ? null : cov.skip ? { t: "تخطَّ الجولة", c: "var(--dim)", bg: "rgba(140,150,170,.1)" }
    : cov.confident ? { t: "إشارة قوية", c: "var(--up)", bg: "rgba(0,225,154,.12)" }
    : { t: "إشارة متوسطة", c: "var(--gold)", bg: "rgba(240,176,63,.12)" };

  return (
    <div dir="rtl" className="term">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Almarai:wght@300;400;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap');
        :root{
          --bg:#07090C; --panel:#0D1116; --panel2:#0A0E12; --line:#1A212B; --line2:#232C38;
          --up:#00E19A; --dn:#FF4D5E; --gold:#F0B03F; --sky:#43C6FF;
          --tx:#EDF1F7; --tx2:#94A0B4; --dim:#5A6678;
        }
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        .term{min-height:100vh;color:var(--tx);font-family:'Almarai',system-ui,sans-serif;
          background:
            linear-gradient(rgba(26,33,43,.35) 1px, transparent 1px),
            linear-gradient(90deg, rgba(26,33,43,.35) 1px, transparent 1px),
            radial-gradient(700px 340px at 100% 0%, rgba(0,225,154,.05), transparent 60%),
            radial-gradient(600px 300px at 0% 8%, rgba(240,176,63,.05), transparent 55%),
            var(--bg);
          background-size:26px 26px, 26px 26px, auto, auto, auto;}
        .wrap{max-width:432px;margin:0 auto;padding:0 14px 104px}
        .mono{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums}
        .panel{background:var(--panel);border:1px solid var(--line);border-radius:16px}
        .chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:800}
        button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
        .press:active{transform:scale(.95)}.press{transition:transform .1s}
        .tickerwrap{overflow:hidden;border-bottom:1px solid var(--line);background:rgba(10,14,18,.8)}
        .tickertrack{display:inline-flex;gap:26px;padding:8px 0;white-space:nowrap;animation:tick 26s linear infinite}
        @keyframes tick{from{transform:translateX(0)}to{transform:translateX(50%)}}
        @media (prefers-reduced-motion:reduce){.tickertrack{animation:none}.press{transition:none}}
        input[type=number]{appearance:textfield}input::-webkit-inner-spin-button{display:none}
      `}</style>

      {/* ─── Ticker tape ─── */}
      <div className="tickerwrap" style={{ direction: "ltr" }}>
        <div className="tickertrack mono">
          {[0, 1].map((rep) => (
            <span key={rep} style={{ display: "inline-flex", gap: 26 }}>
              {(moves.length ? moves.slice(-14) : ORDER.map((s) => ({ symbol: s }))).map((m, i) => (
                <span key={rep + "-" + i} style={{ fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 14 }}>{SYMBOLS[m.symbol].emoji}</span>
                  <span style={{ color: "var(--dim)" }}>×{SYMBOLS[m.symbol].mult}</span>
                  {m.eight && <span style={{ color: "var(--gold)" }}>•8</span>}
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      <div className="wrap">
        {/* ─── Header ─── */}
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0 12px" }}>
          <div style={{
            width: 37, height: 37, borderRadius: 10, display: "grid", placeItems: "center",
            background: "linear-gradient(135deg,#00E19A,#0AA872)", boxShadow: "0 5px 16px rgba(0,225,154,.25)",
          }}><Brain size={19} color="#06231A" strokeWidth={2.5} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>عرّاف الكونز <span className="mono" style={{ fontSize: 9, color: "var(--up)", verticalAlign: "super" }}>PRO</span></div>
            <div style={{ fontSize: 10.5, color: "var(--tx2)" }}>
              {sim.hotModel ? <>النموذج الأدق: <b style={{ color: "var(--up)" }}>{MODEL_AR[sim.hotModel.k]}</b></> : "محطة تداول التوقعات"}
            </div>
          </div>
          <button className="press" onClick={() => setShowSettings((v) => !v)}
            style={{ width: 35, height: 35, borderRadius: 10, background: "var(--panel)", border: "1px solid var(--line)", display: "grid", placeItems: "center" }}>
            <Settings size={15} color="var(--tx2)" />
          </button>
        </header>

        {/* ─── Settings ─── */}
        {showSettings && (
          <div className="panel" style={{ padding: 13, marginBottom: 12, display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--up)", display: "flex", alignItems: "center", gap: 6 }}>
              <Wallet size={13} /> خطة الجلسة
            </div>

            {/* Bankroll + rounds */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--tx2)", marginBottom: 4 }}>رصيد الكونز</div>
                <input type="number" value={bankroll} onChange={(e) => setBankroll(Math.max(0, +e.target.value))} className="mono"
                  style={{ width: "100%", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", color: "var(--gold)", fontSize: 13, fontWeight: 700, direction: "ltr", textAlign: "right" }} />
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--tx2)", marginBottom: 4 }}>عدد الجولات المخططة</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {[10, 20, 30, 50].map((v) => (
                    <button key={v} className="press mono" onClick={() => setRounds(v)} style={{
                      flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 11.5, fontWeight: 700,
                      background: rounds === v ? "var(--up)" : "var(--panel2)",
                      color: rounds === v ? "#06231A" : "var(--tx2)",
                      border: `1px solid ${rounds === v ? "var(--up)" : "var(--line)"}`,
                    }}>{v}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Cover count 1-6 */}
            <div>
              <div style={{ fontSize: 10.5, color: "var(--tx2)", marginBottom: 4 }}>كم رمز تراهن عليه كل جولة؟</div>
              <div style={{ display: "flex", gap: 4 }}>
                {[1, 2, 3, 4, 5, 6].map((v) => (
                  <button key={v} className="press mono" onClick={() => setCoverK(v)} style={{
                    flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 12, fontWeight: 800,
                    background: coverK === v && !manualMode ? "var(--up)" : "var(--panel2)",
                    color: coverK === v && !manualMode ? "#06231A" : "var(--tx2)",
                    border: `1px solid ${coverK === v && !manualMode ? "var(--up)" : "var(--line)"}`,
                    opacity: manualMode ? .45 : 1,
                  }}>{v}</button>
                ))}
              </div>
            </div>

            {/* Manual symbol selection */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontSize: 10.5, color: "var(--tx2)" }}>اختيار الرموز</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="press" onClick={() => setManualMode(false)} style={{
                    padding: "3px 10px", borderRadius: 7, fontSize: 10, fontWeight: 800,
                    background: !manualMode ? "rgba(0,225,154,.15)" : "var(--panel2)",
                    color: !manualMode ? "var(--up)" : "var(--dim)",
                    border: `1px solid ${!manualMode ? "var(--up)" : "var(--line)"}`,
                  }}>تلقائي — المحرك يختار</button>
                  <button className="press" onClick={() => setManualMode(true)} style={{
                    padding: "3px 10px", borderRadius: 7, fontSize: 10, fontWeight: 800,
                    background: manualMode ? "rgba(240,176,63,.15)" : "var(--panel2)",
                    color: manualMode ? "var(--gold)" : "var(--dim)",
                    border: `1px solid ${manualMode ? "var(--gold)" : "var(--line)"}`,
                  }}>يدوي — أنا أحدد</button>
                </div>
              </div>
              {manualMode && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 4 }}>
                  {ORDER.map((s) => {
                    const on = manualSyms.includes(s);
                    return (
                      <button key={s} className="press" onClick={() => toggleManualSym(s)} style={{
                        aspectRatio: "1", borderRadius: 9, display: "grid", placeItems: "center", fontSize: 17,
                        background: on ? "rgba(240,176,63,.16)" : "var(--panel2)",
                        border: `1.5px solid ${on ? "var(--gold)" : "var(--line)"}`,
                      }}>{SYMBOLS[s].emoji}</button>
                    );
                  })}
                </div>
              )}
              {manualMode && manualSyms.length === 0 && (
                <div style={{ fontSize: 9.5, color: "var(--dim)", marginTop: 4 }}>اختر ١-٦ رموز — وإلا أرجع للتلقائي</div>
              )}
            </div>

            {/* Base + profit + limit */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--tx2)" }}>الرهان الأساسي</span>
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                {[100, 1000, 10000, 50000].map((v) => (
                  <button key={v} className="press mono" onClick={() => setBase(v)} style={{
                    padding: "4px 8px", borderRadius: 7, fontSize: 10.5, fontWeight: 700,
                    background: base === v ? "var(--up)" : "var(--panel2)",
                    color: base === v ? "#06231A" : "var(--tx2)",
                    border: `1px solid ${base === v ? "var(--up)" : "var(--line)"}`,
                  }}>{fmt0(v)}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--tx2)" }}>الربح المستهدف / دورة</span>
              <input type="number" value={profit} onChange={(e) => setProfit(Math.max(0, +e.target.value))} className="mono"
                style={{ width: 100, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 9px", color: "var(--tx)", fontSize: 12, direction: "ltr", textAlign: "right" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--tx2)" }}>سقف الرهان · ٠ = بدون</span>
              <input type="number" value={limit} onChange={(e) => setLimit(Math.max(0, +e.target.value))} className="mono"
                style={{ width: 100, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 9px", color: "var(--tx)", fontSize: 12, direction: "ltr", textAlign: "right" }} />
            </div>

            {/* Session goal + stop loss */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--tx2)", marginBottom: 4 }}>هدف الجلسة — أوقفك عنده</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {[{ v: 0, t: "بدون" }, { v: 50, t: "+٥٠٪" }, { v: 100, t: "دبل" }, { v: 200, t: "×٣" }].map((o) => (
                    <button key={o.v} className="press" onClick={() => setGoalPct(o.v)} style={{
                      flex: 1, padding: "6px 0", borderRadius: 8, fontSize: 10, fontWeight: 800,
                      background: goalPct === o.v ? "rgba(0,225,154,.15)" : "var(--panel2)",
                      color: goalPct === o.v ? "var(--up)" : "var(--dim)",
                      border: `1px solid ${goalPct === o.v ? "var(--up)" : "var(--line)"}`,
                    }}>{o.t}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--tx2)", marginBottom: 4 }}>وقف الخسارة</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {[{ v: 0, t: "بدون" }, { v: 25, t: "٢٥٪" }, { v: 50, t: "٥٠٪" }].map((o) => (
                    <button key={o.v} className="press" onClick={() => setStopPct(o.v)} style={{
                      flex: 1, padding: "6px 0", borderRadius: 8, fontSize: 10, fontWeight: 800,
                      background: stopPct === o.v ? "rgba(255,77,94,.12)" : "var(--panel2)",
                      color: stopPct === o.v ? "var(--dn)" : "var(--dim)",
                      border: `1px solid ${stopPct === o.v ? "var(--dn)" : "var(--line)"}`,
                    }}>{o.t}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── الحسبة الذكية ── */}
            <div style={{ background: "var(--panel2)", border: "1px dashed var(--line2)", borderRadius: 11, padding: 11 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                <Brain size={12} /> الحسبة الذكية
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, fontSize: 10.5 }}>
                <div style={{ color: "var(--tx2)" }}>يتحمل رصيدك <b className="mono" style={{ color: "var(--tx)" }}>{session.ladder.depth}</b> خسائر متتالية</div>
                <div style={{ color: "var(--tx2)" }}>احتمال النجاة في {rounds} جولة: <b className="mono" style={{ color: session.survive >= .9 ? "var(--up)" : session.survive >= .7 ? "var(--gold)" : "var(--dn)" }}>{Math.round(session.survive * 100)}%</b></div>
                <div style={{ color: "var(--tx2)" }}>هامش ربح التوزيعة: <b className="mono" style={{ color: session.margin >= 20 ? "var(--up)" : "var(--gold)" }}>{session.margin.toFixed(0)}%</b></div>
                <div style={{ color: "var(--tx2)" }}>احتمال خسارة الجولة: <b className="mono" style={{ color: "var(--tx)" }}>{Math.round(session.q * 100)}%</b></div>
              </div>
              {session.ladder.rungs.length > 0 && (
                <div className="mono" style={{ marginTop: 8, fontSize: 9, color: "var(--dim)", direction: "ltr", textAlign: "right" }}>
                  سلّم التعويض: {session.ladder.rungs.map((r) => fmt0(r)).join(" ← ")}
                </div>
              )}
              {session.margin < 10 && (
                <div style={{ marginTop: 7, fontSize: 9.5, color: "var(--dn)" }}>⚠️ تغطية {session.repOptions.length} رموز تترك هامشاً ضئيلاً — قلّل الرموز أو ركّز على الصغار.</div>
              )}
              <button className="press" onClick={() => setBase(session.suggested)} style={{
                marginTop: 9, width: "100%", padding: "8px 0", borderRadius: 9, fontSize: 11, fontWeight: 800,
                background: "rgba(0,225,154,.12)", color: "var(--up)", border: "1px solid rgba(0,225,154,.35)",
              }}>
                ✦ اقتراح رياضي: رهان أساسي <span className="mono">{fmt0(session.suggested)}</span> (نجاة ≥٩٥٪) — طبّقه
              </button>
            </div>
          </div>
        )}

        {tab === "play" && (
          <>
            {/* ─── Session status ─── */}
            {session.goalHit && (
              <div style={{ padding: "10px 13px", borderRadius: 12, marginBottom: 10, background: "rgba(0,225,154,.12)", border: "1px solid var(--up)", fontSize: 12, fontWeight: 800, color: "var(--up)", textAlign: "center" }}>
                🎯 حققت هدف الجلسة (+{fmt0(session.goalTarget)}) — قفل واطلع رابح!
              </div>
            )}
            {session.stopHit && !session.goalHit && (
              <div style={{ padding: "10px 13px", borderRadius: 12, marginBottom: 10, background: "rgba(255,77,94,.1)", border: "1px solid var(--dn)", fontSize: 12, fontWeight: 800, color: "var(--dn)", textAlign: "center" }}>
                🛑 وصلت وقف الخسارة — توقف وحافظ على الباقي.
              </div>
            )}
            {bankroll > 0 && (
              <div className="panel" style={{ padding: "9px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                <Wallet size={13} color="var(--gold)" />
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)" }}>{fmt0(bankroll)}</span>
                <span style={{ fontSize: 9.5, color: "var(--dim)" }}>يتحمل {session.ladder.depth} خسائر · نجاة {Math.round(session.survive * 100)}%</span>
                {session.goalTarget > 0 && (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ flex: 1, height: 5, borderRadius: 99, background: "var(--panel2)", overflow: "hidden", border: "1px solid var(--line)" }}>
                      <div style={{ height: "100%", width: `${session.goalProgress * 100}%`, background: "linear-gradient(90deg,#0AA872,#00E19A)", borderRadius: 99, transition: "width .5s" }} />
                    </div>
                    <span className="mono" style={{ fontSize: 9, color: "var(--up)" }}>{Math.round(session.goalProgress * 100)}%</span>
                  </div>
                )}
              </div>
            )}
            {/* ─── HERO: Stock-quote card ─── */}
            <section className="panel" style={{ padding: 16, marginBottom: 11, position: "relative", overflow: "hidden" }}>
              {top ? (
                <>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 42, lineHeight: 1 }}>{SYMBOLS[top.symbol].emoji}</span>
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{SYMBOLS[top.symbol].ar}</div>
                        <div className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>KNZ:{top.symbol.toUpperCase().slice(0, 4)} · ×{SYMBOLS[top.symbol].mult}</div>
                      </div>
                    </div>
                    {signal && <span className="chip" style={{ background: signal.bg, color: signal.c }}>{signal.t}</span>}
                  </div>

                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                    <span className="mono" style={{ fontSize: 34, fontWeight: 800, color: "var(--up)", lineHeight: 1 }}>
                      {top.conf.toFixed(1)}<span style={{ fontSize: 16 }}>%</span>
                    </span>
                    {cov && (
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <TrendingUp size={12} /> تغطية {cov.coverProb.toFixed(0)}%
                      </span>
                    )}
                  </div>

                  {second && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                      <Star size={11} color="var(--sky)" fill="var(--sky)" />
                      <span style={{ fontSize: 11.5, color: "var(--tx2)", fontWeight: 700 }}>
                        الرديف: {SYMBOLS[second.symbol].emoji} {SYMBOLS[second.symbol].ar} <span className="mono">{second.conf.toFixed(0)}%</span>
                      </span>
                    </div>
                  )}

                  {/* Confidence sparkline */}
                  {sim.confSeries.length >= 3 && (
                    <div style={{ position: "relative" }}>
                      <svg width="100%" height="44" viewBox="0 0 300 44" preserveAspectRatio="none" style={{ direction: "ltr", display: "block" }}>
                        <path d={sparkPath(sim.confSeries.slice(-40), 300, 44) + " L300,44 L0,44 Z"} fill="rgba(0,225,154,.09)" stroke="none" />
                        <path d={sparkPath(sim.confSeries.slice(-40), 300, 44)} fill="none" stroke="var(--up)" strokeWidth="1.8" strokeLinejoin="round" />
                      </svg>
                      <span className="mono" style={{ position: "absolute", top: 0, left: 0, fontSize: 8.5, color: "var(--dim)" }}>منحنى ثقة المحرك</span>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ textAlign: "center", padding: "24px 0", color: "var(--dim)", fontSize: 12.5 }}>
                  <Target size={24} style={{ opacity: .4, marginBottom: 8 }} />
                  <div>سجّل أول ضربة وأفتح لك السوق</div>
                </div>
              )}
            </section>

            {/* ─── Order card ─── */}
            {betPlan && (
              <section className="panel" style={{ padding: 14, marginBottom: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, display: "flex", alignItems: "center", gap: 6 }}>
                    <Coins size={13} color="var(--gold)" /> أمر الصفقة
                  </span>
                  {sim.lossRun > 0
                    ? <span className="chip" style={{ background: "rgba(255,77,94,.1)", color: "var(--dn)" }}><TrendingDown size={10} /> تعويض {fmt0(sim.carry)}</span>
                    : <span className="chip" style={{ background: "rgba(0,225,154,.1)", color: "var(--up)" }}>هدف +{fmt0(betPlan.desiredProfit)}</span>}
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {betPlan.rows.map((r, i) => (
                    <div key={r.sym + i} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                      background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 11,
                    }}>
                      <span style={{ fontSize: 21 }}>{SYMBOLS[r.sym].emoji}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{SYMBOLS[r.sym].ar}</div>
                        <div className="mono" style={{ fontSize: 9, color: "var(--dim)" }}>×{r.mult} → {fmt0(r.win)}</div>
                      </div>
                      <div className="mono" style={{ fontSize: 16.5, fontWeight: 800, color: "var(--gold)", direction: "ltr" }}>{fmt(r.stake)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 10.5, color: "var(--tx2)" }}>
                  <span>مخاطرة <b className="mono" style={{ color: "var(--tx)" }}>{fmt0(betPlan.cost)}</b></span>
                  {betPlan.capped && <span style={{ color: "var(--gold)" }}>⚠️ سقف — دورة جديدة</span>}
                  {(() => {
                    const lb = [...sim.perMove].reverse().find((p) => p.bet)?.bet;
                    if (!lb) return null;
                    return lb.won
                      ? <span className="mono" style={{ color: "var(--up)" }}>✓ +{fmt0(lb.net)}</span>
                      : <span style={{ color: "var(--dn)" }}>✗ خارج التغطية</span>;
                  })()}
                </div>
                {/* Session P&L */}
                {sim.equitySeries.length >= 2 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--line2)" }}>
                    <Wallet size={13} color={sim.equity >= 0 ? "var(--up)" : "var(--dn)"} />
                    <span style={{ fontSize: 10.5, color: "var(--tx2)" }}>محفظة الجلسة</span>
                    <span className="mono" style={{ fontSize: 13.5, fontWeight: 800, color: sim.equity >= 0 ? "var(--up)" : "var(--dn)", direction: "ltr" }}>
                      {sim.equity >= 0 ? "+" : ""}{fmt0(sim.equity)}
                    </span>
                    <svg width="80" height="22" viewBox="0 0 80 22" style={{ marginRight: "auto", direction: "ltr" }}>
                      <path d={sparkPath(sim.equitySeries.slice(-30), 80, 22)} fill="none"
                        stroke={sim.equity >= 0 ? "var(--up)" : "var(--dn)"} strokeWidth="1.6" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
              </section>
            )}

            {/* ─── Strip ─── */}
            <section style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 10.5, color: "var(--tx2)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}><History size={11} /> الشريط ({moves.length})</span>
                <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 9.5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 3 }}><Star size={9} color="var(--gold)" fill="var(--gold)" />أول</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 3 }}><Star size={9} color="var(--sky)" fill="var(--sky)" />ثاني</span>
                </span>
              </div>
              <div style={{ overflowX: "auto", paddingBottom: 4, direction: "ltr" }}>
                <div style={{ display: "flex", gap: 5, flexDirection: "row-reverse", justifyContent: "flex-end", width: "max-content" }}>
                  {moves.length === 0
                    ? <span style={{ fontSize: 11, color: "var(--dim)", padding: "8px 0" }}>لا توجد ضربات…</span>
                    : moves.slice(-40).map((m, i) => {
                        const ri = Math.max(0, moves.length - 40) + i;
                        const rk = rankFlags[ri]; const run = streaks[ri];
                        const broke = run === 1 && ri > 0;
                        return (
                          <div key={m.ts + "" + i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                            <div style={{
                              position: "relative", width: 40, height: 40, borderRadius: 10, display: "grid", placeItems: "center", fontSize: 20,
                              background: m.eight ? "rgba(240,176,63,.12)" : "var(--panel)",
                              border: `1px solid ${m.eight ? "var(--gold)" : "var(--line)"}`,
                            }}>
                              {SYMBOLS[m.symbol].emoji}
                              {rk === 1 && <Star size={12} color="var(--gold)" fill="var(--gold)" style={{ position: "absolute", top: -4, left: -4 }} />}
                              {rk === 2 && <Star size={12} color="var(--sky)" fill="var(--sky)" style={{ position: "absolute", top: -4, left: -4 }} />}
                              {m.eight && <span className="mono" style={{ position: "absolute", bottom: -3, right: -3, width: 14, height: 14, borderRadius: 99, background: "var(--gold)", color: "#221600", fontSize: 8.5, fontWeight: 800, display: "grid", placeItems: "center" }}>8</span>}
                            </div>
                            <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: broke ? "var(--dn)" : "var(--dim)" }}>{run}</span>
                          </div>
                        );
                      })}
                </div>
              </div>
            </section>

            {/* ─── Market read ─── */}
            {analysis && (
              <section className="panel" style={{ padding: 12, marginBottom: 11, borderColor: "rgba(67,198,255,.22)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
                  <Sparkles size={12} color="var(--sky)" />
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--sky)" }}>قراءة السوق</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {analysis.notes.map((a, i) => (
                    <span key={i} className="chip" style={{ background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--tx2)", fontWeight: 400 }}>{a}</span>
                  ))}
                </div>
                {analysis.verdict && (
                  <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 9, background: "rgba(67,198,255,.08)", border: "1px solid rgba(67,198,255,.2)", fontSize: 12, fontWeight: 800 }}>
                    التوصية: {analysis.verdict}
                  </div>
                )}
              </section>
            )}

            {/* ─── Trend candles ─── */}
            {winTrend.length >= 3 && (
              <section className="panel" style={{ padding: 12, marginBottom: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, display: "flex", alignItems: "center", gap: 6 }}>
                    <BarChart3 size={12} color="var(--up)" /> ترند الجولات
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
                    {winTrend.slice(-20).filter((x) => x).length}/{Math.min(winTrend.length, 20)}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 42, direction: "ltr" }}>
                  {winTrend.slice(-30).map((w, i) => (
                    <div key={i} style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                      <div style={{
                        width: "100%", borderRadius: 1.5, height: w ? "100%" : "36%",
                        background: w === 1 ? "var(--gold)" : w === 2 ? "var(--sky)" : "rgba(255,77,94,.6)",
                      }} />
                    </div>
                  ))}
                </div>
                {(() => {
                  const last = winTrend.slice(-30);
                  const lw = last[last.length - 1] > 0;
                  let wave = 1;
                  for (let i = last.length - 2; i >= 0; i--) { if ((last[i] > 0) === lw) wave++; else break; }
                  return (
                    <div style={{ marginTop: 6, fontSize: 10, color: "var(--dim)", textAlign: "center" }}>
                      {lw ? `🟢 موجة صعود: ${wave}` : `🔴 موجة هبوط: ${wave} — رفع تدريجي للتعويض`}
                    </div>
                  );
                })()}
              </section>
            )}

            {/* ─── 8 toggle ─── */}
            <button className="press" onClick={() => setEightArmed((v) => !v)} style={{
              width: "100%", marginBottom: 11, padding: "11px 13px", borderRadius: 13,
              background: eightArmed ? "rgba(240,176,63,.1)" : "var(--panel)",
              border: `1px solid ${eightArmed ? "var(--gold)" : "var(--line)"}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Zap size={15} color={eightArmed ? "var(--gold)" : "var(--dim)"} />
                <span style={{ fontSize: 12, fontWeight: 800 }}>الضربة القادمة عليها الـ ٨</span>
              </span>
              <span style={{ width: 38, height: 21, borderRadius: 99, padding: 2.5, background: eightArmed ? "var(--gold)" : "var(--line2)", display: "block", transition: "background .2s" }}>
                <span style={{ width: 16, height: 16, borderRadius: 99, background: "#fff", display: "block", transform: eightArmed ? "translateX(-17px)" : "none", transition: "transform .2s" }} />
              </span>
            </button>

            {/* ─── Symbol pad ─── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7, marginBottom: 11 }}>
              {ORDER.map((s) => (
                <button key={s} className="press" onClick={() => logHit(s)} style={{
                  aspectRatio: "1", borderRadius: 13, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 1,
                  background: SYMBOLS[s].size === "big" ? "linear-gradient(180deg,#10161D,#0C1116)" : "var(--panel)",
                  border: `1px solid ${eightArmed ? "rgba(240,176,63,.4)" : "var(--line)"}`,
                }}>
                  <span style={{ fontSize: 24 }}>{SYMBOLS[s].emoji}</span>
                  <span style={{ fontSize: 8.5, color: "var(--tx2)", fontWeight: 700 }}>{SYMBOLS[s].ar}</span>
                  <span className="mono" style={{ fontSize: 7.5, color: "rgba(240,176,63,.55)", fontWeight: 700 }}>×{SYMBOLS[s].mult}</span>
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              <button className="press" onClick={undo} disabled={!moves.length} style={{
                padding: "11px 0", borderRadius: 12, background: "var(--panel)", border: "1px solid var(--line)",
                fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                opacity: moves.length ? 1 : .4, color: "var(--tx)",
              }}><Undo2 size={13} /> تراجع</button>
              <button className="press" onClick={resetAll} disabled={!moves.length} style={{
                padding: "11px 0", borderRadius: 12, background: "rgba(255,77,94,.07)", border: "1px solid rgba(255,77,94,.28)",
                fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                opacity: moves.length ? 1 : .4, color: "var(--dn)",
              }}><Trash2 size={13} /> مسح الكل</button>
            </div>
          </>
        )}

        {/* ─── History ─── */}
        {tab === "history" && (
          <section style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 9, display: "flex", alignItems: "center", gap: 6 }}>
              <History size={13} color="var(--gold)" /> السجل ({moves.length})
            </div>
            {moves.length === 0
              ? <div style={{ textAlign: "center", color: "var(--dim)", fontSize: 12, padding: "40px 0" }}>لا توجد ضربات</div>
              : <div style={{ display: "grid", gap: 5 }}>
                  {[...moves].reverse().map((m, i) => {
                    const idx = moves.length - i; const ri = idx - 1; const rk = rankFlags[ri];
                    return (
                      <div key={m.ts + "" + i} className="panel" style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", borderRadius: 11 }}>
                        <span className="mono" style={{ fontSize: 9.5, color: "var(--dim)", width: 20 }}>{idx}</span>
                        <span style={{ fontSize: 20 }}>{SYMBOLS[m.symbol].emoji}</span>
                        <span style={{ fontSize: 12, fontWeight: 800, flex: 1 }}>{SYMBOLS[m.symbol].ar}</span>
                        <span className="mono" style={{ fontSize: 9, color: "var(--dim)" }}>سلسلة {streaks[ri]}</span>
                        {rk === 1 && <Star size={12} color="var(--gold)" fill="var(--gold)" />}
                        {rk === 2 && <Star size={12} color="var(--sky)" fill="var(--sky)" />}
                        {m.eight && <span className="chip" style={{ background: "rgba(240,176,63,.1)", color: "var(--gold)" }}><Clock size={9} /> ٨</span>}
                      </div>
                    );
                  })}
                </div>}
          </section>
        )}

        {/* ─── Report ─── */}
        {tab === "report" && (
          <section style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <FileText size={13} color="var(--gold)" /> تقرير التدريب
            </div>
            {report.locked ? (
              <div className="panel" style={{ padding: 22, textAlign: "center" }}>
                <Brain size={24} style={{ opacity: .3, marginBottom: 9 }} />
                <div style={{ fontSize: 12, color: "var(--tx2)" }}>أحتاج {report.remaining} جولة لأول محطة ({report.next})</div>
                <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 5 }}>المحطات: ٧ / ١٠ / ١٥ / ٢٠</div>
              </div>
            ) : (
              <>
                <div className="panel" style={{ padding: 14, marginBottom: 10, borderColor: "rgba(0,225,154,.28)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--up)" }}>دقة فوز المراهنة</span>
                    <span className="mono" style={{ fontSize: 25, fontWeight: 800, color: "var(--up)" }}>{report.acc}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 99, background: "var(--panel2)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${report.acc}%`, borderRadius: 99, background: "linear-gradient(90deg,#0AA872,#00E19A)", transition: "width .6s" }} />
                  </div>
                </div>
                <div className="panel" style={{ padding: 13, display: "grid", gap: 7 }}>
                  {report.lines.map((l, i) => (
                    <div key={i} style={{ fontSize: 12, lineHeight: 1.75, color: i === 0 ? "var(--tx)" : "var(--tx2)", fontWeight: i === 0 ? 800 : 400 }}>{l}</div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>

      {/* ─── Bottom nav ─── */}
      <nav style={{ position: "fixed", bottom: 0, insetInline: 0, background: "rgba(7,9,12,.94)", backdropFilter: "blur(12px)", borderTop: "1px solid var(--line)" }}>
        <div style={{ maxWidth: 432, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(3,1fr)" }}>
          {[
            { id: "play", label: "التداول", icon: Target },
            { id: "history", label: "السجل", icon: History },
            { id: "report", label: "التقرير", icon: FileText },
          ].map((t) => {
            const Icon = t.icon; const active = tab === t.id;
            return (
              <button key={t.id} className="press" onClick={() => setTab(t.id)} style={{
                padding: "10px 0 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                color: active ? "var(--up)" : "var(--dim)",
              }}>
                <Icon size={18} />
                <span style={{ fontSize: 9.5, fontWeight: 800 }}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
