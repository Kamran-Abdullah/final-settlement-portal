# Builds UpdatedFSA.exe (esbuild + Node single-executable) into dist (default) or another folder:  build-exe.ps1 -Out dist_new
# The public folder ships next to the exe. The database is NOT in dist (it lives in %LOCALAPPDATA%\UpdatedFSA\data when this
# folder is in OneDrive), so a rebuild never touches data.
param([string]$Out = "dist")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
# dependencies: this folder's node_modules
$nm = "$PSScriptRoot\node_modules"
if (-not (Test-Path "$nm\esbuild")) { throw "esbuild not found. Run: npm install --no-save esbuild postject (in this folder)" }
$env:NODE_PATH = $nm
if ($Out -eq "dist") { if (Get-Process UpdatedFSA -ErrorAction SilentlyContinue) { throw "UpdatedFSA.exe is running - close it first (or build with -Out dist_new)" } }
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force build, $Out | Out-Null
Remove-Item -Recurse -Force "$Out\public", "$Out\UpdatedFSA.exe" -ErrorAction SilentlyContinue
node "$nm\esbuild\bin\esbuild" server.js --bundle --platform=node --target=node22 --format=cjs --outfile=build/bundle.js
node --experimental-sea-config sea-config.json
Copy-Item (Get-Command node).Source "$Out\UpdatedFSA.exe" -Force
node "$nm\postject\dist\cli.js" "$Out\UpdatedFSA.exe" NODE_SEA_BLOB build\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
Copy-Item public "$Out\public" -Recurse -Force
Copy-Item start.bat "$Out\Start Updated FSA.bat" -Force
Write-Host "Built $Out\UpdatedFSA.exe"
