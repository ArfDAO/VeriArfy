# @veriarfy/client-side-rust

Tarayicida calisan **VCF (Variant Call Format) stream parser**. Kullanicinin ham
genom dosyasi cihazi hic terk etmeden, FHE'ye verilmeye hazir bir `0 | 1 | 2`
dozaj vektorune cevrilir.

## Neden stream?

1-5 GB'lik bir VCF'i `file.text()` ile okumak tarayiciyi cokertir (JS string'leri
UTF-16'dir; 5 GB dosya ~10 GB RAM demektir). Bu modul dosyayi **chunk chunk**
okur:

```
tepe bellek = chunk boyutu (~64 KB) + en uzun satir + dozaj vektoru (varyant basina 1 bayt)
```

Insan genomu WGS VCF'i tipik olarak ~5M varyant icerir → cikti ~5 MB.

## Dozaj eslemesi

| GT              | Anlam                | Cikti |
| --------------- | -------------------- | ----- |
| `0/0`, `0\|0`   | Referans ile ayni    | `0`   |
| `0/1`, `1/0`    | Heterozigot mutasyon | `1`   |
| `1/1`, `1\|1`   | Homozigot mutasyon   | `2`   |
| `1/2` (cok-alelli) | 2 alt alel        | `2`   |
| `1` (haploid, chrX/Y) | 1 alt alel      | `1`   |
| `./.`           | Cagrilamamis         | `0` + `missingGenotypeCount` sayaci |

Kural: **referans olmayan alel sayisi**, `2` ile sinirlanmis. Eksik genotipler
atlanmaz, `0` olarak yazilir — boylece cikti vektoru referans varyant listesiyle
pozisyonel olarak hizali kalir (FHE devresi sabit uzunluk bekler).

## Derleme

```bash
cargo install wasm-pack
npm run wasm:build          # -> packages/client-side-rust/pkg/
```

Testler wasm gerektirmez, native calisir:

```bash
npm run wasm:test
```

Gercek tarayicida kanit sayfasi (`pkg/` derlendikten sonra):

```bash
npm run demo --workspace packages/client-side-rust
```

[`examples/browser-demo.html`](examples/browser-demo.html) yayinlanan wasm'i bir
Web Worker icinde bundler olmadan yukler; eslesme kurallarini, chunk sinirlarini
ve hata yollarini dogrular, ardindan 400 MB'lik sentetik bir VCF'i akitarak
sure/hiz/wasm-heap olcer.

## API

```ts
// Yuksek seviye: File/Blob'u bastan sona akitarak ayristirir.
parseBlob(blob, sampleName?, onProgress?): Promise<VcfParseResult>

// ReadableStream (or. DecompressionStream ciktisi) icin.
parseReadableStream(stream, sampleName?, totalBytes?, onProgress?): Promise<VcfParseResult>

// Dusuk seviye: chunk'lari JS tarafindan siz beslemek isterseniz.
new VcfStreamParser(sampleName?) -> .pushChunk(Uint8Array) -> .finish(): VcfParseResult
```

`VcfParseResult`: `dosages: Uint8Array`, `sampleName`, `sampleNames`,
`variantCount`, `missingGenotypeCount`, `skippedLineCount`, `bytesProcessed`.

Web tarafinda kullanim: [`useVcfParser`](../web/src/lib/useVcfParser.ts) hook'u
ve [`vcfWorker`](../web/src/lib/vcfWorker.ts).

## Sinirlar

- `.vcf.gz` dosyalari worker'da `DecompressionStream("gzip")` ile acilir. Cok-uyeli
  **BGZF** bloklarinda tarayici implementasyonlari farklilik gosterebilir; kritik
  is akislarinda duz `.vcf` tercih edin.
- Sadece-site (sample kolonu olmayan) VCF'ler reddedilir — genotip cikarilamaz.
