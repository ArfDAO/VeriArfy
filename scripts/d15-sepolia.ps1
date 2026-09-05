#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "readiness",
    "preflight",
    "deploy",
    "stake-node-1",
    "stake-node-2",
    "prepare",
    "node-1",
    "node-2",
    "complete"
  )]
  [string]$Stage,

  [string]$QueryId,
  [string]$RequestId,
  [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "packages\contracts\ops\d15-sepolia.json"
$profile = Get-Content -Raw -LiteralPath $profilePath | ConvertFrom-Json

if ($profile.profile -ne "d15-sepolia-2of2-ml") {
  throw "Beklenmeyen D15 profile: $($profile.profile)"
}
if ($profile.network -ne "sepolia" -or [int64]$profile.chainId -ne 11155111) {
  throw "D15 terminal akisi yalniz Sepolia chainId 11155111 icindir."
}
if (@($profile.authorizedNodes).Count -ne 2) {
  throw "D15 terminal akisi tam iki node bekler."
}

function Remove-EnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
}

function Clear-SignerEnvironment {
  Remove-EnvironmentValue "DEPLOYER_PRIVATE_KEY"
  Remove-EnvironmentValue "NODE_PRIVATE_KEY"
}

function Clear-StageEnvironment {
  Remove-EnvironmentValue "D15_EXECUTION_ACK"
  Remove-EnvironmentValue "D15_NODE_ROLE"
  Remove-EnvironmentValue "LIVE_CHECK_STAGE"
  Remove-EnvironmentValue "LIVE_CHECK_QUERY_TYPE"
  Remove-EnvironmentValue "LIVE_CHECK_QUERY_ID"
  Remove-EnvironmentValue "LIVE_CHECK_REQUEST_ID"
}

function Invoke-Npm {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & npm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm komutu exit code $LASTEXITCODE ile basarisiz oldu."
  }
}

function Invoke-WithSigner {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("deployer", "node")]
    [string]$Role,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Clear-SignerEnvironment
  $secure = Read-Host "$Role test-only private key (ekranda gorunmez)" -AsSecureString
  $pointer = [IntPtr]::Zero
  $plain = $null

  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($plain -notmatch "^(0x)?[0-9a-fA-F]{64}$") {
      throw "Private key formati gecersiz; 32-byte hex bekleniyor."
    }
    if (-not $plain.StartsWith("0x", [StringComparison]::OrdinalIgnoreCase)) {
      $plain = "0x$plain"
    }

    if ($Role -eq "deployer") {
      $env:DEPLOYER_PRIVATE_KEY = $plain
    } else {
      $env:NODE_PRIVATE_KEY = $plain
    }
    & $Action
  } finally {
    Clear-SignerEnvironment
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $plain = $null
    if ($null -ne $secure) { $secure.Dispose() }
  }
}

function Confirm-StateChange {
  param(
    [Parameter(Mandatory = $true)][string]$Acknowledgement,
    [Parameter(Mandatory = $true)][string]$Phrase
  )

  if (-not $Execute) {
    Write-Host "DRY-RUN: Bu asama transaction gonderebilir; -Execute verilmedigi icin calistirilmadi."
    Write-Host "Daha sonra: .\scripts\d15-sepolia.ps1 -Stage $Stage -Execute"
    return $false
  }

  Write-Host "UYARI: Bu asama Sepolia test aginda kalici transaction gonderebilir."
  $typed = Read-Host "Devam etmek icin birebir '$Phrase' yazin"
  if ($typed -cne $Phrase) {
    throw "Onay cumlesi eslesmedi; transaction gonderilmedi."
  }
  $env:D15_EXECUTION_ACK = $Acknowledgement
  return $true
}

function Assert-HandoffIds {
  if ($QueryId -notmatch "^[0-9]+$" -or $RequestId -notmatch "^[0-9]+$") {
    throw "Bu asama icin decimal -QueryId ve -RequestId zorunludur."
  }
}

# Profile degerleri publictir. Private key'ler yalniz Invoke-WithSigner icinde,
# maskeli prompt'tan alinip tek child process'e aktarilir ve finally'de silinir.
$env:D15_PROFILE = [string]$profile.profile
$env:HARDHAT_DISABLE_TELEMETRY_PROMPT = "true"
$env:SEPOLIA_RPC_URL = [string]$profile.publicRpcUrl
$env:AUTHORIZED_NODE_ADDRESSES = (@($profile.authorizedNodes) -join ",")
$env:MIN_PARTICIPANTS = [string]$profile.minParticipants
$env:NODE_BASE_STAKE = [string]$profile.nodeBaseStakeWei

