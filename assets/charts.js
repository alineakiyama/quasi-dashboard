/* =========================================================================
   Gráficos em SVG inline e os formatadores da página.

   Sem biblioteca: cada gráfico é uma string de SVG montada aqui. As regras que
   valem para todos eles:

   · Um eixo só. Duas medidas de escalas diferentes viram dois gráficos.
   · Marca fina, grade discreta, rótulo direto quando são poucas séries.
   · Camada de hover por padrão — um gráfico em HTML É interativo.
   · A cor das séries vem de --series-N na folha de estilo, na ordem fixa em
     que foram validadas. A ordem não é decorativa: é o mecanismo de
     segurança para daltonismo.
   ========================================================================= */

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const STEPS = ['var(--step-1)', 'var(--step-2)', 'var(--step-3)'];

export const seriesColor = (i) => SERIES[i % SERIES.length];
export const stepColor = (i) => STEPS[i % STEPS.length];

/* --------------------------------------------------------- formatadores -- */

// A interface fala inglês e reporta em dólar, então a formatação segue o padrão
// americano: 1,045 e 88.9%, não 1.045 e 88,9%.
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n) => (n == null ? '—' : nf0.format(n));
export const fmtPct = (n, d = 1) => (n == null ? '—' : (d === 2 ? nf2 : nf1).format(n) + '%');

/** Diferença entre duas porcentagens é ponto percentual, não porcentagem: de
    3,4% para 3,0% caiu 0,4 pp — "caiu 0,4%" leria como 0,4% de 3,4%. */
export const fmtPp = (n, d = 1) => (n == null ? '—' : (d === 2 ? nf2 : nf1).format(n) + ' pp');

export function fmtMoney(n, { cents = false } = {}) {
  if (n == null) return '—';
  return '$' + (cents ? nf2 : nf0).format(n);
}

