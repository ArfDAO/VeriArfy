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

## Arastirma konsolu — sifreli verinin KULLANILDIGI yer

Katki akisi veriyi iceri aliyordu; bu bolum onu **kullaniyor**. Akis
rapor §2.6'daki BSKK-44'un tamami:

```
1. ODEME       ucret odenir, EMANETTE bekler
2. TALEP       odeme sozlesmesi (sorgu kapisi) acilim talebini acar
3. ONAY        yetkili dugumler M-of-N onaylar
4. ITIRAZ      esikten sonra sure acik kalir
5. YURUTME     cozum yetkisi ARASTIRMACIYA verilir
6. COZUM       tarayicida, arastirmacinin imzasiyla (userDecrypt)
7. ISTATISTIK  ki-kare + Welch t, duz metinde
8. PAYLASIM    %80 katilimcilara, %20 hazineye
```

### Cozulen sey bireyin verisi DEGILDIR

Acilan handle'lar grup TOPLAMLARIDIR: kontenjans hucreleri ve
(n, Sum x, Sum x^2). Kimsenin dozaji ya da VO2 max degeri hicbir asamada duz
metne donmez. k-anonimlik esigi de bunun altinda ayrica durur.

### `publicDecrypt` degil `userDecrypt`

`executeDisclosure` izni YALNIZCA arastirmacinin adresine verir
(`FHE.allow(handle, researcher)`). Dolayisiyla cozum arastirmacinin
IMZASINI gerektirir:

1. tarayicida gecici anahtar cifti uretilir — relayer bile duz metni gormez,
2. acik anahtar + kontrat listesi + sure EIP-712 ile imzalanir,
3. relayer KMS'ten yeniden sifreleme alir, sonuc gecici ozel anahtarla acilir.

ACL kaydi handle+KONTRAT ikilisine bagli oldugu icin her handle'in hangi
kontrattan geldigi tasinir: kontenjans protokolde, biyobelirtec toplamlari
modulde.

### Istatistik motoru ORTAK

Ki-kare ve coklu test duzeltmesi `packages/study` icine tasindi
(`chiSquareTest`, `chiSquareP`, `benjaminiHochberg`); `GwasChiSquare.test.ts`
kendi kopyasini birakip ayni fonksiyonu cagiriyor. Iki uygulama olsaydi
sessizce ayrisir ve ekranda gorunen p-degeri testin dogruladigi deger olmazdi.

Ozel fonksiyonlar (eksik gama, seri + surekli kesir) elle yazildigi icin
bilinen tablo degerlerine karsi dogrulaniyor (`scripts/chi-selftest.mjs`):
`chi2=3,841 df=1 -> p=0,05`, `chi2=9,210 df=2 -> p=0,01`.

**Coklu test duzeltmesi** (Benjamini-Hochberg) eklendi: 1000 SNP tarandiginda
%5 esikte 50 tanesi TESADUFEN anlamli cikar. Bonferroni yerine BH secildi —
Bonferroni binlerce testte gercek sinyali de eler.

### On kosullar sessiz revert yerine ACIKCA gosteriliyor

`openQuery` uc sarti revert ile zorluyor:

| sart | eksikse ne olur |
|---|---|
| arastirmaci defterine kayit (ZK kimlik) | `NotRegisteredResearcher` |
| en az bir katilimcinin izni | `PoolEmpty` |
| yeterli token + harcama izni | ERC-20 hatasi |

Ucu de once zincirden okunur ve eksik olan ekranda maddelenir. Okunmasalardi
kullanici sebebi anlasilmayan bir islem hatasi gorurdu.

### "Yetkili dugum" olmak onay icin YETMIYOR

Ilk gercek denemede onay adimi `NodeNotStaked` ile dustu — arayuz "yetkili
dugum: evet ✓" gosterirken.

Sebep tasarimin kendisi: onay yetkisi yetkilendirmeyle bitmiyor, dugumun
TEMINATI da yeterli olmali. Ve gereken teminat havuzun ekonomik degeriyle
birlikte buyuyor:

```
minStake = baseStake x log2(toplamUcret / esik)
```

Olculen: dugum 0,001 ETH ile yetkiliydi; ilk 12 tUSD'lik sorgudan sonra
gereken teminat 0,0054594 ETH'ye cikti ve ayni dugum onay veremez oldu.

