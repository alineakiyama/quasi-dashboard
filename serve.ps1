<#
  serve.ps1 — servidor estático mínimo para ver o portal localmente.

      powershell -ExecutionPolicy Bypass -File serve.ps1
      powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 9000

  Existe só porque abrir o index.html com dois cliques não funciona: o navegador
  bloqueia módulos ES e fetch() em file://. Não faz parte do site publicado.
#>

[CmdletBinding()]
param(
  [int]$Port = 8124,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Root = (Resolve-Path $Root).Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml';            '.md' = 'text/markdown; charset=utf-8'
  '.png'  = 'image/png';                '.ico' = 'image/x-icon'
  '.woff2'= 'font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch { Write-Host "Não consegui abrir a porta $Port. Tente -Port 9000." -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host "  Portal Quasi  ->  http://localhost:$Port/" -ForegroundColor Magenta
Write-Host "  servindo $Root" -ForegroundColor DarkGray
Write-Host '  Ctrl+C para parar' -ForegroundColor DarkGray
Write-Host ''

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = Join-Path $Root ($rel -replace '/', '\')

    # Nunca servir nada de fora da raiz, mesmo com ../ no caminho.
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue
    }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host ("  200  /{0}" -f $rel) -ForegroundColor DarkGray
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 — $rel")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host ("  404  /{0}" -f $rel) -ForegroundColor Yellow
    }
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop(); $listener.Close()
}
