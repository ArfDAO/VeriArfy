# MK-0015 — Arayuz baglama ve dogrulama konsolu

**Durum:** Kabul edildi · 16 Agustos 2026
**Kod:** `web/src/components/{Contribute,GenomicStep,BiomarkerStep,SystemStatus,TraceConsole}.tsx`,
`web/src/lib/{trace,useTrace,studyPanel}.ts`, `client-side-rust/src/lib.rs`
**Kilit:** `live-check.ts` (gercek Sepolia), `panel.test.ts`, `metrics.test.ts`, `cargo test`
**Ilgili:** [MK-0013](0013-panel-hizalama.md), [MK-0014](0014-surekli-olcum-kanali.md)

---

## Neden bu adim

MK-0013 ve MK-0014 iki veri kanalini bitirdi: sozlesme, kutuphane, test. Ama
hicbir bilesen `panel.ts`, `consumerGenotype.ts` ya da `metrics.ts` dosyalarini
CAGIRMIYORDU. Gercek bir kullanici ne dosya yukleyebiliyor ne olcum
girebiliyordu — iki bitmis kanal, sifir kullanim.

---

## Ayristiricida bulunan iki hata

Arayuzu baglarken VCF yolu tikandi ve sebebi iki gercek hataydi.

### 1. Ayristirici varyant KIMLIGI uretmiyordu

Rust ayristiricisi yalnizca dozaj donduruyordu: `[0, 1, 2, ...]`. Hangi
varyanta ait olduklari hicbir yerde yazili degildi.

Bu, MK-0013'te sozlesme tarafinda duzeltilen hatanin ta kendisidir, bir kat
asagida. Panele hizalama IMKANSIZDI: kimlik olmadan "3 numarali SNP" iki
kullanicida farkli varyant olur.

**Cozum:** panel filtresi. Ayristiriciya calismanin rsID listesi verilir
(`setWantedIds`), yalnizca eslesen varyantlar toplanir ve kimlikleri
dozajlarla ayni sirada doner.

Filtrenin Rust tarafinda olmasi sart: tum genom VCF'i milyonlarca satirdir,
hepsini JS'e tasiyip sonra elemek isin buyuk kismini bellege tasimak olurdu.
Filtre GT cozumunden de ONCE calisir — panelde olmayan bir satirin genotipini
cozmek bosa istir.

### 2. Eksik genotipe 0 yaziliyordu

Koddaki yorum aciktı:

> `// Hizalamayi bozmamak icin yer tutucu 0 yazilir, sayaca islenir.`

Hizalama korunuyordu ama **deger yalan soyluyordu**: 0 "homozigot referans"
demektir, yani "bu mutasyonu tasimiyor". Cagirilamamis (`./.`) bir genotipin
dogru ifadesi "bilmiyoruz"dur.

Sozlesme tarafi MK-0013'te `DOSAGE_MISSING = 3` ile duzeltilmisti; ayristirici
hala 0 yaziyordu. Yani **veri zincire girmeden once bozuluyordu.**

Uc mevcut test bu degisikligi dogru sekilde yakaladi ve yeni davranisa
guncellendi; bes yeni test eklendi (`cargo test` 12/12).

---

## Dogrulama konsolu

Kullanicinin istegi netti: her adimda gercekten calistigini gormek.

Sifreli bir sistemde ekrandaki hicbir sey kendini kanitlamaz — "veri
sifrelendi" yazan bir etiket hicbir sey yapmadan da yazilabilir. Bu yuzden her
adim somut bir KANIT birakir:

| kanit turu | ornek |
|---|---|
| `tx` | islem ozeti + Etherscan baglantisi |
| `value` | blok, harcanan gaz, zincirden okunan sayac |
| `handle` | ciphertext handle'i — sifreli degerin zincirdeki kimligi |
| `hash` | panel ozeti |
| `note` | neden boyle yapildigi |

**Yesil nokta ile ✓ farkli seyler soyler:**

- nokta = islem hatasiz tamamlandi
- ✓ = deger **zincirden geri okunarak** dogrulandi

Ayrim bilinclidir: "gonderdim" ile "zincir oyle diyor" ayni sey degildir.
Yalnizca ikincisi kanittir. Bu yuzden her yazma adiminin ardindan ayri bir
"zincirden geri okundu" adimi calisir ve sozlesme sayacini (`submittedSnps`,
`submittedMetrics`, `isEnrolled`) bekleneniyle karsilastirir.

