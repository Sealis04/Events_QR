# Helper for setup.bat (hub): name and LAN address questions, DNS check, firewall, next-steps box.
# Plain PowerShell 5.1, no modules. Run only through setup.bat:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hub-network.ps1 -Action <action> ...
# Answers go to -OutFile (setup.bat reads it back); the exit code says yes (0) or no (1).
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Value = '',
  [string]$Name = '',
  [string]$Ip = '',
  [string]$OutFile = '',
  [string]$Port = '3000',
  [string]$Setup = 'prod',
  [string]$HubCmd = ''
)
$ErrorActionPreference = 'Stop'

# ---- name -----------------------------------------------------------------------------------

# Returns an empty string when $n is usable as the hub's name, else the reason.
function Test-HubName([string]$n) {
  $n = $n.Trim()
  if ($n -eq '') { return 'The name is empty.' }
  if ($n -match 'http' -or $n.Contains('/') -or $n -match '\s') {
    return 'Type only the name, without http, slashes or spaces.'
  }
  if (-not $n.Contains('.')) { return 'The name needs a dot, like hub.yourdomain.com.' }
  if ($n -match '(^|\.)example\.(org|com)$') { return 'example.org and example.com are placeholders, not your name.' }
  if ($n -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$') {
    return 'That is not a valid name (letters, digits, dashes and dots only).'
  }
  return ''
}

# ---- LAN address ----------------------------------------------------------------------------

$virtual = 'vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback'

# This PC's IPv4 addresses on up adapters that are not loopback, link-local or virtual.
function Get-LanAddresses {
  $found = @()
  foreach ($a in Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }) {
    if ($a.Name -match $virtual -or $a.InterfaceDescription -match $virtual) { continue }
    foreach ($addr in Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue) {
      $ip = $addr.IPAddress
      if ($ip.StartsWith('127.') -or $ip.StartsWith('169.254.')) { continue }
      $found += [pscustomobject]@{ Ip = $ip; Adapter = $a.Name }
    }
  }
  return $found
}

function Test-LanAddress([string]$ip) {
  $ip = $ip.Trim()
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return 'That is not an IPv4 address like 192.168.0.10.' }
  if (-not (@(Get-LanAddresses) | Where-Object { $_.Ip -eq $ip })) {
    return "$ip is not an address of this PC on a real network adapter."
  }
  return ''
}

# ---- actions --------------------------------------------------------------------------------

