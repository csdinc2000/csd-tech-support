#requires -Version 5.1

<#
.SYNOPSIS
    Performs conservative Windows 10/11 endpoint optimization for IT support.

.DESCRIPTION
    This script is intended for technician or RMM execution on Windows 10 and
    Windows 11 endpoints. It:

      * Reduces a conservative allowlist of optional startup applications
      * Disables Windows background-app permissions through policy
      * Enables Storage Sense
      * Performs user/system temporary-file cleanup, Recycle Bin cleanup,
        Windows component cleanup, and Disk Cleanup
      * Identifies and removes allowlisted consumer AppX bloatware
      * Reports common optional Win32 software and only removes it when the
        uninstall entry provides a QuietUninstallString and
        -RemoveWin32Bloatware is supplied
      * Pauses OneDrive by shutting down its sync process
      * Sets Windows Search to Manual when a physical HDD is detected

    Run with -WhatIf before making changes. The script does not remove security
    software, OEM support tools, drivers, Microsoft Store infrastructure, or
    Windows components outside the explicit bloatware allowlist.

.PARAMETER WhatIf
    Shows intended changes without applying them. This is a common PowerShell
    parameter provided by SupportsShouldProcess.

.PARAMETER SkipStartup
    Do not change startup approval entries.

.PARAMETER SkipBackgroundApps
    Do not change the Windows background-app policy.

.PARAMETER SkipStorageSense
    Do not enable Storage Sense.

.PARAMETER SkipDeepCleanup
    Do not perform disk cleanup.

.PARAMETER SkipBloatware
    Do not identify AppX/Win32 bloatware.

.PARAMETER RemoveBloatware
    Remove the allowlisted consumer AppX packages identified by the script.
    Without this switch, AppX packages are reported only.

.PARAMETER RemoveWin32Bloatware
    Also run quiet uninstall commands for the small Win32 allowlist. Entries
    without a QuietUninstallString are reported but never removed automatically.

.PARAMETER SkipOneDrive
    Do not pause OneDrive.

.PARAMETER SkipSearchOptimization
    Do not inspect the physical disks or change Windows Search.

.PARAMETER RestartExplorer
    Restart Windows Explorer after registry and shell-related changes.

.PARAMETER RebootAfter
    Restart the endpoint after all requested work completes.

.PARAMETER LogPath
    Path for the technician log. Defaults to
    %ProgramData%\CSD\Support\Logs\Windows-Optimization-<timestamp>.log.

.EXAMPLE
    .\Optimize-WindowsEndpoint.ps1 -WhatIf

.EXAMPLE
    .\Optimize-WindowsEndpoint.ps1 -RemoveWin32Bloatware -RestartExplorer

.NOTES
    Requires local administrator rights. Run from an elevated PowerShell
    session launched by the IT support platform.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [switch]$SkipStartup,
    [switch]$SkipBackgroundApps,
    [switch]$SkipStorageSense,
    [switch]$SkipDeepCleanup,
    [switch]$SkipBloatware,
    [switch]$RemoveBloatware,
    [switch]$RemoveWin32Bloatware,
    [switch]$SkipOneDrive,
    [switch]$SkipSearchOptimization,
    [switch]$RestartExplorer,
    [switch]$RebootAfter,
    [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$script:Results = New-Object System.Collections.Generic.List[object]
$script:LogPath = $LogPath

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "CHANGE")]
        [string]$Level = "INFO"
    )

    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $line
    if ($script:LogPath) {
        try {
            Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
        }
        catch {
            Write-Host "[WARN] Could not write to log: $($_.Exception.Message)"
        }
    }
}

function Add-Result {
    param(
        [string]$Area,
        [string]$Status,
        [string]$Details
    )

    $script:Results.Add([pscustomobject]@{
        Area    = $Area
        Status  = $Status
        Details = $Details
    })
}

function Invoke-Change {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Target,
        [Parameter(Mandatory = $true)]
        [string]$Action,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [string]$Area = "General"
    )

    if ($PSCmdlet.ShouldProcess($Target, $Action)) {
        try {
            & $ScriptBlock
            Write-Log "$Action - $Target" "CHANGE"
            Add-Result $Area "Changed" "$Action - $Target"
        }
        catch {
            Write-Log "$Action failed for $Target: $($_.Exception.Message)" "WARN"
            Add-Result $Area "Failed" "$Action - $Target - $($_.Exception.Message)"
        }
    }
    else {
        Write-Log "WhatIf: $Action - $Target"
        Add-Result $Area "WhatIf" "$Action - $Target"
    }
}

