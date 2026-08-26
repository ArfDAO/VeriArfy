# MK-0018 — Fiyat: kayit basina, kitliga gore

**Durum:** Kabul edildi · 21 Agustos 2026
**Kod:** `VeriarfyPayments.quoteForFields`, `_scarcityBps`, `_snapshotPricing`,
`weightedCoverage`, `CoverageBits.maskOf`
**Kilit:** `VeriarfyPayments.test.ts` — "Kitlik carpani" (8 test)
**Ilgili:** [MK-0016](0016-kapsama-ve-kullanima-gore-odeme.md), [MK-0017](0017-kanitli-kapsama.md)

---

## Sorun: fiyat, satin alinan seyle ilgisizdi

Eski formul tek satirdi:

```solidity
fee = baseFee + perParticipantFee * participantCount();
```

Iki yonden de yanlisti.

**Alan sayisi fiyata girmiyordu.** MK-0016 arastirmaciya alan secme hakki
verdi — biri `{rs4977574}` ister, digeri 40 alanlik bir panel. Ikisi de AYNI
parayi oduyordu. Oysa aldiklari sey ayni degil.

**Verisi olmayan kisi icin de odeniyordu.** Havuzda 1000 kisi olup istenen
alanda 12'sinde veri varsa, satin alinan sey 12 kayittir. Kalan 988 kisi o
sorguya hicbir sey vermiyor — ne odeme aliyor (MK-0016 kapsamaya gore
dagitiyor) ne de fiyata katkisi mesru.

Yani odemenin **paydasi** (kapsama toplami) ile **fiyatin carpani**
(havuz buyuklugu) farkli iki sayiydi. Bu ayrik durdukca "verisi kullanildigi
kadar kazansin" iddiasi fiyat tarafinda karsiliksiz kaliyordu.

---

## Yeni formul

```
ucret = taban + Σ  kayit(alan) x kayitFiyati x kitlik(alan)
             alan ∈ istenen

kayit(alan)  = o alana GERCEKTEN veri vermis kisi sayisi
kitlik(alan) = havuz / kayit(alan)              [1x .. tavan]
kayit(0)     = 0  ->  alan BEDAVA
```

**Kayit = bir kisi x bir alan.** Arastirmaci `{rs4977574, VO2MAX}` isterse ve
bunlara sirasiyla 12 ve 30 kisi veri vermisse, satin aldigi sey 42 kayittir.

Bu sayi, odemenin dagitildigi paydayla (`coverageTotal`) **birebir ayni**.
Arastirmacinin odedigi ile katilimcinin hak ettigi artik ayni olcuye dayaniyor
— bu, formulun asil kazanimi.

---

## Kitlik: az bulunan veri kisi basina daha pahali

Istenen davranis: seyrek bir kohortun verisi, herkeste bulunan bir varyantla
ayni fiyata satilmasin.

OLCULDU — 1000 kisilik havuz, tek alan, `perRecordFee = 0,05`:

| kapsama | 4x tavan (toplam / kisi) | 10x tavan (toplam / kisi) |
|---|---|---|
| herkeste | 50,00 / 0,05 | 50,00 / 0,05 |
| %50 | 50,00 / 0,10 | 50,00 / 0,10 |
| %25 | 50,00 / 0,20 | 50,00 / 0,20 |
| %10 | 20,00 / 0,20 | 50,00 / **0,50** |
| %5 | 10,00 / 0,20 | 25,00 / **0,50** |
| %1 | 2,00 / 0,20 | 5,00 / **0,50** |

Seyrek veriye sahip kisi, kalabalik bir alandaki kisiden kat kat fazla
kazaniyor. Toplamda seyrek alan yine daha ucuz — daha az veri satin
aliniyor — ama kisi basi fiyat yukseliyor. Istenen tam olarak buydu.

### Carpan neden zincirden turetiliyor

"Hangi veri degerli" karari sahibe birakilabilirdi — bir `fieldValueBps`
tablosu yeterdi. Birakilmadi: fiyat o zaman piyasanin degil sahibin karari
olurdu ve merkeziyetsizlik iddiasinin en gorunur yerinde catlak acilirdi.

Kitlik, kapsama sayaclarindan **turer**. Kimse elle atamaz.

### Tavan bir MALIYET SINIRI DEGIL — bu yanlis anlasilmaya acik

Ilk okumada tavan bir guvenlik sinir gibi gorunur. Degildir; alan ucreti
zaten kendiliginden sinirlidir:

```
ucret(alan) = kayit x perRecordFee x (havuz / kayit) = perRecordFee x havuz
```

Carpan TAVANSIZ olsa bile bir alanin ucreti `perRecordFee x havuz` degerini
asamaz. Yani tavani yukseltmek maliyeti patlatmaz.

**Tavanin gercek islevi: kitlik ayriminin NEREDE DURACAGI.** Tavan `C` iken,
kapsamasi `havuz/C` degerinin altindaki tum alanlar AYNI kisi basi fiyati
alir.

Ilk yazilan deger 4x'ti ve OLCUM bunun yanlis oldugunu gosterdi: %25'in
altindaki her sey ayni fiyata dusuyordu. Havuzun %1'indeki bir nadir kohort
ile %25'indeki siradan bir alan kisi basina birebir ayni parayi aliyordu —
mekanizma tam da devreye girmesi gereken yerde susuyordu.

Gercekci nadir kohortlar (nadir hastalik, spesifik klinik grup) havuzun
%1-%10'udur. Varsayilan bu yuzden **10x** (`maxScarcityBps = 100_000`);
ayrim %10'a kadar surer.

`BPS_DENOMINATOR` verilerek kitlik tamamen kapatilabilir; altina inilemez
(kitligin fiyati DUSURMESI anlamsiz olurdu, carpan zaten 1'in altina
inmiyor).

