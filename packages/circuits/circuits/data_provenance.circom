pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/eddsaposeidon.circom";
include "lib/merkle.circom";

/*
 * VeriArfy — Sıfır Bilgi Veri Kökeni (ZK-Data Provenance).
 *
 * ## Kanıtlanan iddia
 *
 *   "Yüklediğim panelin düz metni, akredite kurumlar listesinde yer alan bir
 *    kurumun EdDSA imzasını taşıyor; panel biçim kurallarına uyuyor; bu kanıt
 *    benim cüzdanıma ve yüklediğim şifreli bloba bağlı; aynı kayıt ikinci kez
 *    yüklenemez."
 *
 * Panelin kendisi (dozaj vektörü) hiçbir noktada açığa çıkmaz.
 *
 * ## Neden RSA değil EdDSA
 *
 * Rapor §2.8 RSA-2048 doğrulaması öngörüyordu; ölçülen maliyeti ~1,5 milyon
 * R1CS kısıtı. Aynı işi Baby Jubjub üzerinde EdDSA ile yapmak birkaç bin
 * kısıta iniyor — çünkü eğri, devrenin çalıştığı alanla (BN254 skaler alanı)
 * uyumlu; RSA ise 2048 bitlik modüler aritmetiği alan elemanlarına parçalayıp
 * taşıma bitleriyle uğraşmayı gerektiriyor.
 *
 * Pratik sonucu: kanıt üretimi masaüstünde saniyeler yerine dakikalar sürmüyor
 * ve devre 2^14 ptau'ya sığıyor. Kurumların RSA/ECDSA ile imzaladığı gerçek
 * dünyada bu, kurumun EdDSA anahtarını da yayımlamasını gerektirir — yani
 * kurum tarafında bir entegrasyon işi. Karşılığında kullanıcı tarafındaki
 * kanıt üretimi mobil cihazda bile mümkün hale gelir.
 *
 * ## KAPSAM SINIRI — dürüstçe: bu devre şifrelemenin DOĞRULUĞUNU kanıtlamaz
 *
 * Devre "panelin düz metni imzalıdır" der. "IPFS'e yüklediğim şifreli metin
 * tam olarak bu paneli şifreler" DEMEZ. Aradaki bağ (Proof of Correct
 * Encryption) bu devrede kurulu değildir; kötü niyetli bir kullanıcı geçerli
 * imzalı bir panele sahip olup bambaşka bir şey şifreleyebilir.
 *
 * `cidHigh` / `cidLow` bu boşluğu KAPATMAZ; yalnızca kanıtın başka bir bloba
 * taşınmasını engeller (kanıt hırsızlığı ve önden alma koruması).
 *
 * Gerçek çözüm iki yoldan gelir ve ikisi de bu devrenin dışındadır:
 *   1. fhEVM yolunda `FHE.fromExternal(handle, inputProof)` — Zama'nın girdi
 *      kanıtı, şifreli metnin geçerliliğini zaten zincir üzerinde doğrular.
 *   2. Concrete yolunda tam PoCE — henüz kurulmadı, açık madde.
 *
 * ## Açık sinyal sırası (snarkjs)
 *
 *   [root, nullifierHash, commitment, externalNullifier, cidHigh, cidLow, signalHash]
 */
