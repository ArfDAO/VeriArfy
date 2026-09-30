# MK-0019 — Araştırmacı doğrulaması (kurumsuz), Faz 1

**Durum:** Kabul edildi · 30 Eylül 2026
**Kod:** `packages/curator/src/verification/`, `packages/curator/src/chain.js`,
`packages/contracts/contracts/AccreditationLog.sol`,
`packages/web/src/components/ResearcherVerification.tsx`
**Kilit:** `AccreditationLog.test.ts` (7), `verification.test.js` (19),
`curator/test/flow.e2e.mjs` (uçtan uca, 24 kontrol)

---

## Karar

Akredite araştırmacı listesine **doğrulama olmadan girilemez.** Önceki
`/enroll` ucu herkese açıktı: taahhüdünü gönderen herkes akredite oluyordu.
Kapatıldı (410).

Kurumla anlaşma olmadan araştırmacılık şöyle doğrulanır:

1. **Kurum e-postası (zorunlu).** `.edu.tr` adresine 6 haneli kod gider; koda
   erişmek kutuya erişimi kanıtlar. Profil kontrolü tek başına sahiplik
   kanıtlamaz, bu yüzden e-posta her yolda zorunludur.
2. **Akademik durum**, iki yoldan biriyle:
   - **ORCID ile giriş** — sahipliği ORCID'in kendisi doğrular (OAuth,
     `/authenticate`). Kayıttaki **güncel** istihdamın kurumu, e-postanın
     kurumuyla eşleştirilir. Otomatik onay.
   - **YÖK Akademik / AVESİS profili** — operatör incelemesi.
3. Doğrulanan kişi listeye **tek bir kimlikle** eklenir. Zincirde hangi
   akredite kişinin işlem yaptığını ZK kaydı gizler.

Kurumun rolü bu modelde yalnızca ikidir: verinin doğruluğunu imzalamak ve
satın almada onay vermek (BSKK-44 onay eşiği, MK-0006).

---

## Doğrulanmış varsayımlar

| Varsayım | Sonuç | Kaynak |
|---|---|---|
| ORCID ile giriş sahipliği kanıtlar | Evet | ORCID entegrasyon rehberi |
| ORCID genel API üye olmayanlarca kullanılabilir | Evet; üretimde yalnız HTTPS yönlendirme | ORCID Public API belgesi |
| YÖK Akademik'in API'si / giriş özelliği var | **Hayır** | akademik.yok.gov.tr |
| Render ücretsiz katman SMTP gönderebilir | **Hayır** (25, 465, 587 kapalı) | render.com/docs/free |
| Render ücretsiz katmanda disk kalıcı | **Hayır**; uyku, yeniden başlatma ve dağıtımda silinir | render.com/docs/free |
| ROR kaydı kurumun alan adını içerir | Evet (ör. Erciyes → `erciyes.edu.tr`) | api.ror.org |
| Resend alan adı doğrulaması ister | Evet | Resend belgeleri |

## Tasarım kararları ve gerekçeleri

**Kurum eşleştirmesi isimle değil alan adıyla.** ORCID'deki kurum, ROR
kaydındaki resmi alan adıyla karşılaştırılır. Kurum ROR ile tanımlıysa doğrudan
o kayda, değilse ROR'un *affiliation* eşleştirmesine bakılır ve yalnız onun
**emin olduğu** (`chosen`) eşleşme alınır. İsim araması yetmedi: gerçek bir
Erciyes çalışanı kurumunu "Erciyes Üniversitesi/ Erciyes University" diye
girmişti ve isim araması sonuç döndürmedi.

Gerçek veriyle ölçüldü (üç üniversite, 30 kayıt): 19 eşleşme, **0 yanlış
eşleşme**. Eşleşmeyenlerin tamamı meşru: ORCID'de güncel istihdam yok
(öğrenci/mezun) ya da kişi şu an başka üniversitede.

