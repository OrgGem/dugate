[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This script is deliberately pinned to one new local Vault. It never targets
# du-live-vault, never prints initialization material, and never reads .env.
$containerName = 'du-vault-persistent'
$expectedImage = 'hashicorp/vault@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2'
$expectedVolume = 'du-vault-persistent-data'
$platformNetwork = if ($env:DU_PLATFORM_NETWORK) { $env:DU_PLATFORM_NETWORK } else { 'du-platform-net' }
$baseUri = [Uri]'http://127.0.0.1:18200'
$stateDirectory = Join-Path $PSScriptRoot 'local'
$stateFile = Join-Path $stateDirectory 'du-vault-persistent-init.dpapi.txt'
$configFile = Join-Path $PSScriptRoot 'server.hcl'

function Stop-Safely([string]$Message) {
  $script:safeFailureMessage = $Message
  throw 'Safe Vault bootstrap guard stopped execution.'
}

function Invoke-DockerRead([string[]]$DockerArgs) {
  $output = & docker @DockerArgs 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-Safely 'Read-only Docker target validation failed.' }
  return [string]::Join([Environment]::NewLine, [string[]]$output).Trim()
}

function Set-PrivateAcl([string]$Path, [bool]$IsDirectory) {
  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security = Get-Acl -LiteralPath $Path
  if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $userSid.Value) {
    Stop-Safely 'Recovery-material path is not owned by the current Windows user.'
  }

  $allowedSids = @($userSid.Value, $systemSid.Value)
  $existingRules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $inheritance = if ($IsDirectory) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $alreadyRestricted = $security.AreAccessRulesProtected -and $existingRules.Count -eq 2
  if ($alreadyRestricted) {
    foreach ($sid in $allowedSids) {
      $matching = @($existingRules | Where-Object { $_.IdentityReference.Value -ceq $sid })
      if ($matching.Count -ne 1 -or $matching[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          $matching[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
          $matching[0].InheritanceFlags -ne $inheritance -or
          $matching[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        $alreadyRestricted = $false
        break
      }
    }
  }
  if ($alreadyRestricted) { return }

  $security.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    [void]$security.RemoveAccessRuleSpecific($existingRule)
  }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $userSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $systemSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  Set-Acl -LiteralPath $Path -AclObject $security

  $actual = Get-Acl -LiteralPath $Path
  if (-not $actual.AreAccessRulesProtected) { Stop-Safely 'Protected recovery-material ACL could not be verified.' }
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $userSid.Value -or $rules.Count -ne 2 -or
      @($rules | Where-Object { $_.IdentityReference.Value -notin $allowedSids }).Count -gt 0) {
    Stop-Safely 'Recovery-material ACL contains an unexpected principal.'
  }
}

function ConvertFrom-ProtectedText([string]$ProtectedText) {
  $secureText = ConvertTo-SecureString -String $ProtectedText
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureText)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Protect-Text([string]$PlainText) {
  $secureText = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
  return ConvertFrom-SecureString -SecureString $secureText
}

function Test-PrivatePersistence {
  if (-not (Test-Path -LiteralPath $stateDirectory)) {
    New-Item -ItemType Directory -Path $stateDirectory | Out-Null
  }
  Set-PrivateAcl $stateDirectory $true

  $probe = 'du-vault-dpapi-preflight-only'
  $protectedProbe = Protect-Text $probe
  if ((ConvertFrom-ProtectedText $protectedProbe) -cne $probe) {
    Stop-Safely 'Windows CurrentUser DPAPI preflight failed.'
  }

  $probePath = Join-Path $stateDirectory ('.dpapi-preflight-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($probePath, $protectedProbe, [Text.Encoding]::UTF8)
    Set-PrivateAcl $probePath $false
    $written = [IO.File]::ReadAllText($probePath, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if ((ConvertFrom-ProtectedText $written) -cne $probe) {
      Stop-Safely 'Protected recovery-material write preflight failed.'
    }
  } finally {
    if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath -Force }
  }
}

