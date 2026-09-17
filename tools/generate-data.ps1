<#
  generate-data.ps1 — gerador dos dados FICTÍCIOS do Portal Quasi.

  Roda offline, sem dependência nenhuma:
      powershell -ExecutionPolicy Bypass -File tools/generate-data.ps1

  Escreve sete dos oito arquivos de data/ (action-plans.json e escrito a mao).
  E determinístico: a mesma seed produz exatamente os mesmos numeros, entao
  rodar de novo não faz o dashboard mudar sozinho.

  Na Fase 2 este arquivo e substituído por um job que chama a API do Commslayer
  e da Shopify. O formato de saída e o mesmo — ver docs/DATA-CONTRACT.md.
#>

[CmdletBinding()]
param(
  [int]$Seed = 20260907,
  [string]$OutDir = ''
)

# $PSScriptRoot não esta preenchido na avaliacao dos defaults do param() no PS 5.1.
if (-not $OutDir) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Definition
  $OutDir = Join-Path (Split-Path -Parent $here) 'data'
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# Cultura invariante: sem isto o PowerShell em pt-BR escreveria "3,75" e o JSON quebraria.
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
$ErrorActionPreference = 'Stop'

$rng = [System.Random]::new($Seed)

# ------------------------------------------------------------------ aleatório

function U { $rng.NextDouble() }
function Uni([double]$a, [double]$b) { $a + (U) * ($b - $a) }
function IntBetween([int]$a, [int]$b) { $rng.Next($a, $b + 1) }
function Pick($array) { $array[$rng.Next(0, $array.Count)] }

function PickWeighted($pairs) {
  $total = 0.0; foreach ($p in $pairs) { $total += $p.w }
  $r = (U) * $total; $acc = 0.0
  foreach ($p in $pairs) { $acc += $p.w; if ($r -le $acc) { return $p.v } }
  return $pairs[-1].v
}

function Shuffle($array) {
  $a = @($array)
  for ($i = $a.Count - 1; $i -gt 0; $i--) {
    $j = $rng.Next(0, $i + 1)
    $t = $a[$i]; $a[$i] = $a[$j]; $a[$j] = $t
  }
  return ,$a
}

# Box-Muller. Guardamos o segundo valor porque descartá-lo dobraria o custo.
$script:gaussSpare = $null
function Gauss {
  if ($null -ne $script:gaussSpare) { $g = $script:gaussSpare; $script:gaussSpare = $null; return $g }
  do { $u = 2.0 * (U) - 1.0; $v = 2.0 * (U) - 1.0; $s = $u * $u + $v * $v } while ($s -ge 1.0 -or $s -eq 0.0)
  $f = [math]::Sqrt(-2.0 * [math]::Log($s) / $s)
  $script:gaussSpare = $v * $f
  return $u * $f
}

# Duração em horas: mistura de duas lognormais.
#   corpo rapido  -> o ticket pego dentro do turno
#   cauda lenta   -> o que caiu de madrugada ou ficou esperando terceiro
# Uma lognormal sozinha não reproduz o degrau do "virou a noite", que e
# exatamente o que decide a métrica de "% respondido em menos de 24h".
function Duration([double]$fastMedian, [double]$fastSigma, [double]$slowShare, [double]$slowMedian, [double]$slowSigma) {
  if ((U) -lt $slowShare) { $v = $slowMedian * [math]::Exp($slowSigma * (Gauss)) }
  else                    { $v = $fastMedian * [math]::Exp($fastSigma * (Gauss)) }
  if ($v -lt 0.05) { $v = 0.05 }
  return [math]::Round($v, 2)
}

# ------------------------------------------------------------- emissão de JSON

function JStr($s) {
  if ($null -eq $s) { return 'null' }
  $e = [string]$s
  $e = $e.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return '"' + $e + '"'
}
function JNum($n) {
  if ($null -eq $n) { return 'null' }
  return ([double]$n).ToString('0.####', [System.Globalization.CultureInfo]::InvariantCulture)
}
function JVal($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [int] -or $v -is [double] -or $v -is [long] -or $v -is [decimal] -or $v -is [single]) { return (JNum $v) }
  if ($v -is [System.Collections.Specialized.OrderedDictionary]) { return (JObj $v) }
  if ($v -is [array] -or $v -is [System.Collections.ArrayList]) {
    $parts = @(); foreach ($x in $v) { $parts += (JVal $x) }
    return '[' + ($parts -join ',') + ']'
  }
  return (JStr $v)
}
# Objeto achatado numa linha so — mantem os arquivos legiveis em diff.
function JObj($o) {
  $parts = @()
  foreach ($k in $o.Keys) { $parts += (JStr $k) + ':' + (JVal $o[$k]) }
  return '{' + ($parts -join ',') + '}'
}
function JRows($header, $key, $rows) {
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine('{')
  foreach ($k in $header.Keys) { [void]$sb.AppendLine('  ' + (JStr $k) + ': ' + (JVal $header[$k]) + ',') }
  [void]$sb.AppendLine('  ' + (JStr $key) + ': [')
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $comma = $(if ($i -lt $rows.Count - 1) { ',' } else { '' })
    [void]$sb.AppendLine('    ' + (JObj $rows[$i]) + $comma)
  }
  [void]$sb.AppendLine('  ]')
  [void]$sb.Append('}')
  return $sb.ToString()
}
function WriteJson([string]$name, [string]$body) {
  $path = Join-Path $OutDir $name
  [System.IO.File]::WriteAllText($path, $body, (New-Object System.Text.UTF8Encoding($false)))
  $kb = [math]::Ceiling((Get-Item $path).Length / 1024)
  Write-Host ('  data/{0,-22} {1,5} KB' -f $name, $kb)
}

