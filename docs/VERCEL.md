# Vercel yayini

VeriArfy arayuzu Vercel'de statik olarak yayinlanir. Vercel proje ayarlarinda
Root Directory repository kokunde birakilir. `vercel.json` su akisla derleme
yapar:

1. `npm ci` ile lock dosyasina birebir bagimlilik kurulur.
2. `scripts/vercel-build.mjs`, Rust `1.98.1` ve `wasm-pack 0.13.1` kurup
   `wasm32-unknown-unknown` hedefini ekler.
3. Iki Rust istemci paketi `pkg/` altinda temiz ortamda uretilir; ardindan
   `npm run web:build` calisir. `pkg/` ciktilari uretilmis oldugu icin Git'e
   alinmaz.

Vercel Project Settings > Environment Variables altinda Preview ve Production
icin su degiskenleri tanimlayin:

| Degisken | Deger |
| --- | --- |
| `VITE_API_BASE` | Canli ML/anket FastAPI servisinin HTTPS taban URL'si |
| `VITE_CURATOR_URL` | Merkle agaci ve researcher kayitlarini sunan curator URL'si |

Bu degiskenler verilmezse arayuz gelistirme varsayilanlari olan
`http://localhost:8000` ve `http://localhost:8787` adreslerine duser; canli
deployment bu nedenle kullanilabilir olmaz.

`/circuits/*` ve `/fhe/*` dosyalari hash'li dosya adlari degildir. Vercel
ayarindaki `max-age=0, must-revalidate` her istekte dogrulanabilir cache
semantigi saglar; eski ZK veya FHE dosyasi immutable bir yil boyunca tutulmaz.

Curator kokunun zincire yazilmasi ve curator storage'in kalici tutulmasi bu
statik deployment'in disindadir. Kok kaydi manuel olarak yetkili operasyonla
ayri, yetkili bir on-chain islem olarak yapilmali; Render/Railway gibi ortamlarda disk ephemeral olabilecegi icin
kalici bir volume veya harici persistent storage ayarlanmalidir. Merge ve
Vercel build zincire islem gondermez; yeni arastirmaci kok onayi ayri yetkili
bir islem gerektirir.
