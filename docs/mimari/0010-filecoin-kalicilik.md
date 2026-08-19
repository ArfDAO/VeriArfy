# MK-0010 — Filecoin kaliciligi: anlasma defteri ve cogaltma politikasi

**Durum:** Kabul edildi · 15 Agustos 2026
**Kod:** `VeriarfyStorage.sol`, `scripts/verify-storage-deals.ts`
**Kilit:** `VeriarfyStorage.test.ts` (24 test) + gercek Filecoin RPC dogrulamasi
**Ilgili rapor bolumleri:** §2.9.2 (birincil), §2.9, WBS 2.3

---

## Sorun

Rapor §2.9.2 dogru bir seyi soyluyor: **IPFS veriyi ADRESLER, saklamayi garanti
etmez.** Pinlenmemis bir blok garbage collection ile silinir ve tibbi
arastirmada veri kaybi kabul edilemez.

Bugune kadar sistemde blob'lar Pinata uzerinden IPFS'e pinleniyordu —
**hicbir Filecoin anlasmasi yoktu.** Pinata bir pinleme servisidir, Filecoin
saglayicisi degildir; yani raporun tarif ettigi ekonomik tesvik katmani
tamamen eksikti.

---

## Ne yapildi, ne yapilmadi — durustce

Bu, projede **iki farkli guven modelinin ayni sozlesmede** bulundugu ilk yer.
Karistirilmamasi kritik:

| Parca | Guven modeli | Nerede |
|---|---|---|
| Politika: 3 replika, 180 gun, farkli saglayici, yenileme zamani | **guvensiz** — zincirde zorlanir | `VeriarfyStorage` |
| Olgu: "boyle bir anlasma gercekten var mi" | **tanikli** — bir ajan beyan eder | `attestor` |

Ikincisini guvensiz yapmanin yolu bir Filecoin isik istemcisi ya da kopru
olurdu; Ethereum, Filecoin'in durumunu goremez. Ikisi de bu projenin kapsaminin
cok disinda.

**Bunu gizlemek yerine yalani tespit edilebilir kildik.** Her kayit bir
`dealId` tasir ve `scripts/verify-storage-deals.ts` bunu Filecoin'in
**herkese acik, anahtar gerektirmeyen** RPC'sinden dogrular
(`StateMarketStorageDeal`). Tanik uydurma bir anlasma kaydederse, hicbir
kimlik bilgisi olmayan herhangi biri bunu yakalar.

Betik bir "guzellik" degil, guven modelinin tasiyici parcasidir.

### Patlama yaricapi — tanik ne kadar zarar verebilir

Bu sorunun cevabi kodda olculebilir: **hicbir sozlesme `VeriarfyStorage`'i
okumaz.** Ne `VeriarfyPayments`, ne `VeriarfyProtocol`, ne `VeriarfyStaking`.
Tek tuketici Gizlilik Panelindeki bir etikettir.

Dolayisiyla yalan bir kayit su sonuclari **veremez**:

- para akisini degistiremez (odemeler bu defteri hic okumaz),
- cozum yetkisi veremez (BSKK-44 bagimsizdir),
- sifreli veriyi ya da anahtari acamaz.

Yapabilecegi tek sey **yanlis iyimserlik**: kullanici verisinin kalici
sakladigini sanip yerel kopyasini silebilir. Gercek bir zarardir ama sinirli
ve iyi tanimlidir.

Yalanin ters yonu (kaydi hic yazmamak, ya da saglam bir anlasmayi dusmus
gostermek) durumu **oldugundan kotu** gosterir — guvenli taraf.

### Tanik YENI bir guvenilen taraf degil

`onlyAttestor` hem tanigi hem `owner()`'i kabul eder. Yani tanik rolu, zaten
var olan sahibin yaninda **ek** bir guven varsayimi getirmez: sahip
`setAccreditedRoot`, `setQueryGateway`, `authorizeNode`, `setStakingModule`
gibi cok daha agir yetkilere zaten sahiptir.

Tanigi ayri bir adrese almak (`setAttestor`) yine de dogru: gunluk kayit isini
yapan servis anahtarinin, protokolun sahibi olan cok imzali cuzdanla ayni
olmasi gerekmez.

### "Tespit edilebilir" -> "tespit edilir"

