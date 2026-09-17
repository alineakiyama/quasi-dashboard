/* Visão da semana — a tela que o cliente abre. */

import * as M from '../metrics.js';
import {
  tile, statusChip, legend, barList, lineChart, columnChart, seriesColor,
  fmtInt, fmtPct, fmtPp, fmtHours, fmtMoney, fmtRange, fmtDay, esc,
} from '../charts.js';

export function renderOverview(data, state) {
  const { meta, rows, reasons, queue, refunds, replacements, revenue, chargebacks } = data;
  const w = state.window;
  const cmp = state.compare;
  const reasonLabel = state.reason ? data.reasonById.get(state.reason)?.label : null;

  const cur = M.ticketKpis(rows, { ...w, reason: state.reason });
  const prev = cmp ? M.ticketKpis(rows, { ...cmp, reason: state.reason }) : null;

  const money = M.revenueIn(revenue, w.from, w.to);
  const ref = M.refundsIn(refunds, w.from, w.to);
  const repl = M.replacementsIn(replacements, w.from, w.to);
  const refRate = M.refundRate(refunds, revenue, w.from, w.to);
  const refRatePrev = cmp ? M.refundRate(refunds, revenue, cmp.from, cmp.to) : null;
  const cbRate = M.chargebackRate(chargebacks, revenue, w.from, w.to);
  const cbRatePrev = cmp ? M.chargebackRate(chargebacks, revenue, cmp.from, cmp.to) : null;

  const t = meta.targets;
  const days = M.byDay(rows, { ...w, reason: state.reason });
  // Até um mês, um ponto por dia. Acima disso, um ponto por semana: 90 colunas
  // finas não se leem, e a mediana semanal sai do conjunto reunido de tickets
  // da semana — é para isso que os arrays crus existem.
  const semanal = days.length > 31;
  const pontos = semanal ? M.byWeek(days) : days;
  const unidadeTempo = semanal ? 'week' : 'day';
  const titulos = semanal
    ? pontos.map((p) => `Week of ${fmtDay(p.date)}${p.days < 7 ? ` (${p.days} of 7 days)` : ''}`)
    : undefined;
  const perReason = M.byReason(rows, reasons, w);

  /* -------------------------------------------------------------- topo -- */

  const d = (a, b, dir) => M.change(a, b, dir);
  const lbl = (delta, fmt) => (delta.delta == null ? '' : fmt(Math.abs(delta.delta)));

  const dCreated = d(cur.created, prev?.created, 'lower_is_better');
  const dFrt = d(cur.frtMedian, prev?.frtMedian, 'lower_is_better');
  const dU24 = d(cur.pctUnder24, prev?.pctUnder24, 'higher_is_better');
  const dRes = d(cur.resMedian, prev?.resMedian, 'lower_is_better');
  const dRefund = d(refRate, refRatePrev, 'lower_is_better');
  const dCb = d(cbRate, cbRatePrev, 'lower_is_better');

  const kpisTop = [
    tile({
      hero: true, label: 'Conversations received', value: fmtInt(cur.created),
      delta: dCreated, deltaLabel: lbl(dCreated, fmtInt),
      foot: `${fmtInt(cur.answered)} answered · ${fmtInt(cur.closed)} closed`,
    }),
    tile({
      label: 'First response', value: fmtHours(cur.frtMedian), unit: 'median',
      delta: dFrt, deltaLabel: lbl(dFrt, fmtHours),
      status: M.goalStatus(cur.frtMedian, t.frt_median_hours),
      foot: `9 in 10 within ${fmtHours(cur.frtP90)}`,
    }),
    tile({
      label: 'Answered within 24h', value: fmtPct(cur.pctUnder24),
      delta: dU24, deltaLabel: lbl(dU24, (v) => fmtPp(v)),
      status: M.goalStatus(cur.pctUnder24, t.pct_answered_under_24h),
      foot: `${fmtInt(cur.frt.length - M.countUnder(cur.frt, 24))} waited more than a day`,
    }),
    tile({
      label: 'Resolution', value: fmtHours(cur.resMedian), unit: 'median',
      delta: dRes, deltaLabel: lbl(dRes, fmtHours),
      status: M.goalStatus(cur.resMedian, t.resolution_median_hours),
      foot: `${fmtInt(cur.closed)} conversations closed`,
    }),
  ].join('');

  // Os dois cartões de fila são retrato de um instante, não soma do período —
  // então não mudam com o seletor. Quando o período escolhido não é o do
  // retrato, o cartão precisa dizer isso, senão o número parece do período.
  const snapDia = fmtDay(data.queue.snapshot_at);
  const foraDoPeriodo = w.to !== data.meta.data_end;
  const notaFila = foraDoPeriodo ? ` · snapshot of ${snapDia}, not of the period you picked` : '';

  const kpisBottom = [
    tile({
      label: 'Queue at close', value: fmtInt(queue.summary.backlog),
      status: foraDoPeriodo ? null : M.goalStatus(queue.summary.backlog, t.backlog),
      foot: `${fmtInt(queue.summary.aging.over_72h)} waiting more than 3 days${notaFila}`,
    }),
    tile({
      label: 'No reply for 24h+', value: fmtInt(queue.summary.over_24h_unanswered),
      status: foraDoPeriodo ? null : M.goalStatus(queue.summary.over_24h_unanswered, t.over_24h_unanswered),
      foot: `still no human reply${notaFila}`,
    }),
    tile({
      label: 'Refund rate', value: fmtPct(refRate, 2),
      delta: dRefund, deltaLabel: lbl(dRefund, (v) => fmtPp(v, 2)),
      status: M.goalStatus(refRate, t.refund_rate),
      foot: `${fmtMoney(ref.total)} against ${fmtMoney(money.revenue)}`,
    }),
    tile({
      label: 'Chargeback rate', value: fmtPct(cbRate, 2),
      delta: dCb, deltaLabel: lbl(dCb, (v) => fmtPp(v, 2)),
      status: M.goalStatus(cbRate, t.chargeback_rate),
      foot: `${fmtInt(M.chargebacksOpenedIn(chargebacks, w.from, w.to).count)} disputes in ${fmtInt(money.orders)} orders`,
    }),
  ].join('');

  /* ---------------------------------------------------------- gráficos -- */

  const dayList = pontos.map((x) => x.date);
  const eixo = semanal ? { xLabel: fmtDay, titles: titulos } : {};
  // Um dia só não tem tendência: uma linha de um ponto é um pingo solto no meio
  // do gráfico. Os dados são diários, não por hora, então nesse caso os números
  // do dia aparecem direto, em vez de um gráfico que não diz nada.
  const umDia = pontos.length === 1;
  const volume = umDia ? `
    <dl class="stat-inline">
      <div><dt>Received</dt><dd>${fmtInt(pontos[0].created)}</dd></div>
      <div><dt>Answered</dt><dd>${fmtInt(pontos[0].answered)}</dd></div>
      <div><dt>Closed</dt><dd>${fmtInt(pontos[0].closed)}</dd></div>
      <div><dt>Reopened</dt><dd>${fmtInt(pontos[0].reopened)}</dd></div>
    </dl>
    <p class="note">A single day has no trend to draw — the data is daily, not hourly. Pick a range of two
    days or more to see the line.</p>` : lineChart({
    days: dayList,
    series: [
      { key: 'created', label: 'Received', color: seriesColor(0), values: pontos.map((x) => x.created) },
      { key: 'answered', label: 'Answered', color: seriesColor(1), values: pontos.map((x) => x.answered) },
      { key: 'closed', label: 'Closed', color: seriesColor(2), values: pontos.map((x) => x.closed) },
    ],
    yLabel: `Conversations per ${unidadeTempo}`,
    ...eixo,
  });

  const frtCols = umDia ? `
    <dl class="stat-inline">
      <div><dt>Median</dt><dd>${fmtHours(pontos[0].frtMedian)}</dd></div>
      <div><dt>Within 24h</dt><dd>${fmtPct(M.percent(M.countUnder(pontos[0].frt, 24), pontos[0].frt.length))}</dd></div>
      <div><dt>Replies measured</dt><dd>${fmtInt(pontos[0].frt.length)}</dd></div>
    </dl>` : columnChart({
    days: dayList,
    values: pontos.map((x) => (x.frtMedian == null ? null : Math.round(x.frtMedian * 10) / 10)),
    label: 'First response (median)',
    formatValue: (v) => `${v}h`,
    color: 'var(--series-1)',
    ...eixo,
  });

  /* ------------------------------------------------------- por motivo --- */

  const totalCreated = M.sum(perReason.map((r) => r.created));
  const geral = M.ticketKpis(rows, w);

  const motivoBars = barList(
    perReason.map((r) => ({
      label: r.label, value: r.created,
      sub: fmtPct(r.share),
      color: r.reason === state.reason ? 'var(--rose-ink)' : 'var(--series-1)',
    })),
    { format: fmtInt });

  const motivoTable = `<div class="tablewrap"><table>
    <thead><tr>
      <th>Contact reason</th>
      <th class="num">Received</th><th class="num">Share</th>
      <th class="num">1st reply</th><th class="num">Within 24h</th>
      <th class="num">Resolution</th><th class="num">Reopened</th>
    </tr></thead>
    <tbody>${perReason.map((r) => `
      <tr${r.reason === state.reason ? ' style="background:var(--rose-tint)"' : ''}>
        <td>${esc(r.label)}</td>
        <td class="num">${fmtInt(r.created)}</td>
        <td class="num">${fmtPct(r.share)}</td>
        <td class="num">${fmtHours(r.frtMedian)}</td>
        <td class="num">${fmtPct(r.pctUnder24)}</td>
        <td class="num">${fmtHours(r.resMedian)}</td>
        <td class="num">${fmtPct(r.reopenRate)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td>Total / weighted</td>
      <td class="num">${fmtInt(totalCreated)}</td>
      <td class="num">100.0%</td>
      <td class="num">${fmtHours(geral.frtMedian)}</td>
      <td class="num">${fmtPct(geral.pctUnder24)}</td>
      <td class="num">${fmtHours(geral.resMedian)}</td>
      <td class="num">${fmtPct(geral.reopenRate)}</td>
    </tr></tfoot>
  </table></div>`;

  /* ------------------------------------------------ reembolso e troca --- */

  const REF_LABEL = {
    not_delivered: 'Never delivered', damaged_in_transit: 'Damaged in transit',
    quality_issue: 'Product quality', adverse_reaction: 'Skin reaction',
    late_delivery: 'Late delivery', wrong_item: 'Wrong item',
    changed_mind: 'Changed their mind', subscription_charge: 'Subscription charge',
    missing_part: 'Item missing from the kit',
  };

  const dinheiro = `
    <dl class="stat-inline">
      <div><dt>Refunded</dt><dd>${fmtMoney(ref.total)}<span class="sub">${fmtInt(ref.count)} refunds · ${fmtMoney(ref.average, { cents: true })} average</span></dd></div>
      <div><dt>Partial</dt><dd>${fmtPct(ref.partialShare)}<span class="sub">part of the order kept, not all of it</span></dd></div>
      <div><dt>Replacements</dt><dd>${fmtMoney(repl.total)}<span class="sub">${fmtInt(repl.count)} shipped · ${fmtInt(repl.repeats)} for the second time</span></dd></div>
      <div><dt>Total cost of going wrong</dt><dd>${fmtMoney(ref.total + repl.total)}<span class="sub">${fmtPct(M.percent(ref.total + repl.total, money.revenue), 2)} of revenue</span></dd></div>
    </dl>`;

  const refBars = barList(
    ref.byReason.map((g) => ({ label: REF_LABEL[g.key] ?? g.key, value: g.count, sub: fmtMoney(g.amount) })),
    { format: fmtInt });

  /* ------------------------------------------------------------ metas --- */

  // Fila e "sem resposta" vêm do retrato, não do período. Num período que não
  // é o do retrato eles não têm valor a mostrar — melhor um traço do que um
  // número que parece pertencer àquela semana e não pertence.
  const valores = {
    frt_median_hours: cur.frtMedian,
    pct_answered_under_24h: cur.pctUnder24,
    resolution_median_hours: cur.resMedian,
    backlog: foraDoPeriodo ? null : queue.summary.backlog,
    over_24h_unanswered: foraDoPeriodo ? null : queue.summary.over_24h_unanswered,
    reopen_rate: cur.reopenRate,
    refund_rate: refRate,
    chargeback_rate: cbRate,
  };
  const unidade = (v, unit) => {
    if (v == null) return '—';
    if (unit === 'hours') return fmtHours(v);
    if (unit === 'percent') return fmtPct(v, v < 10 ? 2 : 1);
    if (unit === 'usd') return fmtMoney(v);
    return fmtInt(v);
  };

  const metas = `<div class="tablewrap"><table>
    <thead><tr><th>Target</th><th class="num">Now</th><th class="num">Goal</th><th class="num">Limit</th><th>Standing</th></tr></thead>
    <tbody>${Object.entries(t).map(([id, target]) => {
      const v = valores[id];
      const st = M.goalStatus(v, target);
      return `<tr>
        <td>${esc(target.label)}</td>
        <td class="num"><b>${unidade(v, target.unit)}</b></td>
        <td class="num">${unidade(target.goal, target.unit)}</td>
        <td class="num">${unidade(target.warning, target.unit)}</td>
        <td style="text-align:left">${statusChip(st, v == null && foraDoPeriodo ? 'no snapshot' : null)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>
  <p class="note">The thresholds live in <code>data/meta.json</code>. Changing a goal changes the
  chip in this table with no code change; deleting an entry deletes the row.${
    foraDoPeriodo ? ` <b>Queue at period end</b> and <b>open 24h+ with no reply</b> read as a dash:
    they are measurements from the ${esc(snapDia)} snapshot, and there is no snapshot for the period you picked.` : ''}</p>`;

  /* ------------------------------------------------------------ monta --- */

  const escopo = state.reason
    ? `<p class="note note--scoped">Filtered to <b>${esc(reasonLabel)}</b>. Refunds, replacements and
       chargebacks do not carry a contact reason — those blocks still show the whole period.</p>`
    : '';

  return `
    ${escopo}
    <div class="grid grid--kpi">${kpisTop}</div>
    <div class="grid grid--kpi">${kpisBottom}</div>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Volume by ${unidadeTempo}</h2>
            <p class="card__note">Received is when a conversation is born; answered is when a person
            actually replied to it. The ${unidadeTempo}s where the rose line sits above the amber one are
            the ${unidadeTempo}s the queue grew.</p>
          </div>
          <span class="card__aside">${esc(fmtRange(w.from, w.to))}</span>
        </div>
        <div class="card__body">${volume}
          ${umDia ? '' : legend([
            { label: 'Received', color: seriesColor(0) },
            { label: 'Answered', color: seriesColor(1) },
            { label: 'Closed', color: seriesColor(2) },
          ], { line: true })}
        </div>
      </section>

      <section class="card">
        <div class="card__head"><div>
          <h2 class="card__title">Time to first response</h2>
          <p class="card__note">The ${unidadeTempo}'s median, in hours. Computed over the actual set of
          conversations answered that ${unidadeTempo}${semanal ? ' — pooled, never an average of daily medians' : ''}.</p>
        </div></div>
        <div class="card__body">${frtCols}</div>
      </section>
    </div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Refunds and replacements <span class="chip chip--demo">Demo data</span></h2>
        <p class="card__note">Refund rate is money over money — the amount given back divided by
        revenue for the same window. Never refunds ÷ conversations.</p>
      </div></div>
      <div class="card__body">${dinheiro}
        <h3 style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:22px 0 12px">Reason for the refund</h3>
        ${refBars}
      </div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Why people write in</h2>
        <p class="card__note">With a single store, the contact reason is this portal's axis of
        comparison. This table ignores the filter on purpose — it <i>is</i> the comparison.</p>
      </div></div>
      <div class="card__body">${motivoBars}<div style="margin-top:24px">${motivoTable}</div>
        <p class="note">The total row is recomputed over every conversation pooled together — it is
        not the average of the cells above it. Counts add up; medians and percentages do not.</p>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Targets</h2>
        <p class="card__note">Where each number landed against what was agreed.</p>
      </div></div>
      <div class="card__body">${metas}</div>
    </section>
  `;
}
