# VeriArfy

**Sosyal medya kullanımı anksiyete ve panik atağı artırıyor mu?**
Bu soruyu, katılımcıların bireysel yanıtları **hiç açılmadan** yanıtlayan açık bir çalışma.

Kimlik doğrulaması **zero-knowledge** (Groth16), veri işleme **tamamen homomorfik
şifreleme** (Zama FHEVM), ağ **Sepolia**.

---

## Güven ama doğrula

Projenin çekirdek iddiası şu: *gizlilik için bilimsel doğruluktan ödün vermek
gerekmiyor.* Bunu iddia etmekle bırakmıyoruz — **aynı veriyi iki bağımsız hattan
geçirip sonuçların birebir aynı çıktığını gösteriyoruz.**

| | **Düz-metin hattı** | **FHE hattı** |
|---|---|---|
| Puanlar | açık | şifreli |
| Toplama | doğrudan | homomorfik, zincir üstünde |
| Bireysel puan görülebilir mi | **evet** | **hayır, hiç** |
| Sonuç | referans | doğrulanan |

```bash
npm run study:verify
```

Gerçek çıktı (60 katılımcı, gerçek ZK kanıtı + gerçek FHE işlemleri):

```
── Grup toplamlari: duz-metin vs FHE ──
  anxiety grup 0: duz(n=20, Σx=881,  Σx²=39497) | fhe(n=20, Σx=881,  Σx²=39497)
  anxiety grup 1: duz(n=20, Σx=1010, Σx²=51578) | fhe(n=20, Σx=1010, Σx²=51578)
  anxiety grup 2: duz(n=20, Σx=1233, Σx²=76253) | fhe(n=20, Σx=1233, Σx²=76253)
  panic   grup 0: duz(n=20, Σx=226,  Σx²=2782)  | fhe(n=20, Σx=226,  Σx²=2782)
  panic   grup 1: duz(n=20, Σx=267,  Σx²=3757)  | fhe(n=20, Σx=267,  Σx²=3757)
  panic   grup 2: duz(n=20, Σx=316,  Σx²=5154)  | fhe(n=20, Σx=316,  Σx²=5154)

✓ Iki hat birebir ayni sonucu uretti.
```

### Neden birebir aynı çıkıyor?

Bir grubun **bütün** istatistiği üç tamsayıdan türetilebilir:

```
n = katılımcı sayısı,  S = Σx,  Q = Σx²

ortalama = S / n
varyans  = (n·Q − S²) / (n·(n−1))
```

Bu yüzden FHE hattının bireysel puanı açmasına hiç gerek yok — sadece bu üç
toplamı homomorfik olarak biriktiriyor. İki hat *aynı tamsayıları* ürettiği için
sonraki Welch t-testi, Cohen's d ve p-değeri de kaçınılmaz olarak aynı çıkıyor.

---

## Çalışma tasarımı

**Maruziyet (3 grup):** günlük sosyal medya süresi — `0–5 saat` · `5–10 saat` · `10+ saat`
**Birincil karşılaştırma:** düşük (0–5s) ↔ yüksek (10+s)

**Sonuç ölçütleri**
- **Anksiyete** — Burns Anxiety Inventory yapısı: 33 madde × 0–3 = **0–99**,
  üç alt ölçek (Anksiyeteli Duygular 6 · Anksiyeteli Düşünceler 11 · Fiziksel Belirtiler 16),
  yayımlanmış kesim noktaları (0–4 minimal … 51–99 aşırı/panik).
- **Panik** — PDSS yapısı: 7 madde × 0–4 = **0–28**.

**İstatistik:** Welch t-testi (Satterthwaite df) · Cohen's d · %95 güven aralığı ·
iki yönlü p-değeri (düzenlenmiş eksik beta fonksiyonu ile, dış bağımlılık yok).

