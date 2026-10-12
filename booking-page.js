"use strict";
/**
 * نظام عيادة — Public booking page builder (self-contained, no build step)
 * ======================================================================
 * Returns the entire HTML document (inline CSS + inline JS) for `/booking/<slug>`.
 *
 * The document is a single template literal, exactly like the original build, so:
 *   - the ONLY interpolations are the clinic name and the client data object;
 *   - nothing inside the page may use a backtick or a backslash (both would be
 *     eaten by this template literal), so the client code sticks to plain
 *     concatenation and backslash-free patterns.
 */

const escHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildBookingPage(opts) {
  const name = opts && opts.name ? opts.name : "عيادة";
  const slug = opts ? opts.slug : null;
  const daysAhead = opts && opts.daysAhead ? opts.daysAhead : 90;
  const data = JSON.stringify({ slug, name, daysAhead }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap">
<title>حجز موعد — ${escHtml(name)}</title>
<style>
  :root{
    --bg:#eef1f8;--bg-2:#e3e9f6;--card:#ffffff;--card-2:#f6f8fd;--card-3:#eef2fb;
    --fg:#0c1524;--muted:#5b6b82;--muted-2:#8a97ad;--line:#e6ebf5;--line-2:#eef2fa;
    --brand:#0ea5e9;--brand-2:#6366f1;--brand-3:#8b5cf6;--brand-d:#0369a1;
    --brand-l:#38bdf8;--brand-soft:#e6f5fe;--brand-ink:#075985;
    --brand-grad:linear-gradient(120deg,#0284c7,#0ea5e9 44%,#6366f1);
    --accent:#7c3aed;--accent-soft:#f0ecff;
    --ok:#0d9488;--ok-soft:#d9f8f1;--warn:#d97706;--err:#e11d48;--err-soft:#fdeced;
    --glass:rgba(255,255,255,.72);--glass-line:rgba(226,235,244,.9);
    --glow-a:rgba(14,165,233,.24);--glow-b:rgba(99,102,241,.2);--glow-c:rgba(139,92,246,.16);
    --ring:0 0 0 4px rgba(14,165,233,.2);
    --sh-s:0 1px 2px rgba(12,21,36,.06),0 1px 3px rgba(12,21,36,.05);
    --sh-m:0 22px 44px -22px rgba(12,21,36,.28);
    --sh-l:0 46px 90px -34px rgba(12,21,36,.38);
    --hairline:linear-gradient(90deg,transparent,rgba(255,255,255,.95),transparent);
    --ease:cubic-bezier(.16,.84,.44,1);
    --r:24px;--r-s:16px;--r-xs:12px;
  }
  html.dark{
    --bg:#060a16;--bg-2:#0a1120;--card:#0d1729;--card-2:#111f36;--card-3:#16273f;
    --fg:#eaf0f9;--muted:#94a4bd;--muted-2:#6b7c98;--line:#1d2f49;--line-2:#16283f;
    --brand:#38bdf8;--brand-2:#818cf8;--brand-3:#a78bfa;--brand-d:#0ea5e9;
    --brand-l:#7dd3fc;--brand-soft:#0b2b40;--brand-ink:#bae6fd;
    --brand-grad:linear-gradient(120deg,#0ea5e9,#6366f1 55%,#8b5cf6);
    --accent:#a78bfa;--accent-soft:#1a2246;
    --ok:#2dd4bf;--ok-soft:#0c2f2b;--warn:#fbbf24;--err:#fb7185;--err-soft:#351a24;
    --glass:rgba(9,16,30,.7);--glass-line:rgba(29,47,73,.9);
    --glow-a:rgba(56,189,248,.2);--glow-b:rgba(129,140,248,.18);--glow-c:rgba(167,139,250,.16);
    --ring:0 0 0 4px rgba(56,189,248,.24);
    --sh-s:0 1px 2px rgba(0,0,0,.45);
    --sh-m:0 24px 50px -24px rgba(0,0,0,.66);
    --sh-l:0 50px 100px -36px rgba(0,0,0,.76);
    --hairline:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent);
  }
  *{box-sizing:border-box}
  *::selection{background:var(--brand);color:#fff}
  html{scroll-behavior:smooth}
  body{
    margin:0;min-height:100vh;color:var(--fg);line-height:1.8;
    background:linear-gradient(180deg,var(--bg),var(--bg-2));
    font-family:"IBM Plex Sans Arabic","Segoe UI",system-ui,-apple-system,"Noto Kufi Arabic","Noto Naskh Arabic",Tahoma,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    font-feature-settings:"liga" 1,"calt" 1;
  }
  ::-webkit-scrollbar{width:11px;height:11px}
  ::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px;border:3px solid transparent;background-clip:content-box}
  ::-webkit-scrollbar-thumb:hover{background:var(--muted-2);background-clip:content-box}
  /* aurora backdrop + film grain */
  .aurora{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;filter:blur(4px)}
  .aurora span{position:absolute;display:block;border-radius:50%;filter:blur(64px);will-change:transform;
    animation:drift 28s var(--ease) infinite alternate}
  .aurora span:nth-child(1){width:56vw;height:56vw;top:-18vw;inset-inline-end:-10vw;
    background:radial-gradient(circle at 35% 35%,var(--glow-a),transparent 70%)}
  .aurora span:nth-child(2){width:48vw;height:48vw;top:22vh;inset-inline-start:-14vw;
    background:radial-gradient(circle at 60% 40%,var(--glow-b),transparent 70%);animation-duration:34s;animation-delay:-7s}
  .aurora span:nth-child(3){width:42vw;height:42vw;bottom:-16vw;inset-inline-start:26vw;
    background:radial-gradient(circle at 50% 50%,var(--glow-c),transparent 70%);animation-duration:40s;animation-delay:-15s}
  @keyframes drift{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(2.5vw,3.5vh,0) scale(1.14)}}
  .noise{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.04;
    background-image:radial-gradient(rgba(12,21,36,.85) 1px,transparent 1px);background-size:3px 3px}
  html.dark .noise{opacity:.055;background-image:radial-gradient(rgba(255,255,255,.5) 1px,transparent 1px)}
  a{color:inherit}
  .ic{width:1.1em;height:1.1em;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.9;
    stroke-linecap:round;stroke-linejoin:round;vertical-align:-.18em;display:inline-block}
  .muted{color:var(--muted)}

  /* ── top mini bar (appears on scroll) ───────────────────── */
  .minibar{position:fixed;inset-inline:0;top:0;z-index:70;transform:translateY(-115%);opacity:0;
    transition:transform .32s cubic-bezier(.4,0,.2,1),opacity .32s;
    background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    border-bottom:1px solid var(--glass-line)}
  .minibar.show{transform:translateY(0);opacity:1}
  .mb-in{max-width:1000px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:9px 18px}
  .mb-name{font-weight:800;font-size:.95rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mb-spacer{flex:1}
  .mb-call{display:inline-flex;align-items:center;gap:6px;font-size:.82rem;color:var(--brand);
    text-decoration:none;font-weight:700;white-space:nowrap}
  .mb-call:hover{color:var(--brand-ink)}

  /* ── hero ───────────────────────────────────────────────── */
  .hero{position:relative;overflow:hidden;color:#fff;
    background:
      radial-gradient(120% 130% at 88% -12%,rgba(255,255,255,.24),transparent 56%),
      radial-gradient(90% 120% at 0% 120%,rgba(255,255,255,.14),transparent 60%),
      var(--brand-grad);
    padding:30px 18px 88px}
  html.dark .hero{background:
      radial-gradient(120% 130% at 88% -12%,rgba(56,189,248,.3),transparent 56%),
      linear-gradient(135deg,#04263c,#0a3d61 52%,#1c2a63)}
  .hero::after{content:"";position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.09) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.09) 1px,transparent 1px);
    background-size:46px 46px;
    mask-image:radial-gradient(130% 95% at 82% -5%,#000,transparent 74%);
    -webkit-mask-image:radial-gradient(130% 95% at 82% -5%,#000,transparent 74%)}
  .hero-bg{position:absolute;inset:0;pointer-events:none;opacity:.6;
    background:
      radial-gradient(520px 250px at 92% -20%,rgba(255,255,255,.42),transparent 60%),
      radial-gradient(440px 230px at 4% 122%,rgba(255,255,255,.22),transparent 60%)}
  .hero-in{position:relative;max-width:1000px;margin:0 auto;display:flex;
    justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:14px;min-width:0}
  .logo{width:58px;height:58px;border-radius:18px;
    background:linear-gradient(135deg,rgba(255,255,255,.36),rgba(255,255,255,.14));
    border:1px solid rgba(255,255,255,.46);display:grid;place-items:center;font-size:1.52rem;
    font-weight:900;color:#fff;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);flex:0 0 auto;
    box-shadow:0 12px 28px -14px rgba(3,20,40,.65),inset 0 1px 0 rgba(255,255,255,.55)}
  .logo.sm{width:34px;height:34px;border-radius:11px;font-size:1rem}
  .eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:.74rem;font-weight:700;
    background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.32);border-radius:999px;
    padding:3px 12px;margin-bottom:8px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28)}
  .hero h1{margin:0;font-size:1.78rem;line-height:1.4;overflow-wrap:anywhere;font-weight:700;
    letter-spacing:-.2px;text-shadow:0 2px 18px rgba(2,18,36,.35)}
  .hero-tools{display:flex;align-items:center;gap:10px;flex:0 0 auto}
  .status{display:inline-flex;align-items:center;gap:7px;font-size:.78rem;font-weight:700;
    background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 12px}
  .status i{width:8px;height:8px;border-radius:50%;background:#34d399;animation:pulse 2.2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 9px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
  .tg{width:42px;height:42px;border-radius:13px;background:rgba(255,255,255,.16);
    border:1px solid rgba(255,255,255,.3);color:#fff;cursor:pointer;display:grid;place-items:center;
    font-size:1.05rem;transition:transform .18s,background .18s}
  .tg:hover{background:rgba(255,255,255,.28);transform:rotate(-12deg)}
  .hero-meta{position:relative;max-width:1000px;margin:16px auto 0;display:flex;flex-wrap:wrap;gap:8px}
  .hero-meta a,.hero-meta span{display:inline-flex;align-items:center;gap:7px;font-size:.84rem;
    background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.24);border-radius:999px;padding:6px 13px;
    text-decoration:none}
  .hero-strip{position:relative;max-width:1000px;margin:14px auto 0;display:flex;flex-wrap:wrap;
    gap:8px 18px;font-size:.79rem;opacity:.96}
  .hero-strip span{display:inline-flex;align-items:center;gap:6px}

  /* ── layout ─────────────────────────────────────────────── */
  .wrap{max-width:1000px;margin:-50px auto 0;padding:0 18px 96px;display:grid;gap:20px;
    grid-template-columns:1fr;align-items:start}
  @media(min-width:980px){.wrap{grid-template-columns:minmax(0,1fr) 344px}}
  .wrap.single{grid-template-columns:1fr;max-width:680px}
  .card{position:relative;background:var(--glass);border:1px solid var(--line);border-radius:var(--r);
    box-shadow:var(--sh-m);padding:28px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    overflow:hidden}
  .card::before{content:"";position:absolute;inset:0 0 auto;height:1px;background:var(--hairline);
    opacity:.9;pointer-events:none}
  .card.side{background:var(--card)}
  .side{position:sticky;top:82px}

  /* ── form head + progress ───────────────────────────────── */
  .form-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:4px}
  .form-head h2{margin:0;font-size:1.28rem}
  .form-head p{margin:4px 0 0;color:var(--muted);font-size:.87rem}
  .progress{flex:0 0 116px;height:8px;border-radius:999px;background:var(--card-3);
    overflow:hidden;margin-top:8px}
  .progress>span{display:block;height:100%;width:0;border-radius:999px;
    background:linear-gradient(90deg,var(--brand),var(--accent));transition:width .4s cubic-bezier(.4,0,.2,1)}

  /* ── steps ──────────────────────────────────────────────── */
  .step{padding:22px 0;border-top:1px dashed var(--line)}
  .step:first-of-type{border-top:0;padding-top:14px}
  .step-h{display:flex;align-items:center;gap:10px}
  .step-n{width:30px;height:30px;border-radius:10px;background:var(--brand-grad);color:#fff;
    display:grid;place-items:center;font-weight:800;font-size:.86rem;flex:0 0 auto;
    box-shadow:0 8px 18px -8px rgba(14,165,233,.72)}
  .step-h h3{margin:0;font-size:1.03rem}
  .step-p{margin:5px 0 14px;color:var(--muted);font-size:.84rem}

  /* ── service cards ──────────────────────────────────────── */
  .svcs{display:grid;gap:12px}
  @media(min-width:600px){.svcs{grid-template-columns:1fr 1fr}}
  .svc{position:relative;display:block;cursor:pointer;border:1.5px solid var(--line);
    background:var(--card-2);border-radius:var(--r-s);padding:15px;
    transition:transform .18s,border-color .18s,box-shadow .18s,background .18s}
  .svc:hover{transform:translateY(-3px);border-color:var(--brand-l);box-shadow:var(--sh-m)}
  .svc input{position:absolute;opacity:0;pointer-events:none}
  .svc-top{display:flex;align-items:center;justify-content:space-between}
  .svc-ic{width:40px;height:40px;border-radius:12px;background:var(--brand-soft);color:var(--brand);
    display:grid;place-items:center}
  .svc-ic svg{width:21px;height:21px}
  .tick{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);display:grid;
    place-items:center;color:transparent;transition:.18s}
  .tick svg{width:13px;height:13px;stroke-width:2.6}
  .svc .nm{font-weight:800;font-size:1rem;margin-top:11px;display:block}
  .svc .ds{color:var(--muted);font-size:.83rem;margin-top:2px;display:block}
  .svc .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .chip{display:inline-flex;align-items:center;gap:5px;background:var(--card);border:1px solid var(--line);
    border-radius:999px;padding:3px 10px;font-size:.78rem;color:var(--muted)}
  .chip.price{background:var(--brand-soft);border-color:transparent;color:var(--brand-ink);font-weight:800}
  .svc.sel{border-color:var(--brand);background:linear-gradient(180deg,var(--brand-soft),var(--card-2));
    box-shadow:var(--ring)}
  .svc.sel .tick{background:var(--brand);border-color:var(--brand);color:#fff}
  .svc.sel .svc-ic{background:var(--brand);color:#fff}
  .svc:focus-within{outline:2px solid var(--brand);outline-offset:2px}

  /* ── fields ─────────────────────────────────────────────── */
  .field{margin-top:16px}
  .field:first-child{margin-top:0}
  .field label{display:flex;align-items:center;gap:7px;font-size:.85rem;font-weight:700;margin:0 0 8px}
  .field label b{color:var(--err)}
  .field label .opt{color:var(--muted);font-weight:500;font-size:.77rem}
  .consent{display:flex;align-items:flex-start;gap:10px;margin-top:16px;font-size:.83rem;color:var(--muted);
    background:var(--card-2);border:1px solid var(--line-2);border-radius:var(--r-s);padding:12px 14px;line-height:1.7;cursor:pointer}
  .consent input{margin:3px 0 0;width:18px;height:18px;accent-color:var(--brand);flex:none}
  .consent.bad{border-color:var(--err);background:var(--err-soft)}
  input,select,textarea{width:100%;padding:12px 14px;border-radius:12px;border:1.5px solid var(--line);
    background:var(--card-2);color:var(--fg);font:inherit;transition:border-color .16s,box-shadow .16s,background .16s}
  input:focus,select:focus,textarea:focus{outline:0;border-color:var(--brand);box-shadow:var(--ring);background:var(--card)}
  input::placeholder,textarea::placeholder{color:var(--muted-2)}
  textarea{resize:vertical;min-height:78px}
  input.bad,textarea.bad{border-color:var(--err);box-shadow:0 0 0 4px rgba(220,38,38,.14)}
  small.err{display:block;color:var(--err);font-size:.77rem;margin-top:5px}
  small.err:empty{display:none}
  .row{display:grid;gap:0 14px}
  @media(min-width:600px){.row{grid-template-columns:1fr 1fr}}

  /* ── day chips + doctors ────────────────────────────────── */
  .days{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:9px;scrollbar-width:thin}
  .days::-webkit-scrollbar{height:6px}
  .days::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
  .day{flex:0 0 auto;min-width:78px;text-align:center;border:1.5px solid var(--line);background:var(--card-2);
    border-radius:var(--r-s);padding:8px 11px;cursor:pointer;font:inherit;color:var(--fg);transition:.16s}
  .day span{display:block;font-weight:800;font-size:.86rem}
  .day small{color:var(--muted);font-size:.71rem}
  .day:hover{border-color:var(--brand-l);transform:translateY(-2px)}
  .day[aria-pressed="true"]{background:linear-gradient(135deg,var(--brand),var(--brand-d));
    border-color:transparent;color:#fff;box-shadow:var(--sh-s)}
  .day[aria-pressed="true"] small{color:rgba(255,255,255,.85)}
  .docs{display:flex;flex-wrap:wrap;gap:9px}
  .doc{display:inline-flex;align-items:center;gap:8px;border:1.5px solid var(--line);background:var(--card-2);
    border-radius:999px;padding:6px 14px 6px 7px;cursor:pointer;font:inherit;color:var(--fg);
    font-size:.86rem;font-weight:600;transition:.16s}
  .doc .av{width:27px;height:27px;border-radius:50%;background:var(--card-3);color:var(--brand);
    display:grid;place-items:center;font-size:.76rem;font-weight:800;flex:0 0 auto}
  .doc:hover{border-color:var(--brand-l);transform:translateY(-2px)}
  .doc[aria-pressed="true"]{background:linear-gradient(135deg,var(--brand),var(--brand-d));
    border-color:transparent;color:#fff;box-shadow:var(--sh-s)}
  .doc[aria-pressed="true"] .av{background:rgba(255,255,255,.24);color:#fff}

  /* ── auto-assigned slot ─────────────────────────────────── */
  .auto-head{display:flex;align-items:center;gap:9px;margin:22px 0 12px}
  .auto-head strong{font-size:.94rem;letter-spacing:-.2px}
  .auto-head .ae{margin-inline-start:auto;font-size:.72rem;font-weight:700;color:var(--brand-ink);
    background:var(--brand-soft);border-radius:999px;padding:3px 10px}
  .next-card{position:relative;display:flex;align-items:center;gap:16px;padding:18px;border-radius:20px;
    background:linear-gradient(135deg,var(--brand-soft),var(--card-2) 62%);
    border:1.5px solid transparent;overflow:hidden;background-clip:padding-box;
    box-shadow:0 22px 46px -24px rgba(14,165,233,.55),inset 0 1px 0 rgba(255,255,255,.5);
    animation:rise .5s var(--ease) both}
  .next-card::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1.5px;
    background:linear-gradient(135deg,var(--brand),var(--brand-2) 55%,var(--brand-3));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
  .next-card::after{content:"";position:absolute;inset-inline-start:0;top:13%;bottom:13%;width:4px;
    border-radius:99px;background:var(--brand-grad)}
  .next-ic{position:relative;width:56px;height:56px;border-radius:17px;flex:0 0 auto;display:grid;place-items:center;
    background:var(--brand-grad);color:#fff;
    box-shadow:0 14px 26px -12px rgba(14,165,233,.78),inset 0 1px 0 rgba(255,255,255,.35)}
  .next-ic::after{content:"";position:absolute;inset:0;border-radius:inherit;animation:softpulse 2.6s infinite}
  @keyframes softpulse{0%{box-shadow:0 0 0 0 rgba(14,165,233,.45)}70%{box-shadow:0 0 0 14px rgba(14,165,233,0)}100%{box-shadow:0 0 0 0 rgba(14,165,233,0)}}
  .next-ic svg{position:relative;width:26px;height:26px;stroke-width:2.1}
  .next-txt{display:flex;flex-direction:column;min-width:0}
  .next-k{font-size:.78rem;color:var(--muted);font-weight:600}
  .next-t{font-size:2.15rem;font-weight:800;line-height:1.12;letter-spacing:.5px;
    background:var(--brand-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
  .next-sub{font-size:.8rem;color:var(--muted)}
  .next-badge{margin-inline-start:auto;flex:0 0 auto;font-size:.72rem;font-weight:800;color:#fff;
    background:var(--brand-grad);border-radius:999px;padding:5px 12px;
    box-shadow:0 10px 22px -12px rgba(14,165,233,.8)}
  .next-card.warn{background:var(--card-2);box-shadow:none;gap:13px;animation:none}
  .next-card.warn::before{background:linear-gradient(135deg,var(--line),var(--line))}
  .next-card.warn::after{display:none}
  .next-card.warn .next-ic{background:linear-gradient(135deg,var(--warn),#b45309);box-shadow:none}
  .next-card.warn .next-ic::after{animation:none;box-shadow:none}
  .next-card.warn .next-t{font-size:1.02rem;color:var(--fg);background:none;-webkit-text-fill-color:currentColor}
  .jump{margin-top:12px;width:100%;display:flex;align-items:center;justify-content:center;gap:8px;
    padding:13px;border-radius:var(--r-s);border:1.5px solid var(--brand-l);background:var(--card);
    color:var(--brand-ink);font:inherit;font-weight:700;cursor:pointer;transition:.16s var(--ease)}
  .jump:hover{background:var(--brand-soft);transform:translateY(-2px);box-shadow:var(--sh-s)}
  .empty{color:var(--muted);font-size:.88rem;padding:18px;background:var(--card-2);
    border:1.5px dashed var(--line);border-radius:var(--r-s);text-align:center}
  .skel-wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:9px;margin-top:14px}
  .skel{height:41px;border-radius:12px;background:linear-gradient(90deg,var(--card-2),var(--card-3),var(--card-2));
    background-size:200% 100%;animation:shimmer 1.3s infinite linear}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  .step{animation:rise .55s var(--ease) both}
  .step:nth-of-type(2){animation-delay:.07s}
  .step:nth-of-type(3){animation-delay:.14s}
  .card.side{animation:rise .6s var(--ease) both;animation-delay:.1s}

  /* ── message ────────────────────────────────────────────── */
  .msg{display:none;margin-top:16px;padding:13px 15px;border-radius:var(--r-s);font-size:.89rem;
    align-items:center;gap:9px}
  .msg.ok{display:flex;background:var(--ok-soft);border:1px solid rgba(13,148,136,.35);color:var(--ok)}
  .msg.err{display:flex;background:var(--err-soft);border:1px solid rgba(220,38,38,.35);color:var(--err)}

  /* ── summary ────────────────────────────────────────────── */
  .sum-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .sum-head h3{margin:0;font-size:1rem}
  .sum-edit{font-size:.71rem;color:var(--muted);background:var(--card-3);border-radius:999px;padding:2px 10px}
  .row2{display:flex;justify-content:space-between;gap:12px;padding:9px 0;font-size:.87rem;
    border-bottom:1px solid var(--line-2)}
  .row2:last-of-type{border-bottom:0}
  .row2 .k{color:var(--muted)}
  .row2 .v{font-weight:700;text-align:left;max-width:62%;overflow-wrap:anywhere}
  .total{margin-top:14px;padding-top:14px;border-top:2px solid var(--line);
    display:flex;justify-content:space-between;align-items:center}
  .total span{font-weight:800}
  .total b{color:var(--brand);font-size:1.4rem;font-weight:900;line-height:1}
  .cta{width:100%;margin-top:16px;padding:16px;border:0;border-radius:var(--r-s);cursor:pointer;
    font:inherit;font-weight:800;font-size:1.02rem;color:#fff;display:flex;align-items:center;
    justify-content:center;gap:9px;background:var(--brand-grad);position:relative;overflow:hidden;
    box-shadow:0 18px 36px -14px rgba(14,165,233,.82),inset 0 1px 0 rgba(255,255,255,.28);
    transition:transform .18s var(--ease),box-shadow .18s,opacity .18s}
  .cta::after{content:"";position:absolute;top:0;bottom:0;inset-inline-start:-40%;width:35%;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);
    transform:skewX(-18deg);transition:inset-inline-start .6s var(--ease)}
  .cta:hover{transform:translateY(-2px);box-shadow:0 22px 46px -14px rgba(14,165,233,.92),inset 0 1px 0 rgba(255,255,255,.3)}
  .cta:hover::after{inset-inline-start:120%}
  .cta:active{transform:translateY(0)}
  .cta:disabled{opacity:.6;cursor:not-allowed;transform:none}
  .spinner{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.45);
    border-top-color:#fff;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .tip{color:var(--muted);font-size:.78rem;margin:14px 0 0;line-height:1.7}
  .trust{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .trust span{display:inline-flex;align-items:center;gap:5px;font-size:.73rem;color:var(--muted);
    background:var(--card-2);border:1px solid var(--line-2);border-radius:999px;padding:4px 10px}

  /* ── success ────────────────────────────────────────────── */
  .ticket{text-align:center;padding:36px 26px 32px}
  .ticket::after{content:"";position:absolute;top:0;inset-inline:0;height:4px;background:var(--brand-grad)}
  .seal{width:92px;height:92px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle at 50% 42%,var(--ok-soft),transparent 72%);position:relative}
  .seal .ring{position:absolute;inset:0;border-radius:50%;border:2.5px solid var(--ok);opacity:0;
    animation:ring .7s ease}
  @keyframes ring{0%{transform:scale(.5);opacity:.6}100%{transform:scale(1.25);opacity:0}}
  .seal svg{width:46px;height:46px;fill:none;stroke:var(--ok);stroke-width:2.4;
    stroke-linecap:round;stroke-linejoin:round}
  .seal svg path{stroke-dasharray:36;stroke-dashoffset:36;animation:draw .5s .15s ease forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  .ticket h2{margin:0 0 6px;font-size:1.42rem}
  .rec{display:inline-flex;align-items:center;gap:9px;background:var(--card-2);border:1px dashed var(--line);
    border-radius:12px;padding:8px 14px;font-size:.84rem;color:var(--muted);margin:14px 0 4px}
  .rec b{color:var(--fg);font-family:ui-monospace,Consolas,monospace;letter-spacing:.5px}
  .rec button{border:0;background:transparent;color:var(--brand);cursor:pointer;display:grid;place-items:center;padding:2px}
  .rec button:hover{color:var(--brand-ink)}
  .ticket .rows{text-align:start;margin-top:16px;background:var(--card-2);border:1px solid var(--line-2);
    border-radius:var(--r-s);padding:6px 16px}
  .ticket .total{margin-top:16px}
  .actions{display:grid;gap:10px;margin-top:20px}
  @media(min-width:520px){.actions{grid-template-columns:1fr 1fr}}
  .act{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:13px;
    border:1.5px solid var(--line);background:var(--card-2);color:var(--fg);font:inherit;font-weight:700;
    cursor:pointer;transition:transform .16s,border-color .16s;text-decoration:none}
  .act:hover{border-color:var(--brand-l);transform:translateY(-2px)}
  .act.wide{grid-column:1/-1}
  .act.primary{background:var(--brand-grad);border-color:transparent;color:#fff;
    box-shadow:0 12px 26px -14px rgba(14,165,233,.8)}

  /* ── off / not available ────────────────────────────────── */
  .off{text-align:center;padding:58px 24px}
  .off h1{font-size:1.35rem;margin:14px 0 8px}
  .off p{margin:0}

  /* ── mobile action bar ──────────────────────────────────── */
  .bottombar{position:fixed;inset-inline:0;bottom:0;z-index:60;background:var(--glass);
    backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid var(--glass-line);
    transform:translateY(115%);transition:transform .32s cubic-bezier(.4,0,.2,1);
    padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
  .bottombar.show{transform:translateY(0)}
  .bb-in{max-width:1000px;margin:0 auto;display:flex;align-items:center;gap:14px}
  .bb-info{display:flex;flex-direction:column;line-height:1.25}
  .bb-k{font-size:.71rem;color:var(--muted)}
  .bb-v{font-weight:900;color:var(--brand);font-size:1.08rem}
  .bb-btn{flex:1;padding:14px;border:0;border-radius:var(--r-s);font:inherit;font-weight:800;color:#fff;
    cursor:pointer;background:var(--brand-grad);
    box-shadow:0 14px 30px -12px rgba(14,165,233,.8),inset 0 1px 0 rgba(255,255,255,.26)}
  .bb-btn:disabled{opacity:.6}
  @media(min-width:980px){.bottombar{display:none}}

  /* ── toasts ─────────────────────────────────────────────── */
  .toasts{position:fixed;bottom:86px;inset-inline-end:16px;z-index:80;display:flex;flex-direction:column;
    gap:10px;pointer-events:none;max-width:min(360px,86vw)}
  @media(min-width:980px){.toasts{bottom:20px}}
  .toast{display:flex;align-items:center;gap:9px;padding:12px 15px;border-radius:var(--r-s);
    background:var(--card);border:1px solid var(--line);box-shadow:var(--sh-l);font-size:.87rem;
    opacity:0;transform:translateY(14px);transition:.3s}
  .toast.in{opacity:1;transform:none}
  .toast.out{opacity:0;transform:translateY(14px)}
  .toast.ok{color:var(--ok)}
  .toast.err{border-color:rgba(220,38,38,.4);color:var(--err)}

  /* ── phones ─────────────────────────────────────────────── */
  @media(max-width:560px){
    .hero{padding:18px 15px 72px}
    .hero h1{font-size:1.34rem}
    .logo{width:48px;height:48px;border-radius:15px;font-size:1.3rem}
    .hero-in{gap:12px}
    .hero-tools{gap:8px}
    .status{display:none}
    .hero-meta{gap:7px}
    .hero-meta a,.hero-meta span{font-size:.79rem;padding:5px 11px}
    .hero-strip{gap:6px 14px;font-size:.74rem}
    .wrap{padding:0 13px 104px;margin-top:-46px;gap:15px}
    .card{padding:18px;border-radius:18px}
    .form-head{gap:12px}
    .form-head h2{font-size:1.15rem}
    .progress{flex-basis:92px}
    .next-t{font-size:1.7rem}
    .next-card{padding:14px;gap:12px}
    .next-badge{display:none}
    .side{position:static}
    .ticket{padding:26px 18px}
    .toasts{inset-inline:16px;max-width:none}
  }
  @media(prefers-reduced-motion:reduce){
    *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
    html{scroll-behavior:auto}
  }
  @media print{
    .minibar,.hero,.bottombar,.toasts,.side,.no-print{display:none!important}
    body{background:#fff}
    .wrap{margin:0;padding:0;display:block}
    .card{box-shadow:none;border:0;padding:0}
  }
</style>
</head>
<body>

<div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>
<div class="noise" aria-hidden="true"></div>

<header class="minibar" id="minibar">
  <div class="mb-in">
    <span class="logo sm" id="mblogo"></span>
    <span class="mb-name" id="mbname">${escHtml(name)}</span>
    <span class="mb-spacer"></span>
    <a class="mb-call" id="mbcall" hidden></a>
    <button class="tg" id="tg2" type="button" aria-label="تبديل المظهر" title="تبديل المظهر"></button>
  </div>
</header>

<section class="hero">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="hero-in">
    <div class="brand">
      <span class="logo" id="logo"></span>
      <div>
        <span class="eyebrow">حجز موعد إلكتروني</span>
        <h1 id="hname">${escHtml(name)}</h1>
      </div>
    </div>
    <div class="hero-tools">
      <span class="status"><i></i> استقبال الحجوزات مفتوح</span>
      <button class="tg" id="tg" type="button" aria-label="تبديل المظهر" title="تبديل المظهر"></button>
    </div>
  </div>
  <div class="hero-meta" id="hmeta"></div>
  <div class="hero-strip" id="hstrip"></div>
</section>

<main>
  <div class="wrap" id="wrap">
    <div class="card" id="card">
      <div class="skel-wrap"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>
    </div>
  </div>
</main>

<div class="bottombar" id="bottombar">
  <div class="bb-in">
    <div class="bb-info"><span class="bb-k">الإجمالي المتوقع</span><span class="bb-v" id="bbv">—</span></div>
    <button type="button" class="bb-btn" id="bbbtn">تأكيد الحجز</button>
  </div>
</div>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="true"></div>

<noscript><div style="padding:40px;text-align:center">يتطلّب هذا النموذج تشغيل JavaScript لإتمام الحجز.</div></noscript>

<script>
const D = ${data};
const $ = function(s){ return document.querySelector(s); };
const $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
const API = "/api/public/booking/" + D.slug;

var I = {
  pin:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 21s6.5-5.1 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.9 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.4"/></svg>',
  phone:'<svg class="ic" viewBox="0 0 24 24"><path d="M6.6 3h3l1.5 4.1-2.1 1.4a13.5 13.5 0 0 0 5.4 5.4l1.4-2.1L19 13.4v3a2 2 0 0 1-2.2 2A16.4 16.4 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3Z"/></svg>',
  clock:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l3 2"/></svg>',
  cal:'<svg class="ic" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg>',
  user:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 20a6.8 6.8 0 0 1 13.6 0"/></svg>',
  sun:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.4v2M12 19.6v2M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2.4 12h2M19.6 12h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/></svg>',
  moon:'<svg class="ic" viewBox="0 0 24 24"><path d="M20 14.6A8.2 8.2 0 0 1 9.4 4 8.3 8.3 0 1 0 20 14.6Z"/></svg>',
  check:'<svg class="ic" viewBox="0 0 24 24"><path d="m5 12.5 4.4 4.4L19 7"/></svg>',
  clinic:'<svg class="ic" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  tooth:'<svg viewBox="0 0 24 24"><path d="M8.2 3.5C6.1 3.5 4.6 5.1 4.6 7.6c0 2 .6 3.2 1 5 .3 1.4.3 2.6.6 4 .2 1 .6 1.9 1.3 1.9.9 0 .9-1.6 1.2-3 .2-1 .5-1.7 1.3-1.7s1.1.7 1.3 1.7c.3 1.4.3 3 1.2 3 .7 0 1.1-.9 1.3-1.9.3-1.4.3-2.6.6-4 .4-1.8 1-3 1-5 0-2.5-1.5-4.1-3.6-4.1-1.2 0-1.8.6-2.4.6s-1.2-.6-2.4-.6Z"/></svg>',
  spark:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M18.4 5.6l-2.5 2.5M8.1 15.9l-2.5 2.5"/></svg>',
  shield:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3l7 2.8V11c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V5.8L12 3Z"/></svg>',
  copy:'<svg class="ic" viewBox="0 0 24 24"><rect x="8.6" y="8.6" width="11" height="11" rx="2"/><path d="M15.6 8.6V6.2A2.2 2.2 0 0 0 13.4 4H6.2A2.2 2.2 0 0 0 4 6.2v7.2A2.2 2.2 0 0 0 6.2 15.6h2.4"/></svg>',
  print:'<svg class="ic" viewBox="0 0 24 24"><path d="M7 9V4h10v5M7 17H5.2A1.7 1.7 0 0 1 3.5 15.3V11A2 2 0 0 1 5.5 9h13a2 2 0 0 1 2 2v4.3A1.7 1.7 0 0 1 18.8 17H17"/><rect x="7" y="14" width="10" height="6.5" rx="1.4"/></svg>',
  ics:'<svg class="ic" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3.5v3M16 3.5v3M3.5 9.5h17M12 12.2v4.6M9.7 14.5h4.6"/></svg>',
  refresh:'<svg class="ic" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/></svg>',
  info:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8h.01"/></svg>'
};

/* ── theme (shares the key with the main app) ── */
function paintThemeBtn(btn, dark){ if(btn){ btn.innerHTML = dark ? I.sun : I.moon; btn.title = dark ? "الوضع النهاري" : "الوضع الليلي"; } }
var dark = false;
try { var saved = localStorage.getItem("theme"); dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; }
catch(e){ dark = matchMedia("(prefers-color-scheme: dark)").matches; }
function applyTheme(d){ dark = d; document.documentElement.classList.toggle("dark", d); paintThemeBtn($("#tg"), d); paintThemeBtn($("#tg2"), d); try { localStorage.setItem("theme", d ? "dark" : "light"); } catch(e){} }
applyTheme(dark);
$("#tg").addEventListener("click", function(){ applyTheme(!dark); });
$("#tg2").addEventListener("click", function(){ applyTheme(!dark); });

/* ── tiny helpers (no backslashes anywhere: the template would eat them) ── */
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function p2(n){ return (n<10?"0":"") + n; }
function iso(d){ return d.getFullYear() + "-" + p2(d.getMonth()+1) + "-" + p2(d.getDate()); }
function ar(d){ return d.toLocaleDateString("ar-EG", { weekday:"long", day:"numeric", month:"long" }); }
function initial(str){ var t=String(str==null?"":str).trim(); return t ? t.charAt(0) : "؟"; }
function toast(text, kind){
  var box=$("#toasts"); if(!box) return;
  var t=document.createElement("div"); t.className="toast " + (kind==="err"?"err":"ok");
  t.innerHTML=(kind==="err"?I.info:I.check) + "<span>" + esc(text) + "</span>";
  box.appendChild(t);
  requestAnimationFrame(function(){ t.classList.add("in"); });
  setTimeout(function(){ t.classList.remove("in"); t.classList.add("out"); setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },360); }, 3800);
}
function fallbackCopy(txt){ var t=document.createElement("textarea"); t.value=txt; t.setAttribute("readonly",""); t.style.position="fixed"; t.style.top="-1000px"; document.body.appendChild(t); t.select(); try{ document.execCommand("copy"); }catch(e){} document.body.removeChild(t); }
function icsDate(dt){ return dt.getFullYear() + p2(dt.getMonth()+1) + p2(dt.getDate()) + "T" + p2(dt.getHours()) + p2(dt.getMinutes()) + "00"; }

/* ── minibar reveal on scroll ── */
function onScroll(){ var m=$("#minibar"); if(m) m.classList.toggle("show", window.scrollY > 150); }
window.addEventListener("scroll", onScroll, { passive:true });
onScroll();

/* ── not-available page ── */
function renderOff(){
  document.querySelector("main .wrap").classList.add("single");
  $("#wrap").innerHTML =
    '<div class="card off">' +
      '<div class="seal"><span class="ring"></span><svg viewBox="0 0 24 24"><path d="M12 3l7 2.8V11c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V5.8L12 3Z"/></svg></div>' +
      '<h1>الحجز غير متاح</h1>' +
      '<p class="muted">هذا الرابط غير صحيح، أو أن العيادة أوقفت الحجز عبر الموقع.<br>يرجى التواصل مع العيادة مباشرةً.</p>' +
    '</div>';
  var bar=$("#bottombar"); if(bar) bar.classList.remove("show");
  var strip=$("#hstrip"); if(strip) strip.innerHTML="";
}

if (!D.slug) {
  renderOff();
} else {

const state = { clinic:{}, services:[], doctors:[], serviceId:"", time:"", doctorId:"", movedDay:false };

function money(n, cur){ return Number(n||0).toLocaleString("en-US") + " " + (cur || state.clinic.currency || "ر.س"); }
function mins(n){ return Number(n||0) + " دقيقة"; }
function svcOf(id){ return state.services.filter(function(s){ return s.id===id; })[0] || null; }
function docOf(id){ return state.doctors.filter(function(d){ return d.id===id; })[0] || null; }
function row2(k, v){ return '<div class="row2"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }

/* ── summary panel ── */
function summaryHTML(){
  var s = svcOf(state.serviceId);
  var dayVal = $("#date") ? $("#date").value : "";
  var when = (state.time && dayVal) ? (ar(new Date(dayVal + "T00:00:00")) + " — " + state.time) : "لم يُحدَّد بعد";
  var doc = docOf(state.doctorId);
  var h = '<div class="sum-head"><h3>ملخّص الموعد</h3><span class="sum-edit">يتحدّث تلقائياً</span></div>';
  h += row2("الخدمة", s ? esc(s.name) : "—");
  h += row2("المدة", s ? esc(mins(s.durationMin)) : "—");
  if (state.doctors.length) h += row2("الطبيب", esc(doc ? doc.fullName : "أي طبيب متاح"));
  h += row2("اليوم والوقت", esc(when));
  h += '<div class="total"><span>الإجمالي المتوقع</span><b>' + (s ? esc(money(s.price)) : "—") + '</b></div>';
  h += '<button type="submit" form="f" class="cta" id="send">' + I.check + '<span>تأكيد الحجز</span></button>';
  h += '<p class="tip">الأسعار المعروضة تقديرية وقد تتغيّر. الحجز عبر الموقع لا يتطلّب أي دفع، ويُثبَّت السعر والموعد نهائياً عند مكالمة التأكيد من العيادة.</p>';
  h += '<div class="trust"><span>' + I.shield + ' بيانات محمية</span><span>' + I.clock + ' تأكيد سريع</span><span>' + I.ics + ' إضافة للتقويم</span></div>';
  return h;
}
function paintSummary(){ var box=$("#sum"); if(box) box.innerHTML = summaryHTML(); }

function syncBars(){
  var bar=$("#bottombar"); if(!bar) return;
  var s=svcOf(state.serviceId);
  var v=$("#bbv"); if(v) v.textContent = s ? money(s.price) : "—";
  bar.classList.toggle("show", !!$("#f"));
}

/* ── progress bar ── */
function validName(v){ return String(v).trim().length >= 3; }
function validPhone(v){ return /^[0-9()+ -]{7,20}$/.test(String(v).trim()); }
function updateProgress(){
  var checks=[];
  if (state.services.length) checks.push(!!state.serviceId);
  checks.push(!!($("#date") && $("#date").value));
  checks.push(!!state.time);
  checks.push(validName($("#name") ? $("#name").value : ""));
  checks.push(validPhone($("#phone") ? $("#phone").value : ""));
  var n=0; for(var i=0;i<checks.length;i++) if(checks[i]) n++;
  var bar=$("#pbar"); if(bar) bar.style.width = Math.round(n / checks.length * 100) + "%";
}

/* ── service cards ── */
function serviceCards(){
  if(!state.services.length) return '<p class="empty">لم تُضِف العيادة أي خدمة بعد، يمكنك حجز موعد عام.</p>';
  var out='<div class="svcs">';
  for(var i=0;i<state.services.length;i++){
    var s=state.services[i], sel=(state.serviceId===s.id);
    out += '<label class="svc' + (sel?' sel':'') + '" data-id="' + s.id + '">' +
      '<input type="radio" name="svc" value="' + s.id + '"' + (sel?' checked':'') + '>' +
      '<div class="svc-top"><span class="svc-ic">' + I.clinic + '</span><span class="tick">' + I.check + '</span></div>' +
      '<span class="nm">' + esc(s.name) + '</span>' +
      (s.description ? '<span class="ds">' + esc(s.description) + '</span>' : '') +
      '<span class="chips"><span class="chip">' + I.clock + ' ' + esc(mins(s.durationMin)) + '</span>' +
      '<span class="chip price">' + esc(money(s.price)) + '</span></span></label>';
  }
  return out + '</div>';
}
function paintServices(){
  var box=$("#svcs"); if(!box) return;
  box.innerHTML=serviceCards();
  $$("#svcs .svc").forEach(function(el){
    el.addEventListener("click", function(){
      state.serviceId = el.getAttribute("data-id");
      paintServices(); loadSlots();
    });
  });
}

/* ── day shortcuts ── */
function paintDays(){
  var box=$("#daychips"); if(!box) return;
  var today=new Date(); today.setHours(0,0,0,0);
  var cur=$("#date").value;
  var labels=["اليوم","غداً","بعد غد"];
  var out="";
  for(var i=0;i<7;i++){
    var d=new Date(today); d.setDate(d.getDate()+i);
    var val=iso(d);
    var lbl = i<3 ? labels[i] : d.toLocaleDateString("ar-EG",{weekday:"short"});
    var sub = d.toLocaleDateString("ar-EG",{day:"numeric",month:"short"});
    out += '<button type="button" class="day" data-d="' + val + '"' + (val===cur?' aria-pressed="true"':'') + '>' +
      '<span>' + lbl + '</span><small>' + esc(sub) + '</small></button>';
  }
  box.innerHTML=out;
  $$("#daychips .day").forEach(function(b){
    b.addEventListener("click", function(){
      $("#date").value = b.getAttribute("data-d");
      paintDays(); loadSlots();
    });
  });
}

/* ── doctor pills ── */
function paintDocs(){
  var wrap=$("#docwrap"), box=$("#docs"); if(!wrap||!box) return;
  if(!state.doctors.length){ wrap.hidden=true; box.innerHTML=""; return; }
  wrap.hidden=false;
  var out='<button type="button" class="doc" data-id=""' + (!state.doctorId?' aria-pressed="true"':'') + '><span class="av">' + I.spark + '</span>أي طبيب متاح</button>';
  for(var i=0;i<state.doctors.length;i++){
    var d=state.doctors[i];
    out += '<button type="button" class="doc" data-id="' + d.id + '"' + (state.doctorId===d.id?' aria-pressed="true"':'') + '><span class="av">' + esc(initial(d.fullName)) + '</span>' + esc(d.fullName) + '</button>';
  }
  box.innerHTML=out;
  $$("#docs .doc").forEach(function(b){
    b.addEventListener("click", function(){
      state.doctorId = b.getAttribute("data-id") || "";
      paintDocs(); loadSlots();
    });
  });
}

/* ── auto-assigned slot ── */
function autoSkeleton(){ return '<div class="skel" style="height:86px"></div>'; }
function fmtDay(dstr){ return ar(new Date(dstr + "T00:00:00")); }
function paintAuto(d){
  var box=$("#auto"); if(!box) return;
  var here = d.next && d.next.date === d.date;
  if(here){
    state.time = d.next.time;
    box.innerHTML =
      '<div class="next-card">' +
        '<span class="next-ic">' + I.clock + '</span>' +
        '<span class="next-txt">' +
          '<span class="next-k">أقرب موعد متاح لك</span>' +
          '<span class="next-t">' + esc(d.next.time) + '</span>' +
          '<span class="next-sub">مدة الموعد ' + esc(mins(d.durationMin)) + '</span>' +
        '</span>' +
        '<span class="next-badge">يُحجز تلقائياً</span>' +
      '</div>' +
      '<p class="tip">' + I.info + ' يُخصَّص الموعد تلقائياً حسب المواعيد المحجوزة ومدة كل موعد، فلا حاجة لاختيار الوقت.</p>';
  } else if(d.next){
    state.time = "";
    box.innerHTML =
      '<div class="next-card warn">' +
        '<span class="next-ic">' + I.info + '</span>' +
        '<span class="next-txt">' +
          '<span class="next-k">هذا اليوم ممتلئ</span>' +
          '<span class="next-t">عذراً، انتهت المواعيد المتاحة في هذا اليوم.</span>' +
        '</span>' +
      '</div>' +
      '<button type="button" class="jump" id="jump">' + I.cal + ' أقرب موعد في ' + esc(fmtDay(d.next.date)) + ' — ' + esc(d.next.time) + '</button>';
  } else {
    state.time = "";
    box.innerHTML =
      '<div class="next-card warn">' +
        '<span class="next-ic">' + I.info + '</span>' +
        '<span class="next-txt">' +
          '<span class="next-k">لا تتوفر مواعيد</span>' +
          '<span class="next-t">عذراً، انتهت المواعيد المتاحة حالياً — يرجى المحاولة لاحقاً.</span>' +
        '</span>' +
      '</div>';
  }
  paintSummary(); updateProgress(); syncBars();
}
function loadSlots(){
  if(!D.slug) return Promise.resolve();
  var box=$("#auto"); if(!box) return Promise.resolve();
  state.time="";
  box.innerHTML=autoSkeleton();
  paintSummary(); updateProgress(); syncBars();
  var q = "date=" + encodeURIComponent($("#date").value) +
    "&serviceId=" + encodeURIComponent(state.serviceId) +
    "&doctorId=" + encodeURIComponent(state.doctorId || "");
  return fetch(API + "/slots?" + q)
    .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
    .then(function(res){
      var d=res.d;
      if(!res.ok) throw new Error((d && d.error) || "تعذّر تحديد الموعد");
      paintAuto(d);
      var jump=$("#jump");
      if(jump) jump.addEventListener("click", function(){
        $("#date").value = d.next.date;
        paintDays(); loadSlots();
      });
    })
    .catch(function(e){
      box.innerHTML='<div class="empty">' + esc(e.message) + '</div>';
    });
}

/* ── message ── */
function say(text, kind){
  var m=$("#msg"); if(!m) return;
  if(!text){ m.className="msg"; m.innerHTML=""; return; }
  m.className="msg " + kind;
  m.innerHTML=(kind==="err"?I.info:I.check) + "<span>" + esc(text) + "</span>";
}

/* ── validation ── */
function validate(showAll){
  var nameEl=$("#name"), phoneEl=$("#phone");
  var nOk=validName(nameEl?nameEl.value:""), pOk=validPhone(phoneEl?phoneEl.value:"");
  if(nameEl){ nameEl.classList.toggle("bad", showAll && !nOk); var en=$("#ename"); if(en) en.textContent = (showAll && !nOk) ? "الاسم مطلوب (٣ أحرف على الأقل)" : ""; }
  if(phoneEl){ phoneEl.classList.toggle("bad", showAll && !pOk); var ep=$("#ephone"); if(ep) ep.textContent = (showAll && !pOk) ? "رقم جوال غير صالح" : ""; }
  var ok = nOk && pOk;
  var cEl=$("#consent"), cWrap=$("#consentwrap");
  if(cWrap) cWrap.classList.toggle("bad", showAll && cEl && !cEl.checked);
  if(showAll && cEl && !cEl.checked) ok=false;
  if(showAll){ if(state.services.length && !state.serviceId) ok=false; if(!state.time) ok=false; }
  return ok;
}

/* ── render the form ── */
function render(){
  var maxDate=new Date(); maxDate.setDate(maxDate.getDate() + D.daysAhead);
  var svcStep = state.services.length
    ? '<section class="step"><div class="step-h"><span class="step-n">1</span><h3>اختر الخدمة</h3></div>' +
      '<p class="step-p">المدة والسعر يحدّدان الأوقات المتاحة لك.</p><div id="svcs"></div></section>'
    : '';

  $("#wrap").classList.remove("single");
  $("#wrap").innerHTML =
    '<div class="card">' +
      '<form id="f" novalidate>' +
        '<div class="form-head">' +
          '<div><h2>احجز موعدك</h2><p>ثلاث خطوات بسيطة ويصلك تأكيد الموعد.</p></div>' +
          '<div class="progress" aria-hidden="true"><span id="pbar"></span></div>' +
        '</div>' +
        svcStep +
        '<section class="step"><div class="step-h"><span class="step-n">' + (state.services.length?2:1) + '</span><h3>اختر اليوم</h3></div>' +
          '<p class="step-p">نمنحك تلقائياً أقرب وقت متاح في اليوم الذي تختاره.</p>' +
          '<div class="field"><label for="date">' + I.cal + ' اليوم</label><div class="days" id="daychips"></div><input id="date" type="date" required></div>' +
          '<div class="field" id="docwrap" hidden><label>' + I.user + ' الطبيب</label><div class="docs" id="docs"></div></div>' +
          '<div class="auto-head"><strong>' + I.clock + ' الموعد المخصّص لك</strong><span class="ae">يُحدَّد آلياً</span></div>' +
          '<div id="auto"></div>' +
        '</section>' +
        '<section class="step"><div class="step-h"><span class="step-n">' + (state.services.length?3:2) + '</span><h3>بياناتك</h3></div>' +
          '<p class="step-p">نستعملها فقط لتأكيد الموعد.</p>' +
          '<div class="row">' +
            '<div class="field"><label for="name">' + I.user + ' الاسم الكامل <b>*</b></label><input id="name" autocomplete="name" placeholder="اكتب اسمك هنا"><small class="err" id="ename"></small></div>' +
            '<div class="field"><label for="phone">' + I.phone + ' رقم الجوال <b>*</b></label><input id="phone" inputmode="tel" autocomplete="tel" placeholder="05xxxxxxxx"><small class="err" id="ephone"></small></div>' +
          '</div>' +
          '<div class="field"><label for="note">' + I.info + ' ملاحظات للعيادة <span class="opt">اختياري</span></label><textarea id="note" rows="3" maxlength="500" placeholder="سبب الزيارة أو أي ملاحظة"></textarea></div>' +
          '<label class="consent" id="consentwrap"><input type="checkbox" id="consent"><span>أوافق على استخدام اسمي ورقم جوالی لتأكيد الموعد والتواصل بشأنه فقط، ويمكنني طلب حذفها لاحقاً.</span></label>' +
        '</section>' +
      '</form>' +
      '<div class="msg" id="msg" role="status" aria-live="polite"></div>' +
    '</div>' +
    '<aside class="card side"><div id="sum"></div></aside>';

  var d=$("#date");
  d.min=iso(new Date());
  d.max=iso(maxDate);
  d.value=iso(new Date());

  paintServices(); paintDocs(); paintDays(); paintSummary();
  d.addEventListener("change", function(){ paintDays(); loadSlots(); });
  $("#name").addEventListener("input", function(){ updateProgress(); validate(false); });
  $("#phone").addEventListener("input", function(){ updateProgress(); validate(false); });
  var cEl=$("#consent"); if(cEl) cEl.addEventListener("change", function(){ updateProgress(); validate(false); });
  $("#f").addEventListener("submit", submit);
  updateProgress(); syncBars();
  return loadSlots();
}

/* ── submit ── */
function submit(ev){
  ev.preventDefault();
  var nameEl=$("#name"), phoneEl=$("#phone");
  var name=nameEl.value.trim(), phone=phoneEl.value.trim();
  var problems=[];
  if(!validName(name)) problems.push(nameEl);
  if(!validPhone(phone)) problems.push(phoneEl);
  if(state.services.length && !state.serviceId) problems.push({ svc:true });
  if(!state.time) problems.push({ slots:true });
  var cEl=$("#consent");
  if(cEl && !cEl.checked) problems.push({ consent:true });
  validate(true);
  if(problems.length){
    say("يرجى إكمال الحقول المطلوبة قبل التأكيد", "err");
    toast("يرجى إكمال الحقول المطلوبة", "err");
    var first=problems[0];
    if(first && first.focus) first.focus();
    else if(first && first.svc){ var sv=$("#svcs"); if(sv) sv.scrollIntoView({behavior:"smooth",block:"center"}); }
    else if(first && first.consent){ var cw=$("#consentwrap"); if(cw) cw.scrollIntoView({behavior:"smooth",block:"center"}); }
    else { var sl=$("#auto"); if(sl) sl.scrollIntoView({behavior:"smooth",block:"center"}); }
    updateProgress();
    return;
  }
  var btn=$("#send");
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="spinner"></span><span>جارِ الإرسال…</span>'; }
  var bb=$("#bbbtn"); if(bb) bb.disabled=true;
  say("", "");
  fetch(API, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ patientName:name, phone:phone, date:$("#date").value, doctorId:state.doctorId || "", serviceId:state.serviceId, note:$("#note").value, consent: !!($("#consent") && $("#consent").checked) })
  })
  .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, status:r.status, d:d }; }); })
  .then(function(r){
    if(!r.ok){
      if (r.status === 423) { renderClosed((r.d && r.d.error) || "", ""); return; }
      if (r.status === 409) loadSlots();
      throw new Error((r.d && r.d.error) || "تعذّر إتمام الحجز");
    }
    done(r.d);
  })
  .catch(function(e){
    say(e.message, "err");
    toast(e.message, "err");
    if(btn){ btn.disabled=false; btn.innerHTML=I.check + '<span>تأكيد الحجز</span>'; }
    if(bb) bb.disabled=false;
  });
}

/* ── success screen ── */
function downloadIcs(a){
  if(!a.date || !a.time){ toast("لا تتوفر بيانات كافية لإنشاء الحدث", "err"); return; }
  var start=new Date(a.date + "T" + a.time + ":00");
  var end=new Date(start.getTime() + (Number(a.durationMin) || 20) * 60000);
  var NL=String.fromCharCode(13,10);
  var lines=[
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Eyada//Booking//AR","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + (a.id || String(Date.now())) + "@eyada",
    "DTSTAMP:" + icsDate(new Date()),
    "DTSTART:" + icsDate(start),
    "DTEND:" + icsDate(end),
    "SUMMARY:" + (a.serviceName || "موعد") + " - " + (a.clinicName || state.clinic.name || ""),
    "LOCATION:" + (state.clinic.address || ""),
    "DESCRIPTION:رقم الحجز " + (a.id || ""),
    "END:VEVENT","END:VCALENDAR"
  ];
  var link=document.createElement("a");
  link.href="data:text/calendar;charset=utf-8," + encodeURIComponent(lines.join(NL));
  link.download="appointment.ics";
  document.body.appendChild(link); link.click();
  setTimeout(function(){ document.body.removeChild(link); }, 0);
  toast("تم تجهيز ملف التقويم", "ok");
}
function done(d){
  var a=d.appointment || {};
  state.time = a.time || state.time;
  $("#wrap").classList.add("single");
  var when = a.date ? ar(new Date(a.date + "T00:00:00")) : "";
  var rows =
    row2("الخدمة", esc(a.serviceName || "موعد عام")) +
    row2("اليوم", esc(when)) +
    row2("الوقت", esc(a.time || "")) +
    row2("المدة", esc(mins(a.durationMin)));
  $("#wrap").innerHTML =
    '<div class="card ticket" id="ticket">' +
      '<div class="seal"><span class="ring"></span><svg viewBox="0 0 24 24"><path d="m5 12.5 4.4 4.4L19 7"/></svg></div>' +
      '<h2>تم استلام طلب الحجز</h2>' +
      '<p class="muted">' + esc(d.message || "") + '</p>' +
      '<div class="rec">رقم الطلب: <b id="recno">' + esc(a.id || "") + '</b>' +
        '<button type="button" id="copybtn" title="نسخ الرقم" aria-label="نسخ الرقم">' + I.copy + '</button></div>' +
      '<div class="rows">' + rows + '</div>' +
      '<div class="total"><span>الإجمالي المتوقع</span><b>' + esc(money(a.price)) + '</b></div>' +
      (state.clinic.phone
        ? '<p class="tip">لتأكيد الموعد تواصل مع العيادة على <strong>' + esc(state.clinic.phone) + '</strong>.</p>'
        : '<p class="tip">سيتم تأكيد الموعد معك هاتفياً.</p>') +
      '<div class="actions">' +
        '<button type="button" class="act primary" id="icsbtn">' + I.ics + ' إضافة للتقويم</button>' +
        (a.manageUrl ? '<button type="button" class="act" id="managebtn">' + I.clock + ' إدارة الحجز أو إلغاؤه</button>' : '') +
        '<button type="button" class="act" id="printbtn">' + I.print + ' طباعة</button>' +
        '<button type="button" class="act wide" id="againbtn">' + I.refresh + ' حجز موعد آخر</button>' +
      '</div>' +
    '</div>';
  var bar=$("#bottombar"); if(bar) bar.classList.remove("show");
  $("#againbtn").addEventListener("click", function(){ state.time=""; state.movedDay=false; render(); window.scrollTo({ top:0, behavior:"smooth" }); });
  var mbtn=$("#managebtn"); if(mbtn) mbtn.addEventListener("click", function(){ location.href = a.manageUrl; });
  $("#printbtn").addEventListener("click", function(){ window.print(); });
  $("#icsbtn").addEventListener("click", function(){ downloadIcs(a); });
  $("#copybtn").addEventListener("click", function(){
    var txt=a.id || "";
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){ toast("تم نسخ رقم الطلب", "ok"); }, function(){ fallbackCopy(txt); toast("تم نسخ رقم الطلب", "ok"); });
    } else { fallbackCopy(txt); toast("تم نسخ رقم الطلب", "ok"); }
  });
  window.scrollTo({ top:0, behavior:"smooth" });
  toast("تم استلام طلبك بنجاح", "ok");
}

