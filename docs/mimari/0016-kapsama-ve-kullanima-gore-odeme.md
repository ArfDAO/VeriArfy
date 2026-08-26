# MK-0016 — Kapsama bitmap'i ve kullanima gore odeme (1. adim)

**Durum:** Kabul edildi · 20 Agustos 2026
**Kod:** `libraries/CoverageBits.sol`, `VeriarfyProtocol.sol`, `VeriarfyBiomarkers.sol`
**Kilit:** `Coverage.test.ts` (9 test)
**Ilgili:** [MK-0013](0013-panel-hizalama.md), [MK-0015](0015-arayuz-ve-dogrulama-konsolu.md)

---

## Cozulen sorun

MK-0015 sunu ortaya cikarmisti: izin GELIR PAYLASIMINI yonetiyor, havuza
dahil olmayi degil. Uc secenek tartisildi (arastirmaci basina ayri tablo /
acilim aninda yeniden toplama / calisma duzeyinde izin) ve hepsi ya
olceklenmiyor ya da vaadi daraltiyordu.

Dogru cerceve **dorduncusuydu**: izin arastirmaciya gore degil, **secim
veriye gore**. Arastirmaci "hangi alanlara ihtiyacim var" der; o alanlara
GERCEKTEN veri vermis olanlar dahil olur ve **kullanildiklari kadar** pay
alir.

Bu, adaletsizligi de duzeltiyor: onceki halde izin vermeyen bir katilimci
toplamda yer aliyor ama pay almiyordu — iki dunyanin da kotusu.

---

## Yarisi zaten calisiyordu

**Alan secimi** vardi: `requestDisclosureMetrics(..., snpFrom, snpWindow,
metricFrom, metricWindow)`.

**"Sadece o veriye sahip olanlar"** da vardi: eksik isareti (`DOSAGE_MISSING`)
sifreliyken elenir, katilimci o alanin kontenjans tablosuna ve `n` sayimina
hic girmez. Gercek veriyle de gorunur oldu — 10 varyantlik panelde
`rs429358` satirinda toplam 2, digerlerinde 3 cikti, cunku AncestryDNA cipi
o varyanti tasimiyordu.

Eksik olan **odeme tarafiydi**.

---

## Kapsama bitmap'i

Kisi basina, alan basina bir bit: "burada gercek verim var".

```solidity
mapping(address => mapping(uint256 => uint256)) private _snpCoverage;
mapping(uint32 => uint32) public snpCoverageCount;   // odemenin paydasi
```

Odeme formulu:

```
pay(kullanici) = havuz x |kapsama(kullanici) ∩ istenen alanlar|
                         ──────────────────────────────────────
                         Σ (istenen her alanin kapsama sayaci)
```

**Maliyet katilimci sayisindan BAGIMSIZDIR.** Pay da payda da O(istenen alan
sayisi); tum katilimcilari dolasan bir tasarim binlerce kiside imkansiz
olurdu. Cekmeli (pull) hesap korunur.

Ayni alan iki kez sayilmaz — sayilsaydi payda sisirilir ve herkesin payi
seyrelirdi. Bir test bunu partili gonderimde dogruluyor.

---

## Kullanici BEYAN ETMEZ, sistem cikarir

Bu, tasarimin en onemli kurali.

> Siradan bir kullanici dosyasinin icinde hangi varyantlarin oldugunu bilmez.
> Doktor degildir — dosyasinin TURUNU bilir.

Bu yuzden kapsama bir soru degil, **ayristirma sonucudur**:

- **Genomik**: `alignToPanel` hangi alanin bulundugunu zaten doner. Maske
  hizalanmis dozaj dizisinden turetilir — `DOSAGE_MISSING` olmayan her alan
  gercek veridir.
- **Biyobelirtec**: bos birakilan metrik `BIOMARKER_MISSING` (0) gider ve
  kapsanmaz.

Tek kaynaktan turetilmesi onemli: maske ayri hesaplansaydi gonderilen sifreli
degerle sessizce ayrisabilirdi.

Arayuz de buna gore konusur: "dosyanizin icinde ne oldugunu bilmenize gerek
yok, turunu secmeniz yeter."

---

## Neden acik (sifresiz)

Sifreli bir bitmap'ten pay dagitilamaz. Sizan sey **deger degil VARLIK**:
"bu adresin rs4977574 olcumu var" bilgisi cikar, dozajin 0 mi 1 mi 2 mi
oldugu cikmaz.

Genomikte kapsama buyuk olcude hangi cipin kullanildigini soyler, biyolojiyi
degil. Biyobelirtecte biraz daha bilgi verir. Olculebilir ama kucuk bir bedel;
alternatifi odeme yapamamak.

---

## Guven siniri — yalanin NEREDE durdugu

Sozlesme bitmap'in sifreli veriyle ortustugunu **dogrulayamaz**; sifreli
olmasinin anlami budur. Bir istemci "bende bu alan var" deyip bos
gonderebilir.