function Write-InitMaterial([string]$JsonText) {
  if (Test-Path -LiteralPath $stateFile) {
    Stop-Safely 'Protected initialization material already exists; refusing to replace it.'
  }
  $encrypted = Protect-Text $JsonText
  $temporaryFile = Join-Path $stateDirectory ('.vault-init-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporaryFile, $encrypted, [Text.Encoding]::UTF8)
  Set-PrivateAcl $temporaryFile $false
  $onDisk = [IO.File]::ReadAllText($temporaryFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  if ((ConvertFrom-ProtectedText $onDisk) -cne $JsonText) {
    Stop-Safely ('Protected initialization response remains at recovery path: ' + $temporaryFile)
  }
  [IO.File]::Move($temporaryFile, $stateFile)
  Set-PrivateAcl $stateFile $false
  $verified = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  if ((ConvertFrom-ProtectedText $verified) -cne $JsonText) {
    Stop-Safely ('Protected initialization response remains at recovery path: ' + $stateFile)
  }
}

function Recover-InterruptedInitWrite {
  $temporaryFiles = @(Get-ChildItem -LiteralPath $stateDirectory -Filter '.vault-init-*.tmp' -File)
  if ($temporaryFiles.Count -eq 0) { return }
  if (Test-Path -LiteralPath $stateFile) {
    Stop-Safely 'Both canonical and temporary protected recovery files exist; refusing to choose or overwrite either.'
  }
  if ($temporaryFiles.Count -ne 1) {
    Stop-Safely 'Multiple protected recovery temporary files exist; refusing to choose among them.'
  }
  $temporaryFile = $temporaryFiles[0].FullName
  Set-PrivateAcl $temporaryFile $false
  $protected = [IO.File]::ReadAllText($temporaryFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  try {
    $json = ConvertFrom-ProtectedText $protected
    $init = ConvertFrom-Json -InputObject $json
    if (-not $init.root_token -or @($init.keys_base64).Count -ne 5) {
      Stop-Safely ('Protected interrupted initialization response needs operator recovery: ' + $temporaryFile)
    }
  } catch {
    Stop-Safely ('Protected interrupted initialization response needs operator recovery: ' + $temporaryFile)
  }
  [IO.File]::Move($temporaryFile, $stateFile)
  Set-PrivateAcl $stateFile $false
}

function Read-InitMaterial {
  if (-not (Test-Path -LiteralPath $stateFile)) {
    Stop-Safely 'This Vault is initialized but its CurrentUser-protected recovery material is missing.'
  }
  Set-PrivateAcl $stateFile $false
  $protected = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  try { return ConvertFrom-Json -InputObject (ConvertFrom-ProtectedText $protected) }
  catch { Stop-Safely 'CurrentUser-protected recovery material cannot be decrypted by this Windows account.' }
}

function Assert-TargetContainer {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Safely 'Docker CLI is unavailable.' }
  if (-not (Test-Path -LiteralPath $configFile)) { Stop-Safely 'Pinned local Vault configuration is missing.' }
  $image = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{.Config.Image}}', $containerName)
  if ($image -cne $expectedImage) { Stop-Safely 'Target container image does not match the pinned isolated Vault image.' }
  $running = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{.State.Running}}', $containerName)
  if ($running -cne 'true') { Stop-Safely 'The isolated Vault container is not running.' }
  $labels = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{json .Config.Labels}}', $containerName) | ConvertFrom-Json
  if ($labels.'com.dugate.purpose' -cne 'persistent-vault-local-preparation' -or $labels.'com.dugate.bootstrap-guard' -cne 'exact-new-vault') {
    Stop-Safely 'Target container labels do not match the isolated Vault bootstrap contract.'
  }
  $command = @(Invoke-DockerRead @('inspect', '--type=container', '--format', '{{json .Config.Cmd}}', $containerName) | ConvertFrom-Json)
  if ($command.Count -ne 1 -or $command[0] -cne 'server') {
    Stop-Safely 'Target container is not running the pinned non-dev Vault server command.'
  }

  $mountsJson = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{json .Mounts}}', $containerName)
  $mounts = @($mountsJson | ConvertFrom-Json)
  $dataMount = @($mounts | Where-Object { $_.Destination -ceq '/vault/file' -and $_.Type -ceq 'volume' -and $_.Name -ceq $expectedVolume })
  $configMount = @($mounts | Where-Object { $_.Destination -ceq '/vault/config/server.hcl' -and $_.Type -ceq 'bind' -and $_.RW -eq $false })
  if ($dataMount.Count -ne 1 -or $configMount.Count -ne 1) {
    Stop-Safely 'Target container does not use the expected isolated Raft volume and read-only config bind.'
  }
  $configSource = ([string]$configMount[0].Source).Replace('\', '/').ToLowerInvariant()
  if (-not $configSource.EndsWith('/infra/vault/server.hcl')) {
    Stop-Safely 'Target container is not using the repository-pinned Vault configuration.'
  }
  $containerConfig = Invoke-DockerRead @('exec', $containerName, 'cat', '/vault/config/server.hcl')
  $normalizedContainerConfig = $containerConfig.Replace("`r`n", "`n").Trim()
  $normalizedLocalConfig = [IO.File]::ReadAllText($configFile).Replace("`r`n", "`n").Trim()
  if ($normalizedContainerConfig -cne $normalizedLocalConfig) {
    Stop-Safely 'Mounted Vault configuration does not match the reviewed repository config.'
  }

  $portsJson = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{json .HostConfig.PortBindings}}', $containerName)
  $ports = $portsJson | ConvertFrom-Json
  $bindings = @()
  foreach ($property in $ports.PSObject.Properties) {
    foreach ($binding in @($property.Value)) {
      $bindings += [PSCustomObject]@{ ContainerPort = $property.Name; HostIp = $binding.HostIp; HostPort = $binding.HostPort }
    }
  }
  if ($bindings.Count -ne 1 -or $bindings[0].ContainerPort -cne '8200/tcp' -or $bindings[0].HostIp -cne '127.0.0.1' -or $bindings[0].HostPort -cne '18200') {
    Stop-Safely 'Target Vault listener is not bound exclusively to 127.0.0.1:18200.'
  }

  $networkJson = Invoke-DockerRead @('inspect', '--type=container', '--format', '{{json .NetworkSettings.Networks}}', $containerName)
  $networks = $networkJson | ConvertFrom-Json
  $networkEntry = $networks.PSObject.Properties[$platformNetwork]
  if (-not $networkEntry -or @($networkEntry.Value.Aliases) -notcontains 'vault' -or @($networkEntry.Value.Aliases) -notcontains 'du-vault-persistent') {
    Stop-Safely 'Target Vault is not attached to the configured platform network with the vault alias.'
  }
  $volume = Invoke-DockerRead @('volume', 'inspect', '--format', '{{.Name}}', $expectedVolume)
  if ($volume -cne $expectedVolume) { Stop-Safely 'Expected isolated Raft volume is unavailable.' }
  $volumeLabels = Invoke-DockerRead @('volume', 'inspect', '--format', '{{json .Labels}}', $expectedVolume) | ConvertFrom-Json
  if ($volumeLabels.'com.dugate.purpose' -cne 'persistent-vault-raft-data') {
    Stop-Safely 'Raft volume label does not match the isolated Vault contract.'
  }
}

