# VeriArfy

**Şifreli genomik veri pazarı.** Veri sahibi verisini cihazında şifreler ve
havuza katılır; araştırmacı yalnızca ihtiyaç duyduğu alanları satın alır;
ödeme, verinin *kullanıldığı kadar* ve *ne kadar nadir olduğu kadar* dağıtılır.

Hiçbir noktada bireysel kayıt açılmaz. Zincir üstündeki her işlem şifreli
değerler üzerinde çalışır.

| | |
|---|---|
| **Canlı demo** | https://veri-arfy.vercel.app |
| **Ağ** | Sepolia |
| **Şifreleme** | Zama fhEVM (TFHE) |
| **Kanıt** | Groth16 · circom |

---

## Çözülen sorun

Bir GWAS çalışması binlerce katılımcının genotipine ihtiyaç duyar; bu kohortu
toplamak çalışmanın en pahalı ve en yavaş kısmıdır. Aynı veri bir kez satılır,
defalarca kullanılır ve verinin geldiği kişiye hiçbir şey dönmez.

Veriyi paylaşmak mahremiyeti kaybetmek anlamına geldiği sürece, paylaşmak
isteyen kişi için makul bir seçenek yok. VeriArfy bu iki tarafı, veriyi hiç
açmadan buluşturur.

---

## Nasıl çalışır

### Veri sahibi

1. Ham tüketici dosyasını (23andMe, AncestryDNA) veya biyobelirteç ölçümlerini
   yükler. **Dosya tarayıcıdan çıkmaz** — ayrıştırma yerelde yapılır.
2. Sistem, çalışmanın panelindeki hangi alanların dosyada *gerçekten* bulunduğunu
   çıkarır. Kullanıcıya sorulmaz: sıradan bir kişi dosyasının içinde hangi
   varyantların olduğunu bilmez, dosyanın **türünü** bilir.
3. Her değer istemcide şifrelenir; tarayıcıda bir **ZK köken kanıtı** üretilir.
4. Şifreli değerler zincirde homomorfik olarak toplanır.

### Araştırmacı

1. ZK kimlik kanıtıyla araştırmacı defterine kaydolur — defter akredite
   olduğunu bilir, kim olduğunu bilmez.
2. Çalışması için gereken **alanları tek tek seçer**. Her alanın yanında o
   alana kaç kişinin veri verdiği ve kıtlık çarpanı görünür; fiyat seçim
   değiştikçe anlık güncellenir.
3. Ücret emanete alınır. **Ödeme tek başına hiçbir şeyi çözmez.**
4. Bağımsız düğümlerin eşikli onayı, ardından itiraz penceresi. Ancak bundan
   sonra açılım yetkisi verilir.
5. Dönen şey bir **grup istatistiğidir** — genomikte ki-kare + BH-FDR,
   biyobelirteçlerde Welch t + Cohen d. Bireysel kayıt asla dönmez.

---

## Ödeme modeli

Ücret **kayıt başınadır**: bir kayıt = bir kişi × bir alan.

```
ücret = taban + Σ  kayıt(alan) × kayıtFiyatı × kıtlık(alan)
             alan ∈ istenen

kıtlık(alan) = havuz / o alanı verenler        [1x .. tavan, varsayılan 10x]
```

Araştırmacı iki alan isterse ve bunlara 40 ile 12 kişi veri vermişse, satın
aldığı şey **52 kayıttır** — havuzun tamamı değil. İstediği alanda verisi
olmayan kişi için ödeme yapılmaz.

**Kıtlık iki yerde birden çalışır.** Aynı çarpan hem araştırmacının fiyatını
hem veri sahibinin payını belirler:

```
pay(kişi) = usagePot ×   Σ kıtlık(alan)      /   Σ kayıt(alan) × kıtlık(alan)
                    kişinin verdiği alanlar      istenen alanlar
```

Payda, ücretin alan bileşeniyle birebir aynı formüldür. Ödenen ile hak edilen
tek bir sayıdan türer.

| alan | kaç kişide | toplam | kişi başı |
|---|---|---|---|
| yaygın varyant | 1000 | 50 birim | 1x |
| seyrek kohort | 100 | 50 birim | **10x** |

Çarpan zincirdeki kapsama sayaçlarından **türetilir**; kimse elle değer atamaz.
"Hangi veri değerli" kararı sahibin insafına bırakılsaydı, fiyat piyasanın
değil sahibin kararı olurdu.

---

## Mimari

