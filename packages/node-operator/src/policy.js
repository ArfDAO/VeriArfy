/**
 * Bir dugumun acilim talebini onaylamadan ONCE dogruladigi kurallar.
 *
 * NEDEN AYRI DOSYA: bu kurallar servisin en onemli parcasi. Otomatik onay,
 * onayi anlamsizlastirmaya cok yakin bir sey; tek farki kurallarin acikca
 * yazili ve sinanabilir olmasi. Ag cagrilarindan ayri tutuldugu icin
 * dogrudan test edilebiliyorlar.
 *
 * NE KONTROL EDILMEZ: talebin BILIMSEL degeri. Bir kurum dugumu uretimde
 * "bu arastirma mesru mu" sorusunu sorar; bu servis onu soramaz ve
 * sordugunu iddia etmez. Sabit panel ve yalniz-aggregate cikti, karar
 * uzayini sozlesme duzeyinde zaten daralttigi icin testnette bu kabul
 * edilebilir - uretimde degildir.
 */

/** @returns {{approve: boolean, reason: string}} */
export function evaluateRequest({
  requestId,
  requester,
  snapshotCount,
  minParticipants,
  finalized,
  revoked,
  executed,
  isAuthorizedNode,
  hasApproved,
  canApprove,
}) {
  if (revoked) return { approve: false, reason: `talep ${requestId} itirazla iptal edilmis` };
  if (executed) return { approve: false, reason: `talep ${requestId} zaten yurutulmus` };
  if (finalized) return { approve: false, reason: `talep ${requestId} zaten yeterli onaya ulasmis` };

  if (!requester || /^0x0+$/i.test(requester)) {
    return { approve: false, reason: `talep ${requestId} yok` };
  }
  if (!isAuthorizedNode) return { approve: false, reason: "bu cuzdan yetkili dugum degil" };
  if (hasApproved) return { approve: false, reason: "bu dugum zaten onaylamis" };

  // Teminat, onayin EKONOMIK KARSILIGIDIR. Teminatsiz onay, yanlis onayin
  // bedeli olmamasi demektir; sozlesme de bunu reddeder.
  if (!canApprove) return { approve: false, reason: "teminat yetersiz" };

  // k-ANONIMLIK - sozlesme bunu talep acilirken zaten dayatiyor. Burada
  // TEKRAR bakilmasinin sebebi savunma derinligi degil, sorumluluk: esigin
  // korundugunu dogrulamak dugumun kendi isidir, baskasinin kontrolune
  // guvenerek onay vermek onayi bir imza atmaktan ibaret birakirdi.
  if (snapshotCount < minParticipants) {
    return {
      approve: false,
      reason: `kohort ${snapshotCount} < esik ${minParticipants}; k-anonimlik saglanmiyor`,
    };
  }

  return { approve: true, reason: `kohort ${snapshotCount} >= esik ${minParticipants}` };
}

/**
 * FARK SALDIRISI KONTROLU.
 *
 * Havuzdaki sayaclar yalnizca ARTAR: yeni katilim eklenir, havuzdan cikis
 * toplamlardan hicbir sey cikarmaz. Her acilim talebi o anki tabloyu dondurur.
 * Dolayisiyla ayni alan icin iki talebin dondurdugu tablolarin FARKI, aradaki
 * donemde katilan kisilerin toplamidir.
 *
 * Bu fark k kisiden AZSA k-anonimlik delinir. En kotu hal: iki sorgu
 * arasinda tek bir kisi katilir ve farkin kendisi o kisinin genotipidir.
 * Her sorgu tek basina "en az 10 kisi" kuralini gecer; sizinti ikisinin
 * birlikte okunmasindan dogar. Sozlesme bunu yakalamiyor cunku her talebi
 * tek basina degerlendiriyor.
 *
 * Kontrol TUM arastirmacilarin talepleriyle yapilir, yalnizca ayni kisinin
 * degil: kurator herkesi kaydettigi icin tek bir kisi birden fazla
 * arastirmaci kimligi acabilir ve kimlikler birbirine baglanamaz.
 *
 * Fark 0 ise kohort AYNIDIR (sayac artmadiysa kimse eklenmedi) - sizinti yok.
 *
 * @param {{ fields: {key: string, count: number}[] }} request
 * @param {{ requestId: number, fields: {key: string, count: number}[] }[]} others
 * @param {number} k  k-anonimlik esigi (minParticipants)
 * @returns {{ approve: boolean, reason: string }}
 */
export function evaluateDifferencing(request, others, k) {
  const mine = new Map(request.fields.map((f) => [f.key, f.count]));

  for (const other of others) {
    for (const field of other.fields) {
      if (!mine.has(field.key)) continue;
      const diff = Math.abs(mine.get(field.key) - field.count);
      if (diff > 0 && diff < k) {
        return {
          approve: false,
          reason:
            `talep ${other.requestId} ile ${field.key} alaninda ${diff} kisilik fark var ` +
            `(esik ${k}); iki sonucun farki bu ${diff} kisinin verisini aciga cikarir`,
        };
      }
    }
  }

  return { approve: true, reason: "fark saldirisi riski yok" };
}
