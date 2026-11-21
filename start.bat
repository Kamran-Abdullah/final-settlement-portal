@echo off
cd /d "%~dp0"
set UFSA_DATA_DIR=%~dp0..\data
start "" http://localhost:4900
UpdatedFSA.exe
