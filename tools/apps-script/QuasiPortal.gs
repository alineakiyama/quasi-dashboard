/**
 * Quasi Portal — sincronização da "Quasi — Master Tracking Spreadsheet" com o dashboard.
 *
 * COMO INSTALAR (uma vez só):
 *   1. Na planilha: Extensions → Apps Script.
 *   2. Crie um arquivo NOVO (+ → Script) chamado QuasiPortal e cole este código.
 *      Não apague nem substitua scripts que já existam no projeto.
 *   3. Salve, escolha a função quasiPortalSetup no topo e clique em Run.
 *      Autorize quando o Google pedir.
 *   4. Volte para a planilha: vai aparecer uma caixa pedindo o segredo de
 *      sincronização. Cole e confirme.
 *
 * O QUE ELE FAZ:
 *   · Quando alguém edita uma das 4 abas, marca a aba como pendente; a cada
 *     minuto as abas pendentes são enviadas ao portal.
 *   · A cada 30 minutos manda todas as abas, para pegar qualquer coisa que
 *     tenha escapado (colar de outra planilha, importação, etc.).
 *   · Nas abas sem data, cria a coluna "Date" e preenche a data de hoje quando
 *     uma linha nova ganha o número do pedido (ou o e-mail).
 *   · Adiciona o menu "Quasi Portal" com "Sync now".
 *
 * Todas as funções começam com quasiPortal para não colidir com outros scripts.
 */

var QUASI_PORTAL = {
  URL: 'https://gpjawqxnururaoqwkdnp.supabase.co/functions/v1/sheets-sync',
  ABAS: {
    'Refund Tracker':                  { tab: 'refunds',         colunaData: null,   colunaChave: 'Order Number' },
    'Subscription Tracker - Cancella': { tab: 'subscriptions',   colunaData: 'Date', colunaChave: 'Customer Email' },
    'Reshipment - 3pl':                { tab: 'reshipments',     colunaData: 'Date', colunaChave: 'Order #' },
    'Order Issues - Dianxiaomi':       { tab: 'supplier_issues', colunaData: 'Date', colunaChave: 'Order #' },
  },
  INTERVALO_MIN_MS: 50 * 1000,   // mesma aba não é reenviada em menos de ~1 minuto
};

/* ---------------------------------------------------------------- setup -- */

function quasiPortalSetup() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Quasi Portal', 'Paste the sync secret:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var segredo = resp.getResponseText().trim();
  if (segredo.length < 32) { ui.alert('That does not look like the sync secret. Nothing was changed.'); return; }
  PropertiesService.getScriptProperties().setProperty('QUASI_PORTAL_SECRET', segredo);

  quasiPortalGarantirColunasDeData_();

  // Recria só os gatilhos deste script; gatilhos de outros scripts ficam intactos.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction().indexOf('quasiPortal') === 0) ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('quasiPortalOnEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('quasiPortalOnChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('quasiPortalOnOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('quasiPortalSyncPending').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('quasiPortalSyncAll').timeBased().everyMinutes(30).create();

  quasiPortalOnOpen();
  var resumo = quasiPortalSyncAll(true);
  ui.alert('Quasi Portal is set up.\n\n' + resumo);
}

function quasiPortalOnOpen() {
  SpreadsheetApp.getUi().createMenu('Quasi Portal')
    .addItem('Sync now', 'quasiPortalSyncNowMenu')
    .addToUi();
}

function quasiPortalSyncNowMenu() {
  SpreadsheetApp.getUi().alert(quasiPortalSyncAll(true));
}

/* -------------------------------------------------------------- gatilhos -- */

function quasiPortalOnEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var cfg = QUASI_PORTAL.ABAS[sh.getName()];
  if (!cfg) return;
  quasiPortalMarcarPendente_(sh.getName());
  if (cfg.colunaData) quasiPortalCarimbarDatas_(sh, cfg, e.range);
}

