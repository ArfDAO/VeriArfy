/** Converts provider and wallet failures into a useful next action without exposing RPC internals. */
export function userError(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = candidate.toLowerCase();

  if (message.includes("user rejected") || message.includes("rejected the request") || message.includes("action_rejected")) {
    return "İşlem cüzdanda onaylanmadı. Devam etmek isterseniz isteği yeniden başlatın.";
  }
  if (message.includes("insufficient funds") || message.includes("insufficient balance")) {
    return "Bu işlem için cüzdan bakiyesi yeterli değil. Bakiye ve ağ ücretini kontrol edin.";
  }
  if (message.includes("network") || message.includes("rpc") || message.includes("missing revert data") || message.includes("failed to fetch")) {
    return "Ağ bağlantısı doğrulanamadı. Sepolia ağını ve RPC bağlantınızı kontrol edip yeniden deneyin.";
  }
  if (message.includes("wrong chain") || message.includes("chain")) {
    return "Bu işlem Sepolia ağında yapılabilir. Cüzdan ağını değiştirip yeniden deneyin.";
  }
  if (message.includes("revert") || message.includes("execution reverted")) {
    return `${fallback} Zincirdeki güncel koşulları yenileyip tekrar deneyin.`;
  }

  return fallback;
}
