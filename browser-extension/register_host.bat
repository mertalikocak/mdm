@echo off
setlocal EnableDelayedExpansion

echo ========================================================
echo  Mak Download Manager (MDM) - Native Messaging Kurulumu
echo ========================================================
echo.

:: 1. Host binary dosyasının konumunu belirle
set "SCRIPT_DIR=%~dp0"
set "TARGET_HOST="

if exist "%LOCALAPPDATA%\mdm\mdm_host.exe" (
    set "TARGET_HOST=%LOCALAPPDATA%\mdm\mdm_host.exe"
) else if exist "%LOCALAPPDATA%\CargoTarget\mdm\release\mdm_host.exe" (
    set "TARGET_HOST=%LOCALAPPDATA%\CargoTarget\mdm\release\mdm_host.exe"
) else if exist "%LOCALAPPDATA%\CargoTarget\mdm\debug\mdm_host.exe" (
    set "TARGET_HOST=%LOCALAPPDATA%\CargoTarget\mdm\debug\mdm_host.exe"
) else if exist "%SCRIPT_DIR%..\src-tauri\target\debug\mdm_host.exe" (
    set "TARGET_HOST=%SCRIPT_DIR%..\src-tauri\target\debug\mdm_host.exe"
)

if not defined TARGET_HOST (
    set "TARGET_HOST=%LOCALAPPDATA%\CargoTarget\mdm\debug\mdm_host.exe"
    echo [UYARI] mdm_host.exe henuz bulunamadi.
    echo Varsayilan hedef olarak su konum belirlendi: !TARGET_HOST!
    echo Lutfen 'cargo build --bins' calistirmayi unutmayin.
) else (
    echo [BILGI] Bulunan Host Binary: !TARGET_HOST!
)

:: 2. Hedef JSON manifest yolunu belirle
set "MANIFEST_DIR=%LOCALAPPDATA%\mdm"
set "MANIFEST_PATH=%MANIFEST_DIR%\com.mak.mdm.json"
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%" 2>nul

:: JSON dosyasinda ters boluleri cift ters bolu yap
set "ESCAPED_HOST=!TARGET_HOST:\=\\!"

:: Deterministik Extension ID
set "DEFAULT_EXT_ID=pgeehhablgafglpdgcdnbpfgfcdajijb"
set "CUSTOM_EXT_ID=%~1"

:: 3. Manifest JSON dosyasini olustur
(
echo {
echo   "name": "com.mak.mdm",
echo   "description": "Mak Download Manager Native Messaging Host",
echo   "path": "!ESCAPED_HOST!",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://!DEFAULT_EXT_ID!/"!EXTRA_COMMA!
if defined CUSTOM_EXT_ID (
echo     ,"chrome-extension://!CUSTOM_EXT_ID!/"
)
echo   ]
echo }
) > "%MANIFEST_PATH%"

echo [BILGI] Manifest olusturuldu: %MANIFEST_PATH%
echo.

:: 4. Windows Kayit Defteri (Registry) Kayitlari (Google Chrome, Brave, Edge)
echo Kayit Defteri kayitlari yapilandiriliyor...

:: Google Chrome
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mak.mdm" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Google Chrome Native Messaging kaydi basarili.
) else (
    echo [HATA] Google Chrome kaydi eklenemedi.
)

:: Brave Browser
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.mak.mdm" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Brave Browser Native Messaging kaydi basarili.
) else (
    echo [HATA] Brave Browser kaydi eklenemedi.
)

:: Microsoft Edge
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mak.mdm" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Microsoft Edge Native Messaging kaydi basarili.
) else (
    echo [BILGI] Microsoft Edge kaydi atlandi.
)

echo.
echo ========================================================
echo  Kurulum Basariyla Tamamlandi!
echo  Sabit Extension ID: !DEFAULT_EXT_ID!
echo.
echo  Brave veya Google Chrome'da:
echo  1. chrome://extensions veya brave://extensions sayfasini acin
echo  2. 'Gelistirici modu' (Developer mode) anahtarini acin
echo  3. 'Paketlenmemis oge yukle' butonuna basin
echo  4. '%SCRIPT_DIR%' klasorunu secin.
echo ========================================================
echo.
