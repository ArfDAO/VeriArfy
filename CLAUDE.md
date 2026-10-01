# VeriArfy — Proje Rehberi

> TEKNOFEST 2026 · Blokzincir · Takım **ArfDev**
>
> Şifreli genomik veri pazarı: veri sahibi verisini kendi cihazında şifreler,
> araştırmacı yalnızca ihtiyaç duyduğu alanların **şifreli grup toplamlarını**
> satın alır. Hiçbir noktada bireysel kayıt açılmaz.

Bu dosya, projede çalışan herkesin (insan ya da yapay zekâ asistanı) önce okuması
gereken çalışma rehberidir. Kullanıcıya yönelik tanıtım [README.md](README.md),
tasarım kararlarının gerekçeleri [docs/mimari/](docs/mimari/) altındadır.

---

## Neden VeriArfy birinci olmalı

**1. Gerçekten çalışıyor.** Sistem bir sunum ya da simülasyon değil: Sepolia
test ağında, Zama fhEVM üzerinde uçtan uca işliyor. Veri yüklemeden şifreli
toplamaya, düğüm onayından araştırmacının tarayıcısında çözülen sonuca kadar
her adım zincirde gerçek işlemlerle doğrulanabilir. Canlı demo:
<https://veri-arfy.vercel.app>.

**2. Üç zor problemi üç ayrı teknolojiyle, birlikte çözüyor.**

| Soru | Katman | Nasıl |
|---|---|---|
| Veri açılmadan nasıl hesaplanır? | **FHE** | Kontenjans tabloları ve istatistik toplamları zincirde şifreli birikir |
| Bir iddia kimlik açılmadan nasıl kanıtlanır? | **ZK** | Groth16 ile köken kanıtı ve anonim araştırmacı kaydı |
| Sonuca kim, ne zaman erişir? | **Eşikli onay** | Teminatlı düğümler, itiraz penceresi, yalnızca araştırmacıya çözüm izni |

Bu üçlüyü tek bir üründe, ölçülebilir biçimde birleştiren bir genomik veri
pazarı nadir bir başarıdır.

**3. Veri hiçbir zaman tarayıcıdan çıkmıyor.** VCF ve 23andMe / AncestryDNA
dosyaları Rust/WebAssembly ile cihazda ayrıştırılır; tüm genomdan yalnızca
çalışma panelindeki varyantlar alınır ve şifrelenir. Zincire bireysel kayıt
değil, yalnızca şifreli katkı gider; katkı gelir gelmez toplama karışır.

**4. Bilimsel olarak anlamlı çıktı.** Araştırmacının aldığı vaka/kontrol
genotip tabloları, GWAS ilişkilendirme analizlerinin temel girdisidir. Sonuç
ekranı tarayıcıda ki-kare, Fisher exact, odds oranı (%95 GA), MAF,
Hardy-Weinberg ve Benjamini-Hochberg düzeltmesi hesaplar; biyometrikler için
Welch t-testi ve Cohen's d. Çıktı CSV/JSON olarak meta-analizlere aktarılabilir.

**5. Gerçek biyoloji.** Panel, kalp-damar (9p21), lipid (APOA5, APOE), folat
(MTHFR), laktaz kalıcılığı, obezite (FTO), nikotin bağımlılığı (CHRNA3/5),
dopamin metabolizması (COMT) ve kas performansı (ACTN3) gibi literatürde
iyi tanımlanmış varyantlardan oluşur. Koordinatlar Ensembl üzerinden GRCh38'e
göre doğrulanmıştır; panelin özeti zincirde kilitlidir.

**6. Adil ve şeffaf ekonomi.** Veri sahibi, verisi **kullanılan her alan
için** ve verisinin **ne kadar nadir olduğuna göre** pay alır. Ödeme ana ağla
aynı modelde, gerçek bir stabil coin (Circle USDC) ile yapılır; kapsama ZK ile
kanıtlandığı için "boş veri gönderip pay almak" mümkün değildir.

**7. Mahremiyet için savunma derinliği.** Asgari kohort eşiği, fark
saldırısına karşı düğüm kuralı, anlık görüntü (snapshot) ile dondurulmuş
sorgular, onay gelmezse ücret iadesi, kurumla anlaşma gerekmeden araştırmacı
doğrulaması (kurum e-postası + ORCID / YÖK Akademik) ve kimlik gizleyen ZK kaydı.