function quasiPortalOnChange(e) {
  // Inserir/remover linhas e colar grandes blocos nem sempre chegam como edição:
  // marca todas as abas; as que não mudaram saem rápido do outro lado.
  if (!e) return;
  if (['INSERT_ROW', 'REMOVE_ROW', 'INSERT_GRID', 'REMOVE_GRID', 'OTHER'].indexOf(e.changeType) < 0) return;
  Object.keys(QUASI_PORTAL.ABAS).forEach(quasiPortalMarcarPendente_);
}

function quasiPortalSyncPending() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var pend = JSON.parse(props.getProperty('QUASI_PORTAL_PENDING') || '[]');
    if (!pend.length) return;
    props.deleteProperty('QUASI_PORTAL_PENDING');
    pend.forEach(function (nome) { quasiPortalEnviar_(nome, false); });
  } finally {
    lock.releaseLock();
  }
}

function quasiPortalSyncAll(forcar) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return 'Another sync is running. Try again in a minute.';
  try {
    return Object.keys(QUASI_PORTAL.ABAS).map(function (nome) {
      return nome + ': ' + quasiPortalEnviar_(nome, forcar === true);
    }).join('\n');
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------ internos -- */

function quasiPortalMarcarPendente_(nome) {
  var props = PropertiesService.getScriptProperties();
  var pend = JSON.parse(props.getProperty('QUASI_PORTAL_PENDING') || '[]');
  if (pend.indexOf(nome) < 0) {
    pend.push(nome);
    props.setProperty('QUASI_PORTAL_PENDING', JSON.stringify(pend));
  }
}

/** Linha de cabeçalho: a primeira, entre as 5 primeiras, com 3 ou mais células preenchidas. */
function quasiPortalCabecalho_(sh) {
  var ncols = Math.max(1, sh.getLastColumn());
  var topo = sh.getRange(1, 1, Math.min(5, Math.max(1, sh.getLastRow())), ncols).getDisplayValues();
  for (var i = 0; i < topo.length; i++) {
    var cheias = topo[i].filter(function (c) { return String(c).trim() !== ''; }).length;
    if (cheias >= 3) {
      var cab = topo[i].map(function (c) { return String(c).trim(); });
      while (cab.length && cab[cab.length - 1] === '') cab.pop();
      return { linha: i + 1, cabecalhos: cab };
    }
  }
  return { linha: 1, cabecalhos: [] };
}

function quasiPortalIndice_(cab, nome) {
  var alvo = String(nome).toLowerCase().replace(/[?\\]/g, '').trim();
  for (var i = 0; i < cab.length; i++) {
    if (String(cab[i]).toLowerCase().replace(/[?\\]/g, '').trim() === alvo) return i;
  }
  return -1;
}

function quasiPortalGarantirColunasDeData_() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(QUASI_PORTAL.ABAS).forEach(function (nome) {
    var cfg = QUASI_PORTAL.ABAS[nome];
    var sh = ss.getSheetByName(nome);
    if (!sh || !cfg.colunaData) return;
    var info = quasiPortalCabecalho_(sh);
    if (quasiPortalIndice_(info.cabecalhos, cfg.colunaData) >= 0) return;
    var col = info.cabecalhos.length + 1;
    sh.getRange(info.linha, col).setValue(cfg.colunaData);
    sh.getRange(info.linha + 1, col, Math.max(1, sh.getMaxRows() - info.linha), 1).setNumberFormat('yyyy-mm-dd');
  });
}

/** Preenche a data de hoje quando alguém digita (ou cola) a chave — número do
    pedido ou e-mail — numa linha que ainda não tem data. Editar só o status de
    uma linha antiga NÃO carimba: senão um caso de julho passaria a contar hoje. */