Ama zararin siniri kodda ve testte yazili:

| | etkilenir mi |
|---|---|
| istatistik (kontenjans, `n`) | **HAYIR** — sifreli deger karar verir |
| odeme | evet — veri vermeden pay alinabilir |

Bir test bunu dogrudan sinar: kapsama yalani soyleyen katilimcinin bitmap'i
kabul edilir, ama o alanin tablosunda yine yalnizca IKI gercek gozlem cikar
(yalan soylenmeyen alanda UC).

Ters yon de test edildi: kapsamayi eksik bildiren kendi payini kaybeder ama
tabloya yine girer.

**Kalici cozum ZK koken kanitidir**: `data_provenance` devresi paneli zaten
akredite kurum imzasina bagliyor; bitmap oraya ACIK CIKTI olarak
eklendiginde uydurulamaz hale gelir. Bu, sonraki adim.

---

## Kod boyutu: optimizasyon ayari degisti

Kapsama eklenince `VeriarfyProtocol` 24.513 bayta cikti — EIP-170 sinirina
**63 bayt** kala. Sonraki adim (alan listesiyle secim) bunu tasimazdi.

`runs` 800'den 100'e cekildi:

```
800 -> 24.513    400 -> 24.300    200 -> 24.074    100 -> 23.587
```

Takas nettir: islem maliyetine homomorfik islemler hakim (SNP basina
~673.000 gaz). Cagri dagitimindaki birkac yuz gazlik fark olculebilir bile
degil; kod boyutu ise dagitilabilirligin ta kendisi.

`CoverageBits` de `public` kutuphanedir (1.384 bayt, ayri adres) ve her iki
kanal onu paylasir.

---

---

## 2. adim — secim: pencere yerine ALAN LISTESI

Arastirmaci artik bitisik bir aralik degil, **istedigi alanlarin listesini**
verir:

```solidity
requestDisclosureFields(researcher, queryType, uint32[] snpIds, uint32[] metricIds)
openQueryFields(queryType, uint32[] snpIds, uint32[] metricIds)   // kapi
```

Gercek arastirma "SNP 0-9" istemez; "rs4977574, rs429358, rs4680" ister.
Bitisik pencere arastirmaciyi ilgilenmedigi alanlari da acmaya zorluyordu —
hem gereksiz maliyet hem **gereksiz aciklik**.

`requestDisclosureWindow` ve `requestDisclosureMetrics` kaldirildi; alan
listesi ikisini de kapsiyor. `requestDisclosure(researcher, queryType)`
kisayolu kaldi (varsayilan: tavana kadar tum alanlar) cunku odeme
sozlesmesinin basit yolu ve duman testleri onu kullaniyor.

### Depolama ucuz

`uint32` dizisi slot basina 8 eleman paketler: 32 SNP yalnizca **4 depolama
yuvasi** tutar. Uyelik testi ayri bir haritada degil, `view` icinde dogrusal
aramayla yapilir — liste en fazla 32 uzunlukta ve `view` bedava, ayri harita
ise her talepte fazladan yazim demek olurdu.

### Arayuz

Arastirmaci konsolunda alan secici: her rsID ve metrik bir cip; tiklayarak
secilir. "Yalnizca sectiginiz alanlar acilir; odeme de buna gore dagitilir."

---

---

## 3. adim — odeme: IKI HAVUZ

Istenen davranis "verisi kullanildigi kadar kazansin". Bonuslari (nadirlik,
kurucu katkici) kullanim sayisiyla CARPMAK matematiksel olarak mumkun ama
paydasi O(1) hesaplanamaz:

```
Σ_kisi [ eslesme(kisi) x bonus(kisi) ]      ← ayrisamaz
```

Tum katilimcilari dolasmak ise binlerce kiside imkansiz. Bu yuzden havuz
IKIYE ayrildi — her ikisi de TAM hesaplanabilir, yaklasiklik yok:

| havuz | dagitim | maliyet |
|---|---|---|
| **kullanim** (varsayilan %70) | `eslesme(kisi) / kapsamaToplami` | O(alan) |
| **bonus** (%30) | `agirlik(kisi) / toplamAgirlik` | O(1) |

Bonusun anlami da korunur: nadirlik carpani "hangi alani verdin"den bagimsiz
bir odul olarak durur — zaten oyle olmali, cunku nadir varyant tasimak
kalp hizi olcumunden bagimsiz bir degerdir.

Oran `setUsageShare` ile ayarlanabilir; **iki uc de gecerlidir**: 0 = tamamen
bonus (eski davranis), 10.000 = tamamen kullanim. Ikisi de test edilir.

### Kapsama toplami DONDURULUR

`coverageTotal` sorgu acildiginda kaydedilir — katilimci sayisi gibi. Sorgu
acildiktan sonra yeni katilimcilar gelmeye devam eder; payda degisseydi daha
once hesaplanan paylarin toplami havuzu ASABILIRDI.

### Kapsama sifirsa para kilitlenmez

