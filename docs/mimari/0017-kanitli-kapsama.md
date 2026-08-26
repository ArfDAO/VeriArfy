# MK-0017 — Kanitli kapsama: bitmap ZK devresine girdi

**Durum:** Kabul edildi · 21 Agustos 2026
**Kod:** `data_provenance.circom`, `circuits/src/provenance.js`,
`web/src/lib/provenance.ts`, `VeriarfyProtocol.submitRecord`, `CoverageBits.withinProven`
**Kilit:** `provenance-test.js` (6 yeni), `VeriarfyProtocol.test.ts` (7 yeni),
`web/src/lib/provenance.test.ts` (8 yeni — iki uygulamanin ayrismasini yakalar)
**Ilgili:** [MK-0013](0013-panel-hizalama.md), [MK-0016](0016-kapsama-ve-kullanima-gore-odeme.md)

---

## Once: devrede duran GERCEK bir hata

MK-0013 eksik veri isaretini ekledi (`DOSAGE_MISSING = 3`) ve sozlesme
tarafini duzeltti. **Devre ve istemci kutuphanesi unutuldu:**

```circom
secondFactor[i] <== firstFactor[i] * (dosages[i] - 2);
secondFactor[i] === 0;     // yalnizca {0, 1, 2}
```

```js
const VALID_DOSAGES = new Set([0, 1, 2]);
```

Sonucu: **koken kaniti, eksik cagrisi olan HER gercek panelde uretilemiyordu.**
Sessiz bir bozulma degil, tamamen kapali bir yol — ve gercek dosyalarda eksik
cagri kuraldir: test ettigimiz PGP 23andMe dosyasinda 638.463 satirin
21.987'si cagirilamamis.

Devre artik `{0, 1, 2, 3}` kabul ediyor. Maliyet dozaj basina bir kisit arttι
(derece-4 aralik kontrolu); toplam 17.208 dogrusal olmayan kisit, ptau
DEGISMEDI (2^15).

---

## Kapsama bitleri devrenin ACIK CIKTISI

MK-0016 kapsamayi istemciden aliyordu ve guven sinirini acikca yaziyordu:
yalan istatistigi bozamaz ama ODEMEYI bozar. Simdi bitler devrede
turetiliyor:

```circom
isMissing[i] <== secondFactor[i] / 6;   // d=3 -> 6, digerleri -> 0
coverageAcc[i+1] <== coverageAcc[i] + (1 - isMissing[i]) * bitValue;
```

Kelime basina 240 bit: bir BN254 alan elemanina (~254 bit) rahat sigar ve
sozlesme tarafindaki `uint256` maskeye de sigar, sinira dayanmaz.

Acik sinyal sirasi — circom once CIKTILARI, sonra acik GIRDILERI yazar:

```
[root, nullifierHash, commitment, coverage[0..4],
 externalNullifier, cidHigh, cidLow, signalHash]     -> 12 sinyal
```

Sozlesme bu kelimeleri `CoverageBits.record`'a verir; her kelime kendi
ofsetinden yazilir ve **calisma boyutuyla sinirlanir** (`snpCount`) — devrenin
PANEL'i 1000 olsa da calisma 10 varyantsa yalnizca 10 bit yazilir. Calisma
disindaki alanlarin sayaci sisirilemez.

### Ne dogrulaniyor

- **kapsama sisirilemez**: kelimeyi elle degistirmek kaniti bozar
  (`InvalidProvenanceProof`) — kelimeler acik SINYAL
- **eksik alan kapsamada yok**: `dosages[i] = 3` -> bit 0
- **tamamen eksik panel** artik kanit uretebiliyor (once uretemiyordu)
- devrenin turettigi bitler JS hesabiyla BIREBIR ayni

---

## DURUST SINIR — bugunku dagitimda kapsama HALA uydurulabilir

Makine dogru ama guvenligi tek bir varsayima dayaniyor: **kurumun ozel
anahtari gizli olmali ve kurum yalnizca gercek veriyi imzalamali.**

Bugunku dagitimda bu varsayim SAGLANMIYOR:

```js
const DEVELOPMENT_SEED = "veriarfy-gelistirme-kurumu-tohumu-0001";
```

Gelistirme kurumunun anahtari depodaki bir tohumdan turetiliyor, yani
herkese acik. Saldirgan "hepsi bende var" diye bir panel uydurup bu anahtarla
imzalayabilir ve gecerli bir kanit uretebilir.

Yani bugun kanit sunu soyluyor: *"bu kapsama, taahhude giren dozajlarla
TUTARLIDIR"*. Sunu SOYLEMIYOR: *"bu dozajlar gercek bir olcumden geliyor"*.

Ikincisi ancak gercek akredite kurumlarla saglanir — rapor §2.8'in tarif
ettigi kurulum. Makine hazir; eksik olan kurumsal entegrasyon.

---

## KARAR — imzasiz katman, ZK ile

Devre panelin **akredite bir kurum tarafindan imzalanmis** olmasini sart
kosuyordu. Ama MK-0013'te acilan B2C yolunda kullanici kendi 23andMe /
AncestryDNA dosyasini yukluyor ve **o dosyanin kurumsal imzasi yoktur, olamaz
da.** `submitRecord`'u oldugu gibi zorunlu kilmak tuketici yolunu tamamen
kapatirdi.

Verilen karar: **kurumsal dogrulama simdilik yok, veri dogrudan alinacak;
guvence ZK'dan gelecek.** Kurumsal katman cok sonraki bir is.

