<#!
.SYNOPSIS
Copies the current SQLite database to the VPS only if the destination does not exist.

.EXAMPLE
.\deploy\push-initial-db.ps1 -SshUser root
#>
param(
    [Parameter(Mandatory)]
    [string]$SshUser,
    [string]$HostName = "65.20.72.135",
    [string]$IdentityFile
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$database = Join-Path $projectRoot "clicker.db"
if (-not (Test-Path -LiteralPath $database)) {
    throw "Local database was not found: $database"
}

$sshArgs = @()
if ($IdentityFile) { $sshArgs += @("-i", $IdentityFile) }
$target = "${SshUser}@${HostName}"

& ssh @sshArgs $target "test ! -e /var/www/clicker/data/clicker.db"
if ($LASTEXITCODE -ne 0) {
    throw "The VPS database already exists. It was not changed."
}

& scp @sshArgs $database "${target}:/tmp/clicker-initial.db"
if ($LASTEXITCODE -ne 0) { throw "Database upload failed." }

& ssh @sshArgs $target "install -o clicker -g clicker -m 0600 /tmp/clicker-initial.db /var/www/clicker/data/clicker.db && rm -f /tmp/clicker-initial.db"
if ($LASTEXITCODE -ne 0) { throw "Could not install database on the VPS." }

Write-Host "Initial database uploaded. Later deployments must use update-vps.sh only."
