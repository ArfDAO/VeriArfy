# MK-0009 — Dead Man's Switch: varis dugumlere yetki devri

**Durum:** Kabul edildi · 14 Agustos 2026
**Kod:** `VeriarfyProtocol.sol` (varis kumesi, yasam isareti, devir)
**Kilit:** `DeadMansSwitch.test.ts` (24 test)
**Ilgili rapor bolumleri:** §2.6.1 (birincil), §2.6, §2.7

---

## Raporun tarifi ve ikiye ayrilmasi

Rapor §2.6.1 tek bir mekanizma gibi anlatiyor ama **iki ayri sey** var ve
bunlarin sahibi farkli:

| Parca | Nerede yasar | Bizde |
|---|---|---|
| **Anahtar yeniden paylasimi** (DPSS, derece-5 -> derece-8) | anahtarin sahibinde | **YOK** — anahtar bizde degil |
| **Yetki devri** (varis dugumler, 9/12) | yetkilendirmenin oldugu yerde | **VAR** — zincirde |

### Neden DPSS bizde yok

Rapor, "ulusal havuzun anahtari"nin Shamir ile bolundugunu ve krizde
Herzberg (1995) Proactive Secret Sharing ile derece-8 bir polinoma tasindigini
anlatiyor.

Canli mimaride o anahtar **Zama'nin KMS esik anahtaridir.** Bizde yoktur.
Elimizde olmayan bir sirri yeniden paylastiramayiz — bunu yapiyormus gibi kod
yazmak sahtekarlik olurdu. Ayni yapisal durum
[MK-0008](0008-guvenilmez-dugum.md)'deki zk-FHE icin de gecerlidir.

Kendi Shamir katmanimiz **var** — `client-fhe-rust` icinde 10 pay / 7 esik
(`sharks`), kullanicinin kendi `ClientKey`'i icin, testleriyle. Ama o baska bir
alandir (Concrete), ulusal havuz degil; bkz. [MK-0001](0001-anahtar-rejimi.md).

### Neden yetki devri bizde VAR

Bizim mimaride kriz aninda kilitlenen sey anahtar degil, **acilim
yetkilendirmesidir** — ve o tamamen zincirdedir. Dolayisiyla raporun SPOF
korumasini fiilen saglayan yarisi bizde uygulanabilir, ve uygulandi.

---

## Mekanizma

```
ana dugumler calisiyor      -> onay ANA dugumlerden
ana dugumler N blok sustu   -> DEVIR -> onay VARIS dugumlerden (9/12)
ana dugumler geri dondu     -> devir kalkar
```

### Yasam isareti neden tek sayac

Rapor "ana dugumlerin belirli bir sure yanit vermemesi" diyor — yani
**tamaminin** susmasi. Bir dugum bile hayattaysa ag ayaktadir.

`lastMainHeartbeat` tek bir sayacdir. Dugum basina zaman damgasi tutmak, devir
kontrolunde tum listeyi dolasmayi gerektirirdi; tek sayac hem tanimi birebir
karsilar hem kontrolu **O(1)** yapar.

**Onay vermek de yasam isaretidir.** Calisan bir dugumun ayrica "hayattayim"
demesi gerekmemelidir; `approveDisclosure` sayaci gunceller. Ayri bir
`heartbeat()` yalnizca uzun sure sorgu gelmeyen donemler icindir.

---

## Raporun kapatmadigi bosluk: ele gecirme susmaz

Rapor mekanizmanin "ana dugumler dusman tarafindan **hacklenirse**" de devreye
girdigini soyluyor. **Sessizlik tespiti bunu goremez:** ele gecirilmis bir
dugum susmaz — saldirgan yasam isareti gondermeye devam eder ve devri sonsuza
kadar erteler.

Bu, sessizlik tabanli **hicbir** tasarimin cozemeyecegi bir sorundur. Bir test
bunu bir ozellik olarak degil, **bir sinir olarak belgeliyor**: saldirgan 5 kez
esigin bir blok altinda heartbeat gonderir, devir hic acilmaz.

Ele gecirme icin ayri ve gorunur bir yonetisim islemi eklendi:
`declareFailover()`. Kritik ayrinti — **yasam isareti bunu temizlemez.** Aksi
halde ele gecirilmis dugum tek bir `heartbeat` ile kendi yetkisini geri
alirdi. Yalnizca `clearFailover()` kaldirir.

---

## Varis esigi: 9/12 DEGIL, "9/12 ile kademelinin buyugu"

Rapor devir esigini tek bir oran olarak veriyor: **9/12 = %75.**

