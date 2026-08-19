# MK-0008 — Guvenilmez dugum riski: teminat, itiraz, slashing

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `VeriarfyStaking.sol`, `VeriarfyProtocol.sol` (acilim yasam dongusu),
`interfaces/IVeriarfyStaking.sol`
**Kilit:** `VeriarfyStaking.test.ts` (32 test) + `scripts/live-check.ts`
**Ilgili rapor bolumleri:** §2.7, §2.7.1, §2.7.2

---

## Raporun tehdit modeli bizimkiyle AYNI DEGIL

Rapor §2.7'nin problemi **tembel hesaplama**: FHE hesabini yapan eş-islemcinin
isi atlayip rastgele bir sifreli metin dondurmesi. Cozum olarak Arbitrum tarzi
**etkilesimli sahtekarlik kaniti** oneriliyor.

Bu tehdit bizim sozlesmelerimizde **yoktur**, ve varmis gibi davranmak
yaniltici olurdu:

- Homomorfik hesabi **Zama'nin eş-islemci katmani** yapar. Onun dogrulugu
  Zama'nin kendi stake/konsensus katmaninda yasar — bizim kodumuzda degil.
- Bizim zincirdeki her deger ya **EVM'in determinist hesabidir** (itiraza konu
  olamaz) ya da **KMS esik imzalariyla** gelir ve zincirde dogrulanir
  ([MK-0007](0007-nadirlik-carpani.md)). Yanlis sonuc zaten kabul edilmez.

Yani **bisection tarzi bir sahtekarlik kanitinin burada tartisacagi bir hesap
yoktur.** Boyle bir mekanizma yazmak, calisiyormus gibi gorunen ama hicbir seyi
ispatlamayan bir tiyatro olurdu.

## Bizim gercek riskimiz

Dugumlerimizin elindeki yetki farkli ve **daha tehlikeli**: cozum yetkisi
vermek. Kotu niyetli bir cogunluk, hak etmeyen bir arastirmaciya havuzu
actirabilir.

Onemli olan su: bu karar **bir hesap degil, bir politika yargisidir.**
Sozlesmenin kurallari onu "gecersiz" yapmaz — kanit uretilecek bir yanlislik
yoktur. Politika yargisinin dogru denetimi de matematiksel kanit degil,
**akran denetimi + ekonomik risktir.**

Uygulanan model:

```
esik saglanir  ->  ITIRAZ SURESI  ->  itiraz yok  ->  yetki verilir
                                  ->  itiraz var  ->  dugumler oylar
                                        kabul -> onaylayanlar kesilir + men
                                        ret   -> itiraz edenin teminati kesilir
```

Raporun uc katmanindan (§2.7.1) ucu de yerinde:
ekonomik caydiricilik (bu belge), cogunluk onayi (2/3+, bu belge),
kriptografik dogrulama (BSKK-44 + KMS, [MK-0006](0006-bskk44-emanet.md)).

---

## Bulunan hata: itiraz suresi YANLIS YERDEYDI

Onceki kodda esige ulasilir ulasilmaz `FHE.allow` cagriliyordu.

`FHE.allow` **geri alinamaz.** Izin verildigi anda arastirmaci zincir disinda
cozer. Itiraz suresini bu izinden SONRA koymak, "itiraz kabul edildi" demenin
hicbir sey degistirmedigi bir sus payi olurdu.

Bu yuzden acilim iki adima ayrildi:

| Adim | Anlami | Fonksiyon |
|---|---|---|
| `finalized` | esik saglandi | `approveDisclosure` |
| `executed` | yetki FIILEN verildi | `executeDisclosure` |

Itiraz suresi ikisinin arasindadir. `isDisclosureGranted` artik `executed`
doner — yani **odeme de ancak sonuc gercekten teslim edildiginde** dagitima
acilir.

Bu degisiklik 5 mevcut testi kirdi; hepsi dogru sebeple kirilmisti ve
guncellendi.

### Sure tek basina yetmiyor

Itiraz, surenin **son blogunda** acilabilir ve oylamasi surenin otesine tasar.
Yalnizca sureye bakilsaydi, itiraz edilen bir acilim oylama bitmeden
yurutulurdu. Bu yuzden `executeDisclosure` ayrica **cozulmemis itiraz var mi**
diye sorar. Bir test bunu dogrudan zorluyor.

### Sure geriye donuk degistirilemez

Itiraz penceresi, **bitis blogu** olarak talebe yazilir; baslangic + guncel
sure olarak hesaplanmaz. Aksi halde sahip `challengePeriod`'u degistirdiginde
zaten acilmis taleplerin penceresi kayardi. Test bunu da dogruluyor.

---

## Progresif teminat — raporun iki verisi tutarsiz

Rapor §2.7.1: `MinStake = BaseStake x log2(TotalDataValue / Threshold)`
ve iki kontrol noktasi (BaseStake = 32 ETH ile):

| TotalDataValue | Rapordaki MinStake | Carpan |
|---|---|---|
| > 1M USD | 64 ETH | 2 |
| > 100M USD | 256 ETH | 8 |

**Ikisi ayni `Threshold` ile saglanamaz:**

```
carpan 2 icin -> Threshold = 250.000
carpan 8 icin -> Threshold = 390.625
```

