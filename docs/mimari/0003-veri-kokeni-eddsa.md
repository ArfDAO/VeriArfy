# MK-0003 — Veri kokeni devresi: RSA yerine EdDSA

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `packages/circuits/circuits/data_provenance.circom`
**Kilit:** `packages/circuits/scripts/provenance-test.js` (13 kontrol)
**Ilgili rapor bolumleri:** §1.5, §1.5.1, §2.8, §6.6, §7.2, WBS 5.2

---

## Karar

Veri kokeni kaniti, kurum imzasini **RSA-2048 yerine Baby Jubjub uzerinde
EdDSA-Poseidon** ile dogrular.

## Gerekce

Rapor §2.8, RSA-2048 dogrulamasini ~1,5 milyon R1CS kisiti olarak veriyor ve
Halo2'ye gecisi bunun sonucu olarak konumlandiriyor. Olculen gercek:

| | Kisit sayisi | Kanit uretimi |
|---|---|---|
| Rapordaki RSA-2048 tasarimi | ~1.500.000 (beyan) | 14 s -> 3,2 s (hedef) |
| **Kurulan EdDSA tasarimi** | **20.088 (olculen)** | **~850 ms (olculen)** |

Fark yapisal: EdDSA'nin calistigi Baby Jubjub egrisi, devrenin calistigi
BN254 skaler alaniyla uyumludur — nokta aritmetigi dogrudan alan islemleridir.
RSA ise 2048 bitlik modüler aritmetigi alan elemanlarina parcalayip tasima
bitleriyle ugrasmayi gerektirir.

Sonuclari:

- Devre 2^15 ptau'ya sigiyor; Groth16 + Circom altyapisi korunuyor, Halo2'ye
  gecmek gerekmiyor.
- Kanit uretimi dizustunde ~850 ms; raporun 3,2 saniyelik hedefinin altinda.
- Kanit boyutu sabit (Groth16): 723 bayt JSON, zincirde 8 alan elemani.

**Bedeli:** Kurumlarin bugun RSA/ECDSA kullandigi yerde EdDSA anahtari da
yayimlamasi gerekir. Bu, kurum tarafinda bir entegrasyon isidir; karsiliginda
kanit uretimi mobil cihazda bile mumkun hale gelir.

---

## Devre ne kanitliyor

> "Yukledigim panelin duz metni, akredite kurumlar listesinde yer alan bir
> kurumun imzasini tasiyor; panel bicim kurallarina uyuyor; bu kanit benim
> cuzdanima ve yukledigim sifreli bloba bagli; ayni kayit ikinci kez
> yuklenemez."

Semasi:

```
packed        = sum(dosages[i] * 4^i)          # 16 dozaj, 2 bit each
commitment    = Poseidon(packed, salt)
imza          = EdDSA-Poseidon(kurumAnahtari, commitment)
kurumYapragi  = Poseidon(Ax, Ay)               # akredite agacinda
nullifierHash = Poseidon(externalNullifier, commitment)
```

Iki tasarim ayrintisi kasitli:

**Kurum paneli degil TAAHHUDU imzalar.** Boylece imza salt'i da kapsar.
Yalnizca panel imzalansaydi kullanici salt'i degistirip ayni paneli yeni bir
taahhutle yeniden yukleyebilir ve nullifier'i atlatabilirdi. Test bunu
dogruluyor (`salt degistirilerek nullifier atlatilamiyor`).

**Kurum acik anahtari GIZLI girdidir.** Akreditasyon bir Merkle kanitiyla
gosterilir. Sebep: hangi hastaneye gidildigi basli basina hassas bir bilgidir.

---

## Zincire baglandi

Devre `VeriarfyProtocol.submitRecord` yolunda **zorunlu kapidir**. Kanitsiz
kayit girisi mumkun degildir. Sozlesme sunlari dogrular:

