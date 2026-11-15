@echo off
echo ========================================================
echo  Mak Download Manager (MDM) - Native Messaging Temizligi
echo ========================================================
echo.

:: Google Chrome kaydini sil
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mak.mdm" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Google Chrome Native Messaging kaydi silindi.
) else (
    echo [-] Google Chrome kaydi bulunamadi veya zaten silinmis.
)

:: Brave Browser kaydini sil
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.mak.mdm" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Brave Browser Native Messaging kaydi silindi.
) else (
    echo [-] Brave Browser kaydi bulunamadi veya zaten silinmis.
)

:: Microsoft Edge kaydini sil
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mak.mdm" /f >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Microsoft Edge Native Messaging kaydi silindi.
)

:: Manifest dosyasini temizle
if exist "%LOCALAPPDATA%\mdm\com.mak.mdm.json" (
    del "%LOCALAPPDATA%\mdm\com.mak.mdm.json" >nul 2>&1
    echo [OK] Host manifest dosyasi silindi.
)

echo.
echo Temizlik basariyla tamamlandi.