function Test-SupportedEndpoint {
    if ($env:OS -ne "Windows_NT") {
        throw "This script only supports Windows 10 and Windows 11."
    }

    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $caption = [string]$os.Caption
    if ($caption -notmatch "Windows 10|Windows 11") {
        throw "Unsupported Windows version: $caption"
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session."
    }

    Write-Log "Supported endpoint: $caption, build $($os.BuildNumber)"
    Add-Result "Preflight" "Passed" "$caption, build $($os.BuildNumber), administrator session"
}

function Get-RegistryValueNames {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    try {
        $item = Get-ItemProperty -LiteralPath $Path -ErrorAction Stop
        return @(
            $item.PSObject.Properties |
                Where-Object { $_.Name -notmatch "^PS(Path|ParentPath|ChildName|Drive|Provider)$" } |
                Select-Object -ExpandProperty Name
        )
    }
    catch {
        Write-Log "Could not enumerate registry path $Path: $($_.Exception.Message)" "WARN"
        return @()
    }
}

function Set-DwordValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Value,
        [Parameter(Mandatory = $true)][string]$Area
    )

    Invoke-Change `
        -Target "$Path\$Name" `
        -Action "Set DWORD to $Value" `
        -Area $Area `
        -ScriptBlock {
            if (-not (Test-Path -LiteralPath $Path)) {
                New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
            }
            New-ItemProperty -LiteralPath $Path -Name $Name -PropertyType DWord `
                -Value $Value -Force -ErrorAction Stop | Out-Null
        }
}

function Disable-OptionalStartupApps {
    # This list intentionally excludes antivirus, backup, accessibility,
    # management-agent, and hardware-driver startup entries.
    $startupPatterns = @(
        "Teams",
        "Spotify",
        "Discord",
        "Steam",
        "EpicGames",
        "Skype",
        "Zoom",
        "Dropbox",
        "Telegram",
        "Adobe Creative Cloud",
        "GoogleDriveFS"
    )

    $runPaths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
    )
    $approvalPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
    $disabledBytes = [byte[]](0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
    $found = New-Object System.Collections.Generic.List[string]

    foreach ($runPath in $runPaths) {
        foreach ($name in (Get-RegistryValueNames -Path $runPath)) {
            try {
                $command = [string](Get-ItemPropertyValue -LiteralPath $runPath -Name $name -ErrorAction Stop)
            }
            catch {
                continue
            }

            $candidate = "$name $command"
            if ($startupPatterns | Where-Object { $candidate -match [regex]::Escape($_) }) {
                $found.Add("$name from $runPath")
            }
        }
    }

    if ($found.Count -eq 0) {
        Write-Log "No allowlisted optional startup applications were found."
        Add-Result "Startup" "No change" "No matching optional startup entries found"
        return
    }

    foreach ($runPath in $runPaths) {
        foreach ($name in (Get-RegistryValueNames -Path $runPath)) {
            try {
                $command = [string](Get-ItemPropertyValue -LiteralPath $runPath -Name $name -ErrorAction Stop)
            }
            catch {
                continue
            }

            $candidate = "$name $command"
            if (-not ($startupPatterns | Where-Object { $candidate -match [regex]::Escape($_) })) {
                continue
            }

            $capturedName = $name
            Invoke-Change `
                -Target "Startup entry '$capturedName'" `
                -Action "Disable optional startup application" `
                -Area "Startup" `
                -ScriptBlock {
                if (-not (Test-Path -LiteralPath $approvalPath)) {
                    New-Item -Path $approvalPath -Force -ErrorAction Stop | Out-Null
                }
                    New-ItemProperty -LiteralPath $approvalPath -Name $capturedName `
                        -PropertyType Binary -Value $disabledBytes -Force -ErrorAction Stop | Out-Null
                }
        }
    }

    Write-Log ("Optional startup entries found: " + ($found -join "; "))
}

function Disable-BackgroundAppPermissions {
    $path = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy"
    Set-DwordValue `
        -Path $path `
        -Name "LetAppsRunInBackground" `
        -Value 2 `
        -Area "Background apps"
    Write-Log "Background-app policy set to force-deny for Microsoft Store/UWP apps."
}

