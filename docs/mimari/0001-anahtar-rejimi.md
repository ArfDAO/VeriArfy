# MK-0001 — Anahtar rejimi: iki hesaplama alani, iki farkli anahtar

**Durum:** Kabul edildi · 14 Agustos 2026
**Kilit:** `packages/client-fhe-rust/tests/input_contract.rs` (4 test)
**Ilgili rapor bolumleri:** §2.5, §2.5.1, §2.5.2, §3.1.1, §3.3, WBS 1.3

---

## Karar

VeriArfy'da **tek bir anahtar rejimi yoktur.** Iki ayri hesaplama alani vardir ve
her biri kendi anahtar rejimiyle calisir:

| Alan | Motor | Anahtar | Coklu kullanici | Ne yapar |
|---|---|---|---|---|
| **A — Populasyon** | Zama fhEVM | Agin global anahtari (Zama saglar) | **Evet** | Frekans sayimi, allel orani, χ², kohort toplami |
| **B — Birey** | Concrete ML | Kullanicinin kendi `ClientKey`'i | **Hayir** | Onceden egitilmis modelle sifreli cikarim |

Sonuclarin acilmasi her iki alanda da **BSKK-44 Shamir esigine** (7/10) baglidir.

Teknik raporun tarif ettigi "tum kullanicilar tek bir Kolektif Acik Anahtarla
sifreler" modeli (§2.5.1, WBS 1.3) **Alan A icin zaten gecerlidir** — cunku
fhEVM'in ag genelinde tek bir FHE anahtari vardir ve biz onu kullaniyoruz.
Kendi DKG torenimizi kurmamiza gerek yoktur.

Ayni model **Alan B icin uygulanamaz.** Gerekcesi asagida kanitlanmistir.

---

## Neden Alan B'de kolektif acik anahtar olamaz

Concrete'in tfhers koprusu, devre girdisinden belirli bir gurultu duzeyi talep
eder. Bu duzeyin ne oldugu olculdu ve bir **kimlik** cikti:

```
Concrete'in talep ettigi girdi varyansi = COMPUTE_PARAMS.glwe_noise.std²
                                        = 4.701977e-38
                                        = TAZE sifrelemenin gurultusu
```

Olculen oran: `1.000000086`.

Yani sozlesme "su temizlikte olsun" demiyor — **"hic dokunulmamis olsun"**
diyor. Pay birakilmamis. Bunun uc dogrudan sonucu var:

### 1. Tek bir toplama bile sozlesmeyi asiyor

```
taze varyans         : 4.972422e-38
tek toplamadan sonra : 8.729705e-38   (1.76x buyume)
sozlesmeye oran      : 1.86x          -> REDDEDILIR
```

### 2. PKE tanim geregi bir keyswitch icerir

Acik anahtarla sifrelenen veri `CompactCiphertextList` olarak uretilir ve
sunucuda `expand()` ile hesap alanina tasinir. Bu adim bir keyswitch/PBS'tir.
Dolayisiyla PKE ciktisi **hicbir parametre secimiyle** taze sifreleme
gurultusunun altina inemez.

### 3. "Bootstrap ile temizleriz" de calismiyor

```
bootstrap (PBS) cikti varyansi : 1.078373e-13
sozlesme                       : 4.701977e-38
oran                           : 2.293e24
```

Bu sayi kritik: daha once PKE yolunda olculen deger **1.09e-13** idi — pratik
olarak ayni sayi. Yani o zamanki sonuc bir parametre hatasi degil, **PBS'in
kendi gurultu tabaniydi.** Konu kapanmistir.

### Zama'nin kendi ornegi de boyle yapiyor

`concrete` deposundaki resmi tfhers ornegi, girdiyi gizli anahtarla sifreler:
`tfhers_bridge.serialize_input_secret_key(input_idx=0)` ile anahtar disari
alinir, sifreleme Rust tarafinda o anahtarla yapilir. Kopru bu kullanim icin
tasarlanmistir; PKE hic dusunulmemistir.

---

## Neden Alan B'de ortak GIZLI anahtar da olamaz

Akla gelen ikinci cozum, tum kullanicilarin ayni gizli anahtarla sifrelemesidir
— gurultu sorunu cozulur, ciphertext'ler toplanabilir hale gelir.

Bu **mahremiyet acisindan kabul edilemez**: anahtari bilen her katilimci, diger
her katilimcinin verisini cozebilir. Projenin temel vaadiyle dogrudan celisir.

Dolayisiyla Alan B yapisal olarak **tek kullanicilik bir cikarim motorudur.**
Bu bir eksiklik degil, dogru gorev dagilimidir: raporun §3.1.1'de tarif ettigi
is zaten budur — onceden egitilmis modelin **bireysel** hasta verisi uzerinde
cikarim yapmasi.

---

## Sonuclar

### Kod tarafinda

- `packages/client-fhe-rust` gizli anahtar uretir, panelden secilen dozajlari
  sifreler, anahtari Shamir ile 10 parcaya boler (esik 7). `PublicEncryptor`
  ve PKE parametreleri **kaldirilmistir; geri getirilmemelidir.**
- `packages/contracts/VeriarfyProtocol.sol` Alan A'yi tasir. Farkli adreslerin
  dozajlarinin gercekten toplandigi testlerle dogrulanmistir (`0+1+2=3`,
  uc ayri imzalayan).
- `packages/ml` Alan B'yi tasir. Devrenin girdi anahtari, tarayicinin urettigi
  anahtarla `keygen_with_initial_keys` uzerinden ozdeslestirilir.

### Cozulmemis kalan

Concrete'in **degerlendirme anahtar seti** yalnizca
`bridge.keygen_with_initial_keys(lwe_secret_key)` ile uretilebilir; yani gizli
anahtari bilmeyi gerektirir. Tarayici bunu tek basina uretemez
(`concrete-python` tarayicida calismaz).

Cozum, BSKK-44'un zaten var olan mekanizmasidir: anahtar seti **7/10 esikli bir
torenle** uretilir, gizli anahtar torende gecici olarak birlesir, set cikar,
anahtar yeniden imha edilir. Boylece butun halde bir gizli anahtar hicbir
tarafta kalici olarak durmaz. Bu tören aracı henüz kodlanmamistir.

### Rapor tarafinda duzeltilmesi gerekenler

1. **§2.5.1 / WBS 1.3** — "Kolektif Acik Anahtar" ve DKG toreni, kendi
   kuracagimiz bir bilesen olarak degil, **fhEVM'in sagladigi ag anahtari**
   olarak anlatilmali. DKG torenini biz kurmuyoruz; Zama'nin 13 dugumlu
   esikli KMS'i kuruyor.
2. **§3.1.1** — Sifreli cikarimin **bireysel** oldugu acikca yazilmali;
   populasyon istatistiginin fhEVM tarafinda yapildigi belirtilmeli.
3. **§2.5** — "farkli anahtarlarla sifrelenmis veriler toplanamaz" tespiti
   dogrudur; ama cozumun iki alanda iki farkli bicimde uygulandigi
   eklenmelidir.

---

## Bu karar nasil bozulur

`COMPUTE_PARAMS` degistirilirse kimlik bozulabilir. `input_contract.rs`
testlerinden **birincisi** bu durumda kirilir ve karar yeniden degerlendirilmek
zorunda kalir. Test suslu degil, kasitli bir bekcidir; susturulmamalidir.

Uc numarali test (`a_single_addition_already_exceeds_the_contract`) kirilirsa
bu, sozlesmede pay olustugu anlamina gelir — o durumda PKE karari da yeniden
incelenmelidir.