```
packages/
  contracts/          fhEVM sözleşmeleri (Solidity)
  circuits/           circom devreleri + Groth16 kurulumu
  client-side-rust/   VCF ayrıştırıcı (Rust → wasm)
  client-fhe-rust/    istemci tarafı FHE şifreleyici (Rust → wasm)
  web/                arayüz (React + Vite)
  curator/            akredite katılımcı Merkle ağacı
  ml/                 Concrete ML köprüsü (araştırma)
  study/              istatistik motoru (ki-kare, Welch t, BH-FDR)
```

### Üç katman, üç ayrı soru

| katman | soru | çözüm |
|---|---|---|
| **FHE** | Veri açılmadan nasıl hesaplanır? | Zama fhEVM; kontenjans tabloları ve Welch yeterli istatistikleri şifreli birikir |
| **ZK** | Veriniz olduğunu nasıl kanıtlarsınız? | Kapsama bitleri devrede taahhütten türetilir; uydurulamaz |
| **KMS** | Sonuca kim erişebilir? | Eşikli onay + itiraz penceresi |

### Neden kapsama ZK'dan geliyor

Ödeme kullanılan alana göre dağıtılıyor. Kapsama istemciden gelseydi
uydurulabilirdi: *"bende bu alan var"* deyip boş göndermek, veri vermeden pay
almak demekti. İstatistiği bozmaz (şifreli değer karar verir) ama **parayı**
bozardı.

Devre kapsama bitlerini taahhüde giren dozajlardan türetir ve açık çıktı olarak
verir. Sözleşme ayrıca kaydı olan bir katılımcının beyanının kanıtın **alt
kümesi** olmasını şart koşar (`CoverageNotProven`) — aksi halde saldırgan önce
dar bir kanıt gönderip sonra maskeyle genişletirdi.

---

## Dağıtım (Sepolia)

| sözleşme | adres |
|---|---|
| VeriarfyProtocol | `0x273FF690e1070e9F18ebef4823c2bC73D3E40AAE` |
| VeriarfyPayments | `0xFA42A0aF6D5426289499F5B6FA2fA571c18E30C8` |
| VeriarfyBiomarkers | `0x02FB666Fd374A6585Ae635b8C0eE5C347E50fA6a` |
| DataProvenanceVerifier | `0x853Fa62357Be96f6463f5b6927436371C35E85C3` |
| VeriArfyRegistry | `0xcd1FeaCe584d95f20A3695586aD59411C4Cda267` |
| VeriarfyStaking | `0x5d06da5Bc53D69547c562cc6194f296Ab3aFf44A` |
| VeriarfyStorage | `0x03504F85c474aafF7718A85fcCa15A13A6BB64ed` |
| Groth16Verifier | `0x0CCC953CA14a1842E4f13454304D8359d398A24d` |
| AnxietyStudy | `0xb7BBD086713C229c41729621F185Efb239F68C03` |
| PaymentToken (Circle test USDC) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

Blok `11807543` itibarıyla geçerli (2026-09-29).
Eşik 2/2, `MIN_PARTICIPANTS = 10`.

### Ödeme birimi

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
[D15 operatör planında](docs/D15-REDEPLOY.md) durmaya devam ediyor.

### Rol ayrimi

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

### Yetkili düğüm servisi

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


---

## Kurulum

Gereken: Node 20+, Rust (wasm hedefiyle), Python 3.11 (yalnızca ML köprüsü için).

```bash
npm install

# Devreleri kur (circom indirilir, tören çalışır)
npm run circuits:build

# Rust → wasm
npm run wasm:build
npm run fhe:build

# Sözleşmeler
npm run contracts:compile
npm run contracts:test
```

### Çalıştırma

```bash
npm run curator      # Merkle ağacı servisi (localhost:8787)
npm run web:dev      # arayüz (localhost:5173)
```

Araştırmacı kaydından sonra ağaç kökü zincire yazılmalıdır:

```bash
npm run curator:push-root
```

> Bu adım bilerek elle çalıştırılır. Zincire yazan tek işlem odur; barındırılan
> bir servise vermek özel anahtarı oraya koymak demekti.

### Ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın:

| değişken | ne için |
|---|---|
| `SEPOLIA_RPC_URL` | zincir erişimi |
| `DEPLOYER_PRIVATE_KEY` | dağıtım ve kurator kökü |
| `PINATA_JWT` | IPFS yüklemesi |
| `VITE_CURATOR_URL` | arayüzün kurator adresi |

