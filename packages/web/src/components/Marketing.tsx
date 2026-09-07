import { useT } from "../lib/i18n";

export function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  // Metinler cagiran tarafta cevriliyor: bu bilesen bicimlendirmeden sorumlu,
  // icerikten degil.
  return <div className="section-head"><p className="section-head__context">{eyebrow}</p><h2>{title}</h2><p>{sub}</p></div>;
}

export function FeatureRow() {
  const t = useT();
  return (
    <div className="archive-flow" id="yontem">
      <article className="archive-flow__owner">
        <span className="mono">{t("01 / VERİ SAHİBİ")}</span>
        <h3>{t("Kişisel kaydı hazırlayın.")}</h3>
        <p>{t("Dosya uyumu görülür, alanlar yerelde şifrelenir ve izin kaydı oluşur.")}</p>
        <div className="archive-flow__ledger">
          <span>{t("İzin kaydı")}</span><span className="mono">ACTIVE</span>
          <span>{t("Alan kapsamı")}</span><span className="mono">12 / 12</span>
        </div>
      </article>
      <article className="archive-flow__research">
        <span className="mono">{t("02 / ARAŞTIRMACI")}</span>
        <h3>{t("Çalışma protokolünü tanımlayın.")}</h3>
        <p>{t("Yalnız gerekli alanlar ve sonuç koşulları kayda alınır; talep bir çalışma nesnesi olarak ilerler.")}</p>
      </article>
      <article className="archive-flow__node">
        <span className="mono">{t("03 / DOĞRULAMA DÜĞÜMÜ")}</span>
        <h3>{t("İşlem defterini denetleyin.")}</h3>
        <p>{t("Onay, itiraz penceresi ve çözüm sırası tek bir denetlenebilir kayıtta tutulur.")}</p>
        <div className="archive-flow__ledger">
          <span>{t("Onay durumu")}</span><span className="mono">PENDING</span>
          <span>{t("Kanıt yolu")}</span><span className="mono">0x7C…A11</span>
        </div>
      </article>
    </div>
  );
}

export function Footer() {
  const t = useT();
  return <footer className="footer"><div className="section footer__content"><p>{t("VeriArfy araştırma amaçlıdır; tıbbi değerlendirme veya tavsiye sunmaz.")}</p><p className="mono">FHE · ZK · SEPOLIA</p></div></footer>;
}

/**
 * Sorun bolumu.
 *
 * Sayilar SOMUT: "veri degerlidir" gibi bir genelleme yerine, degerin nerede
 * durdugu ve kime gitmedigi soylenir.
 */
