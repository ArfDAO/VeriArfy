# D/15 nonce-24 redeploy — yeni oturum handoff

Hazirlik tarihi: 2026-09-06. Bu belge canli islem onayi degildir.
Yeni oturumda `devam et` denildiginde once bu plan ve canonical FarukOS
`VeriArfy/D15-Redeploy-Handoff.md` okunur, sonra salt-okunur kontrol yapilir.
Bu hazirlik oturumunda Sepolia transaction'i gonderilmedi.

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

## Yeni oturum sirasi

Komutlar repository kokunden calistirilir. Her state-changing asama yeni
operasyon onayi gerektirir; `devam et` tek basina butun zincir islemlerinin
onayi sayilmaz. Deployer, node-1 ve node-2 icin ayri taze terminaller kullanilir.
Private key yalniz maskeli prompt'a yapistirilir; sohbete, komut satirina,
dosyaya, ortak `.env` veya plana yazilmaz. Islem sonunda signer environment'i temizlenir.

1. Private key olmadan Sepolia/review/nonce/reuse/bakiye kontrolu:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage redeploy
   ```

2. Kontrol gectikten ve kullanici o asamayi onayladiktan sonra yeni deployer terminali:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage redeploy -Execute
   ```

   Tam onay cumlesi: `REDEPLOY SEPOLIA D15 NONCE24`; wrapper `ACK=redeploy`
   uygular ve deployer key'ini maskeli ister. Nonce, payload, chainId, gas ve
   fee'ler sabittir. Her transaction iki confirmation bekler.

3. Sekiz runtime hash'i, topology, baslangic state'i ve iki yeni verifier'da
   gercek sentetik proof basarili olmadan deployment/web dosya cifti degistirilmez.
   Tamamlaninca yeni adreslere karsi gercek FHE CLI kontrolu:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage proof-check
   ```

4. Node-1 ve node-2 ayri taze terminallerde once kendi salt-okunur stake planini,
   sonra ayri onayla execute asamasini calistirir:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-1
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-1 -Execute
   # Baska terminal, yalniz node-2 key'i:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-2
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-2 -Execute
   ```

   Her node yeni staking kontratina **0.001 ETH + gas** yatirir. Eski stake
   otomatik tasinmaz. Eski kontratta `requestUnstake`, 7200 blok bekleme ve
   withdraw ayri yetkilendirilecek istege bagli bir akistir; redeploy buna dokunmaz.

5. [README'deki dort asamali akis](../README.md#4-sepolia-canli-kontrolu-d15-dort-asamali)
   izlenir: deployer `prepare`, node-1 `node-1`, node-2 `node-2`, deployer `complete`.
   Her asama ayri onay/key prompt'u kullanir. Prepare ciktisindaki public QueryId
   ve RequestId sonraki uc asamaya aynen aktarilir. D/15 tamamlanana kadar D/16 kapalidir.

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
Bu prova Sepolia deployment'i veya FHE live-check'in tamamlandigi anlamina gelmez.

Pin-specific testler CI'nin rastgele development ceremony'sinden ayridir:

```powershell
# packages/contracts dizininde; cihaz-yuku onayi ile, 512 MB heap siniri:
$env:D15_PINNED_ARTIFACT_TESTS = '1'
node --max-old-space-size=512 ..\..\node_modules\hardhat\internal\cli\cli.js test --no-compile test/D15Redeploy.test.ts test/D15RedeployJournal.test.ts test/D15RedeploySubmit.test.ts test/D15RedeployOutput.test.ts test/RedeployGate.test.ts
Remove-Item Env:D15_PINNED_ARTIFACT_TESTS
```
