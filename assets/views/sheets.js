/* Telas alimentadas pela "Quasi — Master Tracking Spreadsheet":
   Refunds, Subscriptions, Reshipments, Supplier issues, Order lookup e Data check.

   Cada tela faz UMA chamada ao banco (uma função de relatório que devolve tudo
   pronto) e se atualiza sozinha a cada minuto enquanto está aberta. Tudo o que
   vem da planilha é texto digitado por pessoas: passa por esc() antes do HTML. */

import { supabase } from '../supabase.js';
import {
  lineChart, seriesColor, wireCharts, barList,
  fmtInt, fmtMoney, fmtRange, fmtDay, esc,
} from '../charts.js';

const FUSO = 'America/New_York';
const AUTO_MS = 60 * 1000;

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function presets() {
  const t = hoje();
  return [
    { id: 'today', short: 'Today', from: t, to: t },
    { id: 'yesterday', short: 'Yesterday', from: addDays(t, -1), to: addDays(t, -1) },
    { id: 'last7', short: '7 days', from: addDays(t, -6), to: t },
    { id: 'last30', short: '30 days', from: addDays(t, -29), to: t },
    { id: 'last60', short: '60 days', from: addDays(t, -59), to: t },
  ];
}

const rpcReal = async (nome, params) => {
  const { data, error } = await supabase.rpc(nome, params);
  if (error) throw new Error(error.message);
  return data;
};

// Aviso quando o período usa datas estimadas (histórico espalhado entre 08/07 e 16/09).
const avisoEstimado = (t) => (t.estimated
  ? `<p class="note note--scoped" style="margin-top:12px">${fmtInt(t.estimated)} of ${fmtInt(t.count)} in this period have an <b>estimated</b> date: rows added before Sep 17, 2026 had no date, so they were spread evenly from Jul 8 to Sep 16 in sheet order (top = oldest). Numbers per day or week before Sep 17 are an approximation; only the full Jul 8 – Sep 16 total is exact.</p>`
  : '');

const money = (v) => fmtMoney(v == null ? null : Number(v));
const cents = (v) => fmtMoney(v == null ? null : Number(v), { cents: true });
const pctDe = (a, b) => (b ? `${Number(((a / b) * 100).toFixed(1))}%` : '—');

/* ------------------------------------------------------ peças visuais -- */

function variacao(atual, anterior, dir, fmt = fmtInt) {
  if (anterior == null || atual == null) return '';
  const delta = atual - anterior;
  if (Math.abs(delta) < 1e-9) return '<span class="delta delta--flat">no change</span>';
  const tom = dir === 0 ? 'delta--flat' : ((dir > 0 ? delta > 0 : delta < 0) ? 'delta--good' : 'delta--bad');
  return `<span class="delta ${tom}">${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta))}</span>`;
}

function tile({ label, value, delta = '', foot = '' }) {
  return `<div class="rtile">
    <span class="rtile__label">${esc(label)}</span>
    <span class="rtile__value">${value}</span>
    <span class="rtile__foot">${delta}${foot ? `<span>${foot}</span>` : ''}</span>
  </div>`;
}

function barras(lista, { valor = 'count', sub } = {}) {
  if (!lista?.length) return '<p class="empty">Nothing in this period.</p>';
  return barList(lista.map((x) => ({ label: x.key, value: Number(x[valor]) || 0, sub: sub ? sub(x) : '' })), { format: fmtInt });
}

function grafico(porDia, { campo = 'count', rotulo, formato = fmtInt }, alvo) {
  if (!porDia?.length) return '<p class="empty">No dated rows in this period yet.</p>';
  if (porDia.length < 2) return '<p class="note">Only one day with data in this period — pick a longer range to see the trend.</p>';
  return lineChart({
    days: porDia.map((d) => d.date),
    series: [{ key: campo, label: rotulo, color: seriesColor(0), values: porDia.map((d) => Number(d[campo]) || 0) }],
    formatValue: formato, yLabel: rotulo, height: 220,
    width: Math.max(420, Math.round(alvo?.clientWidth || 780)),
  });
}