template DataProvenance(PANEL, LEVELS) {
    // ------------------------------------------------------------------
    // Gizli girdiler — hiçbiri kanıttan okunamaz
    // ------------------------------------------------------------------

    /// Dozaj vektörü: her eleman 0 (hom. referans), 1 (het.) veya 2 (hom. alt).
    signal input dosages[PANEL];

    /// Kullanıcıya özel rastgelelik. Olmazsa taahhüt kaba kuvvetle aranabilir:
    /// panel uzayı 3^PANEL kadardır ve PANEL=16 için bu yalnızca ~43 milyon.
    signal input salt;

    /// İmzalayan kurumun açık anahtarı. GİZLİ tutulur: hangi hastaneye
    /// gidildiği başlı başına hassas bir bilgidir.
    signal input institutionAx;
    signal input institutionAy;

    /// Kurumun EdDSA imzası (Baby Jubjub, Poseidon).
    signal input S;
    signal input R8x;
    signal input R8y;

    /// Kurumun akredite listede olduğunun Merkle kanıtı.
    signal input pathIndices[LEVELS];
    signal input siblings[LEVELS];

    // ------------------------------------------------------------------
    // Açık girdiler
    // ------------------------------------------------------------------

    /// Kapsam ayracı (kayıt turu / protokol sürümü).
    signal input externalNullifier;

    /// Yüklenen şifreli blobun CID digest'i, iki 128 bitlik yarım halinde.
    /// 256 bitlik digest tek bir BN254 alan elemanına (254 bit) sığmaz.
    signal input cidHigh;
    signal input cidLow;

    /// Yükleyenin cüzdanına bağlar.
    signal input signalHash;

    // ------------------------------------------------------------------
    // Çıktılar — açık sinyal olur
    // ------------------------------------------------------------------

    /// Akredite kurumlar ağacının kökü; sözleşme bunu kendi kaydıyla karşılaştırır.
    signal output root;

    /// Aynı imzalı kaydın ikinci kez yüklenmesini engeller (Sybil / tekrar).
    signal output nullifierHash;

    /// Panelin taahhüdü; zincirde saklanır, panelin kendisi asla açığa çıkmaz.
    signal output commitment;

    // ------------------------------------------------------------------
    // 1) Biçim doğrulaması: her dozaj {0, 1, 2} kümesinde olmalı
    // ------------------------------------------------------------------
    //
    // Num2Bits(2) ile 0..3 aralığına sıkıştırmak yetmez; 3 hâlâ geçerli
    // görünürdü. Çarpım biçimi kümeyi tam olarak verir ve dozaj başına
    // yalnızca iki kısıt harcar.

    signal firstFactor[PANEL];
    signal secondFactor[PANEL];

    for (var i = 0; i < PANEL; i++) {
        firstFactor[i] <== dosages[i] * (dosages[i] - 1);
        secondFactor[i] <== firstFactor[i] * (dosages[i] - 2);
        secondFactor[i] === 0;
    }

    // ------------------------------------------------------------------
    // 2) Paneli tek bir alan elemanına paketle
    // ------------------------------------------------------------------
    //
    // Her dozaj 2 bit; taban 4 ile paketleme tersine çevrilebilir (biçim
    // kontrolü sayesinde taşma yok). PANEL=16 -> 32 bit. Poseidon en fazla 16
    // girdi aldığı için doğrudan hash almak PANEL=16'da sınıra dayanırdı;
    // paketleme hem bunu çözer hem de panel büyürken (2 bit x 125'e kadar)
    // devre yapısını değiştirmez.

    signal packedAcc[PANEL + 1];
    packedAcc[0] <== 0;

    var placeValue = 1;
    for (var i = 0; i < PANEL; i++) {
        packedAcc[i + 1] <== packedAcc[i] + dosages[i] * placeValue;
        placeValue = placeValue * 4;
    }

    // ------------------------------------------------------------------
    // 3) Taahhüt = Poseidon(paketlenmiş panel, salt)
    // ------------------------------------------------------------------

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== packedAcc[PANEL];
    commitmentHasher.inputs[1] <== salt;
    commitment <== commitmentHasher.out;

    // ------------------------------------------------------------------
    // 4) Kurumun imzası taahhüdün üzerinde mi
    // ------------------------------------------------------------------
    //
    // Kurum paneli değil TAAHHÜDÜ imzalar. Böylece imza anında kurum da
    // salt'ı bilir; salt'ı sonradan değiştirmek imzayı geçersiz kılar. Bu,
    // aynı paneli farklı salt'la yeniden yükleyip nullifier'ı atlatmayı
    // engeller.

    component signatureCheck = EdDSAPoseidonVerifier();
    signatureCheck.enabled <== 1;
    signatureCheck.Ax <== institutionAx;
    signatureCheck.Ay <== institutionAy;
    signatureCheck.S <== S;
    signatureCheck.R8x <== R8x;
    signatureCheck.R8y <== R8y;
    signatureCheck.M <== commitment;

    // ------------------------------------------------------------------
    // 5) İmzalayan kurum akredite mi
    // ------------------------------------------------------------------

    component institutionLeaf = Poseidon(2);
    institutionLeaf.inputs[0] <== institutionAx;
    institutionLeaf.inputs[1] <== institutionAy;

    component tree = MerkleTreeInclusionProof(LEVELS);
    tree.leaf <== institutionLeaf.out;
    for (var i = 0; i < LEVELS; i++) {
        tree.pathIndices[i] <== pathIndices[i];
        tree.siblings[i] <== siblings[i];
    }
    root <== tree.root;

    // ------------------------------------------------------------------
    // 6) Nullifier — aynı kayıt iki kez yüklenemez
    // ------------------------------------------------------------------
    //
    // Taahhüt üzerinden türetilir: taahhüt imzalı olduğu için kullanıcı onu
    // değiştiremez, dolayısıyla nullifier'dan kaçamaz.

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== externalNullifier;
    nullifierHasher.inputs[1] <== commitment;
    nullifierHash <== nullifierHasher.out;

    // ------------------------------------------------------------------
    // 7) Kanıtı cüzdana ve yüklenen bloba bağla
    // ------------------------------------------------------------------
    //
    // Bu üç sinyal devrede başka hiçbir yerde kullanılmıyor. Karesini almak
    // onları tanığa (witness) sokar ve kısıt sistemine bağlar; aksi halde
    // derleyici bunları eler ve kanıt istenen cüzdandan/bloktan bağımsız
    // hale gelir — yani başkası tarafından yeniden kullanılabilir.

    signal signalHashSquared;
    signal cidHighSquared;
    signal cidLowSquared;

    signalHashSquared <== signalHash * signalHash;
    cidHighSquared <== cidHigh * cidHigh;
    cidLowSquared <== cidLow * cidLow;
}

// PANEL=16: hâlihazırda uçtan uca doğrulanmış panel boyutu (Concrete devresi
//           bu boyutta derleniyor). Paketleme sayesinde büyütmek devre
//           yapısını değil yalnızca bu sayıyı değiştirir.
// LEVELS=20: araştırmacı devresiyle aynı ağaç derinliği; ~1 milyon kurum.
component main {public [externalNullifier, cidHigh, cidLow, signalHash]} =
    DataProvenance(16, 20);