/* ── mobile bar ── */
$("#bbbtn").addEventListener("click", function(){
  var f=$("#f");
  if(!f) return;
  if(f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { cancelable:true }));
});

/* ── closed page: clinic staff stopped the public site ── */
function renderClosed(msg, until){
  document.querySelector("main .wrap").classList.add("single");
  var nm = (state.clinic && state.clinic.name) || D.name || "";
  var body = msg ? esc(msg) : ("عيادة " + esc(nm) + " أوقفت الحجز عبر الموقع مؤقتاً.");
  var untilHtml = until ? '<p class="muted">يعود الموقع للعمل بتاريخ ' + esc(until) + '.</p>' : '';
  var phoneHtml = (state.clinic && state.clinic.phone)
    ? '<p class="tip">للتواصل مع العيادة: <strong><a href="tel:' + esc(state.clinic.phone) + '">' + esc(state.clinic.phone) + '</a></strong></p>'
    : '';
  $("#wrap").innerHTML =
    '<div class="card off">' +
      '<div class="seal"><span class="ring"></span><svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg></div>' +
      '<h1>الموقع مغلق مؤقتاً</h1>' +
      '<p class="muted">' + body + '</p>' + untilHtml + phoneHtml +
    '</div>';
  var bar=$("#bottombar"); if(bar) bar.classList.remove("show");
  var strip=$("#hstrip"); if(strip) strip.innerHTML="";
}