const card = (titulo, nota, corpo, extra = '') => `<section class="card">
  <div class="card__head"><div>
    <h2 class="card__title">${titulo}</h2>${nota ? `<p class="card__note">${nota}</p>` : ''}
  </div>${extra}</div>
  <div class="card__body">${corpo}</div>
</section>`;

/* --------------------------------------------- montagem com período -- */

const ESTADOS = {};

function montarComPeriodo(host, def, { rpc = rpcReal } = {}) {
  const S = ESTADOS[def.id] ??= { preset: 'last30', from: null, to: null, body: null, key: null, loading: false, silencioso: false, error: null, ctrl: null };
  S.rpc = rpc;
  if (!S.from) { const p = presets().find((x) => x.id === S.preset); S.from = p.from; S.to = p.to; }

  host.innerHTML = `
    <div class="card rp-controls">
      <div class="rp-bar">
        <div class="seg" data-s="presets" role="group" aria-label="Quick ranges"></div>
        <form class="range" data-s="range" novalidate>
          <input type="date" data-s="from" aria-label="From">
          <span class="hint" aria-hidden="true">–</span>
          <input type="date" data-s="to" aria-label="To">
          <button class="btn btn--primary" type="submit" data-s="apply">Apply</button>
        </form>
      </div>
      <div class="rp-status" data-s="status" aria-live="polite"></div>
    </div>
    <div class="view" data-s="conteudo"></div>`;

  const $s = (n) => host.querySelector(`[data-s="${n}"]`);
  const raiz = $s('conteudo');   // some quando a pessoa troca de aba

  const pintarControles = () => {
    $s('presets').innerHTML = presets().map((p) => {
      const on = p.from === S.from && p.to === S.to;
      return `<button type="button" data-preset="${p.id}" class="${on ? 'is-on' : ''}" aria-pressed="${on}" title="${esc(fmtRange(p.from, p.to))}">${esc(p.short)}</button>`;
    }).join('');
    $s('from').value = S.from; $s('to').value = S.to;
    $s('from').max = $s('to').max = hoje();
    validar();
  };
  const validar = () => {
    const f = $s('from').value, t = $s('to').value;
    const ok = f && t && f <= t && !(f === S.from && t === S.to);
    $s('apply').disabled = !ok;
    return ok;
  };
  const pintarStatus = () => {
    const el = $s('status');
    if (S.loading) { el.innerHTML = '<span class="loading__pulse" aria-hidden="true"></span> Loading…'; return; }
    if (S.error) { el.innerHTML = `<span class="is-error">${esc(S.error)}</span> <button type="button" class="btn" data-recarregar>Try again</button>`; return; }
    el.innerHTML = `<span class="rp-live">From the tracking spreadsheet · ${esc(fmtRange(S.from, S.to))}</span>
      <span>updates every minute</span> <button type="button" class="btn" data-recarregar>Refresh</button>`;
  };
  const pintar = () => {
    pintarStatus();
    const alvo = $s('conteudo');
    if (!S.body) { alvo.innerHTML = S.loading ? '<p class="empty">Loading…</p>' : ''; return; }
    alvo.innerHTML = def.render(S.body, S, alvo);
    wireCharts(alvo);
  };

  const carregar = async ({ silent = false } = {}) => {
    if (silent && (S.loading || S.silencioso)) return;
    S.ctrl?.abort?.();
    const ctrl = { aborted: false, abort() { this.aborted = true; } };
    S.ctrl = ctrl;
    const chave = `${S.from}|${S.to}`;
    if (silent) S.silencioso = true; else { S.loading = true; S.error = null; host.classList.add('is-loading'); pintarStatus(); }
    let mudou = true;
    try {
      const body = await S.rpc(def.rpc, { p_from: S.from, p_to: S.to });
      if (ctrl.aborted) return;
      mudou = !(silent && S.key === chave && JSON.stringify(body) === JSON.stringify(S.body));
      S.body = body; S.key = chave;
    } catch (err) {
      if (ctrl.aborted) return;
      if (silent) mudou = false; else S.error = err.message;
    } finally {
      if (S.ctrl === ctrl) { S.loading = false; S.silencioso = false; host.classList.remove('is-loading'); }
    }
    if (S.ctrl !== ctrl || !raiz.isConnected) return;
    if (mudou) pintar(); else pintarStatus();
  };

  $s('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    const p = presets().find((x) => x.id === b.dataset.preset);
    S.preset = p.id; S.from = p.from; S.to = p.to;
    pintarControles(); carregar();
  });
  for (const n of ['from', 'to']) $s(n).addEventListener('input', validar);
  $s('range').addEventListener('submit', (e) => {
    e.preventDefault(); if (!validar()) return;
    S.preset = null; S.from = $s('from').value; S.to = $s('to').value;
    pintarControles(); carregar();
  });
  $s('status').addEventListener('click', (e) => { if (e.target.closest('[data-recarregar]')) carregar(); });

  pintarControles();
  pintar();
  if (!(S.body && S.key === `${S.from}|${S.to}`)) carregar();
  agendar(def.id, host, () => carregar({ silent: true }));
}