> **Telif notu.** [packages/study/src/instruments.js](packages/study/src/instruments.js)
> içindeki madde metinleri, Burns envanterinin *yapısını* (madde sayısı, alt ölçekler,
> 0–3 puanlama, kesim noktaları) birebir izleyen **özgün Türkçe ifadelerdir**;
> Dr. Burns'ün telifli madde metinleri değildir. Lisanslı tam metniniz varsa
> yalnızca o dosyadaki `text` alanlarını değiştirin — puanlama, istatistik ve
> FHE hattı hiç değişmeden çalışmaya devam eder.

---

## Gizlilik modeli — ne açılır, ne açılmaz

| Veri | Durum |
|---|---|
| Kim olduğunuz | **Hiç yazılmaz.** Zincire yalnızca "akredite listede" ZK kanıtı gider |
| Bireysel anksiyete/panik puanınız | **Hiç açılmaz.** Şifreli halde toplama katılır, saklanmaz |
| Hangi kullanım grubunda olduğunuz | **Şifreli.** `eq`+`select` ile doğru gruba homomorfik eklenir |
| Grup düzeyinde n, Σx, Σx² | **Açılır** — yayımlanan sonuç bu, herkes doğrulayabilsin diye |

Ek korumalar:
- **Çift katılım engeli** — ZK nullifier (aynı kimlik iki kez kayıt olamaz) +
  adres başına tek gönderim.
- **Bütünlük** — puanlar kontratta `FHE.min` ile üst sınıra kırpılır, kareler
  kontratta hesaplanır; kötü niyetli bir katılımcı şişirilmiş değerle toplamları bozamaz.

---

## Mimari

```
packages/
├── circuits/    Circom devresi (Poseidon + Merkle 20) + Groth16 anahtarları
├── study/       Ölçekler, puanlama, istatistik motoru, düz-metin hattı
├── contracts/   VeriArfyRegistry (ZK kayıt) · AnxietyStudy (FHE) · VeriArfyVault
├── curator/     Akredite katılımcı ağacı + Merkle yolu servisi
└── web/         React arayüz — anket, şifreleme, canlı sonuçlar
```

---

## Kurulum

```bash
npm install
```

### 1. Devreyi derle (bir kez)

```bash
npm run circuits:build
```

### 2. Doğrulama koşumu — hiçbir şey deploy etmeden

```bash
npm run study:test      # istatistik motorunun öz-testi (26 kontrol)
npm run study:verify    # iki hattı karşılaştır (gerçek ZK + FHE, yerel)
```

Kohort boyutu: `COHORT=20 npm run study:verify` (grup başına katılımcı).

### 3. Sepolia'ya deploy

