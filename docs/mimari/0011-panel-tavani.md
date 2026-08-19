# MK-0011 — 16 SNP tavani: yanlis teshis ve kalkmasi

**Durum:** Kabul edildi · 15 Agustos 2026
**Kod:** `packages/ml/src/genomic/model.py`, `packages/ml/src/genomic/__init__.py`,
`packages/circuits/circuits/data_provenance.circom`, `packages/circuits/src/provenance.js`
**Kilit:** `tests/panel_ceiling_probe.py`, `tests/panel_scale_probe.py`,
`tests/compiler_limit_probe.py`,
`packages/circuits/scripts/panel-scale-probe.mjs`
**Ilgili rapor bolumleri:** §3.3, §7.6

---

## Ozet

Aylardir kayitli olan "16 SNP tavani" **gercek bir sinir degildi.** Sebep
`model.py` icindeki iki `import` satirinin sirasiydi. Sira duzeltilince ayni
veri, ayni surum ve ayni parametrelerle **3892 varyantin tamami** derlendi —
tavan 243 kat kalkti ve model dogrulugu **AUC 0.951 -> 0.996**'ya cikti.

---

## Kayitli olan iddia

`model.py` sunu soyluyordu:

> concrete-ml 1.9.0 + gercek chrMT dozajlariyla panel >= 20 oldugunda
> Concrete'in LLVM arka ucu **cokuyor** (Python istisnasi degil, surec olumu).
> Cokme; n_bits (8/6/4), L2 duzenlilestirme (C=1/0.1/0.01), birebir ayni
> kolonlarin atilmasi ve derleme kumesi boyutu (2002/200/100 satir)
> degisikliklerinden bagimsiz olarak tekrarlandi. Ayni sekil rastgele veriyle
> 64 ozellikte sorunsuz derlendigi icin **sorun veriye ozgudur**.

Denetim tablosunda bu, "olcek iddiasinin en somut engeli" olarak
isaretlenmisti — rapor §3.3/§7.6 "milyonlarca SNP" vaat ediyor, elimizde 16
vardi.

Gozlemler dogruydu. **Cikarim yanlisti.**

---

## Teshis

### 1. Cokme derlemede degil

Ilk sonda (`panel_ceiling_probe.py`) her denemeyi ayri surecte kosturdu ve
gercek veriyle 64 ozellige kadar sorunsuz derledi. Cokme baska yerdeydi.

Daha dar bir deneme sunu gosterdi:

```
load_cohort()   -> "YUKLEME TAMAM (2503, 3892)"  ardindan cikis kodu 134
```

Yani **is bitiyor**, sonra surec kapanirken oluyor. Concrete derlemesi bu
denemede hic calismamisti.

### 2. Tetikleyici tek bir import

Import'lar tek tek denendi:

```
numpy                     -> 0
sklearn.linear_model      -> 0
concrete.ml.sklearn       -> 0
concrete.ml.deployment    -> 134     <-- tek basina, hicbir is yapmadan
```

### 3. Belirleyici deney: SIRA

Ayni kod, yalnizca iki satirin yeri degistirilerek kosuldu:

```
SIRA A: concrete.ml.sklearn ONCE   -> panel 32 derlendi, panel 64 derlendi
SIRA B: concrete.ml.deployment ONCE -> panel 32 COKTU,   panel 64 COKTU
```

`model.py` B sirasindaydi:

```python
from concrete.ml.deployment import FHEModelDev   # once
from concrete.ml.sklearn import LogisticRegression
```

Ters sirada Concrete'in yerel/LLVM baslatmasi bozuluyor; devre belli bir
karmasikligi asinca `SIGABRT` ("Pure virtual function called") geliyor.

**Neden boyut gibi gorundu:** bozuk baslatma kucuk devrelerde ayakta kaliyor,
buyuk devrede coku­yor. Panel buyudukce cokme geldigi icin "panel sinirina
carptik" sonucuna varilmis. Iki degisken (boyut ve import sirasi) hicbir
zaman ayri ayri denenmemis.

---

## Duzeltme

Iki satir yer degistirdi ve dosyaya **degistirilmemesi gerektigi** yazildi:

```python
# IMPORT SIRASI ONEMLI — DEGISTIRMEYIN.
from concrete.ml.sklearn import LogisticRegression
from concrete.ml.deployment import FHEModelDev
```