| Kontrol | Nasil |
|---|---|
| Kurum akredite mi | `root` zincirdeki `accreditedRoot` ile karsilastirilir (1 saatlik gecerlilik penceresi) |
| Ayni kayit tekrar mi | `provenanceNullifierSpent` — **ayri** mapping (alan ayrimi) |
| Kanit bu cuzdana mi ait | `signalHash == uint256(uint160(msg.sender))` |
| Kanit bu bloba mi ait | `cidHigh/cidLow` **cagridaki digest'ten turetilir**, kanittan degil |

Son satir kritik: yarilar `uint256(cidDigest) >> 128` ve `& type(uint128).max`
ile hesaplanir. Boylece gecerli bir kanit baska bir bloba ilistirilemez.

Olculen gas (Sepolia, gercek islem): **299.792 – 356.379** (Groth16 dogrulama
dahil, 7 acik sinyal).

Dogrulanmis kosumlar:

```
kontrat : 0x8F8382cd3d1D32B7272fbAB7f66f15806c699A87
tx      : 0xa3e3797f90e593bd8a0824fb8625cfe2016625299a22b3bdd6a2b1ba4dc436ef
```

Sozlesme tarafinda 8 test, cogu olumsuz: kanitsiz giris, sahte imza, calinmis
kanit, baska CID'e ilistirme, nullifier tekrari, bilinmeyen kok.

---

## KAPSAM SINIRI — devre sifrelemenin dogrulugunu kanitlamaz

Bu, raporun §6.6'da kendisinin de isaret ettigi bosluktur ve **kapatilmamistir.**

Devre "panelin duz metni imzalidir" der. **"IPFS'e yukledigim sifreli metin tam
olarak bu paneli sifreler" DEMEZ.** Kotu niyetli bir kullanici gecerli imzali
bir panele sahip olup bambaska bir sey sifreleyebilir.

`cidHigh` / `cidLow` acik girdileri bu boslugu kapatmaz; yalnizca kanitin baska
bir bloba tasinmasini engeller (kanit hirsizligi / onden alma korumasi).

Gercek cozum iki yoldan gelir, ikisi de bu devrenin disindadir:

1. **fhEVM yolunda cozulmus durumda:** `FHE.fromExternal(handle, inputProof)`
   Zama'nin girdi kaniti sifreli metnin gecerliligini zincir uzerinde zaten
   dogrular (bkz. [MK-0002](0002-fhevm-nesli.md)).
2. **Concrete yolunda ACIK:** tam Proof of Correct Encryption gerekir. Henuz
   kurulmadi.

Rapor §7.2 bu ayrimi yapmadan "veri zehirlenmesi engellendi" diyor; duzeltilmeli.

---

## Alan ayrimi — kayit altina alinan sart

Iki devre ayni nullifier bicimini kullanir:

```
kimlik devresi : Poseidon(externalNullifier, identityNullifier)
koken devresi  : Poseidon(externalNullifier, commitment)
```

Carpisma pratikte imkansizdir (ikisi de rastgele alan elemani) ama guvence
istatistikseldir, kriptografik degil. Bu yuzden **kural**: iki devre ayni
`externalNullifier` degerini kullanmaz ve sozlesme tarafinda nullifier'lar
**ayri mapping'lerde** tutulur.

---

## Olculen degerler

```
devre               : DataProvenance(PANEL=16, LEVELS=20)
kisit               : 20.088   (researcher_identity: 11.435)
ptau                : 2^15 = 32.768
kanit uretimi       : ~850 ms  (Node.js, dizustu)
kanit boyutu        : 723 bayt (JSON), Groth16 sabit
acik sinyal         : 7
```

PANEL=16 secimi tesaduf degil: Concrete devresinin dogrulanmis panel tavani da
16. Paketleme (2 bit x eleman) sayesinde 125'e kadar buyutmek devre yapisini
degil yalnizca sabiti degistirir — ama yeniden kurulum (setup) gerektirir.
