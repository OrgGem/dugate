@echo off
node "%~dp0dev.cjs" %*
exit /b %errorlevel%