`VERIFIED_MAX_PANEL_SIZE` 16'dan 3892'ye cikti — chrMT'nin tamami.

---

## Olculen sonuc

Tam boru hatti (egitim + kuantizasyon + derleme + **gercek FHE cikarimi**):

| panel | AUC | kuantize dogruluk | derleme | FHE gecikmesi |
|---:|---:|---:|---:|---:|
| 16 | 0.951 | 0.932 | 0,6 sn | 0,53 sn |
| 32 | 0.979 | 0.970 | 0,4 sn | 0,35 sn |
| 64 | 0.989 | 0.980 | 0,4 sn | 0,35 sn |
| 256 | 0.994 | 0.982 | 0,4 sn | 0,40 sn |
| 1024 | 0.996 | 0.986 | 0,3 sn | 0,52 sn |
| **3892** | **0.996** | 0.982 | 0,5 sn | 0,63 sn |

Dikkat cekici olan: **maliyet neredeyse sabit.** 243 kat daha fazla varyant,
derleme suresini artirmiyor ve FHE gecikmesini 0,53 -> 0,63 saniyeye
tasiyor. Sebep modelin **lineer** olmasi: lojistik regresyon sifreli girdiyle
DUZ agirliklarin ic carpimidir; TFHE'de bu toplama ve skaler carpimdir,
bootstrapping zinciri gerektirmez.

Cikis kodlari da 0'a dondu — kapanis cokmesi ayni duzeltmeyle gitti.

---

## Kalan sinir: veri, derleyici degil

3892, **chrMT'deki toplam varyant sayisidir.** Mitokondriyal DNA yalnizca
16.569 harf uzunlugundadir; tum genomun milyonda besi. Yani artik tavan
derleyicide degil **veri kumesindedir.**

Daha buyuk panel icin nukleer kromozom verisi gerekir (1000 Genomes chr1
tek basina milyonlarca varyant tasir). Bu bir veri indirme/isleme isidir,
mimari engel degildir.

### Derleyicinin kendi tavani olculdu

`compiler_limit_probe.py` sentetik 0/1/2 dozajlarla ozellik sayisini
katlayarak artirir. Olculen sey model dogrulugu degil **kapasitedir** — bu
yuzden sentetik veri mesrudur; dogruluk zaten gercek veriyle olculdu.

512 ornek, egitim + derleme + **gercek FHE cikarimi**:

| ozellik | egitim | derleme | FHE cikarimi | tepe bellek | ozellik basina |
|---:|---:|---:|---:|---:|---:|
| 4.096 | 0,1 sn | 0,2 sn | 0,71 sn | 669 MB | 0,173 ms |
| 16.384 | 0,2 sn | 0,3 sn | 1,74 sn | 1,4 GB | 0,106 ms |
| 65.536 | 0,5 sn | 0,4 sn | 6,22 sn | 4,3 GB | 0,095 ms |
| 262.144 | 1,6 sn | 1,4 sn | 29,6 sn | 6,3 GB | 0,113 ms |
| **1.048.576** | 8,3 sn | 15,9 sn | **823 sn** | **11,1 GB** | 0,785 ms |

**Rapor §3.3/§7.6'nin "milyonlarca SNP" iddiasi derleyici acisindan
ULASILABILIR** — bir milyondan fazla ozellik derlendi ve gercek FHE ile
calisti.

Ama egri iki bolgeye ayriliyor:

- **~262.000'e kadar dogrusal.** Ozellik basina maliyet 0,10-0,17 ms
  araliginda sabit kaliyor. Bu bolgede olcek gercekten "bedava".
- **1 milyonda bozuluyor.** Ozellik basina maliyet 7 kat kotulesiyor
  (0,113 -> 0,785 ms). Sebep neredeyse kesin bellek: 11,1 GB tepe kullanim
  bu makinede takasa (swap) itiyor. Yani sinir algoritmik degil, **fiziksel
  bellek**.

Dolayisiyla durust ifade sudur: *bir milyon SNP calisir ve gosterildi, ama
tek cikarim 13,7 dakika surer ve 11 GB bellek ister.* Uretimde makul calisma
bolgesi **~262.000 SNP / ~30 saniye**; daha buyugu icin ya daha cok bellekli
bir sunucu ya da panelleri parcalayip kismi toplamlari sifreli birlestirmek
gerekir.

---

## ZK koken devresindeki AYRI tavan — ve kalkmasi