switch ($Action) {
  'check-name' {
    if ((Test-HubName $Value) -eq '') { exit 0 } else { exit 1 }
  }

  'ask-name' {
    Write-Host ''
    Write-Host 'The hub name is the name you put in Cloudflare, e.g. hub.yourdomain.com.'
    Write-Host 'Phones type it to reach the hub; it must be a name you own.'
    while ($true) {
      $n = (Read-Host 'Hub name').Trim()
      $why = Test-HubName $n
      if ($why -eq '') { break }
      Write-Host "  $why"
    }
    Set-Content -Path $OutFile -Value $n -Encoding ASCII
    exit 0
  }

  'check-url' {
    # HUB_URL for the web app: https://<real name>, no path, no trailing slash.
    if ($Value -notmatch '^https://([^/:\s]+)(:\d+)?$') {
      Write-Host '  Use the form https://hub.yourdomain.com (https, a name, no path or trailing slash).'
      exit 1
    }
    $why = Test-HubName $Matches[1]
    if ($why -ne '') {
      Write-Host "  $why"
      exit 1
    }
    exit 0
  }

  'check-ip' {
    if ((Test-LanAddress $Value) -eq '') { exit 0 } else { exit 1 }
  }

  'ask-ip' {
    $list = @(Get-LanAddresses)
    Write-Host ''
    if ($list.Count -eq 0) {
      Write-Host 'No usable network address found on this PC (are you connected to the venue or home network?).'
      exit 1
    }
    Write-Host "This PC's addresses on real networks:"
    for ($i = 0; $i -lt $list.Count; $i++) {
      Write-Host ('  {0}. {1}   ({2})' -f ($i + 1), $list[$i].Ip, $list[$i].Adapter)
    }
    Write-Host 'Pick the one on the Wi-Fi or cable the phones will use.'
    while ($true) {
      if ($list.Count -eq 1) {
        $answer = (Read-Host ('Use {0}? Press Enter to confirm, or type another number' -f $list[0].Ip)).Trim()
        if ($answer -eq '') { $answer = '1' }
      } else {
        $answer = (Read-Host 'Number').Trim()
      }
      $n = 0
      if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $list.Count) {
        $chosen = $list[$n - 1].Ip
        break
      }
      Write-Host '  Type one of the numbers above.'
    }
    Write-Host ''
    Write-Host "Reserve $chosen for this PC in the router (DHCP reservation), so it never changes."
    Set-Content -Path $OutFile -Value $chosen -Encoding ASCII
    exit 0
  }

  'port53' {
    Write-Host 'Programs holding UDP port 53 on this PC:'
    $lines = @(netstat -ano -p udp | Select-String -Pattern ':53\s')
    if ($lines.Count -eq 0) { Write-Host '  (none found: try again, or look at Docker Desktop)' }
    foreach ($l in $lines) {
      $pidText = ($l.ToString().Trim() -split '\s+')[-1]
      $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
      $label = if ($proc) { $proc.ProcessName } else { 'unknown' }
      Write-Host ('  {0}  ->  {1} (PID {2})' -f $l.ToString().Trim(), $label, $pidText)
    }
    exit 0
  }

  'check-dns' {
    $ok = $false
    for ($try = 1; $try -le 5 -and -not $ok; $try++) {
      $old = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $text = (& nslookup $Name $Ip 2>&1 | Out-String)
      $ErrorActionPreference = $old
      $at = $text.IndexOf('Name:')
      if ($at -ge 0 -and $text.Substring($at).Contains($Ip)) { $ok = $true; break }
      if ($try -lt 5) { Start-Sleep -Seconds 2 }
    }
    if ($ok) {
      Write-Host "  nslookup $Name $Ip answers $Ip."
      exit 0
    }
    Write-Host "  nslookup $Name $Ip did not return $Ip."
    exit 1
  }

  'firewall' {
    # One elevated PowerShell: Private profile for the hub's network, idempotent inbound rules.
    $script = Join-Path $env:TEMP 'eqr-hub-firewall.ps1'
    @'
param([string]$Ip)
$ErrorActionPreference = 'Stop'
try {
  $idx = (Get-NetIPAddress -IPAddress $Ip -AddressFamily IPv4).InterfaceIndex
  Get-NetConnectionProfile -InterfaceIndex $idx | Set-NetConnectionProfile -NetworkCategory Private
  foreach ($r in @(@('TCP', 80), @('TCP', 443), @('TCP', 53), @('UDP', 53))) {
    $display = 'Events_QR hub {0} {1}' -f $r[0], $r[1]
    if (-not (Get-NetFirewallRule -DisplayName $display -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $display -Direction Inbound -Action Allow -Protocol $r[0] -LocalPort $r[1] -Profile Any | Out-Null
    }
  }
  exit 0
} catch {
  Write-Host $_
  Start-Sleep -Seconds 5
  exit 1
}
'@ | Set-Content -Path $script -Encoding ASCII
    try {
      $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-Ip', $Ip)
      $code = $p.ExitCode
    } catch {
      $code = 2
    }
    Remove-Item $script -ErrorAction SilentlyContinue
    exit $code
  }

  'next-steps' {
    $first = $Name.Split('.')[0]
    $webCmd = if ($Setup -eq 'dev') {
      'docker compose -p events-qr-dev --env-file .env -f docker/compose.vm.yml -f docker/compose.local.yml up -d app'
    } else {
      'docker compose --env-file .env -f docker/compose.vm.yml up -d app'
    }
    $target = if ($Setup -eq 'dev') {
      "host.docker.internal:$Port"
    } else {
      "app:3000 (when Nginx Proxy Manager runs from this hub's proxy profile; otherwise ${Ip}:$Port)"
    }
    $bar = '=' * 72
    $text = @"
$bar
  DO THIS NOW: what is left for the hub $Name ($Ip)
$bar
 1. Router, DHCP settings:
      - Reserve $Ip for this PC.
      - Primary DNS = $Ip. Secondary DNS: leave empty.
      While this PC is off, devices on this Wi-Fi cannot look up names.
 2. Cloudflare: an A record  $first  ->  $Ip , DNS only (grey cloud).
 3. Nginx Proxy Manager (http://localhost:81):
      - Certificate for $Name with "Use a DNS Challenge" (Cloudflare token).
      - Proxy host $Name -> $target
      - SSL tab: Force SSL.
 4. Web app .env: HUB_URL=https://$Name
    then restart the web app (on the machine that runs it):
      $webCmd
 5. Phones: mobile data off, Private DNS off, then open https://$Name/scan
 6. If something stops working:
      Restart the DNS service:  $HubCmd --profile dns up -d --force-recreate dns
      Test it:                  nslookup $Name $Ip
      Check the hub:            https://$Name/api/health
$bar
"@
    Write-Host ''
    Write-Host $text
    if ($OutFile -ne '') {
      Set-Content -Path $OutFile -Value $text -Encoding ASCII
      Write-Host ''
      Write-Host "The same steps are saved in $OutFile."
    }
    exit 0
  }

  default {
    Write-Host "Unknown action: $Action"
    exit 2
  }
}
