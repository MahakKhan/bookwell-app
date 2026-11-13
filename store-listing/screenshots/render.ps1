# Renders every slide to a 1600x900 PNG: powershell -File render.ps1 [name ...]
$dir = $PSScriptRoot
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$names = if ($args.Count) { $args } else { Get-ChildItem $dir -Filter *.html | ForEach-Object { $_.BaseName } }
foreach ($n in $names) {
  $url = "file:///" + ($dir -replace '\\', '/') + "/$n.html"
  & $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1600,900 --screenshot="$dir\$n.png" $url | Out-Null
  Write-Output "$n -> $((Get-Item "$dir\$n.png").Length) bytes"
}
