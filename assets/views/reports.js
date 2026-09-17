/* Reports — os relatórios do Commslayer, com os mesmos números do portal.

   Diferente das outras telas, esta busca dado real e de forma assíncrona. Ela
   guarda o próprio estado (período, comparação, ordenação, página) no módulo,
   então trocar de aba e voltar não perde nada nem refaz a busca à toa.

   Tudo o que vem da API é tratado como dado não confiável: nomes de agente,
   inbox e label passam por esc() antes de entrar no HTML. */

import { fetchReports } from '../supabase.js';
import {
  lineChart, legend, seriesColor, wireCharts,
  fmtInt, fmtRange, fmtDay, fmtDuration, esc,
} from '../charts.js';

// O Commslayer fecha os dias no fuso da conta, que devolve datas em -04:00.
const FUSO = 'America/New_York';
const POR_PAGINA = 25;
// A tela se atualiza sozinha nesse intervalo enquanto o período inclui hoje. O
// cache da função tem o mesmo tempo, então o Commslayer recebe no máximo uma
// chamada por minuto por período, não importa quantas telas estejam abertas.
const AUTO_MS = 60 * 1000;

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const nDias = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
const isoDeEpoch = (ms) => new Date(ms).toISOString().slice(0, 10);

const larguraDe = (el) => Math.max(420, Math.round(el?.clientWidth || 780));
const dur = (v) => fmtDuration(v);
const durCurto = (v) => fmtDuration(v, { short: true });
const pct = (v) => (v == null ? '—' : `${Number((+v).toFixed(1))}%`);
const nota = (v) => (v == null ? '—' : `${Number((+v).toFixed(1))}`);

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

/* ------------------------------------------------------------- estado -- */

const S = {
  from: null, to: null, compare: true, businessHours: false,
  ovMetric: 'created_tickets', prMetric: 'average_response_time',
  ag: { q: '', sort: 'agent', dir: 'asc', page: 1 },
  cs: { q: '', sort: 'closed_tickets', dir: 'desc', page: 1 },
  body: null, bodyKey: null, error: null, loading: false, ctrl: null,
};

const chaveAtual = () => `${S.from}|${S.to}|${S.compare}|${S.businessHours}`;

function janelaComparacao() {
  if (!S.compare) return {};
  const n = nDias(S.from, S.to);
  return { compareFrom: addDays(S.from, -n), compareTo: addDays(S.from, -1) };
}

const rep = (nome) => S.body?.reports?.[nome]?.payload ?? null;

/* ------------------------------------------------------------ montagem -- */

/** `fetcher` existe para testar a tela com dados montados à mão, sem sessão.
    Em uso normal é sempre a busca real. */