Yakalanabilir olmak, kimse bakmazsa ise yaramaz. Bu yuzden dogrulama
**CI'ya baglandi** (`storage-audit` isi) ve `schedule` ile gunluk kosar:
zincir durumu koda bagli degildir — bir anlasma dusebilir, suresi dolabilir
ya da tanik yanlis beyanda bulunabilir. Yanlis bir kayit en gec **24 saat**
icinde CI'yi kirar. Is hicbir sir gerektirmez; iki uc da genel okumadir.

Panel de iddianin kaynagini gizlemez: replika sayisinin altinda bunun bir
tanik beyani oldugu ve bagimsiz dogrulanabildigi yazar. Olmayan bir kesinlik
satmamak, gizliligi kod duzeyinde savunmak kadar onemlidir.

---

## Epoch: oracle gerekmiyor

Filecoin epoch'lari **sabit 30 saniyedir** ve genesis zaman damgasi bilinir.
Dolayisiyla guncel epoch `block.timestamp`'ten aritmetikle turetilir — hicbir
oracle'a, hicbir tanik beyanina gerek yoktur.

Bu, sozlesmedeki en degerli guvensiz parcadir: "anlasmanin suresi doldu mu",
"yenileme zamani geldi mi" sorulari kimsenin beyanina bagli degildir.

**Gercek agda dogrulandi:**

```
Filecoin gercek epoch : 6281176
bizim hesabimiz       : 6281176
fark                  : 0 epoch
```

(Onceki kosumda 1 epoch fark cikmisti — Ethereum blok zamaninin normal
gecikmesi. 20 epoch tolerans konuldu.)

Genesis `immutable` verilir, sabit degil: Calibration test agi farkli bir
genesis kullanir. Yanlis verilirse epoch hesabi kayar ve **dogrulama betigi
bunu gercek zincir basiyla karsilastirip yakalar.**

---

## WBS 2.3 kurallari ve neden boyle

### 3 farkli saglayici

Rapor "en az 3 farkli Filecoin madencisinde" diyor. Zorlanan sey
**saglayicilarin FARKLI olmasidir**: ayni madenciye uc anlasma yapip "3
replika" gostermek, cogaltmanin tek amacini (tek nokta hatasini kaldirmak)
tamamen bosa cikarirdi. Kod bunu `ProviderAlreadyStores` ile reddeder.

Rapor ayrica "farkli cografi bolgelerde" diyor. **Cografya zincirde
dogrulanamaz** — saglayici kimligi bir aktor numarasidir, konum degil. Bu
kisim anlasma yapilirken saglayici seciminde saglanir; kodun garanti ettigi
bir sey degildir ve oyleymis gibi yazilmadi.

### 180 gun

`MIN_DEAL_EPOCHS = 518.400` (180 x 2880 epoch/gun).

**Gercek agdan dogrulandi:** ornek alinan canli anlasma #90000000'in suresi
`4737889 - 4219489 = 518.400` epoch — sabitle birebir ayni. Yani bu deger
uydurma degil, Filecoin'de fiilen kullanilan standart sure.

### Yenileme, veri kaybolmadan ONCE

`RENEWAL_WINDOW_EPOCHS = 86.400` (30 gun).

Anlasma bitene kadar beklemek gec olurdu: yeni anlasma kurmak, veriyi
saglayiciya aktarmak ve sektorun muhurlenmesi zaman alir. Bir test bunu
dogrudan dogruluyor — yenileme tetiklendiginde veri **hala yerinde**.

`flagRenewal` herkese aciktir: sart zaten zincirde gorunur bir olgudur ve
yenilemenin baslatilmasi tek bir tarafin insafina birakilmamalidir. Yalnizca
gercekten gerekliyse olay yayar.

---

## Dusen anlasmalar silinmiyor, isaretleniyor

Bir saglayici cezalandirilirsa kayit **silinmez**, `terminated` isaretlenir.
Silinseydi o saglayicinin gecmiste basarisiz oldugu bilgisi kaybolur ve ayni
saglayiciyla yeniden anlasma yapilip yapilmadigi izlenemezdi.

Buna karsilik **saglayici kilidi acilir**: dusen bir anlasmadan sonra ayni
saglayiciyla yeni bir anlasma yapilabilmelidir. Aksi halde bir kez gecici
ariza yasayan saglayici kalici olarak dislanirdi — ve bu bir politika karari
degil, kaza olurdu.

---

## `multiformats` neden kullanilmadi

