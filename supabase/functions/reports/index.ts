/**
 * reports — entrega os relatórios do Commslayer para o dashboard.
 *
 *   GET /functions/v1/reports?from=2026-09-10&to=2026-09-16
 *       &compare_from=2026-09-03&compare_to=2026-09-09
 *       &business_hours=false&reports=overview,agents,csat
 *
 * Por que existe:
 *  · O token do Commslayer não pode ir para o navegador. Ele mora nos segredos
 *    do Supabase e só esta função o usa.
 *  · Cada relatório do Commslayer leva 2–4 s. A função guarda cada resposta em
 *    public.report_cache e entrega do cache enquanto estiver fresca; pedidos
 *    idênticos ao mesmo tempo compartilham a mesma chamada.
 *  · Os números são de um cliente real. Só responde para usuário logado.
 *
 * Os relatórios são devolvidos exatamente como o Commslayer manda (o `data` de
 * cada resposta), para o dashboard mostrar os mesmos números do portal.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const COMMSLAYER = 'https://app.commslayer.com/api/integration/v1';
const RELATORIOS = ['overview', 'agents', 'csat', 'inboxes', 'labels'] as const;
type Relatorio = typeof RELATORIOS[number];

// O CSAT do Commslayer não aceita horário comercial; mandar o parâmetro para ele
// só criaria entradas de cache duplicadas com o mesmo conteúdo.
const ACEITA_HORARIO_COMERCIAL = new Set<Relatorio>(['overview', 'agents', 'inboxes', 'labels']);

const ORIGENS_PERMITIDAS = new Set([
  'https://alineakiyama.github.io',
  'http://localhost:8125',
]);

// O Commslayer fecha os dias no fuso da conta, e as datas que ele devolve vêm
// em -04:00: Nova York. "Hoje" precisa ser o hoje de lá, senão o cache trata
// como fechado um dia que para o Commslayer ainda está aberto.
const FUSO = 'America/New_York';
const TTL_FORCADO_MS = 60 * 1000;              // "Refresh" nunca bate no Commslayer mais de 1x/min por período
const TTL_COM_HOJE_MS = 60 * 1000;            // período que inclui hoje ainda está mudando; a tela atualiza a cada minuto
const TTL_FECHADO_MS = 6 * 60 * 60 * 1000;     // dia fechado quase não muda (CSAT chega atrasado)
const MAX_DIAS = 400;
const TIMEOUT_MS = 25_000;

const TOKEN = Deno.env.get('COMMSLAYER_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const CHAVE_SERVICO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  ?? (() => { try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? ''; } catch { return ''; } })();

const admin = createClient(SUPABASE_URL, CHAVE_SERVICO, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ------------------------------------------------------------- utilidades */