const TIMERS = {};
function agendar(id, host, fn) {
  clearInterval(TIMERS[id]);
  TIMERS[id] = setInterval(() => {
    if (host.hidden) { clearInterval(TIMERS[id]); return; }
    if (document.visibilityState === 'visible') fn();
  }, AUTO_MS);
}

/* ---------------------------------------------------------- Refunds -- */

export function mountRefunds(host, opts) {
  montarComPeriodo(host, {
    id: 'refunds',
    rpc: 'report_refunds',
    render(b, S, alvo) {
      const t = b.totals ?? {}, p = b.previous ?? {};
      const tiles = [
        tile({ label: 'Refunded', value: money(t.refunded), delta: variacao(Number(t.refunded), Number(p.refunded), -1, money), foot: `${fmtInt(t.count)} refunds` }),
        tile({ label: 'Refunds', value: fmtInt(t.count), delta: variacao(t.count, p.count, -1) }),
        tile({ label: 'Revenue kept with partial refunds', value: money(t.kept), delta: variacao(Number(t.kept), Number(p.kept), 1, money), foot: `${fmtInt(t.partial)} customers took a partial refund` }),
        tile({ label: 'Full refunds', value: fmtInt(t.full), delta: variacao(t.full, p.full, -1), foot: `${pctDe(t.partial, t.count)} of refunds were partial` }),
        tile({ label: 'Need to verify', value: fmtInt(t.need_verify), delta: variacao(t.need_verify, p.need_verify, -1) }),
      ].join('');

      const verificar = (b.verify_list ?? []).length
        ? `<div class="tablewrap"><table><thead><tr><th>Sheet row</th><th>Order</th><th>Date</th><th class="num">Amount</th><th>Reason</th></tr></thead>
            <tbody>${b.verify_list.map((r) => `<tr><td>${fmtInt(r.row)}</td><td>${esc(r.order ?? '—')}</td><td>${r.date ? esc(fmtDay(r.date)) : '—'}</td>
              <td class="num">${money(r.amount)}</td><td>${esc(r.reason ?? '—')}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Nothing waiting for verification in this period.</p>';

      return `
        <div class="card"><div class="rtiles" style="margin-top:0">${tiles}</div>
          ${b.undated ? `<p class="note">${fmtInt(b.undated)} row(s) in the sheet have no refund date and are not counted in any period — see Data check.</p>` : ''}
        </div>
        ${card('Refunded per day', 'Money given back each day, in dollars.', grafico(b.by_day, { campo: 'refunded', rotulo: 'Refunded', formato: (v) => fmtMoney(v) }, alvo))}
        <div class="grid grid--2">
          ${card('Why customers were refunded', null, barras(b.by_reason, { sub: (x) => money(x.amount) }))}
          ${card('How it was resolved', 'A partial refund keeps the rest of the order value.', barras(b.by_resolution, { sub: (x) => money(x.amount) }))}
        </div>
        <div class="grid grid--2">
          ${card('Subscription after the refund', null, barras(b.by_subscription))}
          ${card('Need to verify', 'Most recent first, with the row number in the sheet.', verificar)}
        </div>`;
    },
  }, opts);
}

