/* Partida: login, abas, filtros, tema e renderizadores.

   Nada aqui calcula métrica e nada aqui busca arquivo. Ele decide o que mostrar
   e passa adiante o que data.js (dados de demonstração) ou reports.js (dados
   reais do Commslayer) entregam. */

import { supabase } from './supabase.js';
import { loadData } from './data.js';
import { presets, compareWindow, clampRange, daysBetween } from './metrics.js';
import { wireCharts, fmtRange, fmtDay, fmtInt, esc } from './charts.js';

import { mountReports } from './views/reports.js';
import {
  mountRefunds, mountSubscriptions, mountReshipments, mountSupplierIssues, mountLookup, mountDataCheck,
} from './views/sheets.js';
import { renderOverview } from './views/overview.js';
import { renderOperation } from './views/operation.js';
import { renderChargebacks } from './views/chargebacks.js';
import { renderPlans } from './views/plans.js';
import { renderSources } from './views/sources.js';

const plural = (n, um, varios) => (n === 1 ? um : `${fmtInt(n)} ${varios}`);

const VIEWS = {
  reports: {
    title: 'Reports',
    mount: mountReports,
    sub: () => 'Live from Commslayer — the same numbers as the Commslayer portal.',
  },
  refunds: {
    title: 'Refunds',
    mount: mountRefunds,
    sub: () => 'From the Refund Tracker tab of the tracking spreadsheet. Each row is one refund.',
  },
  subscriptions: {
    title: 'Subscriptions',
    mount: mountSubscriptions,
    sub: () => 'Cancellations and changes from the Subscription Tracker tab.',
  },
  reshipments: {
    title: 'Reshipments',
    mount: mountReshipments,
    sub: () => 'Failed orders and reshipments from the Reshipment - 3pl tab.',
  },
  supplier: {
    title: 'Supplier issues',
    mount: mountSupplierIssues,
    sub: () => 'Order problems from the Order Issues - Dianxiaomi tab.',
  },
  lookup: {
    title: 'Order lookup',
    mount: mountLookup,
    sub: () => 'Everything the tracking spreadsheet has about one order or customer, in one place.',
  },
  datacheck: {
    title: 'Data check',
    mount: mountDataCheck,
    sub: () => 'Does the portal match the spreadsheet? Row counts, totals and anything that needs attention.',
  },
  overview: {
    title: 'Overview',
    render: renderOverview,
    sub: (s) => `${fmtRange(s.window.from, s.window.to)}` +
      (s.compare
        ? ` · compared with the ${plural(s.compare.days, 'day', 'days')} before.`
        : ' · there is no earlier data of the same length to compare against.'),
  },
  operation: {
    title: 'Operations',
    render: renderOperation,
    sub: () => 'Where the queue stands right now and who is holding what. Internal view.',
  },
  chargebacks: {
    title: 'Chargebacks',
    render: renderChargebacks,
    sub: (s) => `Disputes opened ${fmtRange(s.window.from, s.window.to)}, and where every case stands today.`,
  },
  plans: {
    title: 'Action plans',
    render: renderPlans,
    sub: () => 'What we committed to fixing, and the number each plan will be judged by.',
  },
  sources: {
    title: 'Where the numbers come from',
    render: renderSources,
    sub: () => 'What each metric measures, how it is computed, and what changes when the data goes live.',
  },
};

// Quais filtros da barra fazem sentido em cada tela. Reports tem os próprios
// controles, iguais aos do portal do Commslayer.
const USA_PERIODO = new Set(['overview', 'chargebacks', 'sources']);
const USA_MOTIVO = new Set(['overview', 'operation']);

const $ = (sel) => document.querySelector(sel);

const state = { view: 'reports', reason: null, presetId: null, window: null, compare: null };
let data = null;          // dados de demonstração; null se não carregaram
let PRESETS = [];
let iniciado = false;

/* ---------------------------------------------------------------- boot -- */

wireTheme();
wireAuth();

async function start() {
  try {
    data = await loadData();
    PRESETS = presets(data.meta);
    setRange(data.meta.period_start, data.meta.period_end);
    fillReasonFilter();
    showWarnings(data.warnings);
    wireRange();
  } catch (err) {
    // Sem os dados de demonstração, Reports continua funcionando.
    console.error(err);
    data = null;
  }

  $('#filter-reason').addEventListener('change', (e) => {
    state.reason = e.target.value || null;
    render();
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.view));
  });

  addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS[v] && v !== state.view) go(v, { silent: true });
  });

  const initial = location.hash.slice(1);
  if (VIEWS[initial]) state.view = initial;

  render();
}

/* --------------------------------------------------------------- login -- */

function wireAuth() {
  const form = $('#login-form'), erro = $('#login-error'), botao = $('#login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.textContent = '';
    botao.disabled = true;
    botao.textContent = 'Signing in…';
    const { error } = await supabase.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
    });
    botao.disabled = false;
    botao.textContent = 'Sign in';
    if (error) {
      erro.textContent = /invalid/i.test(error.message) ? 'Wrong email or password.' : error.message;
      return;
    }
    $('#login-password').value = '';
  });

  $('#signout').addEventListener('click', () => supabase.auth.signOut());

  // Não chamar outros métodos do Supabase dentro deste callback: o cliente pode travar.
  supabase.auth.onAuthStateChange((_evento, sessao) => mostrar(sessao));
}

