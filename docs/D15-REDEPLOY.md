# D/15 nonce-24 redeploy — tamamlama ve kurtarma kaydi

Hazirlik ve tamamlama tarihi: 2026-09-06. Nonce 24–41 redeploy Sepolia'da
tamamlandi; 18/18 receipt `status=1`, blok araligi 11647006–11647040 ve sinir
nonce 42. Toplam gas 17,807,903, gercek fee `0.020462928715141095 ETH`.
Output cifti SHA256
`659b605e133d663fb0da63cd1e00dbac60fa64eddb54063faa53d7c0be89c01a`
ile byte-identical yayimlandi. Son salt-okunur proof-check provenance icin 13,
identity icin 4 public signal uretti ve iki yeni verifier'da `verified=true`
sonucunu aldi; hicbir ek transaction gondermedi.

Iki node yeni `VeriarfyStaking` kontratina ayri signer'larla `0.001 ETH` stake
etti ve ikisi de `canApprove=true`. Dort asamali canli kabul `QueryId=0`,
`RequestId=0` icin tamamlandi: prepare 12/12, node approval 2/2 ve complete
3/3 receipt `status=1`. Final state `finalized=true`, `granted=true`,
`revoked=false`, query settled ve deployer claim tamam. D/15 canli kabul siniri
kapandi; D/16 calismasi baslayabilir.

## Sabit plan

- Eski deployed verifier'lar mevcut yerel zkey'lerle uyumsuz; eski zkey yedegi yok.
  Bu, wallet private key'lerinin kayip oldugu anlamina gelmez.
- Public kurtarma paketi: `packages/circuits/pinned/d15-proof-artifacts-v1.zip`.
  Boyut 11,904,760 byte; SHA256
  `4a4484657cb9d53908e0c5aa3dc49c46b8e4e099832c9a34df2a408d1ecdd794`.
  Dokuz public artifact icerir; wallet key veya witness icermez. Yeni ceremony yapilmaz.
- Pinler: `packages/circuits/artifacts.lock.json`; kontrol:
  `node --max-old-space-size=512 packages/circuits/scripts/check-artifacts.mjs`.
  Kurtarma gerekirse archive README'si izlenir; `circuits:build` ile yeni rastgele
  anahtar uretmek bu planin yerine gecmez.
- Review: `packages/contracts/ops/d15-redeploy-review.json`.
  Plan hash: `0xd026de9debced25767b1d6d5b023aa2157318ede64204a3a27ee14da8d15a62c`.
- Nonce 24–41: 18 islem, sekiz yeni kontrat; tamamlanma siniri 42.
  Uc library, test token ve storage reuse edilir. Eski deployment snapshot'i
  `packages/contracts/ops/d15-previous-deployment.json` dosyasinda korunur.
- Gas limit toplami 27,200,000; max fee 2 gwei, priority 0.1 gwei;
  deployer harcama ust siniri **0.0544 Sepolia ETH**. Bu bir maliyet tahmini
  degil imzalanacak payload'larin gas/fee tavanidir. Node stake/gas haric.
  Her execute oncesi mevcut bakiye, nonce ve base fee yeniden kontrol edilir.

## Tamamlanan canli akis

Tum state-changing D/15 asamalari tamamlandi. Asagidaki salt-okunur komutlar
audit/recovery icin korunur; redeploy, stake veya live-check execute asamalari
normal akista yeniden calistirilmaz. Private key sohbete, komut satirina,
dosyaya, ortak `.env` veya plana yazilmadi.

1. Redeploy normal akista yeniden execute edilmez. Gerektiginde private key
   olmadan plan, journal, final state ve output cifti salt-okunur dogrulanir:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage redeploy
   ```

2. Yeni adreslere karsi gercek FHE CLI ve verifier kontrolu salt-okunur olarak
   yeniden calistirilabilir:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage proof-check
   ```

3. Node stake tamamlama kaydi:

   - Node-1: `0x30cae82b7f1cf938c8e136e7890e61af00f8e249b194e4682662098922322d40`,
     blok 11647092, `status=1`.
   - Node-2: `0x6f0cf12b2a7c04296f3d67ce1dc61663cbca9c640631ec13c233c577c80a00cf`,
     blok 11647104, `status=1`.
   - Eski stake otomatik tasinmadi. Eski kontratta `requestUnstake`, 7200 blok
     bekleme ve withdraw ayri yetkilendirilecek istege bagli bir akistir.

