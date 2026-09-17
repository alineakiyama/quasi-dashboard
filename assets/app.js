/* Partida: login, abas e tema.

   Só existem telas com dado real: Reports (Commslayer) e as telas da planilha
   de acompanhamento. Cada tela tem os próprios controles e busca o próprio dado. */

import { supabase } from './supabase.js';
import { esc } from './charts.js';

import { mountReports } from './views/reports.js';
import {
  mountRefunds, mountSubscriptions, mountReshipments, mountSupplierIssues, mountLookup, mountDataCheck,
} from './views/sheets.js';

const VIEWS = {
  reports: {
    title: 'Reports',
    mount: mountReports,
    sub: 'Live from Commslayer — the same numbers as the Commslayer portal.',
  },
  refunds: {
    title: 'Refunds',
    mount: mountRefunds,
    sub: 'From the Refund Tracker tab of the tracking spreadsheet. Each row is one refund.',
  },
  subscriptions: {
    title: 'Subscriptions',
    mount: mountSubscriptions,
    sub: 'Cancellations and changes from the Subscription Tracker tab.',
  },
  reshipments: {
    title: 'Reshipments',
    mount: mountReshipments,
    sub: 'Failed orders and reshipments from the Reshipment - 3pl tab.',
  },
  supplier: {
    title: 'Supplier issues',
    mount: mountSupplierIssues,
    sub: 'Order problems from the Order Issues - Dianxiaomi tab.',
  },
  lookup: {
    title: 'Order lookup',
    mount: mountLookup,
    sub: 'Everything the tracking spreadsheet has about one order or customer, in one place.',
  },
  datacheck: {
    title: 'Data check',
    mount: mountDataCheck,
    sub: 'Does the portal match the spreadsheet? Row counts, totals and anything that needs attention.',
  },
};

const $ = (sel) => document.querySelector(sel);

const state = { view: 'reports' };
let iniciado = false;

/* ---------------------------------------------------------------- boot -- */

wireTheme();
wireAuth();

function start() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.view));
  });

  addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS[v] && v !== state.view) go(v, { silent: true });
  });

  const initial = location.hash.slice(1);
  if (VIEWS[initial]) state.view = initial;

  render();
}

/* --------------------------------------------------------------- login -- */

function wireAuth() {
  const form = $('#login-form'), erro = $('#login-error'), botao = $('#login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.textContent = '';
    botao.disabled = true;
    botao.textContent = 'Signing in…';
    const { error } = await supabase.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
    });
    botao.disabled = false;
    botao.textContent = 'Sign in';
    if (error) {
      erro.textContent = /invalid/i.test(error.message) ? 'Wrong email or password.' : error.message;
      return;
    }
    $('#login-password').value = '';
  });

  $('#signout').addEventListener('click', () => supabase.auth.signOut());

  // Não chamar outros métodos do Supabase dentro deste callback: o cliente pode travar.
  supabase.auth.onAuthStateChange((_evento, sessao) => mostrar(sessao));
}

function mostrar(sessao) {
  const logado = Boolean(sessao);
  $('#login').hidden = logado;
  $('#app').hidden = !logado;
  if (!logado) {
    setTimeout(() => $('#login-email')?.focus(), 0);
    return;
  }
  $('#user-email').textContent = sessao.user?.email ?? '';
  if (!iniciado) {
    iniciado = true;
    start();
  }
}

/* ---------------------------------------------------------------- tema -- */

function wireTheme() {
  const btn = $('#theme');
  const atual = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const pintar = () => { btn.textContent = `Theme: ${atual()}`; };
  btn.addEventListener('click', () => {
    const novo = atual() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = novo;
    try { localStorage.setItem('quasi-theme', novo); } catch { /* sem armazenamento */ }
    pintar();
  });
  pintar();
}

/* ------------------------------------------------------------ desenhar -- */

function go(view, { silent = false } = {}) {
  if (!VIEWS[view]) return;
  state.view = view;
  if (!silent) location.hash = view;
  render();
  $('#conteudo').focus({ preventScroll: true });
  scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  const def = VIEWS[state.view];

  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });

  $('#view-title').textContent = def.title;
  $('#view-sub').textContent = def.sub;
  document.title = `Quasi · ${def.title}`;

  for (const id of Object.keys(VIEWS)) {
    const el = document.getElementById(`view-${id}`);
    el.hidden = id !== state.view;
    if (id !== state.view) el.innerHTML = '';
  }

  const host = document.getElementById(`view-${state.view}`);
  try {
    def.mount(host);
  } catch (err) {
    console.error(err);
    host.innerHTML = `<p class="empty">Could not build this view: ${esc(err.message)}</p>`;
  }
}