/* ---------------------------------------------------- Subscriptions -- */

export function mountSubscriptions(host, opts) {
  montarComPeriodo(host, {
    id: 'subscriptions',
    rpc: 'report_subscriptions',
    render(b, S, alvo) {
      const t = b.totals ?? {}, p = b.previous ?? {}, h = b.all_time ?? {};
      const tiles = [
        tile({ label: 'Requests', value: fmtInt(t.count), delta: variacao(t.count, p.count, -1) }),
        tile({ label: 'Cancellations', value: fmtInt(t.cancellations), delta: variacao(t.cancellations, p.cancellations, -1) }),
        tile({ label: 'Changes (frequency, quantity, pause, skip)', value: fmtInt(t.changes), delta: variacao(t.changes, p.changes, 0) }),
        tile({ label: 'Saved', value: fmtInt(t.saved), delta: variacao(t.saved, p.saved, 1), foot: 'retained, paused or skipped' }),
        tile({ label: 'No reason given', value: fmtInt(t.no_reason) }),
      ].join('');
      return `
        <div class="card"><div class="rtiles" style="margin-top:0">${tiles}</div>
          <p class="note">Each customer counts once — the most recent row for an email wins.</p>${avisoEstimado(t)}
        </div>
        ${card('Requests per day', null, grafico(b.by_day, { rotulo: 'Requests' }, alvo))}
        <div class="grid grid--2">
          ${card('Why customers cancel', 'Grouped from the free-form reasons in the sheet.', barras(b.by_reason))}
          ${card('What they asked for', null, barras(b.by_management))}
        </div>
        ${card('Outcome', null, barras(b.by_outcome))}
        ${card(`History — all ${fmtInt(h.count)} customers`, `Every row in the sheet${h.undated ? `, including ${fmtInt(h.undated)} without any date` : ''}.`, barras(h.by_reason))}`;
    },
  }, opts);
}

/* ------------------------------------------------------ Reshipments -- */

export function mountReshipments(host, opts) {
  montarComPeriodo(host, {
    id: 'reshipments',
    rpc: 'report_reshipments',
    render(b, S, alvo) {
      const t = b.totals ?? {}, p = b.previous ?? {}, h = b.all_time ?? {};
      const tiles = [
        tile({ label: 'Cases', value: fmtInt(t.count), delta: variacao(t.count, p.count, -1) }),
        tile({ label: 'Reshipment issued', value: fmtInt(t.issued), delta: variacao(t.issued, p.issued, 0) }),
        tile({ label: 'Fulfilled or delivered', value: fmtInt(t.delivered), delta: variacao(t.delivered, p.delivered, 1) }),
        tile({ label: 'Customer not messaged', value: fmtInt(t.not_messaged), delta: variacao(t.not_messaged, p.not_messaged, -1) }),
        tile({ label: 'Asked for a refund', value: fmtInt(t.refund_requests), delta: variacao(t.refund_requests, p.refund_requests, -1) }),
      ].join('');
      return `
        <div class="card"><div class="rtiles" style="margin-top:0">${tiles}</div>
          <p class="note">Each order counts once — the most recent row wins.</p>${avisoEstimado(t)}
        </div>
        ${card('Cases per day', null, grafico(b.by_day, { rotulo: 'Cases' }, alvo))}
        <div class="grid grid--2">
          ${card('Why the order failed', null, barras(b.by_reason))}
          ${card('Where each case stands', null, barras(b.by_status))}
        </div>
        <div class="grid grid--2">
          ${card('What the customer asked for', null, barras(b.by_request))}
          ${card('By agent', null, barras(b.by_agent))}
        </div>
        <div class="grid grid--2">
          ${card(`History — status of all ${fmtInt(h.count)} orders`, (h.undated ? `Including ${fmtInt(h.undated)} without any date.` : null), barras(h.by_status))}
          ${card('History — why they failed', null, barras(h.by_reason))}
        </div>`;
    },
  }, opts);
}

/* -------------------------------------------------- Supplier issues -- */