/* ── manage booking (cancel / reschedule via hashed token link) ── */
function manageError(msg){
  $("#wrap").classList.add("single");
  $("#wrap").innerHTML =
    '<div class="card off">' +
      '<div class="seal"><span class="ring"></span><svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg></div>' +
      '<h1>تعذّر فتح الرابط</h1>' +
      '<p class="muted">' + esc(msg || "رابط غير صالح أو منتهي الصلاحية.") + '</p>' +
    '</div>';
  var bar=$("#bottombar"); if(bar) bar.classList.remove("show");
}
function renderManage(token){
  $("#wrap").classList.add("single");
  $("#wrap").innerHTML = '<div class="card"><div class="empty">' + I.clock + ' جارٍ تحميل بيانات الحجز…</div></div>';
  var bar=$("#bottombar"); if(bar) bar.classList.remove("show");
  fetch(API + "/appointment?token=" + encodeURIComponent(token))
    .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
    .then(function(r){
      if(!r.ok || !r.d || !r.d.appointment){ manageError(r.d && r.d.error); return; }
      manageCard(r.d, token);
    })
    .catch(function(){ manageError("تعذّر الاتصال بالخادم، جرّب لاحقاً."); });
}
function manageCard(d, token){
  var a=d.appointment || {};
  var cancelled = String(a.status) === "cancelled" || String(a.status) === "canceled";
  var rows =
    row2("العيادة", esc(a.clinicName || state.clinic.name || "")) +
    row2("اليوم", esc(a.date || "")) +
    row2("الوقت", esc(a.time || "")) +
    row2("الحالة", cancelled ? "ملغي" : "مؤكّد");
  var body =
    '<div class="card ticket" id="ticket">' +
      '<div class="seal"><span class="ring"></span><svg viewBox="0 0 24 24"><path d="m5 12.5 4.4 4.4L19 7"/></svg></div>' +
      '<h2>إدارة موعدك</h2>' +
      '<p class="muted">يمكنك تأجيل الموعد أو إلغاؤه من هنا قبل موعده.</p>' +
      '<div class="rows">' + rows + '</div>';
  if(cancelled){
    body += '<p class="tip">تم إلغاء هذا الموعد. يمكنك حجز موعد جديد من صفحة العيادة.</p>' +
      '<div class="actions"><button type="button" class="act wide" id="mhome">' + I.refresh + ' حجز موعد جديد</button></div>';
  } else if(d.canCancel === false){
    body += '<p class="tip">لا يمكن تعديل هذا الموعد حالياً. يرجى التواصل مع العيادة.</p>';
  } else {
    body +=
      '<div class="field" style="margin-top:18px"><label for="mdate">' + I.cal + ' تأجيل إلى يوم آخر</label>' +
        '<input id="mdate" type="date" min="' + iso(new Date()) + '"></div>' +
      '<div class="actions">' +
        '<button type="button" class="act primary" id="mresched">' + I.refresh + ' تأجيل الموعد</button>' +
        '<button type="button" class="act" id="mcancel">' + I.info + ' إلغاء الحجز</button>' +
      '</div>';
  }
  body += '</div>';
  $("#wrap").innerHTML = body;

  var hm=$("#mhome"); if(hm) hm.addEventListener("click", function(){ state.time=""; render(); window.scrollTo({ top:0, behavior:"smooth" }); });
  var rs=$("#mresched"); if(rs) rs.addEventListener("click", function(){ manageReschedule(token, rs); });
  var cc=$("#mcancel"); if(cc) cc.addEventListener("click", function(){ manageCancel(token, cc); });
}
function manageCancel(token, btn){
  if(btn){ btn.disabled=true; }
  fetch(API + "/cancel", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ token:token }) })
    .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
    .then(function(r){
      if(!r.ok){ toast((r.d && r.d.error) || "تعذّر إلغاء الحجز", "err"); if(btn) btn.disabled=false; return; }
      toast("تم إلغاء الموعد", "ok");
      renderManage(token);
    })
    .catch(function(){ toast("تعذّر الاتصال بالخادم", "err"); if(btn) btn.disabled=false; });
}
function manageReschedule(token, btn){
  var de=$("#mdate");
  var val=de ? de.value : "";
  if(!val){ toast("اختر اليوم الجديد أولاً", "err"); if(de) de.focus(); return; }
  if(btn){ btn.disabled=true; }
  fetch(API + "/reschedule", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ token:token, date:val }) })
    .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
    .then(function(r){
      if(!r.ok){ toast((r.d && r.d.error) || "تعذّر تأجيل الحجز", "err"); if(btn) btn.disabled=false; return; }
      toast("تم تأجيل الموعد بنجاح", "ok");
      renderManage(token);
    })
    .catch(function(){ toast("تعذّر الاتصال بالخادم", "err"); if(btn) btn.disabled=false; });
}

