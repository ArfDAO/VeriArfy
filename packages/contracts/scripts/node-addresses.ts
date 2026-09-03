import { getAddress, ZeroAddress } from "ethers";

/**
 * AUTHORIZED_NODE_ADDRESSES degerini zincir islemlerinden once guvenli hale
 * getirir. Yalnizca public adresler kabul edilir; private key burada tutulmaz.
 */
export function parseAuthorizedNodeAddresses(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("AUTHORIZED_NODE_ADDRESSES zorunludur");
  }

  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length < 2) {
    throw new Error("AUTHORIZED_NODE_ADDRESSES en az iki dugum adresi icermelidir");
  }
  if (entries.some((entry) => entry === "")) {
    throw new Error("AUTHORIZED_NODE_ADDRESSES bos adres iceremez");
  }

  const canonical = entries.map((entry, index) => {
    let address: string;
    try {
      // getAddress lowercase/uppercase adresleri checksum'li forma cevirir;
      // checksum'i bozuk mixed-case adresleri ise reddeder.
      address = getAddress(entry);
    } catch {
      throw new Error(`AUTHORIZED_NODE_ADDRESSES[${index}] gecersiz adres`);
    }
    if (address === ZeroAddress) {
      throw new Error(`AUTHORIZED_NODE_ADDRESSES[${index}] zero adres olamaz`);
    }
    return address;
  });

  const normalized = new Set(canonical.map((address) => address.toLowerCase()));
  if (normalized.size !== canonical.length) {
    throw new Error("AUTHORIZED_NODE_ADDRESSES duplicate adres iceremez");
  }

  return canonical;
}
