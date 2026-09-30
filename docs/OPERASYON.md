# Operasyon kılavuzu

Bu belge, README'den taşınan operatör ayrıntılarını içerir: Sepolia dağıtım
geçmişi, rol ayrımı, D/15 aşamalı operatör akışı ve kurulumla ilgili notlar.
Genel tanıtım ve hızlı başlangıç için [README](../README.md).

## Ödeme birimi

Sorgu ücretleri **Circle'ın Sepolia test USDC'si** ile ödenir — mainnet'teki
USDC ile aynı arayüz, aynı 6 ondalık, aynı `approve` + `transferFrom` yolu.
Mainnet'e çıkarken değişen tek şey `PAYMENT_TOKEN` değişkenidir; kod yolu
birebir aynı kalır.

Araştırmacı token'ı **kendisi** alır: <https://faucet.circle.com> (Sepolia
ağını seçin). Operatörün kimseye token basması gerekmez.

Depoda bir `StableTestToken` de var ama bu dağıtımda **kullanılmıyor**. Arzını
operatör kontrol ettiği için her yeni araştırmacı bir komut beklemek zorunda
kalırdı; ayrıca mainnet'ten farklı bir kurulum demek olurdu. `PAYMENT_TOKEN`
verilmediğinde `deploy.ts` ona düşer — yeni bir ağa çıkarken bu değişkeni
vermeyi unutmayın.

Bu dağıtımdaki **her anahtar proje ekibinde**: deployer, iki yetkili düğüm ve
kök yazan kurator cüzdanı. Bir önceki nonce-24 dağıtımında düğüm ve sahip
anahtarları erişilebilir degildi; `approveDisclosure` hem `isAuthorizedNode`
hem teminat sarti aradigi icin arastirmaci o dagitimda bir sorgunun sonucunu
hicbir zaman ALAMAZDI. O dagitimin islem kayitlari
[D15 operatör planında](D15-REDEPLOY.md) durmaya devam ediyor.

## Rol ayrımı

| rol | adres | yetkisi |
|---|---|---|
| deployer / sahip | `0xD37Df9f97E5e1D285a5B6143e2FB970fD9B108D4` | Protocol, Payments, Staking yonetimi |
| kurator | `0xdEE96eF2dd20bDC98b4673e1496f1824FE1Ca2E0` | **yalnizca** `VeriArfyRegistry.updateRoot` |
| yetkili dugum 1 | `0xCc49139712cc1816121607BF3993e7CaE0E67af8` | `approveDisclosure`, `heartbeat` |
| yetkili dugum 2 | `0xa3f313FcB16040F1D669afc8657c9e118D79B4C7` | `approveDisclosure`, `heartbeat` |

Registry sahipligi kasitli olarak deployer'da DEGIL. Kok yazimi kurator
servisinin otomatik yaptigi bir is oldugu icin anahtari barindirilan servise
girmek gerekiyor; o anahtarin ele gecmesi halinde kaybedilen tek sey akredite
agac kokudur, protokolun yonetimi degil.

## Yetkili düğüm servisi

Araştırmacı ücreti ödediğinde zincirde bir açılım talebi açılır, ama talep
**kendiliğinden onaylanmaz**: `approveDisclosure` yetkili ve teminatlı bir
düğümden gelmek zorundadır. Bu onay gelmeden sonuç üretilemez ve kullanıcının
yapabileceği bir şey yoktur.

`packages/node-operator` bu onayı veren servistir. Bekleyen talepleri tarar
(olay dinlemek yerine tarama: servis kapalıyken gelen talep olay akışında
kaybolur, tarama yeniden başlayınca onu da bulur) ve `src/policy.js`'deki
kurallara göre onaylar:

- talep açık mı (iptal/yürütülmüş/eşiğe ulaşmış değil)
- cüzdan yetkili düğüm mü, daha önce onaylamış mı
- teminatı yeterli mi — onayın ekonomik karşılığı budur
- kohort `minParticipants` eşiğini geçiyor mu

Kurallar ağ çağrılarından ayrı tutulur, doğrudan test edilir:
`npm run node-operator:test`.

**Ne kontrol etmez:** talebin bilimsel değerini. Üretimde bir kurum düğümü
"bu araştırma meşru mu" sorusunu sorar; bu servis soramaz ve sorduğunu iddia
etmez. Sabit panel ve yalnız-aggregate çıktı karar uzayını sözleşme düzeyinde
zaten daralttığı için testnette bu kabul edilebilir — üretimde değildir.