# -------------------------------------------------------------------- período
# Os dados cobrem 18 semanas fechadas, de segunda a domingo. É o que dá sentido
# aos atalhos do seletor de período (7, 30, 90 dias, mês passado) — com só duas
# semanas de dado, "últimos 30 dias" abriria uma tela quase vazia.
#
# PeriodStart/PeriodEnd continuam existindo: são o intervalo com que a página
# abre (a última semana) e PeriodEnd é o dia do retrato da fila.

$TZ          = '-03:00'
$DataStart   = [datetime]'2026-05-04'
$PeriodEnd   = [datetime]'2026-09-06'
$PeriodStart = $PeriodEnd.AddDays(-6)
$WEEKS       = [int]((($PeriodEnd - $DataStart).Days + 1) / 7)
$SnapshotAt  = '2026-09-06T21:00:00' + $TZ
$GeneratedAt = '2026-09-07T08:30:00' + $TZ

$allDays = @(); for ($d = $DataStart; $d -le $PeriodEnd; $d = $d.AddDays(1)) { $allDays += $d }
function D([datetime]$d) { $d.ToString('yyyy-MM-dd') }
function Stamp([datetime]$d, [int]$h, [int]$m) { $d.ToString('yyyy-MM-dd') + ('T{0:d2}:{1:d2}:00' -f $h, $m) + $TZ }
function RandStamp([datetime]$d) { Stamp $d (IntBetween 6 22) (IntBetween 0 59) }
function WeekOf([datetime]$d) { [int][math]::Floor(($d - $DataStart).Days / 7) }

# Segunda pesa mais (fim de semana represado), domingo e o mais leve. Soma 7.00.
$dowWeight = @{ Monday = 1.22; Tuesday = 1.10; Wednesday = 1.03; Thursday = 0.99; Friday = 0.95; Saturday = 0.85; Sunday = 0.86 }

# ------------------------------------------------- a história das 18 semanas
# Um número por semana diz o quanto a operação estava pior que a última semana
# (1.00 = igual à última). Todo o resto — mediana de resposta, fatia da cauda
# lenta, reabertura, reembolso, chargeback — deriva dele, então as métricas
# pioram e melhoram juntas, como numa operação de verdade.
#
#   maio a agosto ... melhora lenta, de 1.32 para 1.24
#   semana 11 ....... liquidação de julho: pedidos +75%, o suporte afoga (+0.35)
#   semana 12 ....... ressaca da liquidação (+0.15)
#   semana 16 ....... 1.21 — a "semana anterior" que o portal já mostrava
#   semana 17 ....... 1.00 — os planos de ação entraram em vigor
$PROMO_WEEK = 11

function Quality([int]$w) {
  if ($w -ge 17) { $q = 1.00 }
  elseif ($w -eq 16) { $q = 1.21 }
  else { $q = 1.32 - 0.08 * ($w / 15.0) }
  if ($w -eq $PROMO_WEEK) { $q += 0.35 }
  if ($w -eq $PROMO_WEEK + 1) { $q += 0.15 }
  return $q
}

# Conversas criadas na semana. Cresce com a loja; a última semana cai porque o
# e-mail proativo de rastreio (plano 2) cortou contato na origem.
function WeekVolume([int]$w) {
  if ($w -ge 17) { $v = 1046.0 } else { $v = 880.0 + 14.9 * $w }
  if ($w -eq $PROMO_WEEK) { $v *= 1.45 }
  if ($w -eq $PROMO_WEEK + 1) { $v *= 1.15 }
  return $v
}

# Receita e pedidos da semana. Não dependem da qualidade do suporte — dependem
# da loja. A liquidação vende muito mais pedido, com ticket médio menor.
function WeekRevenue([int]$w) {
  $r = 118000.0 + 1150.0 * $w
  if ($w -eq $PROMO_WEEK) { $r *= 1.60 }
  return $r
}
function WeekOrders([int]$w) {
  $o = (118000.0 + 1150.0 * $w) / 67.5
  if ($w -eq $PROMO_WEEK) { $o *= 1.75 }
  return $o
}

# --------------------------------------------------------- motivos de contato
# A loja e uma so, entao o motivo do contato e o eixo de comparacao do portal.
#   share -> fatia do volume
#   frt / res -> fator sobre a mediana base, em horas
#   slow -> fatia dos tickets que cai na cauda lenta