export function mountSupplierIssues(host, opts) {
  montarComPeriodo(host, {
    id: 'supplier',
    rpc: 'report_supplier_issues',
    render(b, S, alvo) {
      const t = b.totals ?? {}, p = b.previous ?? {}, h = b.all_time ?? {};
      const tiles = [
        tile({ label: 'Cases', value: fmtInt(t.count), delta: variacao(t.count, p.count, -1) }),
        tile({ label: 'Unfulfilled', value: fmtInt(t.unfulfilled), delta: variacao(t.unfulfilled, p.unfulfilled, -1) }),
        tile({ label: 'Lost in transit', value: fmtInt(t.lost), delta: variacao(t.lost, p.lost, -1) }),
        tile({ label: 'Product quality', value: fmtInt(t.quality), delta: variacao(t.quality, p.quality, -1), foot: 'unbranded, damaged, wrong or missing item' }),
        tile({ label: 'Customer not messaged', value: fmtInt(t.not_messaged), delta: variacao(t.not_messaged, p.not_messaged, -1) }),
      ].join('');
      return `
        <div class="card"><div class="rtiles" style="margin-top:0">${tiles}</div>
          <p class="note">From the Dianxiaomi order issues tab. Each order counts once — the most recent row wins.</p>${avisoEstimado(t)}
        </div>
        ${card('Cases per day', null, grafico(b.by_day, { rotulo: 'Cases' }, alvo))}
        <div class="grid grid--2">
          ${card('What went wrong', null, barras(b.by_reason))}
          ${card('By agent', null, barras(b.by_agent))}
        </div>
        ${card(`History — all ${fmtInt(h.count)} orders`, `${fmtInt(h.not_messaged)} with the customer not marked as messaged.`, barras(h.by_reason))}`;
    },
  }, opts);
}

/* ----------------------------------------------------- Order lookup -- */

const LOOKUP = { q: '', body: null, loading: false, error: null };

const CAMPOS = {
  refunds: { titulo: 'Refund Tracker', campos: [['refund_date', 'Refund date', (v) => (v ? fmtDay(v) : '—')], ['refunded_amount', 'Refunded', cents], ['total_amount', 'Order total', cents], ['resolution', 'Resolution'], ['reason', 'Reason'], ['refund_status', 'Status'], ['subscription_status', 'Subscription'], ['ticket_link', 'Ticket']] },
  reshipments: { titulo: 'Reshipment - 3pl', campos: [['entry_date', 'Date', (v) => (v ? fmtDay(v) : 'no date')], ['est_date', 'Estimated date', fmtDay], ['agent', 'Agent'], ['reason', 'Reason'], ['customer_request', 'Customer asked for'], ['new_order_number', 'New order'], ['status', 'Status'], ['messaged', 'Messaged'], ['description', 'Description']] },
  supplier_issues: { titulo: 'Order Issues - Dianxiaomi', campos: [['entry_date', 'Date', (v) => (v ? fmtDay(v) : 'no date')], ['est_date', 'Estimated date', fmtDay], ['agent', 'Agent'], ['reason', 'Reason'], ['status', 'Status'], ['reshipment_tracking', 'Reshipment tracking'], ['description', 'Description']] },
  subscriptions: { titulo: 'Subscription Tracker', campos: [['entry_date', 'Date', (v) => (v ? fmtDay(v) : 'no date')], ['est_date', 'Estimated date', fmtDay], ['management', 'Request'], ['reason_raw', 'Reason'], ['reason_group', 'Reason group'], ['outcome', 'Outcome'], ['requests', 'Notes']] },
};