function Enable-StorageSense {
    $userPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy"
    $machinePolicyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\StorageSense"

    # 01 enables Storage Sense for the interactive user. The machine policy
    # also makes the setting effective when an RMM runs this script as SYSTEM.
    # The script deliberately does not set Downloads retention or delete
    # personal files.
    Set-DwordValue -Path $userPath -Name "01" -Value 1 -Area "Storage Sense"
    Set-DwordValue `
        -Path $machinePolicyPath `
        -Name "AllowStorageSenseGlobal" `
        -Value 1 `
        -Area "Storage Sense"

    $startStorageSense = Get-Command -Name "Start-StorageSense" -ErrorAction SilentlyContinue
    if ($null -ne $startStorageSense) {
        Invoke-Change `
            -Target "Windows Storage Sense" `
            -Action "Run Storage Sense now" `
            -Area "Storage Sense" `
            -ScriptBlock {
                & $startStorageSense.Name -ErrorAction Stop
            }
    }
    else {
        Write-Log "Storage Sense enabled; Start-StorageSense is not available on this build."
        Add-Result "Storage Sense" "Enabled" "Policy enabled; immediate-run cmdlet unavailable"
    }
}

function Remove-DirectoryContents {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Log "Cleanup path does not exist: $Path"
        return
    }

    try {
        Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue |
            Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
        Write-Log "Cleaned temporary contents of $Path" "CHANGE"
        Add-Result "Deep cleanup" "Changed" "Temporary contents cleaned: $Path"
    }
    catch {
        Write-Log "Some files in $Path could not be removed: $($_.Exception.Message)" "WARN"
        Add-Result "Deep cleanup" "Partial" "Some files could not be removed: $Path"
    }
}

function Invoke-DeepDiskCleanup {
    $tempPaths = @(
        $env:TEMP,
        $env:TMP,
        (Join-Path $env:SystemRoot "Temp")
    ) | Where-Object { $_ } | Select-Object -Unique

    foreach ($path in $tempPaths) {
        Invoke-Change `
            -Target $path `
            -Action "Remove temporary files and folders" `
            -Area "Deep cleanup" `
            -ScriptBlock {
                Remove-DirectoryContents -Path $path
            }
    }

    if (Get-Command -Name Clear-RecycleBin -ErrorAction SilentlyContinue) {
        Invoke-Change `
            -Target "Recycle Bin" `
            -Action "Empty Recycle Bin for the current user" `
            -Area "Deep cleanup" `
            -ScriptBlock {
                Clear-RecycleBin -Force -ErrorAction Stop
            }
    }

    $cleanmgr = Join-Path $env:SystemRoot "System32\cleanmgr.exe"
    if (Test-Path -LiteralPath $cleanmgr) {
        Invoke-Change `
            -Target "Windows Disk Cleanup" `
            -Action "Run automatic Disk Cleanup" `
            -Area "Deep cleanup" `
            -ScriptBlock {
                $process = Start-Process -FilePath $cleanmgr -ArgumentList "/verylowdisk" `
                    -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
                if ($process.ExitCode -ne 0) {
                    throw "cleanmgr.exe exited with code $($process.ExitCode)"
                }
            }
    }

    $dism = Join-Path $env:SystemRoot "System32\dism.exe"
    if (Test-Path -LiteralPath $dism) {
        Invoke-Change `
            -Target "Windows component store" `
            -Action "Run DISM component cleanup without restarting" `
            -Area "Deep cleanup" `
            -ScriptBlock {
                $process = Start-Process -FilePath $dism `
                    -ArgumentList "/Online", "/Cleanup-Image", "/StartComponentCleanup", "/NoRestart" `
                    -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
                if ($process.ExitCode -ne 0) {
                    throw "DISM exited with code $($process.ExitCode)"
                }
            }

        Invoke-Change `
            -Target "Windows component store health" `
            -Action "Run DISM RestoreHealth without restarting" `
            -Area "System repair" `
            -ScriptBlock {
                $process = Start-Process -FilePath $dism `
                    -ArgumentList "/Online", "/Cleanup-Image", "/RestoreHealth", "/NoRestart" `
                    -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
                if ($process.ExitCode -ne 0) {
                    throw "DISM RestoreHealth exited with code $($process.ExitCode)"
                }
            }
    }

    $sfc = Join-Path $env:SystemRoot "System32\sfc.exe"
    if (Test-Path -LiteralPath $sfc) {
        Invoke-Change `
            -Target "Protected Windows system files" `
            -Action "Run System File Checker repair scan" `
            -Area "System repair" `
            -ScriptBlock {
                $process = Start-Process -FilePath $sfc -ArgumentList "/scannow" `
                    -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
                if ($process.ExitCode -notin @(0, 1, 2)) {
                    throw "SFC exited with unexpected code $($process.ExitCode)"
                }
            }
    }

    $doCacheCommand = Get-Command -Name "Delete-DeliveryOptimizationCache" -ErrorAction SilentlyContinue
    if ($null -ne $doCacheCommand) {
        Invoke-Change `
            -Target "Delivery Optimization cache" `
            -Action "Clear Delivery Optimization cache" `
            -Area "Deep cleanup" `
            -ScriptBlock {
                & $doCacheCommand.Name -Force -ErrorAction Stop
            }
    }
}