# D15 test profile'i deterministik tut; shared .env zaten yuklenmez.
$env:DISCLOSURE_THRESHOLD = "2"
$env:QUERY_BASE_FEE = "1000000"
$env:QUERY_PER_RECORD_FEE = "50000"
$env:LIQUIDITY_SHARE_BPS = "8000"
$env:STAKE_VALUE_THRESHOLD = "250000"
$env:CHALLENGE_PERIOD_BLOCKS = "20"
$env:LIVENESS_TIMEOUT_BLOCKS = "7200"
Remove-EnvironmentValue "PAYMENT_TOKEN"
Remove-EnvironmentValue "STORAGE_ATTESTOR"
Clear-SignerEnvironment
Clear-StageEnvironment

Write-Host "D15 public profile"
Write-Host "  deployer : $($profile.deployer)"
Write-Host "  node-1   : $($profile.authorizedNodes[0])"
Write-Host "  node-2   : $($profile.authorizedNodes[1])"
Write-Host "  query    : ML (2), approvals 2/2"
Write-Host "  min pool : $($profile.minParticipants) (test-only)"
Write-Host "  stage    : $Stage"
Write-Host ""

Push-Location $repoRoot
try {
  switch ($Stage) {
    "readiness" {
      if ($Execute) { throw "readiness salt-okunurdur; -Execute kabul etmez." }
      Invoke-Npm -Arguments @("run", "chain:d15-readiness")
    }
    "preflight" {
      if ($Execute) { throw "preflight salt-okunurdur; -Execute kabul etmez." }
      Invoke-Npm -Arguments @("run", "chain:preflight")
    }
    "deploy" {
      if (-not (Confirm-StateChange "deploy" "DEPLOY SEPOLIA D15")) { return }
      Invoke-WithSigner "deployer" {
        Invoke-Npm -Arguments @("run", "chain:d15-deploy")
      }
    }
    "stake-node-1" {
      $env:D15_NODE_ROLE = "node-1"
      if (-not $Execute) {
        Invoke-Npm -Arguments @("run", "chain:stake-node")
        return
      }
      if (-not (Confirm-StateChange "stake-node-1" "STAKE SEPOLIA NODE-1")) { return }
      Invoke-WithSigner "node" {
        Invoke-Npm -Arguments @("run", "chain:stake-node")
      }
    }
    "stake-node-2" {
      $env:D15_NODE_ROLE = "node-2"
      if (-not $Execute) {
        Invoke-Npm -Arguments @("run", "chain:stake-node")
        return
      }
      if (-not (Confirm-StateChange "stake-node-2" "STAKE SEPOLIA NODE-2")) { return }
      Invoke-WithSigner "node" {
        Invoke-Npm -Arguments @("run", "chain:stake-node")
      }
    }
    "prepare" {
      if (-not (Confirm-StateChange "prepare" "PREPARE SEPOLIA D15")) { return }
      $env:LIVE_CHECK_STAGE = "prepare"
      $env:LIVE_CHECK_QUERY_TYPE = [string]$profile.queryType
      Invoke-WithSigner "deployer" {
        Invoke-Npm -Arguments @("run", "chain:live-check")
      }
    }
    "node-1" {
      Assert-HandoffIds
      if (-not (Confirm-StateChange "node-1" "APPROVE SEPOLIA NODE-1")) { return }
      $env:LIVE_CHECK_STAGE = "node-1"
      $env:LIVE_CHECK_QUERY_ID = $QueryId
      $env:LIVE_CHECK_REQUEST_ID = $RequestId
      Invoke-WithSigner "node" {
        Invoke-Npm -Arguments @("run", "chain:live-check")
      }
    }
    "node-2" {
      Assert-HandoffIds
      if (-not (Confirm-StateChange "node-2" "APPROVE SEPOLIA NODE-2")) { return }
      $env:LIVE_CHECK_STAGE = "node-2"
      $env:LIVE_CHECK_QUERY_ID = $QueryId
      $env:LIVE_CHECK_REQUEST_ID = $RequestId
      Invoke-WithSigner "node" {
        Invoke-Npm -Arguments @("run", "chain:live-check")
      }
    }
    "complete" {
      Assert-HandoffIds
      if (-not (Confirm-StateChange "complete" "COMPLETE SEPOLIA D15")) { return }
      $env:LIVE_CHECK_STAGE = "complete"
      $env:LIVE_CHECK_QUERY_ID = $QueryId
      $env:LIVE_CHECK_REQUEST_ID = $RequestId
      Invoke-WithSigner "deployer" {
        Invoke-Npm -Arguments @("run", "chain:live-check")
      }
    }
  }
} finally {
  Clear-SignerEnvironment
  Clear-StageEnvironment
  Pop-Location
}