$reasons = @(
  [ordered]@{ reason='order_status';        label='Where is my order';       short='Tracking';     share=0.26; frt=0.85; res=0.62; slow=0.15; slot=1 },
  [ordered]@{ reason='delivery_issue';      label='Delivery problem';        short='Delivery';     share=0.14; frt=1.18; res=1.85; slow=0.22; slot=2 },
  [ordered]@{ reason='subscription';        label='Subscription';            short='Subscription'; share=0.13; frt=1.02; res=0.78; slow=0.18; slot=3 },
  [ordered]@{ reason='product_question';    label='Product question';        short='Question';     share=0.12; frt=0.96; res=0.55; slow=0.16; slot=4 },
  [ordered]@{ reason='refund_request';      label='Refund request';          short='Refund';       share=0.09; frt=1.34; res=1.22; slow=0.24; slot=5 },
  [ordered]@{ reason='cancel_change_order'; label='Cancel or change order';  short='Cancellation'; share=0.07; frt=0.78; res=0.48; slow=0.11; slot=6 },
  [ordered]@{ reason='adverse_reaction';    label='Skin reaction';           short='Reaction';     share=0.06; frt=0.42; res=1.65; slow=0.04; slot=7 },
  [ordered]@{ reason='damaged_item';        label='Damaged product';         short='Damaged';      share=0.05; frt=1.06; res=1.42; slow=0.19; slot=8 },
  [ordered]@{ reason='wrong_item';          label='Wrong item';              short='Wrong item';   share=0.04; frt=1.10; res=1.35; slow=0.20; slot=9 },
  [ordered]@{ reason='promo_discount';      label='Promo and discount';      short='Promo';        share=0.04; frt=0.88; res=0.44; slow=0.13; slot=10 }
)

$FRT_BASE     = 3.10   # mediana do corpo rapido de primeira resposta, em horas
$RES_BASE     = 21.0   # idem para resolução

# ------------------------------------------------------------------- agentes

$agents = @(
  [ordered]@{ agent_id='ag_amara';  agent_name='Amara Osei';       weight=0.132 },
  [ordered]@{ agent_id='ag_sofia';  agent_name='Sofia Marchetti';  weight=0.124 },
  [ordered]@{ agent_id='ag_daniel'; agent_name='Daniel Okafor';    weight=0.118 },
  [ordered]@{ agent_id='ag_priya';  agent_name='Priya Raman';      weight=0.112 },
  [ordered]@{ agent_id='ag_lucas';  agent_name='Lucas Ferreira';   weight=0.106 },
  [ordered]@{ agent_id='ag_elena';  agent_name='Elena Vasquez';    weight=0.098 },
  [ordered]@{ agent_id='ag_marcus'; agent_name='Marcus Bell';      weight=0.092 },
  [ordered]@{ agent_id='ag_yuki';   agent_name='Yuki Tanaka';      weight=0.081 },
  [ordered]@{ agent_id='ag_nadia';  agent_name='Nadia Haddad';     weight=0.074 },
  [ordered]@{ agent_id='ag_tomas';  agent_name='Tomas Ribeiro';    weight=0.063 }
)
$agentIds = @($agents | ForEach-Object { $_.agent_id })

Write-Host ''
Write-Host 'Portal Quasi — gerando dados fictícios' -ForegroundColor Magenta
Write-Host ('  seed {0}   dados de {1} a {2} ({3} semanas)' -f $Seed, (D $DataStart), (D $PeriodEnd), $WEEKS) -ForegroundColor DarkGray
Write-Host ''

# ================================================================ reasons.json

$reasonRows = @()
foreach ($r in $reasons) {
  $reasonRows += [ordered]@{ reason = $r.reason; label = $r.label; short_label = $r.short; color_slot = [int]$r.slot }
}
WriteJson 'reasons.json' (JRows ([ordered]@{ schema = 'reasons/1' }) 'reasons' $reasonRows)

# ========================================================== tickets-daily.json

$ticketRows   = @()
$frtByDay     = @{}   # data -> lista de FRT do dia inteiro (usada para repartir entre agentes)
$closedByDay  = @{}
$reopenByDay  = @{}

foreach ($day in $allDays) {
  $wk      = WeekOf $day
  $q       = Quality $wk
  $worse   = $q - 1.0
  $dayBase = ((WeekVolume $wk) / 7.0) * $dowWeight[$day.DayOfWeek.ToString()]

  $dayFrt = New-Object System.Collections.ArrayList
  $dayClosed = 0; $dayReopen = 0

  foreach ($r in $reasons) {
    $created = [int][math]::Round($dayBase * $r.share * (Uni 0.86 1.14))
    if ($created -lt 1) { $created = 1 }

    # answered não e uma fatia de created: e quem recebeu resposta humana NAQUELE dia,
    # entao pode passar de created num dia de recuperacao e ficar abaixo num dia ruim.
    # Numa semana pior, o time responde e fecha uma fatia menor do que entrou.
    $answered = [int][math]::Round($created * (Uni 0.90 1.04) * [math]::Max(0.70, 1.0 - $worse * 0.286))
    if ($answered -lt 1) { $answered = 1 }

    $closed = [int][math]::Round($answered * (Uni 0.88 1.00) * [math]::Max(0.70, 1.0 - $worse * 0.238))
    if ($closed -lt 1) { $closed = 1 }

    $reopenRate = Uni (0.028 + $worse * 0.066) (0.058 + $worse * 0.086)
    $reopened = [int][math]::Round($closed * $reopenRate)

    $frtMed  = $FRT_BASE * $r.frt * $q
    $resMed  = $RES_BASE * $r.res * $q
    $slow    = [math]::Min(0.6, $r.slow * (1.0 + $worse * 0.857))

    $frtArr = @(); for ($i = 0; $i -lt $answered; $i++) { $frtArr += (Duration $frtMed 0.74 $slow 30.0 0.52) }
    $resArr = @(); for ($i = 0; $i -lt $closed;   $i++) { $resArr += (Duration $resMed 0.86 ($slow * 0.7) 96.0 0.62) }

    foreach ($f in $frtArr) { [void]$dayFrt.Add($f) }
    $dayClosed += $closed; $dayReopen += $reopened

    $ticketRows += [ordered]@{
      date = (D $day); reason = $r.reason
      created = $created; answered = $answered; closed = $closed; reopened = $reopened
      frt_hours = $frtArr; resolution_hours = $resArr
    }
  }

  $frtByDay[(D $day)]    = $dayFrt
  $closedByDay[(D $day)] = $dayClosed
  $reopenByDay[(D $day)] = $dayReopen
}

