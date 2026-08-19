# MK-0014 — Surekli biyobelirtec kanali (veri kategorisi 2)

**Durum:** Kabul edildi · 15 Agustos 2026
**Kod:** `VeriarfyBiomarkers.sol`, `libraries/BiomarkerStats.sol`,
`libraries/ContingencyStats.sol`, `web/src/lib/metrics.ts`
**Kilit:** `Biomarkers.test.ts` (22), `BiomarkerHcu.test.ts`, `metrics.test.ts` (30)
**Ilgili:** [MK-0013](0013-panel-hizalama.md) · veri kategorisi 2

---

## Ne eklendi

VO2 max, laktat esigi, kreatin kinaz onarim hizi, giyilebilir cihazlardan
gelen kardiyovaskuler metrikler. Sistem daha once YALNIZCA 0/1/2 dozaj kabul
ediyordu.

---

## Kategorik degil surekli — istatistik de degisiyor

| | veri kategorisi 1 | veri kategorisi 2 |
|---|---|---|
| deger | kategorik (0/1/2) | surekli |
| zincirde biriken | 2x3 kontenjans tablosu | `n`, `Sum x`, `Sum x^2` |
| test | ki-kare | Welch t-testi |

Ikisinde de zincirde yalnizca SAYIMLAR birikir. Sebep aynidir: hem ki-kare hem
varyans **bolme** icerir, sifreli bolme TFHE'de pratik degildir. Test duz
metinde, `packages/study` icindeki `compareGroups` ile yapilir.

Bu uc sayinin secilmesi keyfi degil: Welch t-testinin ihtiyaci tam olarak
budur. Birey duzeyinde hicbir sey saklanmaz — kimsenin VO2 max degeri zincire
yazilmaz.

`n` neden ayri ve sifreli: `participantCount` kullanilamaz. Bir katilimci
genomik paneli tamamlayip metrik gondermeyebilir ya da o metrigi olcturmemis
olabilir. Sayimi metrik basina ve sifreli tutmak, eksik olcumun ortalamayi
bozmamasini saglar.

---

## Eksik veri: burada 0 GUVENLE "eksik" demek

MK-0013'te 0'a ayri bir isaret gerekmisti (`DOSAGE_MISSING = 3`), cunku
genomikte 0 gecerli bir dozajdir ("homozigot referans").

Burada tersi: olcekli sifir hicbir fizyolojik metrikte gecerli degildir. VO2
max 0, kalp hizi 0 ya da laktat 0, olcum degil olcumun yoklugudur.

Bu kural varsayim olarak birakilmaz, **zorlanir**: her metrigin `minValue`
degeri en az 1 olmak zorundadir. Boylece 0 gecerli araligin disinda kalir ve
tek bir kural yeter: **arali disi olcum = eksik**.

Bedava gelmesinin sebebi de bu — aralik kontrolu kotu niyetli girdiye karsi
zaten yapiliyor. Ayri bir "var/yok" bayragi gonderilseydi metrik basina
fazladan bir sifreli girdi ve bir karsilastirma odenirdi.

### Kirpma yok, eleme var

MK-0013'un kurali burada da gecerli: arali disi bir degeri sinira **kirpmak**,
uydurma ama gecerli gorunen bir gozlem uretir. 200 ml/kg/dk gonderen bir
istemci 90'a kirpilsaydi "olaganustu sporcu" olarak ortalamayi yukari cekerdi.
Elenmek dogru davranistir.

---

## Olcek, birim ve sifir noktasi zincirde

Panel hizalamasi burada iki kat zor, cunku bir de **birim** var:

- indeks 3 Alice icin VO2 max, Bob icin laktat esigi olabilir,
- ikisi de VO2 max gonderse bile biri ml/kg/dk digeri L/dk olabilir.

Bu yuzden her metrigin olcegi, birimi ve gecerli araligi zincirde durur.
Aralik zorunlu (eleme zincirde yapiliyor); olcek ve birim de zorunlu, cunku
birimsiz bir tamsayi anlamsizdir.

### `offset` — isaretli buyuklukler

