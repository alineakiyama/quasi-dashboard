/**
 * commslayer-events — guarda os auto-labels de cada ticket do Commslayer.
 *
 *   POST /functions/v1/commslayer-events?k=CHAVE                 aviso do webhook
 *   POST /functions/v1/commslayer-events?k=CHAVE&action=reconcile  conferência (a cada 10 min)
 *   POST /functions/v1/commslayer-events?k=CHAVE&action=setup      cria o webhook no Commslayer
 *
 * A chave (segredo CL_EVENTS_KEY) vai na URL cadastrada no Commslayer; sem ela,
 * nada é aceito. Só são guardados id, datas, status, labels e contact reason —
 * nada de cliente nem de mensagem.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const COMMSLAYER = 'https://app.commslayer.com/api/integration/v1';
const TOKEN = Deno.env.get('COMMSLAYER_TOKEN') ?? '';
const CHAVE = Deno.env.get('CL_EVENTS_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const CHAVE_SERVICO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  ?? (() => { try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? ''; } catch { return ''; } })();

const EVENTOS = ['conversation_created', 'conversation_updated', 'conversation_status_changed'];
const JANELA_CONFERENCIA_MS = 3 * 60 * 60 * 1000;   // confere os tickets das últimas 3 h
const MAX_PAGINAS = 8;                               // 800 tickets: folga para 3 h com 3 mil/dia

const admin = createClient(SUPABASE_URL, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

function iguais(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function api(caminho: string, init: RequestInit = {}) {
  const res = await fetch(COMMSLAYER + caminho, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(25_000),
  });
  const texto = await res.text();
  let corpo: any = null;
  try { corpo = JSON.parse(texto); } catch { corpo = null; }
  return { status: res.status, corpo };
}

async function estado(k: string, v: unknown) {
  await admin.from('cl_state').upsert({ k, v, updated_at: new Date().toISOString() });
}

/* ------------------------------------------------------------- webhook -- */

// O formato do aviso não está documentado: procura o objeto que tem cara de
// ticket (id + created_at + labels) no corpo, em `data` ou em `conversation`.
function acharTicket(corpo: any): any | null {
  const candidatos = [corpo, corpo?.data, corpo?.conversation, corpo?.data?.conversation, corpo?.payload, corpo?.payload?.conversation];
  for (const c of candidatos) {
    if (c && typeof c === 'object' && c.id != null && c.created_at != null && 'labels' in c) return normalizar(c);
  }
  return null;
}

// O webhook manda datas em segundos (número) e pode trazer o auto-label à parte
// em `auto_label`; a API manda datas em texto. Deixa tudo no formato da API.
function data(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const n = Number(v);
  if (/^\d+(\.\d+)?$/.test(String(v)) && !Number.isNaN(n)) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  return String(v);
}
function nomeLabel(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.title ?? v.name ?? v.label ?? null;
}
function normalizar(c: any) {
  const labels = (Array.isArray(c.labels) ? c.labels : []).map(nomeLabel).filter(Boolean);
  const auto = Array.isArray(c.auto_label) ? c.auto_label.map(nomeLabel) : [nomeLabel(c.auto_label)];
  for (const a of auto) if (a && !labels.some((l: string) => l.toLowerCase() === a.toLowerCase())) labels.push(a);
  return {
    id: c.id, display_id: c.display_id ?? null, status: c.status ?? null, labels,
    created_at: data(c.created_at), updated_at: data(c.updated_at ?? c.last_activity_at ?? c.timestamp),
    contact_reason: c.contact_reason && typeof c.contact_reason === 'object'
      ? { id: c.contact_reason.id ?? null, name: c.contact_reason.name ?? null, parent_id: c.contact_reason.parent_id ?? null } : null,
  };
}

// Tipos dos campos que importam, para diagnóstico (sem valores de cliente).
const tipos = (c: any) => c ? `created_at:${typeof c.created_at} labels:${Array.isArray(c.labels) ? 'array' : typeof c.labels} auto_label:${Array.isArray(c.auto_label) ? 'array' : typeof c.auto_label}=${JSON.stringify(c.auto_label)?.slice(0, 80)} contact_reason:${typeof c.contact_reason}` : '';

// Formato do aviso sem os valores, para conferir o que o Commslayer manda.
function formato(o: any, nivel = 0): string {
  if (!o || typeof o !== 'object' || Array.isArray(o) || nivel > 1) return Array.isArray(o) ? '[]' : typeof o;
  return '{' + Object.keys(o).sort().map((k) => `${k}${nivel < 1 && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? ':' + formato(o[k], nivel + 1) : ''}`).join(',') + '}';
}

async function receberAviso(req: Request) {
  const corpo = await req.json().catch(() => null);
  const evento = corpo?.event ?? corpo?.event_type ?? corpo?.type ?? null;
  const ticket = acharTicket(corpo);
  let gravou = false, erro = '';
  if (ticket) {
    const { error } = await admin.rpc('cl_upsert', { p_rows: [ticket], p_source: 'webhook' });
    if (error) { console.error('cl_upsert', error.message); erro = error.message; }
    gravou = !error;
  }
  const bruto = [corpo, corpo?.data, corpo?.conversation].find((c) => c && typeof c === 'object' && c.id != null && 'labels' in c);
  await admin.from('cl_events_log').insert({ event: evento, shape: `${tipos(bruto)} ${erro} | ${formato(corpo)}`.slice(0, 1000), stored: gravou });
  // Sempre 200: um aviso que não é de ticket não deve derrubar o webhook.
  return json({ ok: true, stored: gravou });
}