function Invoke-VaultApi([string]$Method, [string]$Path, [object]$Body = $null, [string]$Token = '') {
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), [Uri]::new($baseUri, $Path))
  $response = $null
  if ($Token) { [void]$request.Headers.TryAddWithoutValidation('X-Vault-Token', $Token) }
  if ($null -ne $Body) {
    $json = if ($Body -is [string]) { $Body } else { ConvertTo-Json -InputObject $Body -Depth 12 -Compress }
    $request.Content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
  }
  try {
    $response = $script:httpClient.SendAsync($request).GetAwaiter().GetResult()
    $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      Stop-Safely ("Vault API request failed with HTTP {0}." -f [int]$response.StatusCode)
    }
    if ([string]::IsNullOrWhiteSpace($responseText)) {
      $responseJson = $null
    } else {
      try { $responseJson = ConvertFrom-Json -InputObject $responseText }
      catch { Stop-Safely 'Vault API returned an unreadable response.' }
    }
    return [PSCustomObject]@{ Json = $responseJson; Raw = $responseText }
  } finally {
    $request.Dispose()
    if ($response) { $response.Dispose() }
  }
}

function Wait-ForVaultReady {
  $originalClient = $script:httpClient
  $readinessClient = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  try {
    # HttpClient.Timeout cannot be changed after the first request has started.
    # Use a separate short-timeout client for bounded readiness polling.
    $readinessClient = [Net.Http.HttpClient]::new()
    $readinessClient.Timeout = [TimeSpan]::FromSeconds(2)
    $script:httpClient = $readinessClient
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $status = (Invoke-VaultApi 'GET' '/v1/sys/seal-status').Json
        if ($status.initialized -eq $true -and $status.sealed -eq $false -and $status.storage_type -ceq 'raft') {
          # seal-status can flip before Raft has replayed enough state to serve
          # authenticated mount operations. Require health to return HTTP 200.
          $health = (Invoke-VaultApi 'GET' '/v1/sys/health').Json
          if ($health.initialized -eq $true -and $health.sealed -eq $false -and $health.standby -eq $false) {
            return $status
          }
        }
      } catch {
        # A just-unsealed Raft leader can briefly return 5xx while its state is
        # replaying. Retry only unauthenticated readiness reads; never init.
        $script:safeFailureMessage = $null
      }
      Start-Sleep -Milliseconds 500
    }
    Stop-Safely 'Vault did not become healthy after unseal; recovery material remains protected for a safe retry.'
  } finally {
    $script:httpClient = $originalClient
    if ($readinessClient) { $readinessClient.Dispose() }
  }
}