**Bağımsızlık uyarısı:** M-of-N eşiği düğümlerin bağımsız olmasını varsayar.
Bu servise birden fazla anahtar verilirse hepsi adına onay verir; o düğümler
pratikte tek bir taraftır ve eşik gerçek bir dağıtımı temsil etmez. Servis
bunu gizlemez, açılışta uyarır ve sağlık ucunda `independentNodes: false`
döner. Üretimde her düğüm ayrı kurumda, ayrı anahtarla, ayrı politikayla
çalışmalıdır.

**İtiraz süresi: 5 blok (~1 dakika).** Eşiğe ulaşılan talep ile yetkinin
verilmesi (`FHE.allow`) arasındaki penceredir. `FHE.allow` geri alınamadığı
için hatalı bir onayı itirazla durdurmanın tek anı budur
([MK-0008](mimari/0008-guvenilmez-dugum.md)).

Dağıtımda 20 blok (~4 dakika) kurulmuştu; testnette izleyen ve itiraz eden
kimse olmadığı için bu süre bir güvence sağlamıyor, yalnızca bekletiyordu.
5 blok, pencereyi ekranda görünür ve itiraz edilebilir tutuyor. **Sıfır
yapılmamalı** — mekanizma ortadan kalkar. Üretimde tersine uzun olmalı ki bir
kurum inceleyebilsin; üst sınır, itiraz + oylama süresinin (3600) teminat
çekme gecikmesini (7200) aşmamasıdır, aksi halde kötü onay veren düğüm itiraz
sonuçlanmadan teminatını çekebilir. Ayar ve bu sınırlar:
`packages/contracts/scripts/set-challenge-period.ts`.

**Teminat eşiği büyür — izlenmesi gerekir.** `minStake()` havuzun toplam
değeriyle birlikte yükselir (progresif teminat, rapor 2.7.1). Sabit bir
teminat bir süre sonra eşiğin altında kalır ve düğüm sessizce
`canApprove=false` olur. O anda servis çalışır, tarama başarılıdır,
`lastError` boştur — yani **dışarıdan sağlıklı görünür ama hiçbir talebi
onaylayamaz.** Bu bir kez yaşandı.

Sağlık ucu bu yüzden `canApproveAny` ve düğüm başına `readiness` döndürür:

```
canApproveAny: true
readiness: [{ authorized, canApprove, stake, requiredStake, gas, lowGas }]
```

`canApproveAny: false` görüldüğünde teminat yenilenmelidir:

```
NODE_WALLETS=... npx hardhat run scripts/bootstrap-nodes.ts --network sepolia
```

Betik hedefi eşiğin **4 katı** olarak alır; sadece eşiği karşılamak bir
sonraki sorguda yine yetersiz kalırdı.



## Bağımlılık kilidi notu

**`@pkgjs/parseargs` neden kök bağımlılıkta:** doğrudan kullanılmıyor;
`jackspeak` onu *isteğe bağlı* bağımlılık olarak bildiriyor ve npm bunu
sürümüne göre kilide yazıp yazmamayı değiştiriyor. Sonuç: aynı kilit dosyası
npm 9/10/11 ile **farklı ağaçlar** üretiyordu (1314 / 1327 / 1398 paket) ve
Vercel'de `npm ci` "Missing: @pkgjs/parseargs from lock file" ile düşüyordu.
Açıkça bildirilince üç sürüm de aynı ağacı kuruyor (1328). Kaldırmayın;
kaldırılırsa hata yerelde görünmeden yalnızca dağıtımda geri gelir.


## Dağıtım durumu ve operatör akışı

**2026-09-06 durum:** sabitlenmis proof anahtarlariyla nonce **24–41
redeploy** tamamlandi. On sekiz receipt `status=1` ile 11647006–11647040
bloklarinda kesinlesti; sinir nonce 42 ve gercek toplam fee
`0.020462928715141095 ETH`. Yeni deployment cifti plan hash
`0xd026de9debced25767b1d6d5b023aa2157318ede64204a3a27ee14da8d15a62c`
ile yayimlandi. Salt-okunur proof-check yeni provenance (13 signal) ve identity
(4 signal) verifier'larini `verified=true` ile dogruladi. Ayrintili tamamlama ve
kurtarma kaydi [nonce-24 redeploy operator planinda](D15-REDEPLOY.md).
Yeni staking kontratinda iki node da `0.001 ETH` stake ile `canApprove=true`.
Dort asamali live-check `QueryId=0`, `RequestId=0` icin 2/2 approval,
disclosure grant, query settlement ve claim ile tamamlandi. D/15 canli kabul
siniri kapandi; D/16 calismasi baslayabilir.