$hdr = [ordered]@{ schema = 'tickets-daily/1'; reporting_timezone = 'America/Sao_Paulo' }
WriteJson 'tickets-daily.json' (JRows $hdr 'rows' $ticketRows)

# =============================================================== revenue.json

$revRows = @()
foreach ($day in $allDays) {
  $wk      = WeekOf $day
  $w       = $dowWeight[$day.DayOfWeek.ToString()] / 7.0
  $jit     = Uni 0.93 1.07
  $orders  = [int][math]::Round((WeekOrders $wk) * $w * $jit)
  $revenue = [math]::Round((WeekRevenue $wk) * $w * $jit * (Uni 0.97 1.03), 2)
  $revRows += [ordered]@{ date = (D $day); revenue_usd = $revenue; orders = $orders }
}
$curRevenue = 0.0; $curOrders = 0
foreach ($row in $revRows) {
  if ([datetime]$row.date -ge $PeriodStart) { $curRevenue += $row.revenue_usd; $curOrders += $row.orders }
}
WriteJson 'revenue.json' (JRows ([ordered]@{ schema = 'revenue/1'; currency = 'USD' }) 'rows' $revRows)

# =============================================================== refunds.json

$refundReasons = @(
  @{ v = 'not_delivered';    w = 24 }, @{ v = 'damaged_in_transit'; w = 17 },
  @{ v = 'quality_issue';    w = 14 }, @{ v = 'adverse_reaction';   w = 11 },
  @{ v = 'late_delivery';    w = 12 }, @{ v = 'wrong_item';         w = 8 },
  @{ v = 'changed_mind';     w = 9 },  @{ v = 'subscription_charge'; w = 5 }
)

function Build-Refunds([int]$count, [datetime]$from, [datetime]$to, [string]$prefix, [double]$partialShare) {
  $rows = @()
  $span = ($to - $from).Days
  for ($i = 1; $i -le $count; $i++) {
    $day  = $from.AddDays((IntBetween 0 $span))
    $part = (U) -lt $partialShare
    $amt  = $(if ($part) { [math]::Round((Uni 14 52), 2) } else { [math]::Round((Uni 48 129), 2) })
    $rows += [ordered]@{
      refund_id   = ('rf_{0}{1:d3}' -f $prefix, $i)
      order_id    = ('QS-{0}' -f (IntBetween 240000 259999))
      ticket_id   = $(if ((U) -lt 0.88) { 'tk_' + (IntBetween 700000 799999) } else { $null })
      refunded_at = (RandStamp $day)
      amount_usd  = $amt
      refund_type = $(if ($part) { 'partial' } else { 'full' })
      reason      = (PickWeighted $refundReasons)
      agent_id    = $(if ((U) -lt 0.94) { (Pick $agentIds) } else { $null })
    }
  }
  return ,($rows | Sort-Object { $_.refunded_at })
}

# Reembolsos por semana acompanham o volume e pioram junto com a operação.
# O prefixo do id carrega a semana, para os ids seguirem únicos entre semanas.
$refundRows = @()
for ($wk = 0; $wk -lt $WEEKS; $wk++) {
  $ini = $DataStart.AddDays(7 * $wk)
  $n   = [int][math]::Round((WeekVolume $wk) / 1046.0 * 56.0 * (1.0 + ((Quality $wk) - 1.0) * 0.8) * (Uni 0.92 1.08))
  $refundRows += Build-Refunds $n $ini ($ini.AddDays(6)) ('w{0:d2}_' -f $wk) (Uni 0.38 0.45)
}
WriteJson 'refunds.json' (JRows ([ordered]@{ schema = 'refunds/1'; currency = 'USD' }) 'refunds' $refundRows)

# ========================================================== replacements.json

$replReasons = @(
  @{ v = 'not_delivered'; w = 26 }, @{ v = 'damaged_in_transit'; w = 28 },
  @{ v = 'quality_issue'; w = 18 }, @{ v = 'wrong_item';         w = 16 },
  @{ v = 'missing_part';  w = 12 }
)

