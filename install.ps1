# Instalador do Quebra-galho para Windows 10/11 (PowerShell 5.1 ou 7+), sem administrador.
#   Remoto: irm https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main/install.ps1 | iex
#   Clone:  powershell -ExecutionPolicy Bypass -File .\install.ps1
# Variaveis: QUEBRAGALHO_BIN_DIR (onde fica o comando), QUEBRAGALHO_NO_PROMPT=1 (sem perguntas),
#            QUEBRAGALHO_NO_MODIFY_PATH=1 (nao altera o PATH), QUEBRAGALHO_RAW_URL (origem dos arquivos).
# Este arquivo e so ASCII de proposito: os acentos das mensagens vao como \uXXXX e viram texto em Msg,
# para funcionar igual em "irm | iex" e em "-File" no PowerShell 5.1, com ou sem BOM.
# Tudo fica dentro de uma funcao: nao usamos "exit", que fecharia o terminal de quem roda "| iex".

function Msg([string]$text) { [regex]::Unescape($text) }

function Install-Quebragalho {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $marker = 'quebragalho-installer:managed'
  $rawUrl = if ($env:QUEBRAGALHO_RAW_URL) { $env:QUEBRAGALHO_RAW_URL.TrimEnd('/') } else { 'https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main' }
  $files = 'quebragalho.mjs', 'lib/catalog.mjs', 'lib/claude-setup.mjs', 'lib/commands.mjs', 'lib/context.mjs', 'lib/device.mjs', 'lib/doctor.mjs', 'lib/exec.mjs', 'lib/format.mjs', 'lib/gateway.mjs', 'lib/harness.mjs', 'lib/launch.mjs', 'lib/login.mjs', 'lib/proc.mjs', 'lib/util.mjs', 'lib/vault.mjs'

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw (Msg 'quebragalho: instale o Node.js 22+ primeiro: https://nodejs.org') }
  $version = (& node --version).Trim().TrimStart('v')
  if ([int]$version.Split('.')[0] -lt 22) { throw (Msg 'quebragalho: requer Node.js 22+.') }

  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $binDir = if ($env:QUEBRAGALHO_BIN_DIR) { $env:QUEBRAGALHO_BIN_DIR } else { Join-Path $localAppData 'Programs\quebragalho' }
  $appDir = Join-Path $binDir 'quebragalho-app'
  $launcher = Join-Path $binDir 'quebragalho.cmd'

  # So sobrescreve o que e nosso: marcador nas primeiras linhas e nunca um link.
  if (Test-Path -LiteralPath $launcher) {
    $item = Get-Item -LiteralPath $launcher -Force
    $ours = (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) -and ((Get-Content -LiteralPath $launcher -TotalCount 5) -match [regex]::Escape($marker))
    if (-not $ours) { throw ((Msg 'quebragalho: j\u00e1 existe {0} e ele n\u00e3o \u00e9 do Quebra-galho; instala\u00e7\u00e3o interrompida para preservar o arquivo.') -f $launcher) }
  }
  if (Test-Path -LiteralPath $appDir) {
    if ((Get-Item -LiteralPath $appDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ((Msg 'quebragalho: {0} \u00e9 um link; instala\u00e7\u00e3o interrompida.') -f $appDir) }
    $managed = Test-Path -LiteralPath (Join-Path $appDir '.managed')
    $empty = -not (Get-ChildItem -LiteralPath $appDir -Force | Select-Object -First 1)
    if (-not ($managed -or $empty)) { throw ((Msg 'quebragalho: j\u00e1 existe {0} e ele n\u00e3o \u00e9 do Quebra-galho.') -f $appDir) }
  }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $token = [Guid]::NewGuid().ToString('N')
  $stage = Join-Path $binDir ".stage-$token"
  $old = Join-Path $binDir ".old-$token"
  $newLauncher = Join-Path $binDir ".quebragalho-new-$token.cmd"
  try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $source = $null
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'quebragalho.mjs')) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'lib'))) { $source = $PSScriptRoot }
    if (-not $source -and -not $rawUrl.StartsWith('https://')) { throw (Msg 'quebragalho: QUEBRAGALHO_RAW_URL deve usar HTTPS.') }
    foreach ($file in $files) {
      $target = Join-Path $stage ($file -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      if ($source) { Copy-Item -LiteralPath (Join-Path $source ($file -replace '/', '\')) -Destination $target }
      else {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$rawUrl/$file" -OutFile $target }
        catch { throw ((Msg 'quebragalho: falha ao baixar {0} ({1}); nada foi instalado.') -f $file, $_.Exception.Message) }
      }
      if (-not (Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -eq 0) { throw ((Msg 'quebragalho: arquivo vazio: {0}; nada foi instalado.') -f $file) }
    }
    [IO.File]::WriteAllText((Join-Path $stage '.managed'), "managed by $marker`r`n")

    # ASCII puro: o cmd.exe le o arquivo na codepage do console.
    $lines = '@echo off', "rem $marker (gerado por install.ps1; reinstale para atualizar)", 'setlocal',
      'set "NoDefaultCurrentDirectoryInExePath=1"', 'set "QUEBRAGALHO_LAUNCHER=%~f0"', 'node "%~dp0quebragalho-app\quebragalho.mjs" %*', 'exit /b %ERRORLEVEL%'
    [IO.File]::WriteAllText($newLauncher, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))

    if (Test-Path -LiteralPath $appDir) { Move-Item -LiteralPath $appDir -Destination $old }
    try { Move-Item -LiteralPath $stage -Destination $appDir }
    catch {
      # Devolve a instalacao anterior antes de falhar.
      if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $appDir)) { Move-Item -LiteralPath $old -Destination $appDir }
      throw
    }
    Move-Item -LiteralPath $newLauncher -Destination $launcher -Force
  }
  finally {
    foreach ($path in $stage, $old, $newLauncher) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue } }
  }
  Write-Host ((Msg 'Instalado em {0} (arquivos em {1})') -f $launcher, $appDir)

  Add-ToUserPath $binDir
  Show-NextSteps $launcher
}