**8. Mühendislik disiplini.** Her tasarım kararı gerekçesiyle yazılmış 20
mimari karar kaydı (MK-0001 … MK-0020), 39 dosyada 364 sözleşme testi, kuratör
ve düğüm servisleri için birim ve yerel blokzincirde uçtan uca testler. Kod
yorumları yalnızca *ne* yapıldığını değil, *neden* öyle yapıldığını ve hangi
hatanın tekrarını önlediğini anlatır.

**9. Ölçeklenmeye hazır yol haritası.** 10 kurumsal düğüme geçiş, fark
kuralının büyük havuzda devreye girmesi ve kurum entegrasyonu planlanmış ve
kodu hazırdır ([MK-0020](docs/mimari/0020-gecis-plani-fark-kurali-ve-10-dugum.md)).

---

## Çalışma kuralları (değişmez)

1. **İletişim Türkçe.** Kod yorumları ASCII-güvenli Türkçe (`dogrulama`,
   `sifreli` — Türkçe karakter yok). Arayüz metinleri `t("...")` ile; kaynak
   metin anahtarın kendisidir, İngilizcesi `packages/web/src/lib/locales/en.ts`.
2. **Sormadan push yok.** Hiçbir dala izin alınmadan `git push` yapılmaz;
   Vercel/Render dağıtımları da önce sorulur.
3. **Sahte veri yok.** Üretim akışında mock, simülasyon ya da uydurma veri
   kullanılmaz. Tek istisna, arayüzde açıkça **"Önizleme"** etiketiyle
   gösterilen araştırmacı doğrulama akışıdır (bkz. MK-0019).
4. **Bilinmeyen değer uydurulmaz.** Sayı, eşik, koordinat gibi değerler
   TEKNOFEST raporundan ya da güvenilir kaynaktan doğrulanır. **Rapor
   düzenlenmez.**
