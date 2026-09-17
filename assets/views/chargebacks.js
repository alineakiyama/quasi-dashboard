/* Chargebacks.

   O arquivo responde duas perguntas diferentes e mantê-las separadas é o ponto:

   · Quantas ENTRARAM no período — recortado por opened_at. É a única base da taxa.
   · Onde as disputas estão AGORA — varredura de todas as linhas, ignorando o
     período. Uma disputa aberta antes da semana e ainda indecisa é dinheiro em
     risco hoje; limitá-la à semana seria reportá-la como se tivesse se resolvido. */

import * as M from '../metrics.js';
import {
  tile, statusChip, legend, barList, stackedRow,
  fmtInt, fmtPct, fmtPp, fmtMoney, fmtStamp, fmtDay, fmtRange, esc,
} from '../charts.js';

const REASON = {
  fraud_unauthorised: 'Fraud / unauthorised',
  product_not_received: 'Product not received',
  product_not_as_described: 'Not as described',
  subscription_not_cancelled: 'Subscription not cancelled',
  duplicate_charge: 'Duplicate charge',
  credit_not_processed: 'Credit not processed',
  unrecognised_descriptor: 'Did not recognise the charge',
};
const NETWORK = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', paypal: 'PayPal' };
const STATUS = {
  open: 'Received', under_review: 'With the bank',
  won: 'Won', lost: 'Lost', accepted: 'Accepted without contesting',
};

