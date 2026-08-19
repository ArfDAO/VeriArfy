# MK-0007 — Nadirlik Carpani ve Kurucu Katkici

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `VeriarfyProtocol.sol`, `VeriarfyPayments.sol`,
`libraries/RarityMath.sol`, `interfaces/IKMSVerifier.sol`
**Kilit:** `RarityMultiplier.test.ts` (24 test) + `scripts/live-check.ts`
**Ilgili rapor bolumleri:** §4.3 (birincil), §4.2, §2.5.2, §3.4

---

## Raporun istedigi

Rapor §4.3 uc parcali bir mekanizma tarif ediyor:

1. **FHE Boolean Tetikleyici** — "Kullanicinin verisi tamamen sifreli (`euint8`)
   kalir; akilli sozlesme asla desifre etmez... `ebool result =
   TFHE.eq(patient_SNP, SMA_mutant_code)`. KMS dugumleri, hastanin tum genomunu
   degil, **yalnizca bu tek bitlik boolean sonucunu** threshold decryption ile
   cozer."
2. **Formul** — `R = log2(1 + N_total / N_variant)`
   Ornek: 100.000 kisilik havuzda 50 tasiyici -> `log2(2001) ~= 11`, yani 11 kat
   daha yuksek sorgu basi gelir.
3. **Kurucu Katkici** — ilk 10.000 saglayiciya kalici **+%50** bonus.

Uculu de uygulandi. Uc noktada rapordan ayrildik; her biri asagida.

---

## Sapma 1 — "Otomatik tanimlanir" nasil saglandi

Rapor "Sonuc 1 ise kullaniciya Nadirlik Carpani **otomatik** tanimlanir" diyor.
Bu, sonucu sozlesmeye geri getiren bir **cozum oracle'i** varsayiyor.

Kullandigimiz surumde (`@fhevm/solidity` 0.11.1) boyle bir geri cagri **yok**.
Eski nesildeki `@fhevm/oracle-solidity` paketi npm'den kaldirilmis (404).
Mevcut akis sudur:

```
sozlesme: FHE.makePubliclyDecryptable(bit)
   |
herhangi biri: relayer.publicDecrypt([handle])
   |
KMS dugumleri: esik saglanirsa duz deger + EIP-712 imzalari
   |
zincire geri yazim
```

Son adim naif yazilirsa **guvenilir bir taraf** yaratir: sonucu getiren yalan
soyleyebilir. Cozum, `KMSVerifier` sozlesmesinin zincirdeki
`verifyDecryptionEIP712KMSSignatures(handles, deger, kanit)` fonksiyonudur —
"bu handle bu degere cozulur" iddiasi KMS esigi tarafindan imzalanmis olmalidir.

Bu yuzden `confirmRarity` **herkese aciktir** ve bu bir acik degil, tasarimin
kendisidir: raporun istedigi otomatiklik, ayricalikli bir role gerek
duyulmamasiyla saglanir. Sonucu kimin tasidigi onemsizdir.

Iki test bunu dogrudan zorluyor:

- uydurulmus `true` degeri kanitsiz gonderilir -> reddedilir;
- **baska bir katilimcinin gecerli, gercek imzali kaniti** kendi bitine
  yapistirilmaya calisilir -> reddedilir (imzalar handle'a baglidir).

---

## Sapma 2 — Degerlendirme otomatik degil, ISTEGE BAGLI

Rapor mekanizmanin arka planda calistigini ima ediyor. Biz katilimciya acik bir
adim koyduk: `requestRarityAssessment()`.

**Sebep, gizlilik acisindan durust olmak.**

`isRareCarrier` alani herkese aciktir ve "bu adres nadir varyant tasiyor"
bilgisini sizdirir. Bunu gizlemek **imkansizdir**: 11 kat pay alan bir adresin
tasiyici oldugu zaten odemeden okunur. Alani ozel yapmak yalnizca yanilsama
yaratirdi.

Rapor §3.4'un veri egemenligi ilkesiyle tutarli olan tek davranis, takasi
kullaniciya birakmaktir:

| Secim | Sonuc |
|---|---|
| Degerlendirme istenmez | Bit sifreli kalir, carpan 1,00x |
| Degerlendirme istenir | Tek bit acilir, carpan R olur |

Panel bu uyariyi acikca gosterir. Acilan seyin **tek bit** oldugu — dozajin,
panelin, genomun kapali kaldigi — ayrica test edilir: nadirlik biti acildiktan
sonra dozaj havuzunu cozme denemesi hala reddedilir.

---

## Sapma 3 — Carpan ne zaman sabitlenir

`R = log2(1 + N/C)` havuz buyudukce **degisir**. Rapor bunu bir kez tanimlayip
birakiyor; ne zaman olculdugunu soylemiyor.

Sabitlenmeseydi: bir sorgudan alinacak pay, o sorgudan **sonra** havuza katilan
kisilere gore kayardi ve paylarin toplami havuzu asabilirdi.

Karar: carpanin girdileri (`N`, `C`) **sorgu acildigi anda** anlik goruntuye
alinir. Carpan saklanmaz, iki sayidan yeniden hesaplanir — `RarityMath` saf
fonksiyondur, kayit O(1) kalir.

Ayrica `N_total` **havuzun tamamidir**, izin verenlerin sayisi degil: nadirlik,
varyantin populasyondaki gercek seyrekligidir.

---

## O(1) dagitim — asil zor kisim

Agirlikli dagitim naif yazilirsa payda icin izin verenler dolasilir; bu, rapor
§4.2'de zaten cozdugumuz O(N) sorununu geri getirirdi.

Cozum: dort sayac, dort **ayrik** kume.

```
N  = izin veren toplam          consentCount
C  = izin veren tasiyici         consentRareCount
F  = izin veren Kurucu           consentFoundingCount
CF = izin veren tasiyici+Kurucu  consentRareFoundingCount

duz             = N + CF - C - F   agirlik 1,00x
yalniz Kurucu   = F - CF           agirlik 1,50x
yalniz tasiyici = C - CF           agirlik R
ikisi birden    = CF               agirlik R x 1,5
```

> **Islem sirasi:** `N - C - F + CF` matematiksel olarak dogru ama ara adimda
> negatife duser (N=2, C=1, F=2, CF=1 -> "2-1-2") ve Solidity'de tasma panigi
> verir. Once eklenip sonra cikarilmali. Bu, test yazilmasaydi ancak uretimde
> gorulecek bir hataydi.

Bir test, tek tek toplanan agirliklarin bu paydaya **birebir** esit oldugunu
dogruluyor. Esit olmasaydi dagitim ya havuzu asar ya da para kilitlerdi.

### Sayaclar neden izin ANINDAKI duruma gore

Katilimcinin nadirligi izin verdikten **sonra** dogrulanirsa, sayaclar ile
bireysel agirlik ayrisir. Bu yuzden durum `rareAtGrant` ile izin aninda
dondurulur; sonradan dogrulanan katilimci izni yenileyerek yeni agirligiyla
sayilir.

`hasAccessAt` zaten `grantedAtBlock <= openedAtBlock` sartini aradigi icin,
yenilenen izin eski sorgulari etkilemez — tutarlilik tanim geregi saglanir.

---

## `log2` neden kutuphane

Solidity'de logaritma yoktur. Tam sayi `log2` yeterli **degildir**: 2.000 ile
4.095 arasindaki her seyreklige ayni carpani verirdi, yani formul bilgi
tasimazdi.

`RarityMath._log2Q64` Q64.64 sabit noktada calisir: tam kisim kaydirmayla,
kesirli kisim ardisik **kare alma** ile bulunur (`log2(y²) = 2·log2(y)`
ozdesligi; her karede bir basamak okunur).

Dogrulama — raporun kendi ornegi:

```
multiplierBps(100.000, 50) = 109.668 bps = 10,97x     (rapor: "yaklasik 11")
multiplierBps(500, 500)    =  10.000 bps =  1,00x     (herkes tasiyorsa prim yok)
multiplierBps(100.000, 1)  = 166.096 bps = 16,61x
```

`RarityMathHarness` bir **mock degildir**: icinde hicbir mantik yoktur, uretim
kutuphanesine devreder. Var olma sebebi, 100.000 kisilik gercek bir havuz
kurmadan raporun ornegini dogrulayabilmektir. Uretimde dagitilmaz.

---

## Geriye donuk uyum

Nadirlik, eski davranisin **ustune** eklendi. Hic kimse degerlendirme
istemezse:

- kucuk havuzda herkes Kurucu'dur, agirliklar esittir, bonus sadelesir;
- dagitim tam olarak `havuz / katilimciSayisi`'na doner.

Mevcut 79 testin tamami degistirilmeden gecti — bu, "eklenti gercekten eklenti
mi" sorusunun en dogrudan cevabi.

---

## Yakalanan hata

`claim()` payini `claimable()`'dan **bagimsiz** hesapliyordu. Agirliklar
eklendiginde gorunumdeki tutar 5.886.075, odenen 4.800.000 oldu — panelde
gosterilen ile odenen sessizce ayristi. Test yakaladi; iki yol tek ifadeye
indirildi.

Ayni turda web tarafinda ikinci bir hata bulundu: `publicDecrypt` SDK
sonucunun **zarfini** dolasiyordu (`clearValues` alanini degil), yani duz
degerler hicbir zaman dogru okunamazdi. Duzeltildi.

---

## Olculen degerler (Sepolia, gercek islem)

```
requestRarityAssessment  (acilim izni)          94.874 gas
confirmRarity            (KMS imza dogrulama)  377.541 gas
aggregateDosage          (nadirlik biti dahil) 925.574 gas   (onceden 876.874)
openQuery                (nadirlik anlik gor.) 566.716 gas   (onceden 510.562)
settleQuery                                     87.705 gas
claim                    (agirlikli)           117.456 gas   (onceden 110.358)
```

Canli kosum ciktisi:

```
bit handle  : 0xc5818c13013a7b1f8fd898f2e612245ea6902784daff...
cozulen bit : false
imza uzunlugu: 914 bayt
sonuc       : yaygin varyant
```

Gonderilen dozaj 1 (heterozigot) idi; nadir esigi 2'dir. Sonucun "yaygin"
cikmasi, degerin uydurulmadiginin da kanitidir — betik bunu ayrica kontrol eder
ve ters sonucta hata firlatir.

`confirmRarity`'nin 377.541 gas'i neredeyse tamamen KMS imza dogrulamasidir.
Pahalidir ama alternatifi guvenilir bir taraftir.

---

## Sinirlar

- **Tek SNP.** Nadirlik biti tek bir varyant icin hesaplanir; cok panelli
  nadirlik icin bit basina ayri handle ve ayri esikli cozum gerekir.
- **Carpan tavani yok.** Tek tasiyicili bir havuzda R ~ 16x'e cikar. Havuza
  girmek akredite kurum imzali ZK koken kaniti gerektirdigi icin Sybil ile
  suni seyreklik uretmek pahalidir, ama formulun kendisinde tavan yoktur —
  rapor da koymuyor.
- **Ilk 10.000 sinirl kontrat sabitidir.** Rapor bu sayiyi veriyor; uretimde
  degistirilebilir olmasi istenirse `immutable` yapilip dagitimda verilmelidir.