/** Horas em algo que se lê. Abaixo de 1h vira minuto; acima de 48h vira dia. */
export function fmtHours(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${nf1.format(h)} h`;
  return `${nf1.format(h / 24)} d`;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Construído a partir das partes, não de new Date(iso): uma data pelada é lida
// como UTC e voltaria um dia para quem está a oeste de Greenwich.
const parseDay = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const fmtDay = (iso) => { const d = parseDay(iso); return `${MONTH[d.getMonth()]} ${d.getDate()}`; };
export const fmtDayShort = (iso) => { const d = parseDay(iso); return `${WEEKDAY[d.getDay()]} ${d.getDate()}`; };
export const fmtWeekday = (iso) => WEEKDAY[parseDay(iso).getDay()];

export function fmtRange(from, to) {
  return String(from).slice(0, 10) === String(to).slice(0, 10) ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
}

export function fmtStamp(iso) {
  const d = new Date(iso);
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${MONTH[d.getMonth()]} ${d.getDate()}, ${h12}:${min} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* -------------------------------------------------------------- pedaços -- */

/** Um cartão de número. `delta` vem de metrics.change(); `status` de goalStatus(). */
export function tile({ label, value, unit, delta, deltaLabel, status, statusLabel, hero, foot }) {
  const parts = [];
  if (delta && delta.tone !== 'flat' && delta.delta != null) {
    const arrow = delta.delta > 0 ? '▲' : '▼';
    const cls = delta.tone === 'good' ? 'delta--good' : 'delta--bad';
    parts.push(`<span class="delta ${cls}">${arrow} ${esc(deltaLabel)}</span>`);
  } else if (delta && delta.delta != null) {
    parts.push(`<span class="delta delta--flat">no change</span>`);
  }
  if (status && status !== 'none') parts.push(statusChip(status, statusLabel));
  if (foot) parts.push(`<span>${esc(foot)}</span>`);

  return `<article class="kpi${hero ? ' kpi--hero' : ''}">
    <p class="kpi__label">${esc(label)}</p>
    <p class="kpi__value">${esc(value)}${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</p>
    ${parts.length ? `<div class="kpi__foot">${parts.join('')}</div>` : ''}
  </article>`;
}

const CHIP_WORD = { good: 'on target', warn: 'watch', crit: 'off target', none: 'no target' };

/** A cor nunca carrega o estado sozinha — o chip sempre vem com a palavra. */
export function statusChip(status, label) {
  const cls = { good: 'chip--good', warn: 'chip--warn', crit: 'chip--crit', none: 'chip--none' }[status] ?? 'chip--none';
  return `<span class="chip ${cls}">${esc(label ?? CHIP_WORD[status] ?? status)}</span>`;
}

export function legend(items, { line = false } = {}) {
  return `<div class="legend">${items.map((i) =>
    `<span class="legend__item"><span class="legend__key${line ? ' legend__key--line' : ''}" style="background:${i.color}"></span>${esc(i.label)}</span>`
  ).join('')}</div>`;
}

/** Lista de barras deitadas — a forma certa para comparar magnitude entre
    categorias nomeadas. Uma cor só: a identidade está no rótulo, não no matiz. */
export function barList(items, { format = fmtInt, color = 'var(--series-1)', max } = {}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value ?? 0));
  return `<div class="bars">${items.map((i) => {
    const w = Math.max(0, ((i.value ?? 0) / top) * 100);
    return `<div class="bar" title="${esc(i.label)}: ${esc(format(i.value))}">
      <span class="bar__label">${esc(i.label)}</span>
      <span class="bar__track"><span class="bar__fill" style="width:${w.toFixed(2)}%;background:${i.color ?? color}"></span></span>
      <span class="bar__value">${esc(format(i.value))}${i.sub ? `<span class="cell-sub">${esc(i.sub)}</span>` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------- barra empilhada -- */

/** Uma barra horizontal particionada. O vão de 2px entre segmentos é a folha
    de superfície que impede duas cores vizinhas de se lerem como uma só. */
export function stackedRow(segments, { height = 26, format = fmtInt } = {}) {
  const total = segments.reduce((t, s) => t + s.value, 0) || 1;
  const cells = segments.filter((s) => s.value > 0).map((s) => {
    const pct = (s.value / total) * 100;
    return `<span class="tt-seg" style="flex:0 0 ${pct.toFixed(3)}%;background:${s.color};height:${height}px"
      title="${esc(s.label)}: ${esc(format(s.value))} (${nf1.format(pct)}%)"></span>`;
  }).join('');
  return `<div style="display:flex;gap:2px;border-radius:999px;overflow:hidden">${cells}</div>`;
}

/* ---------------------------------------------------------- linhas ------- */

const W = 780, PAD = { t: 16, r: 16, b: 30, l: 44 };

/** Escala com passos redondos (1, 2, 2,5 ou 5 vezes uma potência de dez) e uns
    cinco intervalos. Dividir o topo em quartos fixos dava eixo com 63 e 188. */
function niceScale(max) {
  if (!(max > 0)) return { top: 10, ticks: [0, 5, 10] };
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { top, ticks };
}

/**
 * Gráfico de linhas com camada de hover.
 *   days   : [iso, …] eixo x
 *   series : [{ key, label, color, values: [] }, …]
 * Uma escala só, sempre. Duas medidas de grandeza diferente pedem dois gráficos.
 */
export function lineChart({ days, series, height = 250, formatValue = fmtInt, yLabel, xLabel = fmtDayShort, titles }) {
  const H = height;
  // Com até 4 séries cada linha ganha rótulo na ponta, e o rótulo precisa de
  // margem para caber — senão ele sai pela borda do viewBox.
  const direct = series.length <= 4;
  const padR = direct ? 92 : PAD.r;
  const iw = W - PAD.l - padR, ih = H - PAD.t - PAD.b;
  const maxV = Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v != null)));
  const { top, ticks } = niceScale(maxV);

  const x = (i) => PAD.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v) => PAD.t + ih - (v / top) * ih;

  const grid = ticks.map((t) => `
    <line class="gridline" x1="${PAD.l}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}"/>
    <text class="tick" x="${PAD.l - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${formatValue(t)}</text>`).join('');

  // No máximo uns nove rótulos no eixo, qualquer que seja o intervalo: com 90
  // pontos, um rótulo em cada vira uma faixa ilegível.
  const every = Math.max(1, Math.ceil(days.length / 9));
  const xlabels = days.map((d, i) => (i % every === 0)
    ? `<text class="tick" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(xLabel(d))}</text>` : '').join('');

  const paths = series.map((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    if (!pts.length) return '';
    return `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"
              stroke-linecap="round" points="${pts.join(' ')}"/>`;
  }).join('');

  // Rótulo direto na ponta: com até 4 séries a identidade não precisa depender
  // só do quadradinho da legenda. Mas séries que convergem no fim da semana
  // empilham os rótulos em cima uns dos outros, e rótulo ilegível é pior do que
  // rótulo nenhum — então eles são afastados até caberem lado a lado.
  const GAP = 13;
  const last = days.length - 1;
  const marcas = direct
    ? series.map((s, i) => ({ i, label: s.label, color: s.color, v: s.values[last] }))
        .filter((m) => m.v != null)
        .map((m) => ({ ...m, yv: y(m.v) }))
        .sort((a, b) => a.yv - b.yv)
    : [];
  for (let i = 1; i < marcas.length; i++) {
    if (marcas[i].yv - marcas[i - 1].yv < GAP) marcas[i].yv = marcas[i - 1].yv + GAP;
  }
  // Se o empurrão jogou o último para fora, desloca o bloco inteiro para cima.
  const excesso = marcas.length ? marcas[marcas.length - 1].yv - (PAD.t + ih) : 0;
  if (excesso > 0) for (const m of marcas) m.yv -= excesso;

  const rotulos = marcas.map((m) => {
    const yReal = y(m.v);
    // Quando o rótulo saiu do lugar, um tracinho liga ele de volta à linha.
    const guia = Math.abs(m.yv - yReal) > 2
      ? `<line x1="${(x(last) + 2).toFixed(1)}" y1="${yReal.toFixed(1)}"
              x2="${(x(last) + 7).toFixed(1)}" y2="${m.yv.toFixed(1)}"
              stroke="${m.color}" stroke-width="1" opacity=".5"/>` : '';
    return `${guia}<text x="${(x(last) + 10).toFixed(1)}" y="${(m.yv + 3.5).toFixed(1)}"
      font-size="10.5" font-weight="600" fill="${m.color}">${esc(m.label)}</text>`;
  }).join('');

  // Faixas de acerto: uma por dia, largas o bastante para o mouse pegar.
  const bandW = iw / Math.max(1, days.length - 1);
  const hits = days.map((d, i) => {
    const payload = series.map((s) => ({ label: s.label, color: s.color, value: s.values[i] }));
    const data = esc(JSON.stringify({ title: titles?.[i] ?? fmtDay(d), rows: payload }));
    return `<rect class="hit" data-tt="${data}" data-x="${x(i).toFixed(1)}"
      x="${(x(i) - bandW / 2).toFixed(1)}" y="${PAD.t}" width="${bandW.toFixed(1)}" height="${ih}"/>`;
  }).join('');

  const dots = series.map((s, si) => s.values.map((v, i) => v == null ? '' :
    `<circle class="dot" data-dot="${i}" r="4" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}"
      fill="${s.color}" opacity="0"/>`).join('')).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(yLabel ?? 'Time series')}" data-chart="line">
    ${grid}
    <line class="baseline" x1="${PAD.l}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}"/>
    ${xlabels}
    <line class="crosshair" y1="${PAD.t}" y2="${PAD.t + ih}" x1="0" x2="0" opacity="0"/>
    ${paths}${rotulos}${dots}${hits}
  </svg>`;
}

/** Colunas verticais para uma medida só, por dia. Ponta arredondada em 4px,
    ancorada na linha de base — nunca uma cápsula solta no ar. */
export function columnChart({ days, values, height = 200, color = 'var(--series-1)', formatValue = fmtInt, label, xLabel = fmtDayShort, titles }) {
  const H = height;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const { top, ticks } = niceScale(Math.max(1, ...values.filter((v) => v != null)));
  const y = (v) => PAD.t + ih - (v / top) * ih;
  const slot = iw / days.length;
  const bw = Math.min(38, slot * 0.6);

  const grid = ticks.map((t) => `
    <line class="gridline" x1="${PAD.l}" y1="${y(t).toFixed(1)}" x2="${W - PAD.r}" y2="${y(t).toFixed(1)}"/>
    <text class="tick" x="${PAD.l - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${formatValue(t)}</text>`).join('');

  const bars = values.map((v, i) => {
    const cx = PAD.l + slot * i + slot / 2;
    const h = Math.max(0, PAD.t + ih - y(v ?? 0));
    const data = esc(JSON.stringify({ title: titles?.[i] ?? fmtDay(days[i]), rows: [{ label, color, value: v }] }));
    return `<rect class="hit" data-tt="${data}" x="${(cx - slot / 2).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(1)}" height="${ih}"/>
      <rect x="${(cx - bw / 2).toFixed(1)}" y="${y(v ?? 0).toFixed(1)}" width="${bw.toFixed(1)}"
        height="${h.toFixed(1)}" rx="4" fill="${color}" pointer-events="none"/>`;
  }).join('');

  const every = Math.max(1, Math.ceil(days.length / 9));
  const xlabels = days.map((d, i) => (i % every === 0)
    ? `<text class="tick" x="${(PAD.l + slot * i + slot / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(xLabel(d))}</text>` : '').join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label ?? '')}" data-chart="col">
    ${grid}${bars}
    <line class="baseline" x1="${PAD.l}" y1="${y(0).toFixed(1)}" x2="${W - PAD.r}" y2="${y(0).toFixed(1)}"/>
    ${xlabels}
  </svg>`;
}

/* --------------------------------------------------------------- hover --- */

let tipEl = null;

function showTip(html, ev) {
  if (!tipEl) tipEl = document.getElementById('tooltip');
  if (!tipEl) return;
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let left = ev.clientX + 14, tp = ev.clientY - r.height - 12;
  if (left + r.width > innerWidth - 8) left = ev.clientX - r.width - 14;
  if (tp < 8) tp = ev.clientY + 18;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${tp}px`;
}

function hideTip() { if (tipEl) tipEl.hidden = true; }

/** Liga a camada de hover em todo gráfico dentro de `root`. Chamado depois de
    cada render — os SVG são recriados a cada troca de filtro. */
export function wireCharts(root) {
  root.querySelectorAll('svg[data-chart]').forEach((svg) => {
    const cross = svg.querySelector('.crosshair');
    const dots = svg.querySelectorAll('.dot');

    svg.querySelectorAll('.hit').forEach((hit, idx) => {
      hit.addEventListener('mousemove', (ev) => {
        let payload;
        try { payload = JSON.parse(hit.dataset.tt); } catch { return; }
        const rows = payload.rows
          .filter((r) => r.value != null)
          .map((r) => `<span class="tt-row"><span class="tt-key"><span class="tt-dot" style="background:${r.color}"></span>${esc(r.label)}</span><span class="tt-val">${esc(typeof r.value === 'number' ? (Number.isInteger(r.value) ? nf0.format(r.value) : nf1.format(r.value)) : r.value)}</span></span>`)
          .join('');
        showTip(`<b>${esc(payload.title)}</b>${rows}`, ev);

        if (cross && hit.dataset.x) {
          cross.setAttribute('x1', hit.dataset.x);
          cross.setAttribute('x2', hit.dataset.x);
          cross.setAttribute('opacity', '1');
        }
        dots.forEach((d) => d.setAttribute('opacity', d.dataset.dot === String(idx) ? '1' : '0'));
      });
      hit.addEventListener('mouseleave', () => {
        hideTip();
        if (cross) cross.setAttribute('opacity', '0');
        dots.forEach((d) => d.setAttribute('opacity', '0'));
      });
    });
  });

  root.addEventListener('scroll', hideTip, { passive: true });
}