ML tarafi acildiktan sonra sira koken kanitina geldi: o da ayni panele
taahhut edebilmeli.

### Once olculdu

| panel | dogrusal olmayan kisit | ptau |
|---:|---:|---:|
| 16 | 13.063 | 2^14 |
| 64 | 13.159 | 2^14 |
| 125 | 13.281 | 2^14 |

Panel **neredeyse bedava**: dozaj basina ~2 kisit. Devre EdDSA + Merkle
tarafindan domine ediliyor.

### Sonra sessiz bir bozulma bulundu

Panel taban 4 ile **tek** bir alan elemanina paketleniyordu. Dozaj basina
2 bit, BN254 alani ~254 bit -> tavan 127.

Ama `PANEL = 128` ve `256` **sorunsuz derleniyordu.** Circom tasmayi
yakalamaz. Taban 4 toplami modulusu asinca taahhut tersine cevrilemez hale
gelir ve devre **sessizce yanlis** olur: kanit uretilir, dogrulanir, ama
gercek paneli temsil etmez. Derlenmemekten cok daha tehlikeli bir hata.

Devreye acik koruma konuldu (`assert`), ve 128/256 artik derlenmiyor.

### Sonra tavan kaldirildi: parcali paketleme

Tek eleman yerine **parcalar**: her 125 dozaj kendi alan elemanina paketlenir,
taahhut hepsinin uzerinden alinir (`Poseidon(CHUNKS + 1)`).

Poseidon en fazla 16 girdi aldigi ve biri salt'a gittigi icin yeni tavan
**1875 = 15 x 125**. Bu da `assert` ile zorlanir.

| panel | kisit | ptau |
|---:|---:|---:|
| 250 | 13.552 | 2^14 |
| 500 | 14.112 | 2^14 |
| **1000** | 15.208 | 2^14 |
| 1875 | 17.150 | 2^15 |
| 2000 | **derlenmez** (koruma) | — |

### Uretim degeri: PANEL = 1000

Klinik poligenik risk skorlari tipik olarak 100-1000 SNP kullanir (yaygin
ornek: meme kanseri PRS313 = 313 SNP). 1000, bunlarin tamamini kapsar.

Olculen bedel — uctan uca, gercek kanit uretimi:

```
kisit sayisi   : 20.088 -> 23.762   (+%18)
kanit uretimi  :   722 ms -> 767 ms (+%6)
kanit boyutu   :   ~720 bayt        (DEGISMEDI — Groth16 sabit boyutlu)
ptau           :   2^15             (DEGISMEDI)
```

Yani panel 62 kat buyudu, kanit uretimi %6 uzadi ve zincirdeki dogrulama
maliyeti hic degismedi.

### Test kirilganligi da duzeltildi

Testler ve `live-check` sabit 16 elemanlik paneller tasiyordu; panel
buyutulunce "uzunluk uyusmuyor" ile dustuler. Hepsi artik uzunlugu
`PANEL_SIZE`'dan turetiyor — dogrulanan sey uzunluk degil DAVRANIS.

### Kalan sinir ve otesi

1875'in ustu icin parcalar uzerinde bir **Poseidon agaci** gerekir. Bugun
ihtiyac yok; ama gerekirse yol acik ve maliyet parca basina ~240 kisit.

Ayrica onemli bir ayrim: koken paneli ile ML cikarim paneli **ayni olmak
zorunda degildir.** Koken kaniti "akredite kurum bu paneli imzaladi" der;
cikarim o panelin bir alt kumesinde calisabilir.

---

## Ders

Uc gozlem dogruydu ve hepsi yanlis yone isaret etti:

1. "Cokme surec olumu" — dogru, ama kapanista.
2. "n_bits/duzenlilestirme degistirmek fark etmiyor" — dogru, cunku hicbiri
   sebep degildi.
3. "Rastgele veri 64'te derleniyor" — dogru, ama o denemede import sirasi
   FARKLIYDI (`concrete.ml.sklearn` dogrudan alinmisti); gercek veri
   `model.py` uzerinden geliyordu ve bozuk sirayi tasiyordu.

Ucuncusu asil yaniltici olan: karsilastirma "gercek veri vs rastgele veri"
sanildi, oysa ayni anda "bozuk import sirasi vs temiz import sirasi"
karsilastiriliyordu. Iki degisken birbirine karismisti.

Sonda betikleri depoda kalir; boylece bu sayi bir daha tahmine dayanmaz.
