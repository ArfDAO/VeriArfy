# `contracts/filecoin/` — disaridan alinan referans kod

Bu klasordeki `DealClient.sol` ve `Types.sol` **bizim yazdigimiz kod
degildir.** Protocol Labs'in referans istemci sozlesmesinden
(https://github.com/lotus-web3/client-contract) oldugu gibi alinmistir.

**Lisans:** Apache-2.0 · Copyright 2022 Protocol Labs, Inc.

## Neden degistirilmeden alindi

Calibration test aginda anlasmalari otomatik kabul eden saglayici
(PiKNiK, `t017840`) bir Boost botu calistirir ve bu bot **`DealProposalCreate`
olayini** dinler. Olayin imzasi ya da sozlesmenin davranisi degistirilirse
bot teklifi tanimaz ve anlasma hic kurulmaz.

Yani buradaki kod bir bagimliliktir; iyilestirilecek bir sey degildir.
Degisiklik gerekiyorsa once botun hala tanidigi dogrulanmalidir.

## Ne yapar

```
makeDealProposal(DealRequest)          -> DealProposalCreate olayi
   |
   +-- Boost botu olayi gorur, CAR'i location_ref'ten indirir
   |
   +-- anlasmayi Filecoin'de yayimlar
   |
   +-- market aktoru sozlesmeyi geri cagirir (MARKET_NOTIFY_DEAL)
          |
          +-- pieceDeals[commP] = dealId
```

Bizim ilgilendigimiz cikti son satirdir: `pieceDeals[commP]` ile **dealId**.
O kimlik Sepolia'daki `VeriarfyStorage.registerDeal` ile kalicilik defterine
islenir ve `scripts/verify-storage-deals.ts` onu Filecoin zincirinden
dogrular.

## Bizim kodumuz nerede

- `contracts/VeriarfyStorage.sol` — kalicilik defteri ve politika (Sepolia)
- `scripts/filecoin-*.ts` / `.mjs` — hazirlik, teklif, toplama

Mimari gerekce: [`docs/mimari/0010-filecoin-kalicilik.md`](../../../../docs/mimari/0010-filecoin-kalicilik.md)
