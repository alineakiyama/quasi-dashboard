/* Partida: carrega os dados, liga os filtros, chama os renderizadores.

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
    sub: (s) => `Quasi support, ${fmtRange(s.window.from, s.window.to)}` +
      (s.compare
        ? `, against the ${plural(s.compare.days, 'day', 'days')} before.`
        : ' — there is no earlier data of the same length to compare against.'),
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

const $ = (sel) => document.querySelector(sel);

const state = { view: 'overview', reason: null, presetId: null, window: null, compare: null };
let data = null;
let PRESETS = [];
let fecharSeletor = () => {};

/* ---------------------------------------------------------------- boot -- */

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
  fillRailMeta();
  showWarnings(data.warnings);
  wireRange();

  $('#filter-reason').addEventListener('change', (e) => {
    state.reason = e.target.value || null;
    render();
  });

  document.querySelectorAll('.navitem').forEach((btn) => {
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

/* ------------------------------------------------------------- período -- */

function setRange(from, to) {
  const r = clampRange(from, to, data.meta);
  state.window = r;
  state.compare = compareWindow(r.from, r.to, data.meta);
  // Um intervalo digitado à mão que coincide com um atalho É aquele atalho —
  // o check aparece nele, em vez de a seleção ficar órfã como "personalizado".
  state.presetId = PRESETS.find((p) => p.from === r.from && p.to === r.to)?.id ?? null;
  paintRange();
}

function paintRange() {
  const p = PRESETS.find((x) => x.id === state.presetId);
  $('#range-text').textContent = p ? `${p.label} · ${fmtRange(p.from, p.to)}` : fmtRange(state.window.from, state.window.to);

  $('#range-presets').innerHTML = PRESETS.map((x) => `
    <li role="presentation">
      <button type="button" class="range__item" role="option" data-preset="${x.id}"
              aria-selected="${x.id === state.presetId}">
        <svg class="range__check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3.2 3.1L13 4.6" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>${esc(x.label)}</span>
        <span class="range__dates">${esc(fmtRange(x.from, x.to))}</span>
      </button>
    </li>`).join('');

  resetCustomInputs();
}

function resetCustomInputs() {
  const f = $('#range-from'), t = $('#range-to');
  for (const el of [f, t]) { el.min = data.meta.data_start; el.max = data.meta.data_end; }
  f.value = state.window.from;
  t.value = state.window.to;
  $('.range__apply').disabled = !hint();
}

/** Diz, antes de aplicar, o tamanho do intervalo e se vai haver comparação.
    Devolve se o intervalo é válido. */
function hint() {
  const f = $('#range-from').value, t = $('#range-to').value, el = $('#range-hint');
  const { data_start: ini, data_end: fim } = data.meta;
  el.classList.remove('is-error');

  if (!f || !t) { el.textContent = 'Pick both dates.'; return false; }
  if (f > t) { el.textContent = 'The start date is after the end date.'; el.classList.add('is-error'); return false; }
  // O min/max do <input type="date"> não impede digitar fora da faixa.
  if (f < ini || t > fim) {
    el.textContent = `Data only exists from ${fmtDay(ini)} to ${fmtDay(fim)}.`;
    el.classList.add('is-error');
    return false;
  }
  const n = daysBetween(f, t);
  el.textContent = `${plural(n, '1 day', 'days')} · ` +
    (compareWindow(f, t, data.meta) ? `compared with the ${plural(n, 'day', 'days')} before` : 'no earlier data to compare');
  return true;
}

function wireRange() {
  const btn = $('#range-button'), pop = $('#range-pop');

  const abrir = () => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    (pop.querySelector('[aria-selected="true"]') ?? pop.querySelector('.range__item'))?.focus();
  };
  const fechar = ({ foco = false } = {}) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    resetCustomInputs();        // datas digitadas e não aplicadas não sobrevivem ao fechar
    if (foco) btn.focus();
  };
  fecharSeletor = fechar;

  btn.addEventListener('click', () => (pop.hidden ? abrir() : fechar()));

  // Atalho é um clique: aplica e fecha. Só o intervalo personalizado pede "Apply".
  $('#range-presets').addEventListener('click', (e) => {
    const item = e.target.closest('[data-preset]');
    if (!item) return;
    const p = PRESETS.find((x) => x.id === item.dataset.preset);
    setRange(p.from, p.to);
    fechar({ foco: true });
    render();
  });

  $('#range-presets').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const itens = [...pop.querySelectorAll('.range__item')];
    const i = itens.indexOf(document.activeElement);
    itens[(i + (e.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length]?.focus();
    e.preventDefault();
  });

  for (const id of ['#range-from', '#range-to']) {
    $(id).addEventListener('input', () => { $('.range__apply').disabled = !hint(); });
  }

  $('#range-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!hint()) return;
    setRange($('#range-from').value, $('#range-to').value);
    fechar({ foco: true });
    render();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !e.target.closest('.field--range')) fechar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) fechar({ foco: true });
  });
}

/* ------------------------------------------------------------- filtros -- */

function fillReasonFilter() {
  $('#filter-reason').innerHTML = `<option value="">All reasons</option>` +
    data.reasons.map((r) => `<option value="${esc(r.reason)}">${esc(r.label)}</option>`).join('');
}

function fillRailMeta() {
  const m = data.meta;
  $('#rail-meta').innerHTML = `
    <b>${esc(m.brand.name)}</b>
    Commslayer · Shopify<br>
    Generated ${esc(fmtStamp(m.generated_at))}<br>
    Reporting in ${esc(m.reporting_timezone)}`;
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
  fecharSeletor();
  if (!silent) location.hash = view;
  render();
  $('#conteudo').focus({ preventScroll: true });
  scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const def = VIEWS[state.view];

  document.querySelectorAll('.navitem').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === state.view));

  $('#view-title').textContent = def.title;
  $('#view-sub').textContent = def.sub(state);
  document.title = `Quasi · ${def.title}`;

  // O seletor de motivo não faz sentido onde nada é recortado por motivo, e o de
  // período não faz sentido nas telas que não pertencem a um período.
  const usaMotivo = state.view === 'overview' || state.view === 'operation';
  $('#filter-reason').closest('.field').style.display = usaMotivo ? '' : 'none';
  $('.field--range').style.display = (state.view === 'plans' || state.view === 'operation') ? 'none' : '';

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
