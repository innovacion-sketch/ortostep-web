@echo off
cd /d "%~dp0"
title ORTOSTEP - extraccion de datos
.venv\Scripts\python -m ortostep_worker vigilar
pause
