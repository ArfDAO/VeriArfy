declare module "snarkjs" {
  interface Groth16Proof {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: string;
    curve: string;
  }

  interface Groth16 {
    fullProve(
      input: unknown,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  }

  export const groth16: Groth16;
}