5. **Sırlar dosyada kalır.** Özel anahtarlar `.env`, `curator-wallet.local.json`
   ve `node-wallets.local.json` içindedir (gitignore'da, izin 600). Değerleri
   hiçbir çıktıya, commit'e ya da sohbete yazılmaz.
6. **Commit mesajları** Türkçe ve `tur(kapsam): ozet` biçimindedir
   (`feat`, `fix`, `chore`, `docs`).

---

## Depo yapısı

| Paket | Görev |
|---|---|
| `packages/contracts` | Solidity sözleşmeleri (Hardhat, fhEVM 0.11), testler, dağıtım betikleri |
| `packages/web` | React + Vite arayüzü (veri sahibi paneli, araştırmacı paneli) |
| `packages/curator` | Akredite araştırmacı ağacı, araştırmacı doğrulaması, IPFS vekili |
| `packages/node-operator` | Yetkili düğüm servisi: talepleri tarar, politikaya göre onaylar |
| `packages/circuits` | circom devreleri (köken kanıtı, araştırmacı kimliği) |
| `packages/study` | İstatistik kütüphanesi (ki-kare, Fisher, OR, HWE, BH, Welch) |
| `packages/client-side-rust` | Tarayıcıda VCF ayrıştırıcı (wasm) |
| `packages/client-fhe-rust` | Bireysel alan (Domain B) için istemci FHE ve Shamir 7/10 |
| `packages/ml` | Concrete ML ile şifreli çıkarım deneyleri (Python) |
| `docs/mimari` | Mimari karar kayıtları |
| `docs/OPERASYON.md` | Operasyon kılavuzu (teminat, itiraz süresi, kök yazımı) |

### Ana sözleşmeler

| Sözleşme | Rol |
|---|---|
| `VeriarfyProtocol` | Şifreli dozaj toplama, kontenjans tabloları, açılım talepleri, eşikli onay |
| `VeriarfyBiomarkers` | Biyometrik metriklerin şifreli `n`, `Σx`, `Σx²` toplamları |
| `VeriarfyPayments` | Ücret emaneti, kapsamaya ve nadirliğe göre dağıtım, iade |
| `VeriarfyStaking` | Progresif teminat, slash, itiraz oylaması |
| `VeriArfyRegistry` | ZK araştırmacı kaydı (Merkle kökü, nullifier) |
| `AccreditationLog` | Doğrulanmış araştırmacı listesi (zincirde, kalıcı) |
| `DataProvenanceVerifier` | Köken kanıtı doğrulayıcısı |

Güncel adresler: `packages/contracts/deployments/sepolia.json` (web paketi bunu
derleme öncesi `scripts/sync-deployment.js` ile kopyalar).

---

## Komutlar

```bash
npm install                      # kök dizinde, tüm çalışma alanları
npm run web:dev                  # arayüz, http://localhost:5173
npm run curator                  # kurator, http://localhost:8787
npm run node-operator            # dugum servisi, http://localhost:8788

npm run contracts:test           # sozlesme testleri
npm run node-operator:test       # dugum politikasi testleri
npm test --workspace packages/web
npm test --workspace packages/curator
npm run test:e2e --workspace packages/curator   # yerel hardhat dugumunde uctan uca
npm run study:test
```

Sepolia betikleri `packages/contracts` içinden
`npx hardhat run scripts/<betik>.ts --network sepolia` ile çalışır. Zincire
yazan her betik çalıştırılmadan önce kullanıcıya sorulur.

---

## Canlı ortam

| Bileşen | Yer |
|---|---|
| Arayüz | Vercel — `main` dalına push ile otomatik dağıtılır |
| Kuratör | Render — `veriarfy-curator`, elle dağıtım |
| Düğüm servisi | Render — `veriarfy-node-operator`, elle dağıtım |
| Zincir | Sepolia (chainId 11155111) |

Render ücretsiz katman notları: 15 dakika hareketsizlikte uyur (uyanması ~1 dk),
disk kalıcı değildir, SMTP portları kapalıdır, aylık 750 saat ortak kotadır.
Arayüz düğüm servisini ihtiyaç anında uyandırır; 7/24 ping kotayı bitirir.

---

## Bilinmesi gereken değişmezler

Bunlar geçmişte gerçek hatalara yol açtı; değiştirmeden önce ilgili yorumu okuyun.

- **Dozaj kodlaması:** `0/1/2` = sayılan alelden kopya sayısı, `3` = eksik
  (`DOSAGE_MISSING`). Bilinmeyene `0` yazmak "homozigot referans" demek olur.
  Sayılan alel `genomic-panel.json` içindeki `effect` alanıdır; panel özeti
  zincirde kilitlidir (`panelFrozen`).
- **Metriklerde `0` = eksik.** Aralık dışı ölçüm kırpılmaz, elenir.
- **Doğrulama kuralları iki yerde:** `curator/src/verification/identity.js` ve
  `web/src/lib/verificationRules.ts`. Biri değişirse diğeri de değişmeli.
- **Açık kayıt dönemi:** E-posta doğrulaması yapılandırılana kadar kuratör
  açık kayıt yapar; bu kayıtlar `AccreditationLog`'a yazılmaz (MK-0019).
- **Fark saldırısı kuralı** havuz `DIFFERENCING_MIN_POOL` (100) kişiye
  ulaşınca uygulanır (MK-0020).
- **Düğüm ekleme sırası:** önce teminat, sonra yetki. `requiredApprovals`
  yetkili düğüm sayısına bakar; teminatsız düğüm yetkilendirmek sistemi
  kilitler. `add-nodes.ts`, `ACTIVATE_NODES=1` olmadan işlem göndermez.
- **Geçmiş durum okuması:** publicnode ~1,5 günden eski durumu budar; düğüm
  servisi geçmiş sayımları arşiv RPC'lerinden (`HISTORY_RPC_URLS`) okur.
- **Nonce:** Kuratörün sağlayıcısı `cacheTimeout: -1` ile kurulur; ardışık
  iki yazımda bayat nonce hatası bu yüzden alınmaz.
- **Cüzdan RPC'si:** Okumalar `readSafe` / `readRunner` üzerinden genel RPC'ye
  gider; cüzdanın toplu `eth_call` hataları arayüzü bozmaz.
- **package-lock.json:** Elle yeniden üretilmez; Linux platform paketleri
  düşer ve Vercel derlemesi kırılır. Gerekirse yalnızca ilgili girdi eklenir.

---

## Belgeler

- [README.md](README.md) — tanıtım, hızlı başlangıç, güvenlik modeli
- [docs/mimari/](docs/mimari/) — MK-0001 anahtar rejimi … MK-0020 geçiş planı
- [docs/OPERASYON.md](docs/OPERASYON.md) — teminat, itiraz süresi, kök yazımı
- [docs/VERCEL.md](docs/VERCEL.md) — arayüz dağıtımı