Kanit uretemeyen bir adim yesil gorunmez.

---

## Sistem durumu: panel ozeti karsilastirmasi

Sayfadaki en onemli satir bu:

```
PANEL ÖZETİ (ZİNCİR)   0x0f5affe0…b901344e
PANEL ÖZETİ (YEREL)    0x0f5affe0…b901344e
GENOMİK PANEL: EŞLEŞTİ ✓
```

Tarayicidaki panel ile zincirin ilan ettigi ozet farkliysa gonderilen dozajlar
baska bir varyant listesine ait olur. Tek kullaniciyla FARK EDILMEZ.

Bu yuzden ozet tarayicida yeniden hesaplanir, zincirdekiyle karsilastirilir ve
**tutmuyorsa katki akisi kapatilir** — devam ettirmek yerine durdurulur.

Metrik sinirlari da yerel bir dosyadan degil sozlesmeden okunur. Sebep: eleme
zincirde yapiliyor. Yerel kopya kullanilsaydi ilan edilen sinir ile ZORLANAN
sinir sessizce ayrisabilirdi.

---

## Calisma tanimlari tek yerde uretilir

`packages/web/scripts/prepare-study.ts`:

1. panelleri okur, ozetlerini hesaplar,
2. IPFS'e (Pinata) sabitler,
3. zincire gidecek metrik dizisini uretir (`bytes32` etiketler, 31 bayti asan
   etiket ACIKCA reddedilir — sessizce kirpilsaydi panelde bir sey, zincirde
   baskasi olurdu),
4. panellerin tarayici kopyasini yazar.

Betik `packages/web` icindedir cunku ozet fonksiyonlari tarayicidakiyle
**birebir ayni** olmak zorunda — kopyalanmaz, dogrudan ithal edilir. Hardhat
betikleri CommonJS oldugu icin oradan ithal edilemezdi.

---

## Panelin kendisi

10 varyantlik demo paneli. Koordinatlar **Ensembl REST** uzerinden
dogrulanmistir (rs4977574, rs1801133, rs4988235, rs1815739, rs9939609,
rs1051730, rs429358, rs7412, rs4680, rs662799).

**Etki aleli kurali:** her varyantta etki aleli, dbSNP'nin bildirdigi ILK
ALTERNATIF aleldir. Bu bir tasarim secimidir ve risk yonu hakkinda hicbir
iddia tasimaz — panelin tamami zaten ozetle sabitlenir.

6 metriklik biyobelirtec paneli: VO2MAX, LACTATE_THRESHOLD, CK_TOTAL,
CK_REPAIR_SLOPE (ISARETLI — `offset` ile kodlanir), RESTING_HR, HRV_RMSSD.

---

## Ne dogrulandi

**Gercek Sepolia** (`live-check.ts`, tek kosum): ZK koken kaniti -> sifreli
kayit -> 10 SNP dozaj -> **6 metrik biyobelirtec** -> esikli tek bit cozumu
(KMS imzasi zincirde dogrulandi) -> odeme -> gelir paylasimi. Toplamlar
handle'lari bos degil, yani homomorfik birikim gercek agda olustu.

**Tarayici**: panel ozeti eslesmesi canli okundu, 6 metrik siniri
sozlesmeden geldi, katilimci sayaci zincirle birlikte degisti, mobilde yatay
tasma yok (genis tablo kendi kabinde kayiyor).

---

## Zama SDK wasm'i — sebebi hic belli olmayan hata

Ilk gercek kullanimda kayit adimi soyle duştu:

```
WebAssembly.instantiate(): expected magic word 00 61 73 6d,
                           found 3c 21 64 6f
```

`3c 21 64 6f` = `"<!do"` — yani wasm sanilan sey **HTML**.

Sebep: SDK kendi wasm'ini `new URL('tfhe_bg.wasm', import.meta.url)` ile
bulmaya calisiyor. Vite gelistirmede paketi on-derleyip
`node_modules/.vite/deps/` altina tasidigi icin bu adres, yaninda wasm
OLMAYAN bir klasore duser; dev sunucusu da bulunamayan yola index.html
dondurur. Hata mesaji sebebi hic anlatmaz.

