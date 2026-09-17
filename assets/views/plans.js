/* Planos de ação.

   Esta tela é o conteúdo inteiro de data/action-plans.json. Acrescentar um plano,
   reescrever um passo, marcar um como feito, trocar o responsável ou a prioridade
   acontece lá, nunca aqui.

   É a única tela que ignora o seletor de período: um plano não pertence a uma
   semana, ele fica aberto até ser fechado. */

import { statusChip, fmtDay, esc } from '../charts.js';

const STATUS = {
  not_started: { label: 'Not started', chip: 'chip--none' },
  in_progress: { label: 'In progress', chip: 'chip--warn' },
  blocked: { label: 'Blocked', chip: 'chip--crit' },
  done: { label: 'Done', chip: 'chip--good' },
};

const TIPO = {
  supplier: 'supplier', tech: 'tech', comms: 'comms',
  policy: 'policy', internal: 'internal',
};

export function renderPlans(data) {
  const plans = [...(data.plans ?? [])].sort((a, b) =>
    (a.priority - b.priority) || a.title.localeCompare(b.title, 'en'));

  if (plans.length === 0) {
    return `<p class="empty">No plans recorded.</p>`;
  }

  const cards = plans.map((p) => {
    const feitos = p.actions.filter((a) => a.done).length;
    const st = STATUS[p.status] ?? { label: p.status, chip: 'chip--none' };

    return `<section class="card plan">
      <div class="plan__top">
        <h2 class="plan__title">${esc(p.title)}</h2>
        <div class="plan__tags">
          <span class="chip ${st.chip}">${esc(st.label)}</span>
          <span class="chip chip--none chip--plain">priority ${esc(p.priority)}</span>
          <span class="chip chip--none chip--plain">${feitos} of ${p.actions.length} steps</span>
        </div>
      </div>

      <div class="plan__block">
        <h4>The problem</h4>
        <p>${esc(p.problem)}</p>
      </div>

      ${p.why_it_matters ? `<div class="plan__block">
        <h4>Why this one first</h4>
        <p>${esc(p.why_it_matters)}</p>
      </div>` : ''}

      <div class="plan__block">
        <h4>Steps</h4>
        <ul class="steps">${p.actions.map((a) => `
          <li class="step${a.done ? ' step--done' : ''}">
            <span class="step__dot" aria-hidden="true"></span>
            <span class="step__text">${esc(a.text)}${TIPO[a.type] ? `<span class="tag">${esc(TIPO[a.type])}</span>` : ''}</span>
          </li>`).join('')}
        </ul>
      </div>

      <div class="plan__block">
        <h4>How we will know it worked</h4>
        <p class="plan__metric">${p.metric ? esc(p.metric) : 'No metric set — a plan without one is a wish.'}</p>
      </div>

      <p class="note">
        ${p.owner ? `Owner: <b>${esc(p.owner)}</b>` : '<b>No owner assigned</b>'}
        · opened ${esc(fmtDay(p.opened_at))} · ${esc(p.plan_id)}
      </p>
    </section>`;
  }).join('');

  return `
    <p class="note note--scoped">
      This screen ignores the period selector — a plan does not belong to a week, it stays open
      until it is closed. The dots are read-only: progress is recorded by editing
      <code>data/action-plans.json</code>, not by clicking here.
    </p>
    ${cards}`;
}
