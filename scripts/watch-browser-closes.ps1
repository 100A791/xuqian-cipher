# Watch who makes msedge disappear. READ-ONLY: it never starts or closes a browser.
# ASCII only on purpose (see project lesson about .cmd/.ps1 encoding).
$log = Join-Path $env:TEMP 'xuqian-browser-watch.log'
"==== watch started $(Get-Date -Format o) ====" | Out-File -Append -Encoding utf8 $log

$prev = @{}
while ($true) {
  $now = @{}
  foreach ($p in (Get-Process msedge -ErrorAction SilentlyContinue)) { $now[[int]$p.Id] = $true }

  foreach ($id in $prev.Keys) {
    if (-not $now.ContainsKey($id)) {
      $stamp = Get-Date -Format o
      "$stamp  msedge PID $id DISAPPEARED" | Out-File -Append -Encoding utf8 $log

      # Snapshot every process that could plausibly have done it.
      $suspects = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe' or Name='node.exe' or Name='cmd.exe' or Name='taskkill.exe' or Name='msedge.exe'" -ErrorAction SilentlyContinue
      foreach ($s in $suspects) {
        $c = $s.CommandLine
        if ($null -eq $c) { $c = '' }
        "    suspect: $($s.Name) PID=$($s.ProcessId) :: $($c.Substring(0, [Math]::Min(220, $c.Length)))" | Out-File -Append -Encoding utf8 $log
      }
      "    ----" | Out-File -Append -Encoding utf8 $log
    }
  }
  $prev = $now
  Start-Sleep -Seconds 1
}
