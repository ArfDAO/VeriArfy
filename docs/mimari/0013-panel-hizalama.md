# MK-0013 — Panel hizalamasi, eksik veri ve tuketici dosyalari

**Durum:** Kabul edildi · 15 Agustos 2026
**Kod:** `VeriarfyProtocol.sol`, `web/src/lib/panel.ts`,
`web/src/lib/consumerGenotype.ts`
**Kilit:** `panel.test.ts` (21 test), `MultiSnpGwas.test.ts` (eksik veri)
**Ilgili rapor bolumleri:** §3.3, §2.8 · veri kategorisi 1 (Genomik)

---

## Bulunan hata: hizasiz toplama

VCF ayristiricisinin dokumantasyonu sunu soyluyordu:

> cikti dizisi her zaman referans varyant listesiyle **pozisyonel olarak
> hizali** kalir

**Ama sistemde boyle bir referans varyant listesi YOKTU.** Dizi sadece "bu
dosyada bulunan varyantlar, dosya sirasiyla" idi.

Sonucu somut: Alice'in 3 numarali SNP'si ile Bob'un 3 numarali SNP'si **farkli
varyantlar** olur. Zincir yalnizca `[d0, d1, ... dk]` gorur; hangi varyanta
karsilik geldikleri yazili degildir. Kontenjans tablosu alakasiz seyleri
toplar.

**Tek kullaniciyla fark edilmez.** Ikinci gercek kullanicida sessizce bozulur —
yani tam olarak "gercek veri gelince patlayacak" turden bir hata.

---

## Cozum: panel + ozet

Calisma bir **panel** tanimlar: sirali varyant listesi.

```json
{
  "panelId": "veriarfy-cardio-v1",
  "version": 1,
  "assembly": "GRCh38",
  "variants": [
    { "rsid": "rs4977574", "chrom": "9", "pos": 22098575, "effect": "G", "other": "A" }
  ]
}
```

Panelin **ozeti** zincirde durur (`panelHash`), kendisi IPFS'te (`panelUri`).
Binlerce satirlik listeyi zincire yazmak gereksiz; ozet, herkesin ayni listeyi
kullandiginin kanitidir.

Istemci kendi dosyasini bu panele **hizalar**: cikti panel sirasindadir, dosya
sirasinda degil.

### Etki aleli neden panelde yazili

Dozaj "kac kopya" degil, "**ETKI ALELINDEN** kac kopya" demektir. Hangi alelin
sayildigi bilinmeden 0/1/2 anlamsizdir — ayni kisi, alel secimine gore 0 da 2
de olabilir.

Bir test bunu dogrudan gosteriyor: `AA` genotipi etki aleli `A` iken 2,
`G` iken 0 doner.

### Ozet neyi kapsar

Varyant **sirasi** ve **etki aleli** ozete girer; ikisi de degisirse ozet
degisir. Cunku ikisi de anlamı degistirir. Ozet kanonik bir birlestirmeden
alinir — JSON anahtar sirasi ya da bosluklar ozeti etkilemez.

---

## Eksik veri: 0 yazmak sessiz bir yalandir

Tuketici cipleri (23andMe, AncestryDNA) panelin tamamini kapsamaz. Panelde
olup kullanicinin dosyasinda olmayan varyanta ne yazmali?

**0 YANLIS.** 0, "homozigot referans" demektir — yani "bu mutasyonu
tasimiyor". Oysa dogru ifade "**bilmiyoruz**"dur. 0 yazmak alel frekanslarini
sistematik olarak asagi ceker ve GWAS sonuclarini bozar.

Cozum: ayri bir isaret.

```solidity
uint8 public constant DOSAGE_MISSING = 3;
```

**Maliyeti sifir.** Tablo zaten `dozaj == 0|1|2` sorularini soruyor; 3 hicbirine
uymaz, dolayisiyla o katilimci **o SNP'nin tablosuna hic girmez** — istenen
davranis tam olarak budur.

### Yan fayda: kotu niyet de dislaniyor

Kirpma artik `MAX_DOSAGE` yerine `DOSAGE_MISSING`'e yapiliyor:

```solidity
dosage = FHE.min(dosage, FHE.asEuint8(DOSAGE_MISSING));
```

Onceden 255 gonderen bir saldirgan 2'ye kirpiliyordu — yani "homozigot mutant"
olarak **uydurma bir gozlem** ekliyordu. Simdi 3'e kirpiliyor ve kendini
disarida birakiyor. Iki mevcut test bu davranis degisikligiyle guncellendi.

---

## Tuketici dosyalari (B2C kapisi)

VCF arastirma dunyasinin bicimidir; siradan kullanici 23andMe ya da
AncestryDNA'dan **sekmeli duz metin** indirir.

```
23andMe      : rs4477212  1  82154  AA
AncestryDNA  : rs4477212  1  82154  A   A
```

Ikisi de ayristiriliyor ve **ayni dozajlari** uretiyor — bir test bunu
dogruluyor.

Bicim tespiti **sutun sayisina** bakar, baslik metnine degil: AncestryDNA'nin
basligi da `rsid` ile baslar; ayirt edici olan alelin tek sutunda mi (23andMe)
iki sutunda mi (AncestryDNA) verildigidir.

Dosyalar 600.000+ satir ve ~25 MB oldugu icin **akis halinde** okunur; tamamini
belege alip `split("\\n")` demek tarayicida bellegi ikiye katlardi. Chunk
sinirinda yarim kalan satir bir sonraki parcaya tasinir — bu detay atlanirsa
dosyanin bir kismi sessizce kaybolur.

---

## Ne dogrulaniyor

`panel.test.ts` — 21 test. En kritik olani:

> **IKI FARKLI kullanici ayni panel indeksinde AYNI varyanti tasir**

Kullanicilarin dosyalari farkli siralarda ve farkli kapsamlarda; yine de
indeks 1 her ikisinde de `rs2000` oluyor. Tum tasarimin sebebi bu.

Zincir tarafinda `MultiSnpGwas.test.ts`:
- eksik isaretli SNP o varyantin tablosuna girmiyor,
- arali disi deger (255) tabloyu bozmuyor, eksik sayiliyor.

---

## Dagitimda uyari

`PANEL_HASH` verilmezse dagitim betigi **acikca uyariyor**:

```
UYARI: PANEL_HASH verilmedi. Tek kullanicili duman testi icin sorun
       degil, ama GERCEK katilimcilarla panel ozeti ZORUNLUDUR —
       yoksa farkli dosyalar sessizce hizasiz toplanir.
```

Sessiz kalmasi, bu belgenin anlattigi hatanin geri gelmesi demekti.

---

## Henuz yok — veri kategorisi 2 ve 3

Kullanicidan alinacak veri uc kategoriye ayriliyor; bu belge **birincisini**
tamamliyor.

- **Kategori 2 — surekli biyobelirtec ve telemetri**: VO2 max, laktat esigi,
  kreatin kinaz onarim hizi, giyilebilir cihazlardan kardiyovaskuler
  telemetri. Su an sistem YALNIZCA 0/1/2 dozaj kabul ediyor; surekli degerler
  icin ayri bir sifreli kanal (`euint16`/`euint32`, sabit noktali olcek)
  gerekiyor.
- **Kategori 3 — klinik etiket ve farmakogenomik**: ilac yanitlari, kanser
  riski biyobelirtecleri, uyku apnesi siddeti, patojen direnc haritalari.
  Bunlar modelin HEDEFIDIR; su an hicbir kanal yok.

Ikisi de ayri birer mimari karar gerektiriyor ve bu belgenin kapsami disinda.