export function mountReports(host, { fetcher = fetchReports } = {}) {
  S.fetcher = fetcher;
  if (!S.from) {
    const p = presets().find((x) => x.id === 'last7');
    S.from = p.from; S.to = p.to;
  }

  host.innerHTML = `
    <div class="card rp-controls">
      <div class="rp-bar">
        <div class="seg" data-rp="presets" role="group" aria-label="Quick ranges"></div>
        <form class="range" data-rp="range" novalidate>
          <input type="date" data-rp="from" aria-label="From">
          <span class="hint" aria-hidden="true">–</span>
          <input type="date" data-rp="to" aria-label="To">
          <button class="btn btn--primary" type="submit" data-rp="apply">Apply</button>
        </form>
        <label class="switch"><input type="checkbox" data-rp="compare"><span class="switch__track" aria-hidden="true"></span>Compare to previous period</label>
        <label class="switch"><input type="checkbox" data-rp="bh"><span class="switch__track" aria-hidden="true"></span>Business hours</label>
      </div>
      <div class="rp-status" data-rp="status" aria-live="polite"></div>
    </div>

    <div data-rp="errors"></div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Overview</h2>
        <p class="card__note">Pick a number to see how it moved day by day.</p>
      </div></div>
      <div class="rtiles" data-rp="ov-tiles"></div>
      <div class="chart-wrap" data-rp="ov-chart"></div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Productivity</h2>
      </div></div>
      <div class="rtiles" data-rp="pr-tiles"></div>
      <div class="chart-wrap" data-rp="pr-chart"></div>
    </section>

    <section class="card">
      <div class="card__head">
        <div><h2 class="card__title">Agent performance</h2></div>
        <div class="table-tools">
          <input class="search" type="search" placeholder="Search agents" aria-label="Search agents" data-rp="ag-q">
        </div>
      </div>
      <div class="card__body" data-rp="ag-table"></div>
    </section>

    <section class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">CSAT</h2>
          <p class="card__note">Customer satisfaction. Commslayer does not apply business hours to CSAT.</p>
        </div>
      </div>
      <div class="rtiles" data-rp="cs-tiles"></div>
      <div class="grid grid--2" style="margin-top:14px">
        <div>
          <h3 class="rp-sub">Rating distribution</h3>
          <div data-rp="cs-dist"></div>
        </div>
        <div>
          <h3 class="rp-sub">Average rating by day</h3>
          <div data-rp="cs-trend"></div>
        </div>
      </div>
      <div class="card__head" style="margin-top:22px">
        <h3 class="rp-sub" style="margin:0">By agent</h3>
        <div class="table-tools">
          <input class="search" type="search" placeholder="Search agents" aria-label="Search CSAT agents" data-rp="cs-q">
        </div>
      </div>
      <div class="card__body" data-rp="cs-table"></div>
    </section>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__head"><div><h2 class="card__title">Inboxes</h2></div></div>
        <div class="card__body" data-rp="ib-table"></div>
      </section>
      <section class="card">
        <div class="card__head"><div>
          <h2 class="card__title">Labels</h2>
          <p class="card__note">Tickets tagged with each label in the period.</p>
        </div></div>
        <div class="card__body" data-rp="lb-list"></div>
      </section>
    </div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Auto-labels</h2>
        <p class="card__note" data-rp="al-note">Labels Commslayer applies by itself, per ticket created in the period.</p>
      </div></div>
      <div class="card__body" data-rp="al-list"></div>
    </section>`;

  wire(host);
  paintControls(host);
  paintAll(host);
  if (!(S.body && S.bodyKey === chaveAtual())) load(host);
  agendarAtualizacao(host);
}

/* ------------------------------------------------ atualização automática -- */

let timer = null;
let ouvindoVisibilidade = false;

const incluiHoje = () => Boolean(S.to) && S.to >= hoje();

/** Só atualiza quando faz sentido: a aba Reports visível, a janela do navegador
    em primeiro plano, o período incluindo hoje e nenhuma busca em andamento. */
function podeAtualizar(host) {
  return !host.hidden && document.visibilityState === 'visible' && incluiHoje() && !S.loading && !S.silencioso;
}

function agendarAtualizacao(host) {
  clearInterval(timer);
  timer = setInterval(() => {
    if (host.hidden) { clearInterval(timer); timer = null; return; }
    if (podeAtualizar(host)) load(host, { silent: true });
  }, AUTO_MS);

  // Voltou para a aba do navegador depois de um tempo fora: atualiza já, em vez
  // de esperar o próximo minuto com números velhos na tela.
  if (!ouvindoVisibilidade) {
    ouvindoVisibilidade = true;
    document.addEventListener('visibilitychange', () => {
      const alvo = document.getElementById('view-reports');
      if (!alvo || !S.body || !podeAtualizar(alvo)) return;
      const idade = Date.now() - Date.parse(S.body.generated_at ?? 0);
      if (idade >= AUTO_MS) load(alvo, { silent: true });
    });
  }
}

const $rp = (host, nome) => host.querySelector(`[data-rp="${nome}"]`);

/* ----------------------------------------------------------- interação -- */