`?url` ile ithal etmek de calismaz: paketin `exports` alani yalnizca `./web`,
`./bundle`, `./node` yollarini aciyor, `./lib/tfhe_bg.wasm` derin ithali
engelli.

**Cozum:** `scripts/prepare-fhe-wasm.js` iki wasm'i `public/fhe/` altina
kopyalar ve `initSDK`'ya ACIK yol verilir. Betik `predev` ve `prebuild`
kancalarina baglidir — unutulmasi mumkun degil. Paketin yeri Node'un
cozumleyicisine sorulur (`require.resolve`), sabit yol yazilmaz: monorepo'da
paket koke de pakete de kurulmus olabilir.

Dogrulandi: `/fhe/tfhe_bg.wasm` -> HTTP 200, `application/wasm`, ilk dort bayt
`00 61 73 6d`; tarayicida `initSDK` gecti ve dist/ ciktisina da kopyalandi.

**Yan not:** coklu is parcacigi COOP/COEP basliklari ister. Onlar olmadan SDK
uyari basip TEK PARCACIGA duser — calisir, yalnizca yavastir. Basliklari acmak
RPC ve relayer isteklerini kirabilecegi icin bilincli olarak acilmadi.

---

## Gercek veriyle deneme — ve cikan yeni bulgu

### Tuketici dosyalari: calisiyor

**openSNP kapandi** (30 Nisan 2025, tum veriler silindi). Yerine
**Personal Genome Project (Harvard)** kullanildi: acik onamli katilimcilarin
yayimladigi gercek 23andMe ham dosyalari.

Iki farkli katilimcinin dosyasi kendi kodumuzla hizalandi:

```
katilimci A : 638.463 satir · kapsama 10/10 · [0,1,0,0,0,2,1,0,1,2]
katilimci B : 631.455 satir · kapsama 10/10 · [0,0,0,2,0,0,0,0,0,2]
```

Iki dosya farkli sirada ve farkli kapsamda; yine de **indeks 3 her ikisinde de
rs1815739**. MK-0013'un tum sebebi buydu ve simdi iki gercek insanin verisiyle
gosterilmis oldu.

### VCF: 1000 Genomes'ta rsID YOK

1000 Genomes faz 3 chr22 dosyasi (196 MB) indirilip ayristirildi:

```
ornek          : HG00096   (2504 ornekli panel)
taranan varyant: 1.103.547
panelde bulunan: []
```

Akis sorunsuz calisti ama **hicbir eslesme cikmadi**. Sebep: bu dosyalarda
**ID kolonu bostur** (`.`). Varyant dosyada var — rs4680 tam olarak
`22:19951271 G>A` satiri — ama ADI yazili degil.

Bu bir hata degil, gercek verinin bir ozelligi: kimlik bir ANOTASYONDUR, ham
cagri verisinin parcasi degil. Klinik VCF'lerin buyuk kismi da boyle gelir.

**Sonuc — bilinen sinir:** rsID'ye gore hizalama, kimlik tasiyan dosyalarda
(tuketici formatlari, anotasyonlu VCF'ler) calisir; kimliksiz VCF'lerde
HICBIR SEY bulamaz. Kapatmak icin konum+alel eslesmesi gerekir ve bu, panelin
ilan ettigi ASSEMBLY ile dosyanin ayni olmasini sart kosar — panelde
`assembly` alani zaten var ama su an yalnizca belge amaclidir.

Bulgu `client-side-rust` icinde bir testle sabitlendi
(`thousand_genomes_phase3_has_no_variant_ids`, yerel dosya varsa kosar).

---

## Durust sinirlar

- Ekran goruntusu bu ortamdan bos donuyor; gorsel dogrulama **yapilmadi**.
  Yapisal dogrulama (DOM olculeri, hesaplanmis stiller, canli zincir degerleri)
  yapildi.
- Katki akisinin YAZMA yolu tarayicida cuzdanla surulmedi (ortamda cuzdan yok).
  Ayni sozlesme cagrilari gercek Sepolia'da `live-check.ts` ile dogrulandi.
- `live-check.ts` duman testi icin k-anonimlik esigini **1'e cekiyor**. Gercek
  calismada bu deger yukseltilmelidir; suan dagitilan kontratta 1'dir.
- Zaman serisi indirgemesinin dogru yapildigi zincirde kanitlanmaz (MK-0014).
