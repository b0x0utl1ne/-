# 把当前仓库发布到 GitHub（SSH，走 443 端口）
# 用法：
#   .\scripts\publish-github.ps1 -Owner <GitHub用户名> -Repo <仓库名>
#   .\scripts\publish-github.ps1 -Owner <GitHub用户名> -Repo <仓库名> -Message "本次改动说明"
#
# 前提：
#   1. 已把 ~/.ssh/id_ed25519.pub 加到 GitHub → Settings → SSH and GPG keys
#   2. 已在 GitHub 上建好同名空仓库（不要勾 README）

param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$portableGit = Join-Path $env:USERPROFILE "tools\PortableGit\cmd\git.exe"
$git = if (Test-Path $portableGit) { $portableGit } else { "git" }
$ssh = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
if (-not (Test-Path $ssh)) { $ssh = "ssh" }

Push-Location $repoRoot
try {
  if ($Message) {
    & $git add -A
    & $git commit -m $Message
  }

  Write-Host "检查 SSH 认证…"
  $auth = (& $ssh -T -o ConnectTimeout=20 git@github.com 2>&1 | Out-String)
  if ($auth -notmatch "successfully authenticated") {
    Write-Host $auth
    throw "SSH 认证没通过：先把公钥加到 GitHub（Settings → SSH and GPG keys）。"
  }

  $url = "git@github.com:$Owner/$Repo.git"
  $remotes = @(& $git remote)
  if ($remotes -contains "origin") {
    & $git remote set-url origin $url
  } else {
    & $git remote add origin $url
  }

  Write-Host "推送到 $url …"
  & $git push -u origin main
  Write-Host "完成。"
} finally {
  Pop-Location
}