function wire(host) {
  $rp(host, 'presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = presets().find((x) => x.id === b.dataset.preset);
    S.from = p.from; S.to = p.to;
    paintControls(host);
    load(host);
  });

  for (const nome of ['from', 'to']) $rp(host, nome).addEventListener('input', () => validar(host));

  $rp(host, 'range').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validar(host)) return;
    S.from = $rp(host, 'from').value;
    S.to = $rp(host, 'to').value;
    paintControls(host);
    load(host);
  });

  $rp(host, 'compare').addEventListener('change', (e) => { S.compare = e.target.checked; load(host); });
  $rp(host, 'bh').addEventListener('change', (e) => { S.businessHours = e.target.checked; load(host); });

  $rp(host, 'status').addEventListener('click', (e) => {
    if (e.target.closest('[data-rp-refresh]')) load(host, { refresh: true });
  });

  host.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-metric]');
    if (tile) {
      if (tile.dataset.group === 'ov') S.ovMetric = tile.dataset.metric;
      else S.prMetric = tile.dataset.metric;
      paintOverview(host);
      paintProductivity(host);
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      const t = S[sort.dataset.table];
      if (t.sort === sort.dataset.sort) t.dir = t.dir === 'asc' ? 'desc' : 'asc';
      else { t.sort = sort.dataset.sort; t.dir = sort.dataset.sort === 'agent' ? 'asc' : 'desc'; }
      t.page = 1;
      paintTables(host);
      return;
    }
    const pag = e.target.closest('[data-page]');
    if (pag) {
      S[pag.dataset.table].page += Number(pag.dataset.page);
      paintTables(host);
    }
  });

  $rp(host, 'ag-q').addEventListener('input', (e) => { S.ag.q = e.target.value; S.ag.page = 1; paintTables(host); });
  $rp(host, 'cs-q').addEventListener('input', (e) => { S.cs.q = e.target.value; S.cs.page = 1; paintTables(host); });
}

function validar(host) {
  const f = $rp(host, 'from').value, t = $rp(host, 'to').value, max = hoje();
  const ok = f && t && f <= t && t <= max && nDias(f, t) <= 400 && !(f === S.from && t === S.to);
  $rp(host, 'apply').disabled = !ok;
  return ok;
}

/* --------------------------------------------------------------- busca -- */

/** Só o conteúdo dos relatórios, sem horários de busca: se ela não mudou, não
    há o que redesenhar. */
const assinatura = (body) => JSON.stringify(
  Object.entries(body?.reports ?? {}).map(([nome, r]) => [nome, r.payload]),
);

/**
 * Busca os relatórios do período atual.
 * silent: atualização automática. Não apaga a tela, não mostra "Loading", não
 * troca números por erro se falhar, e só redesenha o que de fato mudou.
 */
