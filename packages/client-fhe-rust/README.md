# @veriarfy/client-fhe-rust

Faz 1'in ([`client-side-rust`](../client-side-rust)) urettigi `0 | 1 | 2` dozaj
vektorunu, **tarayicida uretilen** bir `ClientKey` ile `FheUint8` olarak
sifreleyip tek bir bayt blobuna serilestirir. Gizli anahtar cihazi terk etmez.

## Kritik iki Cargo ayari

`tfhe`'yi wasm'da calistirmak icin iki sey zorunlu — ikisi de sessizce degil,
gurultulu sekilde kirilir:

| Ayar | Yapilmazsa |
| --- | --- |
| `default-features = false` | Varsayilan feature `avx512`'dir, x86'ya ozgudur; wasm32 derlemesi kirilir. |
| `integer-client-js-wasm-api` | tfhe'nin wasm entropi kaynagi (`WasmSeeder`) yalnizca bunun actigi `__wasm_api` bayragi altinda derlenir. Onsuz `new_seeder()` tarayicida *"No compatible seeder found"* ile panikler — **anahtar uretilemez**. |

`shortint-js-wasm-api` + `boolean-js-wasm-api` calisma zamaninda kullanilmiyor;
tfhe'nin hazir JS API'lerini de paketliyorlar. Olculdu: ucu birlikte **1,6 MB**
wasm, yalnizca `integer-client-js-wasm-api` ile **1,4 MB**.

## Boyut gercegi — once bunu okuyun

Olculen degerler (hem native hem tarayici, ayni sonuc):

| | Duz `FheUint8` | Tohumlanmis (seeded) |
| --- | --- | --- |
| tek dozaj | **64,3 KB** | **0,5 KB** |
| 1.000 varyant | 62,8 MB | 0,49 MB |
| 5.000.000 varyant (WGS) | ~314 GB | ~2,4 GB |

Yani **tum genomu sifrelemek pratik degil**. Faz 1 ciktisindan calismanin
ilgilendigi bir varyant paneli secilmeli. Varsayilan yol `encryptDosagesSeeded`
olmali: ayni gizlilik, **128 kat** kucuk blob.

Anahtarlar: `ClientKey` 30,5 KB (kullanicida kalir), `CompressedServerKey`
57 MB (hesaplayan duguma bir kez gonderilir, sifre **cozemez**).

## Performans (Chromium, M-serisi Mac)

| Islem | Sure |
| --- | --- |
| anahtar uretimi | ~4,1 sn |
| sifreleme | 0,97 ms / varyant |
| cozme | ~0,95 ms / varyant |

Anahtar uretimi senkron ve saniyeler suruyor; wasm heap'i ~289 MB'a cikiyor.
**Mutlaka bir Web Worker icinde** cagirin — main thread'de arayuz kilitlenir.

## Panel secimi

Tum vektoru sifrelemek yerine calismanin ilgilendigi SNP'ler secilir:

```ts
selectPanel(dosages, indices): Uint8Array          // sifrelemeden onizleme
client.encryptPanelSeeded(dosages, indices)        // uretim yolu
blobInfo(blob)                                     // cozmeden basligi oku
```

Verilen **sira korunur** — ciktinin i. elemani `indices[i]`'in dozajidir, cunku
FHE devresi panelin sirasina gore yazilir. Iki durum sessizce gecmez:

- **sinir disi indeks** — kullanici baska referans surumuyle uretilmis VCF
  yuklemis olabilir; eksik eleman atlanirsa sonraki her sey kayar;
- **tekrarlanan indeks** — homomorfik toplamda ayni varyanti iki kez sayar.

Hatali panelde hicbir sey sifrelenmeden hata doner.

Panel indeksleri blobun icinde tasinir. Panel calismanin herkese acik tanimi
oldugu icin (tum katilimcilarda ayni) bu hicbir sey sizdirmaz; buna karsilik
alici taraf "blobun 7. elemani hangi SNP?" sorusunu ayri dosyaya bakmadan
yanitlar.

## API

```ts
FheClient.generate(): FheClient                    // yeni gizli anahtar
FheClient.fromSecretKey(bytes): FheClient          // kayitli anahtari geri yukle

client.encryptPanelSeeded(u8, u32): Uint8Array     // ONERILEN yol
client.encryptDosagesSeeded(u8): Uint8Array        // panelsiz, tum vektor
client.encryptPanel / encryptDosages               // sikistirilmamis karsiliklari
client.decryptDosages(blob): Uint8Array            // gonderim oncesi dogrulama
client.exportSecretKey(): Uint8Array               // ASLA aga gondermeyin
client.exportServerKey(): Uint8Array               // hesaplayan duguma gider
client.ciphertextSizeBytes(seeded): number         // arayuzde boyut uyarisi icin

selectPanel(u8, u32): Uint8Array                   // anahtarsiz onizleme
blobInfo(blob): BlobInfo                           // { version, count, panel, sizeBytes }
```

Blob, surum + eleman sayisi + panel basligi tasiyan `bincode` cercevesidir.
Baslik `deserialize_from` ile sifreli metinlere dokunmadan okunur, boylece
uyumsuz bir blob islenmeye baslamadan reddedilir.

## React tarafi

- [`fheWorker.ts`](../web/src/lib/fheWorker.ts) — `FheClient` yalnizca burada
  yasar; gizli anahtar kendiliginden hicbir yere yazilmaz.
- [`useFheEncryptor.ts`](../web/src/lib/useFheEncryptor.ts) — istek/yanit
  eslestirmeli temiz hook.

```tsx
const fhe = useFheEncryptor();
const key = await fhe.generateKey();                        // ~4 sn, worker'da
const enc = await fhe.encrypt(dosages, { panel: PANEL });   // enc.blob -> IPFS
```

Ucdan uca kanit: [`packages/web/dev/fhe-harness.html`](../web/dev/fhe-harness.html)
gercek hook'lari ve worker'lari kullanarak VCF → dozaj → panel → sifreleme →
cozum zincirini kosar ve keygen sirasinda ana thread'in canli kaldigini olcer.

## Derleme, test, kanit

```bash
npm run fhe:build                                  # wasm-pack -> pkg/
npm run fhe:test                                   # 16 native test
npm run demo --workspace packages/client-fhe-rust  # tarayici kanit sayfasi
```

[`examples/browser-demo.html`](examples/browser-demo.html) iki wasm paketini de
yukleyip VCF → dozaj → sifreleme → cozum zincirini ucdan uca dogrular.

## Bilinmesi gereken sinir

Buradaki `ClientKey`, **fhEVM'den ayridir**. `packages/web/src/lib/fhe.ts`
Zama relayer SDK'siyla agin acik anahtarini kullanir ve ciktisi `AnxietyStudy`
kontratinda islenebilir. Bu modulun urettigi blob ise **zincir disi** FHE
hesaplamasi icindir; akilli kontrat onu isleyemez. Ikisini karistirmayin.