function Build-Replacements([int]$count, [datetime]$from, [datetime]$to, [string]$prefix, [double]$secondShare) {
  $rows = @()
  $span = ($to - $from).Days
  for ($i = 1; $i -le $count; $i++) {
    $day = $from.AddDays((IntBetween 0 $span))
    $rows += [ordered]@{
      replacement_id        = ('rp_{0}{1:d3}' -f $prefix, $i)
      original_order_id     = ('QS-{0}' -f (IntBetween 240000 259999))
      replacement_order_id  = ('QS-{0}' -f (IntBetween 260000 264999))
      ticket_id             = $(if ((U) -lt 0.91) { 'tk_' + (IntBetween 700000 799999) } else { $null })
      created_at            = (RandStamp $day)
      supplier_cost_usd     = [math]::Round((Uni 9.4 23.8), 2)
      shipping_cost_usd     = [math]::Round((Uni 4.2 11.6), 2)
      reason                = (PickWeighted $replReasons)
      is_second_replacement = ((U) -lt $secondShare)
      agent_id              = $(if ((U) -lt 0.93) { (Pick $agentIds) } else { $null })
    }
  }
  return ,($rows | Sort-Object { $_.created_at })
}

$replRows = @()
for ($wk = 0; $wk -lt $WEEKS; $wk++) {
  $ini = $DataStart.AddDays(7 * $wk)
  $n   = [int][math]::Round((WeekVolume $wk) / 1046.0 * 42.0 * (1.0 + ((Quality $wk) - 1.0) * 0.85) * (Uni 0.92 1.08))
  $replRows += Build-Replacements $n $ini ($ini.AddDays(6)) ('w{0:d2}_' -f $wk) (0.11 + ((Quality $wk) - 1.0) * 0.14)
}
WriteJson 'replacements.json' (JRows ([ordered]@{ schema = 'replacements/1'; currency = 'USD' }) 'replacements' $replRows)

# =========================================================== chargebacks.json

$cbReasons = @(
  @{ v = 'fraud_unauthorised';        w = 26 }, @{ v = 'product_not_received';       w = 22 },
  @{ v = 'subscription_not_cancelled'; w = 18 }, @{ v = 'product_not_as_described';  w = 14 },
  @{ v = 'duplicate_charge';          w = 8 },  @{ v = 'unrecognised_descriptor';    w = 7 },
  @{ v = 'credit_not_processed';      w = 5 }
)
$cbNetworks = @(@{ v = 'visa'; w = 44 }, @{ v = 'mastercard'; w = 33 }, @{ v = 'amex'; w = 12 }, @{ v = 'paypal'; w = 11 })

# Uma disputa leva semanas para o banco decidir. Então a chance de ainda estar
# pendente no dia do retrato depende de quanto tempo faz que ela foi aberta —
# não é uma fatia fixa. Disputa de maio já foi decidida; da semana passada, não.
function Build-Chargebacks([int]$count, [datetime]$from, [datetime]$to, [string]$prefix) {
  $rows = @()
  $span = ($to - $from).Days
  for ($i = 1; $i -le $count; $i++) {
    $day      = $from.AddDays((IntBetween 0 $span))
    $age      = ($PeriodEnd - $day).Days
    $pPending = $(if ($age -lt 14) { 0.80 } elseif ($age -lt 45) { 0.35 } else { 0.04 })
    $pending  = (U) -lt $pPending

    # A decisão nunca pode cair no dia do retrato ou depois dele.
    $decidedOn = $day.AddDays((IntBetween 6 38))
    if ($decidedOn -ge $PeriodEnd) { $pending = $true }

    if ($pending) {
      $status = $(if ((U) -lt 0.55) { 'open' } else { 'under_review' })
      $resolved = $null
      $repr = ($status -eq 'under_review')
    } else {
      $status = PickWeighted @(@{ v = 'won'; w = 46 }, @{ v = 'lost'; w = 38 }, @{ v = 'accepted'; w = 16 })
      $resolved = (RandStamp $decidedOn)
      $repr = ($status -ne 'accepted')
    }
    $rows += [ordered]@{
      chargeback_id = ('cb_{0}{1:d3}' -f $prefix, $i)
      order_id      = ('QS-{0}' -f (IntBetween 200000 259999))
      opened_at     = (RandStamp $day)
      resolved_at   = $resolved
      amount_usd    = [math]::Round((Uni 41 178), 2)
      fee_usd       = 15.0
      reason        = (PickWeighted $cbReasons)
      status        = $status
      network       = (PickWeighted $cbNetworks)
      represented   = $repr
    }
  }
  return ,$rows
}

# Quantidade por semana = pedidos x taxa, e a taxa piora com a operação: cliente
# que não recebe resposta abre disputa no banco. A liquidação traz fraude junto.
$cbRows = @()
for ($wk = 0; $wk -lt $WEEKS; $wk++) {
  $ini  = $DataStart.AddDays(7 * $wk)
  $rate = 0.0064 * (1.0 + ((Quality $wk) - 1.0) * 1.2)
  if ($wk -eq $PROMO_WEEK) { $rate *= 1.3 }
  $n = [int][math]::Round((WeekOrders $wk) * $rate * (Uni 0.85 1.15))
  $cbRows += Build-Chargebacks $n $ini ($ini.AddDays(6)) ('w{0:d2}_' -f $wk)
}
$cbRows = @($cbRows | Sort-Object { $_.opened_at })
WriteJson 'chargebacks.json' (JRows ([ordered]@{ schema = 'chargebacks/1'; currency = 'USD'; snapshot_at = $SnapshotAt }) 'chargebacks' $cbRows)

# ================================================================= queue.json
# Snapshot: o estado da fila no instante em que a semana fechou.

