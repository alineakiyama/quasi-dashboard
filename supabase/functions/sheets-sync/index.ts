/**
 * sheets-sync — recebe uma aba da "Quasi — Master Tracking Spreadsheet" e
 * espelha no banco.
 *
 * Quem chama é o script instalado na própria planilha (tools/apps-script),
 * com o segredo SHEETS_SYNC_SECRET no cabeçalho x-sync-secret.
 *
 *   POST { tab, sheet_name, header_row, headers: [...], rows: [{ n, v: [...] }], sheet_stats }
 *
 * O que ela faz, nesta ordem:
 *  1. Se o conteúdo da aba é idêntico ao da última sincronização, só registra
 *     a conferência e sai — nada é gravado.
 *  2. Converte cada linha: números de pedido limpos, valores e porcentagens
 *     como número, datas em AAAA-MM-DD (corrigindo dia/mês trocado nos
 *     reembolsos), motivos de cancelamento agrupados.
 *  3. Grava as linhas numa área de preparo e aplica tudo numa transação:
 *     insere o que é novo, apaga o que saiu da planilha, atualiza o número
 *     da linha do que foi movido.
 *
 * Proteção: se chegarem muito menos linhas do que já existem (planilha lida
 * pela metade, aba errada), a sincronização é recusada em vez de apagar dados.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const SEGREDO = Deno.env.get('SHEETS_SYNC_SECRET') ?? '';
const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const MAX_LINHAS = 80_000;
const BLOCO = 500;

/* ----------------------------------------------------------- utilidades -- */

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação que leva o mesmo tempo acerte ou erre, para o segredo não vazar por tempo de resposta. */
async function segredoConfere(recebido: string): Promise<boolean> {
  if (!SEGREDO || !recebido) return false;
  const [a, b] = await Promise.all([sha256(recebido), sha256(SEGREDO)]);
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

const normCab = (s: unknown) =>
  String(s ?? '').replace(/\\#/g, '#').replace(/[?:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const texto = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Número de pedido: tira "#", espaços e o ".0" que números viram ao passar pela planilha. */
function pedido(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return String(Math.trunc(v));
  const s = String(v).trim().replace(/^#\s*/, '').replace(/\.0+$/, '');
  return s === '' ? null : s;
}

function dinheiro(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;   // sem arredondar: a soma tem que bater com o SUM() da planilha
  const s = texto(v);
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 0.2, 20, "20%" e "100%%" viram todos 0.2 / 1.0. */
function porcentagem(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else {
    const s = texto(v);
    if (!s) return null;
    const temPct = s.includes('%');
    n = Number(s.replace(/[%\s]/g, ''));
    if (!Number.isFinite(n)) return null;
    if (temPct) n = n / 100;
  }
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n = n / 100;
  return Math.round(n * 10000) / 10000;
}

const diaValido = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Aceita AAAA-MM-DD (o que o script manda para células de data), número serial
    do Sheets e texto tipo 9/17/2026. Sem certeza, assume mês/dia (padrão EUA). */
function data(v: unknown): string | null {
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10);
  }
  const s = texto(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return diaValido(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    const [mes, dia] = a > 12 ? [b, a] : [a, b];
    return diaValido(y, mes, dia) ? iso(y, mes, dia) : null;
  }
  return null;
}

/* ---------------------------------------- motivos de cancelamento, agrupados -- */
// Cobre as 43 variações encontradas na aba (incluindo erros de digitação).
// A ordem importa: a primeira regra que casar vence.
const GRUPOS_CANCELAMENTO: Array<[string, RegExp]> = [
  ['No reason given', /^\s*$|no reason/i],
  ["Didn't mean to subscribe", /accident|unaware|not subscribe knowingly|mistaken|wrong item/i],
  ['Only wanted one purchase', /one time|1 time|1 pack|want(ed)? to try|try first|will reorder/i],
  ["Can't afford", /afford|financ|job|lost job/i],
  ['Too many products', /too many|dont need|don't need/i],
  ["Didn't like the product", /did not like|not work|didn.t like/i],
  ['Allergic reaction', /allerg/i],
  ['Unhappy with renewal charge', /renewal|2nd charge|second charge/i],
  ['Late delivery', /delay|late deliver/i],
  ['Personal circumstances', /travel|leaving|personal|medical|unforeseen/i],
  ["Doesn't want a subscription", /want.*subscription|wish to continue/i],
];
const grupoCancelamento = (motivo: string | null) =>
  (GRUPOS_CANCELAMENTO.find(([, re]) => re.test(motivo ?? '')) ?? ['Other'])[0];

const MOTIVO_REEMBOLSO: Record<string, string> = {
  'unware about subscription': 'Unaware about subscription',
  'damage item': 'Damaged item',
};
const limparMotivoReembolso = (v: unknown) => {
  const s = texto(v);
  return s ? (MOTIVO_REEMBOLSO[s.toLowerCase()] ?? s) : null;
};

/* ------------------------------------------------------------- as abas -- */

type Linha = { n: number; v: unknown[] };
type Registro = Record<string, unknown> & { issues: string[] };
type Aba = {
  colunas: Record<string, string[]>;          // campo -> cabeçalhos aceitos
  obrigatorias: string[];                     // sem elas, a aba não sincroniza
  montar: (get: (campo: string) => unknown) => Registro;
  depois?: (regs: Array<Registro & { row_number: number }>) => void;
};

const ABAS: Record<string, Aba> = {
  refunds: {
    colunas: {
      order_number: ['order number', 'order #', 'order'],
      refund_date: ['refund date'],
      reason: ['reason for refund', 'reason'],
      resolution: ['resolution'],
      total_amount: ['total amount'],
      refund_pct: ['refund %', 'refund percent'],
      refunded_amount: ['refunded amount'],
      ticket_link: ['ticket link'],
      refund_status: ['refund status'],
      subscription_status: ['subscription status'],
    },
    obrigatorias: ['order_number', 'refund_date', 'refunded_amount'],
    montar(get) {
      const total = dinheiro(get('total_amount'));
      const reembolsado = dinheiro(get('refunded_amount'));
      const pct = porcentagem(get('refund_pct'));
      const resolucao = texto(get('resolution'));
      const bruto = texto(get('refund_date'));
      const dt = data(get('refund_date'));

      let tipo: string | null = null;
      if (pct != null) tipo = pct >= 0.999 ? 'full' : 'partial';
      else if (total != null && reembolsado != null) tipo = reembolsado >= total - 0.01 ? 'full' : 'partial';
      else if (/partial/i.test(resolucao ?? '')) tipo = 'partial';
      else if (/^refund$/i.test(resolucao ?? '')) tipo = 'full';

      const issues: string[] = [];
      const numPedido = pedido(get('order_number'));
      if (!numPedido) issues.push('missing order number');
      if (!bruto) issues.push('no refund date');
      else if (!dt) issues.push(`unreadable refund date "${bruto}"`);
      if (reembolsado == null) issues.push('no refunded amount');
      if (total != null && reembolsado != null && reembolsado > total + 0.01) issues.push('refunded more than the order total');

      return {
        order_number: numPedido,
        refund_date: dt,
        refund_date_raw: bruto,
        date_corrected: false,
        reason: limparMotivoReembolso(get('reason')),
        resolution: resolucao,
        refund_type: tipo,
        total_amount: total,
        refund_pct: pct,
        refunded_amount: reembolsado,
        ticket_link: texto(get('ticket_link')),
        refund_status: texto(get('refund_status')),
        subscription_status: texto(get('subscription_status')),
        issues,
      };
    },
    // A aba é preenchida em ordem cronológica. Uma data ambígua (dia ≤ 12) que
    // destoa das vizinhas sem ambiguidade, e ficaria perto delas com dia e mês
    // trocados, foi digitada invertida — ex.: 08/07 escrito como 07/08.
    depois(regs) {
      const dia = (s: string) => Date.parse(`${s}T00:00:00Z`) / 864e5;
      const hojeNY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const certas = regs.map((r) => {
        const s = r.refund_date as string | null;
        return s && +s.slice(8, 10) > 12 ? dia(s) : null;
      });
      regs.forEach((r, i) => {
        const s = r.refund_date as string | null;
        if (!s) return;
        const d = +s.slice(8, 10), m = +s.slice(5, 7);
        if (d > 12 || d === m) return;
        const viz: number[] = [];
        for (let j = Math.max(0, i - 60); j <= Math.min(regs.length - 1, i + 60); j++) {
          if (j !== i && certas[j] != null) viz.push(certas[j]!);
        }
        if (viz.length < 3) return;
        viz.sort((a, b) => a - b);
        const mediana = viz[viz.length >> 1];
        const trocada = iso(+s.slice(0, 4), d, m);
        // Reembolso não acontece no futuro: se só a versão trocada já passou, é ela.
        const futura = s > hojeNY && trocada <= hojeNY;
        if (futura || Math.abs(dia(trocada) - mediana) + 3 < Math.abs(dia(s) - mediana)) {
          r.refund_date = trocada;
          r.date_corrected = true;
        }
      });
    },
  },

  subscriptions: {
    colunas: {
      entry_date: ['date'],
      email: ['customer email', 'email'],
      management: ['management'],
      reason_raw: ['reason'],
      requests: ['requests'],
      completed: ['completed'],
      outcome: ['subscription'],
    },
    obrigatorias: ['email', 'management'],
    montar(get) {
      const email = texto(get('email'))?.toLowerCase() ?? null;
      const motivo = texto(get('reason_raw'));
      const issues: string[] = [];
      if (!email) issues.push('missing customer email');
      return {
        entry_date: data(get('entry_date')),
        email,
        management: texto(get('management')),
        reason_raw: motivo,
        reason_group: grupoCancelamento(motivo),
        requests: texto(get('requests')),
        completed: texto(get('completed')),
        outcome: texto(get('outcome')),
        issues,
      };
    },
  },

  reshipments: {
    colunas: {
      entry_date: ['date'],
      agent: ['agent name', 'agent'],
      order_number: ['order #', 'order number'],
      reason: ['reason'],
      description: ['description'],
      customer_request: ['customer request'],
      new_order_number: ['new order #', 'new order number'],
      status: ['status'],
      messaged: ['messaged customer'],
    },
    obrigatorias: ['order_number', 'reason', 'status'],
    montar(get) {
      const numPedido = pedido(get('order_number'));
      const issues: string[] = [];
      if (!numPedido) issues.push('missing order number');
      return {
        entry_date: data(get('entry_date')),
        agent: texto(get('agent')),
        order_number: numPedido,
        reason: texto(get('reason')),
        description: texto(get('description')),
        customer_request: texto(get('customer_request')),
        new_order_number: pedido(get('new_order_number')),
        status: texto(get('status')),
        messaged: texto(get('messaged')),
        issues,
      };
    },
  },

  supplier_issues: {
    colunas: {
      entry_date: ['date'],
      agent: ['agent name', 'agent'],
      order_number: ['order #', 'order number'],
      reason: ['reason'],
      description: ['description'],
      reshipment_tracking: ['reshipment tracking'],
      status: ['status'],
    },
    obrigatorias: ['order_number', 'reason'],
    montar(get) {
      const numPedido = pedido(get('order_number'));
      const issues: string[] = [];
      if (!numPedido) issues.push('missing order number');
      return {
        entry_date: data(get('entry_date')),
        agent: texto(get('agent')),
        order_number: numPedido,
        reason: texto(get('reason')),
        description: texto(get('description')),
        reshipment_tracking: texto(get('reshipment_tracking')),
        status: texto(get('status')),
        issues,
      };
    },
  },
};

/* ------------------------------------------------------------- handler -- */

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!(await segredoConfere(req.headers.get('x-sync-secret') ?? ''))) return json({ error: 'Invalid sync secret.' }, 401);

  let corpo: { tab?: string; sheet_name?: string; headers?: unknown[]; rows?: Linha[]; sheet_stats?: unknown };
  try { corpo = await req.json(); } catch { return json({ error: 'Body is not JSON.' }, 400); }

  const aba = ABAS[corpo.tab ?? ''];
  if (!aba) return json({ error: `Unknown tab "${corpo.tab}".` }, 400);
  if (!Array.isArray(corpo.headers) || !Array.isArray(corpo.rows)) return json({ error: 'headers and rows are required.' }, 400);
  if (corpo.rows.length > MAX_LINHAS) return json({ error: `Too many rows (${corpo.rows.length}).` }, 413);

  const tab = corpo.tab!;
  const hash = await sha256(JSON.stringify([corpo.headers, corpo.rows]));

  // 1. Nada mudou desde a última vez: só marca a conferência.
  const { data: ultima } = await db.from('sheet_sync_runs')
    .select('id, content_hash').eq('tab', tab).eq('ok', true).order('id', { ascending: false }).limit(1).maybeSingle();
  if (ultima?.content_hash === hash) {
    await db.from('sheet_sync_runs').update({ finished_at: new Date().toISOString() }).eq('id', ultima.id);
    return json({ ok: true, unchanged: true });
  }

  const { data: run, error: runErr } = await db.from('sheet_sync_runs').insert({
    tab, sheet_name: corpo.sheet_name ?? null, content_hash: hash,
    rows_received: corpo.rows.length, sheet_stats: corpo.sheet_stats ?? null,
  }).select('id').single();
  if (runErr || !run) return json({ error: `Could not start the run: ${runErr?.message}` }, 500);

  const falhar = async (msg: string, status = 422) => {
    await db.from('sheet_sync_staging').delete().eq('run_id', run.id);
    await db.from('sheet_sync_runs').update({ ok: false, error: msg, finished_at: new Date().toISOString() }).eq('id', run.id);
    return json({ ok: false, error: msg }, status);
  };

  try {
    // 2. Onde está cada campo nesta aba.
    const cab = corpo.headers.map(normCab);
    const indice: Record<string, number> = {};
    for (const [campo, nomes] of Object.entries(aba.colunas)) {
      indice[campo] = cab.findIndex((h) => nomes.includes(h));
    }
    const faltando = aba.obrigatorias.filter((c) => indice[c] < 0);
    if (faltando.length) {
      return await falhar(`Column not found in the sheet: ${faltando.map((c) => aba.colunas[c][0]).join(', ')}. Was it renamed?`);
    }

    // Proteção contra apagar tudo por uma leitura incompleta da planilha.
    const tabela = { refunds: 'sheet_refunds', subscriptions: 'sheet_subscriptions', reshipments: 'sheet_reshipments', supplier_issues: 'sheet_supplier_issues' }[tab]!;
    const { count: atuais } = await db.from(tabela).select('row_key', { count: 'exact', head: true });
    if ((atuais ?? 0) > 50 && corpo.rows.length < (atuais ?? 0) * 0.5) {
      return await falhar(`Refused: the sheet sent ${corpo.rows.length} rows but the portal has ${atuais}. Nothing was deleted.`);
    }

    // 3. Linhas convertidas, com chave pelo conteúdo (+ ocorrência, para linhas idênticas).
    const agora = new Date().toISOString();
    const vistos = new Map<string, number>();
    const registros: Array<Registro & { row_key: string; row_number: number }> = [];
    for (const linha of corpo.rows) {
      const get = (campo: string) => (indice[campo] >= 0 ? linha.v?.[indice[campo]] : null);
      const base = await sha256(JSON.stringify(linha.v ?? []));
      const n = (vistos.get(base) ?? 0) + 1;
      vistos.set(base, n);
      registros.push({ ...aba.montar(get), row_key: `${base.slice(0, 40)}:${n}`, row_number: Number(linha.n) });
    }
    registros.sort((a, b) => a.row_number - b.row_number);
    aba.depois?.(registros);

    // 4. Só as linhas que o portal ainda não tem vão para a área de preparo; as
    //    que já existem seguem apenas como chave. Numa edição comum em uma aba de
    //    25 mil linhas, isso é 1 linha preparada em vez de 25 mil.
    const { data: chavesAtuais, error: chavesErr } = await db.rpc('sheet_keys', { p_tab: tab });
    if (chavesErr) return await falhar(`Could not read current keys: ${chavesErr.message}`, 500);
    const existentes = new Set<string>(chavesAtuais ?? []);
    const novos = registros.filter((r) => !existentes.has(r.row_key));

    for (let i = 0; i < novos.length; i += BLOCO) {
      const bloco = novos.slice(i, i + BLOCO).map((r) => ({
        run_id: run.id, row_key: r.row_key, row_number: r.row_number,
        rec: { ...r, synced_at: agora },
      }));
      const { error } = await db.from('sheet_sync_staging').insert(bloco);
      if (error) return await falhar(`Staging failed: ${error.message}`, 500);
    }

    const { data: resultado, error: commitErr } = await db.rpc('sheet_sync_commit', {
      p_run: run.id, p_tab: tab, p_keys: registros.map((r) => [r.row_key, r.row_number]),
    });
    if (commitErr) return await falhar(`Apply failed: ${commitErr.message}`, 500);

    await db.from('sheet_sync_runs').update({
      ok: true, finished_at: new Date().toISOString(),
      inserted: resultado.inserted, updated: resultado.updated, deleted: resultado.deleted, rows_stored: resultado.stored,
    }).eq('id', run.id);

    // Limpeza de preparos abandonados por execuções que falharam no meio.
    const { data: falhas } = await db.from('sheet_sync_runs').select('id').eq('ok', false).limit(50);
    if (falhas?.length) await db.from('sheet_sync_staging').delete().in('run_id', falhas.map((f) => f.id));

    return json({ ok: true, ...resultado, corrected_dates: registros.filter((r) => r.date_corrected).length,
      rows_with_issues: registros.filter((r) => r.issues.length).length });
  } catch (err) {
    return await falhar(`Unexpected error: ${(err as Error).message}`, 500);
  }
});