**250.000 secildi.** 1M noktasini birebir tutturur; 100M noktasinda 8,64 kat
verir (rapor 8 diyor). Sapma **yukari** yonde — yani raporun vaat ettiginden
daha pahali bir koalisyon saldirisi. Ters secim, vaat edilenden **ucuz** bir
saldiri anlamina gelirdi; guvenlikte yanlis taraf odur.

### Formulun uygulanmayan kismi

Formul oldugu gibi uygulansaydi `TotalDataValue < Threshold` iken
`log2(x < 1)` negatif olur ve **sistemin en kirilgan oldugu ilk gunlerde
teminati sifira indirirdi.** Taban teminat alt sinir olarak korunur.

`log2` icin ayri bir kod yazilmadi — [MK-0007](0007-nadirlik-carpani.md)'deki
`RarityMath` kullanildi; `multiplierBps(x-1, 1) = log2(x)` kimligiyle.

### TotalDataValue nedir

`VeriarfyPayments.cumulativeFees` — sistemden **gecmis** toplam ucret. Hazine
bakiyesinden farklidir: hazine cekildikce azalir, bu sayac azalmaz.

**Iade edilen sorgular sayilmaz.** Sayilsaydi bir arastirmaci sorgu acip iade
alarak teminat esigini suni sekilde yukseltip dugumleri agdan itebilirdi.

---

## Kacis yollari kapatildi

**Cekim kuyruguna alinan tutar aninda teminat olmaktan cikar.** Aksi halde bir
dugum kotu onaydan hemen sonra cekim baslatir, itiraz suresi boyunca teminatli
gorunur, sure biter bitmez parasini alirdi.

**Kesme, cekim kuyrugundaki tutari da alir.** Ayni kacisin ikinci yolu.

`UNBONDING_DELAY` (7.200 blok) itiraz + oylama suresinden (3.600) uzun
secildi; bu tesaduf degil, gerektir.

**Men kalicidir.** Yasakli dugum yeniden teminat yatiramaz ve protokoldeki
yetkisi otomatik duser — bunu sahibin elle yapmasina birakmak cezayi insafa
baglardi.

---

## Oylama esigi ayrintilari

Kabul icin **kullanilan oylarin 2/3'u** gerekir (rapor §2.7.1: "2/3+ majority").

**Payda neden kullanilan oy, tum dugumler degil:** cekimser bir cogunluk her
itirazi otomatik reddederdi. Denetimin islemesi icin sessizligin "hayir"
sayilmamasi gerekir.

**Buna karsilik hic oy kullanilmamissa itiraz REDDEDILIR:** kimsenin
desteklemedigi bir iddia dugum kesmeye yetmemeli.

**Onaylayanlar ne itiraz edebilir ne oy kullanabilir.** Kendi kararini
yargilamak denetimi anlamsiz kilardi.

**Asilsiz itiraz bedava degildir:** itiraz teminati (taban teminatin onda
biri) kesilir. Sifir olsaydi her acilim bedava geciktirilebilirdi.

---

## Kesilen teminat yakilmiyor

Rapor "aninda yakilir" diyor. Burada **hazine havuzunda toplanir.**

Gerekce: zarar goren taraf katilimcilardir. Kesilen teminatin tazminat kaynagi
olmasi, degeri yok etmekten daha anlamlidir. Caydiricilik acisindan ikisi
esittir — kotu niyetli dugum her iki halde de parasini kaybeder.

---

## Modul isteges bagli

`stakingModule` atanmamissa protokol **eskisi gibi** calisir: teminat aranmaz,
itiraz suresi 0'dir. Bu bilincli — guvenlik katmani protokolu esir almamalidir
ve testlerin cogu bu katmani ilgilendirmez.

Arayuz de dar tutuldu (`IVeriarfyStaking`): protokol yalnizca "bu dugum oy
kullanabilir mi" ve "bu acilim itiraz yuzunden bekliyor mu" sorularini sorar.
Guvenlik modulu, protokol degismeden yenilenebilir.

---

## Olculen degerler (Sepolia, gercek islem)

```
stake              (dugum teminati)         ~ 45.000 gas
approveDisclosure  (teminat kontrolu ile)   ~ 80.000 gas
executeDisclosure  (FHE ACL izinleri)        292.124 gas
settleQuery                                  110.014 gas
claim                                        117.447 gas
```

`openQuery` 566.829 -> 535.429 gas (ilk kosum ilk-yazim maliyeti tasir).

Canli kosum ciktisi — itiraz suresi gercek agda uygulaniyor:

```
approveDisclosure tx: 0xa2ba22b1...
Itiraz suresi acik: blok 11488787 -> 11488807, bekleniyor...
  itiraz suresi doldu (blok 11488807)
executeDisclosure tx: 0x2cfc07cb...
```

Yani onay ile teslim arasinda **20 blok** gercekten gecti; `settleQuery` da
ancak ondan sonra kabul edildi.

---

## Henuz yok

- **zk-FHE** (rapor §2.7.2): raporun kendisi bunu "gelecek vizyonu" olarak
  isaretliyor. Determinist dogrulama, ekonomik caydiriciligin yerini alacak
  hedeftir; bugun literaturde uretime hazir bir uygulamasi yoktur.
- **Kurumsal HSM imzalari**: dugumler hala duz EOA.
- **Itiraz gerekcesinin zincire yazilmasi**: su an itiraz yalnizca bir
  isarettir; gerekce zincir disinda tartisilir. IPFS'e baglanmis bir gerekce
  belgesi dogal bir sonraki adimdir.
