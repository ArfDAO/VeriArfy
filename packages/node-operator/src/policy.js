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