function mostrar(sessao) {
  const logado = Boolean(sessao);
  $('#login').hidden = logado;
  $('#app').hidden = !logado;
  if (!logado) {
    setTimeout(() => $('#login-email')?.focus(), 0);
    return;
  }
  $('#user-email').textContent = sessao.user?.email ?? '';
  if (!iniciado) {
    iniciado = true;
    start();
  }
}

/* ---------------------------------------------------------------- tema -- */

function wireTheme() {
  const btn = $('#theme');
  const atual = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const pintar = () => { btn.textContent = `Theme: ${atual()}`; };
  btn.addEventListener('click', () => {
    const novo = atual() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = novo;
    try { localStorage.setItem('quasi-theme', novo); } catch { /* sem armazenamento */ }
    pintar();
  });
  pintar();
}

/* --------------------------------------------------- período (demo) -- */

function setRange(from, to) {
  const r = clampRange(from, to, data.meta);
  state.window = r;
  state.compare = compareWindow(r.from, r.to, data.meta);
  state.presetId = PRESETS.find((p) => p.from === r.from && p.to === r.to)?.id ?? null;
  paintRange();
}

function paintRange() {
  $('#presets').innerHTML = PRESETS.map((p) => {
    const on = p.id === state.presetId;
    return `<button type="button" data-preset="${p.id}" class="${on ? 'is-on' : ''}"
      aria-pressed="${on}" title="${esc(fmtRange(p.from, p.to))}">${esc(p.short)}</button>`;
  }).join('');
  resetInputs();
}

function resetInputs() {
  const f = $('#range-from'), t = $('#range-to');
  for (const el of [f, t]) { el.min = data.meta.data_start; el.max = data.meta.data_end; }
  f.value = state.window.from;
  t.value = state.window.to;
  validate();
}

function validate() {
  const f = $('#range-from').value, t = $('#range-to').value;
  const el = $('#range-hint'), apply = $('#range-apply');
  const { data_start: ini, data_end: fim } = data.meta;
  el.classList.remove('is-error');
  const erro = (msg) => { el.textContent = msg; el.classList.add('is-error'); apply.disabled = true; return false; };

  if (!f || !t) return erro('Pick both dates.');
  if (f > t) return erro('The start date is after the end date.');
  if (f < ini || t > fim) return erro(`Data only exists from ${fmtDay(ini)} to ${fmtDay(fim)}.`);

  const n = daysBetween(f, t);
  const aplicado = f === state.window.from && t === state.window.to;
  el.textContent = `${plural(n, '1 day', 'days')} · ` +
    (compareWindow(f, t, data.meta) ? `vs the ${plural(n, 'day', 'days')} before` : 'no earlier data to compare');
  apply.disabled = aplicado;
  return !aplicado;
}

function wireRange() {
  $('#presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const p = PRESETS.find((x) => x.id === btn.dataset.preset);
    setRange(p.from, p.to);
    render();
  });
  for (const id of ['#range-from', '#range-to']) {
    $(id).addEventListener('input', validate);
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Escape') resetInputs(); });
  }
  $('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate()) return;
    setRange($('#range-from').value, $('#range-to').value);
    render();
  });
  $('#range-reset').addEventListener('click', () => {
    setRange(data.meta.period_start, data.meta.period_end);
    render();
  });
}

function fillReasonFilter() {
  $('#filter-reason').innerHTML = `<option value="">All reasons</option>` +
    data.reasons.map((r) => `<option value="${esc(r.reason)}">${esc(r.label)}</option>`).join('');
}

function showWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  const box = $('#alerts');
  box.innerHTML = warnings.map((w) => `<p class="alert"><b>Inconsistent demo data:</b> ${esc(w)}</p>`).join('');
}

/* ------------------------------------------------------------ desenhar -- */

function go(view, { silent = false } = {}) {
  if (!VIEWS[view]) return;
  state.view = view;
  if (!silent) location.hash = view;
  render();
  $('#conteudo').focus({ preventScroll: true });
  scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const def = VIEWS[state.view];
  const real = Boolean(def.mount);   // telas com dado real têm os próprios controles

  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });

  $('#view-title').textContent = def.title;
  $('#view-sub').textContent = real || data ? def.sub(state) : '';
  document.title = `Quasi · ${def.title}`;

  // style.display, não hidden: .filters tem display:flex.
  $('#field-period').style.display = !real && data && USA_PERIODO.has(state.view) ? '' : 'none';
  $('#field-reason').style.display = !real && data && USA_MOTIVO.has(state.view) ? '' : 'none';
  $('#demo').hidden = real;
  $('#alerts').hidden = real || !$('#alerts').innerHTML;

  for (const id of Object.keys(VIEWS)) {
    const el = document.getElementById(`view-${id}`);
    el.hidden = id !== state.view;
    if (id !== state.view) el.innerHTML = '';
  }

  const host = document.getElementById(`view-${state.view}`);
  try {
    if (def.mount) {
      def.mount(host);
    } else if (!data) {
      host.innerHTML = '<p class="empty">The demo data for this tab could not be loaded.</p>';
    } else {
      host.innerHTML = def.render(data, state);
      wireCharts(host);
    }
  } catch (err) {
    console.error(err);
    host.innerHTML = `<p class="empty">Could not build this view: ${esc(err.message)}</p>`;
  }
}