function Get-AppxBloatware {
    $patterns = @(
        "Microsoft.3DBuilder",
        "Microsoft.3DViewer",
        "Microsoft.BingFinance",
        "Microsoft.BingNews",
        "Microsoft.BingSports",
        "Microsoft.BingWeather",
        "Microsoft.GetHelp",
        "Microsoft.Getstarted",
        "Microsoft.Microsoft3DViewer",
        "Microsoft.MicrosoftJournal",
        "Microsoft.MicrosoftOfficeHub",
        "Microsoft.MicrosoftSolitaireCollection",
        "Microsoft.MixedReality.Portal",
        "Microsoft.People",
        "Microsoft.SkypeApp",
        "Microsoft.Wallet",
        "Microsoft.WindowsFeedbackHub",
        "Microsoft.WindowsMaps",
        "Microsoft.Xbox",
        "Microsoft.XboxApp",
        "Microsoft.XboxGamingOverlay",
        "Microsoft.XboxIdentityProvider",
        "Microsoft.XboxSpeechToTextOverlay",
        "Microsoft.ZuneMusic",
        "Microsoft.ZuneVideo",
        "Clipchamp.Clipchamp",
        "Facebook",
        "Netflix",
        "SpotifyAB.SpotifyMusic",
        "TikTok"
    )

    try {
        return @(
            Get-AppxPackage -AllUsers -ErrorAction Stop |
                Where-Object {
                    $packageName = [string]$_.Name
                    $patterns | Where-Object { $packageName -like "*$_*" }
                } |
                Sort-Object Name, Version -Unique
        )
    }
    catch {
        Write-Log "Could not enumerate installed AppX packages: $($_.Exception.Message)" "WARN"
        return @()
    }
}

function Get-ProvisionedAppxBloatware {
    $patterns = @(
        "Microsoft.BingNews",
        "Microsoft.BingWeather",
        "Microsoft.GetHelp",
        "Microsoft.Getstarted",
        "Microsoft.MicrosoftOfficeHub",
        "Microsoft.MicrosoftSolitaireCollection",
        "Microsoft.MixedReality.Portal",
        "Microsoft.People",
        "Microsoft.SkypeApp",
        "Microsoft.WindowsFeedbackHub",
        "Microsoft.WindowsMaps",
        "Microsoft.Xbox",
        "Microsoft.ZuneMusic",
        "Microsoft.ZuneVideo",
        "Clipchamp.Clipchamp"
    )

    try {
        return @(
            Get-AppxProvisionedPackage -Online -ErrorAction Stop |
                Where-Object {
                    $packageName = [string]$_.DisplayName
                    $patterns | Where-Object { $packageName -like "*$_*" }
                } |
                Sort-Object DisplayName -Unique
        )
    }
    catch {
        Write-Log "Could not enumerate provisioned AppX packages: $($_.Exception.Message)" "WARN"
        return @()
    }
}

function Get-OptionalWin32Software {
    $paths = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    $patterns = @(
        "Candy Crush",
        "Farm Heroes",
        "WildTangent",
        "Facebook",
        "Netflix",
        "TikTok",
        "Booking.com",
        "Dropbox Promotion"
    )
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($path in $paths) {
        foreach ($entry in (Get-ItemProperty -Path $path -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace([string]$entry.DisplayName)) {
                continue
            }
            if ($patterns | Where-Object { [string]$entry.DisplayName -like "*$_*" }) {
                $items.Add([pscustomobject]@{
                    DisplayName          = [string]$entry.DisplayName
                    DisplayVersion       = [string]$entry.DisplayVersion
                    QuietUninstallString = [string]$entry.QuietUninstallString
                    UninstallString      = [string]$entry.UninstallString
                })
            }
        }
    }

    return @($items | Sort-Object DisplayName, DisplayVersion -Unique)
}

