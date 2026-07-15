@echo off
rem Launch StepRayOptics: start a local web server and open the browser.
cd /d "%~dp0"
start "" http://localhost:8341
python -m http.server 8341