**Kanıt gücü kaydedilir.** ORCID istihdamı kişinin kendisi girdiyse *beyan*,
bir üye kurumun sistemi girdiyse *kurum onaylı*. İkisi farklı `evidence`
değeriyle zincire yazılır; ileride kurum düğümleri daha güçlü kanıt isteyebilir.

**Liste zincirde (`AccreditationLog`), diskte değil.** Disk kalıcı olmadığı
için "kişi başına tek kimlik" kuralı diskte uygulanamazdı: kullanılmış e-posta
kaydı her uykuda silinir, aynı kişi aynı adresle yeniden kaydolurdu. Kurator
açılışta listeyi zincirden kurar.

**E-posta zincire açık yazılmaz.** Yazılan, kuratörün gizli anahtarıyla
üretilmiş HMAC özetidir. Düz hash yetmezdi: kurum adresleri tahmin edilebilir
(`ad.soyad@universite.edu.tr`) ve denemeyle geri bulunurdu.

**Sunucu durum tutmaz.** Kod, e-posta oturumu, ORCID dönüşü ve operatör onayı
imzalı jetonlarla taşınır. Sunucu yeniden başlasa da akış kopmaz.

**`+etiket` atılır.** Birçok sunucu `ad+x@` adresini `ad@` kutusuna teslim
eder; atılmasa aynı kişi sınırsız kimlik açardı.

**Operatör onayı yalnız POST.** E-posta güvenlik tarayıcıları bağlantıları
önceden açabiliyor; GET ile onaylansaydı bir tarayıcı başvuruyu kendiliğinden
onaylardı.

## Güven noktaları (bu fazda kalan)

- **Kuratör kayıt anında kimi gördüğünü bilir** (e-posta ↔ taahhüt). Zincirde
  hangi cüzdanın kim olduğu gizli kalır, ama listeyi tutan tarafa güvenilir.
  Bunu kaldırmak Faz 3'ün işidir (e-postanın DKIM imzasını ZK devresinde
  doğrulamak).
- **E-posta mensubiyeti kanıtlar, akademik unvanı değil.** Birçok üniversite
  öğrencilere de `edu.tr` adresi veriyor. `ogr.`/`student.` alt alan adları
  reddedilir ama bu yalnız bir ön elemedir; akademik durumu ORCID ya da profil
  incelemesi belirler.
- **ORCID beyanı kişinin kendisi girebilir.** En güçlü kombinasyon: `edu.tr`
  e-postası + ORCID'de aynı kurum (tercihen kurum onaylı).

## Bilinen sınırlar (sonraki fazlar)

- **Süre sonu / iptal yok.** `VeriArfyRegistry` kaydı kalıcı; üniversiteden
  ayrılan biri erişimini korur. Yıllık yeniden doğrulama sözleşme değişikliği
  (Registry + Payments yeniden dağıtımı) gerektirir — Faz 2.
- **Faz 3 (DKIM-ZK)** yalnız e-postasını DKIM ile imzalayan üniversitelerde
  mümkün. Örneklenen 10 üniversiteden 3'ünde anahtar bulundu (İTÜ 1024 bit,
  Erciyes ve Osmangazi 2048 bit); diğerleri için gerçek e-posta başlığı gerekir.

## Geçiş

Yeni kuratör açıldığında dağıtımdaki `AccreditationLog` boştur; kök boş
listenin köküne güncellenir. **Zaten kayıtlı araştırmacılar etkilenmez**
(`isRegistered` kalıcı). Liste sözleşmesi yapılandırılmamışken kök
**yazılmaz** — aksi halde boş listenin kökü geçerli kökü ezerdi.

Eski `data/tree.json` artık kullanılmıyor. `push-root` aracı da listeyi
zincirden okur; eski dosyayı okusaydı bayat kökü yazıp doğrulanmış herkesi
geçerli kökün dışına iterdi.