export function mountLookup(host, { rpc = rpcReal } = {}) {
  host.innerHTML = `
    <div class="card">
      <form class="lookup" data-l="form">
        <input class="search lookup__input" type="search" data-l="q" placeholder="Order number (e.g. 254310) or customer email" aria-label="Order number or customer email" autocomplete="off">
        <button class="btn btn--primary" type="submit">Search</button>
      </form>
      <p class="note">Searches the four tabs at once: refunds, reshipments, supplier issues (by order number) and subscriptions (by email).</p>
    </div>
    <div data-l="res" aria-live="polite"></div>`;
  const q = host.querySelector('[data-l="q"]');
  q.value = LOOKUP.q;
  const pintar = () => {
    const alvo = host.querySelector('[data-l="res"]');
    if (LOOKUP.loading) { alvo.innerHTML = '<p class="empty">Searching…</p>'; return; }
    if (LOOKUP.error) { alvo.innerHTML = `<p class="rp-error">${esc(LOOKUP.error)}</p>`; return; }
    if (!LOOKUP.body) { alvo.innerHTML = ''; return; }
    const blocos = Object.entries(CAMPOS).map(([k, cfg]) => {
      const linhas = LOOKUP.body[k] ?? [];
      if (!linhas.length) return '';
      return card(`${esc(cfg.titulo)} <span class="chip chip--none chip--plain">${linhas.length}</span>`, null,
        linhas.map((r) => `<div class="lookup__item">
          <div class="lookup__row">Sheet row ${fmtInt(r.row_number)}${r.order_number ? ` · order ${esc(r.order_number)}` : ''}${r.email ? ` · ${esc(r.email)}` : ''}</div>
          <dl class="deflist deflist--compact">${cfg.campos.filter(([c]) => r[c] != null && r[c] !== '').map(([c, rot, fmt]) =>
            `<dt>${esc(rot)}</dt><dd>${fmt ? esc(fmt(r[c])) : esc(r[c])}</dd>`).join('')}</dl>
        </div>`).join(''));
    }).join('');
    alvo.innerHTML = blocos || `<p class="empty">Nothing found for "${esc(LOOKUP.q)}" in the four tabs.</p>`;
  };
  host.querySelector('[data-l="form"]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const termo = q.value.trim();
    if (termo.length < 3) return;
    LOOKUP.q = termo; LOOKUP.loading = true; LOOKUP.error = null; pintar();
    try { LOOKUP.body = await rpc('order_lookup', { p_query: termo }); }
    catch (err) { LOOKUP.error = err.message; LOOKUP.body = null; }
    finally { LOOKUP.loading = false; pintar(); }
  });
  pintar();
  setTimeout(() => q.focus(), 0);
}

/* ------------------------------------------------------- Data check -- */

const NOMES = {
  refunds: ['Refund Tracker', 'Refunds'],
  subscriptions: ['Subscription Tracker - Cancella', 'Subscriptions'],
  reshipments: ['Reshipment - 3pl', 'Reshipments'],
  supplier_issues: ['Order Issues - Dianxiaomi', 'Supplier issues'],
};

const quando = (iso) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};
const bate = (ok) => `<span class="chip ${ok ? 'chip--good' : 'chip--crit'}">${ok ? 'match' : 'mismatch'}</span>`;

