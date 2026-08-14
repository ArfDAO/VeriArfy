# MK-0004 — Gelir paylasimi: raporun formulu ve olceklenme sorunu

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `packages/contracts/contracts/VeriarfyPayments.sol`
**Kilit:** `packages/contracts/test/VeriarfyPayments.test.ts` (12 test)
**Ilgili rapor bolumleri:** §3.5, §4.1, §4.2, §4.2.1

---

## Karar

Hesaplama basina odeme ve gelir paylasimi tek bir kontratta toplandi.
Raporun ekonomik modeli korundu — %80 katilimci / %20 hazine, stablecoin,
utility token yok — ama **iki noktada rapordan bilincli olarak sapildi.**

---

## Sapma 1: raporun formulu tutarsiz

Rapor §4.2:

```
R_LP = (F_query x 0.80) x (User_Data_Used / Total_Data_Queried)
```

Metinde `User_Data_Used` "sorguda verisi kullanilan bireysel kullanici
sayisi", `Total_Data_Queried` ise "sorgunun kapsadigi toplam veri havuzu
buyuklugu" olarak tanimlaniyor.

Formul iki acidan calismiyor:

1. `R_LP` kisi basi odul gibi adlandirilmis ama sag taraf TOPLAM havuzu
   veriyor; kullanicilar arasinda nasil bolunecegi hic tanimlanmamis.
2. Sorgu tum havuzu kapsadiginda oran 1 olur ve carpan hicbir bilgi tasimaz —
   ki tipik durum budur.

Uygulanan tutarli okuma:

```
havuz     = ucret x 0.80
kisi basi = havuz / sorgudakiKatilimciSayisi
```

Rapor buna gore duzeltilmeli.

---

## Sapma 2: raporun dagitim yontemi olceklenmiyor

Rapor §4.2: *"Akilli sozlesme, her sorgu sonrasi kullanicilarin hak ettikleri
geliri dahili bakiye olarak kaydeder."*

Bu, sorgu basina **N adet depolama yazimi** demektir (N = katilimci sayisi).
Raporun kendi 3. yil hedefi 1 milyon katilimci; tek bir sorgu blok gaz
limitini kat kat asar. Rapor bu maliyeti "kullanici basina ~45K gas" diye
veriyor ama bunun **kim tarafindan** odendigini soylemiyor — yazimlar sorguyu
acan islemde gerceklesirdi.

Uygulanan cozum: sorgu **O(1)** kaydedilir, pay **cekim aninda** hesaplanir.

```solidity
struct Query {
    uint256 liquidityPot;   // ucretin %80'i
    uint32  snapshotCount;  // sorgu acildigi andaki katilimci sayisi
    ...
}
```

Uygunluk testi de O(1). Protokolde her katilimcinin **1 tabanli** katilim
sirasi tutulur (`participantIndex`); indeksi anlik goruntuden kucuk esitse
katilimci o sorguya dahildir. Boylece:

- sorgu acmak: katilimci sayisindan BAGIMSIZ sabit maliyet,
- pay cekmek: kullanici basina sabit maliyet, kendi odedigi gaz.

Yan fayda: sorgudan **sonra** katilan biri o sorgudan pay alamaz — dogru olan
da budur, cunku verisi hesaplamaya girmemistir. Test bunu dogruluyor.

---

## Olculen gerçek degerler (Sepolia)

| Islem | Gas | Rapordaki iddia |
|---|---|---|
| `openQuery` | 212.102 | belirtilmemis |
| `claim` | **96.398** | ~45.000 |

Rapordaki 45K rakami gercekci degil: tek basina bir ERC-20 `transfer` soguk
alicida ~50K tuketir, ustune sorgu okumasi, uygunluk kontrolu ve "cekildi"
isareti gelir. **Rapor 96K olarak duzeltilmeli.**

Dogrulanmis canli kosum:

```
ucret 11.000.000 (11 tUSD, 1 katilimci)
  -> katilimcilara 8.800.000   (%80)
  -> hazineye      2.200.000   (%20)
cekilen: 8.800.000
tx: 0xdc11df7728cc13d185267b0cb782ea649aa775fa9629e2ffdbef0aa53eefa8d2
```

---

## Korunan tasarim kararlari

**Utility token yok.** Kontrat herhangi bir ERC-20 ile calisir; uretimde USDC
adresi `PAYMENT_TOKEN` ile verilir. Kendi tokenimiz yoktur ve basilmaz
(rapor §3.5).

**Katilimci payi degistirilemez.** `liquidityShareBps` `immutable`. Dagitim
orani, kullanicilarin veri yuklerken kabul ettigi ekonomik sozlesmenin
parcasidir; sonradan dusurulebilir olsaydi guven varsayimi degisirdi. Rapor
bunu sabit %80 diye anlatiyor ama degistirilemezligi belirtmiyor — daha guclu
bir garanti olarak eklenmeli.

**Yalnizca ZK ile dogrulanmis arastirmaci sorgu acabilir.** `VeriArfyRegistry`
kaydi zorunlu. Rapor bu bagi kurmuyor; kurulmasi hem Sybil savunmasi hem de
denetlenebilirlik acisindan dogru.

**Bos havuzda sorgu acilamaz.** Dagitilacak kimse yokken ucret tahsil etmek,
ucretin tamaminin hazineye gitmesi demek olurdu.

---

## Kusurat (dust)

`liquidityPot / snapshotCount` tam bolunmedigi icin her sorguda en fazla
`snapshotCount - 1` birim artar. Bu tutar kontratta kilitli kalirdi;
`sweepDust(queryId)` ile hazineye tasinir.

Test invaryanti: **odenen = dagitilan + hazine**, ve kontrat bakiyesi tam
olarak hazine kadar. Fazlasi kilitli fon demektir.

---

## Henuz yok

- **Nadirlik carpani** (rapor §4.3): sifreli boolean tetikleyici ile nadir
  varyant tespiti. FHE karsilastirma devresi ve esikli cozum gerektirir;
  mevcut pay hesabi duz esit bolusturme yapar.
- **Sorgu ile esikli acilimin baglanmasi**: su an odeme ve BSKK-44 onayi ayri
  akislar. Dogru tasarim, ucretin acilim onayina emanet (escrow) edilmesidir.
- **Toplu dagitim / odeme kanallari** (rapor §4.2): cekim modeli zaten O(1)
  oldugu icin aciliyeti dusuk.
