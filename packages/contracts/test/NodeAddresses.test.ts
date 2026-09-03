import { expect } from "chai";
import { getAddress, ZeroAddress } from "ethers";

import { parseAuthorizedNodeAddresses } from "../scripts/node-addresses";

describe("AUTHORIZED_NODE_ADDRESSES", () => {
  const nodeA = "0x52908400098527886E0F7030069857D2E4169EE7";
  const nodeB = "0xde709f2102306220921060314715629080e2fb77";

  it("adresleri checksum canonical forma cevirir", () => {
    expect(parseAuthorizedNodeAddresses(`${nodeA.toLowerCase()}, ${nodeB}`)).to.deep.equal([
      getAddress(nodeA),
      getAddress(nodeB),
    ]);
  });

  it("eksik veya tek adresi reddeder", () => {
    expect(() => parseAuthorizedNodeAddresses(undefined)).to.throw();
    expect(() => parseAuthorizedNodeAddresses(nodeA)).to.throw();
  });

  it("zero adresi reddeder", () => {
    expect(() =>
      parseAuthorizedNodeAddresses(`${ZeroAddress}, ${nodeA}`),
    ).to.throw();
  });

  it("malformed ve checksum-invalid mixed-case adresleri reddeder", () => {
    expect(() => parseAuthorizedNodeAddresses(`0x1234, ${nodeA}`)).to.throw();
    const invalidChecksum = "0x52908400098527886e0F7030069857D2E4169EE7";
    expect(() =>
      parseAuthorizedNodeAddresses(`${invalidChecksum}, ${nodeB}`),
    ).to.throw();
  });

  it("farkli case ile yazilmis duplicate adresi reddeder", () => {
    expect(() =>
      parseAuthorizedNodeAddresses(`${nodeA.toLowerCase()}, ${nodeA}`),
    ).to.throw();
  });
});