export function mountDataCheck(host, { rpc = rpcReal } = {}) {
  const S = ESTADOS.check ??= { body: null, error: null };
  const pintar = () => {
    if (S.error) { host.innerHTML = `<p class="rp-error">${esc(S.error)}</p>`; return; }
    if (!S.body) { host.innerHTML = '<p class="empty">Loading…</p>'; return; }
    const cards = Object.entries(NOMES).map(([k, [aba, rotulo]]) => {
      const x = S.body[k] ?? {};
      const run = x.last_run ?? {};
      const naPlanilha = run.sheet_stats?.rows;
      const saudavel = run.ok !== false;
      const linhasBatem = naPlanilha != null && naPlanilha === x.stored;
      const somaPlanilha = run.sheet_stats?.refunded_sum;
      const somaBate = k === 'refunds' && somaPlanilha != null && Math.abs(Number(somaPlanilha) - Number(x.refunded_sum)) < 0.01;
      const problemas = (x.issues ?? []).map((i) => `<li>Row ${fmtInt(i.row)}: ${esc(i.issues.join('; '))}</li>`).join('');
      const diaOuTexto = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s ?? '') ? fmtDay(s) : String(s ?? '—'));
      const correcoes = (x.corrections ?? []).map((c) => `<li>Row ${fmtInt(c.row)}: ${esc(diaOuTexto(c.raw))} in the sheet → counted as ${esc(diaOuTexto(c.used))}</li>`).join('');
      return `<section class="card">
        <div class="card__head">
          <div><h2 class="card__title">${esc(rotulo)} <span class="chip ${saudavel ? 'chip--good' : 'chip--crit'}">${saudavel ? 'syncing' : 'sync failed'}</span></h2>
            <p class="card__note">Tab "${esc(aba)}" · last change received ${esc(quando(run.finished_at))} · last checked ${esc(quando(x.last_check))}</p></div>
        </div>
        ${!saudavel ? `<p class="rp-error">${esc(run.error ?? 'Unknown error')}</p>` : ''}
        <dl class="stat-inline" style="margin-top:14px">
          <div><dt>Rows in the sheet</dt><dd>${naPlanilha == null ? '—' : fmtInt(naPlanilha)}<span class="sub">non-empty rows sent</span></dd></div>
          <div><dt>Rows in the portal</dt><dd>${fmtInt(x.stored)}<span class="sub">${naPlanilha == null ? '' : bate(linhasBatem)}</span></dd></div>
          ${x.cases != null ? `<div><dt>Unique cases</dt><dd>${fmtInt(x.cases)}<span class="sub">newest row per ${k === 'subscriptions' ? 'email' : 'order'}</span></dd></div>` : ''}
          ${k === 'refunds' ? `<div><dt>Refunded — sheet vs portal</dt><dd>${cents(somaPlanilha)}<span class="sub">portal ${cents(x.refunded_sum)} ${somaPlanilha == null ? '' : bate(somaBate)}</span></dd></div>` : ''}
          ${x.estimated != null ? `<div><dt>Estimated date</dt><dd>${fmtInt(x.estimated)}<span class="sub">old rows spread Jul 8 – Sep 16</span></dd></div>` : ''}
          <div><dt>Without a date</dt><dd>${fmtInt(x.undated)}<span class="sub">only in history, not in periods</span></dd></div>
          <div><dt>Rows with a problem</dt><dd>${fmtInt(x.with_issues)}<span class="sub">still counted</span></dd></div>
        </dl>
        ${problemas ? `<details class="check-details"><summary>See rows with a problem</summary><ul>${problemas}</ul></details>` : ''}
        ${correcoes ? `<details class="check-details"><summary>${fmtInt(x.corrected)} refund date(s) with day and month swapped</summary><ul>${correcoes}</ul></details>` : ''}
      </section>`;
    }).join('');

    const t = hoje(), ini = addDays(t, -29);
    const data = (iso) => `DATE(${iso.slice(0, 4)},${+iso.slice(5, 7)},${+iso.slice(8, 10)})`;
    host.innerHTML = `
      ${cards}
      ${card('Check it yourself in the sheet', 'Paste these in any empty cell of the spreadsheet and compare with the portal.', `
        <dl class="deflist">
          <dt>Total refunded</dt><dd><code class="formula">=SUM('Refund Tracker'!G:G)</code> — compare with "Refunded — sheet vs portal" above.</dd>
          <dt>Refunded in the last 30 days</dt><dd><code class="formula">=SUMIFS('Refund Tracker'!G:G,'Refund Tracker'!B:B,"&gt;="&amp;${data(ini)},'Refund Tracker'!B:B,"&lt;="&amp;${data(t)})</code> — compare with Refunds → 30 days. It can differ only by the rows listed under "day and month swapped", which the sheet counts on the wrong date.</dd>
          <dt>Unique reshipment orders</dt><dd><code class="formula">=COUNTUNIQUE('Reshipment - 3pl'!B2:B)</code> — compare with Unique cases. Rows without an order number count as their own case in the portal.</dd>
          <dt>Unique subscription customers</dt><dd><code class="formula">=COUNTUNIQUE(ARRAYFORMULA(LOWER('Subscription Tracker - Cancella'!A3:A)))</code></dd>
        </dl>`)}`;
  };
  const carregar = async () => {
    try { S.body = await rpc('data_check', {}); S.error = null; } catch (err) { S.error = err.message; }
    pintar();
  };
  pintar();
  carregar();
  agendar('check', host, carregar);
}