---

## Dağıtım durumu ve operatör akışı

**2026-09-06 durum:** sabitlenmis proof anahtarlariyla nonce **24–41
redeploy** tamamlandi. On sekiz receipt `status=1` ile 11647006–11647040
bloklarinda kesinlesti; sinir nonce 42 ve gercek toplam fee
`0.020462928715141095 ETH`. Yeni deployment cifti plan hash
`0xd026de9debced25767b1d6d5b023aa2157318ede64204a3a27ee14da8d15a62c`
ile yayimlandi. Salt-okunur proof-check yeni provenance (13 signal) ve identity
(4 signal) verifier'larini `verified=true` ile dogruladi. Ayrintili tamamlama ve
kurtarma kaydi [nonce-24 redeploy operator planinda](docs/D15-REDEPLOY.md).
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

### 5. Kurator servisi

```bash
npm run curator              # http://localhost:8787
npm run curator:push-root    # ağacın kökünü zincire yazar
```

### 6. Arayüz

```bash
npm run web:dev
```

`http://localhost:5173/?preview=survey` ile anketi cüzdan/zincir olmadan
tasarım önizlemesinde görebilirsiniz.

---

## Test

```bash
npm run contracts:test                      # sözleşmeler (fhEVM mock)
npm run test --workspace packages/circuits  # devre: kanıt + reddetme senaryoları
npm run test --workspace packages/web       # arayüz
npm run study:test                          # istatistik motoru
```

Devre testlerinin çoğu **olumsuzdur**: değiştirilmiş panel, akredite olmayan
kurum, biçim dışı dozaj, nullifier atlatma denemesi. Bir devrenin değeri neyi
kabul ettiğinde değil, **neyi reddettiğindedir**.

Gerçek ağda uçtan uca doğrulama:

```bash
npm run chain:live-check
```

---

## Dürüst sınırlar

Bunları bulunmasındansa yazmayı tercih ediyoruz.

**Verinin gerçekliği kanıtlanmıyor.** ZK kanıtı, kapsamanın taahhütle tutarlı
olduğunu gösterir. Verinin gerçek bir ölçümden geldiğini **göstermez** — bunu
ancak paneli imzalayan akredite bir kurum söyleyebilir. Devre iki katmanı da
destekliyor (`attested` bayrağı) ve hangi katmanın kullanıldığını
`recordAttested` içinde saklıyor, ama kurum entegrasyonu henüz yok. Geliştirme
anahtarı depoda açık olduğu için imzalı katman şu an kullanılmıyor.

**Tören tek katılımcılı.** Üretilen zkey bir "development ceremony" çıktısıdır.
Ana ağ için çok taraflı bir tören şarttır.

**Havuzdan çıkmak geçmişi silmez.** Ayrılmak gelecekteki sorgulardan pay almayı
durdurur; homomorfik toplamlara karışmış veri geri çekilemez.

**Zaman serisi indirgemesi zincirde doğrulanmıyor.** Biyobelirteç kanalında ham
ölçüm dizisi tarayıcıda özetleniyor (`n`, `Σx`, `Σx²`); sözleşme bu özetin doğru
hesaplandığını doğrulamıyor.

**Test ağı ölçeği.** Doğrulamalar küçük bir Sepolia havuzunda yapıldı, popülasyon
ölçeğinde değil.

---

## Mimari kararlar

Her önemli karar, gerekçesi ve ölçümüyle birlikte `docs/mimari/` altında:

| | |
|---|---|
| [MK-0003](docs/mimari/0003-veri-kokeni-eddsa.md) | Neden RSA değil EdDSA (~1,5M kısıt → birkaç bin) |
| [MK-0011](docs/mimari/0011-panel-tavani.md) | HCU tavanı ve parti boyutu ölçümü |
| [MK-0013](docs/mimari/0013-panel-hizalama.md) | Eksik genotip işareti ve panel hizalama |
| [MK-0016](docs/mimari/0016-kapsama-ve-kullanima-gore-odeme.md) | Kapsama bitmap'i ve kullanıma göre ödeme |
| [MK-0017](docs/mimari/0017-kanitli-kapsama.md) | Kapsamanın ZK devresine taşınması |
| [MK-0018](docs/mimari/0018-kayit-basina-ve-kitliga-gore-fiyat.md) | Kayıt başına + kıtlığa göre fiyatlandırma |

---

## Lisans

BSD-3-Clause-Clear