try {
  $script:safeFailureMessage = $null
  $script:httpClient = $null
  if ($env:OS -ne 'Windows_NT') { Stop-Safely 'DPAPI bootstrap is supported only on Windows.' }
  Test-PrivatePersistence
  Assert-TargetContainer
  Recover-InterruptedInitWrite

  Add-Type -AssemblyName System.Net.Http
  $script:httpClient = [Net.Http.HttpClient]::new()
  # First Raft unseal can fsync the initial state; allow slow local disks to
  # finish instead of abandoning an already accepted share after a short wait.
  $script:httpClient.Timeout = [TimeSpan]::FromSeconds(60)
  $status = (Invoke-VaultApi 'GET' '/v1/sys/seal-status').Json
  if ($status.storage_type -cne 'raft') { Stop-Safely 'Target Vault does not report Raft storage.' }

  if ($status.initialized -eq $false) {
    if (Test-Path -LiteralPath $stateFile) {
      Stop-Safely 'Vault is uninitialized while protected initialization material exists; refusing recovery ambiguity.'
    }
    $initResponse = Invoke-VaultApi 'PUT' '/v1/sys/init' @{ secret_shares = 5; secret_threshold = 3 }
    # Persist the complete response under DPAPI before validating or unsealing.
    Write-InitMaterial $initResponse.Raw
    $init = $initResponse.Json
    $keys = @($init.keys_base64)
    if (-not $init.root_token -or $keys.Count -ne 5 -or @($keys | Where-Object { -not $_ }).Count -gt 0) {
      Stop-Safely 'Initialization response is protected on disk but did not contain the expected recovery material.'
    }
  } else {
    $init = Read-InitMaterial
    $keys = @($init.keys_base64)
    if (-not $init.root_token -or $keys.Count -ne 5 -or @($keys | Where-Object { -not $_ }).Count -gt 0) {
      Stop-Safely 'Protected initialization material is incomplete.'
    }
  }

  if ($status.sealed -eq $true) {
    for ($index = 0; $index -lt 3; $index++) {
      $unseal = Invoke-VaultApi 'PUT' '/v1/sys/unseal' @{ key = $keys[$index] }
      if ($unseal.Json.sealed -eq $false) { break }
    }
  }
  $status = Wait-ForVaultReady

  $mounts = (Invoke-VaultApi 'GET' '/v1/sys/mounts' $null $init.root_token).Json.data
  $transit = $mounts.PSObject.Properties['transit/']
  if (-not $transit) {
    [void](Invoke-VaultApi 'POST' '/v1/sys/mounts/transit' @{ type = 'transit'; description = 'Transit engine for future DUGate key integration.' } $init.root_token)
  } elseif ($transit.Value.type -cne 'transit') {
    Stop-Safely 'An unexpected engine already occupies the transit/ mount; no changes were made to it.'
  }

  $kv = $mounts.PSObject.Properties['secret/']
  if (-not $kv) {
    [void](Invoke-VaultApi 'POST' '/v1/sys/mounts/secret' @{ type = 'kv'; options = @{ version = '2' }; description = 'KV v2 for future DUGate secret integration.' } $init.root_token)
  } elseif ($kv.Value.type -cne 'kv' -or $kv.Value.options.version -cne '2') {
    Stop-Safely 'An unexpected engine or version already occupies secret/; no changes were made to it.'
  }

  Write-Output 'Isolated Vault is initialized and unsealed with Raft storage; Transit and KV v2 mounts are ready.'
  Write-Output ('Recovery material is DPAPI-protected for the current Windows user at: ' + $stateFile)
} catch {
  # All expected failures are deliberately value-free. Suppress HTTP/PowerShell
  # exception details because they can include response bodies or request data.
  if ($script:safeFailureMessage) {
    $diagnostic = $script:safeFailureMessage
  } else {
    $exceptionType = $_.Exception.GetType().Name
    $scriptLine = $_.InvocationInfo.ScriptLineNumber
    $diagnostic = "Unexpected bootstrap failure (type=$exceptionType, line=$scriptLine); details suppressed. Check seal status and protected recovery files before retrying."
  }
  [Console]::Error.WriteLine($diagnostic)
  exit 1
} finally {
  if ($script:httpClient) { $script:httpClient.Dispose() }
}