Dogrulama betigi Filecoin piece CID'ini (commP) 32 baytlik ozete cevirir.
Beklenen arac `multiformats` idi ama **yalnizca ESM olarak yayinlaniyor**;
betik hardhat altinda CJS kosuyor ve ts-node dinamik `import()`'u `require`'a
indirgiyor. Paket bu baglamda hicbir sekilde yuklenemedi.

Cozulen sey dar ve iyi tanimli oldugu icin (CIDv1, base32, 32 baytlik ozet)
base32 + varint cozumu elle yazildi — 40 satir, bagimliliksiz.

**Dogrulama olcutu gercek veriyle sabitlendi:**

```
baga6ea4seaqkdi6ztbx4buyhb5sz7n4r5hqw3zzgvhclv24xajr6xswzcucxiaa
-> 0xa1a3d9986fc0d3070f659fb791e9e16de726a9c4baeb970263ebcad915057400
```

Bu deger `multiformats`'in ESM ortaminda urettigi degerle **birebir**
karsilastirildi.

---

## Betigin oz-kontrolu

Henuz kayitli anlasmamiz yokken betik hicbir sey dogrulamadan "tamam" derdi.
O halde ileride gercek bir uyusmazlik ciktiginda betigin dogru calistigina
guvenemezdik.

Bu yuzden `selfCheck` her kosumda calisir:

1. zincirdeki epoch hesabimiz Filecoin'in **gercek zincir basiyla**
   karsilastirilir,
2. ayristirma yardimcilari **canli** bir anlasma uzerinde denenir,
3. sozlesmedeki 180 gun tabani gercek anlasma suresiyle karsilastirilir.

---

## Panelde ne gosteriliyor

```
KALICILIK (FILECOIN)   IPFS pinli — Filecoin anlasmasi yok
```

Anlasma kaydedildikce bu satir `3 saglayici` olur; esik altindaysa
`(esik alti)`, yenileme penceresindeyse `· yenileme gerekli` eklenir.

**Uydurma bir "guvende" mesaji yoktur.** Bugun sistemde Filecoin anlasmasi
olmadigi icin panel bunu aynen soyler.

---

## Calibration'da gercek anlasma — kurulan boru hatti

Test aginda anlasma **kuruldu**. Akis dort betiktir:

```
1. filecoin-prepare-car.mjs   CAR + commP + Pinata'ya yukle + indirilebilirligi dogrula
2. filecoin-make-deal.ts      DealClient dagit + makeDealProposal        (Calibration)
3. filecoin-collect-deal.ts   saglayici yayimlayinca dealId'yi topla     (Calibration)
4. filecoin-register-deal.ts  defteri Sepolia'da guncelle                (Sepolia)
```

### Karsilasilan ve cozulen sorunlar

**Referans DealClient eski surume yaziliydi.** Protocol Labs'in sozlesmesi
`filecoin-solidity` v0.8'i varsayiyor; kurulu surum v4.0.3. Uc kirilma:
`external/` klasoru kalkmis (BigNumbers ve CBOR ayri paketlere tasinmis),
`ChainEpoch` artik kullanici tanimli deger tipi (`unwrap`/`wrap` gerekiyor),
`DealLabel` duz string degil `{data,isString}` yapisi.

Ayrica vendor'lanan `Types.sol` **tamamen silindi**: v4 kutuphanesi ayni CBOR
serilestiricilerini kendisi sagliyor. Kopya tutmak, Filecoin CBOR bicimi
degistiginde bakimi bize yikardi.

