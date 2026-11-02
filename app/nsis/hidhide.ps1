# Downloads the official HidHide release, checks it and runs its installer.
# Used by the Console UI installer (hooks.nsh) only when the user asks for it.
#
# The download must match the pinned SHA-256 and carry a valid Authenticode
# signature from Nefarius Software Solutions; otherwise it is deleted and
# never run. HidHide's own installer asks for administrator rights (UAC).
#
# Exit codes: HidHide installer's own code (0 = installed, 3010 = installed,
# restart needed), 10 = download failed, 11 = hash mismatch, 12 = bad
# signature, 13 = the administrator prompt was declined.

param([Parameter(Mandatory = $true)][string]$Folder)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# HidHide v1.5.230 (2024-05-11), MIT, https://github.com/nefarius/HidHide
$Url = 'https://github.com/nefarius/HidHide/releases/download/v1.5.230.0/HidHide_1.5.230_x64.exe'
$Sha256 = 'F4BBBCB82E6258641B887C74BC81C4C5F66E4AA811808DFC304347687B7605F6'
$Signer = 'CN=Nefarius Software Solutions e.U.,'

$File = Join-Path $Folder 'HidHide_1.5.230_x64.exe'

try {
    # Windows PowerShell 5.1 may still default to TLS 1.0.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
} catch {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    exit 10
}

if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Sha256) {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    exit 11
}

$sig = Get-AuthenticodeSignature -LiteralPath $File
if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate.Subject.StartsWith($Signer)) {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    exit 12
}

try {
    $p = Start-Process -FilePath $File -Verb RunAs -Wait -PassThru
} catch {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    exit 13
}
Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
exit $p.ExitCode
