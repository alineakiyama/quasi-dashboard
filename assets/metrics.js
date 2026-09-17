/* =========================================================================
   Todo o cálculo do portal. Funções puras: entram dados, saem números.
   Nada aqui toca no DOM e nada aqui busca arquivo.

   Duas convenções que valem para a página inteira:

   1. MEDIANA NUNCA É GUARDADA. tickets-daily.json carrega um valor por ticket,
      não uma mediana pronta, porque mediana de medianas não é mediana. Toda
      mediana da tela é calculada sobre o conjunto real de tickets em escopo.

   2. CONTAGEM E DINHEIRO SOMAM; MEDIANA E PORCENTAGEM NÃO. A linha de total das
      tabelas é recalculada sobre o conjunto reunido, o que a pondera por volume.
      É por isso que ela quase nunca é a média das células acima dela.
   ========================================================================= */

/* ------------------------------------------------------------ básicas ---- */

export function median(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(values, q) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function sum(values) { return values.reduce((t, v) => t + (v || 0), 0); }

/** Divisão que devolve null em vez de NaN/Infinity quando não há denominador. */
export function ratio(a, b) { return b ? a / b : null; }
export function percent(a, b) { return b ? (a / b) * 100 : null; }

export function countUnder(values, limit) {
  return values.reduce((n, v) => n + (v < limit ? 1 : 0), 0);
}

/* ------------------------------------------------------------ períodos --- */

const D = (s) => String(s).slice(0, 10);

export function inWindow(dateish, from, to) {
  const d = D(dateish);
  return d >= from && d <= to;
}

const addDays = (iso, n) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Quantos dias um intervalo inclusivo tem. De 1 a 7 de setembro são 7. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
}

/** Os atalhos do seletor. Contados a partir do último dia com dado, NÃO de hoje:
    o job roda depois que o dia fecha, então "últimos 7 dias" contados a partir de
    hoje sempre incluiriam dias que ainda não existem nos arquivos. */
export function presets(meta) {
  const end = meta.data_end;
  // "Today" é o último dia fechado nos arquivos. Com o job diário real, é o dia
  // que o job acabou de fechar — hoje de verdade só existiria com coleta ao longo do dia.
  const lista = [
    { id: 'today', label: 'Today', from: end, to: end },
    { id: 'yesterday', label: 'Yesterday', from: addDays(end, -1), to: addDays(end, -1) },
    { id: 'last7', label: 'Last 7 days', from: addDays(end, -6), to: end },
    { id: 'last30', label: 'Last 30 days', from: addDays(end, -29), to: end },
    { id: 'last60', label: 'Last 60 days', from: addDays(end, -59), to: end },
  ];
  // Um atalho que começaria antes do primeiro dia de dado mostraria um período
  // menor do que o nome promete. Melhor não oferecer.
  return lista.filter((p) => p.from >= meta.data_start);
}

/** A janela de comparação: o intervalo de mesmo tamanho imediatamente anterior.
    Se ela não couber inteira nos dados, não existe — comparar 30 dias contra 12
    daria uma seta de variação que parece dizer algo e não diz. */
export function compareWindow(from, to, meta) {
  const dias = daysBetween(from, to);
  const cFrom = addDays(from, -dias);
  if (cFrom < meta.data_start) return null;
  return { from: cFrom, to: addDays(from, -1), days: dias };
}

/** Prende o intervalo dentro da cobertura e desinverte início e fim trocados. */
export function clampRange(from, to, meta) {
  let f = from < meta.data_start ? meta.data_start : from;
  let t = to > meta.data_end ? meta.data_end : to;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/* -------------------------------------------------------------- tickets -- */

export function filterRows(rows, { from, to, reason }) {
  return rows.filter((r) =>
    inWindow(r.date, from, to) && (!reason || r.reason === reason));
}

/** Reúne linhas diárias num bloco só. Os arrays de duração são concatenados,
    nunca somados nem promediados — é deles que sai toda mediana. */
export function aggregate(rows) {
  const out = { created: 0, answered: 0, closed: 0, reopened: 0, frt: [], res: [] };
  for (const r of rows) {
    out.created += r.created; out.answered += r.answered;
    out.closed += r.closed;   out.reopened += r.reopened;
    if (r.frt_hours) out.frt.push(...r.frt_hours);
    if (r.resolution_hours) out.res.push(...r.resolution_hours);
  }
  return out;
}

export function ticketKpis(rows, window) {
  const a = aggregate(filterRows(rows, window));
  return {
    ...a,
    frtMedian: median(a.frt),
    frtP90: quantile(a.frt, 0.9),
    resMedian: median(a.res),
    pctUnder24: percent(countUnder(a.frt, 24), a.frt.length),
    reopenRate: percent(a.reopened, a.closed),
  };
}

/** Uma linha por dia do período, com a mediana de FRT daquele dia. */
export function byDay(rows, window) {
  const days = new Map();
  for (const r of filterRows(rows, window)) {
    if (!days.has(r.date)) days.set(r.date, { date: r.date, created: 0, answered: 0, closed: 0, reopened: 0, frt: [] });
    const d = days.get(r.date);
    d.created += r.created; d.answered += r.answered; d.closed += r.closed; d.reopened += r.reopened;
    if (r.frt_hours) d.frt.push(...r.frt_hours);
  }
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, frtMedian: median(d.frt) }));
}