Bu ISTENEN davranistir — acilabilecek verinin degeri arttikca dugumun riske
attigi miktar da artmali. Hata, arayuzun yanlis seyi gostermesiydi: "yetkili
mi" sorusunun yanitini gosterip "onay verebilir mi" sorusunu hic sormuyordu.

Duzeltme: `canApprove`, `stakeOf` ve `minStake` cuzdan baglanir baglanmaz
okunuyor; eksik varsa buton kapali kaliyor, eksik miktar formulle birlikte
yaziliyor ve "teminati tamamla" eylemi sunuluyor. Tamamlarken eksigin
%20 fazlasi yatiriliyor: tam eksik kadar yatirmak bir sonraki ucrette yine
yetmezdi.

### `any` bir hatayi sakladi

Cozum adimi ilk denemede soyle dustu:

```
InvalidTypeError undefined UintNumber string
```

Sebep: `userDecrypt`'e `startTimestamp` ve `durationDays` METIN olarak
geciriliyordu; SDK bunlari sayi olarak dogruluyor. Kaynakta birebir:

```js
assertIsUintNumber(startTimestamp);
assertIsUintNumber(durationDays);
// isUintNumber: typeof value === 'number' && Number.isInteger(value)
```

Tip bildirimi zaten `number` diyordu. Yakalanmamasinin sebebi
`getFheInstance(): Promise<any>` idi — `any` tum tip kontrolunu sildi ve hata
ancak calisma aninda, hangi alanin sorunlu oldugunu SOYLEMEYEN bir mesajla
ortaya cikti.

Duzeltme iki katmanli: degerler sayiya cevrildi VE SDK'nin kullandigimiz
yuzeyi (`createEncryptedInput`, `generateKeypair`, `createEIP712`,
`userDecrypt`, `publicDecrypt`) dar bir arayuzle tiplendi. Paketin tamamini
yeniden tiplemek degil — yalnizca cagirdigimiz dortlu, imzalar paketin
`.d.ts`'inden birebir.

### "Sure doldu" ile "yurutuldu" ayni sey degil

Ucuncu deneme `User address ... is not authorized to user decrypt handle`
ile dustu. Sebep dogrudan benim mantik hatamdi:

```ts
// YANLIS — tahmin
const executed =
  finalized && !revoked && challengeEndsAtBlock > 0 &&
  currentBlock >= challengeEndsAtBlock;
```

Bu, "itiraz suresi doldu"yu "cozum yetkisi verildi" sandi. Iki sonucu oldu:

1. "Cozum yetkisini ver" butonu HIC gorunmedi (kosulu `!executed` idi ve
   `executed` sure dolar dolmaz true oluyordu),
2. "Coz ve hesapla" bolumu, `FHE.allow` hic yazilmamisken acildi.

Yani kullanici, ACL izni olmayan handle'lari cozmeye calisti.

Protokol bu bilgiyi zaten veriyor: `isDisclosureGranted(requestId)` dogrudan
`request.executed` bayragini donduruyor. Cikarim yerine OKUMA:

```ts
const executed: boolean = granted;              // zincirden
const canExecute = finalized && !revoked && !executed && sureDoldu;
```

Ders, konsolun kendi kuralinin ta kendisi: "gonderdim" ile "zincir oyle
diyor" ayni sey degil — ve burada tahmin eden bendim.

### Relayer'in 2048 BIT siniri

Ikinci deneme `Cannot decrypt more than 2048 encrypted bits in a single
request` ile dustu. Pencere bunu rahatca asiyor:

```
10 SNP x 2 grup x 3 seviye x euint32        = 1920 bit
 6 metrik x 2 grup x (64 + 64 + 32)         = 1920 bit
                                      toplam = 3840 bit
```

Istekler bit genisligine gore parcalaniyor. **Imza tek kaliyor**: EIP-712
mesaji acik anahtari, kontrat listesini ve sureyi imzalar — HANDLE'LARI
degil. Her parti icin ayri imza istemek kullaniciya arka arkaya cuzdan
uyarisi gostermek olurdu.

Bit genisligi handle'dan CIKARILMIYOR, cagirandan tasiniyor: handle bicimi
degisirse cikarim sessizce yanlislanirdi, tasinan tip ise derleyicinin
gordugu bir sozdur.