$BACKLOG = 214
$agingU24 = 118; $aging2472 = 63; $aging72 = $BACKLOG - $agingU24 - $aging2472   # particiona o backlog

# Backlog por motivo — reparte os 214 respeitando as fatias, com a sobra no maior.
$backlogByReason = @()
$assigned = 0
for ($i = 0; $i -lt $reasons.Count; $i++) {
  $r = $reasons[$i]
  if ($i -eq 0) { continue }
  $n = [int][math]::Round($BACKLOG * $r.share * (Uni 0.85 1.2))
  $assigned += $n
  $backlogByReason += [ordered]@{ reason = $r.reason; backlog = $n; over_24h_unanswered = [int][math]::Round($n * (Uni 0.14 0.30)) }
}
$first = [ordered]@{ reason = $reasons[0].reason; backlog = ($BACKLOG - $assigned); over_24h_unanswered = 0 }
$first.over_24h_unanswered = [int][math]::Round($first.backlog * 0.19)
$backlogByReason = @($first) + $backlogByReason
$OVER24 = 0; foreach ($b in $backlogByReason) { $OVER24 += $b.over_24h_unanswered }

# Agentes do dia do snapshot: repartimos o pool real de FRT daquele dia, entao
# a mediana por agente e a mediana do dia saem do mesmo conjunto de numeros.
$snapDay    = D $PeriodEnd
$snapPool   = Shuffle $frtByDay[$snapDay]
$answeredToday = $snapPool.Count
$snapClosed = $closedByDay[$snapDay]
$snapReopen = $reopenByDay[$snapDay]

$agentRows = @()
$cursor = 0; $closedLeft = $snapClosed; $reopenLeft = $snapReopen
for ($i = 0; $i -lt $agents.Count; $i++) {
  $a = $agents[$i]
  if ($i -eq $agents.Count - 1) { $take = $answeredToday - $cursor }
  else { $take = [int][math]::Round($answeredToday * $a.weight) }
  if ($take -lt 0) { $take = 0 }
  if ($cursor + $take -gt $answeredToday) { $take = $answeredToday - $cursor }

  $slice = @(); for ($k = 0; $k -lt $take; $k++) { $slice += $snapPool[$cursor + $k] }
  $cursor += $take

  if ($i -eq $agents.Count - 1) { $cl = $closedLeft; $ro = $reopenLeft }
  else {
    $cl = [int][math]::Round($snapClosed * $a.weight * (Uni 0.9 1.1)); if ($cl -gt $closedLeft) { $cl = $closedLeft }
    $ro = [int][math]::Round($snapReopen * $a.weight * (Uni 0.7 1.4)); if ($ro -gt $reopenLeft) { $ro = $reopenLeft }
  }
  if ($cl -lt 0) { $cl = 0 }; if ($ro -lt 0) { $ro = 0 }
  $closedLeft -= $cl; $reopenLeft -= $ro

  $agentRows += [ordered]@{
    agent_id = $a.agent_id; agent_name = $a.agent_name
    answered = $take; closed = $cl; reopened = $ro; frt_hours = $slice
  }
}

$critReasons = @(
  @{ v = 'no_reply_over_24h'; w = 32 }, @{ v = 'waiting_over_3_days'; w = 24 },
  @{ v = 'reopened';          w = 16 }, @{ v = 'refund_requested';    w = 14 },
  @{ v = 'escalated';         w = 14 }
)
# O número de opções por motivo precisa continuar o mesmo: Pick() sorteia um
# índice dentro do array, então mudar a quantidade deslocaria todos os sorteios
# seguintes e os números do relatório inteiro mudariam.
$subjects = @{
  order_status        = @('Order stuck in tracking for 9 days', 'Tracking number is not updating', 'Where is my order?', 'Tracking stopped in transit')
  delivery_issue      = @('Marked as delivered but I never got it', 'Package returned to sender', 'Wrong address on the label')
  subscription        = @('Charged after cancelling my subscription', 'I want to skip the next cycle', 'Duplicate subscription')
  product_question    = @('Can I use it with retinol?', 'How many times per week?', 'Is it safe for sensitive skin?')
  refund_request      = @('Refund still has not landed', 'I want a full refund on this order', 'Agreed partial refund never arrived')
  cancel_change_order = @('Cancel before it ships', 'Change my delivery address', 'Change the variant on my order')
  adverse_reaction    = @('Burning and redness after use', 'Itching around the eye area', 'Skin reaction on the second day')
  damaged_item        = @('Box crushed and sachet punctured', 'Product arrived leaking', 'Seal was broken on arrival')
  wrong_item          = @('Received the wrong variant', 'One item missing from the kit', 'Got 2 of 3 units')
  promo_discount      = @('Coupon did not apply at checkout', 'Charged without the bundle discount', 'Free gift missing from my order')
}
$customers = @('Hannah Weiss','Chloe Bennett','Aisha Rahman','Megan Torres','Julia Sandberg','Nora Lindqvist',
               'Rachel Kim','Fatima Zahra','Emily Carter','Sarah Nakamura','Isabel Moreau','Grace O''Donnell',
               'Leah Abrams','Camila Duarte','Tessa Boone','Ingrid Halvorsen')

