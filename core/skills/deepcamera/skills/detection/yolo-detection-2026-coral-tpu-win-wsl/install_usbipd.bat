@echo off
echo Installing usbipd-win via Windows Package Manager...
winget install usbipd -e --accept-package-agreements --accept-source-agreements
echo.
echo Please close this window to continue.
pause
