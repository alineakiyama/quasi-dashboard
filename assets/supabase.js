/* Conexão com o Supabase: login e busca dos relatórios reais.

   A URL e a chave publicável ficam no código de propósito: são públicas por
   definição e não dão acesso a nada sozinhas. Os relatórios só saem da função
   `reports` para uma sessão de usuário logado, e o token do Commslayer nunca
   passa pelo navegador. */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';

export const SUPABASE_URL = 'https://gpjawqxnururaoqwkdnp.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_Z0cSbY5907VM_u3E6cPqYg_ANpyZU7a';

export const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'quasi-auth' },
});

/** Busca os relatórios de um período. Lança erro com `.code` = status HTTP. */
export async function fetchReports({ from, to, compareFrom, compareTo, businessHours, refresh, signal }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw Object.assign(new Error('You are signed out. Sign in again.'), { code: 401 });

  const q = new URLSearchParams({ from, to, business_hours: String(Boolean(businessHours)) });
  if (compareFrom && compareTo) {
    q.set('compare_from', compareFrom);
    q.set('compare_to', compareTo);
  }
  if (refresh) q.set('refresh', '1');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/reports?${q}`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` },
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `The report request failed (${res.status}).`), { code: res.status });
  return body;
}
