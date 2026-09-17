/* Operação — a tela do time, não do cliente.

   Tudo aqui é SNAPSHOT: o estado da fila num instante. Nada nesta tela é uma
   soma de dias e nada pode ser somado entre períodos. Por isso ela não muda
   com o seletor de período — só o instante de queue.json a define. */

import * as M from '../metrics.js';
import {
  tile, legend, barList, stackedRow, stepColor,
  fmtInt, fmtPct, fmtHours, fmtStamp, esc,
} from '../charts.js';

const CRIT_LABEL = {
  no_reply_over_24h: 'No reply for 24h+',
  waiting_over_3_days: 'Waiting 3+ days',
  reopened: 'Reopened',
  refund_requested: 'Asked for a refund',
  escalated: 'Escalated',
};

export function renderOperation(data, state) {
  const { queue, reasonById, refunds, meta } = data;
  const s = queue.summary;
  const snap = queue.snapshot_at;

  const agents = M.agentStats(queue);
  const refByAgent = M.refundsByAgent(refunds, meta.period_end, meta.period_end);
  const nameOf = (id) => queue.agents.find((a) => a.agent_id === id)?.agent_name ?? '—';
  const labelOf = (r) => reasonById.get(r)?.label ?? r;

  const t = meta.targets;
  const filtro = state.reason;

  /* ---------------------------------------------------------- cartões -- */

  const kpis = [
    tile({
      hero: true, label: 'In the queue now', value: fmtInt(s.backlog),
      status: M.goalStatus(s.backlog, t.backlog),
      foot: `${fmtInt(s.unassigned)} with nobody assigned`,
    }),
    tile({
      label: 'No reply for 24h+', value: fmtInt(s.over_24h_unanswered),
      status: M.goalStatus(s.over_24h_unanswered, t.over_24h_unanswered),
      foot: 'open and still without a human reply',
    }),
    tile({
      label: 'Waiting 3+ days', value: fmtInt(s.aging.over_72h),
      foot: `${fmtPct(M.percent(s.aging.over_72h, s.backlog))} of the queue`,
    }),
    tile({
      label: 'Answered that day', value: fmtInt(s.answered_today),
      foot: `${fmtInt(agents.length)} agents on shift`,
    }),
  ].join('');

  /* -------------------------------------------------------- fila/idade -- */

  const aging = [
    { label: 'Under 24h', value: s.aging.under_24h, color: stepColor(0) },
    { label: '24h to 72h', value: s.aging.h24_to_72h, color: stepColor(1) },
    { label: 'Over 72h', value: s.aging.over_72h, color: stepColor(2) },
  ];

  const idade = `
    ${stackedRow(aging, { height: 30 })}
    ${legend(aging.map((a) => ({ label: `${a.label} — ${fmtInt(a.value)}`, color: a.color })))}
    <p class="note">The three bands partition the queue: they add up to exactly ${fmtInt(s.backlog)}.
    Age is not the same as "no reply" — a ticket can be 30 hours old and already answered.</p>`;

  /* ------------------------------------------------------ fila/motivo -- */

  const porMotivo = [...(queue.by_reason ?? [])].sort((a, b) => b.backlog - a.backlog);
  const filaMotivo = barList(
    porMotivo.map((r) => ({
      label: labelOf(r.reason), value: r.backlog,
      sub: `${fmtInt(r.over_24h_unanswered)} with no reply`,
      color: r.reason === filtro ? 'var(--rose-ink)' : 'var(--series-1)',
    })),
    { format: fmtInt });

  /* ---------------------------------------------------------- críticos -- */

  const criticos = (queue.critical ?? [])
    .filter((c) => !filtro || c.reason === filtro)
    .map((c) => ({ ...c, age: M.ageInHours(c.created_at, snap) }))
    .sort((a, b) => b.age - a.age);

  const tabelaCritica = criticos.length === 0
    ? `<p class="empty">Nothing in the critical queue for this selection.</p>`
    : `<div class="tablewrap"><table>
      <thead><tr>
        <th>Conversation</th><th>Reason</th><th class="num">Age</th>
        <th>First reply</th><th>Assigned to</th><th>Why it is here</th>
      </tr></thead>
      <tbody>${criticos.map((c) => `
        <tr>
          <td>${esc(c.subject)}<span class="cell-sub">${esc(c.customer)} · ${esc(c.order_id)} · ${esc(c.ticket_id)}</span></td>
          <td>${esc(labelOf(c.reason))}</td>
          <td class="num">${fmtHours(c.age)}</td>
          <td style="text-align:left">${c.first_human_reply_at
            ? esc(fmtStamp(c.first_human_reply_at))
            : '<span class="chip chip--crit">never answered</span>'}</td>
          <td style="text-align:left">${c.assignee_id
            ? esc(nameOf(c.assignee_id))
            : '<span class="chip chip--warn">unassigned</span>'}</td>
          <td style="text-align:left">${esc(CRIT_LABEL[c.escalation_reason] ?? c.escalation_reason)}</td>
        </tr>`).join('')}
      </tbody></table></div>`;

  /* ---------------------------------------------------------- agentes -- */

  const totalAnswered = M.sum(agents.map((a) => a.answered));
  const poolFrt = agents.flatMap((a) => a.frt_hours ?? []);

  const tabelaAgentes = `<div class="tablewrap"><table>
    <thead><tr>
      <th>Agent</th><th class="num">Answered</th><th class="num">Closed</th>
      <th class="num">1st reply</th><th class="num">Past 24h</th>
      <th class="num">Reopened</th><th class="num">Refunds</th>
    </tr></thead>
    <tbody>${agents.map((a) => `
      <tr>
        <td>${esc(a.agent_name)}</td>
        <td class="num">${fmtInt(a.answered)}</td>
        <td class="num">${fmtInt(a.closed)}</td>
        <td class="num">${fmtHours(a.frtMedian)}</td>
        <td class="num">${fmtInt(a.over24)}</td>
        <td class="num">${fmtInt(a.reopened)}<span class="cell-sub">${fmtPct(a.reopenRate)}</span></td>
        <td class="num">${fmtInt(refByAgent.get(a.agent_id) ?? 0)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td>Total / weighted</td>
      <td class="num">${fmtInt(totalAnswered)}</td>
      <td class="num">${fmtInt(M.sum(agents.map((a) => a.closed)))}</td>
      <td class="num">${fmtHours(M.median(poolFrt))}</td>
      <td class="num">${fmtInt(M.sum(agents.map((a) => a.over24)))}</td>
      <td class="num">${fmtInt(M.sum(agents.map((a) => a.reopened)))}</td>
      <td class="num">${fmtInt(M.sum(agents.map((a) => refByAgent.get(a.agent_id) ?? 0)))}</td>
    </tr></tfoot>
  </table></div>
  <p class="note">The median in the footer comes from all ${fmtInt(poolFrt.length)} conversations
  answered that day pooled together, not from averaging each person's median. Refunds are counted
  per agent from <code>refunds.json</code> — so this table and the refund tiles have no way to disagree.</p>`;

  /* --------------------------------------------------------- mais velho -- */

  const o = s.oldest_ticket;
  const maisVelho = `
    <div class="plan__metric" style="display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline">
      <b style="font-weight:600">${esc(o.subject)}</b>
      <span>${esc(labelOf(o.reason))}</span>
      <span>open for <b>${fmtHours(M.ageInHours(o.created_at, snap))}</b></span>
      <span>${o.assignee_id ? esc(nameOf(o.assignee_id)) : 'unassigned'}</span>
      <span style="color:var(--muted)">${esc(o.ticket_id)}</span>
    </div>`;

  /* ------------------------------------------------------------ monta --- */

  const escopo = filtro
    ? `<p class="note note--scoped">The critical queue and the queue-by-reason chart are filtered to
       <b>${esc(labelOf(filtro))}</b>. The tiles at the top and the agent table describe the whole operation.</p>`
    : '';

  return `
    <p class="note note--scoped" style="background:var(--neutral-bg);color:var(--ink-2)">
      A picture of the queue at <b>${esc(fmtStamp(snap))}</b>. Nothing on this screen is a sum over
      days — it is what existed at that instant, which is why the period selector does not change it.
    </p>
    ${escopo}
    <div class="grid grid--kpi">${kpis}</div>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__head"><div>
          <h2 class="card__title">How long the queue has been waiting</h2>
        </div></div>
        <div class="card__body">${idade}</div>
      </section>

      <section class="card">
        <div class="card__head"><div>
          <h2 class="card__title">Queue by reason</h2>
          <p class="card__note">Where the queue is stuck right now.</p>
        </div></div>
        <div class="card__body">${filaMotivo}</div>
      </section>
    </div>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">The oldest conversation still open</h2>
      </div></div>
      <div class="card__body">${maisVelho}</div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Critical queue</h2>
        <p class="card__note">What needs a person today, oldest first.</p>
      </div>
      <span class="card__aside">${fmtInt(criticos.length)} conversations</span></div>
      <div class="card__body">${tabelaCritica}</div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">By agent</h2>
        <p class="card__note">Figures for the snapshot day, ${esc(fmtStamp(snap).split(',')[0])}.</p>
      </div></div>
      <div class="card__body">${tabelaAgentes}</div>
    </section>
  `;
}