### Sayfa yenilenince ikinci kez ucret odeniyordu

Arayuz acik talebi bellekte tutuyordu; sayfa yenilenince unutuyor ve "ucreti
ode" butonu yeniden etkinlesiyordu. Kullanici, zaten odenmis ve onaylanmis
bir talep dururken ikinci kez odedi — bu gercekten yasandi, bes sorgu acildi.

Durum zaten ZINCIRDE yaziyordu; sormamak kullaniciya bosuna para harcatmakti.
Artik cuzdan baglanir baglanmaz arastirmacinin acik (bolusturulmemis) son
sorgusu bulunup devralaniyor ve odeme butonu kapaniyor.

### Katilimci panelinde iki yanlis gosterim

**"BSKK-44 onayi bekleniyor" dort ayri durumu tek etikete sikistiriyordu.**
Kod yalnizca `settled` bakiyordu; onaylanip itiraz suresinde bekleyen bir
sorgu ile hic onaylanmamis sorgu ayni gorunuyordu. Katilimci acisindan
bunlar cok farkli: biri hala reddedilebilir, digeri fiilen kesinlesmis.
Asama artik protokole sorularak belirleniyor.

**"IPFS pinli" dayanaksiz bir iddiaydi.** CID ozeti bosken bile panel
"IPFS pinli" yaziyordu — ortada hicbir kayit yokken. Kasa bosken dogru ifade
"kayit yok"tur.

### Ki-kare guvenilirligi gizlenmiyor

Beklenen hucre sayisi 5'in altina duserse ki-kare yaklasimi guvenilmez.
Sonuc yine gosterilir ama uyariyla — sayiyi saklamak, kucuk kohortta
"anlamli bulgu" gibi gorunen bir seyi sessizce gecirmek olurdu.

---

## Uctan uca kapandi — ve bir tutarsizlik ortaya cikardi

Ilk tam kosum gercek Sepolia'da:

```
FHE.allow yazildi          gaz 3.108.055
96 sifreli deger cozuldu    3.840 bit, 2 parti, TEK imza
ki-kare                     10 varyant, 0 tanesi FDR<0,05
Welch t                     6 metrik
```

Tablo kendi ic tutarliligini da gosterdi: `rs429358` satirinda toplam gozlem
2, digerlerinde 3 — cunku AncestryDNA cipi o varyanti tasimiyordu ve eksik
isareti (3) o SNP'nin tablosuna girmedi. MK-0013'un tasarladigi davranis,
gercek veriyle gorunur oldu.

### IZIN, HAVUZA DAHIL OLMAYI YONETMIYOR

Ayni ekranda iki sayi celisti:

```
izin veren katilimci : 2
toplam gozlem        : 3
```

Kod okundu: `_requestDisclosure` icinde izin HIC sorulmuyor. Kontenjans
tablosu TUM katkida bulunanlar uzerinden birikir ve acilim tabloyu oldugu
gibi dondurur. `hasAccessAt` yalnizca `VeriarfyPayments` icinde, kimin pay
alacagini belirlemek icin okunuyor.

**Yani izin GELIR PAYLASIMINI yonetiyor, havuza dahil olmayi degil.**

Gizlilik Paneli ise sunu yaziyordu:

> Veriniz yalnizca izin verdiginiz kurumlarca kullanilir.

Bu ifade UYGULAMAYLA ORTUSMUYOR. Metin duzeltildi ve kapsamin siniri acikca
yazildi: acilan sey birey verisi degil grup toplamidir ve k-anonimlik esigi
altinda acilim baslatilamaz — ama izin, veriyi tek tek arastirmacilardan geri
cekmez.

Mimari secim ACIK BIRAKILDI cunku ucuz degil:

| secenek | maliyet |
|---|---|
| izne gore ayri tablo | arastirmaci basina ayri sifreli tablo — depolama ve HCU carpani |
| acilim aninda yeniden toplama | talep basina O(n) homomorfik islem — buyuk n'de imkansiz |
| izni CALISMA duzeyine tasima | anlamli ve ucuz, ama "arastirmaci bazinda izin" vaadi kalkar |

Ucu de urun karari; kod tarafinda birini secmeden once konusulmali.

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
