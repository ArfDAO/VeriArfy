/**
 * Ingilizce sozluk — anahtar TURKCE KAYNAK METNIN kendisidir.
 *
 * Karsiligi olmayan metin Turkce haliyle basilir (bkz. `lib/i18n.tsx`), yani
 * eksik ceviri ekranda GORUNUR ama ekrani kirmaz.
 *
 * `{ad}` bicimindeki yer tutucular korunmali; ceviri sirayi degistirebilir
 * ama yer tutucuyu dusuremez.
 */
export const EN: Record<string, string> = {
  // --- Ust gezinme ---------------------------------------------------------
  "Arşiv bölümleri": "Archive sections",
  "Anket": "Survey",
  "Sonuçlar": "Results",
  "Giriş": "Sign in",
  "Dil": "Language",
  "Türkçe": "Turkish",
  "İngilizce": "English",

  // --- Hero ----------------------------------------------------------------
  "KİŞİSEL VERİ ARŞİVİ / KAYIT 04–SEPOLIA": "PERSONAL DATA ARCHIVE / RECORD 04–SEPOLIA",
  "Veri, izin verilene kadar <em>kapalı</em> kalır.": "Data stays <em>sealed</em> until you allow it.",
  "Genomik ve biyobelirteç kayıtları cihazınızda şifrelenir. Araştırma isteği yalnızca verdiğiniz izin kapsamına göre çalışır; işlem kaydı sonradan doğrulanabilir.":
    "Genomic and biomarker records are encrypted on your own device. A research request runs only within the scope you allowed, and every step stays verifiable afterwards.",
  "Çalışma alanına girin": "Enter the workspace",
  "Kayıt akışını inceleyin": "See how a record flows",
  "Mineral dokulu bir laboratuvar lamı üzerinde arşivlenmiş biyolojik numune":
    "A biological specimen archived on a mineral-textured laboratory slide",
  "Genomik + biyobelirteç": "Genomic + biomarker",
  "İzin: etkin · kayıt: doğrulanabilir": "Consent: active · record: verifiable",
  "Veri işleme kanıtları": "Data-handling evidence",
  "Yerel şifreleme": "Local encryption",
  "Ham dosya tarayıcıyı terk etmez.": "The raw file never leaves the browser.",
  "İzin kaydı": "Consent record",
  "Erişim zincir durumuna bağlıdır.": "Access follows on-chain state.",
  "Grup sonucu": "Group-level result",
  "Tekil kayıt açığa çıkmaz.": "No individual record is revealed.",

  // --- Ana sayfa bolumleri -------------------------------------------------
  "Çalışma kapsamı": "Study scope",
  "Katılımcı kaydı": "Participant records",
  "Çalışma sorusu": "Study questions",
  "Hesaplama yolu": "Computation paths",
  "01 / VERİ SAHİBİ": "01 / DATA OWNER",
  "Kişisel kaydı hazırlayın.": "Prepare your personal record.",
  "Dosya uyumu görülür, alanlar yerelde şifrelenir ve izin kaydı oluşur.":
    "File compatibility is shown, fields are encrypted locally, and a consent record is written.",
  "İzin kaydı ": "Consent record ",
  "Alan kapsamı": "Field coverage",
  "02 / ARAŞTIRMACI": "02 / RESEARCHER",
  "Çalışma protokolünü tanımlayın.": "Define the study protocol.",
  "Yalnız gerekli alanlar ve sonuç koşulları kayda alınır; talep bir çalışma nesnesi olarak ilerler.":
    "Only the required fields and result conditions are recorded; the request proceeds as a study object.",
  "03 / DOĞRULAMA DÜĞÜMÜ": "03 / VERIFICATION NODE",
  "İşlem defterini denetleyin.": "Audit the transaction ledger.",
  "Onay, itiraz penceresi ve çözüm sırası tek bir denetlenebilir kayıtta tutulur.":
    "Approval, the challenge window and the decryption order all live in one auditable record.",
  "Onay durumu": "Approval status",
  "Kanıt yolu": "Proof path",
  "VeriArfy araştırma amaçlıdır; tıbbi değerlendirme veya tavsiye sunmaz.":
    "VeriArfy is for research purposes; it offers no medical assessment or advice.",

  // --- Panel kabugu --------------------------------------------------------
  "Genel bakis": "Overview",
  "Veri yukle": "Upload data",
  "Kazanclar": "Earnings",
  "Gizlilik": "Privacy",
  "Dogrulama": "Verification",
  "Kayit ve hazirlik": "Registration",
  "Veri satin al": "Buy data",
  "Sorgular": "Queries",
  "Sonuclar": "Results",
  "Dugum": "Node",
  "Veri sahibi paneli": "Data owner panel",
  "Arastirmaci paneli": "Researcher panel",
  "Ana içeriğe geç": "Skip to main content",
  "{title} menusu": "{title} menu",
  "Yanlis ag": "Wrong network",
  "Sepolia'ya gec": "Switch to Sepolia",
  "Bagli degil": "Not connected",
  "Giris ekranina don": "Back to sign-in",
  "Bu cuzdan arastirmaci defterinde kayitli degil. Sorgu acmadan once ZK kimlik kaydini tamamlamaniz gerekiyor.":
    "This wallet is not in the researcher registry. Complete ZK identity registration before opening a query.",
  // --- Ana sayfa: anket ve sonuclar ---------------------------------------
  "Gönderim başarısız. Bağlantıyı kontrol edip yeniden deneyin.":
    "Submission failed. Check your connection and try again.",
  "KATILIM": "PARTICIPATE",
  "Anketi doldurun": "Fill in the survey",
  "6 basit soru cevaplayın. Cevaplarınız hem normal hem de FHE ile şifreli olarak işlenecek.":
    "Answer a few short questions. Your answers are processed twice: once in the clear and once encrypted with FHE.",
  "KAYIT TAMAMLANDI": "RECORD COMPLETE",
  "Anket kaydı alındı.": "Your survey response was recorded.",
  "GERÇEK CEVABINIZ": "YOUR ACTUAL ANSWER",
  "Yüksek Kaygı": "High anxiety",
  "Sakin": "Calm",
  "ŞİFRESİZ MODEL TAHMİNİ": "PLAINTEXT MODEL PREDICTION",
  "ŞİFRELİ (FHE) MODEL TAHMİNİ": "ENCRYPTED (FHE) MODEL PREDICTION",
  "doğrulandı": "matched",
  "uyuşmadı": "did not match",
  "FHE ŞİFRELEME KANITI": "FHE ENCRYPTION EVIDENCE",
  "Verileriniz Zama Concrete ML kullanılarak şifrelendi ve tahmin işlemi bu şifreli devre (ciphertext) üzerinde yapıldı.":
    "Your answers were encrypted with Zama Concrete ML, and the prediction ran on that ciphertext without ever decrypting it.",
  "Şifreli veri boyutu": "Ciphertext size",
  "Ciphertext hex özeti": "Ciphertext hex digest",
  "Şifreli veriyi indir (.bin)": "Download the ciphertext (.bin)",
  "Tekrar Doldur": "Fill it in again",
  "CANLI SONUÇLAR": "LIVE RESULTS",
  "Şifreli vs Şifresiz Model": "Encrypted vs plaintext model",
  "Gerçek kullanıcı verileri üzerinde iki modelin doğruluk karşılaştırması.":
    "Accuracy of the two models compared on real user responses.",
  "NASIL ÇALIŞIYOR?": "HOW IT WORKS",
  "Güven ama doğrula": "Trust, but verify",
  "Aynı veri iki bağımsız hattan geçirilir ve sonuçlar kıyaslanır.":
    "The same data runs through two independent paths and the results are compared.",

  // --- Rota gecisleri ------------------------------------------------------
  "OTURUM GERI YUKLENIYOR": "RESTORING SESSION",
  "Cuzdan baglantisi dogrulaniyor.": "Verifying the wallet connection.",
  "Panel yukleniyor...": "Loading panel…",
  // --- Giris ekrani --------------------------------------------------------
  "ERISIM SECIMI": "CHOOSE ACCESS",
  "Hangi taraftan devam edeceksiniz?": "Which side are you here for?",
  "Cuzdan yalnizca oturum kimligidir. Arastirmaci yetkisi her zaman zincirdeki defterden yeniden dogrulanir.":
    "The wallet is only a session identity. Researcher authorisation is always re-checked against the on-chain registry.",
  "Veri sahibi": "Data owner",
  "Arastirmaci": "Researcher",
  "Genomik ve biyobelirtec verinizi sifreleyerek havuza katilir, sorgu odullerini takip edersiniz.":
    "Encrypt your genomic and biomarker data, join the pool, and follow what each query pays you.",
  "Alan secerek grup toplamlarini satin alir, onay surecini izler ve istatistiksel sonucu gorursunuz.":
    "Pick the fields you need, buy the group aggregates, follow the approval process and read the statistics.",
  "{role} olarak devam edin": "Continue as {role}",
  "Paneli ac": "Open the panel",
  "Cuzdan": "Wallet",
  "Cuzdani degistir": "Change wallet",
  "Cuzdandan cik": "Disconnect",
  "Ethereum cuzdani bulunamadi. MetaMask gibi bir cuzdani etkinlestirip sayfayi yenileyin.":
    "No Ethereum wallet found. Enable a wallet such as MetaMask and reload the page.",
  "Mevcut cuzdan oturumu kontrol ediliyor...": "Checking for an existing wallet session…",
  "Devam etmek icin bir cuzdan secin.": "Choose a wallet to continue.",
  "Cuzdani bagla": "Connect wallet",
  "Bu uygulama Sepolia aginda calisir. Rol secmeden once agi degistirin.":
    "This app runs on Sepolia. Switch networks before choosing a role.",
  "CUZDAN BAGLANTISI": "WALLET CONNECTION",
  "Cuzdaninizi secin": "Choose your wallet",
  "Cuzdan secicisini kapat": "Close the wallet picker",
  "Cuzdan secimi": "Wallet selection",
  "Kapat": "Close",
  // --- Paneller (veri sahibi + arastirmaci) --------------------------------
  " bu sorguda ek nadirlik primi yok.": " no extra rarity premium on this query.",
  " bu sorguda nadir alan primi var.": " a rare-field premium applies to this query.",
  "ANLIK FIYAT": "LIVE PRICE",
  "ARASTIRMACI / DUGUM": "RESEARCHER / NODE",
  "ARASTIRMACI / KAYIT VE HAZIRLIK": "RESEARCHER / REGISTRATION",
  "ARASTIRMACI / SONUCLAR": "RESEARCHER / RESULTS",
  "ARASTIRMACI / SORGULAR": "RESEARCHER / QUERIES",
  "ARASTIRMACI / VERI SATIN ALMA": "RESEARCHER / BUYING DATA",
  "Acik sorgu yenilemeden sonra zincirden devralinir. Bu sorgu kapanmadan yeni bir odeme acilamaz.":
    "An open query is picked back up from the chain after a reload. No new payment can start until this one closes.",
  "Acik sorgu yok": "No open query",
  "Acilim": "Disclosure",
  "Acilim yetkisi verilmeyi bekliyor.": "Waiting for disclosure access to be granted.",
  "Acilim yetkisini ver": "Grant disclosure access",
  "Alan ayrintisi zincirde yok": "No field detail on chain",
  "Analizi onayla ve odemeyi dagit": "Confirm the analysis and distribute payment",
  "Arastirma cuzdani hazir": "Research wallet ready",
  "Arastirmaci alan secip sorgu actiginda, bu ekranda kapsamaniz ve odul durumunuz gorunecek.":
    "Once a researcher selects fields and opens a query, your coverage and reward status will appear here.",
  "Arastirmaci defterinde kayitli.": "Registered in the researcher registry.",
  "Ayrildi": "Left",
  "Ayrilmak gecmisi silmez.": "Leaving does not erase the past.",
  "BEKLENEN ADIM": "EXPECTED STEP",
  "BEKLEYEN ODUL": "PENDING REWARD",
  "BIYOBELIRTECLER": "BIOMARKERS",
  "Bazı metriklerde her grupta en az iki katilimci olmadigi icin Welch t-testi hesaplanamiyor.":
    "Some metrics lack at least two participants per group, so the Welch t-test cannot be computed.",
  "Bazı varyantlarda beklenen hucre sayisi 5'in altinda; ki-kare yaklasimi guvenilir degil.":
    "Some variants have expected cell counts below 5; the chi-square approximation is not reliable there.",
  "Biyobelirtec sonucu": "Biomarker result",
  "Bos alanlarin degisken fiyat payi sifirdir; toplamda sorgu dogrulama/emanet maliyeti icin zincirin taban ucreti bulunabilir.":
    "Fields nobody has add nothing to the variable price; the total may still carry the chain's base fee for verification and escrow.",
  "Bu cuzdana onay yetkisi verilmis.": "This wallet has approval authority.",
  "Bu cuzdana protokol tarafindan onay yetkisi verilmemis.":
    "The protocol has not granted this wallet approval authority.",
  "Bu ekran yalnizca zincirdeki uyelik ve taahhut bilgilerini gosterir; ham veri veya sifreleme anahtari gostermez.":
    "This screen shows only on-chain membership and commitment data; it never shows raw data or encryption keys.",
  "CEKILDI": "CLAIMED",
  "CEKILEBILIR TOPLAM": "CLAIMABLE TOTAL",
  "CHI2": "CHI2",
  "CID OZETI": "CID DIGEST",
  "Cekiliyor...": "Claiming…",
  "Cekilmis oduller ile bekleyen odullerin toplami.":
    "Rewards already claimed plus rewards still pending.",
  "Cikis blogu: {block}": "Exit block: {block}",
  "Cozuldu": "Decrypted",
  "Cozulmus acik sorgu yok": "No decrypted query available",
  "Cozulmus grup toplamlari ve odeme dagitimi Sonuclar ekranindan ilerletilir.":
    "Decrypted group aggregates and payment distribution continue on the Results screen.",
  "Cozuluyor...": "Decrypting…",
  "Cozum tamam; odemenin dagitilmasi bekliyor.":
    "Decryption is done; payment distribution is pending.",
  "Cozum yetkisi arastirmaci cuzdani icin zincirde verildi.":
    "Decryption rights were granted on chain to the researcher wallet.",
  "Cuzdan bakiyesi": "Wallet balance",
  "Cuzdaniniz aktif havuz uyesi.": "Your wallet is an active pool member.",
  "DURUM": "STATUS",
  "Dagitildi": "Distributed",
  "Dagitiliyor...": "Distributing…",
  "Dugum ve stake durumu yalnizca Sepolia aginda okunabilir.":
    "Node and stake status can only be read on Sepolia.",
  "Eksik isaretli alanlar kapsama sayisina dahil edilmez.":
    "Fields marked missing do not count towards coverage.",
  "Emanet, protokol kurallarina gore katilimcilar ve hazine arasinda dagitilir.":
    "The escrow is split between participants and the treasury according to protocol rules.",
  "Evet": "Yes",
  "FHE sonucuna erisim henuz verilmedi.": "Access to the FHE result has not been granted yet.",
  "GENOMIK VARYANTLAR": "GENOMIC VARIANTS",
  "GUNCEL minStake()": "CURRENT minStake()",
  "Gelecek sorgu paylarini durdur": "Stop earning from future queries",
  "Genel bakis yalnizca Sepolia agindaki sozlesmeden okunabilir.":
    "The overview can only be read from the contract on Sepolia.",
  "Genomik sonuc": "Genomic result",
  "Gerekli teminat; gecmis toplam ucret buyudukce artabilir.":
    "Required stake; it can grow as cumulative fees increase.",
  "Giris": "Sign in",
  "Gizli kimlik tarayicida uretilir. Kurator yalnizca taahhudu gorur; zincir ise kimliginizin akredite agacta oldugunu kanitlar.":
    "The secret identity is generated in your browser. The curator sees only the commitment, while the chain proves your identity is in the accredited tree.",
  "Grup toplamini coz ve hesapla": "Decrypt the group aggregates and compute",
  "Guncel blok": "Current block",
  "HAKEDIS": "ENTITLEMENT",
  "HAVUZ DURUMU": "POOL STATUS",
  "HAVUZ KATILIMCISI": "POOL PARTICIPANTS",
  "HAVUZDAN AYRILMA": "LEAVING THE POOL",
  "HENUZ CEKILEBILIR DEGIL": "NOT CLAIMABLE YET",
  "Ham dosyaniz tarayicidan cikmaz. Zincire yalnizca sifreli degerler ve dogrulama kanitlari gider.":
    "Your raw file never leaves the browser. Only encrypted values and verification proofs go on chain.",
  "Harcama izni": "Spending allowance",
  "Harcama iznini verin": "Grant the spending allowance",
  "Havuz bosken sorgu acilamaz.": "A query cannot be opened while the pool is empty.",
  "Havuz ve veri kasasi": "Pool and data vault",
  "Havuzdan ayril": "Leave the pool",
  "Hayir": "No",
  "Hazirlik kontrolleri tamamlansa bile havuzda henuz katilimci yok; bu nedenle sorgu acilamaz. Bu, kimlik veya token hatasi degildir.":
    "Even with every readiness check passed, the pool has no participants yet, so no query can be opened. This is not an identity or token problem.",
  "Henuz aktif havuz uyeligi yok.": "No active pool membership yet.",
  "Henuz sorgu yok": "No queries yet",
  "Her satirdaki cekim, basarili islemden sonra zincirden yeniden dogrulanir.":
    "Each row's claim is re-verified against the chain after the transaction succeeds.",
  "Her tutar ve durum zincirden okunur. Odeme agirligi, yalnizca kapsadiginiz alanlara ve nadirlik katsayisina dayanir.":
    "Every amount and status is read from the chain. Your payment weight depends only on the fields you cover and their rarity factor.",
  "IADE EDILDI": "REFUNDED",
  "ISTENEN ALANLAR": "REQUESTED FIELDS",
  "Iade": "Refund",
  "Ilk sorgudan once uc kontrol": "Three checks before your first query",
  "Islem gonderiliyor...": "Sending transaction…",
  "Islem kanitlari": "Transaction evidence",
  "Isleniyor...": "Working…",
  "Itiraz penceresi kapandi; FHE erisimi verilebilir.":
    "The challenge window has closed; FHE access can be granted.",
  "Itiraz sonu": "Challenge ends",
  "Itiraz suresi": "Challenge window",
  "Izin tutari, zincirdeki guncel sorgu ucretini asmaz.":
    "The allowance never exceeds the current on-chain query fee.",
  "KALICILIK": "PERSISTENCE",
  "KAPSADIGINIZ ALAN": "FIELDS YOU COVER",
  "KAPSAMANIZ": "YOUR COVERAGE",
  "KI-KARE + BH-FDR": "CHI-SQUARE + BH-FDR",
  "KONTROL": "CONTROL",
  "KONTROL 0/1/2": "CONTROL 0/1/2",
  "KONTROL LISTESI": "CHECKLIST",
  "Kalan blok": "Blocks left",
  "Kanit cihazinizda uretilir; cüzdanda yalniz zincir kaydi imzalanir.":
    "The proof is generated on your device; the wallet only signs the on-chain record.",
  "Kanitla arastirmaci defterine kaydolun.": "Register in the researcher registry with a proof.",
  "Kapsama ve kitlik her yenilemede zincirden okunur. Fiyat, secilen alanlarda gercekten veri veren kisi sayisina gore hesaplanir.":
    "Coverage and scarcity are read from the chain on every refresh. The price follows how many people actually hold data in the selected fields.",
  "Katki ve odul verileri tarayicida tutulmaz; her yenilemede zincirden okunur.":
    "Contribution and reward data are never cached in the browser; they are read from the chain on every refresh.",
  "Kayit ve hazirlik denetimi yalnizca Sepolia aginda kullanilabilir.":
    "Registration and readiness checks are only available on Sepolia.",
  "Kayit yok": "No record",
  "Kayitli veri kasasinin zincirdeki ozetidir.": "The on-chain digest of your stored data vault.",
  "Kazanclar yalnizca Sepolia aginda okunabilir.": "Earnings can only be read on Sepolia.",
  "Ki-kare ve BH-FDR genomik tablolarda; Welch t ve Cohen d biyobelirtec tablolarinda gosterilir.":
    "Chi-square and BH-FDR appear in the genomic tables; Welch t and Cohen's d in the biomarker tables.",
  "Kimliginizi ZK ile kaydedin": "Register your identity with ZK",
  "Kimlik, bakiye ve harcama izni mevcut. Veri alimi ekraninda alanlari secip anlik fiyatla sorgu acabilirsiniz.":
    "Identity, balance and allowance are all in place. Pick fields on the data-purchase screen and open a query at the live price.",
  "METRIK": "METRIC",
  "Metrik #{list}": "Metric #{list}",
  "ODEME AGIRLIGINIZ": "YOUR PAYMENT WEIGHT",
  "ONAY VEREBILIR MI": "CAN APPROVE",
  "Odeme dagitildi; sonuc ekranina gecebilirsiniz.":
    "Payment was distributed; you can move on to the results screen.",
  "Odendi": "Paid",
  "Oduller sekmesinden cekilebilir tutar.": "The amount you can claim from the rewards tab.",
  "Okunuyor...": "Loading…",
  "Onay": "Approval",
  "Onay bekliyor": "Awaiting approval",
  "Onay dugumunuzun ekonomik yeterliligi": "The economic standing of your approval node",
  "Onay esigi bekleniyor.": "Waiting for the approval threshold.",
  "Onay/acilim basarisiz kalirsa ucret arastirmaciya iade edilir.":
    "If approval or disclosure fails, the fee is refunded to the researcher.",
  "Onaylaniyor...": "Approving…",
  "Once grup kaydini olusturur, sonra genomik ve biyobelirtec alanlarini cihazinizi terk etmeden sifrelersiniz.":
    "First you create the group record, then you encrypt genomic and biomarker fields without them ever leaving your device.",
  "Once kayit ve hazirlik ekranindan arastirmaci kimliginizi dogrulayin.":
    "Verify your researcher identity on the registration screen first.",
  "PANEL TAAHHUDU": "PANEL COMMITMENT",
  "Panel geri cikarilamaz bir taahhut olarak tutulur.":
    "The panel is stored as a commitment that cannot be reversed.",
  "Pencere blok {block} sonunda biter.": "The window closes at block {block}.",
  "Pencerenin bitmesi bekleniyor.": "Waiting for the window to close.",
  "SIRADAKI ADIM": "NEXT STEP",
  "SNP #{list}": "SNP #{list}",
  "SONRAKI ADIM": "NEXT STEP",
  "Secilen SNP": "Selected SNPs",
  "Secilen alanlar icin token bakiyesi yetersiz.":
    "Token balance is not enough for the selected fields.",
  "Secilen metrik": "Selected metrics",
  "Sifreli toplamdan istatistige": "From encrypted aggregates to statistics",
  "Sonuclar yalnizca Sepolia aginda okunabilir.": "Results can only be read on Sepolia.",
  "Sorgu aciliyor...": "Opening query…",
  "Sorgu durumu yalnizca Sepolia aginda okunabilir.": "Query status can only be read on Sepolia.",
  "Sorgu iade edildi.": "The query was refunded.",
  "Sorgu token bakiyesi": "Query token balance",
  "Sorgular ekraninda acilim yetkisi verildikten sonra burada analiz yapabilirsiniz.":
    "Once disclosure access is granted on the Queries screen, you can run the analysis here.",
  "Sorgunuzun zincir ustundeki ilerlemesi": "How your query is progressing on chain",
  "TEMINAT": "STAKE",
  "TOPLAM KAZANC": "TOTAL EARNED",
  "Takip yok": "Not tracked",
  "Teminat esigi saglanmadan onay islemi revert olur.":
    "Approval reverts unless the stake threshold is met.",
  "Token bakiyesi gerekli": "Token balance required",
  "Toplamlari coz ve analiz et": "Decrypt the aggregates and analyse",
  "Ucret": "Fee",
  "Ucret kadar izin ver": "Approve the fee amount",
  "Ucret zincirde emanete alindi.": "The fee is held in escrow on chain.",
  "Ucreti ode ve sorguyu ac": "Pay the fee and open the query",
  "Uye degil": "Not a member",
  "VAKA": "CASE",
  "VAKA 0/1/2": "CASE 0/1/2",
  "VARYANT": "VARIANT",
  "VERI SAHIBI / DOGRULAMA": "DATA OWNER / VERIFICATION",
  "VERI SAHIBI / GENEL BAKIS": "DATA OWNER / OVERVIEW",
  "VERI SAHIBI / GIZLILIK": "DATA OWNER / PRIVACY",
  "VERI SAHIBI / KAZANCLAR": "DATA OWNER / EARNINGS",
  "VERI SAHIBI / VERI YUKLEME": "DATA OWNER / UPLOAD",
  "Veri satin alma ekranindan alanlari secip sorgu actiginizda, bu zaman cizelgesi zincirden dolacak.":
    "When you select fields and open a query on the data-purchase screen, this timeline fills in from the chain.",
  "Veri satin alma yalnizca Sepolia aginda kullanilabilir.":
    "Buying data is only available on Sepolia.",
  "Veri yukleme akisinin islem ozetleri, bloklari, gaz kullanimi ve zincirden geri okunan kanitlari burada kalir.":
    "Transaction hashes, blocks, gas usage and the proofs read back from the chain during upload all stay here.",
  "Veri yuklemeye git": "Go to data upload",
  "Veriniz kullanildiginda payinizi alin": "Get paid when your data is used",
  "Verinizi cihazinizda sifreleyin": "Encrypt your data on your own device",
  "Verinizi sifreleyip havuza katin": "Encrypt your data and join the pool",
  "Verinizin havuzdaki durumu": "Where your data stands in the pool",
  "WELCH t + COHEN d": "WELCH t + COHEN d",
  "YETKI DURUMU": "AUTHORISATION",
  "Yalnizca guncel varsayilan sorgu ucreti kadar izin verilir; sinirsiz token izni istenmez.":
    "Only the current default query fee is approved; no unlimited token allowance is ever requested.",
  "Yalnizca ihtiyaciniz olan alanlari secin": "Select only the fields you actually need",
  "Yenile": "Refresh",
  "Yenileme gerekli.": "Renewal required.",
  "Yetki ve teminat esigi saglaniyor.": "Authorisation and stake threshold are both met.",
  "Yetki veriliyor...": "Granting access…",
  "Yetkili degil": "Not authorised",
  "Yetkili dugum": "Authorised node",
  "Yetkili dugum onaylari bekleniyor.": "Waiting for authorised node approvals.",
  "Yetkili olmak tek basina yeterli degil: `minStake()` sorgu degeriyle buyur ve onay uygunlugu zincirden yeniden okunur.":
    "Being authorised is not enough on its own: `minStake()` grows with query value, and approval eligibility is re-read from the chain.",
  "ZK kimlik kaydi": "ZK identity record",
  "ZK kimlik kaydini baslat": "Start ZK identity registration",
  "ZK kimlik, token bakiyesi ve harcama izni zincirden yeniden okunur; tarayicida basarili varsayilmaz.":
    "ZK identity, token balance and allowance are re-read from the chain; the browser never assumes success.",
  "Zaten homomorfik toplama karismis veriniz geri cekilemez; daha once hak ettiginiz oduller korunur. Ayrilma, bundan sonra acilacak sorgularda yeni pay olusmasini durdurur.":
    "Data already mixed into the homomorphic aggregates cannot be pulled back, and rewards you already earned are kept. Leaving only stops new shares forming in queries opened from now on.",
  "Zincir durumu yeniden okunuyor.": "Re-reading chain state.",
  "en az 1 gerekli": "at least 1 required",
  "istege bagli": "optional",
  "p": "p",
  "p (FDR)": "p (FDR)",
  "sorgular ekranindan": "on the queries screen",
  "t / d": "t / d",
  "takip edin.": "to follow along.",
  "{amount} cek": "Claim {amount}",
  "{blocks} blokluk itiraz penceresi acik.": "{blocks} blocks left in the challenge window.",
  "{done}/{needed} yetkili dugum onayi.": "{done} of {needed} authorised node approvals.",
  "{n} saglayici": "{n} providers",
  // --- Katki akisi, anket ve sonuc tablolari --------------------------------
  "0 · Cüzdan": "0 · Wallet",
  "1 · Gruba kayıt": "1 · Group enrolment",
  "2 · Genomik veri": "2 · Genomic data",
  "3 · Biyobelirteç ve telemetri": "3 · Biomarkers and telemetry",
  "Anketi Gönder": "Submit the survey",
  "AĞ": "NETWORK",
  "Bildirim sesleri veya sürekli çevrimiçi olma zorunluluğu sizde stres yaratıyor mu?":
    "Do notification sounds or the pressure to stay online stress you out?",
  "BİREYSEL TAHMİNLER": "INDIVIDUAL PREDICTIONS",
  "DOĞRULUK KAYBI": "ACCURACY LOSS",
  "Dosyanızın içinde ne olduğunu bilmenize gerek yok.":
    "You do not need to know what is inside your file.",
  "EN AZ BİR ÖLÇÜM GEREKLİ": "AT LEAST ONE MEASUREMENT REQUIRED",
  "EĞİTİM SETİ PERFORMANSI (1000 Sentetik Veri)":
    "TRAINING-SET PERFORMANCE (1,000 synthetic records)",
  "FHE Tahmin": "FHE prediction",
  "FHE Şifreleme Maliyeti": "FHE encryption cost",
  "FHE ✓/✗": "FHE ✓/✗",
  "FHE:": "FHE:",
  "GEREKLİ": "REQUIRED",
  "Geleneksel ML": "Conventional ML",
  "Genel olarak gün içinde kendinizi ne kadar kaygılı (anksiyeteli) hissediyorsunuz?":
    "Overall, how anxious do you feel during the day?",
  "Gerçek (y)": "Actual (y)",
  "Girdiler (X₁-X₁₁)": "Inputs (X₁–X₁₁)",
  "Giriş ekranına git": "Go to the sign-in screen",
  "Gönderiliyor...": "Submitting…",
  "Günde ortalama kaç saat sosyal medya kullanıyorsunuz?":
    "On an average day, how many hours do you spend on social media?",
  "HEDEF DEĞİŞKEN": "TARGET VARIABLE",
  "Henüz katılımcı yok. İlk anketi doldurun!":
    "No participants yet. Be the first to fill in the survey.",
  "KAPSAMA": "COVERAGE",
  "KATILIMCI SAYISI": "PARTICIPANTS",
  "KAYITLI": "RECORDED",
  "KAYNAK": "SOURCE",
  "Karşınızdaki insanlarla yüz yüze sohbet ederken bile sürekli telefonunuzu kontrol etme ihtiyacı duyar mısınız?":
    "Do you feel the urge to check your phone even while talking to someone face to face?",
  "Katkı akışını başlatmak için giriş ekranından cüzdanı bağlayın ve veri sahibi rolünü seçin.":
    "To start contributing, connect your wallet on the sign-in screen and choose the data-owner role.",
  "Kontrol": "Control",
  "Kontrol (sağlıklı)": "Control (healthy)",
  "Metrik paneli okunuyor…": "Loading the metric panel…",
  "Olumsuz veya üzücü haberleri arka arkaya kaydırmaktan (doomscrolling) kendinizi alamadığınız olur mu?":
    "Do you find yourself unable to stop scrolling through negative or upsetting news (doomscrolling)?",
  "PANEL SIRASINDA DOZAJLAR": "DOSAGES IN PANEL ORDER",
  "Plain Tahmin": "Plaintext prediction",
  "Plain ✓/✗": "Plaintext ✓/✗",
  "Sepolia'ya geç": "Switch to Sepolia",
  "Sosyal medya kullanımı nedeniyle işinize, okulunuza veya günlük sorumluluklarınıza odaklanmakta zorluk çekiyor musunuz?":
    "Does social media make it hard to focus on work, school or daily responsibilities?",
  "Sosyal medyada başkalarının hayatlarını kendinizle kıyaslar mısınız?":
    "Do you compare other people's lives on social media to your own?",
  "Sosyal medyada paylaştığınız bir içerik yeterince beğeni/etkileşim almadığında moraliniz bozulur mu?":
    "Does it upset you when something you post does not get enough likes or engagement?",
  "Sosyal medyadaki gönderiler (filtreli fotoğraflar, lüks hayatlar vb.) kendinize olan güveninizi düşürüyor mu?":
    "Do social media posts (filtered photos, luxury lifestyles) lower your self-confidence?",
  "Sosyal medyaya bakmadığınızda bir şeyleri kaçırıyor (FOMO) hissine kapılır mısınız?":
    "Do you feel you are missing out (FOMO) when you are not checking social media?",
  "Tarayıcıdaki panel ile zincirdeki özet farklı. Katkı akışı kapatıldı.":
    "The panel in the browser does not match the digest on chain. Contribution has been disabled.",
  "Telefonunuz yanınızda olmadığında veya şarjı bittiğinde panik/huzursuzluk (Nomofobi) hisseder misiniz?":
    "Do you feel panic or unease when your phone is not with you or its battery dies (nomophobia)?",
  "Uyumadan hemen önce yatakta sosyal medyaya bakar mısınız?":
    "Do you check social media in bed right before sleeping?",
  "Vaka": "Case",
  "Vaka (hasta)": "Case (affected)",
  "Zama Concrete ML": "Zama Concrete ML",
  "Zincirde panel özeti ilan edilmemiş — dağıtım PANEL_HASH verilmeden yapılmış.":
    "No panel digest is declared on chain — the deployment ran without PANEL_HASH.",
  "Zincirden geri okunarak dogrulandi": "Verified by reading it back from the chain",
  "alanları isterse pay alırsınız.": "fields, you earn a share.",
  "kendi biriminde": "in its own unit",
  "olan": "with",
  "zincire giden tamsayıdır": "is the integer that goes on chain",
  "ÖDEMEYE ESAS ALAN": "FIELD USED FOR PAYMENT",
  "ölçülmedi": "not measured",
  "Şifresiz:": "Plaintext:",
  "ŞİFRELİ (FHE) MODEL DOĞRULUĞU": "ENCRYPTED (FHE) MODEL ACCURACY",
  "ŞİFRESİZ MODEL DOĞRULUĞU": "PLAINTEXT MODEL ACCURACY",
  // --- Dogrulama gunlugu (trace) -------------------------------------------
  "  blok": "  block",
  "  gaz": "  gas",
  "0 aralık dışı olduğu için o metriğin n sayımına hiç girmiyor — ortalamayı bozmuyor":
    "0 is out of range, so it never enters that metric's n count — it cannot skew the mean",
  "0 «homozigot referans» demektir; bilinmeyene 0 yazmak alel frekansını aşağı çeker":
    "0 means \"homozygous reference\"; writing 0 for an unknown call drags the allele frequency down",
  "Dosya ayrıştırıldı (tarayıcıda)": "File parsed (in the browser)",
  "Dozajlar şifrelenip gönderildi": "Dosages encrypted and submitted",
  "Kayıt zincirden geri okundu": "Record read back from the chain",
  "Köken kaydı zaten var — atlandı": "A provenance record already exists — skipped",
  "Panele hizalandı": "Aligned to the panel",
  "Sözleşme kaydı doğruluyor": "The contract confirms the record",
  "ZK köken kanıtı üretildi ve gönderildi": "ZK provenance proof generated and submitted",
  "biyobelirteç modülü": "biomarker module",
  "blok": "block",
  "bu neden önemli": "why this matters",
  "doldurduğunuz alanlardan türetildi; boş bıraktığınız metrik ödemeye de girmez":
    "derived from the fields you filled in; a metric you left blank earns nothing either",
  "dosyada olup panelde olmayan": "in the file but not in the panel",
  "eksik (3 olarak işaretlendi)": "missing (marked as 3)",
  "eksik neden 0 değil": "why missing is not 0",
  "eksik ölçüm ne oluyor": "what happens to a missing measurement",
  "fhEVM işlem başına 20M HCU; ölçülen tavan 12 SNP (BiomarkerHcu/MultiSnpGas testleri)":
    "fhEVM allows 20M HCU per transaction; the measured ceiling is 12 SNPs (BiomarkerHcu/MultiSnpGas tests)",
  "gaz": "gas",
  "hayır — yalnızca taahhüt (Poseidon özeti) yazıldı; dozajlar kanıtın içinde gizli kalır":
    "no — only the commitment (a Poseidon digest) was written; the dosages stay hidden inside the proof",
  "hayır — yalnızca şifreli handle saklanır, karşılaştırmalar homomorfik yapılır":
    "no — only encrypted handles are stored, and comparisons run homomorphically",
  "isEnrolled": "isEnrolled",
  "işlem": "transaction",
  "kanıt ne söylemiyor": "what the proof does not say",
  "kanıt ne söylüyor": "what the proof says",
  "kapsama bitleri TAM OLARAK taahhüde giren dozajlardan türedi — «bende bu alan var» deyip boş göndermek imkânsız":
    "the coverage bits are derived from EXACTLY the dosages inside the commitment — claiming a field you do not have is impossible",
  "kapsama nasıl belirlendi": "how coverage was determined",
  "kapsanan": "covered",
  "kareler toplamı için mul(euint64,euint64) = 596.000 HCU; ölçülen tavan 8 metrik":
    "the sum of squares needs mul(euint64,euint64) = 596,000 HCU; the measured ceiling is 8 metrics",
  "metrik sayısı": "metric count",
  "neden atlandı": "why it was skipped",
  "nerede işlendi": "where it was processed",
  "nullifier bir kez harcanır; mevcut kayıt zaten kapsamayı kanıtla yazmış durumda":
    "a nullifier is spent once, and the existing record already wrote its coverage with a proof",
  "panel boyutu": "panel size",
  "paneliniz zincire girdi mi": "did your panel go on chain",
  "parti sınırı neden 10": "why the batch limit is 10",
  "parti sınırı neden 6": "why the batch limit is 6",
  "size sorulmadı — dosyanız ayrıştırıldı. Hangi alanlarda gerçek veriniz olduğu ödemeyi belirler: araştırmacı o alanları isterse pay alırsınız":
    "you were never asked — your file was parsed. Which fields you actually hold decides your pay: if a researcher requests them, you earn a share",
  "submitRecord": "submitRecord",
  "taranan varyant": "variants scanned",
  "tarayıcı — dosya cihazdan çıkmadı": "the browser — the file never left your device",
  "verinin gerçek bir ölçümden geldiğini söylemez; onu ancak imzalayan akredite bir kurum söyleyebilir, ZK söyleyemez":
    "it does not say the data came from a real measurement; only a signing accredited institution can say that, and ZK cannot",
  "zincir grubu görüyor mu": "can the chain see your group",
  "Ölçümler şifrelenip gönderildi": "Measurements encrypted and submitted",
  "ödemeye esas alan": "field used for payment",
  "özet tutmazsa iki kullanıcının «3 numaralı SNP»si farklı varyant olur ve tablo alakasız şeyleri toplar":
    "if the digest does not match, two users' \"SNP #3\" are different variants and the table sums unrelated things",
  "Şifreli grup etiketi yazıldı": "Encrypted group label written",
  // --- Sablonlu iz metinleri (yer tutucular korunmali) ----------------------
  "  ciphertext handle (ilk)": "  ciphertext handle (first)",
  "23andMe · {lines} satır": "23andMe · {lines} lines",
  "AncestryDNA · {lines} satır": "AncestryDNA · {lines} lines",
  "TAMAM · {done}/{total}": "DONE · {done}/{total}",
  "VCF · örnek {name}": "VCF · sample {name}",
  "YANLIŞ AĞ ({id})": "WRONG NETWORK ({id})",
  "aralık dışı → elenir": "out of range → dropped",
  "ciphertext handle": "ciphertext handle",
  "gönderiliyor…": "submitting…",
  "yazılıyor…": "writing…",
  "{covered}/{total} varyant kapsandı": "{covered} of {total} variants covered",
  "{done}/{total} METRİK": "{done}/{total} METRICS",
  "{done}/{total} SNP gönderildi…": "{done}/{total} SNPs submitted…",
  "{done}/{total} metrik gönderildi…": "{done}/{total} metrics submitted…",
  "{group} grubu — şifreli olarak": "{group} group — encrypted",
  "{n} SNP, {batches} partide gönderildi": "{n} SNPs submitted in {batches} batches",
  "{n} alan KANITLA yazıldı ({ms} ms)": "{n} fields written WITH A PROOF ({ms} ms)",
  "{n} metrik, {batches} partide gönderildi ({filled} ölçüm, {missing} eksik)":
    "{n} metrics submitted in {batches} batches ({filled} measured, {missing} missing)",
  "{source} · {n} varyant tarandı": "{source} · {n} variants scanned",
  "Şifrele ve gönder ({n} SNP)": "Encrypt and submit ({n} SNPs)",
  "Şifrele ve gönder ({n} ölçüm)": "Encrypt and submit ({n} measurements)",
  // --- Anket secenekleri ----------------------------------------------------
  "1-3 saat": "1–3 hours",
  "3-5 saat": "3–5 hours",
  "5+ saat": "5+ hours",
  "<1 saat": "Under 1 hour",
  "Bazen": "Sometimes",
  "Biraz": "A little",
  "Her zaman": "Always",
  "Hiç": "Never",
  "Kesinlikle": "Definitely",
  "Oldukça": "Quite a lot",
  "Sakinim": "I feel calm",
  "Sık Sık": "Often",
  "Yüksek Kaygılıyım": "I feel highly anxious",
  "Çok fazla": "A lot",
  "Çoğu zaman": "Most of the time",
  // "Hayir" (ASCII) sozlukte zaten var; anket noktali yazimi kullaniyor ve
  // bunlar FARKLI anahtarlardir. Biri cevrilip digeri unutulursa ekranda
  // yalnizca o kelime Turkce kalir — tam olarak boyle yakalandi.
  "Hayır": "No",
  // --- Tanitim sayfasi ------------------------------------------------------
  "SORUN": "THE PROBLEM",
  "Veri değerli, sahibi karşılıksız": "The data is valuable. Its owner gets nothing.",
  "Genomik veri araştırmacılar için çok değerli; verinin geldiği kişi için neredeyse hiçbir şey ifade etmiyor.":
    "Genomic data is worth a fortune to researchers, and almost nothing to the person it came from.",
  "Araştırmacı için": "For the researcher",
  "Bir GWAS çalışması binlerce katılımcının genotipine ihtiyaç duyar. Bu veriyi toplamak çalışmanın en pahalı ve en yavaş kısmıdır.":
    "A GWAS needs genotypes from thousands of participants. Collecting that cohort is the slowest and most expensive part of the study.",
  "Veri sahibi için": "For the data owner",
  "Aynı veri bir kez satılır, defalarca kullanılır ve kişiye hiçbir şey dönmez. Kimin hangi çalışmada kullandığı da görünmez.":
    "The same data is sold once, used many times, and returns nothing to the person. Who used it, and for what, stays invisible.",
  "Ortadaki boşluk": "The gap between them",
  "Veriyi paylaşmak mahremiyeti kaybetmek anlamına geldiği sürece, paylaşmak isteyen kişi için makul bir seçenek yoktur.":
    "As long as sharing data means giving up privacy, there is no reasonable option for someone who would otherwise be willing to share.",
  "NASIL ÇALIŞIYOR": "HOW IT WORKS",
  "Şifreli kalır, yine de hesaplanır": "It stays encrypted, and still computes",
  "Veri cihazınızda şifrelenir ve öyle kalır. Zincir üstünde yapılan her işlem şifreli değerler üzerinde çalışır.":
    "Data is encrypted on your device and stays that way. Every on-chain operation runs on the ciphertext.",
  "ÖDEME": "PAYMENT",
  "Kullanıldığı kadar, nadirliği kadar": "Paid by use, weighted by scarcity",
  "Araştırmacı yalnızca ihtiyaç duyduğu alanları satın alır. Az bulunan veri, sahibine kişi başına daha fazla kazandırır.":
    "Researchers buy only the fields they need. Data that few people hold earns its owner more per record.",
  "Kayıt başına ödeme": "Paid per record",
  "Bir kayıt, bir kişinin bir alanıdır. Araştırmacı iki alan isterse ve bunlara sırasıyla 40 ve 12 kişi veri vermişse, satın aldığı şey 52 kayıttır — havuzun tamamı değil.":
    "A record is one person and one field. If a researcher asks for two fields held by 40 and 12 people, they buy 52 records — not the whole pool.",
  "Kıtlık çarpanı": "Scarcity multiplier",
  "Bir alan ne kadar az kişide varsa, o alanın kayıt fiyatı o kadar yüksektir. Çarpan zincirdeki kapsama sayaçlarından türetilir; kimse elle değer atamaz.":
    "The fewer people hold a field, the more each of its records costs. The multiplier is derived from on-chain coverage counters — nobody assigns it by hand.",
  "Kıtlık örneği": "Scarcity example",
  "Alan": "Field",
  "Kaç kişide": "Held by",
  "Kişi başı": "Per person",
  "Yaygın varyant": "Common variant",
  "Seyrek kohort": "Sparse cohort",
  "Toplamda seyrek alan daha ucuza gelir — daha az veri satın alınır. Ama o veriyi taşıyan kişi kat kat fazla kazanır.":
    "The sparse field costs less in total — less data is bought. But the person carrying it earns several times more.",
  "TEKNOLOJİ": "TECHNOLOGY",
  "Üç katman": "Three layers",
  "Her katman farklı bir soruyu çözüyor; hiçbiri tek başına yeterli değil.":
    "Each layer answers a different question. None of them is sufficient alone.",
  "Veri açılmadan nasıl hesaplanır?": "How do you compute without decrypting?",
  "Dozajlar ve ölçümler şifreli olarak toplanır. Kontenjans tabloları ve Welch yeterli istatistikleri hiçbir noktada çözülmeden birikir.":
    "Dosages and measurements are aggregated while encrypted. Contingency tables and Welch sufficient statistics accumulate without ever being decrypted.",
  "Veriniz olduğunu nasıl kanıtlarsınız?": "How do you prove you hold the data?",
  "Devre, kapsama bitlerini taahhüde giren dozajlardan türetir. «Bu alan bende var» deyip boş göndermek matematiksel olarak imkânsızdır.":
    "The circuit derives coverage bits from the dosages inside the commitment. Claiming a field you do not hold is mathematically impossible.",
  "Eşikli çözüm": "Threshold decryption",
  "Sonuca kim erişebilir?": "Who can reach the result?",
  "Açılım, bağımsız düğümlerin eşikli onayı ve ardından bir itiraz penceresi gerektirir. Ödeme tek başına hiçbir şeyi çözmez.":
    "Disclosure requires threshold approval from independent nodes, followed by a challenge window. Paying alone decrypts nothing.",
  "DÜRÜST SINIRLAR": "HONEST LIMITS",
  "Sistem neyi kanıtlamıyor": "What the system does not prove",
  "Bir sistemin ne yapmadığını bilmek, ne yaptığını bilmek kadar önemlidir.":
    "Knowing what a system does not do matters as much as knowing what it does.",
  "Verinin gerçekliği kanıtlanmaz": "Authenticity is not proven",
  "ZK kanıtı, kapsamanın taahhütle tutarlı olduğunu gösterir. Verinin gerçek bir ölçümden geldiğini göstermez — bunu ancak imzalayan akredite bir kurum söyleyebilir.":
    "The ZK proof shows coverage is consistent with the commitment. It does not show the data came from a real measurement — only an accredited institution signing the panel can say that.",
  "Havuzdan çıkmak geçmişi silmez": "Leaving does not erase the past",
  "Ayrılmak gelecekteki sorgulardan pay almayı durdurur. Homomorfik toplamlara zaten karışmış veri geri çekilemez.":
    "Leaving stops your share of future queries. Data already mixed into the homomorphic aggregates cannot be pulled back.",
  "Test ağındayız": "This is a testnet",
  "Sözleşmeler Sepolia üzerinde çalışıyor. Tören tek katılımcılı bir geliştirme kurulumudur; ana ağ için çok taraflı bir tören gerekir.":
    "The contracts run on Sepolia. The trusted setup is a single-contributor development ceremony; mainnet requires a multi-party one.",
};
