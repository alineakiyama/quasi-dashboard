/* =========================================================================
   A CAMADA DE DADOS. É o único arquivo do projeto que busca alguma coisa.

   Todo o resto — metrics.js, charts.js, as cinco telas, app.js — recebe o
   objeto que loadData() devolve e nunca alcança nada além dele. A interface
   está acoplada a um FORMATO, não a uma fonte.

   É isso que faz a Fase 2 não encostar na interface: quando um job passar a
   escrever data/*.json com números reais da API do Commslayer e da Shopify,
   nenhum arquivo daqui muda. Se em vez de arquivos a fonte virar um endpoint,
   só a tabela SOURCES abaixo troca caminho por URL.
   ========================================================================= */

const SOURCES = {
  meta:         'meta.json',
  reasons:      'reasons.json',
  tickets:      'tickets-daily.json',
  queue:        'queue.json',
  refunds:      'refunds.json',
  replacements: 'replacements.json',
  revenue:      'revenue.json',
  chargebacks:  'chargebacks.json',
  plans:        'action-plans.json',
};

// Resolvido contra este módulo, não contra a raiz do documento: é o que faz o
// site funcionar igual em example.github.io/quasi-portal/ e na raiz de um servidor.
const base = new URL('../data/', import.meta.url);

async function grab(file) {
  const url = new URL(file, base);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not fetch ${file}. If you opened index.html by double-clicking it, ` +
      `that is why: browsers block fetch() on file://. Serve it over HTTP. (${err.message})`);
  }
  if (!res.ok) throw new Error(`${file} answered ${res.status}.`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${file} is not valid JSON. (${err.message})`);
  }
}

/* ------------------------------------------------------------------------ */

export async function loadData() {
  const names = Object.keys(SOURCES);
  const files = await Promise.all(names.map((n) => grab(SOURCES[n])));
  const raw = Object.fromEntries(names.map((n, i) => [n, files[i]]));
  return normalize(raw);
}

/* Achata os envelopes e checa o que a página tem como saber checar.
   Nunca lança por inconsistência de conteúdo: um feed meio quebrado ainda
   mostra o que dá, com o aviso visível. Só formato ausente é erro fatal. */
function normalize(raw) {
  const warnings = [];

  const meta = raw.meta;
  const reasons = raw.reasons.reasons ?? [];
  const rows = raw.tickets.rows ?? [];
  const queue = raw.queue;
  const refunds = raw.refunds.refunds ?? [];
  const replacements = raw.replacements.replacements ?? [];
  const revenue = raw.revenue.rows ?? [];
  const chargebacks = raw.chargebacks.chargebacks ?? [];
  const plans = raw.plans.plans ?? [];

  const reasonById = new Map(reasons.map((r) => [r.reason, r]));

  // 1. Os arrays de duração carregam um valor por ticket. Se o tamanho não bate
  //    com a contagem, alguma mediana da página está sendo calculada sobre um
  //    conjunto que não é o que a contagem diz.
  let badArrays = 0;
  for (const r of rows) {
    if ((r.frt_hours?.length ?? 0) !== r.answered) badArrays++;
    else if ((r.resolution_hours?.length ?? 0) !== r.closed) badArrays++;
  }
  if (badArrays) {
    warnings.push(`${badArrays} row(s) in tickets-daily.json carry duration arrays whose length ` +
      `does not match the count. The medians for those rows describe a different set of tickets ` +
      `than the count claims.`);
  }

  // 2. As faixas de idade particionam o backlog — se não somam, o gráfico de
  //    fila por idade está descrevendo uma fila que não existe.
  const ag = queue.summary?.aging;
  if (ag) {
    const soma = (ag.under_24h ?? 0) + (ag.h24_to_72h ?? 0) + (ag.over_72h ?? 0);
    if (soma !== queue.summary.backlog) {
      warnings.push(`The queue age buckets add up to ${soma}, but the backlog is ` +
        `${queue.summary.backlog}. They are supposed to partition it.`);
    }
  }

  // 3. A soma dos agentes tem que fechar com o dia do snapshot, senão a tabela
  //    por atendente e o total do dia contam coisas diferentes.
  const somaAgentes = (queue.agents ?? []).reduce((t, a) => t + (a.answered ?? 0), 0);
  if (somaAgentes !== queue.summary?.answered_today) {
    warnings.push(`The agents add up to ${somaAgentes} answered, but the snapshot says ` +
      `${queue.summary?.answered_today}.`);
  }

  // 4. Nenhum motivo pode aparecer sem estar no registro.
  const orfaos = new Set();
  for (const r of rows) if (!reasonById.has(r.reason)) orfaos.add(r.reason);
  for (const r of queue.by_reason ?? []) if (!reasonById.has(r.reason)) orfaos.add(r.reason);
  if (orfaos.size) {
    warnings.push(`Reasons present in the data but missing from reasons.json: ${[...orfaos].join(', ')}.`);
  }

  if (warnings.length) for (const w of warnings) console.warn('[dados]', w);

  return {
    meta, reasons, reasonById, rows, queue,
    refunds, replacements, revenue, chargebacks, plans,
    // O instante em que o status de cada disputa era verdade. Fica no envelope
    // de chargebacks.json, não em meta.json, porque é a idade das disputas que
    // ele data — não o período do relatório.
    chargebackSnapshot: raw.chargebacks.snapshot_at ?? queue.snapshot_at,
    warnings,
  };
}