$critRows = @()
for ($i = 1; $i -le 14; $i++) {
  $r        = PickWeighted (@($reasons | ForEach-Object { @{ v = $_.reason; w = $_.share * 100 } }))
  $created  = $PeriodEnd.AddDays(-1 * (IntBetween 1 9))
  $why      = PickWeighted $critReasons
  $noReply  = ($why -eq 'no_reply_over_24h')
  $critRows += [ordered]@{
    ticket_id           = ('tk_{0}' -f (IntBetween 700000 799999))
    reason              = $r
    subject             = (Pick $subjects[$r])
    customer            = (Pick $customers)
    order_id            = ('QS-{0}' -f (IntBetween 240000 259999))
    created_at          = (RandStamp $created)
    first_human_reply_at = $(if ($noReply) { $null } else { (RandStamp $created.AddDays((IntBetween 0 2))) })
    status              = $(if ((U) -lt 0.62) { 'open' } else { 'pending' })
    assignee_id         = $(if ((U) -lt 0.72) { (Pick $agentIds) } else { $null })
    escalation_reason   = $why
  }
}
$critRows = @($critRows | Sort-Object { $_.created_at })

$oldest = [ordered]@{
  ticket_id = 'tk_741208'
  reason    = 'delivery_issue'
  subject   = 'Pacote devolvido ao remetente sem aviso'
  created_at = '2026-08-26T04:12:00' + $TZ
  status    = 'pending'
  assignee_id = $null
}

$queueSb = [System.Text.StringBuilder]::new()
[void]$queueSb.AppendLine('{')
[void]$queueSb.AppendLine('  "schema": "queue/1",')
[void]$queueSb.AppendLine('  "snapshot_at": ' + (JStr $SnapshotAt) + ',')
[void]$queueSb.AppendLine('  "summary": ' + (JObj ([ordered]@{
    backlog = $BACKLOG
    unassigned = 38
    over_24h_unanswered = $OVER24
    answered_today = $answeredToday
    aging = [ordered]@{ under_24h = $agingU24; h24_to_72h = $aging2472; over_72h = $aging72 }
    oldest_ticket = $oldest
  })) + ',')
[void]$queueSb.AppendLine('  "by_reason": [')
for ($i = 0; $i -lt $backlogByReason.Count; $i++) {
  $c = $(if ($i -lt $backlogByReason.Count - 1) { ',' } else { '' })
  [void]$queueSb.AppendLine('    ' + (JObj $backlogByReason[$i]) + $c)
}
[void]$queueSb.AppendLine('  ],')
[void]$queueSb.AppendLine('  "critical": [')
for ($i = 0; $i -lt $critRows.Count; $i++) {
  $c = $(if ($i -lt $critRows.Count - 1) { ',' } else { '' })
  [void]$queueSb.AppendLine('    ' + (JObj $critRows[$i]) + $c)
}
[void]$queueSb.AppendLine('  ],')
[void]$queueSb.AppendLine('  "agents": [')
for ($i = 0; $i -lt $agentRows.Count; $i++) {
  $c = $(if ($i -lt $agentRows.Count - 1) { ',' } else { '' })
  [void]$queueSb.AppendLine('    ' + (JObj $agentRows[$i]) + $c)
}
[void]$queueSb.AppendLine('  ]')
[void]$queueSb.Append('}')
WriteJson 'queue.json' $queueSb.ToString()

# ================================================================== meta.json

$meta = [System.Text.StringBuilder]::new()
[void]$meta.AppendLine('{')
[void]$meta.AppendLine('  "schema": "meta/1",')
[void]$meta.AppendLine('  "brand": ' + (JObj ([ordered]@{
    name = 'Quasi'; legal_name = 'Quasi Beauty'; site = 'https://officialquasi.com'
    helpdesk = 'commslayer'; ecommerce = 'shopify'; currency = 'USD'
  })) + ',')
[void]$meta.AppendLine('  "generated_at": ' + (JStr $GeneratedAt) + ',')
[void]$meta.AppendLine('  "reporting_timezone": "America/Sao_Paulo",')
[void]$meta.AppendLine('  "data_start": ' + (JStr (D $DataStart)) + ',')
[void]$meta.AppendLine('  "data_end": ' + (JStr (D $PeriodEnd)) + ',')
[void]$meta.AppendLine('  "period_start": ' + (JStr (D $PeriodStart)) + ',')
[void]$meta.AppendLine('  "period_end": ' + (JStr (D $PeriodEnd)) + ',')
[void]$meta.AppendLine('  "targets": {')
$targets = [ordered]@{
  frt_median_hours        = [ordered]@{ label='First response (median)';  unit='hours';   goal=4;    warning=7;   direction='lower_is_better' }
  pct_answered_under_24h  = [ordered]@{ label='Answered within 24h';      unit='percent'; goal=92;   warning=85;  direction='higher_is_better' }
  resolution_median_hours = [ordered]@{ label='Resolution (median)';      unit='hours';   goal=20;   warning=32;  direction='lower_is_better' }
  backlog                 = [ordered]@{ label='Queue at period end';      unit='tickets'; goal=180;  warning=260; direction='lower_is_better' }
  over_24h_unanswered     = [ordered]@{ label='Open 24h+ with no reply';  unit='tickets'; goal=20;   warning=40;  direction='lower_is_better' }
  reopen_rate             = [ordered]@{ label='Reopen rate';              unit='percent'; goal=4.5;  warning=6.5; direction='lower_is_better' }
  refund_rate             = [ordered]@{ label='Refund rate';              unit='percent'; goal=2.2;  warning=3;   direction='lower_is_better' }
  chargeback_rate         = [ordered]@{ label='Chargeback rate';          unit='percent'; goal=0.5;  warning=0.9; direction='lower_is_better' }
}
$tk = @($targets.Keys)
for ($i = 0; $i -lt $tk.Count; $i++) {
  $c = $(if ($i -lt $tk.Count - 1) { ',' } else { '' })
  [void]$meta.AppendLine('    ' + (JStr $tk[$i]) + ': ' + (JObj $targets[$tk[$i]]) + $c)
}
[void]$meta.AppendLine('  }')
[void]$meta.Append('}')
WriteJson 'meta.json' $meta.ToString()