Istenen alanlarin hicbirine kimse veri vermemisse kullanim havuzu
dagitilamaz. O tutar kilitlenmez, BONUS havuzuna eklenir — aksi halde para
sozlesmede olu kalirdi.

### Para yolunun korumalari

Formul degistiginde ilk kirilacak yer burasidir; 11 yeni test eklendi:

- paylarin toplami havuzu ASMAZ (kusurat kisi basina en fazla 2 birim —
  iki havuz, iki bolme)
- `claim` ile `claimable` AYNI ifadeden gelir (daha once tam burada
  ayrismislardi ve test yakalamisti)
- cekilen toplam havuzu asmaz
- iki kez cekilemez
- oranin iki ucu da tutarli

`RarityMultiplier` testleri de guncellendi: nadir tasiyicinin payi artik
bob'un TAM IKI KATI DEGIL — yalnizca BONUS bileseni ikiye katlanir, kullanim
bileseni esittir (herkes ayni alanlari kapsiyor). Test bunu acikca yaziyor.

---

## Sirada

| # | is | durum |
|---|---|---|
| 1 | Kapsama bitmap'i + alan sayaclari | **bitti** |
| 2 | Secim: pencere -> alan listesi | **bitti** |
| 3 | Odeme formulu kullanima gore | **bitti** |
| 4 | Bitmap'i ZK devresine acik cikti olarak ekle | sonra |
| 5 | `submitRecord`'u katki akisina bagla | sonra |
| 6 | Arastirmaciya alan secme ekrani | **bitti** |

---

## IZIN KAPISI KALDIRILDI

Soru suydu: *"izin vermiyorsa neden sisteme yukluyor ki veriyi?"*

Yanit: **yuklemek zaten izindi**, ama sistem ayrica bir izin adimi
istiyordu — ve sozlesmenin kendisi bu ikiligi zorunlu kiliyordu:

```solidity
function grantAccess(...) {
    if (participantIndex[msg.sender] == 0) revert NotAParticipant(msg.sender);
    //  ^ ONCE havuza girmis olmak SART
}
```

Yani sira MECBUREN "once yukle, sonra izin ver"di. Sonucu uc yoldan da
ayniydi:

| durum | ne oluyordu |
|---|---|
| **zamanlama** | bugun yukleyen, YARIN kaydolan arastirmaciya izin veremez — var olmayan adrese izin verilemez, ama verisi zaten toplamin icinde |
| **iptal** | izin geri alinsa bile karisan geri cikarilamaz |
| **secici ret** | "su kuruma evet, buna hayir" imkansiz — toplam TEKTIR |

Ucunde de: veri kullaniliyor, karsiligi odenmiyor. Olmayan bir kontrolu var
gibi gostermek, gizlilik panelinin tum amacina aykiriydi.

### Yerine gelen

- `grantAccess` / `revokeAccess` / `permission()` / `hasAccessAt` **kaldirildi**
- `leavePool()` geldi: **havuzdan cikma** hakki
- `wasInPoolAt(katilimci, blok)`: cikmadan ONCE acilan sorgulardan hak edilen
  paylar korunur — cikmak cezalandirma degildir
- Ucret artik havuzun TAMAMINA gore: arastirmaci toplamin tamamini iceren bir
  istatistik aliyor, dolayisiyla tamami kadar oder. Onceden az odeyip cok
  aliyordu.
- Bonus paydasi GLOBAL sayaclardan: `participantCount`, `rareCarrierCount`,
  `rareFoundingCount`. Kurucu sayisi sayilmaz, `min(N, limit)` ile hesaplanir.
- Nadirlik `rareAtGrant` yerine `rareBefore(katilimci, blok)` ile dondurulur

Protokol 24.037 -> **22.043 bayt** (2.533 pay): izin makinesi ~2 KB tutuyordu.

### Testin yakaladigi gercek acik

Izin kapisi kalkinca **"sorgudan sonra katilan"** siniri da kalkti — cunku o
sinir ORTUK olarak izin tarafindan saglaniyordu (`grantedAtBlock <=
openedAtBlock`). Mevcut bir test bunu hemen yakaladi.

Sinir artik ACIKCA yazili ve zaten bunun icin tasarlanmis olan 1 tabanli
indeksi kullaniyor:

```solidity
uint256 index = protocol.participantIndex(account);
if (index == 0 || index > q.snapshotCount) return 0;
```

Yazilmasaydi sonradan katilan da pay alir, paylarin toplami dondurulmus
paydayi ASARDI.

### Durust sinir — panelde de yazili

**Cikmak gecmisi silmez.** Toplama karisan geri cikarilamaz; bu bir uygulama
eksigi degil, homomorfik toplamanin dogasidir. Cikis BUNDAN SONRASI icindir.

Gizlilik Paneli bunu gizlemek yerine soyluyor. Geri donduruemez sekilde
toplulastirilmis istatistigin bireysel veri sayilmamasi, hukuken de bu
durustlugu destekler.
