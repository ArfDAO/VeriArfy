# MK-0006 — BSKK-44: kademeli esik ve ucret emaneti

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `VeriarfyProtocol.sol`, `VeriarfyPayments.sol`
**Kilit:** `VeriarfyPayments.test.ts` (BSKK-44 emaneti, 9 test) ve
`VeriarfyProtocol.test.ts` (esikli erisim, 11 test)
**Ilgili rapor bolumleri:** §2.5.2, §2.6, §4.1

---

## Karar

Rapor §2.6 su akisi tarif ediyor ve kod artik birebir bunu uyguluyor:

1. **Arastirmaci** bir "Access Request Transaction" gonderir,
2. Yetkili kurum dugumlerinin coklu imza onayi olmadan sorgu **yurutulemez**,
3. Esik, sorgunun **hassasiyetine gore** degisir.

Buna ucret emaneti eklendi: onay gelmeden para el degistirmez.

---

## Duzeltilen uc yanlislik

### 1. Talebi acan taraf tersti

Onceki kod:

```solidity
function requestDisclosure() external onlyAuthorizedNode { ... }
// ve talebi acan dugum ilk onayi kendisi veriyordu
```

Rapor §2.6 ise talebi **arastirmacinin** actigini soyluyor. Ustelik talebi
acanin kendi talebini onaylamasi, coklu imza mekanizmasini anlamsiz kiliyordu:
3 dugumlu bir agda 2 esikli bir talep, aslinda tek bir dugumun onayiyla
gecebiliyordu.

Yeni hali: talep, **kapi** (Gateway) uzerinden arastirmaci adina acilir ve
talebi acan onay VERMEZ.

### 2. Cozum yetkisi yanlis tarafa gidiyordu

Onceki kod izni **onaylayan dugumlere** veriyordu. Rapor §2.5.2 adim 6:

> "Cozulen sonuc yalnizca arastirmacinin cuzdan adresine sifreli kanal
> uzerinden iletilir."

Yani onaylayan kurumlarin sonucu gormesi gerekmiyor — onlar **yetkilendirir**,
okumaz. Yeni hali: `FHE.allow(snapshot, request.requester)`.

Test bunu iki yonlu dogruluyor: arastirmaci cozebiliyor, onaylayan dugum
cozemiyor.

### 3. Esik sabitti, rapor kademeli diyor

Rapor §2.6, birebir:

| Sorgu sinifi | Esik |
|---|---|
| genel istatistik sorgulari | **4/10** |
| bireysel mutasyon arastirmalari | **7/10** |
| populasyon genetigi analizleri | **9/10** |

Eslesme:

```
QUERY_TYPE_STATISTICS -> genel istatistik    -> 4
QUERY_TYPE_ML         -> bireysel mutasyon   -> 7
QUERY_TYPE_GWAS       -> populasyon genetigi -> 9
```

Esik **oran olarak** saklanir (10 uzerinden) ve gercek dugum sayisina
olceklenir. Mutlak sayi saklansaydi dugum sayisi degistiginde oran sessizce
kayardi. Yukari yuvarlanir: 3 dugumde 7/10 orani 2,1 degil **3** onay ister —
asagi yuvarlamak esigi gevsetirdi.

Esik **talep aninda** sabitlenir; sonradan dugum eklenip cikarilsa bile o
talebin esigi degismez.

---

## Ucret emaneti — raporun eksik biraktigi bag

Rapor §2.6 "sorgu onay olmadan yurutulemez" diyor ama **odeme ile onay
arasinda bir bag kurmuyor.** §4.1 ucretten bagimsiz konusuyor. Bu bosluk iki
yonlu istismara aciktir:

- arastirmaci oder, onay gelmez, parasi kilitli kalir;
- ya da tersi: onay gelmeden katilimcilar hak etmedikleri payi ceker.

Cozum: ucret `openQuery` aninda **emanete** alinir.

```
openQuery(queryType) -> ucret emanette, acilim talebi acilir
   |
   +-- onay gelirse -> settleQuery()  -> %80 havuza, %20 hazineye
   |
   +-- gelmezse     -> refundQuery()  -> arastirmaciya iade
```

Emanet asamasinda `claimable` **sifir** doner ve `claim` `NotSettled` ile
reddedilir.

### Iade neden gecikmeli

`REFUND_DELAY = 7.200 blok` (~1 gun). Onay sureci ani degildir; kurumlarin
degerlendirme suresi vardir. Ani iade mumkun olsaydi arastirmaci, onay tam
gelmeden parayi geri cekip sonucu yine de alabilirdi.

Onay geldikten sonra iade **edilemez** — aksi halde arastirmaci sonucu alip
parasini geri isteyebilirdi.

---

## Olculen degerler (Sepolia, gercek islem)

```
openQuery   (emanet + acilim talebi)  510.562 gas
approve     (BSKK-44 onayi)           ~ 60.000 gas
settleQuery (dagitima acma)           104.804 gas
claim       (pay cekme)               110.358 gas
```

`aggregateDosage` GWAS kontenjans tablosu eklendikten sonra **876.874 gas**
(onceden ~302.000). Artis 23 FHE isleminden gelir; hucre basina sabit is yuku
gizlilik icin zorunludur (bkz. [MK-0005](0005-gwas-ki-kare.md)).

Dogrulanmis canli kosum:

```
ucret 11.000.000 EMANETTE (acilim talebi #0)
  emanet dogrulandi: onay gelmeden pay hesaplanmiyor
onay -> settle -> katilimcilara 8.800.000, hazineye 2.200.000
cekilen: 8.800.000
```

---

## Kapi (Gateway) rolu

Rapor §2.5.2'de "Gateway", arastirmacinin yetkisini dogrulayan ve talebi
ileten bilesendir. Bizde bu rol **odeme sozlesmesindedir**: kayitli
arastirmaci kontrolu ve ucret tahsili zaten orada yapilir.

Protokol yalnizca `queryGateway` adresini tanir; arastirmaci kayit defterini
tanimasina gerek kalmaz. Kapi `setQueryGateway` ile sahip tarafindan atanir ve
dagitim betigi bunu otomatik baglar — **bu satir olmadan hicbir sorgu
acilamaz.**

---

## Henuz yok

- **Dead Man's Switch / DPSS** (rapor §2.6.1): ana dugumler ele gecirilirse
  9/12 esikli varis dugumlere devir. Proaktif gizli paylasim kodlanmadi.
- **TEE attestation / redundant computation** (rapor §2.5.2 adim 3a-3b):
  hesaplama makbuzunun dogrulanmasi. Bizde coprocessor katmani Zama'nin
  altyapisinda oldugu icin bu kontroller orada yasar.
- **Kurumsal HSM imzalari** (rapor §2.6): dugumler su an duz EOA. Uretimde
  her kurum kendi HSM korumali anahtariyla imzalamalidir.