/** Reagrupa as linhas de byDay em semanas de segunda a domingo. A mediana da
    semana sai do conjunto reunido de tickets, nunca da média das medianas diárias.
    Semanas cortadas pelo começo ou pelo fim do intervalo levam `days` < 7 — o
    volume delas é menor porque a semana é menor, e o tooltip precisa dizer isso. */
export function byWeek(dayRows) {
  const semanas = new Map();
  for (const d of dayRows) {
    const [y, m, dd] = d.date.split('-').map(Number);
    const desdeSegunda = (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7;
    const segunda = addDays(d.date, -desdeSegunda);
    if (!semanas.has(segunda)) {
      semanas.set(segunda, { date: segunda, days: 0, created: 0, answered: 0, closed: 0, reopened: 0, frt: [] });
    }
    const s = semanas.get(segunda);
    s.days++;
    s.created += d.created; s.answered += d.answered; s.closed += d.closed; s.reopened += d.reopened;
    s.frt.push(...d.frt);
  }
  return [...semanas.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => ({ ...s, frtMedian: median(s.frt) }));
}

/** Uma linha por motivo de contato — o eixo de comparação do portal.
    Ignora de propósito o filtro de motivo: é a tabela que compara os motivos. */
export function byReason(rows, reasons, window) {
  const acc = new Map(reasons.map((r) => [r.reason, {
    reason: r.reason, label: r.label, short: r.short_label,
    created: 0, answered: 0, closed: 0, reopened: 0, frt: [], res: [],
  }]));
  for (const r of filterRows(rows, { from: window.from, to: window.to })) {
    const a = acc.get(r.reason);
    if (!a) continue;
    a.created += r.created; a.answered += r.answered; a.closed += r.closed; a.reopened += r.reopened;
    if (r.frt_hours) a.frt.push(...r.frt_hours);
    if (r.resolution_hours) a.res.push(...r.resolution_hours);
  }
  const total = sum([...acc.values()].map((a) => a.created));
  return [...acc.values()]
    .map((a) => ({
      ...a,
      share: percent(a.created, total),
      frtMedian: median(a.frt),
      resMedian: median(a.res),
      pctUnder24: percent(countUnder(a.frt, 24), a.frt.length),
      reopenRate: percent(a.reopened, a.closed),
    }))
    .sort((a, b) => b.created - a.created);
}

/* ------------------------------------------------------ dinheiro / loja -- */

export function revenueIn(revenue, from, to) {
  const rows = revenue.filter((r) => inWindow(r.date, from, to));
  return {
    revenue: sum(rows.map((r) => r.revenue_usd)),
    orders: sum(rows.map((r) => r.orders)),
    days: rows.length,
  };
}

export function refundsIn(refunds, from, to) {
  const rows = refunds.filter((r) => inWindow(r.refunded_at, from, to));
  const total = sum(rows.map((r) => r.amount_usd));
  const partial = rows.filter((r) => r.refund_type === 'partial').length;
  return {
    rows, count: rows.length, total,
    average: rows.length ? total / rows.length : null,
    partialShare: percent(partial, rows.length),
    byReason: groupCount(rows, 'reason', 'amount_usd'),
  };
}

export function replacementsIn(replacements, from, to) {
  const rows = replacements.filter((r) => inWindow(r.created_at, from, to));
  const supplier = sum(rows.map((r) => r.supplier_cost_usd));
  const shipping = sum(rows.map((r) => r.shipping_cost_usd));
  return {
    rows, count: rows.length,
    supplier, shipping, total: supplier + shipping,
    repeats: rows.filter((r) => r.is_second_replacement).length,
    byReason: groupCount(rows, 'reason'),
  };
}

/** Taxa de reembolso é DINHEIRO SOBRE DINHEIRO: valor devolvido ÷ receita da
    mesma janela. Nunca reembolsos ÷ tickets — é para isso que revenue.json existe. */
export function refundRate(refunds, revenue, from, to) {
  return percent(refundsIn(refunds, from, to).total, revenueIn(revenue, from, to).revenue);
}

function groupCount(rows, key, moneyKey) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] ?? 'desconhecido';
    if (!m.has(k)) m.set(k, { key: k, count: 0, amount: 0 });
    const g = m.get(k);
    g.count++;
    if (moneyKey) g.amount += r[moneyKey] ?? 0;
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/* ---------------------------------------------------------- chargebacks -- */