Kodlanmis degerler `uint32`'dir ve `minValue >= 1` yuzunden negatif olamaz.
Ama gercek verinin bir kismi isaretlidir: **kreatin kinaz onarim hizi normalde
bir DUSUSTUR** (negatif egim). Bu, kullanicinin acikca istedigi verilerden
biri; temsil edilemiyor olsaydi iyilesen her katilimci sessizce "eksik"
sayilirdi.

Cozum kaydirma: `kodlanmis = gercek * scale + offset`.

### Istatistige etkisi yok — ve bu tesaduf degil

```
ortalama(kodlanmis) = ortalama(gercek) * scale + offset
varyans(kodlanmis)  = varyans(gercek) * scale^2        (offset DUSER)
```

`t = ortalama farki / standart hata` oldugu icin offset pay ve paydada yok
olur, `scale` sadelesir. **t ve p degeri kodlanmis degerlerden
hesaplandiginda gercek degerlerden hesaplananla birebir aynidir.** Yalnizca
raporlanan ortalama farki ve guven araligi geri cevrilir.

Bir test bunu dogrudan dogruluyor: ayni veri hem gercek hem kodlanmis halde
`compareGroups`'a verilip `t`, `p`, `df` ve Cohen's d karsilastiriliyor.

---

## Tasma: sifreli aritmetik hata vermez, sarar

Homomorfik toplama tasarsa revert etmez — sessizce yanlis sonuc birikir.
Dolayisiyla tasmama, kodda dogrulanabilir bir **sinir** olmak zorundadir.

```
x_max   = 1.048.575          (2^20 - 1) = MAX_METRIC_VALUE
x_max^2 ~ 1,10 * 10^12
uint64  ~ 1,84 * 10^19
=> ~16.700.000 katilimci tasma olmadan toplanabilir
```

Baglayici terim kareler toplamidir; `Sum x` cok daha gec tasar. Sinir pratikte
darlik yaratmaz cunku her metrik kendi olcegini secer: VO2 max 90,0 -> 9.000;
laktat 20,00 mmol/L -> 20.000; kreatin kinaz 200.000 U/L -> 200.000.

---

## Parti tavani: 8 metrik

Baglayici kisit yine blok gazi degil, fhEVM'in **islem basina HCU butcesi**
(20.000.000). Ama bu kanalda yeni ve pahali bir islem var:

```
mul(euint64, euint64) = 596.000 HCU
```

Dozaj kanalinda hic carpma yoktu. Olculen sonuclar (`BiomarkerHcu.test.ts`):

| parti | toplam gaz | metrik basina |
|---:|---:|---:|
| 1 | 838.278 | 838.278 |
| 4 | 2.711.438 | 677.860 |
| 8 | 5.224.877 | 653.110 |
| 10 | — | **HCU asildi** |