function quasiPortalCarimbarDatas_(sh, cfg, range) {
  var info = quasiPortalCabecalho_(sh);
  var cData = quasiPortalIndice_(info.cabecalhos, cfg.colunaData);
  var cChave = quasiPortalIndice_(info.cabecalhos, cfg.colunaChave);
  if (cData < 0 || cChave < 0) return;
  if (cChave + 1 < range.getColumn() || cChave + 1 > range.getLastColumn()) return;
  var r0 = Math.max(range.getRow(), info.linha + 1);
  var ultima = range.getLastRow();
  if (ultima < r0) return;
  var n = ultima - r0 + 1;
  var chaves = sh.getRange(r0, cChave + 1, n, 1).getValues();
  var faixa = sh.getRange(r0, cData + 1, n, 1);
  var datas = faixa.getValues();
  var hoje = Utilities.formatDate(new Date(), quasiPortalFuso_(), 'yyyy-MM-dd');
  var mudou = false;
  for (var i = 0; i < n; i++) {
    if (String(chaves[i][0]).trim() !== '' && String(datas[i][0]).trim() === '') {
      datas[i][0] = hoje;
      mudou = true;
    }
  }
  if (mudou) {
    faixa.setValues(datas);
    faixa.setNumberFormat('yyyy-mm-dd');
  }
}

/** Lê a aba inteira e manda ao portal. Devolve um resumo curto. */
function quasiPortalEnviar_(nome, forcar) {
  var cfg = QUASI_PORTAL.ABAS[nome];
  var props = PropertiesService.getScriptProperties();
  var segredo = props.getProperty('QUASI_PORTAL_SECRET');
  if (!segredo) return 'not set up (run quasiPortalSetup)';

  var chaveUltimo = 'QUASI_PORTAL_LAST_' + cfg.tab;
  var ultimo = Number(props.getProperty(chaveUltimo) || 0);
  if (!forcar && Date.now() - ultimo < QUASI_PORTAL.INTERVALO_MIN_MS) {
    quasiPortalMarcarPendente_(nome);   // tenta de novo no próximo minuto
    return 'waiting';
  }

  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(nome);
  if (!sh) return 'tab not found';

  var tz = quasiPortalFuso_();
  var info = quasiPortalCabecalho_(sh);
  var ncols = info.cabecalhos.length;
  var ultimaLinha = sh.getLastRow();
  var valores = (ncols && ultimaLinha > info.linha)
    ? sh.getRange(info.linha + 1, 1, ultimaLinha - info.linha, ncols).getValues()
    : [];

  var iReembolso = quasiPortalIndice_(info.cabecalhos, 'Refunded Amount');
  var linhas = [];
  var soma = 0;
  for (var k = 0; k < valores.length; k++) {
    var v = valores[k].map(function (c) {
      if (c instanceof Date) return Utilities.formatDate(c, tz, 'yyyy-MM-dd');
      return typeof c === 'string' ? c.trim() : c;
    });
    var vazia = v.every(function (c) { return c === '' || c === null; });
    if (vazia) continue;
    if (iReembolso >= 0 && typeof valores[k][iReembolso] === 'number') soma += valores[k][iReembolso];
    linhas.push({ n: info.linha + 1 + k, v: v });
  }

  var payload = {
    tab: cfg.tab,
    sheet_name: nome,
    header_row: info.linha,
    headers: info.cabecalhos,
    rows: linhas,
    sheet_stats: { rows: linhas.length, refunded_sum: Math.round(soma * 100) / 100, timezone: tz },
  };

  var resp = UrlFetchApp.fetch(QUASI_PORTAL.URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'x-sync-secret': segredo },
    muteHttpExceptions: true,
  });
  props.setProperty(chaveUltimo, String(Date.now()));

  var codigo = resp.getResponseCode();
  var corpo = {};
  try { corpo = JSON.parse(resp.getContentText()); } catch (err) { corpo = {}; }
  if (codigo !== 200 || !corpo.ok) {
    console.error('Quasi Portal: ' + nome + ' falhou (' + codigo + '): ' + resp.getContentText().slice(0, 500));
    return 'FAILED — ' + (corpo.error || ('HTTP ' + codigo));
  }
  if (corpo.unchanged) return linhas.length + ' rows, no changes';
  return linhas.length + ' rows (+' + corpo.inserted + ' new, ' + corpo.deleted + ' removed)';
}

/** Fuso da planilha; cópias às vezes vêm sem fuso definido. */
function quasiPortalFuso_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'America/New_York';
}

/** Para rodar pelo editor: envia as 4 abas agora e mostra o resultado no log. */
function quasiPortalTestNow() {
  console.log(quasiPortalSyncAll(true));
}