Ama §2.6'daki kademeli esikler de yururlukte
([MK-0006](0006-bskk44-emanet.md)): populasyon genetigi sorgusu **9/10 = %90**
ister.

Yalnizca 9/12 uygulansaydi, en hassas sorgu **kriz aninda daha KOLAY**
gecerdi — mekanizmanin amacinin tam tersi. Bu yuzden iki esikten **buyugu**
gecerlidir.

```
12 varis, istatistik : max(ceil(12x9/12), ceil(12x4/10)) = max(9, 5)  =  9
12 varis, GWAS       : max(ceil(12x9/12), ceil(12x9/10)) = max(9, 11) = 11
```

Raporun 12 varisli ornegi istatistik sorgusunda **tam 9** cikiyor — yani
raporun rakami korunuyor, yalnizca daha hassas sorgularda yukari cekiliyor.

---

## Onaylar neden AYRI sayiliyor

Devir "ana dugumlere guvenilmiyor" demektir. Bu yuzden `mainApprovals` ve
`heirApprovals` **ayri** tutulur; devirden once toplanan ana onaylar varis
esigine **sayilmaz.**

Karistirilsaydi, ele gecirilmis dugumlerin biriktirdigi onaylar varis esigini
doldurabilirdi — devir mekanizmasini icinden bosaltan bir acik. Bir test bunu
dogrudan zorluyor: GWAS talebinde 1 ana onay + 3 varis onayi esigi
**doldurmaz**, 4. varis onayi gerekir.

---

## Kilitlenme riskleri ve kapatilmalari

**Varis esigi talep aninda AYRICA dondurulur.** Devir, talep acildiktan sonra
da olabilir. Tek esik saklansaydi, ana dugumler talep asamasinda sustugunda o
talep sonsuza kadar onaylanamaz ve havuz kalici olarak erisilemez hale
gelirdi.

**Varis atanmamissa devir HIC acilmaz.** Yetkiyi bos bir kumeye devretmek,
korumaya calistigi seyi yok ederdi. `isFailoverActive()` ilk kontrolu budur.

**Esik ilk acildiginda devir aninda tetiklenmez.** `setLivenessTimeout` ve
`authorizeNode` sayaci simdiye ceker; aksi halde gecmisteki sifir degeri
yuzunden devir derhal baslardi. Iki test bunu ayri ayri dogruluyor.

**Bilincli sinir:** varis SONRADAN atanmissa, daha once acilmis talep
varislerce kapatilamaz (`NoHeirNodes`). Cozum yeni talep acmaktir — sessizce
bir esik uydurmaktan iyidir.

---

## Guvenlik katmaniyla iliski

Varis dugumler de teminat kuralina tabidir
([MK-0008](0008-guvenilmez-dugum.md)): kriz ani sorumsuzlugu mesrulastirmaz.
Devir halinde onay veren bir varis, tipki ana dugum gibi itiraz edilebilir ve
kesilebilir.

---

## Dagitim varsayilanlari

```
livenessTimeout = 7.200 blok (~1 gun)
varis dugum     = 0 (elle atanir)
```

Sessizlik esigi **uzun** olmali: kisa bir esik, gecici bir altyapi kesintisini
"ele gecirildi" sanip yetkiyi gereksiz yere devrederdi.

Varis dugumler dagitim betiginin **uydurmayacagi** bir seydir — hangi kurumun
varis oldugu kurumsal bir karardir. Atanmadigi surece mekanizma sessizce devre
disidir.

---

## Canli dogrulama (Sepolia)

```
--- Dead Man's Switch (rapor §2.6.1) ---
  sessizlik esigi : 7200 blok
  son yasam isareti: blok 11489415
  varis dugum      : 0
  devir aktif      : false
```

Duman testi devri **tetiklemez**: uretimde esik ~1 gundur ve bunu beklemek
anlamsizdir. Betigin dogruladigi sey, esigin gercekten yururlukte oldugu ve ana
dugum hayattayken devrin kapali kaldigidir. Devir davranisinin tamami 24 testle
zincir uzerinde dogrulanir.

---

## Henuz yok

- **DPSS / anahtar yeniden paylasimi** — yukarida aciklandi; anahtar bizde
  degil.
- **Varis kumesinin kendi kendine devir ilan etmesi.** Su an ele gecirme hali
  icin sahip karari gerekiyor. Varislerin kendi supermajority'siyle devri
  baslatabilmesi daha merkeziyetsiz olurdu; ancak bu, varislerin yetkiyi
  gasp edebilecegi ters bir saldiri yuzeyi acar ve ayri bir tasarim gerektirir.
- **Kurumsal HSM imzalari** — dugumler hala duz EOA.