/* ── boot ── */
function boot(){
  fetch(API)
    .then(function(r){ return r.json(); })
    .then(function(d){
      state.clinic = d.clinic || {};
      state.services = d.services || [];
      state.doctors = d.doctors || [];
      if(!state.serviceId && state.services.length) state.serviceId = state.services[0].id;

      var nm = state.clinic.name || D.name || "";
      $("#logo").textContent = initial(nm);
      var mb=$("#mblogo"); if(mb) mb.textContent = initial(nm);
      var mn=$("#mbname"); if(mn) mn.textContent = nm;

      var meta=[];
      if(state.clinic.address) meta.push('<span>' + I.pin + ' ' + esc(state.clinic.address) + '</span>');
      if(state.clinic.phone) meta.push('<a href="tel:' + esc(state.clinic.phone) + '">' + I.phone + ' ' + esc(state.clinic.phone) + '</a>');
      $("#hmeta").innerHTML = meta.join("");

      if(d.closed){ renderClosed(d.closedMessage, d.closedUntil); return; }

      var mtoken = new URLSearchParams(location.search).get("manage");
      if(mtoken){ renderManage(mtoken); return; }

      var strip=[I.check + " تأكيد الموعد فوراً", I.clock + " مواعيد من ٨ صباحاً حتى ١٠ مساءً", I.shield + " بياناتك محفوظة"];
      $("#hstrip").innerHTML = strip.map(function(x){ return "<span>" + x + "</span>"; }).join("");

      var call=$("#mbcall");
      if(call && state.clinic.phone){ call.href="tel:" + state.clinic.phone; call.innerHTML=I.phone + " اتصل"; call.hidden=false; }

      render();
    })
    .catch(function(){
      $("#card").innerHTML = '<div class="empty">تعذّر تحميل بيانات العيادة، حدّث الصفحة أو جرّب لاحقاً.</div>';
    });
}
boot();

}
</script>
</body>
</html>`;
}

module.exports = { buildBookingPage };