function cors(origem: string | null): Record<string, string> {
  const permitida = origem && ORIGENS_PERMITIDAS.has(origem) ? origem : 'https://alineakiyama.github.io';
  return {
    'Access-Control-Allow-Origin': permitida,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(corpo: unknown, status: number, origem: string | null): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors(origem), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const dataValida = (s: string | null): s is string => !!s && DATA.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
const hojeNoFuso = () => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());

/* ------------------------------------------------------------------ cache */

type Entrada = { payload: unknown; fetched_at: string; cached: boolean; stale: boolean };

// Pedidos idênticos que chegam enquanto a primeira chamada ainda está no ar
// esperam por ela, em vez de dispararem outra ao Commslayer.
const emAndamento = new Map<string, Promise<Entrada>>();

async function lerCache(chave: string) {
  const { data, error } = await admin.from('report_cache').select('payload, fetched_at').eq('key', chave).maybeSingle();
  if (error) console.error('cache: leitura falhou', error.message);
  return data as { payload: unknown; fetched_at: string } | null;
}

async function gravarCache(chave: string, relatorio: string, payload: unknown) {
  const { error } = await admin.from('report_cache').upsert({ key: chave, report: relatorio, payload, fetched_at: new Date().toISOString() });
  if (error) console.error('cache: gravação falhou', error.message);
}

async function buscarCommslayer(relatorio: Relatorio, q: URLSearchParams): Promise<unknown> {
  const res = await fetch(`${COMMSLAYER}/reports/${relatorio}?${q}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Commslayer respondeu ${res.status} em /reports/${relatorio}`);
  const corpo = await res.json();
  // O Commslayer embrulha tudo num `data` externo; o que interessa está dentro.
  return corpo?.data ?? corpo;
}

async function relatorio(relatorio: Relatorio, p: Periodo): Promise<Entrada> {
  const q = new URLSearchParams({ from_date: p.from, to_date: p.to });
  if (p.compareFrom && p.compareTo) {
    q.set('compare_from_date', p.compareFrom);
    q.set('compare_to_date', p.compareTo);
  }
  if (ACEITA_HORARIO_COMERCIAL.has(relatorio)) q.set('business_hours', String(p.businessHours));

  const chave = `${relatorio}?${q}`;
  const ttl = p.refresh ? TTL_FORCADO_MS : (p.to >= hojeNoFuso() ? TTL_COM_HOJE_MS : TTL_FECHADO_MS);

  const guardado = await lerCache(chave);
  const idade = guardado ? Date.now() - Date.parse(guardado.fetched_at) : Infinity;
  if (guardado && idade < ttl) {
    return { payload: guardado.payload, fetched_at: guardado.fetched_at, cached: true, stale: false };
  }

  if (!emAndamento.has(chave)) {
    emAndamento.set(chave, (async () => {
      try {
        const payload = await buscarCommslayer(relatorio, q);
        await gravarCache(chave, relatorio, payload);
        return { payload, fetched_at: new Date().toISOString(), cached: false, stale: false };
      } catch (err) {
        // Commslayer fora do ar: melhor um número um pouco velho, sinalizado,
        // do que uma tela vazia.
        if (guardado) {
          console.error(`${chave}: usando cache vencido —`, (err as Error).message);
          return { payload: guardado.payload, fetched_at: guardado.fetched_at, cached: true, stale: true };
        }
        throw err;
      } finally {
        emAndamento.delete(chave);
      }
    })());
  }
  return await emAndamento.get(chave)!;
}

/* ---------------------------------------------------------------- handler */

type Periodo = { from: string; to: string; compareFrom?: string; compareTo?: string; businessHours: boolean; refresh: boolean };

Deno.serve(async (req) => {
  const origem = req.headers.get('Origin');

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, origem);

  if (!TOKEN || !CHAVE_SERVICO) return json({ error: 'Função sem configuração no servidor.' }, 500, origem);

  // Só usuário logado. A chave pública sozinha não basta: ela está no código do site.
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Faça login para ver os relatórios.' }, 401, origem);
  const { data: auth, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ error: 'Sessão inválida ou expirada. Entre de novo.' }, 401, origem);

  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const compareFrom = url.searchParams.get('compare_from');
  const compareTo = url.searchParams.get('compare_to');

  if (!dataValida(from) || !dataValida(to)) return json({ error: 'from e to precisam ser datas AAAA-MM-DD.' }, 400, origem);
  if (from > to) return json({ error: 'from é depois de to.' }, 400, origem);
  if (dias(from, to) > MAX_DIAS) return json({ error: `Período máximo: ${MAX_DIAS} dias.` }, 400, origem);
  if ((compareFrom || compareTo) && !(dataValida(compareFrom) && dataValida(compareTo) && compareFrom <= compareTo)) {
    return json({ error: 'compare_from e compare_to precisam vir juntos, como datas válidas.' }, 400, origem);
  }

  const pedidos = (url.searchParams.get('reports') ?? RELATORIOS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const invalidos = pedidos.filter((r) => !(RELATORIOS as readonly string[]).includes(r));
  if (invalidos.length) return json({ error: `Relatório desconhecido: ${invalidos.join(', ')}` }, 400, origem);

  const periodo: Periodo = {
    from, to,
    compareFrom: compareFrom ?? undefined,
    compareTo: compareTo ?? undefined,
    businessHours: url.searchParams.get('business_hours') === 'true',
    refresh: url.searchParams.get('refresh') === '1',
  };

  const resultados = await Promise.allSettled(pedidos.map((r) => relatorio(r as Relatorio, periodo)));

  const reports: Record<string, Entrada> = {};
  const errors: Record<string, string> = {};
  resultados.forEach((res, i) => {
    if (res.status === 'fulfilled') reports[pedidos[i]] = res.value;
    else errors[pedidos[i]] = (res.reason as Error)?.message ?? 'erro desconhecido';
  });

  return json({ generated_at: new Date().toISOString(), period: periodo, reports, errors }, 200, origem);
});