export function renderChargebacks(data, state) {
  const { chargebacks, revenue, meta } = data;
  const w = state.window;
  const cmp = state.compare;
  const snap = data.chargebackSnapshot;

  const abertos = M.chargebacksOpenedIn(chargebacks, w.from, w.to);
  const money = M.revenueIn(revenue, w.from, w.to);
  const rate = M.chargebackRate(chargebacks, revenue, w.from, w.to);
  const ratePrev = cmp ? M.chargebackRate(chargebacks, revenue, cmp.from, cmp.to) : null;
  const dRate = M.change(rate, ratePrev, 'lower_is_better');

  const st = M.chargebackStanding(chargebacks);
  const valorRate = M.percent(abertos.amount, money.revenue);

  /* ---------------------------------------------------------- cartões -- */

  const kpis = [
    tile({
      hero: true, label: 'Chargeback rate', value: fmtPct(rate, 2),
      delta: dRate, deltaLabel: dRate.delta == null ? '' : fmtPp(Math.abs(dRate.delta), 2),
      status: M.goalStatus(rate, meta.targets.chargeback_rate),
      foot: `${fmtInt(abertos.count)} disputes in ${fmtInt(money.orders)} orders`,
    }),
    tile({
      label: 'Amount disputed this period', value: fmtMoney(abertos.amount),
      foot: `${fmtPct(valorRate, 2)} of revenue — the money ratio, which is not the one that triggers anything`,
    }),
    tile({
      label: 'Sitting with the bank', value: fmtInt(st.pending.length),
      foot: `${fmtMoney(st.pendingAmount)} undecided`,
    }),
    tile({
      label: 'Win rate', value: fmtPct(st.winRate),
      foot: `${fmtInt(st.won.length)} won of ${fmtInt(st.decided.length)} decided`,
    }),
  ].join('');

  /* -------------------------------------------------------- resultado -- */

  const segmentos = [
    { label: 'Won', value: st.won.length, color: 'var(--good)' },
    { label: 'Lost', value: st.lost.length, color: 'var(--crit)' },
    { label: 'Accepted without contesting', value: st.accepted.length, color: 'var(--serious)' },
    { label: 'Still pending', value: st.pending.length, color: 'var(--axis)' },
  ];

  const resultado = `
    ${stackedRow(segmentos, { height: 30 })}
    ${legend(segmentos.map((s) => ({ label: `${s.label} — ${fmtInt(s.value)}`, color: s.color })))}
    <dl class="stat-inline" style="margin-top:22px">
      <div><dt>Money kept</dt><dd>${fmtMoney(st.wonAmount)}<span class="sub">cases won</span></dd></div>
      <div><dt>Money lost</dt><dd>${fmtMoney(st.lostAmount)}<span class="sub">lost plus accepted</span></dd></div>
      <div><dt>Processor fees</dt><dd>${fmtMoney(st.fees)}<span class="sub">${fmtInt(chargebacks.length)} cases × $15</span></dd></div>
      <div><dt>Total cost</dt><dd>${fmtMoney(st.lostAmount + st.fees)}<span class="sub">lost plus the fees</span></dd></div>
    </dl>
    <p class="note">Win rate is won ÷ decided. Pending cases are left out — counting them would drag
    the rate down for no reason other than time not having passed yet. The processor's fee is charged
    whatever the outcome and is not returned on a win, which is why it is summed across every case
    and not only the lost ones.</p>`;

  /* --------------------------------------------------------- pendentes -- */

  const pendentes = [...st.pending]
    .map((c) => ({ ...c, age: M.ageInHours(c.opened_at, snap) }))
    .sort((a, b) => b.age - a.age);

  const tabelaPendentes = pendentes.length === 0
    ? `<p class="empty">No dispute is waiting on the bank.</p>`
    : `<div class="tablewrap"><table>
      <thead><tr>
        <th>Case</th><th>Reason claimed</th><th>Network</th>
        <th class="num">Amount</th><th class="num">Age</th><th>Standing</th><th>Evidence</th>
      </tr></thead>
      <tbody>${pendentes.map((c) => `
        <tr>
          <td>${esc(c.order_id)}<span class="cell-sub">${esc(c.chargeback_id)} · opened ${esc(fmtDay(c.opened_at))}</span></td>
          <td>${esc(REASON[c.reason] ?? c.reason)}</td>
          <td>${esc(NETWORK[c.network] ?? c.network)}</td>
          <td class="num">${fmtMoney(c.amount_usd, { cents: true })}</td>
          <td class="num">${Math.round(c.age / 24)} d</td>
          <td style="text-align:left">${esc(STATUS[c.status] ?? c.status)}</td>
          <td style="text-align:left">${c.represented
            ? '<span class="chip chip--good">submitted</span>'
            : '<span class="chip chip--warn">not submitted yet</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>
      <p class="note">Age is measured against the ${esc(fmtStamp(snap))} snapshot. Some were opened
      before the week being reported and are still here — that is money at risk today, whatever
      period the page happens to be showing.</p>`;

  /* ------------------------------------------------------- por motivo -- */

  const motivos = barList(
    st.byReason.map((g) => ({ label: REASON[g.key] ?? g.key, value: g.count, sub: fmtMoney(g.amount) })),
    { format: fmtInt });

  const redes = barList(
    st.byNetwork.map((g) => ({ label: NETWORK[g.key] ?? g.key, value: g.count, sub: fmtMoney(g.amount) })),
    { format: fmtInt });

  /* ------------------------------------------------------------ monta --- */

  return `
    <div class="grid grid--kpi">${kpis}</div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">The ratio the card networks watch</h2>
        <p class="card__note">Chargebacks are measured as <b>count ÷ orders</b>, not value ÷ revenue.
        That is the ratio card networks monitor and set thresholds on — it is what decides whether an
        account enters a monitoring programme. The money ratio sits in the tile beside it because it
        is what the problem actually costs, but it is not the number that triggers anything.</p>
      </div>
      <span class="card__aside">${esc(fmtRange(w.from, w.to))}</span></div>
      <div class="card__body">
        <dl class="stat-inline">
          <div><dt>Disputes opened</dt><dd>${fmtInt(abertos.count)}<span class="sub">in the reported period</span></dd></div>
          <div><dt>Orders</dt><dd>${fmtInt(money.orders)}<span class="sub">denominator of the rate</span></dd></div>
          <div><dt>Rate</dt><dd>${fmtPct(rate, 2)}<span class="sub">${statusChip(M.goalStatus(rate, meta.targets.chargeback_rate))}</span></dd></div>
          <div><dt>Monitoring threshold</dt><dd>${fmtPct(meta.targets.chargeback_rate.warning, 2)}<span class="sub">where programmes typically begin</span></dd></div>
        </dl>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Where the disputes stand today</h2>
        <p class="card__note">All ${fmtInt(chargebacks.length)} rows in the file, with no period filter.</p>
      </div></div>
      <div class="card__body">${resultado}</div>
    </section>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__head"><div><h2 class="card__title">Reason claimed</h2></div></div>
        <div class="card__body">${motivos}</div>
      </section>
      <section class="card">
        <div class="card__head"><div><h2 class="card__title">Network</h2></div></div>
        <div class="card__body">${redes}</div>
      </section>
    </div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Waiting on the bank</h2>
        <p class="card__note">Money that may still come back — or may not.</p>
      </div>
      <span class="card__aside">${fmtInt(pendentes.length)} cases · ${fmtMoney(st.pendingAmount)}</span></div>
      <div class="card__body">${tabelaPendentes}</div>
    </section>
  `;
}
