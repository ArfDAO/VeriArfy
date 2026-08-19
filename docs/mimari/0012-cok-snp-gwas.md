# MK-0012 — Cok SNP'li GWAS: panel, partili katki ve HCU siniri

**Durum:** Kabul edildi · 15 Agustos 2026
**Kod:** `VeriarfyProtocol.sol`
**Kilit:** `MultiSnpGwas.test.ts` (21 test), `MultiSnpGas.test.ts` (olcum)
**Ilgili rapor bolumleri:** §3.3 (birincil), §2.6, §4.3

---

## Sorun

Kontenjans tablosu **tek** bir varyant icindi:

```solidity
euint32[3][2] private _contingency;   // 2 grup x 3 dozaj — TEK SNP
```

Gercek bir GWAS calismasi onlarca-binlerce varyant tarar. Tek SNP'ye gomulu
bir tasarim, gercek veri geldiginde yeniden yazilmayi gerektirirdi — yani
bugun yazilan her sey o gun cope giderdi.

---

## Yeni yapi

```solidity
mapping(uint32 snp => euint32[3][2]) private _contingency;
uint32 public snpCount;        // calismanin paneli
uint32 public rareSnpIndex;    // nadirlik biti hangi varyanta ait
```

Akis ikiye ayrildi:

```
enroll(sifreliGrup)                    -> grup BIR KEZ yazilir
contributeDosages([d0, d1, ... dk])    -> sirali dilimler halinde
   |
   +-- panel tamamlaninca katilimci SAYILIR
```

### Grup neden bir kez

Her partide yeniden gonderilseydi katilimci partiler arasinda **grup
degistirebilir** ve tabloyu bozabilirdi. Bir kez yazilir, tum partilerde
yeniden kullanilir. Yan fayda: grup karsilastirmalari parti basina bir kez
yapilir, SNP basina degil.

### Katkilar neden sirali

Bir sonraki parti tam olarak `submittedSnps[katilimci]` indeksinden baslar.
Serbest indeks verilseydi ne bosluk kalmasi ne de ayni SNP'nin iki kez
sayilmasi engellenebilirdi; ikisi de tabloyu **sessizce** bozardi.

### Katilimci neden tamamlayinca sayiliyor

Yarim kalan bir katki tabloya girmistir ama katilimci degildir. k-anonimlik
esigi ve gelir paylasimi eksik veriyi tam saymamalidir.

**Bilincli sinir:** yarim katki tablodan CIKARILAMAZ — homomorfik toplamdan
bir terim silinemez. Yani tablo toplami katilimci sayisindan buyuk olabilir.
Bir test bunu acikca dogruluyor ve belgeliyor.

---

## Beklenmedik bulgu: sinir gaz degil HCU

Parti buyuklugunu blok gaz limiti belirlemiyor. fhEVM'in **kendi butcesi**
var (`@fhevm/host-contracts/contracts/HCULimit.sol`):

```
MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX       = 20.000.000
MAX_HOMOMORPHIC_COMPUTE_UNITS_DEPTH_PER_TX =  5.000.000
```

Bu butce EVM gazindan **ayri ve daha sikidir**. Islem gaz acisindan rahatca
sigsa bile `HCUTransactionLimitExceeded` ile duser — nitekim ilk olcum
denemesi tam olarak boyle dustu.

Gercek veriyle karsilasilacak ilk duvar budur; blok limiti degil.

### Olculen (MultiSnpGas.test.ts)

| parti | toplam gaz | SNP basina | durum |
|---:|---:|---:|---|
| 1 | 935.991 | 935.991 | tamam |
| 2 | 1.644.119 | 822.060 | tamam |
| 4 | 3.063.797 | 765.949 | tamam |
| 8 | 5.916.871 | 739.609 | tamam |
| **12** | **8.788.273** | **732.356** | **tamam** |
| 16 | — | — | **HCU ASILDI** |

**En buyuk calisan parti: 12 SNP/islem.** SNP basina marjinal maliyet
~732.000 gaz.

1000 SNP'lik bir panel katilimci basina **~84 islem** demektir — bir kerelik
bir maliyet, ama kucumsenecek bir sey degil. Ana agda pahali olur; L2 ya da
Zama'nin kendi agi bunun icin dogru yer.

Parti buyuklugunu **cagiran secer**, sozlesme yalnizca siraliligi zorlar:
HCU butcesi ve blok limiti aga gore degisir, sozlesmeye gomulu bir sayi bir
agda israf digerinde basarisiz islem olurdu.

---

### Gercek agda dogrulandi (Sepolia)