async function load(host, { refresh = false, silent = false } = {}) {
  if (silent && (S.loading || S.silencioso)) return;
  S.ctrl?.abort();
  const ctrl = new AbortController();
  S.ctrl = ctrl;
  const chave = chaveAtual();

  if (silent) {
    S.silencioso = true;
  } else {
    S.loading = true;
    S.error = null;
    host.classList.add('is-loading');
    paintStatus(host);
  }

  let mudou = true;
  try {
    const body = await S.fetcher({
      from: S.from, to: S.to, ...janelaComparacao(),
      businessHours: S.businessHours, refresh, signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) return;
    mudou = !(silent && S.bodyKey === chave && assinatura(body) === assinatura(S.body));
    S.body = body;
    S.bodyKey = chave;
    S.autoFalhou = false;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (silent) { S.autoFalhou = true; mudou = false; }   // mantém os números que já estão na tela
    else S.error = err.message;
  } finally {
    if (S.ctrl === ctrl) {
      S.loading = false;
      S.silencioso = false;
      host.classList.remove('is-loading');
    }
  }
  if (S.ctrl !== ctrl) return;
  if (mudou) paintAll(host);
  else paintStatus(host);
}

/* ----------------------------------------------------------- desenhos -- */

function paintAll(host) {
  // Redesenhar as tabelas volta a rolagem horizontal para o começo; quem estava
  // olhando as colunas da direita não pode ser jogado de volta a cada minuto.
  const rolagem = [...host.querySelectorAll('.tablewrap')].map((el) => el.scrollLeft);

  paintStatus(host);
  paintErrors(host);
  paintOverview(host);
  paintProductivity(host);
  paintCsatTop(host);
  paintTables(host);
  paintLabels(host);
  paintAutoLabels(host);

  host.querySelectorAll('.tablewrap').forEach((el, i) => { if (rolagem[i]) el.scrollLeft = rolagem[i]; });
}

function paintControls(host) {
  const atual = presets().find((p) => p.from === S.from && p.to === S.to);
  $rp(host, 'presets').innerHTML = presets().map((p) => {
    const on = p.id === atual?.id;
    return `<button type="button" data-preset="${p.id}" class="${on ? 'is-on' : ''}" aria-pressed="${on}"
      title="${esc(fmtRange(p.from, p.to))}">${esc(p.short)}</button>`;
  }).join('');
  const f = $rp(host, 'from'), t = $rp(host, 'to');
  for (const el of [f, t]) { el.max = hoje(); el.min = addDays(hoje(), -399); }
  f.value = S.from;
  t.value = S.to;
  $rp(host, 'compare').checked = S.compare;
  $rp(host, 'bh').checked = S.businessHours;
  validar(host);
}

function paintStatus(host) {
  const el = $rp(host, 'status');
  const periodo = esc(fmtRange(S.from, S.to));
  if (S.loading) {
    el.innerHTML = `<span class="loading__pulse" aria-hidden="true"></span> Loading ${periodo} from Commslayer — a new period can take up to 15 s.`;
    return;
  }
  if (S.error) {
    el.innerHTML = `<span class="is-error">${esc(S.error)}</span> <button type="button" class="btn" data-rp-refresh>Try again</button>`;
    return;
  }
  if (!S.body) { el.textContent = ''; return; }
  const entradas = Object.values(S.body.reports ?? {});
  const maisVelho = Math.min(...entradas.map((r) => Date.parse(r.fetched_at)));
  const min = Math.max(0, Math.round((Date.now() - maisVelho) / 60000));
  const vencido = entradas.some((r) => r.stale);
  el.innerHTML = `
    <span class="rp-live">Live from Commslayer · ${periodo}</span>
    <span>updated ${min < 1 ? 'just now' : `${min} min ago`}${incluiHoje() ? ' · updates every minute' : ''}</span>
    ${S.autoFalhou ? '<span class="is-warn">last automatic update failed — retrying</span>' : ''}
    ${vencido ? '<span class="is-warn">Commslayer did not answer — showing the last saved numbers</span>' : ''}
    <button type="button" class="btn" data-rp-refresh>Refresh</button>`;
}

function paintErrors(host) {
  const erros = Object.entries(S.body?.errors ?? {});
  $rp(host, 'errors').innerHTML = erros.length
    ? `<p class="rp-error">Some reports could not load: ${erros.map(([k, v]) => `<b>${esc(k)}</b> (${esc(v)})`).join(', ')}</p>`
    : '';
}

/** Variação contra o período anterior. dir: +1 maior é melhor, -1 menor é melhor, 0 neutro. */
function variacao(atual, anterior, dir, { pontos = false } = {}) {
  if (!S.compare || atual == null || anterior == null) return '';
  const delta = atual - anterior;
  if (Math.abs(delta) < 1e-9) return '<span class="delta delta--flat">no change</span>';
  const seta = delta > 0 ? '▲' : '▼';
  const tom = dir === 0 ? 'delta--flat' : ((dir > 0 ? delta > 0 : delta < 0) ? 'delta--good' : 'delta--bad');
  const texto = pontos
    ? `${Number(Math.abs(delta).toFixed(1))} pp`
    : (anterior ? `${Number(Math.abs((delta / anterior) * 100).toFixed(1))}%` : '');
  return `<span class="delta ${tom}">${seta} ${texto}</span>`;
}

function tiles(defs, fonte, grupo, selecionado) {
  return defs.map((d) => {
    const m = fonte?.[d.k] ?? {};
    const on = grupo && d.k === selecionado;
    const tag = grupo ? 'button' : 'div';
    const attrs = grupo ? ` type="button" data-group="${grupo}" data-metric="${d.k}" aria-pressed="${on}"` : '';
    const anterior = S.compare && m.previous != null ? `<span>prev ${d.fmt(m.previous)}</span>` : '';
    return `<${tag} class="rtile${on ? ' is-on' : ''}"${attrs}>
      <span class="rtile__label">${esc(d.label)}</span>
      <span class="rtile__value">${d.fmt(m.current)}</span>
      <span class="rtile__foot">${variacao(m.current, m.previous, d.dir, { pontos: d.pontos })}${anterior}</span>
    </${tag}>`;
  }).join('');
}

function grafico(pontos, def, largura) {
  if (!pontos?.length) return '<p class="empty">No data for this period.</p>';
  if (pontos.length < 2) return '<p class="note">A single day has no trend to draw. Pick a range of two days or more to see the line.</p>';
  const dias = pontos.map((p) => isoDeEpoch(p.date));
  const series = [{ key: 'current', label: 'This period', color: seriesColor(0), values: pontos.map((p) => p.current) }];
  if (S.compare && pontos.some((p) => p.compare != null)) {
    series.push({ key: 'compare', label: 'Previous', color: 'var(--muted)', dash: true, values: pontos.map((p) => p.compare) });
  }
  return lineChart({ days: dias, series, formatValue: def.eixo, yLabel: def.label, height: 230, width: largura }) +
    (series.length > 1 ? legend([
      { label: 'This period', color: seriesColor(0) },
      { label: 'Previous period (dashed)', color: 'var(--muted)' },
    ], { line: true }) : '');
}

const OV = [
  { k: 'created_tickets', label: 'New tickets', fmt: (v) => (v == null ? '—' : fmtInt(v)), eixo: fmtInt, dir: 0 },
  { k: 'closed_tickets', label: 'Resolved tickets', fmt: (v) => (v == null ? '—' : fmtInt(v)), eixo: fmtInt, dir: 1 },
  { k: 'first_response_time', label: 'First response time', fmt: dur, eixo: durCurto, dir: -1 },
  { k: 'resolution_time', label: 'Resolution time', fmt: dur, eixo: durCurto, dir: -1 },
];
const PR = [
  { k: 'average_response_time', label: 'Avg. response time', fmt: dur, eixo: durCurto, dir: -1 },
  { k: 'messages_sent', label: 'Messages sent', fmt: (v) => (v == null ? '—' : fmtInt(v)), eixo: fmtInt, dir: 0 },
  { k: 'one_touch_tickets', label: 'One-touch tickets', fmt: pct, eixo: (v) => `${v}%`, dir: 1, pontos: true },
  { k: 'zero_touch_tickets', label: 'Zero-touch tickets', fmt: pct, eixo: (v) => `${v}%`, dir: 1, pontos: true },
];

function paintOverview(host) {
  const d = rep('overview')?.data?.overview;
  $rp(host, 'ov-tiles').innerHTML = tiles(OV, d, 'ov', S.ovMetric);
  const def = OV.find((x) => x.k === S.ovMetric);
  const alvo = $rp(host, 'ov-chart');
  alvo.innerHTML = d ? grafico(d.chart_data?.[S.ovMetric], def, larguraDe(alvo)) : '';
  wireCharts(alvo);
}

function paintProductivity(host) {
  const d = rep('overview')?.data?.productivity;
  $rp(host, 'pr-tiles').innerHTML = tiles(PR, d, 'pr', S.prMetric);
  const def = PR.find((x) => x.k === S.prMetric);
  const alvo = $rp(host, 'pr-chart');
  alvo.innerHTML = d ? grafico(d.chart_data?.[S.prMetric], def, larguraDe(alvo)) : '';
  wireCharts(alvo);
}

/* ------------------------------------------------------------- tabelas -- */

function agenteCelula(nome, tipo) {
  const n = String(nome ?? 'Unknown').trim() || 'Unknown';
  const partes = n.split(/\s+/);
  const iniciais = (partes.length > 1 ? partes[0][0] + partes[1][0] : n.slice(0, 2)).toUpperCase();
  return `<span class="agent"><span class="avatar" aria-hidden="true">${esc(iniciais)}</span>
    <span>${esc(n)}</span>${tipo === 'ai_agent' ? '<span class="badge-ai" title="AI agent">AI</span>' : ''}</span>`;
}

/** Tabela com busca, ordenação e paginação. `fixa` é uma linha de total que
    fica sempre no topo e não entra na ordenação, como "All agents" no portal. */
function tabela({ id, cols, linhas, nomeDe, fixa }) {
  const st = S[id];
  const q = st.q.trim().toLowerCase();
  let rows = linhas.filter((r) => !q || String(nomeDe(r) ?? '').toLowerCase().includes(q));

  const col = cols.find((c) => c.k === st.sort) ?? cols[0];
  const valor = (r) => (col.k === 'agent' ? String(nomeDe(r) ?? '') : r[col.k]);
  rows = [...rows].sort((a, b) => {
    const va = valor(a), vb = valor(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const r = typeof va === 'string' ? va.localeCompare(vb, 'en', { sensitivity: 'base' }) : va - vb;
    return st.dir === 'asc' ? r : -r;
  });

  const total = rows.length;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  st.page = Math.min(Math.max(1, st.page), paginas);
  const ini = (st.page - 1) * POR_PAGINA;
  const pagina = rows.slice(ini, ini + POR_PAGINA);

  const th = cols.map((c) => {
    const ativo = c.k === st.sort;
    const aria = ativo ? ` aria-sort="${st.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    const seta = ativo ? (st.dir === 'asc' ? '▲' : '▼') : '';
    return `<th class="${c.k === 'agent' ? '' : 'num'}"${aria}>
      <button type="button" class="sort" data-table="${id}" data-sort="${c.k}">${esc(c.label)} <span aria-hidden="true">${seta}</span></button></th>`;
  }).join('');

  const tr = (r, classe = '') => `<tr${classe ? ` class="${classe}"` : ''}>${cols.map((c) =>
    c.k === 'agent' ? `<td>${c.cell(r)}</td>` : `<td class="num">${c.fmt(r[c.k])}</td>`).join('')}</tr>`;

  const corpo = (fixa && !q ? tr(fixa, 'row-total') : '') + pagina.map((r) => tr(r)).join('');

  return `<div class="tablewrap"><table class="table--sticky">
      <thead><tr>${th}</tr></thead>
      <tbody>${corpo || `<tr><td colspan="${cols.length}"><span class="note">No agents match.</span></td></tr>`}</tbody>
    </table></div>
    <div class="pager">
      <span>Showing ${total ? ini + 1 : 0} - ${Math.min(ini + POR_PAGINA, total)} of ${total}</span>
      <span>
        <button type="button" class="btn" data-table="${id}" data-page="-1" ${st.page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
        <button type="button" class="btn" data-table="${id}" data-page="1" ${st.page >= paginas ? 'disabled' : ''} aria-label="Next page">›</button>
      </span>
    </div>`;
}

const int = (v) => (v == null ? '—' : fmtInt(v));

function paintTables(host) {
  const agentes = rep('agents')?.data;
  $rp(host, 'ag-table').innerHTML = Array.isArray(agentes) ? tabela({
    id: 'ag',
    linhas: agentes,
    nomeDe: (r) => r.agent,
    cols: [
      { k: 'agent', label: 'Agent', cell: (r) => agenteCelula(r.agent, r.agent_type) },
      { k: 'closed_tickets', label: 'Resolved tickets', fmt: int },
      { k: 'closed_tickets_percentage', label: '% of Resolved tickets', fmt: pct },
      { k: 'avg_csat', label: 'Avg. CSAT', fmt: nota },
      { k: 'tickets_replied', label: 'Unique tickets replied', fmt: int },
      { k: 'messages_sent', label: 'Messages sent', fmt: int },
      { k: 'messages_received', label: 'Messages received', fmt: int },
      { k: 'first_response_time', label: 'First response time', fmt: durCurto },
      { k: 'avg_response_time', label: 'Avg. response time', fmt: durCurto },
      { k: 'resolution_time', label: 'Resolution time', fmt: durCurto },
      { k: 'one_touch_tickets', label: 'One-touch tickets', fmt: pct },
      { k: 'ticket_handle_time', label: 'Ticket handle time', fmt: durCurto },
    ],
  }) : placeholder();

  const csat = rep('csat')?.data;
  $rp(host, 'cs-table').innerHTML = Array.isArray(csat?.by_agent) ? tabela({
    id: 'cs',
    linhas: csat.by_agent,
    nomeDe: (r) => r.agent_name,
    fixa: csat.summary ? { ...csat.summary, agent_name: 'All agents', closed_tickets_percentage: null, _total: true } : null,
    cols: [
      { k: 'agent', label: 'Agent', cell: (r) => (r._total ? '<b>All agents</b>' : agenteCelula(r.agent_name, r.agent_type)) },
      { k: 'average_rating', label: 'Avg. CSAT', fmt: nota },
      { k: 'total_responses', label: 'CSAT responses', fmt: int },
      { k: 'closed_tickets', label: 'Resolved tickets', fmt: int },
      { k: 'closed_tickets_percentage', label: '% of Resolved tickets', fmt: pct },
      { k: 'first_response_time', label: 'First response time', fmt: durCurto },
      { k: 'avg_response_time', label: 'Avg. response time', fmt: durCurto },
      { k: 'resolution_time', label: 'Resolution time', fmt: durCurto },
    ],
  }) : placeholder();

  const inboxes = rep('inboxes')?.data;
  $rp(host, 'ib-table').innerHTML = Array.isArray(inboxes) ? `<div class="tablewrap"><table>
      <thead><tr><th>Inbox</th><th class="num">New</th><th class="num">Resolved</th>
        <th class="num">1st response</th><th class="num">Resolution</th></tr></thead>
      <tbody>${inboxes.map((b) => `<tr>
        <td>${esc(b.name)}<span class="cell-sub">${esc((b.platforms ?? []).join(', '))} · ${pct(b.created_tickets_percentage)} of new</span></td>
        <td class="num">${int(b.created_tickets)}</td>
        <td class="num">${int(b.closed_tickets)}</td>
        <td class="num">${durCurto(b.first_response_time)}</td>
        <td class="num">${durCurto(b.resolution_time)}</td>
      </tr>`).join('')}</tbody></table></div>` : placeholder();
}

function paintCsatTop(host) {
  const d = rep('csat');
  const s = d?.data?.summary;
  const p = d?.comparison_data?.summary;
  const fonte = s ? Object.fromEntries(Object.keys(s).map((k) => [k, { current: s[k], previous: p?.[k] ?? null }])) : null;
  $rp(host, 'cs-tiles').innerHTML = tiles([
    { k: 'average_rating', label: 'Avg. CSAT', fmt: nota, dir: 1 },
    { k: 'total_responses', label: 'CSAT responses', fmt: int, dir: 0 },
    { k: 'satisfaction_score', label: 'Satisfaction score', fmt: pct, dir: 1, pontos: true },
    { k: 'response_rate', label: 'Response rate', fmt: pct, dir: 1, pontos: true },
  ], fonte, null, null);

  const dist = d?.data?.distribution;
  $rp(host, 'cs-dist').innerHTML = dist ? `<div class="bars">${[5, 4, 3, 2, 1].map((n) => {
    const x = dist[n] ?? dist[String(n)] ?? { count: 0, percentage: 0 };
    return `<div class="bar" title="${n} stars: ${int(x.count)} (${pct(x.percentage)})">
      <span class="bar__label">${'★'.repeat(n)}<span class="stars-off">${'★'.repeat(5 - n)}</span></span>
      <span class="bar__track"><span class="bar__fill" style="width:${Math.max(0, Math.min(100, +x.percentage || 0))}%"></span></span>
      <span class="bar__value">${int(x.count)}<span class="cell-sub">${pct(x.percentage)}</span></span>
    </div>`;
  }).join('')}</div>` : placeholder();

  const trend = d?.data?.trend;
  const alvo = $rp(host, 'cs-trend');
  if (!Array.isArray(trend)) { alvo.innerHTML = placeholder(); return; }
  if (trend.length < 2) { alvo.innerHTML = '<p class="note">A single day has no trend to draw.</p>'; return; }
  const series = [{ key: 'r', label: 'This period', color: seriesColor(0), values: trend.map((t) => t.average_rating) }];
  const antes = d?.comparison_data?.trend;
  if (S.compare && Array.isArray(antes) && antes.some((t) => t.average_rating != null)) {
    series.push({ key: 'p', label: 'Previous', color: 'var(--muted)', dash: true, values: trend.map((_, i) => antes[i]?.average_rating ?? null) });
  }
  alvo.innerHTML = lineChart({ days: trend.map((t) => t.date), series, formatValue: (v) => String(Number((+v).toFixed(1))), yLabel: 'Average rating', height: 210, width: larguraDe(alvo) });
  wireCharts(alvo);
}

function paintLabels(host) {
  const labels = rep('labels')?.data;
  const alvo = $rp(host, 'lb-list');
  if (!Array.isArray(labels)) { alvo.innerHTML = placeholder(); return; }
  const lista = [...labels].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  const topo = Math.max(1, ...lista.map((l) => l.amount ?? 0));
  const cor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c ?? '') ? c : 'var(--axis)');
  alvo.innerHTML = `<div class="bars">${lista.map((l) => `
    <div class="bar">
      <span class="bar__label"><span class="swatch" style="background:${cor(l.color)}"></span>${esc(l.title)}</span>
      <span class="bar__track"><span class="bar__fill" style="width:${((l.amount ?? 0) / topo) * 100}%"></span></span>
      <span class="bar__value">${int(l.amount)}${S.compare && l.amount_previous != null ? `<span class="cell-sub">prev ${int(l.amount_previous)}</span>` : ''}</span>
    </div>`).join('')}</div>`;
}

// "cancel-order" → "Cancel Order", como o portal mostra.
const tituloLabel = (s) => String(s).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function paintAutoLabels(host) {
  const d = rep('auto_labels');
  const alvo = $rp(host, 'al-list'), nota = $rp(host, 'al-note');
  if (!d) { alvo.innerHTML = S.body?.errors?.auto_labels ? '<p class="empty">Could not load auto-labels.</p>' : placeholder(); return; }
  const lista = (d.labels ?? []).filter((l) => l.count > 0 || (S.compare && l.previous > 0));
  const soma = lista.reduce((a, l) => a + l.count, 0);
  const topo = Math.max(1, ...lista.map((l) => l.count));
  const desde = d.coverage_from;
  const avisos = [];
  if (!desde) avisos.push('Counting has not started yet: the Commslayer webhook is still being connected.');
  else if (S.from < desde) avisos.push(`Counted from ${fmtDay(desde)} — tickets before that day are not in these numbers.`);
  if (d.webhook && (d.webhook.exists === false || d.webhook.broken || d.webhook.active === false)) avisos.push('The Commslayer webhook is off; numbers are still checked every 10 minutes.');
  nota.textContent = `Labels Commslayer applies by itself, per ticket created in the period · ${fmtInt(d.tickets ?? 0)} tickets.`;
  alvo.innerHTML = (avisos.length ? `<p class="note note--scoped" style="margin:0 0 12px">${avisos.map(esc).join(' ')}</p>` : '') +
    (lista.length ? `<div class="bars">${lista.map((l) => `
    <div class="bar">
      <span class="bar__label">${esc(tituloLabel(l.label))}</span>
      <span class="bar__track"><span class="bar__fill" style="width:${(l.count / topo) * 100}%"></span></span>
      <span class="bar__value">${soma ? Math.round((l.count / soma) * 100) : 0}%<span class="cell-sub">${int(l.count)}${S.compare && l.previous != null ? ` · prev ${int(l.previous)}` : ''}</span></span>
    </div>`).join('')}</div>` : '<p class="empty">No auto-labels in this period yet.</p>');
}

function placeholder() {
  if (S.loading && !S.body) return '<p class="empty">Loading…</p>';
  if (S.error && !S.body) return '<p class="empty">Could not load this report.</p>';
  return '<p class="empty">No data.</p>';
}

