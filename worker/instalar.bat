@echo off
cd /d "%~dp0"
echo Instalando el programa de extraccion ORTOSTEP...
python -m venv .venv || goto error
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt || goto error
.venv\Scripts\python tests	est_basico.py || goto error
echo.
echo Listo. Copia config.ejemplo.env como .env, llena la clave y abre iniciar.bat
pause
exit /b 0
:error
echo Hubo un error. Revisa que Python 3.12 o mas nuevo este instalado.
pause
exit /b 1