function Remove-AllowlistedBloatware {
    $installedAppx = @(Get-AppxBloatware)
    $provisionedAppx = @(Get-ProvisionedAppxBloatware)
    $win32 = @(Get-OptionalWin32Software)

    if ($installedAppx.Count -eq 0 -and $provisionedAppx.Count -eq 0 -and $win32.Count -eq 0) {
        Write-Log "No allowlisted consumer bloatware was found."
        Add-Result "Bloatware" "No change" "No allowlisted AppX or Win32 software found"
        return
    }

    foreach ($package in $installedAppx) {
        Write-Log "Identified installed AppX: $($package.Name) $($package.Version)"
        if (-not $RemoveBloatware) {
            Add-Result "Bloatware" "Reported" "$($package.Name) $($package.Version) - not removed; use -RemoveBloatware"
            continue
        }
        $capturedPackage = $package
        Invoke-Change `
            -Target "$($capturedPackage.Name) $($capturedPackage.Version)" `
            -Action "Remove installed AppX package for all users" `
            -Area "Bloatware" `
            -ScriptBlock {
                Remove-AppxPackage -Package $capturedPackage.PackageFullName -AllUsers -ErrorAction Stop
            }
    }

    foreach ($package in $provisionedAppx) {
        Write-Log "Identified provisioned AppX: $($package.DisplayName)"
        if (-not $RemoveBloatware) {
            Add-Result "Bloatware" "Reported" "$($package.DisplayName) provisioned image - not removed; use -RemoveBloatware"
            continue
        }
        $capturedPackage = $package
        Invoke-Change `
            -Target "$($capturedPackage.DisplayName) provisioned image" `
            -Action "Remove AppX package from future user profiles" `
            -Area "Bloatware" `
            -ScriptBlock {
                Remove-AppxProvisionedPackage -Online -PackageName $capturedPackage.PackageName `
                    -ErrorAction Stop | Out-Null
            }
    }

    foreach ($software in $win32) {
        $display = "$($software.DisplayName) $($software.DisplayVersion)".Trim()
        Write-Log "Identified optional Win32 software: $display"

        if (-not $RemoveWin32Bloatware) {
            Add-Result "Bloatware" "Reported" "$display - not removed; use -RemoveWin32Bloatware to allow quiet uninstall"
            continue
        }

        if ([string]::IsNullOrWhiteSpace($software.QuietUninstallString)) {
            Write-Log "No QuietUninstallString found for $display; leaving installed." "WARN"
            Add-Result "Bloatware" "Reported" "$display - no quiet uninstall command available"
            continue
        }

        $command = $software.QuietUninstallString
        Invoke-Change `
            -Target $display `
            -Action "Run vendor-provided quiet uninstall command" `
            -Area "Bloatware" `
            -ScriptBlock {
                $process = Start-Process -FilePath $env:ComSpec `
                    -ArgumentList "/d", "/s", "/c", $command `
                    -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
                if ($process.ExitCode -ne 0) {
                    throw "uninstaller exited with code $($process.ExitCode)"
                }
            }
    }
}

function Pause-OneDrive {
    $oneDrivePaths = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\OneDrive\OneDrive.exe"),
        (Join-Path $env:ProgramFiles "Microsoft OneDrive\OneDrive.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft OneDrive\OneDrive.exe")
    ) | Where-Object { $_ } | Select-Object -Unique

    $process = Get-Process -Name "OneDrive" -ErrorAction SilentlyContinue
    if ($null -eq $process -and -not ($oneDrivePaths | Where-Object { Test-Path -LiteralPath $_ })) {
        Write-Log "OneDrive is not installed or running."
        Add-Result "OneDrive" "No change" "OneDrive process and executable were not found"
        return
    }

    foreach ($path in $oneDrivePaths) {
        if (Test-Path -LiteralPath $path) {
            $capturedPath = $path
            Invoke-Change `
                -Target "OneDrive sync process" `
                -Action "Pause OneDrive by shutting down the sync client" `
                -Area "OneDrive" `
                -ScriptBlock {
                    Start-Process -FilePath $capturedPath -ArgumentList "/shutdown" `
                        -Wait -WindowStyle Hidden -ErrorAction Stop
                }
            break
        }
    }

    if (Get-Process -Name "OneDrive" -ErrorAction SilentlyContinue) {
        Invoke-Change `
            -Target "OneDrive process" `
            -Action "Stop remaining OneDrive process" `
            -Area "OneDrive" `
            -ScriptBlock {
                Get-Process -Name "OneDrive" -ErrorAction Stop | Stop-Process -Force -ErrorAction Stop
            }
    }

    Write-Log "OneDrive is paused for this session; launching OneDrive again will resume syncing."
}