`packages/contracts/.env` doldurun (`.env.example`'a bakın), sonra:

```bash
npm run contracts:deploy:sepolia
```

Adresler `packages/web/src/config/deployment.json` dosyasına otomatik yazılır.

### 4. Sepolia canli kontrolu (D/15, dort asamali)

Deploy ciktisindaki `packages/contracts/deployments/sepolia.json` icindeki
`authorizedNodes` public topolojinin tek kaynagidir. `prepare` asamasi
`LIVE_CHECK_QUERY_TYPE` icin yalnizca `1` (GWAS), `2` (ML) veya `4`
(STATISTICS) kabul eder; zincirde `requiredApprovals(type) === 2` degilse
ilk mutation/proof oncesi fail-closed durur. Gercek Sepolia islemleri gas ve
onceden yatirilmis node stake'i gerektirir; deploy veya live-check otomatik
fonlama/stake yapmaz.

PowerShell'de deployer ve her node icin ayri operator/key-custody shell'i
kullanin. `NODE_PRIVATE_KEY` shared `.env` dosyasina yazilmaz; node-1 ve
node-2 ayni proseste veya ayni private key ile calistirilmaz. Handoff id'leri
public'tir ve prepare ciktisindan kopyalanir. Live-check shared `.env` dosyasini
yuklemez; asagidaki stage/key degerleri her operator prosesinde explicit verilir:

```powershell
# Deployer shell: prepare
$env:DEPLOYER_PRIVATE_KEY = '<deployer-key>'
$env:NODE_PRIVATE_KEY = ''
$env:LIVE_CHECK_STAGE = 'prepare'
$env:LIVE_CHECK_QUERY_TYPE = '2'       # 1, 2 veya 4
npm run chain:live-check
# Ciktilardan LIVE_CHECK_QUERY_ID ve LIVE_CHECK_REQUEST_ID'yi kopyalayin.

# Node-1 operator shell (ayri custody/process)
$env:DEPLOYER_PRIVATE_KEY = ''
$env:NODE_PRIVATE_KEY = '<node-1-key>'
$env:LIVE_CHECK_STAGE = 'node-1'
$env:LIVE_CHECK_QUERY_ID = '<public-query-id>'
$env:LIVE_CHECK_REQUEST_ID = '<public-request-id>'
npm run chain:live-check

# Node-2 operator shell (node-1'den ayri custody/process)
$env:DEPLOYER_PRIVATE_KEY = ''
$env:NODE_PRIVATE_KEY = '<node-2-key>'
$env:LIVE_CHECK_STAGE = 'node-2'
$env:LIVE_CHECK_QUERY_ID = '<public-query-id>'
$env:LIVE_CHECK_REQUEST_ID = '<public-request-id>'
npm run chain:live-check

# Deployer shell: complete
$env:DEPLOYER_PRIVATE_KEY = '<deployer-key>'
$env:NODE_PRIVATE_KEY = ''
$env:LIVE_CHECK_STAGE = 'complete'
$env:LIVE_CHECK_QUERY_ID = '<public-query-id>'
$env:LIVE_CHECK_REQUEST_ID = '<public-request-id>'
npm run chain:live-check
```

Bu kanit yalniz M-of-N authorization ve iki ayri signer handoff'unu gosterir;
HSM, DKG veya gercek threshold decryption uygulandigi iddia edilmez.

### 5. Kurator servisi

```bash
npm run curator              # http://localhost:8787
npm run curator:push-root    # ağacın kökünü zincire yazar
```

### 6. Arayüz

```bash
npm run web:dev
```

`http://localhost:5173/?preview=survey` ile anketi cüzdan/zincir olmadan
tasarım önizlemesinde görebilirsiniz.

---

## Doğrulanmış durum

| Kontrol | Sonuç |
|---|---|
| `npm run study:test` | ✅ 26/26 — t kritik değeri yayımlanmış tabloyla eşleşiyor (2.179, df=12) |
| `npm run study:verify` | ✅ 60 katılımcı, 18 tamsayının hepsi birebir aynı |
| `npm run contracts:test` | ✅ 2/2 |
| `npm run web:build` | ✅ gerçek Zama TFHE WASM paketleniyor |
| Arayüz anket akışı | ✅ 33+7 madde, puanlama ve bant eşlemesi doğrulandı |

---

## Dürüst sınırlar

- **Şu anki sayılar gerçek bulgu değildir.** Doğrulama koşumu, iki hattın aynı
  sonucu ürettiğini göstermek için tohumlanmış **test verisi** kullanır
  ([synthetic.js](packages/study/src/synthetic.js)). Gerçek bulgu, gerçek
  katılımcılar arayüzden yanıt verdikçe oluşur.
- **Yerel koşum FHEVM mock'u kullanır** — kod yolları, ACL ve işlem semantiği
  gerçek, ancak kriptografi Sepolia'da (Zama koprosesörü) gerçekten yapılır.
  Tarayıcıdaki şifreleme her durumda gerçek TFHE WASM'dir.
- **Gözlemsel çalışmadır** — nedensellik değil, ilişki ölçer. Yüksek kullanım ile
  yüksek anksiyete birlikte görülebilir; hangisinin hangisini doğurduğunu bu
  tasarım söyleyemez.
- **`AllowAllVerifier` yalnızca testtedir**, üretimde asla deploy edilmemelidir.
- Araştırma amaçlıdır; **tıbbi tanı veya tedavi tavsiyesi değildir.**

## Lisans

BSD-3-Clause-Clear

Kaynaklar: [Burns Anxiety Inventory yapısı ve kesim noktaları](https://www.mdapp.co/burns-anxiety-inventory-calculator-567/) · [Zama FHEVM](https://github.com/zama-ai)