/* --------------------------------------------------------- conferência -- */

async function conferir() {
  // Labels manuais: os que o relatório de Labels lista (o /labels traz também
  // os auto-labels). Tudo que não está aqui é auto-label.
  const hojeNY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const labels = await api(`/reports/labels?from_date=${hojeNY}&to_date=${hojeNY}`);
  const itens = labels.corpo?.data?.data ?? labels.corpo?.data;
  if (labels.status === 200 && Array.isArray(itens) && itens.length) {
    const titulos = itens.map((l: any) => String(l.title ?? '').trim()).filter(Boolean);
    await admin.rpc('cl_set_manual_labels', { p_titles: titulos });
  }

  const limite = Date.now() - JANELA_CONFERENCIA_MS;
  let cursor: string | null = null, paginas = 0, lidos = 0, gravados = 0, maisAntigo: string | null = null;
  while (paginas < MAX_PAGINAS) {
    const q = new URLSearchParams({ 'page[limit]': '100' });
    if (cursor) q.set('page[after]', cursor);
    const r = await api(`/conversations?${q}`);
    if (r.status !== 200) throw new Error(`Commslayer respondeu ${r.status} em /conversations`);
    const lista = (r.corpo?.data ?? []).filter((c: any) => c && !c.spam);
    paginas++;
    lidos += lista.length;
    if (lista.length) {
      const { data, error } = await admin.rpc('cl_upsert', { p_rows: lista, p_source: 'api' });
      if (error) throw new Error(error.message);
      gravados += data ?? 0;
      maisAntigo = lista[lista.length - 1].created_at;
    }
    cursor = r.corpo?.meta?.next_cursor ?? null;
    if (!cursor || !maisAntigo || Date.parse(maisAntigo) < limite) break;
  }

  // Desde quando a contagem é completa: primeira conferência (o que ela alcançou).
  const { data: cob } = await admin.from('cl_state').select('v').eq('k', 'coverage').maybeSingle();
  if (!cob && maisAntigo) {
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + 864e5));
    // O dia de hoje ficou pela metade; a contagem é completa a partir de amanhã.
    await estado('coverage', { from: dia, first_ticket_at: maisAntigo });
  }

  // Saúde do webhook (se o token puder ver).
  const wh = await api('/webhooks');
  if (wh.status === 200) {
    const nosso = (wh.corpo?.data ?? []).find((w: any) => String(w.url ?? '').includes('/functions/v1/commslayer-events'));
    await estado('webhook', nosso
      ? { exists: true, active: nosso.active, healthy: nosso.healthy, broken: nosso.circuit_breaker?.broken ?? false, last_delivery_at: nosso.last_delivery_at, checked_at: new Date().toISOString() }
      : { exists: false, checked_at: new Date().toISOString() });
  }

  const { data: resumidos } = await admin.rpc('cl_rollup');
  const resultado = { pages: paginas, read: lidos, stored: gravados, oldest_read: maisAntigo, rolled_up: resumidos, at: new Date().toISOString() };
  await estado('last_reconcile', resultado);
  return resultado;
}

/* --------------------------------------------------------------- setup -- */

async function configurar(req: Request) {
  const url = new URL(req.url);
  const destino = `${SUPABASE_URL}/functions/v1/commslayer-events?k=${encodeURIComponent(CHAVE)}`;
  const lista = await api('/webhooks');
  if (lista.status !== 200) return { ok: false, step: 'list', status: lista.status, hint: 'O token do Commslayer não tem a permissão Webhooks.' };
  const existente = (lista.corpo?.data ?? []).find((w: any) => String(w.url ?? '').includes('/functions/v1/commslayer-events'));
  if (existente) {
    const r = await api(`/webhooks/${existente.id}`, { method: 'PATCH', body: JSON.stringify({ webhook: { url: destino, active: true, subscriptions: EVENTOS } }) });
    return { ok: r.status === 200, step: 'update', status: r.status, id: existente.id };
  }
  const r = await api('/webhooks', { method: 'POST', body: JSON.stringify({ webhook: { url: destino, active: true, subscriptions: EVENTOS } }) });
  if (r.status !== 201 && r.status !== 200) return { ok: false, step: 'create', status: r.status, error: r.corpo?.error ?? null };
  // O segredo de assinatura não é usado (a chave da URL autentica); não é guardado nem devolvido.
  return { ok: true, step: 'create', status: r.status, id: r.corpo?.data?.id ?? null, host: url.host };
}

/* ------------------------------------------------------------- handler -- */

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!TOKEN || !CHAVE || !CHAVE_SERVICO) return json({ error: 'Função sem configuração no servidor.' }, 500);
  const url = new URL(req.url);
  if (!iguais(url.searchParams.get('k') ?? '', CHAVE)) return json({ error: 'forbidden' }, 403);

  try {
    switch (url.searchParams.get('action')) {
      case 'reconcile': return json({ ok: true, ...(await conferir()) });
      case 'setup': return json(await configurar(req));
      default: return await receberAviso(req);
    }
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