**Derleyici surumu secim degil zorunluluk.** `@zondax/solidity-bignumber`
kesin pragma kullanir (`pragma solidity 0.8.17;`, karet yok). Bundan
`evmVersion: london` de turer — `paris` solc 0.8.18 ile geldi. Yul optimizer
kapatildi: `BigNumbers.sol` icindeki assembly `msize` kullanir ve derleyici
ikisini birlikte reddeder (referans projenin `foundry.toml`'u da boyle).

**Iki piece CID bicimi var.** `@web3-storage/data-segment`'in `piece.link`
alani **v2** bicimini verir (`bafkzcib...`); market aktoru **v1** commP ister
(`baga6ea4seaq...`). v2 gonderilseydi teklif sessizce reddedilirdi. Dogrusu
`Piece.toInfo(piece).link`.

**CAR uretiminde iki tuzak.** Blockstore'un `getAll()`'u bu surumde beklenen
`{cid, bytes}` cifti yerine tembel bir uretici veriyor; bloklar `put`
sarmalanarak yakalandi. Ayri olarak CID nesneleri yeniden ayristiriliyor:
blockstore ile `@ipld/car` farkli `multiformats` kopyalarina baglanabiliyor ve
o durumda CarWriter dogru nesneyi bile reddediyor ("Can only write
{cid, bytes} objects" — nesnenin bicimini suclayan ama aslinda tip kimligiyle
ilgili bir hata).

**Ag gecidi yayilmasi.** Yeni pinlenen CAR genel ag gecidinde hemen gorunmez;
ilk alti istek 404 dondu. Ustel bekleme eklendi — CAR indirilemezse teklif
sessizce cope gider ve 24 saat bosuna beklenirdi, bu yuzden kontrol teklif
ONCESINE konuldu.

### Calibration'in yapisal siniri: tek saglayici

Calibration'da anlasmalari otomatik kabul eden **tek** saglayici vardir
(PiKNiK, `t017840`). Yani test aginda en fazla **1 replika** gosterilebilir ve
`isAdequatelyReplicated` **false** doner.

Bu bir hata degildir ve gizlenmemistir: panel `1 saglayici (esik alti)` yazar.
Kanitlanan sey mekanizmanin uctan uca calistigidir; 3 replika kurali uretimde
uc ayri saglayiciyla saglanir.

### Zamanlama

Teklif aninda anlasma olusmaz. PiKNiK sektorleri **12 saatte bir** kapatir;
`dealId` 12-24 saat icinde olusur. `start_epoch` bu yuzden 3 gun ileriye
verilir — cok yakin verilirse anlasma "baslangic gecti" diye duser.

---

## ENGEL: uretim icin gercek Filecoin hesabi gerekiyor

Defter, politika, dogrulama ve panel hazir. Eksik olan tek sey **gercek
anlasmalarin kendisi** — ve bu bir kod sorunu degil, **operasyonel bir
onkosuldur**:

- anlasma yapmak FIL bakiyesi olan bir Filecoin hesabi gerektirir, ya da
- toplu servis (Storacha / Lighthouse gibi) uzerinden API anahtari gerektirir.

Ikisi de hesap acmayi ve fon yatirmayi gerektirir; bunlar proje sahibinin
karari olan adimlardir. Karar verildiginde kurator servisine eklenecek parca
kucuktur: yukleme sonrasi donen `dealId`'yi `registerDeal` ile deftere
islemek.

### Calibration test agi — ucretsiz yol

Filecoin'in resmi test agi **Calibration**'dir ve ana agin tam bir kopyasidir:
ayni anlasma mekanigi, ayni PoRep/PoSt, ayni RPC yuzeyi. Tek fark token'in
degersiz olmasi (tFIL, musluktan alinir).

Gereken iki deger **gercek aglardan** `Filecoin.ChainGetGenesis` ile
dogrulanmistir — tahmin degildir:

| | genesis zaman damgasi | UTC |
|---|---|---|
| ana ag | 1.598.306.400 | 24 Agustos 2020, 22:00 |
| Calibration | 1.667.326.380 | 1 Kasim 2022, 18:13 |

Calibration'a gecmek icin **birlikte** degismesi gerekenler:

```
FILECOIN_GENESIS=1667326380
FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
```

Ikisinden biri unutulursa epoch hesabi kayar; `verify-storage-deals.ts` bunu
ilk kosumda yakalar (`Epoch turetimi kayik`).

---

## Olculen degerler

```
VeriarfyStorage dagitimi   ~1.100.000 gas
registerDeal (ilk kayit)   ~170.000 gas
registerDeal (sonraki)     ~150.000 gas
terminateDeal              ~ 60.000 gas
```

Okuma fonksiyonlari (`activeReplicas`, `renewalDue`) CID basina birkac anlasma
uzerinde doner; tum CID'ler uzerinde gezen bir dongu **yoktur**.

---

## Henuz yok

- **Gercek anlasmalar** — yukaridaki engel.
- **256 MB chunking** (WBS 2.3): rapor IPFS chunk boyutunu 256 MB olarak
  veriyor. Bu bir istemci/kurator ayaridir, zincirde temsil edilmez; blob
  boyutlarimiz su an bunun cok altinda.
- **PoRep/PoSt kanitlarinin zincirde dogrulanmasi**: Filecoin bu kanitlari
  KENDI zincirinde dogrular. Ethereum tarafinda tekrarlamak bir kopru
  gerektirir; anlasma kimligiyle dogrulama bunun pratik karsiligidir.
