# MK-0020 — Geçiş planı: fark kuralı ve 10 düğüm

**Durum:** Planlandı · 1 Ekim 2026
**Kod:** `packages/node-operator/src/server.js`, `packages/node-operator/src/policy.js`,
`packages/contracts/scripts/add-nodes.ts`

Test aşamasında iki koruma **hazır ama etkin değil**. Bu belge neyin, ne zaman
ve nasıl açılacağını kaydeder.

---

## 1. Fark saldırısı kuralı — havuz 100 kişiye ulaşınca

**Kural:** Aynı alan için iki sorgunun kişi sayıları arasındaki fark 0 ile
k (= `minParticipants`, 10) arasındaysa yeni sorgu onaylanmaz. İki sonucun
farkı, aradaki az sayıda kişinin verisini doğrudan verir.

**Neden şimdi kapalı:** Havuz 10–20 kişi. Bu boyutta yeni katılan her 1–9
kişi, aynı alanlardaki her yeni sorguyu reddettiriyor; akış denenemiyor.
İlk ölçüm: 9 kişide açılan talep 0 ile 11 kişide açılan talep 8 arasındaki
2 kişilik fark talep 8'i reddettirdi.

**Etkinleşme:** Talebin açıldığı andaki havuz `DIFFERENCING_MIN_POOL`
kişiye (varsayılan **100**) ulaştığında kural kendiliğinden uygulanır.
Kod değişikliği gerekmez. Kural ve testleri (`policy.test.js`) hazır.

**Bilinen sınır:** Kural açıldığında, havuz 100'ün altındayken açılmış
sorgular da karşılaştırmaya girer (geçmiş sayımlar arşiv RPC'den okunur).
100. kişiden sonraki ilk sorgular, 100'ün hemen altındaki eski sorgularla
yakın fark verirse reddedilebilir; bu kuralın amacına uygundur.

## 2. 10 yetkili düğüm — kurum entegrasyonu gelince

**Hedef:** 10 kurumsal düğüm. Kontrattaki eşikler raporun 2.6 bölümüne göre
sorgu türüne bağlıdır ve sabittir (`thresholdFraction`, yalnız kurucu
fonksiyonda atanır):

| Sorgu türü | Oran | 10 düğümde |
|---|---|---|
| Genel istatistik | 4/10 | 4 onay |
| Makine öğrenmesi | 7/10 | 7 onay |
| GWAS | 9/10 | 9 onay |

**Şu an:** 2 düğüm (genel istatistik 1 onay). Düğüm servisi tek proseste
çalışıyor; bu bir test kolaylığıdır, bağımsız kurumları temsil etmez.

**Hazır olan:** `scripts/add-nodes.ts` — eksik düğüm cüzdanlarını üretir,
fonlar, teminat yatırtır ve **en son** yetkilendirir. Sıra kritik:
`requiredApprovals` yetkili düğüm *sayısına* bakar; teminatsız bir düğüm
yetkilendirilirse eşik yükselir ama o düğüm onay veremez ve talepler
sonuçlanmaz. Betik bakiye yetmezse hiçbir işlem göndermez ve
`ACTIVATE_NODES=1` verilmeden yalnız maliyeti yazar.

**Maliyet (1 Ekim 2026 ölçümü):** minStake 0,0065 ETH. 8 yeni düğüm için
2× teminatla 0,131 ETH, 4× teminatla 0,240 ETH.

**Geçiş adımları (kurum entegrasyonunda):**
1. Her kurum kendi düğüm anahtarını üretir; anahtar bizde tutulmaz.
   (`add-nodes.ts` test içindir; üretimde düğümü kurum kendisi teminatlar,
   biz yalnız `authorizeNode` çağırırız.)
2. Her düğüm ayrı bir servis olarak, kendi politikasıyla çalışır.
3. Kurum düğümleri yetkilendirildikten sonra test düğümleri `revokeNode`
   ile çıkarılır.