# PATH do usuario pelo registro, sem expandir variaveis existentes (igual ao uv e ao rustup).
function Add-ToUserPath([string]$directory) {
  $normalize = { param($p) [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\').ToLowerInvariant() }
  if (-not ($env:Path.Split(';') | Where-Object { $_ -and ((& $normalize $_) -eq (& $normalize $directory)) })) { $env:Path = "$env:Path;$directory" }
  if ($env:QUEBRAGALHO_NO_MODIFY_PATH) { Write-Host ((Msg 'Adicione {0} ao PATH para usar o comando quebragalho.') -f $directory); return }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($current.Split(';') | Where-Object { $_ })
    if ($entries | Where-Object { (& $normalize $_) -eq (& $normalize $directory) }) { return }
    $key.SetValue('Path', (($entries + $directory) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
  finally { $key.Close() }
  # Avisa o Windows da mudanca (variavel descartavel) para novos terminais enxergarem o PATH.
  [Environment]::SetEnvironmentVariable('QUEBRAGALHO_NOTIFY', '1', 'User')
  [Environment]::SetEnvironmentVariable('QUEBRAGALHO_NOTIFY', $null, 'User')
  Write-Host ((Msg 'PATH do usu\u00e1rio atualizado com {0}. Abra um novo terminal para usar o comando quebragalho.') -f $directory)
}

function Show-NextSteps([string]$launcher) {
  $interactive = (-not $env:QUEBRAGALHO_NO_PROMPT) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
  if (-not $interactive) { Write-Host (Msg 'Pr\u00f3ximo passo: quebragalho login (depois: quebragalho doctor)'); return }
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    $question = Msg 'Configurar agora um perfil Claude separado do Quebra-galho (inclui o login)? [S/n] '
    $action = @('setup', 'claude')
  }
  else {
    $question = Msg 'Entrar na sua conta Quebra-galho agora? [S/n] '
    $action = @('login')
  }
  try { $choice = Read-Host $question } catch { Write-Host ((Msg 'Quando quiser: quebragalho {0}') -f ($action -join ' ')); return }
  if ($choice -match '^(|s|S|y|Y)$') {
    & $launcher @action
    if ($LASTEXITCODE -ne 0) { Write-Host ((Msg 'N\u00e3o conclu\u00eddo. Quando quiser: quebragalho {0}') -f ($action -join ' ')) }
  }
  else { Write-Host ((Msg 'Quando quiser: quebragalho {0}') -f ($action -join ' ')) }
}

Install-Quebragalho
