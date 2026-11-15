# Mak Download Manager (MDM) — Tarayıcı Entegrasyonu (Brave & Google Chrome)

Bu eklenti, Chromium tabanlı tarayıcılardan (**Brave**, **Google Chrome**) başlatılan dosya ve video indirmelerini doğrudan **Mak Download Manager (MDM)** masaüstü uygulamasına ve yüksek hızlı parçalı indirme motoruna aktarmak için geliştirilmiştir.

---

## 1. Mimari Genel Bakış

- **Manifest Sürümü**: Manifest V3
- **İletişim Kanalı**: Chromium Standard Native Messaging (`com.mak.mdm`)
- **İletişim Şeması**: Standart Girdi/Çıktı (`stdin` / `stdout`), 32-bit little-endian uzunluk önekli UTF-8 JSON paketleri.
- **İşletim Sistemi Kaydı**: Windows Kayıt Defteri (`HKCU\Software\Google\Chrome\NativeMessagingHosts` ve `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts`).

---

## 2. Kurulum ve Yükleme Adımları

### Adım 1: Native Messaging Host'unu Derleyin ve Kaydedin
1. Komut İstemi (CMD) ile masaüstü motorunu derleyin:
   ```cmd
   cd src-tauri
   cargo build --bin mdm_host
   ```
2. `browser-extension/` klasöründeki kayıt komut dosyasını çalıştırın:
   ```cmd
   cd browser-extension
   register_host.bat
   ```
   *Bu işlem Chrome ve Brave için gerekli kayıt defteri anahtarlarını otomatik oluşturur.*

### Adım 2: Eklentiyi Tarayıcıya Yükleyin
1. **Google Chrome** için `chrome://extensions` veya **Brave** için `brave://extensions` adresine gidin.
2. Sağ üst köşedeki **Geliştirici Modu (Developer mode)** anahtarını açın.
3. Sol üstteki **Paketlenmemiş öge yükle (Load unpacked)** butonuna tıklayın.
4. Bu projedeki `browser-extension/` klasörünü seçin.

---

## 3. Özellikler ve Kullanım

1. **Bağlantıya Sağ Tıklama ile İndirme**:
   - Herhangi bir indirilebilir dosya bağlantısına sağ tıklayıp **"MDM ile İndir"** seçeneğini seçin.
   - İndirme doğrudan MDM kuyruğuna aktarılır.
2. **Video Akışlarını Yakalama**:
   - YouTube, Vimeo vb. sayfalarda veya video oynatıcılara sağ tıklayıp **"MDM ile Video İndir"** seçeneğini seçin.
   - MDM analiz modülü videoyu analiz eder ve kalite seçenekleriyle indirmeyi başlatır.
3. **Açılır Pencere (Popup)**:
   - MDM masaüstü uygulamasının çalışıp çalışmadığını ve bağlantı durumunu görüntüler.
   - Tek tıkla MDM masaüstü uygulamasını açar.
   - Hızlı URL yapıştırma alanı sunar.
   - **Otomatik İndirme Yakalama (Download Interception)** özelliğini açıp kapatmanızı sağlar.

---

## 4. Teknik Sınırlar ve Güvenlik Güvenceleri

1. **Blob ve Data URL'leri**:
   - `blob:` ve `data:` bağlantıları tarayıcının yerel bellek nesneleridir. Eklenti bu bağlantıları dışarı aktarmaya çalışmaz ve kullanıcıyı bilgilendirir.
2. **Oturum / Çerezler (Cookies)**:
   - Giriş gerektiren bağlantılarda tarayıcı çerezleri güvenli şekilde MDM'ye iletilir.
3. **Komut Enjeksiyonu Koruması**:
   - Native Messaging Host, gelen URL'leri shell komut dizeleriyle birleştirmez; doğrudan ayrıştırır ve sanitize eder.

---

## 5. Kaldırma (Uninstallation)

Eklenti kaydını Windows sisteminden kaldırmak için:
```cmd
cd browser-extension
unregister_host.bat
```
Ardından tarayıcınızın eklentiler sayfasından eklentiyi "Kaldır" butonuna basarak silebilirsiniz.
