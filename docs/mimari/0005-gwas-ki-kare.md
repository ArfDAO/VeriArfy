# MK-0005 — GWAS: sifreli kontenjans tablosu, duz metin ki-kare

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `packages/contracts/contracts/VeriarfyProtocol.sol`
**Kilit:** `packages/contracts/test/GwasChiSquare.test.ts` (7 test)
**Ilgili rapor bolumleri:** §1.4.1, §2.1.1, §3.3, WBS 3.2

---

## Karar

Zincirde **sifreli 2x3 kontenjans tablosu** tutulur; ki-kare (χ²) ve p-degeri
esikli acilimdan sonra **duz metinde** hesaplanir.

```
             dozaj 0   dozaj 1   dozaj 2
  kontrol      n00       n01       n02
  vaka         n10       n11       n12
```

Katilimci hem grubunu (vaka/kontrol) hem dozajini SIFRELI gonderir. Kontrat,
hangi hucrenin arttigini hic ogrenmeden tabloyu doldurur.

---

## Neden tek toplam yetmiyordu

Onceki hali yalnizca `_dosagePool` idi — tum dozajlarin toplami. Bununla
hesaplanabilen tek sey allel frekansidir:

```
frekans = havuz / (2 x katilimci)
```

GWAS'in sordugu soru bu degil: *"bu varyant hasta grubunda kontrol grubundan
anlamli olcude daha sik mi?"* Bunu yanitlamak icin iki grubun dozaj
DAGILIMI gerekir. Tek bir toplam bu bilgiyi tasimaz — 20 kisilik toplam,
"herkeste 1" ile "yarisinda 2, yarisinda 0" durumlarini ayirt edemez.

Rapor §1.4.1'de arastirmacinin aldigi ciktiyi *"Mutasyon populasyonun
%12'sinde var"* diye tarif ediyor; §4.5'te SMA, FMF, talasemi hedefliyor.
Bunlarin hepsinde sorulan soru ki-karedir. Yani **satilan urun** budur.

---

## Tablo nasil doldurulur (gizlilik korunarak)

Her hucre icin "bu katilimci buraya mi ait" sorusu homomorfik sorulur:

```solidity
inGroup[g]  = FHE.eq(group, g);      // 2 karsilastirma
atLevel     = FHE.eq(dosage, level); // 3 karsilastirma
cell[g][d] += FHE.asEuint32(FHE.and(inGroup[g], atLevel));
```

`FHE.asEuint32(ebool)` sonucu 0 veya 1'e cevirir: dogru hucre 1 artar,
digerleri **0 eklenerek** degismeden kalir.

**Diger hucrelere 0 eklenmesi israf degil zorunluluktur.** Kosullu yazim
yapilsaydi (yalnizca dogru hucreye dokunulsaydi), islem izinden hangi hucrenin
degistigi — yani katilimcinin grubu ve dozaji — okunabilirdi. Sabit is yuku,
gizliligin bedelidir.

Toplam maliyet: 5 karsilastirma + 6 AND + 6 donusum + 6 toplama = 23 FHE
islemi. Olculen gas (Sepolia): **~302.000**.

---

## Ki-kare neden zincirde hesaplanmiyor

```
χ² = Σ (Gozlenen − Beklenen)² / Beklenen
```

Formul **bolme** icerir. Sifreli bolme TFHE'de pratik degildir: her islem bir
bootstrapping zinciri gerektirir ve maliyet hizla blok gaz limitini asar.

Bu yuzden zincirde yalnizca **6 sayim** biriktirilir; esikli acilimla bu 6 sayi
cozulur, χ² ve p-degeri zincir disinda hesaplanir.

**Gizlilik bozulmaz:** cozulen sey bireyin verisi degil, grup toplamlaridir.
Ustelik `minParticipants` (k-anonimlik) esigi altinda acilim zaten
baslatilamaz — 1 katilimciyken tabloyu cozmek dogrudan o kisinin verisini
okumak olurdu.

### Rapora duzeltme

Rapor §2.1.1 *"PBS ile esik karsilastirmasi yapilabilir"* diyor; bu dogrudur.
Ama §3.3 χ²'nin tamamini sifreli hesaplayacakmis izlenimi veriyor. Gerekli
degildir ve gereksiz pahalidir. Rapor "sifreli sayim + esikli acilim + duz
metin istatistik" olarak duzeltilmelidir.

---

## Test: iki kohort, bir gercek

Testin en anlamli kismi ayni iliski yapisinin iki farkli orneklemde
denenmesidir:

```
12 kisi  -> χ² = 2.0000   (df=2)  -> ANLAMLI DEGIL
61 kisi  -> χ² = 10.7484  (df=2)  -> ANLAMLI (p < 0.05)

  kontrol : 16 / 10 / 5
  vaka    :  5 / 10 / 15
```

Kritik deger 5,991 (df=2, α=0,05). Iliski her iki kohortta da AYNI; degisen
tek sey orneklem buyuklugu.

Bu, raporun §3.3'te anlattigi sorunun ta kendisidir: acik veri setleri
(1000 Genomes 2.504 birey) istatistiksel gucu saglamaz. VeriArfy'in degeri,
hastane silolarindaki veriyi mahremiyeti bozmadan birlestirerek bu esigi
asmaktir.

### Diger testler

- Zincirden cozulen tablo, ayni girdilerle bagimsiz hesaplananla **birebir**
  ayni (homomorfik sayim yanlis hucreye yazmiyor).
- Toplam sayim = katilimci sayisi (hicbir katki kaybolmuyor).
- Arali disi grup (200) ve dozaj (250) tabloyu bozamiyor — kirpma calisiyor.
- k-anonimlik esigi altinda tablo acilamiyor.
- Allel frekansi hala dogru (havuz toplami korunuyor).

---

## API degisikligi

`aggregateDosage` artik iki sifreli girdi alir:

```solidity
function aggregateDosage(
    externalEuint8 encGroup,   // 0 = kontrol, 1 = vaka
    externalEuint8 encDosage,  // 0 | 1 | 2
    bytes calldata inputProof
)
```

Ikisi tek bir girdi kanitiyla gonderilir
(`createEncryptedInput(...).add8(group).add8(dosage).encrypt()`).

Acilim tarafinda `disclosureContingency(requestId)` 6 handle dondurur; esik
saglandiginda onaylayan her dugume hepsi icin ACL izni verilir.

---

## Henuz yok

- **p-degeri kutuphanesi**: test χ²'yi hesapliyor ama p-degeri icin ki-kare
  dagilimi tablosu gerekiyor; su an kritik degerle karsilastiriliyor.
- **Cok SNP'li panel**: tablo tek bir SNP icindir. 16 SNP'lik panelin tamami
  icin 16 tablo (96 hucre) gerekir — gaz maliyeti dogrusal artar.
- **Odds ratio / rolatif risk**: ki-karenin yaninda klinik olarak daha
  okunabilir olculer; ayni 6 sayidan hesaplanabilir, eklenmedi.