function Optimize-SearchForSlowDisk {
    $physicalDiskCommand = Get-Command -Name "Get-PhysicalDisk" -ErrorAction SilentlyContinue
    if ($null -eq $physicalDiskCommand) {
        Write-Log "Get-PhysicalDisk is unavailable; Windows Search was not changed." "WARN"
        Add-Result "Windows Search" "Skipped" "Could not reliably detect HDD media type"
        return
    }

    $hdds = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.MediaType -eq "HDD" })
    if ($hdds.Count -eq 0) {
        Write-Log "No physical HDD detected; Windows Search startup type was not changed."
        Add-Result "Windows Search" "No change" "No physical HDD detected"
        return
    }

    Write-Log ("Physical HDD detected: " + (($hdds | Select-Object -ExpandProperty FriendlyName) -join ", "))
    $service = Get-Service -Name "WSearch" -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        Write-Log "Windows Search service is not installed." "WARN"
        Add-Result "Windows Search" "Skipped" "WSearch service not found"
        return
    }

    Invoke-Change `
        -Target "Windows Search (WSearch)" `
        -Action "Set service startup type to Manual" `
        -Area "Windows Search" `
        -ScriptBlock {
            Set-Service -Name "WSearch" -StartupType Manual -ErrorAction Stop
        }
}

function Restart-ShellIfRequested {
    if (-not $RestartExplorer) {
        return
    }

    Invoke-Change `
        -Target "Windows Explorer" `
        -Action "Restart Explorer to reload startup policy changes" `
        -Area "Explorer" `
        -ScriptBlock {
            Get-Process -Name "explorer" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
            Start-Process -FilePath "explorer.exe" -ErrorAction Stop
        }
}

function Restart-EndpointIfRequested {
    if (-not $RebootAfter) {
        return
    }

    Invoke-Change `
        -Target "Windows endpoint" `
        -Action "Restart endpoint in 60 seconds" `
        -Area "Reboot" `
        -ScriptBlock {
            shutdown.exe /r /t 60 /c "CSD Windows optimization completed; restarting in 60 seconds."
        }
}

try {
    if ($WhatIfPreference) {
        $script:LogPath = $null
    }
    else {
        if ([string]::IsNullOrWhiteSpace($script:LogPath)) {
            $logDirectory = Join-Path $env:ProgramData "CSD\Support\Logs"
            $script:LogPath = Join-Path $logDirectory (
                "Windows-Optimization-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss")
            )
        }

        $parent = Split-Path -Parent $script:LogPath
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -Path $parent -ItemType Directory -Force | Out-Null
        }
    }

    Write-Log "Starting CSD Windows endpoint optimization."
    if ($WhatIfPreference) {
        Write-Log "WHATIF MODE: no changes or log files will be created."
    }
    else {
        Write-Log "Log file: $script:LogPath"
    }

    Test-SupportedEndpoint

    if (-not $SkipStartup) {
        Disable-OptionalStartupApps
    }
    else {
        Write-Log "Startup optimization skipped by parameter."
    }

    if (-not $SkipBackgroundApps) {
        Disable-BackgroundAppPermissions
    }
    else {
        Write-Log "Background-app policy skipped by parameter."
    }

    if (-not $SkipStorageSense) {
        Enable-StorageSense
    }
    else {
        Write-Log "Storage Sense skipped by parameter."
    }

    if (-not $SkipDeepCleanup) {
        Invoke-DeepDiskCleanup
    }
    else {
        Write-Log "Deep disk cleanup skipped by parameter."
    }

    if (-not $SkipBloatware) {
        Remove-AllowlistedBloatware
    }
    else {
        Write-Log "Bloatware identification/removal skipped by parameter."
    }

    if (-not $SkipOneDrive) {
        Pause-OneDrive
    }
    else {
        Write-Log "OneDrive pause skipped by parameter."
    }

    if (-not $SkipSearchOptimization) {
        Optimize-SearchForSlowDisk
    }
    else {
        Write-Log "Windows Search optimization skipped by parameter."
    }

    Restart-ShellIfRequested
    Restart-EndpointIfRequested

    Write-Log "Windows endpoint optimization completed."
    Write-Host ""
    Write-Host "CSD Windows Optimization Summary" -ForegroundColor Cyan
    $script:Results | Format-Table -AutoSize
}
catch {
    Write-Log "Fatal error: $($_.Exception.Message)" "ERROR"
    Add-Result "Script" "Failed" $_.Exception.Message
    exit 1
}