Deploy ciktisindaki `packages/contracts/deployments/sepolia.json` icindeki
`authorizedNodes` public topolojinin tek kaynagidir. `prepare` asamasi
`LIVE_CHECK_QUERY_TYPE` icin yalnizca `1` (GWAS), `2` (ML) veya `4`
(STATISTICS) kabul eder; zincirde `requiredApprovals(type) === 2` degilse
ilk mutation/proof oncesi fail-closed durur. Gercek Sepolia islemleri gas ve
onceden yatirilmis node stake'i gerektirir; deploy veya live-check otomatik
fonlama/stake yapmaz.

Onayli D/15 test profili `packages/contracts/ops/d15-sepolia.json` icinde
yalniz public adresleri tutar: deployer, node-1 ve node-2 farklidir; sorgu ML
(`2`), esik 2/2 ve `MIN_PARTICIPANTS=1` yalniz bu test deployment'i icindir.
Bu profil k-anonimlik kaniti degil, M-of-N authorization kanitidir.

Tum operator komutlari `scripts/d15-sepolia.ps1` uzerinden calistirilir.
Private key dosyaya veya komut satirina yazilmaz: PowerShell maskeli prompt ile
alir, yalniz ilgili child process'e aktarir ve `finally` icinde environment'tan
siler. Shared `.env` yuklenmez. State-changing asamalar hem `-Execute` hem de
elle yazilan asama-ozel onay cumlesi olmadan calismaz.

Once private key kullanmayan public readiness'i, sonra transaction gondermeyen
ve yine private key yuklemeyen deployer preflight'ini calistirin:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage readiness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage preflight
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage proof-check
```

`proof-check`, gercek FHE CLI baslatildiktan sonra sentetik koken ve kimlik
kanitlarini ayri Node sureclerinde, tek hesaplama is parcacigiyla uretir.
Her iki kaniti Sepolia'daki verifier kontratlarinda `eth_call` ile dogrular;
private key istemez, transaction gondermez ve `-Execute` kabul etmez.
`PROOF_CHECK_OK` iki dogrulamanin da tamamlandigini belirtir. Bu kontrol,
canli `prepare` veya sonraki asamalar icin operasyon onayi yerine gecmez.
Kaniti ureten alt surec ana surecin Node executable'ini kullanir; sistem Node
ve PATH ayarlarini degistirmez. Witness stdin uzerinden aktarilir, dosyaya veya
komut satirina yazilmaz; signer environment'i alt surece aktarilmaz.

Asagidaki komutlar dokumantasyon amaclidir ve Sepolia transaction'i
gonderebilir. Yalniz ayri operasyon onayindan sonra sirasiyla kullanilir.
Deployment komutu bilerek `--no-compile` kullanir; once ayri cihaz-yuku onayi
ile compile ve hedef testler yeniden gecmis olmalidir:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage deploy -Execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-1          # salt-okunur stake plani
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-1 -Execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage stake-node-2 -Execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage prepare -Execute

# Prepare ciktisindaki public id'leri iki operator de aynen kullanir.
$queryId = Read-Host "LIVE_CHECK_QUERY_ID"
$requestId = Read-Host "LIVE_CHECK_REQUEST_ID"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage node-1 -QueryId $queryId -RequestId $requestId -Execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage node-2 -QueryId $queryId -RequestId $requestId -Execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\d15-sepolia.ps1 -Stage complete -QueryId $queryId -RequestId $requestId -Execute
```

Node operatorleri kendi ayri shell/custody ortamlarinda yalniz kendi test-only
private key'lerini girer. Seed phrase, private key ve wallet parolasi hicbir
zaman repository'ye, sohbete veya ortak `.env` dosyasina konmaz.

Bu kanit yalniz M-of-N authorization ve iki ayri signer handoff'unu gosterir;
HSM, DKG veya gercek threshold decryption uygulandigi iddia edilmez.
