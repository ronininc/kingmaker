@echo off
setlocal enabledelayedexpansion
title Aegis-AI WSL Coral TPU Deployer

echo ===================================================
echo   Aegis-AI Windows WSL Coral TPU Deployment 
echo ===================================================
echo.
echo This script will install the Edge TPU dependencies 
echo natively inside the Windows Subsystem for Linux (WSL).
echo It utilizes usbipd-win to map the Coral USB to the 
echo Linux Kernel, ensuring maximum stability.
echo.

:: 1. Verify wsl exists
where wsl >nul 2>nul
if %errorlevel% neq 0 (
    echo [AEGIS_PAUSE_MODAL] file=install_wsl.bat; msg=Windows Subsystem for Linux (WSL) is required to run the Coral TPU natively. Please click 'Launch Installer' (requires Admin) to install it, then verify your machine restarts. Once back, click 'Done'.
    set /p DUMMY="Waiting for user to install WSL and click Done..."
    
    where wsl >nul 2>nul
    if %errorlevel% neq 0 (
        echo ERROR: WSL is still not installed. Aborting deployment.
        exit /b 1
    )
)

:: 2. Verify usbipd exists
where usbipd >nul 2>nul
if %errorlevel% neq 0 (
    echo [AEGIS_PAUSE_MODAL] file=install_usbipd.bat; msg=usbipd-win is required to pass the Coral TPU to WSL. Please click 'Launch Installer' to install it via winget, then click 'Done'.
    set /p DUMMY="Waiting for user to install usbipd and click Done..."
    
    where usbipd >nul 2>nul
    if !errorlevel! neq 0 (
        if exist "C:\Program Files\usbipd-win\usbipd.exe" (
            set "PATH=%PATH%;C:\Program Files\usbipd-win\"
        ) else (
            echo ERROR: usbipd is still not installed. Aborting deployment.
            exit /b 1
        )
    )
)

:: 3. Inform about hardware binding
echo [1/4] Ensuring hardware is bound...
echo Note: Hardware IDs 18d1:9302 and 1a6e:089a must be bound to usbipd.
echo If they are not bound yet, please run 'usbipd bind' as Administrator.

:: 4. Get the WSL path to the current directory
set "DIR_PATH=%~dp0"
set "DIR_PATH=%DIR_PATH:\=/%"
set "DIR_PATH=%DIR_PATH:C:=/mnt/c%"
set "DIR_PATH=%DIR_PATH:~0,-1%"

:: 5. Install Dependencies inside WSL
echo.
echo [2/4] Initializing WSL Python 3.9 environment...
wsl -u root -e bash -c "apt-get update && apt-get install -y software-properties-common curl wget libusb-1.0-0 && add-apt-repository -y ppa:deadsnakes/ppa && apt-get update && apt-get install -y python3.9 python3.9-venv python3.9-distutils"
if %errorlevel% neq 0 (
    echo ERROR: Failed to install Python 3.9 in WSL. Ensure you have internet access and WSL is running Ubuntu.
    exit /b 1
)

:: 6. Create Virtual Env
echo.
echo [3/4] Creating Virtual Environment...
wsl -e bash -c "cd '%DIR_PATH%' && python3.9 -m venv wsl_venv"
if %errorlevel% neq 0 (
    echo ERROR: Failed to create venv.
    exit /b 1
)

:: 7. Install Python Packages and EdgeTPU Lib
echo.
echo [4/4] Installing Python requirements and Coral TPU drivers...
wsl -e bash -c "cd '%DIR_PATH%' && source wsl_venv/bin/activate && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.9 && python3.9 -m pip install -r requirements.txt"
wsl -u root -e bash -c "cd '%DIR_PATH%' && wget -qO libedgetpu.deb https://packages.cloud.google.com/apt/pool/coral-edgetpu-stable/libedgetpu1-max_16.0_amd64_0ac21f1924dd4b125d5cfc5f6d0e4a5e.deb && dpkg -x libedgetpu.deb ext && cp ext/usr/lib/x86_64-linux-gnu/libedgetpu.so.1.0 libedgetpu.so.1 && rm -rf ext libedgetpu.deb"
:: Install libedgetpu into the real WSL Linux filesystem so dlopen() works (NTFS /mnt/c/ lacks exec bit)
wsl -u root -e bash -c "cp '%DIR_PATH%/libedgetpu.so.1' /usr/local/lib/libedgetpu.so.1 && ldconfig"

echo.
echo.
echo SUCCESS: Windows WSL Deployment Complete!
echo.
echo Aegis-AI is ready to trigger the detection node natively on WSL!
echo You can safely close this terminal.
exit /b 0
