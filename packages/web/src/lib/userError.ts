/** Converts provider and wallet failures into a useful next action without exposing RPC internals. */
export function userError(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = candidate.toLowerCase();
  const detail = technicalDetail(candidate);

  if (message.includes("user rejected") || message.includes("rejected the request") || message.includes("action_rejected")) {
    return "İşlem cüzdanda onaylanmadı. Devam etmek isterseniz isteği yeniden başlatın.";
  }
  if (message.includes("insufficient funds") || message.includes("insufficient balance")) {
    return "Bu işlem için cüzdan bakiyesi yeterli değil. Bakiye ve ağ ücretini kontrol edin.";
  }
  // Kurator kalibi ag kalibindan ONCE gelmeli: "ulasilamadi" metni asagidaki
  // genel ag kalibina da uyuyor ve kullaniciyi Sepolia'yi kontrol etmeye
  // gonderiyordu. Oysa Sepolia calisiyor; eksik olan yerel servis.
  // YALNIZCA ulasilamama durumu. Onceden icinde "kurator" gecen HER hata bu
  // mesaja donuyordu; kuratorun anlamli bir redde verdigi cevap ("kod hatali",
  // "bu e-posta zaten kullanilmis") yanlislikla "servise ulasilamadi" oluyordu.
  if (message.includes("kurator servisine ulasilamadi")) {
    return "Kurator servisine ulasilamadi. Yerel servisi baslatin (npm run curator) ve yeniden deneyin.";
  }
  if (message.includes("network") || message.includes("rpc") || message.includes("missing revert data") || message.includes("failed to fetch")) {
    return "Ağ bağlantısı doğrulanamadı. Sepolia ağını ve RPC bağlantınızı kontrol edip yeniden deneyin.";
  }
  // Sozlesmenin kendi hata adlari, genel "revert" kalibindan ONCE gelmeli;
  // aksi halde hepsi "zincirdeki kosullari yenileyip tekrar deneyin" oluyor ve
  // tekrar denemek bu hatalarin HICBIRINI cozmuyor.
  if (message.includes("nullifieralreadyspent")) {
    return (
      "Bu ZK kimligi zaten bir cuzdanla kaydedilmis. Her cuzdanin kendi kimligi " +
      "olmak zorunda: MetaMask'te bu hesabi secili birakip sayfayi yenileyin, " +
      "yeni bir kimlik uretilecektir."
    );
  }
  if (message.includes("alreadyregistered")) {
    return "Bu cuzdan zaten arastirmaci olarak kayitli. Sorgu ekranindan devam edebilirsiniz.";
  }
  if (message.includes("unknownroot") || message.includes("rootexpired")) {
    return (
      "Kanit, zincirdeki guncel akredite agac koku ile uyusmuyor. Kurator " +
      "kokU yazdiktan sonra yeniden deneyin."
    );
  }
  if (message.includes("wrong chain") || message.includes("chain")) {
    return "Bu işlem Sepolia ağında yapılabilir. Cüzdan ağını değiştirip yeniden deneyin.";
  }
  if (message.includes("revert") || message.includes("execution reverted")) {
    return `${fallback} Zincirdeki güncel koşulları yenileyip tekrar deneyin.`;
  }

  // TANIMADIGIMIZ HATADA HAM SEBEBI GOSTER.
  //
  // Buraya dusen hata, kaliplarin hicbirine uymayan hatadir - yani tam da
  // hakkinda en az sey bildigimiz hata. Onu genel bir cumlenin arkasina
  // saklamak kullaniciyi da bizi de kor birakiyor: ekranda "sorgu durumu
  // okunamadi" yaziyor, konsola bakilmadan sebebi ogrenmenin yolu yok.
  // Tanidigimiz hatalarda ise ham metni EKLEMIYORUZ; orada zaten ne
  // yapilacagini soyluyoruz ve teknik ayrinti yalnizca gurultu olur.
  return detail === null ? fallback : `${fallback} (${detail})`;
}

/** Ham hata metnini ekranda gosterilebilecek kisa bir ozete indirir. */
function technicalDetail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Saglayici hatalari cok satirli JSON govdeleri tasiyabiliyor; ilk satir
  // neredeyse her zaman ayirt edici olani.
  const firstLine = trimmed.split("\n")[0].trim();
  if (firstLine === "") return null;

  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}