Tavan **8 metrik/islem** (dozajda 12 SNP'ydi). 40 metriklik bir panel ~5 islem
eder — 1000 SNP'lik genomik panelin yaninda kucuk.

---

## Zaman serisi ham haliyle sifrelenmiyor

Giyilebilir bir cihaz 1 Hz'de gunde 86.400 ornek uretir. Islem basina 8 ornek,
gunde ~10.800 islem demektir: fiziksel olarak imkansiz.

Ama daha onemlisi **bilimsel olarak gereksiz**. VO2 max zaten ham nefes verisi
degil, bir rampa testinden turetilen bir metriktir; laktat esigi bir egriden
okunur; kreatin kinaz onarim hizi iki olcum arasindaki egimdir.

Indirgeme istemcide yapilir (`metrics.ts` -> `summarizeSeries`: ortalama, en
kucuk, en buyuk, son deger, gun basina egim) ve zincire donemsel metrik girer.
Ham seri kullanicinin cihazinda kalir — mahremiyet acisindan da dogrusu bu.

**Durust sinir:** bu indirgemenin dogru yapildigi zincirde KANITLANMAZ.
Sozlesmenin zorladigi tek sey araliktir, tipki beyan edilen herhangi bir olcum
gibi. Kanitli indirgeme ZK gerektirir ve kapsam disidir.

---

## Neden AYRI bir kontrat oldu

Kanal once `VeriarfyProtocol` icine yazildi. Sonuc:

```
EIP-170 siniri                        24.576 bayt
protokol + metrik kanali              26.299 bayt   -> DAGITILAMAZ
```

Denenen ve YETMEYEN yollar:

| deneme | sonuc |
|---|---|
| `runs: 200` | 25.819 |
| `runs: 100` | 25.346 |
| `runs: 1` | 26.507 |
| `viaIR: true` | 28.483 (daha kotu) |
| `ProofGate` kutuphanesi | 26.245 (54 bayt) |

Son satir ogreticiydi: kutuphaneye tasima **her zaman** kazandirmiyor.
`delegatecall` icin gereken ABI kodlamasi, tasinan kodun kendisi kadar yer
tutabiliyor. Kazanc yalnizca donguleri tasirken geliyor — `ContingencyStats`
2.822, `BiomarkerStats` 3.367 bayt kazandirdi, `ProofGate` 54.

Ayrim ayrica **dogru** olan: veri kategorileri bagimsiz kanallardir ve her
yeni kategori (3: klinik etiketler) ayni duvara carpardi.

```
VeriarfyProtocol     23.476 bayt   (sinirin altinda, ~1.100 bayt pay)
VeriarfyBiomarkers    7.735 bayt
BiomarkerStats        3.367 bayt   (kutuphane, ayri adres)
ContingencyStats      2.822 bayt   (kutuphane, ayri adres)
```

### Yetki nerede kaldi

Onay, itiraz suresi ve iptal dongusunun **tamami protokolde**. Modul yalnizca
veriyi tutar ve tek basina kimseye cozum yetkisi VEREMEZ: `snapshotFor` ve
`grantFor` yalnizca protokolden cagrilabilir. Iki test bunu dogruluyor.

### Sifreli grup etiketi nasil paylasiliyor

fhEVM'de bir sifreli deger uzerinde islem yapmak icin ACL izni gerekir. Modul
grup etiketini kullanamazsa metrikleri gruplara ayiramaz.

Izin **kayit aninda** verilir (`_enroll` icinde `FHE.allow(group, module)`),
cunku sonradan verilemez — katilimci ikinci bir islem imzalamak zorunda
kalirdi. Bu yuzden modul **ilk kayittan once** baglanmis olmak zorundadir ve
`setBiomarkerModule` bunu zorlar: `panelFrozen` ise revert eder, bir kez
baglanan modul degistirilemez.

### Istemci notu

Girdi kaniti kontrat adresine baglidir: olcumler **modulun** adresi icin
sifrelenir, protokolunki icin degil. Karistirilirsa `fromExternal` gecersiz
girdi diye reddeder.

---

## Ne dogrulaniyor

`Biomarkers.test.ts` (22 test) — toplamlar elle hesaplananla birebir; eksik
olcum ne toplama ne sayima giriyor; arali disi deger kirpilmiyor eleniyor;
gruplar karismiyor; modul tek basina yetki veremiyor; kayitlardan sonra
baglanamiyor.

`metrics.test.ts` (30 test) — en kritigi yine MK-0013'un sorusu:

> **IKI FARKLI kullanici ayni indekste AYNI metrigi tasir**

ve istatistik degismezligi: kodlanmis toplamlardan hesaplanan `t`, `p`, `df`,
Cohen's d, gercek degerlerden hesaplananla ayni.

---

## Henuz yok — veri kategorisi 3

Klinik etiket ve farmakogenomik: ilac yanitlari, kanser riski biyobelirtecleri,
uyku apnesi siddeti, patojen direnc haritalari. Bunlar modelin **hedefidir**;
su an hicbir kanal yok.

Bu belgenin acmasi gereken kapi: kategori 3 de kendi modulunde yasayacak.
Protokolde ~1.100 bayt kaldi; ucuncu bir kanali oraya sigdirmaya calismak ayni
duvara carpardi.