Devre buna gore acik bir anahtarla ikiye ayrildi:

```circom
signal input attested;                    // ACIK sinyal
attested * (attested - 1) === 0;          // Boole
signatureCheck.enabled <== attested;      // imza dogrulamasi anahtarla
root <== attested * tree.root;            // KATMAN KILIDI
```

| `attested` | ne kanitlanir | bugun |
|---|---|---|
| 1 | kurum imzasi + bicim + kapsama + cuzdan/blob bagi | altyapi hazir, entegrasyon yok |
| 0 | bicim + kapsama + cuzdan/blob bagi | **kullanilan yol** |

### Katman kilidi — neden sozlesmenin ayrica guvenmesi gerekmiyor

`root <== attested * tree.root` tek satirlik ama tasarimin tasiyicisi:
imzasiz katmanda kok **zorla sifirdir**. Sifir olmayan bir kok uretmenin tek
yolu anahtari acmaktir, o da EdDSA dogrulamasini zorunlu kilar. Yani sozlesme
"kok akredite listede mi" diye sorarak imzanin da dogrulandigini ogrenir; iki
katman devrede birbirine kilitlenir.

Sinandi: imzasiz tanigi `attested = 1` ile yeniden gondermek imza kisitinda
duser; `attested = 2` Boole kisitinda duser (aksi halde imzayi atlayip
`2 x kok` ile sifir olmayan bir kok uretilebilirdi).

### Ne KAZANILDI, ne KAZANILMADI

Imzasiz katman sunu soyler:

- dozajlar bicim kurallarina uyuyor,
- **kapsama bitleri TAM OLARAK taahhude giren dozajlardan turedi,**
- taahhut dozajlari kilitliyor,
- kanit bu cuzdana ve bu sifreli metinlere bagli.

Yani **odeme saldirisi kapandi**: "bende bu alan var" deyip bos gondermek
artik imkansiz. Kapanmayan sey uydurma bir dosya yuklemektir — onu ancak
imzalayan bir taraf kapatabilir ve **ZK kapatamaz**. Bu bir eksiklik degil,
kriptografinin siniri: imzasiz bir veri icin "gercek olcumden geliyor"
diyebilecek hicbir matematik yoktur.

---

## Kanit yolunu ZORUNLU degil YETKILI kilan kilit

Kanit tek basina yetmiyordu. `contributeDosages` hala istemcinin beyan
ettigi maskeyle kapsama YAZIYORDU; saldirgan once dar bir kanit gonderip
sonra maskeyle genisletebilirdi ve kanit yolu bos yere kurulmus olurdu.

```solidity
if (panelCommitment[msg.sender] != 0) {
    if (!CoverageBits.withinProven(_snpCoverage, msg.sender, start, coverageMask, n)) {
        revert CoverageNotProven();
    }
} else {
    covered = CoverageBits.record(...);   // kanitsiz yol (testler, kanit devresi olmayan turler)
}
```

Kaydi olan katilimcinin beyani artik yalnizca kanitin **alt kumesi**
olabilir. Arayuz her zaman kanit gonderdigi icin gercek kullanim yolunda
kapsama tamamen ZK'ya baglidir.

Sira da bu yuzden degisti: **once sifrele, sonra kanitla, en son gonder.**
Ters sirada kanit gecerli olurdu ama bir sey korumazdi.

---

## Kanit neye baglaniyor — CID degil, sifreli metinler

Tasarimda kanit IPFS'e yuklenen sifreli dosyanin CID'ine baglaniyordu. Bu
akista oyle bir dosya **yok**: veri Zama'nin girdi kanitiyla dogrudan zincire
sifreli gidiyor.

Uydurma bir CID yazmak yerine kanit, havuza **gercekten giren** sifreli
metinlerin (ciphertext handle) SHA-256 ozetine baglanir. Bu daha gucludur:
kanit "bir yerde duran bir dosyaya" degil, zincire giren tam olarak o
degerlere baglidir; baska bir katki icin uretilmis kanit buraya
ilistirilemez.

---

## Bugunku dagitimda kalan sinir

Kurum anahtari hala depodaki bir tohumdan turiyor:

```js
const DEVELOPMENT_SEED = "veriarfy-gelistirme-kurumu-tohumu-0001";
```

**Imzali katman bu yuzden bugun guvenilmez** ve zaten kullanilmiyor. Imzasiz
katman bu tohumdan etkilenmez — hicbir imza dogrulamiyor, guvencesi
tamamen taahhut-kapsama tutarliligindan geliyor.

Kurumsal entegrasyon geldiginde tohum gidecek, anahtar HSM'de duracak ve
`recordAttested` sayesinde agirlik farki **gecmise donuk** uygulanabilecek —
ayrimi sonradan turetmek imkansiz olurdu, o yuzden bugunden saklaniyor.

---

## Sirada

| # | is | durum |
|---|---|---|
| 4 | Bitmap'i ZK devresine acik cikti olarak ekle | **bitti** |
| 5 | `submitRecord`'u katki akisina bagla | **bitti** (imzasiz katman) |
| 6 | Akredite kurum entegrasyonu (HSM, gercek anahtar) | sonraki is |

Olculen: 17.214 dogrusal olmayan kisit, 13 acik sinyal, 725 bayt kanit,
~850 ms uretim (masaustu). ptau DEGISMEDI (2^15).
