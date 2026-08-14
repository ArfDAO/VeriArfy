# MK-0002 — fhEVM nesli: istemci ve zincir ayni kusakta olmak zorunda

**Durum:** Kabul edildi · 14 Agustos 2026
**Kilit:** `packages/contracts/scripts/live-check.ts` (gercek agda kosar)
**Ilgili rapor bolumleri:** §2.2, §6.2, WBS 3.1

---

## Karar

fhEVM yigini **tek bir kusak olarak** sabitlenir. Su an kullanilan kusak:

| Bilesen | Surum |
|---|---|
| `@fhevm/solidity` | 0.11.1 |
| `@fhevm/hardhat-plugin` | 0.4.2 |
| `@fhevm/mock-utils` | 0.4.2 |
| `@zama-fhe/relayer-sdk` | 0.4.1 (kontratlar **ve** web ayni surum) |

Bu dortlu birlikte yukseltilir. Birini tek basina oynatmak sessiz uyumsuzluk
uretir.

---

## Neden bu karar gerekli oldu

Proje `@fhevm/solidity@0.8.0` + `relayer-sdk@0.2.0` ile yazilmisti ve **21 test
mock ortaminda geciyordu.** Sepolia'ya ilk dagitim yapildiginda kontratlar
sorunsuz deploy oldu, `submitRecord` gercek agda calisti — ama sifreli girdi
adimi `"Relayer didn't response correctly. Bad JSON"` ile dustu.

Kok neden arastirildi:

1. `relayer.testnet.zama.cloud` icin DNS **NXDOMAIN** donuyordu — hem yerel
   cozucude hem 8.8.8.8'de. Ayni cozucu `zama.ai`'yi normal cozuyordu, yani
   sandbox kisiti degil: **alan adi gercekten yok.**
2. Yeni SDK'lar `relayer.testnet.zama.org` kullaniyordu (`.cloud` -> `.org`).
3. Asil mesele daha derindi: Zama **tum fhEVM yiginini Sepolia'da yeniden
   dagitmisti.**

| | Eski kusak (bizim kullandigimiz) | Yeni kusak (canli) |
|---|---|---|
| ACL | `0x687820221192C5B662b25367F70076A37bc79b6c` | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| Coprocessor | `0x848B0066793BcC60346Da1F49049357399B8D595` | `0x92C920834Ec8941d2C77D188936E1f7A6f49c127` |
| KMSVerifier | `0x1364cBBf2cDF5032C47d8226a6f6FBD2AFCDacAC` | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` |
| Relayer | `relayer.testnet.zama.cloud` (DNS yok) | `relayer.testnet.zama.org` |

Iki kusagin adreslerinde de hala **kod duruyor.** Yani zincire bakarak
"kontrat var, demek ki calisir" demek yaniltici; eski proxy'ler yerinde ama
arkalarindaki relayer kapatilmis.

---

## Neden testler bunu yakalayamadi

`@fhevm/hardhat-plugin`'in mock ortami sifrelemeyi, girdi kanitini ve ACL'i
**yerel olarak taklit eder**; gercek relayer'a ya da gercek coprocessor'a hic
gitmez. Bu yuzden 21 testin tamami, hizmetten kalkmis bir kusaga bagli bir
kontratta bile yesil kalir.

Bunun genel dersi su: **fhEVM'de mock testi "calisir" kaniti degildir.**
Zincir adresleri kutuphane surumune gomulu oldugu icin, surum uyumsuzlugu
derleme hatasi olarak degil, *gecerli gorunup calismayan bir dagitim* olarak
ortaya cikar.

---

## Nasil korunuyoruz

`scripts/live-check.ts` gercek agda su ikisini gonderir ve dogrular:

1. `submitRecord(bytes32)` — duz bir zincir yazimi,
2. `aggregateDosage(handle, proof)` — **Zama relayer'inin uretttigi** gercek
   sifreli girdi ve ZK kaniti.

Ikincisi ancak istemci SDK'si ile kontratin adresleri ayni kusaktaysa gecer.
Yani bu betik bir "duman testi" degil, kusak uyumunun kanitidir.

Dogrulanmis kosum (Sepolia, 14 Agustos 2026):

```
Kontrat  : 0xB57FEad8925E203672E0df858b1Fc22802ab82C2
handle   : 32 bayt   kanit: 100 bayt
katilimci: 0 -> 1
tx       : 0x9b73d655aba23893386be7a58ccbc3acbd441fc799168a9fb1da241dfb1589f2
```

---

## Kural

**Yeni bir aga dagitim yapildiginda `live-check` ZORUNLUDUR.** Deploy tek
basina bir sey kanitlamaz; kanit, gercek relayer'dan gelen sifreli girdinin
kontrat tarafindan kabul edilmesidir.

Zama yigini yeniden dagitirsa bu betik kirilir — ki istenen davranis budur.
Kirildiginda yapilacak: yukaridaki dort paket birlikte yukseltilir,
`ZamaEthereumConfig` adres tablosu kontrol edilir, kontratlar **yeniden
dagitilir** (eski dagitim kurtarilamaz; adresler kontrat baytkoduna gomulur).
