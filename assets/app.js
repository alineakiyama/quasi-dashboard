/* Partida: carrega os dados, liga abas, filtros e tema, chama os renderizadores.

   Nada aqui calcula métrica e nada aqui busca arquivo. Ele só decide o que
   mostrar e passa adiante o objeto que data.js devolveu. */

import { loadData } from './data.js';
import { presets, compareWindow, clampRange, daysBetween } from './metrics.js';
import { wireCharts, fmtRange, fmtStamp, fmtDay, fmtInt, esc } from './charts.js';

import { renderOverview } from './views/overview.js';
import { renderOperation } from './views/operation.js';
import { renderChargebacks } from './views/chargebacks.js';
import { renderPlans } from './views/plans.js';
import { renderSources } from './views/sources.js';

const plural = (n, um, varios) => (n === 1 ? um : `${fmtInt(n)} ${varios}`);

const VIEWS = {
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

// Quais filtros fazem sentido em cada tela. Operação é retrato de um instante e
// planos não pertencem a um período; só Overview e Operação recortam por motivo.
const USA_PERIODO = new Set(['overview', 'chargebacks', 'sources']);
const USA_MOTIVO = new Set(['overview', 'operation']);

const $ = (sel) => document.querySelector(sel);

const state = { view: 'overview', reason: null, presetId: null, window: null, compare: null };
let data = null;
let PRESETS = [];

/* ---------------------------------------------------------------- boot -- */

wireTheme();   // antes dos dados: o botão de tema funciona mesmo se o carregamento falhar

(async function start() {
  try {
    data = await loadData();
  } catch (err) {
    fail(err);
    return;
  }

  PRESETS = presets(data.meta);
  setRange(data.meta.period_start, data.meta.period_end);

  fillReasonFilter();
  fillHeaderMeta();
  showWarnings(data.warnings);
  wireRange();

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

  $('#loading').remove();
  render();
})();

/* ---------------------------------------------------------------- tema -- */

const TEMA = 'quasi-theme';

function wireTheme() {
  const btn = $('#theme');
  const atual = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const pintar = () => { btn.textContent = `Theme: ${atual()}`; };

  btn.addEventListener('click', () => {
    const novo = atual() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = novo;
    // A preferência é uma conveniência: se o navegador bloquear o armazenamento,
    // o tema troca do mesmo jeito, só não é lembrado.
    try { localStorage.setItem(TEMA, novo); } catch { /* sem armazenamento */ }
    pintar();
  });
  pintar();
}

/* ------------------------------------------------------------- período -- */

function setRange(from, to) {
  const r = clampRange(from, to, data.meta);
  state.window = r;
  state.compare = compareWindow(r.from, r.to, data.meta);
  // Um intervalo digitado que coincide com um atalho É aquele atalho.
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

/** Diz, antes de aplicar, o tamanho do intervalo e se vai haver comparação.
    Devolve se o que está digitado pode ser aplicado. */
function validate() {
  const f = $('#range-from').value, t = $('#range-to').value;
  const el = $('#range-hint'), apply = $('#range-apply');
  const { data_start: ini, data_end: fim } = data.meta;
  el.classList.remove('is-error');

  const erro = (msg) => { el.textContent = msg; el.classList.add('is-error'); apply.disabled = true; return false; };

  if (!f || !t) return erro('Pick both dates.');
  if (f > t) return erro('The start date is after the end date.');
  // O min/max do <input type="date"> não impede digitar fora da faixa.
  if (f < ini || t > fim) return erro(`Data only exists from ${fmtDay(ini)} to ${fmtDay(fim)}.`);

  const n = daysBetween(f, t);
  const temComparacao = Boolean(compareWindow(f, t, data.meta));
  const aplicado = f === state.window.from && t === state.window.to;

  el.textContent = `${plural(n, '1 day', 'days')} · ` +
    (temComparacao ? `vs the ${plural(n, 'day', 'days')} before` : 'no earlier data to compare');
  apply.disabled = aplicado;
  return !aplicado;
}

function wireRange() {
  // Atalho é um clique: aplica na hora.
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

/* ------------------------------------------------------------- filtros -- */

function fillReasonFilter() {
  $('#filter-reason').innerHTML = `<option value="">All reasons</option>` +
    data.reasons.map((r) => `<option value="${esc(r.reason)}">${esc(r.label)}</option>`).join('');
}

function fillHeaderMeta() {
  const m = data.meta;
  $('#meta-range').textContent = fmtRange(m.data_start, m.data_end);
  $('#meta-generated').textContent = fmtStamp(m.generated_at);
  $('#meta-tz').textContent = m.reporting_timezone;
}

function showWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  const box = $('#alerts');
  box.hidden = false;
  box.innerHTML = warnings.map((w) =>
    `<p class="alert"><b>Inconsistent data:</b> ${esc(w)}</p>`).join('');
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

  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });

  $('#view-title').textContent = def.title;
  $('#view-sub').textContent = def.sub(state);
  document.title = `Quasi · ${def.title}`;

  // style.display, não o atributo hidden: .filters tem display:flex, que venceria o [hidden].
  $('#field-period').style.display = USA_PERIODO.has(state.view) ? '' : 'none';
  $('#field-reason').style.display = USA_MOTIVO.has(state.view) ? '' : 'none';

  for (const id of Object.keys(VIEWS)) {
    const el = document.getElementById(`view-${id}`);
    el.hidden = id !== state.view;
    if (id !== state.view) el.innerHTML = '';
  }

  const host = document.getElementById(`view-${state.view}`);
  try {
    host.innerHTML = def.render(data, state);
    wireCharts(host);
  } catch (err) {
    console.error(err);
    host.innerHTML = `<p class="empty">Could not build this view: ${esc(err.message)}</p>`;
  }
}

function fail(err) {
  console.error(err);
  const el = $('#loading');
  if (el) {
    el.className = 'alert';
    el.innerHTML = `<span><b>Could not load the data.</b> ${esc(err.message)}</span>`;
  }
}