> Tip notu: 100.000 baz puani `uint16`'ya (65.535) SIGMAZ. Alan `uint32`;
> derleyici bunu yakaladi ama benzer bir sinir sessizce tasabilirdi.

---

## Kitlik FIYATA girip PAYA girmeseydi mimari kendiyle celisirdi

Ilk uygulama yalnizca fiyati degistirdi. Odeme tarafi eski haliyle kaldi:

```solidity
usage = usagePot * coverageWeight(account) / coverageTotal;   // agirliksiz
```

`coverageWeight` "kac alana veri verdin" der — hangi alan oldugunu umursamaz.
Sonucu:

> Arastirmaci nadir alan icin 10 kat oder; o alanin sahibi, yaygin bir alanin
> sahibiyle **ayni** payi alir. Fazla para kullanim havuzuna girer ve herkese
> esit dagilir — yani nadir veri sahibinin hakki kalabaligin icinde erir.

Tek alanlik sorguda sorun gorunmez (havuz zaten yalnizca o alanin sahipleri
arasinda bolunur). **Karisik sorguda** ortaya cikar ve asil kullanim sekli
odur.

### Cozum: tek formul, iki yerde

Ayni kitlik carpani artik payda da kullaniliyor:

```
pay(kisi) = usagePot x  Σ kitlik(alan)      /  Σ kayit(alan) x kitlik(alan)
                    alan ∈ kisinin verdigi     alan ∈ istenen
```

Payda (`weightedTotal`) ucretin alan bileseniyle **birebir ayni formul**.
Arastirmacinin odedigi ile katilimcilarin toplam hakedisi tek bir sayidan
turer.

Olculdu (3 kisilik havuz, 0. alan herkeste, 1. alan yalnizca alice'te,
her ikisi de istenen sorgu):

| kisi | verdigi | agirlik |
|---|---|---|
| bob, carol | yaygin (1x) | 1 birim |
| alice | yaygin + nadir (1x + 3x) | **4 birim** |

### Agirliklar neden DONDURULUYOR

Kitlik `havuz / o alani verenler` demek ve ikisi de sorgudan sonra degismeye
devam ediyor. Guncel deger kullanilsaydi erken cekenle gec ceken farkli
agirlik gorur, paylarin toplami dondurulmus havuzu **asabilirdi**.

Bu yuzden agirliklar sorgu acilirken `_fieldScarcity[queryId]` icine yazilir.
Maliyet dusuk: `uint32[]` yuvaya 8'erli paketlenir, talep tavaninda
(32 SNP + 16 metrik) yalnizca 6 yuva.

### Kapsama okumasi: 48 cagri yerine 1 maske

Agirliklandirma "kac alan" degil "HANGI alanlar" gerektiriyor. Alan basina
bir `has` cagrisi, tavanda onlarca harici staticcall demekti. Tavanlar
(32 ve 16) tek bir `uint256`'ya sigdigi icin `CoverageBits.maskOf` tek
cagrida maskeyi doner.

---

## SINIR — durustce: kitlik, degerin mukemmel vekili degil

Kitlik "az bulunuyor" demektir, "degerli" demek degil. Az doldurulmus onemsiz
bir alan da pahali gorunur.

Gercek klinik deger (kanser kohortu, nadir hastalik) ancak **calisma
panelinin nasil tanimlandigiyla** gelir: boyle bir panel zaten seyrek
doldurulur ve fiyat oradan devralir. Yani mekanizma dogru sinyali yakaliyor
ama sinyalin kendisi dolayli.

Alternatifi — sahibin atadigi deger tablosu — daha dogrudan ama merkezi
olurdu. Bugunku secim bilincli; degistirilmesi gerekirse `_fieldPrice` tek
noktada durur.

---

## Sira degisti: once talep, sonra tahsilat

Ucret artik istenen alanlarin kapsamasindan hesaplaniyor. Alan secilmeyen
yolda alanlari protokol belirliyor, yani liste ancak talep acildiktan sonra
kesinlesiyor:

```solidity
uint256 requestId = explicitFields ? requestDisclosureFields(...) : requestDisclosure(...);
(uint256 fee, ) = quoteForFields(disclosureSnpIds(requestId), disclosureMetricIds(requestId));
token.safeTransferFrom(msg.sender, address(this), fee);
```

Eski koddaki "once transfer, sonra durum" yorumu ayni islem icinde zaten
gecersizdi: transfer duserse talep de geri alinir.

---

## Gelistirme rakamlari — kasitli olarak dusuk

Panel 10 SNP + 6 metrik. Eski "kisi basi 1 USDC" ile 10 katilimcilik bir havuz
160 kayit eder — sorgu basina 160 USDC, test agindaki her denemeyi
pahalilastirirdi.

| | eski | yeni |
|---|---|---|
| taban | 10 USDC | 1 USDC |
| birim | 1 USDC / kisi | 0,05 USDC / kayit |
| 1 katilimci, 16 alan | 11 USDC | 1,80 USDC |
| 10 katilimci, 16 alan | 20 USDC | 9 USDC |

**Yapi degismedi, yalnizca birim fiyat kucultuldu.** Uretimde
`QUERY_BASE_FEE` / `QUERY_PER_RECORD_FEE` ile ayarlanir.

---

## Adlandirma

`perParticipantFee` -> `perRecordFee`. Eski ad artik yalan soyluyordu:
carpan katilimci degil kayit. `quoteFor(address)` kaldirildi — fiyat
arastirmaciya gore degismiyor, alanlara gore degisiyor; yerine `quote()`
(varsayilan pencere) ve `quoteForFields(snpIds, metricIds)` geldi.
