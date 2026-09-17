<#
  publicar.ps1 — manda as mudanças para o GitHub e atualiza o site.

      powershell -ExecutionPolicy Bypass -File publicar.ps1 "o que mudou"

  Existe porque o Windows PowerShell 5.1 não aceita `&&`, e encadear com `;`
  faria o push acontecer mesmo se o commit tivesse falhado. Aqui cada passo só
  roda se o anterior deu certo.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Mensagem = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Definition)

Write-Host ''

# Nada mudou? Então não há o que publicar.
$sujo = git status --porcelain
if (-not $sujo) {
  Write-Host '  Nenhuma mudança para publicar.' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

Write-Host '  Vai subir:' -ForegroundColor Magenta
git status --short | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
Write-Host ''

if (-not $Mensagem) {
  Write-Host '  Faltou a mensagem. Use:' -ForegroundColor Yellow
  Write-Host '    powershell -ExecutionPolicy Bypass -File publicar.ps1 "o que mudou"' -ForegroundColor DarkGray
  Write-Host ''
  exit 1
}

git add -A
if ($LASTEXITCODE -ne 0) { Write-Host '  Falhou no git add.' -ForegroundColor Red; exit 1 }

# A mensagem vai por arquivo, não por -m: o PowerShell 5.1 repassa mal aspas
# duplas para programas nativos, e uma mensagem com "Sep 6" virava pedaços que o
# git lia como nomes de arquivo.
$tmp = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($tmp, $Mensagem, (New-Object System.Text.UTF8Encoding($false)))
  git commit -F $tmp
  $falhou = $LASTEXITCODE -ne 0
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
if ($falhou) { Write-Host '  Falhou no commit — nada foi enviado.' -ForegroundColor Red; exit 1 }

git push
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  O commit foi feito, mas o push falhou.' -ForegroundColor Red
  Write-Host '  Se alguém mexeu no repositório pelo site, rode antes:' -ForegroundColor DarkGray
  Write-Host '    git pull --rebase' -ForegroundColor DarkGray
  exit 1
}

Write-Host ''
Write-Host '  Enviado. O site se atualiza em 1 a 2 minutos:' -ForegroundColor Green
Write-Host '    https://alineakiyama.github.io/quasi-dashboard/' -ForegroundColor Cyan
Write-Host '  Acompanhe em Actions se quiser ver o build:' -ForegroundColor DarkGray
Write-Host '    https://github.com/alineakiyama/quasi-dashboard/actions' -ForegroundColor DarkGray
Write-Host ''
