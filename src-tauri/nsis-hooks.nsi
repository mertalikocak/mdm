; ===================================================================
; Mak Download Manager (MDM) — NSIS Custom Hooks
; Automatically registers Native Messaging Host during installation
; and safely unregisters upon uninstallation without touching user data.
; ===================================================================

!macro customInstall
  DetailPrint "Mak Download Manager: Tarayici Native Messaging Host kaydi yapiliyor..."
  ExecWait '"$INSTDIR\mdm.exe" --register-host'
!macroend

!macro customUnInit
  ; Uninstaller baslarken dosyalar henuz silinmemisken unregister komutunu cagir
  ExecWait '"$INSTDIR\mdm.exe" --unregister-host'
!macroend

!macro customUnInstall
  ; Guvence olarak dogrudan Registry anahtarlarini ve manifest dosyasini kaldir
  DetailPrint "Mak Download Manager: Native Messaging kayitlari temizleniyor..."
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.mak.mdm"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.mak.mdm"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.mak.mdm"
  Delete "$LOCALAPPDATA\mdm\com.mak.mdm.json"
!macroend
