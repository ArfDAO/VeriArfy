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
| VeriarfyProtocol | `0x623351c69c6c5365C98A8D064721D4EF7AF0B0a4` |
| VeriarfyPayments | `0xa30bFCb288A9B81f46FD2d16c81c22D7852d74dA` |
| VeriarfyBiomarkers | `0x20674472d2B32398C5bF656f23373099311d27a1` |
| DataProvenanceVerifier | `0x0513373dd7CB26c20c22b0ED2cD01D49408B0e7F` |
| VeriArfyRegistry | `0xAf206523D4C4fC8EE47919C198Fc35Ce5ddd6ED6` |
| VeriarfyStaking | `0x5033950d0aB4148f3F6101AE1E6cac6d5cBD2C67` |
| VeriarfyStorage | `0xa3f793c5B231d8148d77e80d8412D78bFC7014eC` |

Tamamlanmış bir döngü örneği:

```
submitRecord       0x05b6b6d3db23f0101ef16557f014106d868fae2c7f5ea3feab34dc0076448483
executeDisclosure  0xc8a0c469f452ea271cb11020ba6f420d802925942b948fa0143205349fc76f7a
settleQuery        0xadb087bd454f6695e50e791ad5e68fac64f9709fb0fc54b54d1efa2617b96c77
```

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