export function ProblemRow() {
  const t = useT();
  const items = [
    {
      lead: t("Araştırmacı için"),
      body: t("Bir GWAS çalışması binlerce katılımcının genotipine ihtiyaç duyar. Bu veriyi toplamak çalışmanın en pahalı ve en yavaş kısmıdır."),
    },
    {
      lead: t("Veri sahibi için"),
      body: t("Aynı veri bir kez satılır, defalarca kullanılır ve kişiye hiçbir şey dönmez. Kimin hangi çalışmada kullandığı da görünmez."),
    },
    {
      lead: t("Ortadaki boşluk"),
      body: t("Veriyi paylaşmak mahremiyeti kaybetmek anlamına geldiği sürece, paylaşmak isteyen kişi için makul bir seçenek yoktur."),
    },
  ];

  return (
    <div className="explain-grid">
      {items.map((item) => (
        <article className="explain-card" key={item.lead}>
          <h3>{item.lead}</h3>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}

/**
 * Odeme modeli.
 *
 * Kitlik ornegi GERCEK sozlesme davranisidir, tanitim abartisi degil:
 * ucret `kayit x tabanFiyat x kitlik` formulunden gelir ve ayni kitlik
 * sayisi veri sahibinin payini da belirler.
 */
export function PricingRow() {
  const t = useT();

  return (
    <div className="pricing-explain">
      <div className="pricing-explain__text">
        <h3>{t("Kayıt başına ödeme")}</h3>
        <p>{t("Bir kayıt, bir kişinin bir alanıdır. Araştırmacı iki alan isterse ve bunlara sırasıyla 40 ve 12 kişi veri vermişse, satın aldığı şey 52 kayıttır — havuzun tamamı değil.")}</p>
        <h3>{t("Kıtlık çarpanı")}</h3>
        <p>{t("Bir alan ne kadar az kişide varsa, o alanın kayıt fiyatı o kadar yüksektir. Çarpan zincirdeki kapsama sayaçlarından türetilir; kimse elle değer atamaz.")}</p>
      </div>

      <div className="pricing-explain__table" role="table" aria-label={t("Kıtlık örneği")}>
        <div className="pricing-explain__row pricing-explain__row--head" role="row">
          <span role="columnheader">{t("Alan")}</span>
          <span role="columnheader">{t("Kaç kişide")}</span>
          <span role="columnheader">{t("Kişi başı")}</span>
        </div>
        <div className="pricing-explain__row" role="row">
          <span role="cell">{t("Yaygın varyant")}</span>
          <span className="mono" role="cell">1000</span>
          <span className="mono" role="cell">1x</span>
        </div>
        <div className="pricing-explain__row" role="row">
          <span role="cell">{t("Seyrek kohort")}</span>
          <span className="mono" role="cell">100</span>
          <span className="mono" role="cell">10x</span>
        </div>
        <p className="pricing-explain__note">
          {t("Toplamda seyrek alan daha ucuza gelir — daha az veri satın alınır. Ama o veriyi taşıyan kişi kat kat fazla kazanır.")}
        </p>
      </div>
    </div>
  );
}

/** Kullanilan katmanlar ve her birinin cozdugu soru. */
export function TechRow() {
  const t = useT();
  const layers = [
    {
      tag: "FHE",
      name: "Zama fhEVM",
      q: t("Veri açılmadan nasıl hesaplanır?"),
      body: t("Dozajlar ve ölçümler şifreli olarak toplanır. Kontenjans tabloları ve Welch yeterli istatistikleri hiçbir noktada çözülmeden birikir."),
    },
    {
      tag: "ZK",
      name: "Groth16 · circom",
      q: t("Veriniz olduğunu nasıl kanıtlarsınız?"),
      body: t("Devre, kapsama bitlerini taahhüde giren dozajlardan türetir. «Bu alan bende var» deyip boş göndermek matematiksel olarak imkânsızdır."),
    },
    {
      tag: "KMS",
      name: t("Eşikli çözüm"),
      q: t("Sonuca kim erişebilir?"),
      body: t("Açılım, bağımsız düğümlerin eşikli onayı ve ardından bir itiraz penceresi gerektirir. Ödeme tek başına hiçbir şeyi çözmez."),
    },
  ];

  return (
    <div className="tech-grid">
      {layers.map((l) => (
        <article className="tech-card" key={l.tag}>
          <span className="tech-card__tag mono">{l.tag}</span>
          <h3>{l.name}</h3>
          <p className="tech-card__q">{l.q}</p>
          <p>{l.body}</p>
        </article>
      ))}
    </div>
  );
}

/**
 * Sinirlar.
 *
 * Tanitim sayfasinda bu bolumun bulunmasi bilincli: sistemin
 * kanitlamadigi seyi once biz soylemezsek, ilk soran kisi soyler.
 */
export function LimitsRow() {
  const t = useT();
  const limits = [
    {
      head: t("Verinin gerçekliği kanıtlanmaz"),
      body: t("ZK kanıtı, kapsamanın taahhütle tutarlı olduğunu gösterir. Verinin gerçek bir ölçümden geldiğini göstermez — bunu ancak imzalayan akredite bir kurum söyleyebilir."),
    },
    {
      head: t("Havuzdan çıkmak geçmişi silmez"),
      body: t("Ayrılmak gelecekteki sorgulardan pay almayı durdurur. Homomorfik toplamlara zaten karışmış veri geri çekilemez."),
    },
    {
      head: t("Test ağındayız"),
      body: t("Sözleşmeler Sepolia üzerinde çalışıyor. Tören tek katılımcılı bir geliştirme kurulumudur; ana ağ için çok taraflı bir tören gerekir."),
    },
  ];

  return (
    <div className="explain-grid">
      {limits.map((l) => (
        <article className="explain-card explain-card--limit" key={l.head}>
          <h3>{l.head}</h3>
          <p>{l.body}</p>
        </article>
      ))}
    </div>
  );
}