const PENDING = new Set(['open', 'under_review']);
const DECIDED = new Set(['won', 'lost', 'accepted']);

/** Quantos ENTRARAM no período — é a única base da taxa de chargeback. */
export function chargebacksOpenedIn(chargebacks, from, to) {
  const rows = chargebacks.filter((c) => inWindow(c.opened_at, from, to));
  return { rows, count: rows.length, amount: sum(rows.map((c) => c.amount_usd)) };
}

/** A taxa que as bandeiras olham é CONTAGEM ÷ PEDIDOS, não valor ÷ receita.
    É essa que decide se a conta entra em programa de monitoramento. */
export function chargebackRate(chargebacks, revenue, from, to) {
  return percent(
    chargebacksOpenedIn(chargebacks, from, to).count,
    revenueIn(revenue, from, to).orders);
}

/** Onde as disputas estão AGORA — varre todas as linhas, ignorando o período.
    Uma disputa aberta antes da semana e ainda indecisa é dinheiro em risco hoje;
    limitá-la à semana relatada seria reportá-la como se tivesse se resolvido. */
export function chargebackStanding(chargebacks) {
  const by = (s) => chargebacks.filter((c) => c.status === s);
  const pending = chargebacks.filter((c) => PENDING.has(c.status));
  const decided = chargebacks.filter((c) => DECIDED.has(c.status));
  const won = by('won'), lost = by('lost'), accepted = by('accepted');
  return {
    pending, decided, won, lost, accepted,
    pendingAmount: sum(pending.map((c) => c.amount_usd)),
    wonAmount: sum(won.map((c) => c.amount_usd)),
    lostAmount: sum([...lost, ...accepted].map((c) => c.amount_usd)),
    // A taxa é cobrada dê no que der e não volta numa vitória. Somar só os
    // perdidos subestimaria o custo em uma taxa por caso.
    fees: sum(chargebacks.map((c) => c.fee_usd)),
    winRate: percent(won.length, decided.length),
    byReason: groupCount(chargebacks, 'reason', 'amount_usd'),
    byNetwork: groupCount(chargebacks, 'network', 'amount_usd'),
  };
}

export function ageInHours(fromStamp, toStamp) {
  return (new Date(toStamp) - new Date(fromStamp)) / 36e5;
}

/* -------------------------------------------------------------- agentes -- */

export function agentStats(queue) {
  return (queue.agents ?? [])
    .map((a) => ({
      ...a,
      frtMedian: median(a.frt_hours),
      over24: (a.frt_hours ?? []).filter((h) => h >= 24).length,
      reopenRate: percent(a.reopened, a.closed),
    }))
    .sort((a, b) => b.answered - a.answered);
}

/** Reembolsos concedidos por atendente saem de refunds.json, não de queue.json —
    assim a tabela de agentes e os cartões de reembolso não têm como discordar. */
export function refundsByAgent(refunds, from, to) {
  const m = new Map();
  for (const r of refunds) {
    if (!inWindow(r.refunded_at, from, to) || !r.agent_id) continue;
    m.set(r.agent_id, (m.get(r.agent_id) ?? 0) + 1);
  }
  return m;
}

/* ---------------------------------------------------------------- metas -- */

/** 'good' | 'warn' | 'crit' — de que lado do alvo o número caiu. */
export function goalStatus(value, target) {
  if (value == null || !target) return 'none';
  const higher = target.direction === 'higher_is_better';
  if (higher) {
    if (value >= target.goal) return 'good';
    return value >= target.warning ? 'warn' : 'crit';
  }
  if (value <= target.goal) return 'good';
  return value <= target.warning ? 'warn' : 'crit';
}

/** A variação contra a janela de comparação, já sabendo de que lado é bom.
    Fila caindo é verde porque fila é lower_is_better. */
export function change(current, previous, direction = 'lower_is_better') {
  if (current == null || previous == null) return { delta: null, pct: null, tone: 'flat' };
  const delta = current - previous;
  const pct = previous ? (delta / Math.abs(previous)) * 100 : null;
  const better = direction === 'higher_is_better' ? delta > 0 : delta < 0;
  const tone = Math.abs(delta) < 1e-9 ? 'flat' : (better ? 'good' : 'bad');
  return { delta, pct, tone };
}