# ============================================================== conferência
# Recalcula do zero o que a interface vai calcular, para o gerador nunca
# entregar um arquivo que a propria página acusaria como inconsistente.

function Median($values) {
  $s = @($values | Sort-Object)
  if ($s.Count -eq 0) { return $null }
  $mid = [int][math]::Floor($s.Count / 2)
  if ($s.Count % 2 -eq 1) { return $s[$mid] }
  return ($s[$mid - 1] + $s[$mid]) / 2.0
}

$curFrt = New-Object System.Collections.ArrayList
$curRes = New-Object System.Collections.ArrayList
$curAnswered = 0; $curClosed = 0; $curCreated = 0; $curReopened = 0
$badLen = 0
foreach ($row in $ticketRows) {
  if ($row.frt_hours.Count -ne $row.answered -or $row.resolution_hours.Count -ne $row.closed) { $badLen++ }
  if ([datetime]$row.date -lt $PeriodStart) { continue }
  $curCreated += $row.created; $curAnswered += $row.answered; $curClosed += $row.closed; $curReopened += $row.reopened
  foreach ($v in $row.frt_hours) { [void]$curFrt.Add($v) }
  foreach ($v in $row.resolution_hours) { [void]$curRes.Add($v) }
}
$under24 = 0; foreach ($v in $curFrt) { if ($v -lt 24) { $under24++ } }

$curRefundSum = 0.0
foreach ($rf in $refundRows) { if ([datetime]::Parse($rf.refunded_at) -ge $PeriodStart) { $curRefundSum += $rf.amount_usd } }
$cbOpenedCur = 0
foreach ($cb in $cbRows) { if ([datetime]::Parse($cb.opened_at) -ge $PeriodStart) { $cbOpenedCur++ } }

$agentSum = 0; foreach ($a in $agentRows) { $agentSum += $a.answered }

Write-Host ''
Write-Host 'Conferência dos invariantes' -ForegroundColor Magenta
Write-Host ('  arrays com tamanho errado ........ {0}' -f $badLen)
Write-Host ('  aging soma backlog ............... {0}' -f (($agingU24 + $aging2472 + $aging72) -eq $BACKLOG))
Write-Host ('  agentes somam answered_today ..... {0}  ({1} de {2})' -f ($agentSum -eq $answeredToday), $agentSum, $answeredToday)
Write-Host ''
Write-Host 'Números do período atual' -ForegroundColor Magenta
Write-Host ('  criados / respondidos / fechados .. {0} / {1} / {2}' -f $curCreated, $curAnswered, $curClosed)
Write-Host ('  FRT mediana ....................... {0:N2} h' -f (Median $curFrt))
Write-Host ('  respondidos em ate 24h ............ {0:N1} %' -f (100.0 * $under24 / $curFrt.Count))
Write-Host ('  resolução mediana ................. {0:N2} h' -f (Median $curRes))
Write-Host ('  taxa de reabertura ................ {0:N2} %' -f (100.0 * $curReopened / $curClosed))
Write-Host ('  receita / pedidos ................. US$ {0:N0} / {1:N0}' -f $curRevenue, $curOrders)
Write-Host ('  reembolsos ........................ US$ {0:N0}  ->  {1:N2} %' -f $curRefundSum, (100.0 * $curRefundSum / $curRevenue))
Write-Host ('  chargebacks abertos ............... {0}  ->  {1:N2} %' -f $cbOpenedCur, (100.0 * $cbOpenedCur / $curOrders))
Write-Host ('  fila / +24h sem resposta .......... {0} / {1}' -f $BACKLOG, $OVER24)
Write-Host ''
Write-Host 'Cobertura' -ForegroundColor Magenta
$retrato = [datetime]::Parse($SnapshotAt)
$cbDepois = @($cbRows | Where-Object { $_.resolved_at -and ([datetime]::Parse($_.resolved_at) -gt $retrato) }).Count
Write-Host ('  dias ............................... {0}  ({1} semanas)' -f $allDays.Count, $WEEKS)
Write-Host ('  linhas diárias por motivo .......... {0}' -f $ticketRows.Count)
Write-Host ('  reembolsos / reposições / disputas . {0} / {1} / {2}' -f $refundRows.Count, $replRows.Count, $cbRows.Count)
Write-Host ('  disputa decidida após o retrato .... {0}' -f $cbDepois)
Write-Host ''