4. [README'deki dort asamali akis](../README.md#4-sepolia-canli-kontrolu-d15-dort-asamali)
   tamamlandi:

   - Prepare: nonce 42–53, blok 11647119–11647137, 12/12 `status=1`;
     ilk tx `0xcc4a965a4b72f0a985df45a975a42fea1f68698226268f5cadb72eabd1aa9650`,
     son/openQuery tx `0xb6cd37111f47556e9499c3555321b4ee3959d449a428a3fb431ec94ed45dded3`.
   - Node-1 approval: `0xb04707f8c65034167b3cc1c08944e10efb109aa680b6cb429e60dc561b8a3603`,
     blok 11647160, `status=1`.
   - Node-2 approval: `0x483bd8d49e06e0fd55d03edc46aa00ebf3c5567b73dde014de053bbd0f7e9848`,
     blok 11647173, `status=1`; challenge penceresi 11647193'te kapandi.
   - Complete: nonce 54–56, 3/3 `status=1`; execute
     `0x1fc2addd72768c566ead3410e10bd99cfa61892f14d29cc84f50d920ce7e3268`,
     settle `0xc85c80a703338a9a30b1d634bfb74cac60ceb58bff7f91b4b3926cfa65e8c507`,
     claim `0xb6ac8afd9d91d3aa27b00be02c1109dbf63014235358932e6ae9b4a81835198e`.

## Kesinti ve tekrar calistirma

Journal: `packages/contracts/ops/d15-redeploy-journal.json`. Yalniz plan hash'i
ve sirali nonce/transaction hash'leri tutar; raw imza/private key tutmaz. Hash,
broadcast'tan **once** fsync + atomic rename ile yazilir. Yeniden baslatma ayni
sabit transaction'i imzalar; bilinen pending hash'i tekrar gondermeden bekler.
Tuketilmis nonce icin ayni payload ve basarili receipt yoksa ilerlemez.

Ayni anda ikinci execute `.json.lock` ile engellenir. Kesinti sonrasi once
salt-okunur kontrol; kalan `.lock` veya `.tmp` dosyasini otomatik silme.
PID/process durumu, journal ve RPC hash/receipt'i okunarak neden anlasildiktan
sonra yalniz o dosya icin kontrollu kurtarma yapilir. Journal'i silmek,
nonce atlamak, fee/payload degistirmek veya legacy `deploy`/`resume` calistirmak yasaktir.

Iki output dosyasi tek filesystem transaction'i degildir: yakalanan hatalarda
rollback vardir; ani process/power kaybinda `.resume-*.bak/.tmp` kalabilir.
Eslesmeyen/eksik output cifti fail-closed durur; snapshot, journal ve receipt
dogrulanmadan dosyalar elle tamamlanmaz. Yeni adresler yayimlandiktan ve node
stake/live-check basladiktan sonra redeploy baslangic-state kontrolunun yeniden
gecmesi beklenmez; sonraki stage komutlari kullanilir.

## Yerel kabul

Compile ve frozen pin/export kontrolu gecti. Disposable Hardhat simülasyonunda
18/18 exact payload, sekiz runtime, final topology/state ve iki verifier'in
gercek proof kabul/degistirilmis-signal ret testleri gecti. Olculen gas 17,702,647.
Bu yerel prova tek basina canli kabul sayilmaz; Sepolia canli kabul sonucu
yukaridaki on-chain receipt ve final-state kaydiyla ayrica dogrulandi.

Pin-specific testler CI'nin rastgele development ceremony'sinden ayridir:

```powershell
# packages/contracts dizininde; cihaz-yuku onayi ile, 512 MB heap siniri:
$env:D15_PINNED_ARTIFACT_TESTS = '1'
node --max-old-space-size=512 ..\..\node_modules\hardhat\internal\cli\cli.js test --no-compile test/D15Redeploy.test.ts test/D15RedeployJournal.test.ts test/D15RedeploySubmit.test.ts test/D15RedeployOutput.test.ts test/RedeployGate.test.ts
Remove-Item Env:D15_PINNED_ARTIFACT_TESTS
```
