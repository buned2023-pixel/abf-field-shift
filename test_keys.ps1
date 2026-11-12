# test_keys.ps1 - Load .env keys and test each API endpoint

# Load .env
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env file not found at $envFile" -ForegroundColor Red
    exit 1
}

$keys = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line -match "^([^=]+)=(.*)$") {
        $keys[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

Write-Host "Loaded keys from .env:" -ForegroundColor Cyan
foreach ($k in $keys.Keys) {
    $v = $keys[$k]
    if ($v.Length -gt 10) {
        $masked = $v.Substring(0, 6) + "..." + $v.Substring($v.Length - 4)
    } else {
        $masked = $v
    }
    Write-Host "  $k = $masked"
}

# Define endpoints
$endpoints = @{
    "IPSTACK_KEY"     = "https://api.apilayer.net/ipstack/134.201.250.155?access_key={0}"
    "WEATHERSTACK_KEY"= "https://api.apilayer.net/weatherstack/current?access_key={0}&query=London"
    "FIRMS_MAP_KEY"   = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{0}/VIIRS_SNPP_NRT/-125,24,-66,50/1"
}

Write-Host ""
Write-Host "Testing endpoints:" -ForegroundColor Cyan

foreach ($name in $endpoints.Keys) {
    $key = $keys[$name]
    if (-not $key) {
        Write-Host "  $name : MISSING (not set in .env)" -ForegroundColor Yellow
        continue
    }

    $url = $endpoints[$name] -f $key

    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
        $status = $response.StatusCode
        $body = $response.Content
    } catch {
        # Try to read the error response body
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $body = $reader.ReadToEnd()
            $reader.Close()
            $stream.Close()
        } else {
            Write-Host "  $name : " -NoNewline
            Write-Host "ERROR" -ForegroundColor Red -NoNewline
            Write-Host "  ($($_.Exception.Message))"
            continue
        }
    }

    # Check for JSON error responses (ipstack / weatherstack)
    $isError = $false
    try {
        $data = $body | ConvertFrom-Json
        if ($data.error) {
            $errCode = $data.error.code
            $errInfo = $data.error.info
            if (-not $errInfo) { $errInfo = $data.error.type }
            Write-Host "  $name : " -NoNewline
            Write-Host "INVALID" -ForegroundColor Red -NoNewline
            Write-Host "  (HTTP $status - API error $errCode`: $errInfo)"
            $isError = $true
        }
        elseif ($null -ne $data.success -and -not $data.success) {
            $errInfo = if ($data.error) { $data.error.info } else { "unknown" }
            Write-Host "  $name : " -NoNewline
            Write-Host "INVALID" -ForegroundColor Red -NoNewline
            Write-Host "  (HTTP $status - $errInfo)"
            $isError = $true
        }
    } catch {
        # Non-JSON response (e.g. CSV from FIRMS) - check HTTP status
    }

    if (-not $isError) {
        if ($status -ge 200 -and $status -lt 300) {
            Write-Host "  $name : " -NoNewline
            Write-Host "VALID" -ForegroundColor Green -NoNewline
            Write-Host "  (HTTP $status, $($body.Length) bytes)"
        } else {
            $snippet = if ($body.Length -gt 120) { $body.Substring(0, 120) + "..." } else { $body }
            Write-Host "  $name : " -NoNewline
            Write-Host "INVALID" -ForegroundColor Red -NoNewline
            Write-Host "  (HTTP $status - $snippet)"
        }
    }
}