Mock olcumu gercek agda tekrarlandi — 8 SNP'lik panel, tek partide:

```
contributeDosages (8 SNP)  6.851.846 gas
openQuery                  1.921.900 gas   (onceden 566.829)
executeDisclosure          1.602.004 gas   (onceden   292.112)
settleQuery                  109.980 gas
claim                        117.446 gas
```

`openQuery` ve `executeDisclosure`'daki artis dogrudan pencereden gelir:
8 SNP x 6 hucre = 48 handle kopyalanir ve 48 ACL izni verilir. Tek SNP'de bu
6'ydi. Yani **acilim penceresi maliyetin asil surucusudur** ve
`MAX_DISCLOSURE_WINDOW = 32` sinirinin sebebi budur.

Zincirdeki durum: `snpCount = 8`, `submittedSnps = 8`, `participantCount = 1`.

### Yan bulgu: progresif teminat gercekten calisiyor

Ayni kosumda dugum teminati **0,001 -> 0,0064594 ETH**'ye cikti. Sebep
[MK-0008](0008-guvenilmez-dugum.md)'deki formul: sistemden gecen ucret
(`cumulativeFees = 22.000.000`) esigi astikca `MinStake` yukseliyor. Yani
rapor §2.7.1'in progresif teminat mekanizmasi kagitta degil, canli agda
isliyor.

---

## Acilim penceresi

Talep aninda tablonun **anlik goruntusu** alinir (talepten sonra gelen
katkilar onaylananin disinda kalsin diye). Cok SNP'de bu bir sorun yaratir:
1000 SNP'lik panelde 6000 handle kopyasi hem gaz acisindan imkansiz hem de
gereksiz.

Cozum: talep bir **aralik** bildirir.

```solidity
requestDisclosureWindow(researcher, queryType, snpFrom, snpWindow)
uint32 public constant MAX_DISCLOSURE_WINDOW = 32;
```

Gizlilik acisindan da dogru yon: ne kadar az acilirsa o kadar iyi. Arastirmaci
zaten belirli varyantlarla ilgilenir.

Pencere disindaki SNP `SnpOutsideWindow` ile reddedilir — test ediliyor.

---

## Nadirlik biti artik bir varyanta ait

Tek SNP'liyken "nadir tasiyici" sorusu tekti. Cok SNP'li panelde hangi
varyanta ait oldugu **belirtilmelidir**; `rareSnpIndex` bunu yapar.

Iki test bunu zorluyor: yapilandirilan SNP'de dozaj 2 tasiyan nadir sayilir,
BASKA SNP'lerde dozaj 2 tasiyan sayilmaz.

Maliyet yine sifir: aranan karsilastirma (`dozaj == 2`) tablo icin zaten
yapiliyor.

---

## Panel dondurulur

`configurePanel(snpCount, rareSnpIndex)` yalnizca **ilk katkidan once**
cagrilabilir. Yarida degisen bir panel, kimi katilimcinin 10 kimi 50 SNP
gonderdigi tutarsiz bir tablo birakirdi: sutun sayilari farkli kohortlardan
gelir ve ki-kare anlamsizlasir.

---

## Geriye donuk uyum

`snpCount` varsayilani **1**'dir ve o durumda davranis eskisiyle birebir
aynidir. `aggregateDosage(grup, dozaj, kanit)` kisayolu korundu; cok SNP'li
panelde `UseBatchApi` ile reddedilir ve dogru API'ye yonlendirir.

Mevcut 184 testin tamami degistirilmeden gecti (yalnizca bir testin bekledigi
hata adi `AlreadyAggregated` -> `AlreadyEnrolled` oldu; koruma ayni, yeri
degisti).

`hasAggregated` bir mapping'ken **gorunum fonksiyonu** oldu — ABI imzasi ayni
kaldigi icin arayuz etkilenmedi.

---

## Kalan sinirlar

- **Ki-kare hala zincir disinda.** Cozulen 6 sayi ile duz metinde
  hesaplanir (bkz. [MK-0005](0005-gwas-ki-kare.md)); bu degismedi ve
  degismesi de gerekmiyor.
- **Coklu test duzeltmesi yok.** 1000 SNP taranirsa p-degeri esigi
  Bonferroni/FDR ile duzeltilmelidir. Bu bir istatistik katmani isidir ve
  zincirde degil, arastirmaci tarafinda yapilir — ama panelde uyari olarak
  gosterilmesi dogru olur.
- **Ornek sayisi.** Gercek bir kesif icin binlerce katilimci gerekir; panel
  boyutu artik engel degil, kohort buyuklugu engel.
